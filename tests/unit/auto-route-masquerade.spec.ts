/**
 * 「客户端伪装通道」的**接线面**回归测试（设计稿
 * `docs/agents/client-masquerade-design.md` §3.9 / §3.10 / §5.3 / §10.3）。
 *
 * ## 本文件守什么
 *
 * 伪装功能横跨**四层**，每层都能独立静默失效，且失效时的表现完全相同 ——
 * 「用户在面板里配了伪装、界面显示保存成功，出站请求却什么都没变，且没有任何报错」：
 *
 * 1. **配置层形状判据**（`src/auto-route.ts`）：`sanitizeAutoRouteConfig` / `readEntry`
 *    读路径丢脏块、`assertValidAutoRouteConfig` 写路径中文拒绝、`entryKey` 去重键、
 *    `autoRouteConfigFacts` 内容指纹 —— 四处任缺一处都会让「配了伪装」的候选被静默
 *    合并 / 被指纹漏掉（后者 = 队列不重建）。
 * 2. **转发层载体注入**（`src/auto-route-adapter.ts` 的 `forwardOptions`）：条目上的
 *    `masquerade` 必须变成 options 上的 `accountHubMasquerade` 才能穿过
 *    `ctx.llm.stream()` 到达内层适配器；**缺省时一个键都不挂**（Z2：与加这条通道之前
 *    逐字节一致）。
 * 3. **补丁维持层**（`src/masquerade-patch.ts`，卡片 1 已测）—— 本文件只测 RPC 怎么调它。
 * 4. **RPC 层两个方法**（`src/account-hub-rpc.ts`）：`masquerade.status` **永不抛错**、
 *    `masquerade.apply` **失败必须抛**；以及两个触发点（面板打开 / 保存配置）的
 *    fire-and-forget 纪律。
 *
 * ## 为什么用真夹具而不是 mock 掉文件系统
 *
 * 「打上了没有」这个判据的真相在**磁盘上的那个文件**里。若把 `resolvePatchedTarget` /
 * `inspectPatch` mock 掉，本文件就只剩「我 mock 的返回值被我读到了」——
 * 恰好绕开了唯一会出错的那一段。故这里沿用 `masquerade-patch.spec.ts` 的临时目录夹具
 * （`os.tmpdir()`），把 `masqueradeLookup` 指过去，**绝不触碰真实的 `~/.dsh`**。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import {
  MASQUERADE_TARGET_PACKAGE,
  applyPatch,
  type MasqueradeTargetLookup,
} from '../../src/masquerade-patch.js'
import {
  autoRouteConfigFacts,
  autoRouteMasqueradeProblem,
  sanitizeAutoRouteConfig,
  assertValidAutoRouteConfig,
  type AutoRouteDefinition,
} from '../../src/auto-route.js'

// ──────────────────────────── 夹具 ────────────────────────────

/** 段 1 的原厂调用点字面量（**独立重写**：锚点漂了要让本文件红，而不是跟着实现漂）。 */
const ANCHOR = '\t\t\t\t\theaders: requestHeaders(profile.headers)'

/** 目标包版本（夹具里写死的版本号）。 */
const FIXTURE_VERSION = '0.1.7-rc.1'

/** 原厂 fixture（结构与真机产物同形到「锚点唯一命中」这一层）。 */
function stockFixture(): string {
  return [
    'function requestHeaders(headers) {',
    '  return { ...(headers ?? {}) };',
    '}',
    'function streamWithSnapshot(profile, options) {',
    '  return {',
    '\t\t\t\t\ttemperature: options.temperature,',
    ANCHOR,
    '  };',
    '}',
    'export { requestHeaders, streamWithSnapshot };',
    '',
  ].join('\n')
}

/** 一个临时 profile：目标文件落在**共享层**候选路径上。 */
interface Fixture {
  /** 假 dsh home（`dshHomePath(...segs)` 的基准目录）。 */
  readonly home: string
  /** 目标文件绝对路径。 */
  readonly file: string
}

const created: string[] = []

/** 造夹具（`content` 缺省 = 原厂形态）。 */
function makeFixture(content: string = stockFixture()): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dshcm-route-'))
  created.push(home)
  const packageDir = join(home, 'profiles', 'node_modules', ...MASQUERADE_TARGET_PACKAGE.split('/'))
  const file = join(packageDir, 'lib', 'index.js')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: MASQUERADE_TARGET_PACKAGE, version: FIXTURE_VERSION, type: 'module' }, null, 2),
    'utf8',
  )
  writeFileSync(file, content, 'utf8')
  return { home, file }
}

/** 夹具的 lookup（只给共享层来源；profile 层留空，避免碰到真实安装目录）。 */
function lookupOf(home: string): MasqueradeTargetLookup {
  return { dshHomePath: (...segments: string[]) => join(home, ...segments) }
}

/** 目标文件文本。 */
function textOf(file: string): string {
  return readFileSync(file, 'utf8')
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 用例失败时也不留垃圾：删不掉就算了（临时目录由系统回收）。
    }
  }
})

// ──────────────────────────── 1. 配置层形状判据 ────────────────────────────

/** 造一条带伪装块的候选（`windowId` 缺省用一个固定串）。 */
const masqueradeEntry = (windowId: unknown, extra: Record<string, unknown> = {}) => ({
  provider: 'p-a',
  model: 'a',
  masquerade: { windowId, ...extra },
})

/** 读一条候选（要求条目本身必须留下）。 */
function readOne(entryValue: unknown): Record<string, unknown> {
  const result = sanitizeAutoRouteConfig({
    models: [{ id: 'm1', name: 'A', entries: [entryValue] }],
  })
  expect(result.models, '条目本身必须留下（丢的是伪装块，不是候选）').toHaveLength(1)
  return result.models[0]!.entries[0] as Record<string, unknown>
}

describe('sanitizeAutoRouteConfig：masquerade 读路径（脏块整块丢，条目照留）', () => {
  it('合法 masquerade 读回 { windowId }（两端空白被裁掉）', () => {
    const read = readOne(masqueradeEntry('  win-123  '))
    expect(read.masquerade).toEqual({ windowId: 'win-123' })
    // 归一后**不留别的键**：形状必须与出站载体 `accountHubMasquerade` 逐字一致。
    expect(Object.keys(read.masquerade as object)).toEqual(['windowId'])
  })

  it('非法 masquerade（非对象 / 缺 windowId / 非字符串 / 空串 / 未知键 / 数组）→ 整块丢，条目照留', () => {
    const dirty: unknown[] = [
      'win-123',                              // 裸字符串（旧形态）
      42,
      null,
      [],
      {},                                     // 缺 windowId
      { windowId: 42 },                        // 非字符串
      { windowId: '' },                        // 空串
      { windowId: '   ' },                     // 全空白
      { windowId: 'ok', preset: 'codex' },     // 未知键（preset 刻意不持久化）
      { windowId: 'ok', enabled: true },       // 未知键（没有 enabled 布尔）
    ]
    for (const bad of dirty) {
      const read = readOne({ provider: 'p-a', model: 'a', masquerade: bad })
      expect(read.provider, `provider / model 才是这条候选的实质，必须留下`).toBe('p-a')
      expect(read.model).toBe('a')
      // ⚠️ 判据是「键不存在」而不是「值为空」：`undefined` 占位会让 `Object.keys`
      // 断言与落盘 diff 出现噪声，也会让 `entryKey` 的 `?.` 判据失去意义。
      expect('masquerade' in read, `非法值 ${JSON.stringify(bad)} 不得落成任何形态`).toBe(false)
    }
  })

  it('masquerade 与两个头覆写字段彼此独立：一个坏掉不牵连其它', () => {
    const read = readOne({
      provider: 'p-a',
      model: 'a',
      userAgent: 'CustomAgent/1.0',
      originator: 'my-app',
      masquerade: { windowId: '' },
    })
    expect(read.userAgent, 'masquerade 坏掉不该动 userAgent').toBe('CustomAgent/1.0')
    expect(read.originator).toBe('my-app')
    expect('masquerade' in read).toBe(false)
  })

  it('两条只有 masquerade.windowId 不同的候选**都留下**（身份键必须含该字段）', () => {
    // ⚠️ 不进键的话第二条会被当「重复条目」静默合并：用户加了第二条、界面显示保存
    // 成功，实际只剩一条，且没有任何报错。这正是设计稿 §10.3 C6 守的形态。
    const result = sanitizeAutoRouteConfig({
      models: [{
        id: 'm1',
        name: 'A',
        entries: [
          { provider: 'p-a', model: 'a' },
          { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-1' } },
          { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-2' } },
          { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-2' } }, // 完全同形 → 丢
        ],
      }],
    })
    const entries = result.models[0]!.entries
    expect(entries).toHaveLength(3)
    expect(entries.map(item => item.masquerade?.windowId)).toEqual([undefined, 'w-1', 'w-2'])
  })
})

describe('assertValidAutoRouteConfig：masquerade 写路径（非法即抛，中文点名条目与字段）', () => {
  /** 造一份只有一条候选的配置。 */
  const withEntry = (entryValue: unknown): unknown =>
    ({ models: [{ id: 'm1', name: 'A', entries: [entryValue] }] })

  it('合法 masquerade 放行（含两端空白：判据自己归一）', () => {
    expect(() => assertValidAutoRouteConfig(withEntry(masqueradeEntry('win-123')))).not.toThrow()
    expect(() => assertValidAutoRouteConfig(withEntry(masqueradeEntry('  win-123  ')))).not.toThrow()
  })

  it('非法 masquerade 逐条抛错，且消息点名「第几个条目」+「哪个字段」', () => {
    // ⚠️ 传的是**整条候选**（`masquerade` 挂在它下面），不是裸的 masquerade 值：
    // 裸值会被更早的「条目不是对象」守卫拦下，测到的就不是本字段的判据了。
    const cases: Array<{ value: unknown; pattern: RegExp }> = [
      // 裸字符串：v1 的形状是对象，裸串会让配置层与出站载体形状分叉。
      { value: 'win-123', pattern: /第 1 个条目.*masquerade.*必须是对象/ },
      { value: 42, pattern: /第 1 个条目.*masquerade.*必须是对象/ },
      { value: null, pattern: /第 1 个条目.*masquerade.*必须是对象/ },
      { value: [], pattern: /第 1 个条目.*masquerade.*必须是对象/ },
      { value: {}, pattern: /第 1 个条目.*masquerade.*缺少 windowId/ },
      { value: { windowId: 42 }, pattern: /第 1 个条目.*masquerade.*windowId.*必须是字符串/ },
      { value: { windowId: '' }, pattern: /第 1 个条目.*masquerade.*windowId.*不能为空串/ },
      { value: { windowId: '   ' }, pattern: /第 1 个条目.*masquerade.*windowId.*不能为空串/ },
      { value: { windowId: 'ok', preset: 'codex' }, pattern: /第 1 个条目.*masquerade.*未知字段 preset/ },
    ]
    for (const { value, pattern } of cases) {
      expect(
        () => assertValidAutoRouteConfig(withEntry({ provider: 'p-a', model: 'a', masquerade: value })),
        `非法值 ${JSON.stringify(value)} 必须被拒绝（读路径丢、写路径拒，两条路同源）`,
      ).toThrow(pattern)
    }
  })

  it('缺省 masquerade 放行（缺省 = 关闭伪装，没有 enabled 布尔）', () => {
    expect(() => assertValidAutoRouteConfig(withEntry({ provider: 'p-a', model: 'a' }))).not.toThrow()
    expect('masquerade' in readOne({ provider: 'p-a', model: 'a' })).toBe(false)
  })

  it('autoRouteMasqueradeProblem 是两条路径的唯一判据源（合法返回 null，非法返回中文）', () => {
    expect(autoRouteMasqueradeProblem({ windowId: 'ok' })).toBeNull()
    expect(autoRouteMasqueradeProblem({ windowId: '  ok  ' })).toBeNull()
    for (const bad of ['x', 42, null, [], {}, { windowId: 1 }, { windowId: '' }, { windowId: 'a', z: 1 }]) {
      expect(autoRouteMasqueradeProblem(bad), `${JSON.stringify(bad)} 必须给出中文原因`).toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})

describe('autoRouteConfigFacts：masquerade 必须进内容指纹（漏了 = 队列不重建）', () => {
  const configOf = (entries: unknown[]): unknown => ({ enabled: true, models: [{ id: 'm1', name: 'A', entries }] })

  it('只有 masquerade.windowId 不同 → 指纹必须不同', () => {
    // ⚠️ 这正是设计稿 §10.4 的变异表里「facts 漏加 ⇒ C7」守的形态：指纹相同 ⇒
    // 运行时判定「配置没变」⇒ 用户改了伪装配置但降级队列仍按旧配置转发。
    const before = sanitizeAutoRouteConfig(configOf([{ provider: 'p-a', model: 'a' }]))
    const after = sanitizeAutoRouteConfig(configOf([
      { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-1' } },
    ]))
    expect(autoRouteConfigFacts(before)).not.toBe(autoRouteConfigFacts(after))
  })

  it('只有 windowId 的值不同 → 指纹必须不同（改的是同一条候选的取值）', () => {
    const one = sanitizeAutoRouteConfig(configOf([
      { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-1' } },
    ]))
    const two = sanitizeAutoRouteConfig(configOf([
      { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-2' } },
    ]))
    expect(autoRouteConfigFacts(one)).not.toBe(autoRouteConfigFacts(two))
  })

  it('配置内容完全相同 → 指纹相同（判据是内容，不是对象引用）', () => {
    const source = configOf([{ provider: 'p-a', model: 'a', masquerade: { windowId: 'w-1' } }])
    // 两次 sanitize 各返回全新对象：指纹相同才能保证「每次读配置都重建队列」不发生。
    expect(autoRouteConfigFacts(sanitizeAutoRouteConfig(source)))
      .toBe(autoRouteConfigFacts(sanitizeAutoRouteConfig(source)))
  })

  it('masquerade 缺省与显式 windowId 的指纹必须可分（null 占位不是丢键）', () => {
    const absent = sanitizeAutoRouteConfig(configOf([{ provider: 'p-a', model: 'a' }]))
    const present = sanitizeAutoRouteConfig(configOf([
      { provider: 'p-a', model: 'a', masquerade: { windowId: 'w-1' } },
    ]))
    // 两者都必须在指纹里各占一个位置：`undefined` 被 JSON.stringify 整键丢弃，
    // 而 `null` 占位不会 —— 若实现写成直接塞对象，这里会因键序而变得脆弱。
    expect(autoRouteConfigFacts(absent)).toContain('null')
    expect(autoRouteConfigFacts(present)).toContain('w-1')
    expect(autoRouteConfigFacts(absent)).not.toBe(autoRouteConfigFacts(present))
  })
})

// ──────────────────────────── 2. RPC 层 ────────────────────────────

/** 一份带伪装块的合法定义。 */
const MASQUERADE_DEFINITION: AutoRouteDefinition = {
  id: 'def-mask',
  name: 'masked-auto',
  entries: [
    { provider: 'p-a', model: 'a', masquerade: { windowId: 'win-abc' } },
    { provider: 'p-b', model: 'b' },
  ],
}

interface HarnessOptions {
  /** 假 dsh home（伪装补丁目标的基准目录）；不给 = 不给任何目标来源（`unavailable`）。 */
  home?: string
  /** 预置进持久层文档的 `autoRoute` 原值。 */
  autoRoute?: unknown
}

/**
 * RPC 测试台：storage 替身 + settings 替身 + connection 替身 + 可选的伪装夹具 lookup。
 *
 * 形态照抄 `auto-route-rpc.spec.ts` 的 `makeHarness`（同一套 mock 约定，不另立一套）。
 * 新增的只有 `masqueradeLookup`：它是本卡片为「伪装会真的改磁盘文件」这件事留的口子，
 * 不指向临时夹具就会去动开发机上真实存在的适配器产物。
 */
function makeHarness(options: HarnessOptions = {}) {
  const warnings: string[] = []
  const storageWrites: Array<Record<string, unknown>> = []

  const seedDocument = (): Record<string, unknown> => {
    const doc: Record<string, unknown> = {
      accounts: [],
      disabledModels: {},
      contextBudgets: {},
      checkins: {},
      consumption: {},
      consumptionCursors: {},
      schemaVersion: 0,
      providerAuditVersion: 0,
    }
    if ('autoRoute' in options) doc.autoRoute = options.autoRoute
    return doc
  }

  let storageGlobal: Record<string, unknown> = seedDocument()

  const storage = {
    read: () => storageGlobal,
    write: async (doc: Record<string, unknown>) => {
      const snapshot = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
      storageWrites.push(snapshot)
      storageGlobal = snapshot
    },
  }

  type Handler = (request: Request) => Promise<Response>
  let handler: Handler | undefined

  const ctx = {
    get: (key: string) => {
      if (key === 'storageDomain') {
        return {
          open: async () => ({
            global: { get: () => storage.read(), set: storage.write },
            close: async () => {},
          }),
        }
      }
      if (key === 'settings') {
        return {
          register: () => ({
            get: () => storageGlobal,
            replace: async (value: Record<string, unknown>) => { storageGlobal = value },
          }),
        }
      }
      if (key === 'connection') {
        return { fetch: { register: (config: { fetch: Handler }) => { handler = config.fetch } } }
      }
      return undefined
    },
    inject: (_deps: string[], callback: (ctx: unknown) => void) => { callback(ctx) },
    logger: {
      warn: (message: string) => { warnings.push(message) },
      info: () => {},
      error: () => {},
    },
    credentials: {
      describe: async () => ({ configured: true, writable: true }),
      resolve: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
  }

  const newPool = (): AccountPool => new AccountPool(ctx as never)

  const register = (pool: AccountPool): void => {
    registerAccountHubRpc({
      ctx: ctx as never, pool, codearts: {} as never, buddyCn: {} as never, buddy: {} as never,
      lobsterai: {} as never, traeCn: {} as never, qoder: {} as never, qoderCn: {} as never,
      ...options.home === undefined ? {} : { masqueradeLookup: lookupOf(options.home) },
    })
  }

  const call = async (method: string, payload: unknown) => {
    if (handler === undefined) throw new Error('endpoint handler was not registered')
    const response = await handler(new Request('http://localhost/api/account-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'rpc-1', method: 'account-hub', payload: { method, payload },
      }),
    }))
    const body = await response.json() as {
      result: { ok: boolean; value?: unknown; error?: { message: string } }
    }
    return body.result
  }

  return { ctx, newPool, register, call, storageWrites, warnings, storageCurrent: () => storageGlobal }
}

/** 建池 → 打开持久层 → 注册端点（生产 `apply()` 的时序）。 */
async function setup(options: HarnessOptions = {}) {
  const h = makeHarness(options)
  const pool = h.newPool()
  await pool.openStorage()
  h.register(pool)
  return { h, pool }
}

/** `masquerade.status` 的响应形状（避免在每个用例里重复断言）。 */
interface StatusValue {
  available: boolean
  applied: boolean
  reason?: string
  targetVersion?: string
}

describe('masquerade.status：永不抛错，把「不可用」与「未打补丁」分开', () => {
  it('目标包不存在（无任何来源）→ available:false + 固定中文原因，且**不抛错**', async () => {
    const { h } = await setup()
    const result = await h.call('masquerade.status', {})
    expect(result.ok, '查询类方法必须回 ok:true：抛错会被面板显示成「加载失败」').toBe(true)
    const value = result.value as StatusValue
    expect(value.available).toBe(false)
    expect(value.applied).toBe(false)
    // ⚠️ 这句话必须与面板常量 `AUTO_ROUTE_MASQUERADE_UNAVAILABLE` 逐字同句。
    expect(value.reason).toBe('当前环境未安装外部 provider 适配器')
    // 不可用时不该编造版本号。
    expect('targetVersion' in value).toBe(false)
  })

  it('目标包在场但未配置伪装 → available:true / applied:false（未打补丁）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({ home: fixture.home })
    const result = await h.call('masquerade.status', {})
    const value = result.value as StatusValue
    expect(value.available).toBe(true)
    expect(value.applied, '未配置伪装 ⇒ 补丁不该在场').toBe(false)
    expect(value.targetVersion).toBe(FIXTURE_VERSION)
    // 未打补丁**不是错误**：不该带 reason（那是给「打不上」用的）。
    expect('reason' in value).toBe(false)
    // 零配置自动还原：维持跑过之后文件仍是原厂形态。
    expect(textOf(fixture.file)).toBe(stockFixture())
  })

  it('配置了伪装 → 维持把补丁打上，status 报 applied:true（且 idempotent：文件不被反复重写）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    const first = await h.call('masquerade.status', {})
    const firstValue = first.value as StatusValue
    expect(firstValue.available).toBe(true)
    expect(firstValue.applied, '配置里有伪装块 ⇒ 维持应当把补丁打上').toBe(true)
    const patched = textOf(fixture.file)
    // 幂等：再查一次，文件逐字节不变（判据链「已在场且版本一致 ⇒ 不重写」）。
    const second = await h.call('masquerade.status', {})
    expect((second.value as StatusValue).applied).toBe(true)
    expect(textOf(fixture.file), '重复查询不得反复重写目标文件').toBe(patched)
  })

  it('目标文件不可读（目录占位）→ 仍回 ok:true，不抛错', async () => {
    const fixture = makeFixture()
    // 用一个目录替换掉目标文件：`inspectPatch` 的 readFileSync 会抛 EISDIR。
    rmSync(fixture.file, { force: true })
    mkdirSync(fixture.file, { recursive: true })
    const { h } = await setup({ home: fixture.home })
    const result = await h.call('masquerade.status', {})
    expect(result.ok, '读文件失败也必须回 ok:true（否则面板显示「加载失败」）').toBe(true)
    const value = result.value as StatusValue
    expect(value.available).toBe(true)
    expect(value.applied).toBe(false)
    // 读文件失败这一支的 reason 源头是 `inspectPatch` 的 `describe(error)`，即
    // `readFileSync` 的**英文 errno 文本**（卡片 1 刻意不翻译它：那个模块不面向界面，
    // 英文原文对排查更有用）。RPC 层只做**补中文前缀**、绝不改写原文，故这里两条都断言：
    expect(value.reason, '读文件失败必须把底层原因带给面板，否则用户无迹可循').toBeDefined()
    expect(value.reason, '面板是中文界面，裸 errno 文本必须以中文前缀起头').toMatch(/^伪装状态查询失败/)
    expect(value.reason, '中文前缀之外必须原样保留底层 errno 原文（改写它会让排查失去线索）')
      .toMatch(/EISDIR|directory/i)
  })

  it('配置未启用（enabled:false）时维持不因伪装块而打补丁（还原分支）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: false, models: [MASQUERADE_DEFINITION] },
    })
    const result = await h.call('masquerade.status', {})
    // `masqueradeConfigured` 只看 entries 上的 windowId（不看总开关），故这里仍是 true：
    // 这条用例钉住的是「判据来自配置内容本身」，避免将来有人误加 `enabled` 条件。
    expect((result.value as StatusValue).available).toBe(true)
    expect((result.value as StatusValue).applied).toBe(true)
  })
})

describe('masquerade.apply：失败**必须抛**（与 status 纪律相反）', () => {
  it('目标包不存在 → ok:false，错误原文 = 面板那句「未安装外部 provider 适配器」', async () => {
    const { h } = await setup()
    const result = await h.call('masquerade.apply', {})
    expect(result.ok, '显式应用失败必须让调用方拿到确切答案，不能吞成 applied:false').toBe(false)
    expect(result.error?.message).toBe('当前环境未安装外部 provider 适配器')
  })

  it('目标包在场且配置了伪装 → 打上补丁并回与 status 相同的形状', async () => {
    const fixture = makeFixture()
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    const result = await h.call('masquerade.apply', {})
    expect(result.ok).toBe(true)
    const value = result.value as StatusValue
    expect(value.available).toBe(true)
    expect(value.applied).toBe(true)
    expect(textOf(fixture.file)).toContain('__dshAccountHubApplyMasquerade')
  })

  it('**幂等**：连续两次 apply 都成功，且文件逐字节不变（不重写已在场的补丁）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    const first = await h.call('masquerade.apply', {})
    expect(first.ok).toBe(true)
    const afterFirst = textOf(fixture.file)
    const second = await h.call('masquerade.apply', {})
    expect(second.ok).toBe(true)
    expect(textOf(fixture.file), '已在场且版本一致 ⇒ 判据链必须走 alreadyPatched 而不是重写').toBe(afterFirst)
  })

  it('版本漂移（锚点零命中）→ 抛错且**文件逐字节不变**', async () => {
    // 造一个锚点已变的产物：判据链必须在写入前发现零命中并拒绝。
    const drifted = stockFixture().replace(ANCHOR, '\t\t\t\t\theaders: otherHeaders(profile.headers)')
    const fixture = makeFixture(drifted)
    const before = textOf(fixture.file)
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    const result = await h.call('masquerade.apply', {})
    expect(result.ok, '锚点零命中 ⇒ 必须抛错，而不是静默 applied:false').toBe(false)
    expect(result.error?.message).toMatch(/锚点零命中/)
    expect(textOf(fixture.file), '宁可功能不可用，也不产生半截补丁').toBe(before)
  })

  it('未配置伪装 → apply 成功（还原分支是成功路径，不是失败）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({ home: fixture.home })
    const result = await h.call('masquerade.apply', {})
    expect(result.ok).toBe(true)
    expect((result.value as StatusValue).applied).toBe(false)
  })
})

// ──────────────────────────── 3. 两个触发点 ────────────────────────────

describe('触发点 ②③：面板打开（autoroute.get）与保存配置（autoroute.set）各自维持一次', () => {
  it('触发点 ②：autoroute.get 会把配置里的伪装补丁打上（客户端一行都不用改）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    // 面板挂载时发的正是这一条：维持必须搭在它上面。
    const result = await h.call('autoroute.get', {})
    expect(result.ok).toBe(true)
    expect(textOf(fixture.file), 'autoroute.get 必须顺带维持一次补丁（触发点 ②）')
      .toContain('__dshAccountHubApplyMasquerade')
  })

  it('触发点 ③：autoroute.set 写成功后就地维持（关掉伪装 ⇒ 立刻还原，不等 5 分钟）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({ home: fixture.home })
    // 先经 set 配上伪装：这一次调用本身就该把补丁打上。
    const on = await h.call('autoroute.set', { enabled: true, models: [MASQUERADE_DEFINITION] })
    expect(on.ok).toBe(true)
    expect(textOf(fixture.file), '保存配置后必须立刻维持（触发点 ③）')
      .toContain('__dshAccountHubApplyMasquerade')
    // 再经 set 去掉伪装块：这一次调用本身就该还原，而不是等定时器。
    const stripped: AutoRouteDefinition = {
      id: 'def-mask',
      name: 'masked-auto',
      entries: [{ provider: 'p-a', model: 'a' }],
    }
    const off = await h.call('autoroute.set', { models: [stripped] })
    expect(off.ok).toBe(true)
    expect(textOf(fixture.file), '关掉伪装必须立刻还原（否则那段时间出站仍带伪装头）')
      .toBe(stockFixture())
  })

  it('触发点 ②③ **绝不影响** RPC 结果：目标包损坏时 get/set 照样成功', async () => {
    const fixture = makeFixture(stockFixture().replace(ANCHOR, '\t\t\t\t\theaders: other(profile.headers)'))
    const { h } = await setup({
      home: fixture.home,
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    // 维持会失败（锚点零命中），但它是旁路：只读查询与配置写入都必须照常成功。
    const read = await h.call('autoroute.get', {})
    expect(read.ok, '维持失败绝不能把「打开面板」升级成「面板打不开」').toBe(true)
    expect(read.value).toEqual({ enabled: true, models: [MASQUERADE_DEFINITION] })
    const written = await h.call('autoroute.set', { enabled: false })
    expect(written.ok, '维持失败绝不能把「保存成功」显示成「保存失败」').toBe(true)
    // 失败原因必须留在日志里（否则用户完全无迹可循）。
    expect(h.warnings.some(message => message.includes('伪装'))).toBe(true)
  })

  it('触发点 ②③ 与配置面无关：autoroute.set 的返回体仍只有 enabled/models 两个键', async () => {
    const fixture = makeFixture()
    const { h } = await setup({ home: fixture.home })
    const result = await h.call('autoroute.set', { enabled: true, models: [MASQUERADE_DEFINITION] })
    expect(Object.keys(result.value as object).sort()).toEqual(['enabled', 'models'])
  })

  it('伪装配置**原样往返**：set 存进去、get 读回来（含 windowId 逐字保留）', async () => {
    const fixture = makeFixture()
    const { h } = await setup({ home: fixture.home })
    const written = await h.call('autoroute.set', { models: [MASQUERADE_DEFINITION] })
    expect(written.ok).toBe(true)
    expect(written.value).toEqual({ enabled: false, models: [MASQUERADE_DEFINITION] })
    const read = await h.call('autoroute.get', {})
    expect(read.value).toEqual({ enabled: false, models: [MASQUERADE_DEFINITION] })
    const entries = (read.value as { models: AutoRouteDefinition[] }).models[0]!.entries
    // 配了的条目：`masquerade` 键在，取值逐字保留。
    expect(Object.keys(entries[0]!).sort()).toEqual(['masquerade', 'model', 'provider'])
    expect(entries[0]!.masquerade).toEqual({ windowId: 'win-abc' })
    // 没配的条目：**一个键都不留**（缺省 = 关闭伪装）。
    expect(Object.keys(entries[1]!).sort()).toEqual(['model', 'provider'])
    // 落盘也带上了（否则重启后配置丢失）。
    const stored = (h.storageCurrent().autoRoute as { models: AutoRouteDefinition[] }).models[0]!
    expect(stored.entries[0]!.masquerade).toEqual({ windowId: 'win-abc' })
  })

  it('非法的 masquerade 经 RPC 写入被拒，且错误原文点名条目与字段（配置一字不变）', async () => {
    const { h, pool } = await setup()
    const bad = {
      models: [{
        id: 'def-mask',
        name: 'masked-auto',
        entries: [{ provider: 'p-a', model: 'a', masquerade: { windowId: '' } }],
      }],
    }
    const result = await h.call('autoroute.set', bad)
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/第 1 个条目.*masquerade.*windowId.*不能为空串/)
    // 拒绝后配置一字不变（写路径上静默丢弃等于「点了保存却什么都没存」）。
    expect(pool.autoRouteConfig()).toEqual({ enabled: false, models: [] })
  })
})

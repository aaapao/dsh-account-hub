/**
 * 「客户端伪装通道」的**接线面**回归测试（设计稿
 * `docs/agents/client-masquerade-design.md` §3.9 / §3.10 / §5.3 / §10.3）。
 *
 * ## 本文件守什么
 *
 * 伪装功能横跨**三层**，每层都能独立静默失效，且失效时的表现完全相同 ——
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
 * 3. **RPC 层两个方法**（`src/account-hub-rpc.ts`）：伪装由运输层
 *    （`src/account-hub-masquerade-transport.ts`）在请求出网前就地改写请求头实现，
 *    它随插件进程装载，**没有「打没打上」这种可失败状态** —— 故两个方法都只答
 *    「运输层在不在」，回的是同一份常量可用性。
 *
 * ## 为什么不再有磁盘夹具
 *
 * 旧实现（`src/masquerade-patch.ts`）会**真的改宿主磁盘文件**，故那时的判据只能在临时
 * 目录夹具上验证。那套引擎整体退役的原因正是它的目标解析在 installation-first 的宿主里
 * 永远打不中真文件（patch 从没离开过本机），本文件随之不再需要任何文件系统夹具：
 * 剩下的被测面全是**纯形状判据**与**常量响应**，不碰盘、不留痕。
 */

import { describe, expect, it } from 'vitest'
import { AccountPool } from '../../src/account-pool.js'
import { registerAccountHubRpc } from '../../src/account-hub-rpc.js'
import {
  autoRouteConfigFacts,
  autoRouteMasqueradeProblem,
  sanitizeAutoRouteConfig,
  assertValidAutoRouteConfig,
  type AutoRouteDefinition,
} from '../../src/auto-route.js'

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
  /** 预置进持久层文档的 `autoRoute` 原值。 */
  autoRoute?: unknown
}

/**
 * RPC 测试台：storage 替身 + settings 替身 + connection 替身。
 *
 * 形态照抄 `auto-route-rpc.spec.ts` 的 `makeHarness`（同一套 mock 约定，不另立一套）。
 * ⚠️ 伪装那一面**不再需要任何文件系统口子**：运输层的可用性是常量响应，没有可注入的
 * 目标来源（旧引擎的 `masqueradeLookup` 随它一并退役）。
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

/** `masquerade.status` / `masquerade.apply` 的响应形状。 */
interface TransportStatusValue {
  available: boolean
  transport?: string
}

describe('masquerade.status：运输层可用性（恒真常量，永不抛错）', () => {
  it('回 { available:true, transport:"als-fetch" }，且**只有这两个键**', async () => {
    const { h } = await setup()
    const result = await h.call('masquerade.status', {})
    expect(result.ok, '查询类方法必须回 ok:true：抛错会被面板显示成「加载失败」').toBe(true)
    const value = result.value as TransportStatusValue
    expect(value.available).toBe(true)
    expect(value.transport).toBe('als-fetch')
    // 旧形状的 `applied` / `reason` / `targetVersion` 随磁盘补丁引擎一并作废：它们答的是
    // 「文件打没打上」，而运输层根本没有可失败状态。留着会让面板又去分流一个不存在的档。
    expect(Object.keys(value).sort()).toEqual(['available', 'transport'])
  })

  it('**与配置无关**：没有任何候选、甚至没有 autoRoute 文档时结论也不变', async () => {
    // 运输层是否在场是**进程级事实**，不取决于用户配了什么。这条钉住「别再把它接回配置」。
    const { h } = await setup()
    const empty = await h.call('masquerade.status', {})
    expect((empty.value as TransportStatusValue).available).toBe(true)
  })

  it('配置了伪装时结论**逐字节相同**（该方法不再读配置）', async () => {
    const { h } = await setup({
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    const first = await h.call('masquerade.status', {})
    const second = await h.call('masquerade.status', {})
    expect(second.value).toEqual(first.value)
    expect((first.value as TransportStatusValue).available).toBe(true)
  })

  it('连查三次都成功（无状态、无副作用、可反复调用）', async () => {
    const { h } = await setup({
      autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] },
    })
    for (let index = 0; index < 3; index += 1) {
      const result = await h.call('masquerade.status', {})
      expect(result.ok, `第 ${index + 1} 次查询必须照样成功`).toBe(true)
      expect((result.value as TransportStatusValue).transport).toBe('als-fetch')
    }
  })
})

describe('masquerade.apply：已退役为无副作用的成功返回（运输层无需施加动作）', () => {
  it('回 ok:true，且响应与 `masquerade.status` **完全一致**', async () => {
    const { h } = await setup()
    const applied = await h.call('masquerade.apply', {})
    const status = await h.call('masquerade.status', {})
    expect(applied.ok, '运输层无需任何施加动作 ⇒ 这里不存在失败路径').toBe(true)
    // ⚠️ 两个方法共用宿主侧同一份常量（`MASQUERADE_TRANSPORT_STATUS`）。若哪天有人把
    // apply 改成「真的做点什么」，这条断言会先红 —— 而不是让面板拿到两个形状不同的响应。
    expect(applied.value).toEqual(status.value)
  })

  it('旧语义的键一个都不留（`applied` / `reason` / `targetVersion` 已随引擎退役）', async () => {
    const { h } = await setup()
    const result = await h.call('masquerade.apply', {})
    const value = result.value as Record<string, unknown>
    // 留着 `applied` 会诱导面板再去分流一个**运输层里根本没有**的档（「没打上」）。
    for (const dead of ['applied', 'reason', 'targetVersion']) {
      expect(dead in value, `旧键 ${dead} 不该再出现在响应里`).toBe(false)
    }
  })

  it('**幂等且零副作用**：连调两次都成功，且持久层一字不变', async () => {
    const { h } = await setup({ autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] } })
    const before = JSON.stringify(h.storageCurrent())
    const first = await h.call('masquerade.apply', {})
    const second = await h.call('masquerade.apply', {})
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // 旧实现会**改宿主磁盘上的适配器产物**；退役后它连持久层都不该碰。
    expect(JSON.stringify(h.storageCurrent()), 'apply 不该往持久层写任何东西').toBe(before)
    // 配置里有伪装块与否都不改变结论：运输层照旧只需在场。
    expect((second.value as TransportStatusValue).available).toBe(true)
  })
})

// ──────────────────────────── 3. 配置面 ────────────────────────────

/**
 * 旧实现里 `autoroute.get` / `autoroute.set` 各自**顺带触发一次补丁维持**（触发点 ②③）。
 * 那两个触发点随磁盘引擎一并退役：运输层随插件进程装载，没有任何「配置改了要重新施加」
 * 的动作可言。本节钉住「退役干净」—— 配置面本身照旧，且不再有维保日志。
 */
describe('配置面：伪装配置原样往返，与运输层彻底解耦', () => {
  it('autoroute.get / set 的返回体仍只有 enabled/models 两个键（响应形状未被污染）', async () => {
    const { h } = await setup()
    const result = await h.call('autoroute.set', { enabled: true, models: [MASQUERADE_DEFINITION] })
    expect(Object.keys(result.value as object).sort()).toEqual(['enabled', 'models'])
  })

  it('触发点已退役：get/set 都不再留任何「伪装」维保日志', async () => {
    const { h } = await setup({ autoRoute: { enabled: true, models: [MASQUERADE_DEFINITION] } })
    // 旧实现里这两条各自会跑一次维持，失败时往 logger 里写中文告警。运输层没有可失败态，
    // 故这里必须**一条都没有** —— 有的话说明还有旧路径挂在配置读写上。
    await h.call('autoroute.get', {})
    await h.call('autoroute.set', { enabled: false })
    expect(h.warnings.filter(message => message.includes('伪装'))).toEqual([])
  })

  it('伪装配置**原样往返**：set 存进去、get 读回来（含 windowId 逐字保留）', async () => {
    const { h } = await setup()
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

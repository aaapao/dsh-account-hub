/**
 * Account Hub **客户端伪装补丁引擎**单测（`src/masquerade-patch.ts`，纯文件 IO、零网络）。
 *
 * ## 为什么这个模块必须有独立单测
 *
 * 它要**改写宿主适配器产物本身**（`@deepseek-ai/dsh-llm-pi-ai/lib/index.js`）。这是本仓库
 * 唯一一处「写别人家文件」的功能，出错形态不是「功能不可用」而是「把宿主文件改坏」——
 * 前者用户看得见，后者是静默腐坏。故设计稿 §10.2 的 P1–P12 全部落在这里，核心是三类：
 *
 * 1. **不写比写错好**：锚点零命中 / 多次命中 / 围栏不配对 / 注入字面量被第三方改动
 *    —— 四种情况全部「抛错 + 原文件逐字节不变」。断言方式一律是**比对 Buffer**，
 *    而不是「文件里没有 marker」：后者漏掉「写了一半又改回来」的形态。
 * 2. **原子写回**（P7 / P8）：`writeDetached` 必须用临时文件 + `rename`。硬链接场景
 *    （pnpm store）下 `writeFileSync` 会**写穿到 store 原件**，这条只有用 `linkSync`
 *    造出 nlink=2 才能测出来，且是本仓库「不许污染用户依赖」的底线。
 * 3. **还原后逐字节等于打补丁前**（P5）：G5 的承诺，用原厂 fixture 的 Buffer 直接比。
 *
 * ## 注入函数的语义怎么测
 *
 * 注入函数是**追加到目标文件里的裸函数源码**（不能 import 插件模块），所以不能直接
 * `import` 它。做法是：打完补丁后从产物里**抽出函数源码**，用 `new Function` 求值 ——
 * 这同时完成两件事：证明它语法合法（能编译），并拿到它做语义断言（§10.3 C1–C4）。
 *
 * ## 测试纪律
 *
 * 全部落在 `os.tmpdir()` 下的临时目录，**绝不碰真实 `~/.dsh`**；每个用例自带 fixture，
 * 不共享可变状态。
 */

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MASQUERADE_INJECTED_FUNCTION,
  MASQUERADE_MAINTAIN_INTERVAL_MS,
  MASQUERADE_PATCH_MARKER,
  MASQUERADE_TARGET_PACKAGE,
  MASQUERADE_WINDOW_HEADER,
  applyPatch,
  inspectPatch,
  maintainPatches,
  masqueradeConfigured,
  resolvePatchedTarget,
  revertPatch,
  runMasqueradeMaintenance,
} from '../../src/masquerade-patch.js'

/** 段 1 的原厂调用点字面量（**在测试里独立重写一遍**，故意不 import）。 */
const ANCHOR = '\t\t\t\t\theaders: requestHeaders(profile.headers)'

/** 段 1 的注入后字面量（同样独立重写：锚点漂了要让测试红，而不是跟着实现一起漂）。 */
const ANCHOR_INJECTED = `\t\t\t\t\theaders: ${MASQUERADE_INJECTED_FUNCTION}(requestHeaders(profile.headers), options)`

/** 目标包版本（fixture 里写死的版本号）。 */
const FIXTURE_VERSION = '0.1.7-rc.1'

/**
 * 原厂 fixture：**结构与真机产物同形**到「锚点唯一命中」这一层。
 *
 * 刻意保留 `requestHeaders` 的归属头逻辑（`attributionHeaders` 赢过 profile 项）——
 * 那正是补丁必须存在的理由，也让「注入函数叠在归属头之上」这个语义可断言。
 */
function stockFixture(): string {
  return [
    'function requestHeaders(headers) {',
    '  const attribution = { "user-agent": "deepseek-harness/0.0.0" };',
    '  const reserved = new Set(Object.keys(attribution).map((key) => key.toLowerCase()));',
    '  const passed = {};',
    '  for (const key of Object.keys(headers ?? {})) {',
    '    if (!reserved.has(key.toLowerCase())) passed[key] = headers[key];',
    '  }',
    '  return { ...passed, ...attribution };',
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

/** 一个临时 profile：目标文件落在**共享层**候选路径上，故 `runMasqueradeMaintenance` 也能直接用。 */
interface Fixture {
  /** 假 dsh home（`dshHomePath(...segs)` 的基准目录）。 */
  readonly home: string
  /** 目标文件绝对路径。 */
  readonly file: string
  /** 目标包目录。 */
  readonly packageDir: string
}

const created: string[] = []

/** 造 fixture（`content` 缺省 = 原厂形态）。 */
function makeFixture(content: string = stockFixture()): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dshcm-spec-'))
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
  return { home, file, packageDir }
}

/** 假 `ctx.dshHomePath`。 */
function homePathOf(home: string): (...segments: string[]) => string {
  return (...segments: string[]) => join(home, ...segments)
}

/** 读成 Buffer（逐字节断言的唯一正确方式）。 */
function bytes(file: string): Buffer {
  return readFileSync(file)
}

/** 目录里除目标文件外的残留（P8：临时文件必须清理干净）。 */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name !== 'index.js')
}

/** 从产物里抽出注入函数源码（围栏之间那段）。 */
function extractInjectedSource(patched: string): string {
  const match = /function __dshAccountHubApplyMasquerade\(headers, options\) \{[\s\S]*?\n\}/.exec(patched)
  if (match === null) throw new Error('产物里找不到注入函数源码')
  return match[0]
}

/** 抽出并求值注入函数（顺带证明它语法合法）。 */
function loadInjected(patched: string): (headers: Record<string, string>, options: unknown) => Record<string, string> {
  const source = extractInjectedSource(patched)
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn ${MASQUERADE_INJECTED_FUNCTION};`)() as (
    headers: Record<string, string>,
    options: unknown,
  ) => Record<string, string>
}

/** 打完补丁并取回产物文本 + 注入函数。 */
function patchedFixture(): { fixture: Fixture; patched: string; apply: ReturnType<typeof loadInjected> } {
  const fixture = makeFixture()
  applyPatch(fixture.file)
  const patched = readFileSync(fixture.file, 'utf8')
  return { fixture, patched, apply: loadInjected(patched) }
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    // Windows 上只读文件删不掉：先松权限再删（用例失败时也不留垃圾）。
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // 清理失败不影响断言结论。
    }
  }
})

describe('resolvePatchedTarget', () => {
  it('共享层候选命中时返回该文件并读出目标包版本', () => {
    const fixture = makeFixture()
    const target = resolvePatchedTarget({ dshHomePath: homePathOf(fixture.home) })
    expect(target?.file).toBe(fixture.file)
    expect(target?.version).toBe(FIXTURE_VERSION)
  })

  it('profile 层候选命中时同样返回（两个候选各自独立，先命中先用）', () => {
    const root = mkdtempSync(join(tmpdir(), 'dshcm-profile-'))
    created.push(root)
    const packageDir = join(root, 'node_modules', ...MASQUERADE_TARGET_PACKAGE.split('/'))
    const file = join(packageDir, 'lib', 'index.js')
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: FIXTURE_VERSION }), 'utf8')
    writeFileSync(file, stockFixture(), 'utf8')
    const target = resolvePatchedTarget({ profileRoot: root })
    expect(target?.file).toBe(file)
  })

  it('两个候选全缺 ⇒ 返回 undefined（不是错误：该 profile 没装外部适配器）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshcm-empty-'))
    created.push(home)
    expect(resolvePatchedTarget({ dshHomePath: homePathOf(home) })).toBeUndefined()
  })

  it('一个来源都没给 ⇒ 返回 undefined，不抛错', () => {
    expect(resolvePatchedTarget()).toBeUndefined()
  })

  it('宿主路径解析器抛错时该候选视为不存在，不让功能整体炸掉', () => {
    expect(
      resolvePatchedTarget({
        dshHomePath: () => {
          throw new Error('配置非法')
        },
      }),
    ).toBeUndefined()
  })
})

describe('applyPatch', () => {
  it('P1 锚点唯一命中 ⇒ 写入成功，两段都在场，并记录目标版本', () => {
    const fixture = makeFixture()
    const result = applyPatch(fixture.file)
    expect(result.status).toBe('patched')
    expect(result.targetVersion).toBe(FIXTURE_VERSION)
    const patched = readFileSync(fixture.file, 'utf8')
    expect(patched).toContain(ANCHOR_INJECTED) // 段 1
    expect(patched).toContain(`function ${MASQUERADE_INJECTED_FUNCTION}(headers, options) {`) // 段 2
    expect(patched).toContain(MASQUERADE_PATCH_MARKER)
    expect(patched).toContain(FIXTURE_VERSION) // 版本记账
    expect(patched.endsWith('\n')).toBe(true)
  })

  it('P1 打补丁后的整份产物仍是合法 JS（把 export 摘掉后按函数体编译）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const patched = readFileSync(fixture.file, 'utf8').replace(/^export \{[^}]*\};$/m, '')
    expect(() => new Function(patched)).not.toThrow()
  })

  it('P2 锚点零命中 ⇒ 抛错且文件逐字节不变', () => {
    const fixture = makeFixture(stockFixture().replace(ANCHOR, '\t\t\t\t\theaders: otherHeaders(profile.headers)'))
    const before = bytes(fixture.file)
    expect(() => applyPatch(fixture.file)).toThrow(/零命中/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P3 锚点多次命中 ⇒ 抛错且文件逐字节不变（包一层会漏改其余位置）', () => {
    const fixture = makeFixture(stockFixture().replace(ANCHOR, `${ANCHOR}\n${ANCHOR}`))
    const before = bytes(fixture.file)
    expect(() => applyPatch(fixture.file)).toThrow(/多次命中/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P2 锚点只以**子串**形态出现（被注释掉）⇒ 零命中，不误改注释行', () => {
    // 子串判据会把这行算成命中，于是「注释里的旧调用点」被包一层、真调用点没动 ——
    // 产物语法仍合法、功能却完全没接上，是最难归因的形态。锚点必须是**整行**。
    const fixture = makeFixture(
      stockFixture()
        .replace(ANCHOR, '\t\t\t\t\theaders: otherHeaders(profile.headers)')
        .replace('function requestHeaders(headers) {', `// ${ANCHOR}\nfunction requestHeaders(headers) {`),
    )
    const before = bytes(fixture.file)
    expect(() => applyPatch(fixture.file)).toThrow(/零命中/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P1 锚点另有一处子串形态（注释行）⇒ 只改整行命中那处，注释行一字不动', () => {
    const fixture = makeFixture(
      stockFixture().replace('function requestHeaders(headers) {', `// ${ANCHOR}\nfunction requestHeaders(headers) {`),
    )
    applyPatch(fixture.file)
    const patched = readFileSync(fixture.file, 'utf8')
    expect(patched).toContain(`// ${ANCHOR}`) // 注释行原样保留
    expect(patched).toContain(ANCHOR_INJECTED) // 真调用点被包一层
  })

  it('P4 幂等：第二次打补丁返回 alreadyPatched，且文件逐字节不变', () => {
    const fixture = makeFixture()
    expect(applyPatch(fixture.file).status).toBe('patched')
    const once = bytes(fixture.file)
    expect(applyPatch(fixture.file).status).toBe('alreadyPatched')
    expect(bytes(fixture.file).equals(once)).toBe(true)
  })

  it('P11 marker 在场但版本记账缺失 ⇒ 按未知版本重新校验锚点并重打（不是 alreadyPatched）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const stripped = readFileSync(fixture.file, 'utf8')
      .split('\n')
      .filter(line => !line.startsWith('// dsh-account-hub target-version: '))
      .join('\n')
    writeFileSync(fixture.file, stripped, 'utf8')
    const result = applyPatch(fixture.file)
    expect(result.status).toBe('patched')
    expect(readFileSync(fixture.file, 'utf8')).toContain(`target-version: ${FIXTURE_VERSION}`)
  })

  it('P11 版本漂移 ⇒ 先还原再按新版本重打，记账版本更新为新值', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    writeFileSync(
      join(fixture.packageDir, 'package.json'),
      JSON.stringify({ version: '0.2.0' }),
      'utf8',
    )
    const result = applyPatch(fixture.file)
    expect(result.status).toBe('patched')
    expect(result.targetVersion).toBe('0.2.0')
    const patched = readFileSync(fixture.file, 'utf8')
    expect(patched).toContain('target-version: 0.2.0')
    expect(patched).not.toContain('target-version: 0.1.7-rc.1')
  })

  it('P10 目标文件不存在 ⇒ 抛 ENOENT，不静默创建', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshcm-missing-'))
    created.push(home)
    const file = join(home, 'nope', 'index.js')
    expect(() => applyPatch(file)).toThrow(/ENOENT/)
    expect(existsSync(file)).toBe(false)
  })

  it('P9 目标只读 ⇒ 抛错，原文件逐字节不变，且不留临时文件', () => {
    const fixture = makeFixture()
    const before = bytes(fixture.file)
    chmodSync(fixture.file, 0o444)
    try {
      expect(() => applyPatch(fixture.file)).toThrow()
      expect(bytes(fixture.file).equals(before)).toBe(true)
      expect(leftovers(join(fixture.packageDir, 'lib'))).toEqual([])
    } finally {
      chmodSync(fixture.file, 0o666)
    }
  })

  it('P7 硬链接分离：打补丁后另一个链接的文件内容不变（不污染 pnpm store）', () => {
    const fixture = makeFixture()
    const peer = join(fixture.packageDir, 'lib', 'peer-copy.js')
    linkSync(fixture.file, peer)
    expect(statSync(fixture.file).nlink).toBe(2)
    const peerBefore = bytes(peer)
    applyPatch(fixture.file)
    expect(bytes(peer).equals(peerBefore)).toBe(true) // 同伴链接一个字节都没动
    expect(statSync(fixture.file).nlink).toBe(1) // 目标已分离成独立文件
    expect(readFileSync(peer, 'utf8')).not.toContain(MASQUERADE_PATCH_MARKER)
  })

  it('P8 成功路径与失败路径都不留临时文件', () => {
    const fixture = makeFixture()
    const libDir = join(fixture.packageDir, 'lib')
    applyPatch(fixture.file)
    expect(leftovers(libDir)).toEqual([])
    // 失败路径（锚点漂移）
    const broken = makeFixture(stockFixture().replace(ANCHOR, '\t\t\t\t\theaders: other(profile.headers)'))
    expect(() => applyPatch(broken.file)).toThrow()
    expect(leftovers(join(broken.packageDir, 'lib'))).toEqual([])
  })
})

describe('revertPatch', () => {
  it('P5 还原后逐字节等于打补丁前', () => {
    const fixture = makeFixture()
    const original = bytes(fixture.file)
    applyPatch(fixture.file)
    expect(revertPatch(fixture.file).status).toBe('reverted')
    expect(bytes(fixture.file).equals(original)).toBe(true)
  })

  it('已是原厂形态 ⇒ alreadyStock，且一个字节都不写', () => {
    const fixture = makeFixture()
    const before = bytes(fixture.file)
    expect(revertPatch(fixture.file).status).toBe('alreadyStock')
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P6 围栏不配对（少一行 fence）⇒ 抛错且文件逐字节不变', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const patched = readFileSync(fixture.file, 'utf8')
    const broken = patched
      .split('\n')
      .filter(line => line !== '// --- dsh-account-hub masquerade fence end ---')
      .join('\n')
    writeFileSync(fixture.file, broken, 'utf8')
    const before = bytes(fixture.file)
    expect(() => revertPatch(fixture.file)).toThrow(/围栏不配对/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P6 围栏顺序错乱 ⇒ 抛错且不写', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const lines = readFileSync(fixture.file, 'utf8').split('\n')
    const start = lines.indexOf(MASQUERADE_PATCH_MARKER)
    const fenceStart = lines.indexOf('// --- dsh-account-hub masquerade fence start ---')
    // 把起始 marker 挪到 fence 之后 ⇒ 顺序判据不过。
    lines.splice(start, 1)
    lines.splice(fenceStart, 0, MASQUERADE_PATCH_MARKER)
    writeFileSync(fixture.file, lines.join('\n'), 'utf8')
    const before = bytes(fixture.file)
    expect(() => revertPatch(fixture.file)).toThrow()
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P6 补丁块不在文件末尾（后方被追加了内容）⇒ 抛错且不写', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    writeFileSync(fixture.file, `${readFileSync(fixture.file, 'utf8')}// 第三方追加\n`, 'utf8')
    const before = bytes(fixture.file)
    expect(() => revertPatch(fixture.file)).toThrow(/不在文件末尾/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P12 调用点字面量被第三方改回原厂 ⇒ 抛错且不写（不猜、不写半截）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const tampered = readFileSync(fixture.file, 'utf8').replace(ANCHOR_INJECTED, ANCHOR)
    writeFileSync(fixture.file, tampered, 'utf8')
    const before = bytes(fixture.file)
    expect(() => revertPatch(fixture.file)).toThrow(/找不到注入后的调用点字面量/)
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('P12 调用点被改成第三种写法 ⇒ 抛错且不写', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const tampered = readFileSync(fixture.file, 'utf8').replace(ANCHOR_INJECTED, `${ANCHOR_INJECTED} /* 改过 */`)
    writeFileSync(fixture.file, tampered, 'utf8')
    const before = bytes(fixture.file)
    expect(() => revertPatch(fixture.file)).toThrow()
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('还原后再还原仍是 alreadyStock（幂等，且不再写盘）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    expect(revertPatch(fixture.file).status).toBe('reverted')
    const stock = bytes(fixture.file)
    expect(revertPatch(fixture.file).status).toBe('alreadyStock')
    expect(bytes(fixture.file).equals(stock)).toBe(true)
  })
})

describe('inspectPatch（面板徽标数据源：尽力而为、永不抛错）', () => {
  it('原厂形态 ⇒ stock', () => {
    const fixture = makeFixture()
    const info = inspectPatch(fixture.file)
    expect(info).toMatchObject({ stock: true, patched: false, markerPresent: false, targetVersion: FIXTURE_VERSION })
  })

  it('补丁在场且判据链全过 ⇒ patched，并带出记账版本', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    expect(inspectPatch(fixture.file)).toMatchObject({
      stock: false,
      patched: true,
      markerPresent: true,
      recordedVersion: FIXTURE_VERSION,
      targetVersion: FIXTURE_VERSION,
    })
  })

  it('marker 在场但围栏坏了 ⇒ patched=false + 中文 reason（不抛错）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    writeFileSync(
      fixture.file,
      readFileSync(fixture.file, 'utf8')
        .split('\n')
        .filter(line => line !== '// --- dsh-account-hub masquerade fence end ---')
        .join('\n'),
      'utf8',
    )
    const info = inspectPatch(fixture.file)
    expect(info.patched).toBe(false)
    expect(info.markerPresent).toBe(true)
    expect(info.reason).toBeTruthy()
  })

  it('文件不存在 ⇒ 返回对象 + reason，不抛错', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshcm-inspect-'))
    created.push(home)
    const info = inspectPatch(join(home, 'nope.js'))
    expect(info.patched).toBe(false)
    expect(info.reason).toBeTruthy()
  })
})

describe('注入函数语义（设计稿 §3.4 / §10.3 C1–C4）', () => {
  const base = (): Record<string, string> => ({ 'user-agent': 'deepseek-harness/0.0.0', 'content-type': 'application/json' })

  it('C1 三个载体字段全缺席 ⇒ 返回**同一引用**，一个字节都不变', () => {
    const { apply } = patchedFixture()
    const headers = base()
    const out = apply(headers, {})
    expect(out).toBe(headers) // 同一引用（不是「相等」）
  })

  it('C1 options 本身缺失 / 非对象 ⇒ 同样原样返回', () => {
    const { apply } = patchedFixture()
    for (const options of [undefined, null, 42, 'x', []]) {
      const headers = base()
      expect(apply(headers, options)).toBe(headers)
    }
  })

  it('C2 只配 User-Agent ⇒ 只换 user-agent，其余头不动', () => {
    const { apply } = patchedFixture()
    const out = apply(base(), { accountHubUserAgent: 'codex_exec' })
    expect(out['User-Agent']).toBe('codex_exec')
    expect(out['user-agent']).toBeUndefined()
    expect(out['content-type']).toBe('application/json')
  })

  it('C2 只配 Originator ⇒ 只加 Originator（该头本就不存在）', () => {
    const { apply } = patchedFixture()
    const out = apply(base(), { accountHubOriginator: 'codex_cli_rs' })
    expect(out['Originator']).toBe('codex_cli_rs')
    expect(out['user-agent']).toBe('deepseek-harness/0.0.0')
  })

  it('C4 只配 masquerade ⇒ 只写 x-codex-window-id，不碰 UA，且不发 body 开关头', () => {
    const { apply } = patchedFixture()
    const out = apply(base(), { accountHubMasquerade: { windowId: 'win-1' } })
    expect(out[MASQUERADE_WINDOW_HEADER]).toBe('win-1')
    expect(out['user-agent']).toBe('deepseek-harness/0.0.0')
    expect(out['x-dsh-body-masquerade']).toBeUndefined() // §13 分叉 e：body 路线已砍
  })

  it('C3 异形键清理：同时存在 user-agent / User-Agent ⇒ 只留一个，不产生重复头', () => {
    const { apply } = patchedFixture()
    const out = apply({ 'user-agent': 'old', 'User-Agent': 'older', 'USER-AGENT': 'oldest' }, { accountHubUserAgent: 'codex_exec' })
    const variants = Object.keys(out).filter(key => key.toLowerCase() === 'user-agent')
    expect(variants).toEqual(['User-Agent'])
    expect(out['User-Agent']).toBe('codex_exec')
  })

  it('C3 异形键清理同样作用于 Originator', () => {
    const { apply } = patchedFixture()
    const out = apply({ originator: 'old', Originator: 'older' }, { accountHubOriginator: 'codex_cli_rs' })
    expect(Object.keys(out).filter(key => key.toLowerCase() === 'originator')).toEqual(['Originator'])
  })

  it('最小防御：空串 / 全空白 / 非字符串一律视为未配置（合法性归写路径管）', () => {
    const { apply } = patchedFixture()
    for (const value of ['', '   ', 42, null, {}, undefined]) {
      const headers = base()
      expect(apply(headers, { accountHubUserAgent: value })).toBe(headers)
    }
  })

  it('masquerade 非对象 / windowId 非字符串 ⇒ 视为未配置，原样返回', () => {
    const { apply } = patchedFixture()
    for (const masquerade of [null, 'x', 42, {}, { windowId: 42 }, { windowId: '' }, { windowId: '  ' }]) {
      const headers = base()
      expect(apply(headers, { accountHubMasquerade: masquerade })).toBe(headers)
    }
  })

  it('三字段齐备 ⇒ 三个头都按各自规矩写好', () => {
    const { apply } = patchedFixture()
    const out = apply(base(), {
      accountHubUserAgent: 'codex_exec',
      accountHubOriginator: 'codex_cli_rs',
      accountHubMasquerade: { windowId: 'win-1' },
    })
    expect(out).toMatchObject({
      'User-Agent': 'codex_exec',
      Originator: 'codex_cli_rs',
      [MASQUERADE_WINDOW_HEADER]: 'win-1',
      'content-type': 'application/json',
    })
    expect(out['user-agent']).toBeUndefined()
  })

  it('不修改传入对象（写入发生在副本上）', () => {
    const { apply } = patchedFixture()
    const headers = base()
    apply(headers, { accountHubUserAgent: 'codex_exec' })
    expect(headers['user-agent']).toBe('deepseek-harness/0.0.0')
    expect(headers['User-Agent']).toBeUndefined()
  })

  it('注入函数源码零 import / 零 require（rollup 产物的纪律）', () => {
    const { patched } = patchedFixture()
    const source = extractInjectedSource(patched)
    expect(source).not.toMatch(/\bimport\b/)
    expect(source).not.toMatch(/\brequire\b/)
  })
})

describe('masqueradeConfigured（维持与还原共用的同一判据）', () => {
  const configOf = (entry: unknown): unknown => ({ enabled: true, models: [{ id: 'm', name: 'm', entries: [entry] }] })

  it('有 windowId 的条目 ⇒ true', () => {
    expect(masqueradeConfigured(configOf({ provider: 'router-4', model: 'gpt-5', masquerade: { windowId: 'w' } }))).toBe(true)
  })

  it('没有 masquerade / 空 windowId / 脏值 ⇒ false（与注入函数「会真的写头」的条件对齐）', () => {
    expect(masqueradeConfigured(configOf({ provider: 'p', model: 'm' }))).toBe(false)
    expect(masqueradeConfigured(configOf({ provider: 'p', model: 'm', masquerade: { windowId: '' } }))).toBe(false)
    expect(masqueradeConfigured(configOf({ provider: 'p', model: 'm', masquerade: { windowId: '   ' } }))).toBe(false)
    expect(masqueradeConfigured(configOf({ provider: 'p', model: 'm', masquerade: { windowId: 42 } }))).toBe(false)
    expect(masqueradeConfigured(configOf({ provider: 'p', model: 'm', masquerade: 'x' }))).toBe(false)
  })

  it('结构性读取：形状不对（null / 非对象 / models 非数组）⇒ false，不抛错', () => {
    for (const config of [undefined, null, 42, 'x', {}, { models: 'x' }, { models: [null] }, { models: [{ entries: 'x' }] }]) {
      expect(masqueradeConfigured(config)).toBe(false)
    }
  })
})

describe('runMasqueradeMaintenance（§3.8 判据链）', () => {
  it('目标包不存在 ⇒ unavailable（静默不可用，不是错误）', () => {
    const home = mkdtempSync(join(tmpdir(), 'dshcm-na-'))
    created.push(home)
    const result = runMasqueradeMaintenance({ dshHomePath: homePathOf(home), readAutoRouteConfig: () => undefined })
    expect(result.status).toBe('unavailable')
    expect(result.target).toBeUndefined()
  })

  it('未配置伪装 + 原厂形态 ⇒ idle，不写文件', () => {
    const fixture = makeFixture()
    const before = bytes(fixture.file)
    const result = runMasqueradeMaintenance({ dshHomePath: homePathOf(fixture.home), readAutoRouteConfig: () => ({ models: [] }) })
    expect(result.status).toBe('idle')
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('配置了伪装 + 原厂形态 ⇒ 自动打补丁（G4）', () => {
    const fixture = makeFixture()
    const result = runMasqueradeMaintenance({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }),
    })
    expect(result.status).toBe('patched')
    expect(readFileSync(fixture.file, 'utf8')).toContain(MASQUERADE_PATCH_MARKER)
  })

  it('配置了伪装 + 已在场 ⇒ alreadyPatched，不重写', () => {
    const fixture = makeFixture()
    const deps = {
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }),
    }
    expect(runMasqueradeMaintenance(deps).status).toBe('patched')
    const once = bytes(fixture.file)
    expect(runMasqueradeMaintenance(deps).status).toBe('alreadyPatched')
    expect(bytes(fixture.file).equals(once)).toBe(true)
  })

  it('S1/S4 清空所有条目的伪装头 ⇒ 自动还原，且逐字节回到原厂（G5）', () => {
    const fixture = makeFixture()
    const original = bytes(fixture.file)
    const on = { dshHomePath: homePathOf(fixture.home), readAutoRouteConfig: () => ({ models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }) }
    expect(runMasqueradeMaintenance(on).status).toBe('patched')
    const off = { dshHomePath: homePathOf(fixture.home), readAutoRouteConfig: () => ({ models: [{ entries: [{ provider: 'p' }] }] }) }
    expect(runMasqueradeMaintenance(off).status).toBe('reverted')
    expect(bytes(fixture.file).equals(original)).toBe(true)
  })

  it('R3 锚点漂移 + 配置了伪装 ⇒ failed 且**绝不写文件**（不盲目重写）', () => {
    const fixture = makeFixture(stockFixture().replace(ANCHOR, '\t\t\t\t\theaders: other(profile.headers)'))
    const before = bytes(fixture.file)
    const warnings: string[] = []
    const result = runMasqueradeMaintenance({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }),
      logger: { warn: message => warnings.push(message) },
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toBeTruthy()
    expect(warnings.join('\n')).toContain('维持失败')
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('半截补丁（围栏坏了）+ 已无配置 ⇒ failed 且不写（不猜着裁）', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    writeFileSync(
      fixture.file,
      readFileSync(fixture.file, 'utf8').split('\n').filter(line => line !== MASQUERADE_PATCH_MARKER).join('\n'),
      'utf8',
    )
    const before = bytes(fixture.file)
    const result = runMasqueradeMaintenance({ dshHomePath: homePathOf(fixture.home), readAutoRouteConfig: () => ({ models: [] }) })
    expect(result.status).toBe('failed')
    expect(bytes(fixture.file).equals(before)).toBe(true)
  })

  it('读配置抛错 ⇒ 按「未配置」处置（最保守：走还原），不炸维持循环', () => {
    const fixture = makeFixture()
    applyPatch(fixture.file)
    const result = runMasqueradeMaintenance({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => {
        throw new Error('storage 未就绪')
      },
      logger: { warn: () => undefined },
    })
    expect(result.status).toBe('reverted')
  })
})

describe('maintainPatches（触发点 ① 启动立刻跑 + ④ 5 分钟定时器）', () => {
  it('立刻跑一次，并用 ctx.effect 管定时器生命周期', () => {
    const fixture = makeFixture()
    const labels: string[] = []
    let cleanups = 0
    maintainPatches({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }),
      effect: (_setup, label) => {
        labels.push(label)
      },
    })
    expect(readFileSync(fixture.file, 'utf8')).toContain(MASQUERADE_PATCH_MARKER)
    expect(labels).toEqual(['account-hub: client masquerade patch maintainer'])
    expect(cleanups).toBe(0)
  })

  it('effect 的清理函数可用（fiber 销毁即 clearInterval）', () => {
    const fixture = makeFixture()
    let cleanup: (() => void) | undefined
    maintainPatches({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [] }),
      effect: setup => {
        cleanup = setup()
      },
    })
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup?.()).not.toThrow()
  })

  it('缺省 effect ⇒ 只跑一次、不装定时器（单测不引入真实定时器）', () => {
    const fixture = makeFixture()
    let reads = 0
    maintainPatches({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => {
        reads += 1
        return { models: [] }
      },
    })
    expect(reads).toBe(1)
  })

  it('定时器按间隔重复维持（S1/S3 静默失效的自愈路径）', async () => {
    const fixture = makeFixture()
    let reads = 0
    let cleanup: (() => void) | undefined
    maintainPatches({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => {
        reads += 1
        return { models: [{ entries: [{ masquerade: { windowId: 'w' } }] }] }
      },
      intervalMs: 5,
      effect: setup => {
        cleanup = setup()
      },
    })
    expect(reads).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 40))
    cleanup?.()
    expect(reads).toBeGreaterThan(1)
    expect(readFileSync(fixture.file, 'utf8')).toContain(MASQUERADE_PATCH_MARKER)
  })

  it('间隔 ≤ 0 ⇒ 不装定时器（调用方显式关闭）', () => {
    const fixture = makeFixture()
    const labels: string[] = []
    maintainPatches({
      dshHomePath: homePathOf(fixture.home),
      readAutoRouteConfig: () => ({ models: [] }),
      intervalMs: 0,
      effect: (_setup, label) => {
        labels.push(label)
      },
    })
    expect(labels).toEqual([])
  })

  it('默认间隔是 5 分钟（§13 分叉 j）', () => {
    expect(MASQUERADE_MAINTAIN_INTERVAL_MS).toBe(5 * 60 * 1000)
  })
})

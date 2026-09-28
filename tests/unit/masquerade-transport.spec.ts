/**
 * Account Hub **客户端伪装运输层**单测（`src/account-hub-masquerade-transport.ts`，
 * **零网络**：所有 `fetch` 都是本地假函数）。
 *
 * ## 这个模块为什么必须单独测
 *
 * 它是伪装参数与「真的被发出去的那一次请求」之间的**唯一通道**，而且是全插件唯一
 * 直接改写 `globalThis.fetch` 的地方 —— 出错的影响面不是一条 provider，而是**所有**
 * 出站请求。故用例分四组钉住四件互相独立的事：
 *
 * 1. **`applyMasqueradeHeaders` 三种载体形态各按自己的规矩写** —— `Headers` 大小写
 *    不敏感；`string[][]` 要就地对调、保序、去重；普通对象**必须先清异形键**，否则
 *    同一次请求出现两个同名头，上游看到的是拼接值（真机上极难定位）。
 * 2. **`globalThis.fetch` 包装器的两条路径** —— 无载荷时**零变化**（`init` 连字段都
 *    不被读，更不许代造 `headers`）；有载荷时**就地改写**、`init` 对象身份不变
 *    （重建就会丢掉 `duplex` / 流式 `body` 这类不可复制的字段）。
 * 3. **`withMasqueradeAsyncIterable` 的核心纪律** —— async generator 的函数体在
 *    **恢复它的那一次 `.next()`** 的上下文里执行，与创建位置无关；故生成器在上下文
 *    之外创建、只经由代理消费时，函数体里也必须读得到载荷。这条纪律写错了不会报错，
 *    只会「伪装整段静默失效」，只有这里能提前钉住。
 * 4. **安装 / 卸载的对称性** —— 幂等（不叠层）、只拆自己那一层（不踩别人的包装）、
 *    卸下后能重装；且**模块加载零副作用**（import 那一刻不许已经动过 `globalThis.fetch`）。
 *
 * ## 为什么每一组都要覆盖「三种形态」
 *
 * 三个形态在真机上**都有主**：`codearts` / `buddy` / `lobsterai` 用 `Headers`，
 * `trae-cn` / `qoder` 用普通对象，而 `string[][]` 是 SDK 传 `Headers` 初始化数组时的
 * 真实形态。漏测一个形态 = 漏掉一部分适配器的出站头。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_HUB_USER_AGENT_MAX_LENGTH,
} from '../../src/account-hub-user-agent.js'
import {
  ACCOUNT_HUB_WINDOW_ID_HEADER,
  ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH,
} from '../../src/account-hub-window-id.js'
import {
  applyMasqueradeHeaders,
  currentMasqueradePayload,
  ensureMasqueradeFetch,
  isMasqueradeFetchInstalled,
  releaseMasqueradeFetch,
  withMasqueradeAsyncIterable,
} from '../../src/account-hub-masquerade-transport.js'
import type { MasqueradePayload } from '../../src/account-hub-masquerade-transport.js'

/** 三件套齐全的载荷（部分伪装另有专门用例）。 */
const FULL: MasqueradePayload = {
  userAgent: 'Masquerade/1.0',
  originator: 'codex_cli_rs',
  windowId: 'win-abc-123',
}

/** 进程原本的 `fetch`（每个用例结束后无条件还原，绝不污染其它 spec 文件）。 */
const ORIGINAL_FETCH = globalThis.fetch

/**
 * 本模块被 import 的那一刻，`globalThis.fetch` 是否已经是本模块装的包装器。
 *
 * 这个常量是「**模块加载零副作用**」的唯一证据：vitest 每个 spec 文件独立求值模块图，
 * 故这里的值必须是 `false` —— 若哪次实现把 `ensureMasqueradeFetch()` 写到模块顶层去了，
 * 这条会立刻红（而那种写法会让「谁 import 谁被改全局」这种后果无声扩散）。
 */
const INSTALLED_AT_IMPORT = isMasqueradeFetchInstalled()

afterEach(() => {
  // 先按正规路径卸（覆盖「拆自己那一层」的行为），再无条件还原兜底。
  releaseMasqueradeFetch()
  globalThis.fetch = ORIGINAL_FETCH
})

/** 某个头名在普通对象里的**全部**键（大小写不敏感）—— 「绝无双头」判据的落点。 */
const aliasesOf = (headers: Record<string, string>, name: string): string[] =>
  Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase())

/** 某个头名在 `string[][]` 里的**全部**对（大小写不敏感）。 */
const pairsOf = (headers: string[][], name: string): string[][] =>
  headers.filter((pair) => typeof pair[0] === 'string' && pair[0].toLowerCase() === name.toLowerCase())

/** 一次假 `fetch` 调用留下的实参（**原样引用**，用于断言「有没有被重建」）。 */
interface FetchCall {
  readonly input: string | URL | Request
  readonly init: RequestInit | undefined
}

/**
 * 造一个假 `fetch` 并**先装到 `globalThis` 上**。
 *
 * 顺序是关键：`ensureMasqueradeFetch()` 在**安装时刻**捕获 `globalThis.fetch`，
 * 故必须先摆好下一层，再装包装器 —— 这也正是它能与别的包装器共存的原因。
 */
function installFakeBase(): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const base = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init })
    return Promise.resolve(new Response('ok'))
  }) as typeof fetch
  globalThis.fetch = base
  return { calls }
}

/**
 * 在**伪装载荷上下文**里跑一段代码。
 *
 * 刻意不用任何内部后门（`AsyncLocalStorage` 是模块私有的）：载荷只可能经由
 * {@link withMasqueradeAsyncIterable} 代理的 `next()` 进来 —— 于是每个用到它的用例
 * 都顺带验证了一遍那条核心纪律。生成器**在外层创建**（`driver()` 的求值不在载荷里），
 * 函数体在代理 `next()` 推入上下文后才执行。
 */
async function runWithPayload<T>(payload: MasqueradePayload, body: () => Promise<T>): Promise<T> {
  async function* driver(): AsyncGenerator<T> {
    yield await body()
  }
  const iterable = withMasqueradeAsyncIterable(payload, driver())
  for await (const value of iterable) return value
  throw new Error('driver 没有产出值')
}

describe('applyMasqueradeHeaders：Headers 形态', () => {
  it('三个头全部写入，既有值被**整体替换**（不是追加、不是前缀）', () => {
    // 预置一个**小写**的框架头 —— 这正是 `attributionHeaders()` 的真实形态。
    const headers = new Headers({ 'user-agent': 'framework/1.0', accept: 'text/event-stream' })

    expect(
      applyMasqueradeHeaders(headers, FULL),
      '配了合法载荷时必须报告「真的写了」（false 会被调用方当成「没配」）',
    ).toBe(true)

    // `Headers.get()` 对同名多头会返回 `, ` 拼接值，故「等于覆写值本身」同时也证明了
    // 同一次请求里只有一个该头。
    expect(headers.get('User-Agent')).toBe('Masquerade/1.0')
    expect(headers.get('user-agent')).toBe('Masquerade/1.0')
    expect(headers.get('Originator')).toBe(FULL.originator)
    expect(headers.get(ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL.windowId)
    expect(headers.get('accept')).toBe('text/event-stream')
  })

  it('原本没有的头也能**新增**（Originator / windowId 的常态）', () => {
    const headers = new Headers()
    expect(applyMasqueradeHeaders(headers, FULL)).toBe(true)
    expect(headers.get('Originator')).toBe(FULL.originator)
    expect(headers.get(ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL.windowId)
  })
})

describe('applyMasqueradeHeaders：string[][] 形态', () => {
  it('同名对**就地对调**（保序）、重复对删除、缺的对追加', () => {
    const headers: string[][] = [
      ['accept', 'text/event-stream'],
      ['user-agent', 'framework/1.0'],
      ['User-Agent', 'product/2.0'],
      ['x-trace', 'abc'],
    ]

    expect(applyMasqueradeHeaders(headers, FULL)).toBe(true)

    // 逐对断言整份数组：位置、数量、值一次看全 —— 只断言「值对不对」看不出双头。
    expect(headers).toEqual([
      ['accept', 'text/event-stream'],
      ['User-Agent', FULL.userAgent],
      ['x-trace', 'abc'],
      ['Originator', FULL.originator],
      [ACCOUNT_HUB_WINDOW_ID_HEADER, FULL.windowId],
    ])
    // 换个值而已，不该把 UA 挪到头的末尾去（头顺序会影响部分上游的指纹校验）。
    expect(pairsOf(headers, 'user-agent')).toEqual([['User-Agent', FULL.userAgent]])
    expect(headers.length).toBe(5)
  })

  it('空数组里三个头按 User-Agent → Originator → windowId 顺序追加', () => {
    const headers: string[][] = []
    expect(applyMasqueradeHeaders(headers, FULL)).toBe(true)
    expect(headers).toEqual([
      ['User-Agent', FULL.userAgent],
      ['Originator', FULL.originator],
      [ACCOUNT_HUB_WINDOW_ID_HEADER, FULL.windowId],
    ])
  })
})

describe('applyMasqueradeHeaders：普通对象形态', () => {
  it('异形键被清理干净，只剩规范键（绝无双头）', () => {
    const headers: Record<string, string> = {
      'user-agent': 'framework/1.0',
      'USER-AGENT': 'product/2.0',
      Accept: 'text/event-stream',
    }

    expect(applyMasqueradeHeaders(headers, FULL)).toBe(true)

    // ⚠️ 本组用例的核心判据：漏清一个键，同一次请求就会带两个同名头。
    expect(aliasesOf(headers, 'user-agent')).toEqual(['User-Agent'])
    expect(headers['User-Agent']).toBe(FULL.userAgent)
    expect(headers.Originator).toBe(FULL.originator)
    expect(headers[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe(FULL.windowId)
    // 异形键确实被**删除**（而不是留成空串挂在对象里）。
    expect('user-agent' in headers).toBe(false)
    expect('USER-AGENT' in headers).toBe(false)
    // 无关头一个都不许被顺手改动。
    expect(headers.Accept).toBe('text/event-stream')
  })

  it('只有异形键、没有规范键时也清理干净', () => {
    const headers: Record<string, string> = { 'user-agent': 'framework/1.0' }
    expect(applyMasqueradeHeaders(headers, FULL)).toBe(true)
    expect(aliasesOf(headers, 'user-agent')).toEqual(['User-Agent'])
    expect('user-agent' in headers).toBe(false)
  })
})

describe('applyMasqueradeHeaders：部分伪装与空载荷', () => {
  it('只配了一个字段 → 只写那一个头，其余一个字节都不动', () => {
    const onlyOriginator: MasqueradePayload = { originator: 'codex_cli_rs' }

    const objectHeaders: Record<string, string> = { 'user-agent': 'framework/1.0' }
    expect(applyMasqueradeHeaders(objectHeaders, onlyOriginator)).toBe(true)
    expect(objectHeaders.Originator).toBe('codex_cli_rs')
    // 框架 UA 连大小写形态都原样留着（没配就不许碰）。
    expect(aliasesOf(objectHeaders, 'user-agent')).toEqual(['user-agent'])
    expect(ACCOUNT_HUB_WINDOW_ID_HEADER in objectHeaders).toBe(false)

    const headerList = new Headers({ 'user-agent': 'framework/1.0' })
    expect(applyMasqueradeHeaders(headerList, onlyOriginator)).toBe(true)
    expect(headerList.get('user-agent')).toBe('framework/1.0')
    expect(headerList.get('Originator')).toBe('codex_cli_rs')
    expect(headerList.get(ACCOUNT_HUB_WINDOW_ID_HEADER)).toBeNull()
  })

  it('空载荷 → 返回 false，三种形态都零变化', () => {
    const headerList = new Headers({ accept: 'text/event-stream' })
    const objectHeaders: Record<string, string> = { accept: 'text/event-stream' }
    const pairHeaders: string[][] = [['accept', 'text/event-stream']]

    expect(applyMasqueradeHeaders(headerList, {})).toBe(false)
    expect(applyMasqueradeHeaders(objectHeaders, {})).toBe(false)
    expect(applyMasqueradeHeaders(pairHeaders, {})).toBe(false)

    expect(headerList.get('accept')).toBe('text/event-stream')
    expect(objectHeaders).toEqual({ accept: 'text/event-stream' })
    expect(pairHeaders).toEqual([['accept', 'text/event-stream']])
  })

  it('容器为 undefined → 返回 false 且不抛错（造载体是调用方的事）', () => {
    expect(() => applyMasqueradeHeaders(undefined, FULL)).not.toThrow()
    expect(applyMasqueradeHeaders(undefined, FULL)).toBe(false)
  })
})

describe('applyMasqueradeHeaders：非法值只退化成「少一个头」', () => {
  it('User-Agent 值非法 → 跳过该头，另外两个照写（不连坐、不外抛）', () => {
    const illegal: unknown[] = [
      '', // 空串：缺省即「不覆写」，不需要用空串表达
      '   ', // trim 后为空：同上
      'a'.repeat(ACCOUNT_HUB_USER_AGENT_MAX_LENGTH + 1), // 超长
      'Agent/1.0\r\nX-Injected: evil', // CRLF —— 头注入的经典入口
      'Agent/1.0\nX-Injected: evil', // 裸 LF
      'Agent\t1.0', // TAB 也是控制字符
      '\u0000Agent', // NUL
      42, // 非字符串（可能来自 RPC 反序列化）
      null,
    ]

    for (const value of illegal) {
      const label = JSON.stringify(value)
      const payload: MasqueradePayload = {
        userAgent: value as string,
        originator: 'codex_cli_rs',
        windowId: 'win-abc-123',
      }

      const objectHeaders: Record<string, string> = {}
      expect(
        () => applyMasqueradeHeaders(objectHeaders, payload),
        `普通对象形态：UA=${label} 绝不许抛错（抛错会把一次配置笔误升级成请求失败）`,
      ).not.toThrow()
      expect(aliasesOf(objectHeaders, 'user-agent'), `普通对象形态：UA=${label} 必须被当成「没配」`).toEqual([])
      expect(objectHeaders.Originator).toBe('codex_cli_rs')
      expect(objectHeaders[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe('win-abc-123')

      // `Headers` 形态：判据（normalize）在 `set()` 之前就拦下脏值，于是
      // `Headers.set` 根本收不到会让它抛 `TypeError` 的输入。
      const headerList = new Headers()
      expect(() => applyMasqueradeHeaders(headerList, payload), `Headers 形态：UA=${label} 绝不许抛错`).not.toThrow()
      expect(headerList.get('User-Agent')).toBeNull()
      expect(headerList.get('Originator')).toBe('codex_cli_rs')

      const pairHeaders: string[][] = []
      expect(() => applyMasqueradeHeaders(pairHeaders, payload), `数组形态：UA=${label} 绝不许抛错`).not.toThrow()
      expect(pairsOf(pairHeaders, 'user-agent')).toEqual([])
      expect(pairsOf(pairHeaders, 'originator')).toEqual([['Originator', 'codex_cli_rs']])
    }
  })

  it('windowId 判据复用 account-hub-window-id：脏值不发、合法值 trim 后发出', () => {
    const illegal: unknown[] = [
      '',
      '   ',
      'x'.repeat(ACCOUNT_HUB_WINDOW_ID_MAX_LENGTH + 1),
      'win\r\nX-Injected: evil',
      'win\n1',
      'win\t1',
      7,
      null,
      undefined,
    ]

    for (const value of illegal) {
      const headers: Record<string, string> = {}
      expect(() => applyMasqueradeHeaders(headers, { windowId: value as string })).not.toThrow()
      expect(
        ACCOUNT_HUB_WINDOW_ID_HEADER in headers,
        `windowId=${JSON.stringify(value)} 必须被当成「没配」（判据与读路径同源）`,
      ).toBe(false)
    }

    const headers: Record<string, string> = {}
    expect(applyMasqueradeHeaders(headers, { windowId: '  win-abc-123  ' })).toBe(true)
    expect(headers[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe('win-abc-123')
  })

  it('容器写不动（只读 guard）时同样只退化：不外抛、不阻断请求', () => {
    // 冻结对象 / 冻结数组上的写入在严格模式（ESM 恒为严格模式）里抛 `TypeError`，
    // 正是「写不进去」的真实样本 —— 伪装是锦上添花，绝不能让它变成请求失败。
    const frozenObject = Object.freeze({ accept: 'text/event-stream' }) as Record<string, string>
    expect(
      () => applyMasqueradeHeaders(frozenObject, FULL),
      '冻结容器上写头会抛 TypeError，必须就地吃掉',
    ).not.toThrow()
    expect(applyMasqueradeHeaders(frozenObject, FULL)).toBe(false)

    const frozenPairs = Object.freeze([['accept', 'text/event-stream']]) as unknown as string[][]
    expect(() => applyMasqueradeHeaders(frozenPairs, FULL)).not.toThrow()
    expect(applyMasqueradeHeaders(frozenPairs, FULL)).toBe(false)
  })
})

describe('ensureMasqueradeFetch / releaseMasqueradeFetch', () => {
  it('模块加载零副作用：import 那一刻并没有装包装器', () => {
    expect(INSTALLED_AT_IMPORT).toBe(false)
  })

  it('幂等：连续调用只装一层，不叠加', async () => {
    const { calls } = installFakeBase()
    const base = globalThis.fetch

    ensureMasqueradeFetch()
    const installed = globalThis.fetch
    expect(isMasqueradeFetchInstalled()).toBe(true)
    expect(installed).not.toBe(base)

    ensureMasqueradeFetch()
    ensureMasqueradeFetch()

    // 同一个函数对象 = 没有叠层。
    expect(globalThis.fetch).toBe(installed)
    // 叠层的直接证据：一次调用只该打到最底层一次。
    await globalThis.fetch('https://example.test/v1')
    expect(calls.length).toBe(1)
  })

  it('release 还原到安装时捕获的那一层，且之后可以重新安装', async () => {
    const { calls } = installFakeBase()
    const base = globalThis.fetch

    ensureMasqueradeFetch()
    expect(globalThis.fetch).not.toBe(base)

    releaseMasqueradeFetch()
    expect(globalThis.fetch).toBe(base)
    expect(isMasqueradeFetchInstalled()).toBe(false)

    // 卸下之后请求直通（不再有本模块这一层）。
    await globalThis.fetch('https://example.test/v1')
    expect(calls.length).toBe(1)

    // 「卸下 → 再装」不是单向门：重装后载荷路径照常生效。
    ensureMasqueradeFetch()
    expect(isMasqueradeFetchInstalled()).toBe(true)
    const init: RequestInit = { headers: {} }
    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1', init))
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(FULL.userAgent)
  })

  it('release 只拆自己那一层：`globalThis.fetch` 已被别人替换时什么都不做', () => {
    installFakeBase()
    ensureMasqueradeFetch()

    const foreign = (() => Promise.resolve(new Response('foreign'))) as typeof fetch
    globalThis.fetch = foreign

    releaseMasqueradeFetch()

    // 硬还原会踩掉别人的包装 —— 这里必须原封不动。
    expect(globalThis.fetch).toBe(foreign)
    expect(isMasqueradeFetchInstalled()).toBe(false)
  })

  it('安装时刻捕获 base：能叠在别的包装器之上，请求逐层透传', async () => {
    const { calls } = installFakeBase()
    const lowerWrapper = globalThis.fetch

    ensureMasqueradeFetch()
    expect(globalThis.fetch).not.toBe(lowerWrapper)

    const init: RequestInit = { headers: { accept: 'text/event-stream' } }
    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1', init))

    // 载荷请求穿过本模块这一层，落到安装时捕获的下一层，且头已被改写。
    expect(calls.length).toBe(1)
    expect(calls[0].input).toBe('https://example.test/v1')
    expect(calls[0].init).toBe(init)
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(FULL.userAgent)
  })
})

describe('fetch 包装器：无载荷时零变化', () => {
  it('init 逐字段原样转发，连 `headers` 都不代造', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    const init: RequestInit = { method: 'POST', body: 'payload' }
    await globalThis.fetch('https://example.test/v1', init)

    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe('https://example.test/v1')
    // 同一个对象（不是重建的副本），且一个字段都没被加进去。
    expect(calls[0].init).toBe(init)
    expect(init).toEqual({ method: 'POST', body: 'payload' })
    expect(init.headers, '无载荷路径不许代造头载体').toBeUndefined()
  })

  it('已有 headers 的请求：无载荷时头对象逐键不变', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    const headers: Record<string, string> = { accept: 'text/event-stream', 'user-agent': 'framework/1.0' }
    const init: RequestInit = { method: 'POST', headers }
    await globalThis.fetch('https://example.test/v1', init)

    expect(calls[0].init).toBe(init)
    expect(headers).toEqual({ accept: 'text/event-stream', 'user-agent': 'framework/1.0' })
  })
})

describe('fetch 包装器：有载荷时就地改写', () => {
  it('init.headers 是普通对象 → 就地写入，`init` 身份与其它字段全部保留', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    // `duplex` 是流式请求体的必需字段（openai SDK 的真实形态）。这里刻意造一份：
    // 一旦实现改成「重建 init」，这个字段就会在出网请求里消失。
    const init: RequestInit & { duplex: string } = {
      method: 'POST',
      body: 'stream-body',
      duplex: 'half',
      headers: { accept: 'text/event-stream', 'user-agent': 'framework/1.0' },
    }

    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1', init))

    expect(calls).toHaveLength(1)
    expect(calls[0].init, 'init 必须是同一个对象（重建会丢掉 duplex 等不可复制字段）').toBe(init)
    expect(init.duplex).toBe('half')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('stream-body')

    const headers = init.headers as Record<string, string>
    expect(aliasesOf(headers, 'user-agent')).toEqual(['User-Agent'])
    expect(headers['User-Agent']).toBe(FULL.userAgent)
    expect(headers.Originator).toBe(FULL.originator)
    expect(headers[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe(FULL.windowId)
    expect(headers.accept).toBe('text/event-stream')
  })

  it('init.headers 缺席 → 就地挂一个新载体，其余字段不动', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    const init: RequestInit = { method: 'POST', body: 'stream-body' }
    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1', init))

    expect(calls[0].init).toBe(init)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('stream-body')

    const headers = init.headers as Record<string, string>
    expect(headers['User-Agent']).toBe(FULL.userAgent)
    expect(headers.Originator).toBe(FULL.originator)
    expect(headers[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe(FULL.windowId)
  })

  it('init.headers 是 `string[][]` → 容器身份不变，内容就地改（保序去重）', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    const headerPairs: string[][] = [
      ['accept', 'text/event-stream'],
      ['user-agent', 'framework/1.0'],
    ]
    const init: RequestInit = { method: 'POST', headers: headerPairs }

    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1', init))

    expect(init.headers, '数组容器同样不许被重建').toBe(headerPairs)
    expect(headerPairs).toEqual([
      ['accept', 'text/event-stream'],
      ['User-Agent', FULL.userAgent],
      ['Originator', FULL.originator],
      [ACCOUNT_HUB_WINDOW_ID_HEADER, FULL.windowId],
    ])
    expect(calls[0].init).toBe(init)
  })

  it('init 整个缺席（Request 对象形态）→ 原样转发，不代造 init', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    await runWithPayload(FULL, () => globalThis.fetch('https://example.test/v1'))

    expect(calls).toHaveLength(1)
    // 替调用方造一个假 init 等于改请求语义，比不伪装危险得多。
    expect(calls[0].init).toBeUndefined()
  })

  it('载荷里只有部分字段 → 只有那些头进得去', async () => {
    const { calls } = installFakeBase()
    ensureMasqueradeFetch()

    const init: RequestInit = { headers: { 'user-agent': 'framework/1.0' } }
    await runWithPayload({ windowId: 'win-only' }, () => globalThis.fetch('https://example.test/v1', init))

    const headers = init.headers as Record<string, string>
    expect(headers[ACCOUNT_HUB_WINDOW_ID_HEADER]).toBe('win-only')
    expect(headers.Originator).toBeUndefined()
    expect(aliasesOf(headers, 'user-agent')).toEqual(['user-agent'])
    expect(calls[0].init).toBe(init)
  })
})

describe('withMasqueradeAsyncIterable：载荷上下文的纪律', () => {
  it('生成器在上下文之外创建，套上代理后函数体里读得到载荷（未套代理则读不到）', async () => {
    const direct: Array<MasqueradePayload | undefined> = []
    const proxied: Array<MasqueradePayload | undefined> = []

    // ⚠️ 生成器**在这里创建**（完全不在载荷上下文里）；函数体在每次 `next()` 时才执行。
    async function* source(sink: Array<MasqueradePayload | undefined>): AsyncGenerator<string> {
      sink.push(currentMasqueradePayload())
      yield 'first'
      sink.push(currentMasqueradePayload())
      yield 'second'
    }

    // 对照组：同一个生成器形状，**不套代理** —— 函数体里必然读不到载荷。
    for await (const _value of source(direct)) {
      // 只是把它跑完。
    }
    expect(direct, '没有代理就不该有载荷（否则说明载荷泄漏到了生成器创建处）').toEqual([undefined, undefined])

    // 实验组：只多了 `withMasqueradeAsyncIterable` 这一层。
    for await (const _value of withMasqueradeAsyncIterable(FULL, source(proxied))) {
      // 只是把它跑完。
    }
    expect(
      proxied,
      '核心纪律：async generator 的函数体在**恢复它的那一次 next()** 的上下文里执行，'
        + '故只包创建、或只包一次 next 都不够',
    ).toEqual([FULL, FULL])
  })

  it('break 触发的 return() 也被转发：源生成器 finally 里仍看得到载荷', async () => {
    const inBody: Array<MasqueradePayload | undefined> = []
    const inFinally: Array<MasqueradePayload | undefined> = []

    async function* source(): AsyncGenerator<number> {
      try {
        inBody.push(currentMasqueradePayload())
        yield 1
        yield 2
      } finally {
        // 提前退出路径上的收尾逻辑（销账 / 上报）在真实适配器里一样会发请求，
        // 掉了载荷就会用错身份 —— 这正是三个方法都要包的理由。
        inFinally.push(currentMasqueradePayload())
      }
    }

    const seen: number[] = []
    for await (const value of withMasqueradeAsyncIterable(FULL, source())) {
      seen.push(value)
      break
    }

    expect(seen).toEqual([1])
    expect(inBody).toEqual([FULL])
    expect(inFinally, 'break 路径上的清理逻辑必须也在载荷上下文里').toEqual([FULL])
  })

  it('throw() 也被转发：catch / finally 分支里仍看得到载荷', async () => {
    const inCatch: Array<MasqueradePayload | undefined> = []
    const inFinally: Array<MasqueradePayload | undefined> = []
    const boom = new Error('boom')

    async function* source(): AsyncGenerator<number> {
      try {
        yield 1
      } catch (error) {
        inCatch.push(currentMasqueradePayload())
        throw error
      } finally {
        inFinally.push(currentMasqueradePayload())
      }
    }

    const iterator = withMasqueradeAsyncIterable(FULL, source())[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 1 })
    await expect(iterator.throw?.(boom)).rejects.toThrow('boom')

    expect(inCatch).toEqual([FULL])
    expect(inFinally).toEqual([FULL])
  })

  it('源没实现 return() / throw() 时按协议兜底（不假装转发）', async () => {
    let delivered = false
    const bare: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next(): Promise<IteratorResult<number>> {
            if (delivered) return Promise.resolve({ done: true, value: undefined })
            delivered = true
            return Promise.resolve({ done: false, value: 7 })
          },
        }
      },
    }

    const iterator = withMasqueradeAsyncIterable(FULL, bare)[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: 7 })
    // `for await` 的 `break` 依赖 `return()`：源没有就自己收尾。
    expect(await iterator.return?.(99)).toEqual({ done: true, value: 99 })
    // 源没有 `throw()` 就把异常抛回调用方（吞掉才是错的）。
    await expect(iterator.throw?.(new Error('nope'))).rejects.toThrow('nope')
  })

  it('两路流各自的载荷互不串台（交错推进也不串）', async () => {
    const seenA: Array<MasqueradePayload | undefined> = []
    const seenB: Array<MasqueradePayload | undefined> = []

    async function* source(sink: Array<MasqueradePayload | undefined>): AsyncGenerator<string> {
      sink.push(currentMasqueradePayload())
      yield 'one'
      sink.push(currentMasqueradePayload())
      yield 'two'
    }

    const payloadA: MasqueradePayload = { userAgent: 'A/1.0' }
    const payloadB: MasqueradePayload = { windowId: 'win-b' }
    const iteratorA = withMasqueradeAsyncIterable(payloadA, source(seenA))[Symbol.asyncIterator]()
    const iteratorB = withMasqueradeAsyncIterable(payloadB, source(seenB))[Symbol.asyncIterator]()

    // 交错推进：载荷若被挂在「当前异步执行栈」之外的某个模块级变量上，这里立刻串台。
    await iteratorA.next()
    await iteratorB.next()
    await iteratorA.next()
    await iteratorB.next()

    expect(seenA).toEqual([payloadA, payloadA])
    expect(seenB).toEqual([payloadB, payloadB])
  })

  it('载荷上下文不外泄：出了代理就是 undefined', async () => {
    const seen: Array<MasqueradePayload | undefined> = []
    async function* source(): AsyncGenerator<string> {
      yield 'only'
    }

    for await (const _value of withMasqueradeAsyncIterable(FULL, source())) {
      // 跑完这一路。
    }
    seen.push(currentMasqueradePayload())

    expect(seen).toEqual([undefined])
  })
})

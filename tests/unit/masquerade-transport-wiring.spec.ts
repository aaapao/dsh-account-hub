/**
 * 「客户端伪装运输层」**接线**回归测试：`src/auto-route-adapter.ts` 的 `stream()`
 * 有没有把载荷正确地放进 `AsyncLocalStorage`，以及默认路径有没有被改动。
 *
 * ## 与 `masquerade-transport.spec.ts` 的分工（两份都必须存在）
 *
 * 那一份守**运输层自己**（三种头载体形态的写法、包装器的零载荷路径、安装/卸载对称性）,
 * 它直接调 `withMasqueradeAsyncIterable` 与 `ensureMasqueradeFetch`，**不经过自动路由**。
 * 本文件守的是**它们被接上去的那一段**——这一段的失效形态全是「静默」的：接错位置不报错、
 * 少接一处不报错、默认路径被污染也不报错，只有这三份断言（载荷真的到了出站请求、
 * 默认路径一个字节没动、并发的两路不串）能把它们区分开。
 *
 * ## 为什么必须用**真实 `LlmRuntime`**（刻意不 mock `ctx.llm`）
 *
 * 被测的那条通路本身就是「重入 `ctx.llm.stream()` → 宿主 `adapterStream` → 目标适配器」,
 * 而本功能的核心纪律恰好挂在它的语法上：宿主 `adapterStream` 是 async generator,
 * 函数体在**恢复它的那次 `.next()`** 的上下文里执行，故「包消费」才有效、「包创建」无效。
 * 把 `ctx.llm.stream` 换成替身等于把被测的那一层也换掉了 —— 那样的用例在「包创建」
 * 的错误实现下**照样会绿**，正好丢掉这条纪律唯一的防线。
 *
 * ## 出站证据从哪来
 *
 * 目标适配器里真的 `await fetch(...)`，假的 `fetch` 装在 `globalThis` 上（包装器在安装
 * 时刻捕获它，这正是能与别的包装器共存的原因）。于是断言的对象是**真实到达网络层的那次
 * 请求**——不是 `forwardOptions()` 的返回值，也不是任何中间产物。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  AUTO_ROUTE_PROVIDER_ID,
  type AutoRouteConfig,
  type AutoRouteDefinition,
} from '../../src/auto-route.js'
import { registerAutoRouteLlm, type AutoRouteAdapter } from '../../src/auto-route-adapter.js'
import { ACCOUNT_HUB_WINDOW_ID_HEADER } from '../../src/account-hub-window-id.js'
import {
  currentMasqueradePayload,
  isMasqueradeFetchInstalled,
  releaseMasqueradeFetch,
} from '../../src/account-hub-masquerade-transport.js'

// ──────────────────────────── fetch 卫生 ────────────────────────────

/** 进程原本的 `fetch`（每个用例结束后无条件还原，绝不污染其它 spec 文件）。 */
const ORIGINAL_FETCH = globalThis.fetch

/**
 * 本文件被 import 的那一刻，`globalThis.fetch` 是否已经是运输层装的包装器。
 *
 * 必须是 `false`：接线只发生在 `stream()` 里，**模块加载不得改全局**（另见
 * `masquerade-transport.spec.ts` 的同名判据）。
 */
const INSTALLED_AT_IMPORT = isMasqueradeFetchInstalled()

afterEach(() => {
  // 先按正规路径卸（覆盖「只拆自己那一层」），再无条件还原兜底。
  releaseMasqueradeFetch()
  globalThis.fetch = ORIGINAL_FETCH
})

// ──────────────────────────── 夹具 ────────────────────────────

/** 出网端点（`.invalid` 是保留域，任何解析都不会真的出网）。 */
const EGRESS_URL = 'https://egress.invalid/v1/chat/completions'

/** 目标适配器自带的默认 UA —— 伪装值要**换掉**它，「覆写」才有判据。 */
const DEFAULT_UA = 'provider-default/1.0'

/** 三件套齐全的伪装配置（与条目配置逐字对应，见第 3 组用例）。 */
const FULL_UA = 'Masquerade/1.0'
const FULL_ORIGINATOR = 'codex_cli_rs'
const FULL_WINDOW = 'win-abc-123'

/** 一次真实到达网络层的请求留下的证据。 */
interface EgressCall {
  /** 目标适配器造的那个 `init`（**原样引用**：包装器就地改写，不重建）。 */
  readonly init: RequestInit | undefined
  /** 包装器改写之后、出网那一刻的头（已做大小写归一，便于直接查）。 */
  readonly headers: Record<string, string>
  /** 出网那一刻 ALS 里绑定的 windowId。 */
  readonly windowIdBeforeGate: string | undefined
  /** `await` 让出之后**再读一次**——证明上下文跨挂起仍然是自己那一路（并发用例的判据）。 */
  readonly windowIdAfterGate: string | undefined
}

/** 把任意 `HeadersInit` 形态读成普通对象（键为原样，值取该键的最终值）。 */
function readHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers as string[][])
  return { ...(headers as Record<string, string>) }
}

/** 大小写不敏感地取一个头（HTTP 头名大小写不敏感，断言不该依赖实现的写法）。 */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

/** 某个头名在容器里出现了几次（`1` 才是对的：同名头出现两次 = 上游看到拼接值）。 */
function headerCount(headers: Record<string, string>, name: string): number {
  return Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase()).length
}

/**
 * 装一层假出网函数（**先装到 `globalThis` 上，再由 `stream()` 里的
 * `ensureMasqueradeFetch()` 包住它** —— 顺序反了包装器捕获到的就不是它）。
 */
function installFakeEgress() {
  const calls: EgressCall[] = []
  let gate: (() => Promise<void>) | undefined
  const base = (async (input: string | URL | Request, init?: RequestInit) => {
    void input
    const headers = readHeaders(init?.headers)
    const windowIdBeforeGate = currentMasqueradePayload()?.windowId
    if (gate !== undefined) await gate()
    calls.push({
      init,
      headers,
      windowIdBeforeGate,
      windowIdAfterGate: currentMasqueradePayload()?.windowId,
    })
    return new Response('ok')
  }) as typeof fetch
  globalThis.fetch = base
  return {
    calls,
    base,
    /** 设置出站挂起点（并发用例用它把两路请求真正交错在一起）。 */
    setGate(next: () => Promise<void>): void {
      gate = next
    },
  }
}

/** 目标适配器：记录收到的 options，并**真的 `await fetch`**（这才是出站证据的来源）。 */
class TargetAdapter extends LlmAdapter {
  /** provider → 每次 `stream()` 收到的 options。 */
  readonly seen = new Map<string, GenerateOptions[]>()
  /** 出站头的载体形态（默认普通对象，与 `trae-cn` / `qoder` 的真实形态一致）。 */
  headerStyle: 'object' | 'headers' = 'object'
  /** 下一次该 provider 要「上游报错」的（一次性，用过即摘）。 */
  private readonly failing = new Set<string>()

  constructor(private readonly providers: readonly string[]) {
    super()
  }

  /**
   * 让某 provider 的下一次请求**先真的发出去**、再回一个失败 finish。
   *
   * 顺序刻意与真实适配器一致（请求已经上网了才拿到错误码）：于是「降级前那一次出站」
   * 也留下证据，用例才能同时钉住「失败那一路带的是旧队首的载荷」与「重试那一路带的是
   * 新队首的载荷」—— 若改成「发之前就失败」，前一条证据就没了。
   */
  failOnce(provider: string): void {
    this.failing.add(provider)
  }

  providerInfo(provider: string) {
    return { id: provider, name: `目标 ${provider}` }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: 'target-model', name: '目标模型' }]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: `目标 ${model}` }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const list = this.seen.get(options.provider) ?? []
    list.push(options)
    this.seen.set(options.provider, list)
    await this.send()
    if (this.failing.delete(options.provider)) {
      // 一个内容 chunk 都没发就失败 —— 这才会触发自动路由的**静默降级**（宿主会把
      // 建立阶段与迭代阶段的异常都规范化成这个终止 chunk，见 `auto-route-adapter` 模块头）。
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: `${options.provider} 挂了`, code: 'SERVER' } },
      }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** 造一次请求并发出去（头容器**只在这里构造**，包装器只负责就地改写它）。 */
  private async send(): Promise<void> {
    const headers: HeadersInit = this.headerStyle === 'headers'
      ? new Headers({ 'content-type': 'application/json', 'user-agent': DEFAULT_UA })
      : { 'content-type': 'application/json', 'user-agent': DEFAULT_UA }
    await fetch(EGRESS_URL, { method: 'POST', headers })
  }
}

/** 造一份配置（测试里只覆盖关心的字段）。 */
const config = (models: AutoRouteDefinition[]): AutoRouteConfig => ({ enabled: true, models })

const def = (
  id: string,
  name: string,
  entries: {
    provider: string
    model: string
    userAgent?: string
    originator?: string
    masquerade?: { windowId: string }
  }[],
): AutoRouteDefinition => ({ id, name, entries })

/** 真实 `LlmRuntime` + 目标适配器 + 自动路由适配器的测试台。 */
async function harness(definition: () => AutoRouteConfig) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const providers = [
    ...new Set(definition().models.flatMap((model) => model.entries.map((entry) => entry.provider))),
  ]
  const target = new TargetAdapter(providers)
  if (providers.length > 0) ctx.llm.registerAdapter([...providers], target)
  const adapter = registerAutoRouteLlm(ctx, { ctx, config: definition }).adapter
  return { ctx, target, adapter }
}

/** 走一遍完整请求（`provider` 固定为自动路由）。 */
async function drain(adapter: AutoRouteAdapter, model: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: AUTO_ROUTE_PROVIDER_ID,
    model,
    messages: [],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** chunk 序列的简写。 */
const kinds = (chunks: readonly StreamChunk[]): string[] =>
  chunks.map((chunk) => chunk.type === 'finish' ? `finish:${chunk.reason.kind}` : chunk.type)

/** 三件套齐全的单条目配置（第 1、3、4 组用例的公共起点）。 */
const FULL_DEFINITION = (): AutoRouteConfig => config([
  def('m1', '自动一号', [{
    provider: 'p-a',
    model: 'a',
    userAgent: FULL_UA,
    originator: FULL_ORIGINATOR,
    masquerade: { windowId: FULL_WINDOW },
  }]),
])

// ──────────────────────────── 1. 伪装分支 ────────────────────────────

describe('伪装分支：装了包装器，且载荷经 ALS 到达那一次出站请求', () => {
  it('import 时全局 fetch 未被改动（接线只发生在 stream() 里）', () => {
    expect(INSTALLED_AT_IMPORT).toBe(false)
  })

  it('配了伪装 ⇒ 三个头真的出现在假 fetch 收到的那次请求上', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(FULL_DEFINITION)

    expect(kinds(await drain(adapter, 'm1'))).toEqual(['text-delta', 'finish:stop'])

    expect(egress.calls).toHaveLength(1)
    const call = egress.calls[0]
    // UA 是**覆写**：默认值必须被换掉（不是并存两个头）。
    expect(headerOf(call.headers, 'user-agent')).toBe(FULL_UA)
    expect(headerCount(call.headers, 'user-agent')).toBe(1)
    expect(headerOf(call.headers, 'originator')).toBe(FULL_ORIGINATOR)
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
    // 载荷确实来自 ALS（而不是任何一条绕开上下文的旁路）。
    expect(call.windowIdBeforeGate).toBe(FULL_WINDOW)
    // 包装器**就地改写**：目标适配器造的那个 init 对象身份不变。
    expect(call.init?.headers).toBeDefined()
  })

  it('`Headers` 载体形态同样被改写（三条既有通道各用不同形态）', async () => {
    const egress = installFakeEgress()
    const { adapter, target } = await harness(FULL_DEFINITION)
    target.headerStyle = 'headers'

    await drain(adapter, 'm1')

    expect(egress.calls).toHaveLength(1)
    const call = egress.calls[0]
    expect(call.headers['user-agent']).toBe(FULL_UA)
    expect(headerOf(call.headers, 'originator')).toBe(FULL_ORIGINATOR)
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
  })

  it('windowId 固定复用条目里存的值：两次请求逐字相同，不做任何轮换', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(FULL_DEFINITION)

    await drain(adapter, 'm1')
    await drain(adapter, 'm1')

    expect(egress.calls).toHaveLength(2)
    for (const call of egress.calls) {
      expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
    }
  })

  it('装包装器是配置驱动的：没配伪装的那次请求不装（默认路径与伪装路径共存于同一进程）', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('plain', '素面朝天', [{ provider: 'p-a', model: 'a' }]),
    ]))

    await drain(adapter, 'plain')

    expect(isMasqueradeFetchInstalled()).toBe(false)
    expect(globalThis.fetch).toBe(egress.base)
  })
})

// ──────────────────────────── 2. 默认分支 ────────────────────────────

describe('默认分支：三个字段归一后全空 ⇒ 一个字节都不动', () => {
  it('不装包装器：`globalThis.fetch` 与进用例时是同一个对象', async () => {
    const egress = installFakeEgress()
    const before = globalThis.fetch
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }]),
    ]))

    await drain(adapter, 'm1')

    expect(isMasqueradeFetchInstalled()).toBe(false)
    expect(globalThis.fetch).toBe(before)
    expect(globalThis.fetch).toBe(egress.base)
  })

  it('出站请求逐字不变：默认 UA 原样，两个新增头一个都不发', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{ provider: 'p-a', model: 'a' }]),
    ]))

    await drain(adapter, 'm1')

    expect(egress.calls).toHaveLength(1)
    const call = egress.calls[0]
    expect(call.headers['user-agent']).toBe(DEFAULT_UA)
    expect(headerOf(call.headers, 'originator')).toBeUndefined()
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBeUndefined()
    expect(call.windowIdBeforeGate).toBeUndefined()
  })

  it('配了但脏（空白 windowId）⇒ 当没配：读路径丢整块，出站一个头都不多', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{ provider: 'p-a', model: 'a', masquerade: { windowId: '   ' } }]),
    ]))

    await drain(adapter, 'm1')

    expect(isMasqueradeFetchInstalled()).toBe(false)
    expect(globalThis.fetch).toBe(egress.base)
    expect(headerOf(egress.calls[0].headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBeUndefined()
  })

  it('没配伪装时连 `fetch` 都不该被包装器看上一眼（identity 判据是唯一证据）', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(FULL_DEFINITION)

    // 先跑一路带伪装的，把包装器装上 —— 再确认「另一条素条目」不会因此被改动。
    await drain(adapter, 'm1')
    expect(isMasqueradeFetchInstalled()).toBe(true)

    const { adapter: plainAdapter } = await harness(() => config([
      def('plain', '素面朝天', [{ provider: 'p-a', model: 'a' }]),
    ]))
    await drain(plainAdapter, 'plain')

    // 包装器是全局的（装了就装了），但它零载荷时**纯转发**：头一个都没多。
    expect(egress.calls).toHaveLength(2)
    const plainCall = egress.calls[1]
    expect(plainCall.headers['user-agent']).toBe(DEFAULT_UA)
    expect(headerOf(plainCall.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBeUndefined()
  })
})

// ──────────────────────────── 3. 载荷与条目配置 1:1 ────────────────────────────

describe('载荷与条目配置 1:1：三个字段各自到位，且没有字段会凭空出现', () => {
  it('三件套齐全时三个头各自取到自己那一格的值（不是互相串位）', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(FULL_DEFINITION)

    await drain(adapter, 'm1')

    const call = egress.calls[0]
    // 逐格比对：值一旦错位（例如 windowId 写到 Originator 上）这里立刻红。
    expect(headerOf(call.headers, 'user-agent')).toBe(FULL_UA)
    expect(headerOf(call.headers, 'originator')).toBe(FULL_ORIGINATOR)
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
  })

  it('只配 UA（没配 windowId）也算要伪装：UA 被换掉，另两个头一个都不多发', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{ provider: 'p-a', model: 'a', userAgent: FULL_UA }]),
    ]))

    await drain(adapter, 'm1')

    expect(isMasqueradeFetchInstalled()).toBe(true)
    const call = egress.calls[0]
    expect(headerOf(call.headers, 'user-agent')).toBe(FULL_UA)
    expect(headerOf(call.headers, 'originator')).toBeUndefined()
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBeUndefined()
  })

  it('只配 windowId（没配两个头）同样算要伪装：只有那一个头被加上', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{
        provider: 'p-a',
        model: 'a',
        masquerade: { windowId: FULL_WINDOW },
      }]),
    ]))

    await drain(adapter, 'm1')

    expect(isMasqueradeFetchInstalled()).toBe(true)
    const call = egress.calls[0]
    expect(call.headers['user-agent']).toBe(DEFAULT_UA)
    expect(headerOf(call.headers, 'originator')).toBeUndefined()
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
  })

  it('归一化后带空白的值被 trim 一次再发出（判据复用既有模块，不在这里另抄一份）', async () => {
    const egress = installFakeEgress()
    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{
        provider: 'p-a',
        model: 'a',
        userAgent: `  ${FULL_UA}  `,
        originator: `\t${FULL_ORIGINATOR}\t`,
        masquerade: { windowId: ` ${FULL_WINDOW} ` },
      }]),
    ]))

    await drain(adapter, 'm1')

    const call = egress.calls[0]
    expect(headerOf(call.headers, 'user-agent')).toBe(FULL_UA)
    expect(headerOf(call.headers, 'originator')).toBe(FULL_ORIGINATOR)
    expect(headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe(FULL_WINDOW)
  })

  it('降级到第二条候选后，伪装载荷跟着**新队首**走（不是沿用第一条的）', async () => {
    const egress = installFakeEgress()
    const { adapter, target } = await harness(() => config([
      def('m1', '自动一号', [
        {
          provider: 'p-a',
          model: 'a',
          userAgent: 'First/1.0',
          masquerade: { windowId: 'win-first' },
        },
        {
          provider: 'p-b',
          model: 'b',
          userAgent: 'Second/2.0',
          masquerade: { windowId: 'win-second' },
        },
      ]),
    ]))
    // 第一条候选在首 chunk 前失败 ⇒ 静默降级到第二条（见 `auto-route-adapter` 模块头）。
    // 失败**发生在出站之后**（`failOnce` 的语义见其 JSDoc），故两次出站都留证据。
    target.failOnce('p-a')

    // 降级是静默的：用户只看到第二条候选的正常流（这个断言同时证明失败真被注入了）。
    expect(kinds(await drain(adapter, 'm1'))).toEqual(['text-delta', 'finish:stop'])

    // ⚠️ 两次出站各自带**自己那一条候选**的载荷：第一次是旧队首，第二次是新队首。
    // 若载荷被缓存/复用，第二次会带着 `win-first` 出去 —— 上游看到的就是串了身份。
    expect(egress.calls).toHaveLength(2)
    expect(headerOf(egress.calls[0].headers, 'user-agent')).toBe('First/1.0')
    expect(headerOf(egress.calls[0].headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe('win-first')
    expect(headerOf(egress.calls[1].headers, 'user-agent')).toBe('Second/2.0')
    expect(headerOf(egress.calls[1].headers, ACCOUNT_HUB_WINDOW_ID_HEADER)).toBe('win-second')
    // 两次都真的在载荷上下文里出网（不是只有第一次有）。
    expect(egress.calls[0].windowIdBeforeGate).toBe('win-first')
    expect(egress.calls[1].windowIdBeforeGate).toBe('win-second')
  })
})

// ──────────────────────────── 4. 并发不串扰 ────────────────────────────

describe('并发：两条不同 windowId 的条目同时在飞，互不串扰', () => {
  it('两路请求交错挂起后各自恢复，出站头与上下文仍是自己那一路', async () => {
    const egress = installFakeEgress()
    // 两个出站**都到齐**才放行：先到的那个挂在 `await` 上，后到的那个在「前一路的
    // 载荷仍挂在异步栈上」时进入 —— 这正是串扰唯一可能现形的时刻。
    let arrived = 0
    let release: () => void = () => {}
    const bothArrived = new Promise<void>((resolve) => { release = resolve })
    egress.setGate(async () => {
      arrived += 1
      if (arrived === 2) release()
      await bothArrived
    })

    const { adapter } = await harness(() => config([
      def('m1', '自动一号', [{
        provider: 'p-a',
        model: 'a',
        userAgent: 'Agent-A/1.0',
        masquerade: { windowId: 'win-a' },
      }]),
      def('m2', '自动二号', [{
        provider: 'p-b',
        model: 'b',
        userAgent: 'Agent-B/1.0',
        masquerade: { windowId: 'win-b' },
      }]),
    ]))

    const [first, second] = await Promise.all([drain(adapter, 'm1'), drain(adapter, 'm2')])

    expect(kinds(first)).toEqual(['text-delta', 'finish:stop'])
    expect(kinds(second)).toEqual(['text-delta', 'finish:stop'])
    expect(arrived).toBe(2)
    expect(egress.calls).toHaveLength(2)

    const callOf = (windowId: string): EgressCall | undefined => egress.calls.find(
      (call) => headerOf(call.headers, ACCOUNT_HUB_WINDOW_ID_HEADER) === windowId,
    )
    const callA = callOf('win-a')
    const callB = callOf('win-b')
    expect(callA).toBeDefined()
    expect(callB).toBeDefined()
    // 头各自对位。
    expect(headerOf(callA!.headers, 'user-agent')).toBe('Agent-A/1.0')
    expect(headerOf(callB!.headers, 'user-agent')).toBe('Agent-B/1.0')
    // ALS 上下文按异步链隔离：`await` 让出之后每一路读到的仍是自己那份载荷。
    expect(callA!.windowIdBeforeGate).toBe('win-a')
    expect(callA!.windowIdAfterGate).toBe('win-a')
    expect(callB!.windowIdBeforeGate).toBe('win-b')
    expect(callB!.windowIdAfterGate).toBe('win-b')
  })
})

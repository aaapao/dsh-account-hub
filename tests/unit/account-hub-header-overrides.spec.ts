/**
 * Account Hub **请求头覆写通道**单测（`src/account-hub-user-agent.ts` +
 * `src/account-hub-originator.ts`，**纯函数、零网络**）。
 *
 * ## 这两个模块为什么必须单独测
 *
 * 它们是自动路由候选条目与内层真实适配器之间的**唯一接缝**：聚合层只负责把值挂到
 * `options.accountHubUserAgent` / `options.accountHubOriginator` 上（
 * `src/auto-route-adapter.ts` 的 `forwardOptions()`），真正落到出站请求头的是这里的
 * 两个 `apply*` 函数。接缝两侧各有自己的单测（`auto-route-adapter.spec.ts` 测注入、
 * 各适配器 spec 测出站头），但**接缝本身**的语义只有这里能钉住：
 *
 * 1. **两个头形态各按自己的规矩写** —— `Headers` 键大小写不敏感，`set` 天然覆盖；
 *    普通对象逐字透传给 `fetch`，**必须先清异形键**，否则同一次请求出现两个同名头，
 *    上游看到的是拼接值（这类缺陷在真机上极难定位）。
 * 2. **默认路径零变化** —— 字段缺席或值非法时返回 `false` 且一个字节都不动。
 *    这是 AGENTS.md「出站协议值不随 provider id / 显示名变化」红线的延伸。
 * 3. **读路径把脏值一律当「没有」**（不抛错）—— 适配器的 `send()` 没有 try/catch，
 *    这里抛错等于把一次配置笔误升级成请求失败。
 *
 * ## 为什么「非法值」要逐个形态都测
 *
 * 判据（`accountHubUserAgentProblem` / `accountHubOriginatorProblem`）有四条互相独立
 * 的分支：非字符串 / 空串 / 超长 / 含控制字符。少测一条就等于少守一个入口 —— 尤其
 * **控制字符**那条是头注入的经典入口（`\n` 能让一次请求变成两次）。
 */

import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_HUB_USER_AGENT_MAX_LENGTH,
  accountHubUserAgentOf,
  applyAccountHubUserAgent,
  normalizeAccountHubUserAgent,
} from '../../src/account-hub-user-agent.js'
import {
  ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH,
  accountHubOriginatorOf,
  applyAccountHubOriginator,
  normalizeAccountHubOriginator,
} from '../../src/account-hub-originator.js'

/**
 * 两条通道的**同构**描述：同一份用例体对它们各跑一遍。
 *
 * 两条通道的实现是逐字同构的（一个模块一个头），故用例也写成表驱动 —— 这样
 * 「只给其中一条补了修复」会立刻暴露成半边红，而不是靠人记得两边都改。
 */
interface Channel {
  /** 用例名里用的通道名（中文，便于失败信息直接可读）。 */
  readonly label: string
  /** 覆写通道在 `options` 上的字段名。 */
  readonly field: 'accountHubUserAgent' | 'accountHubOriginator'
  /** 出站头的规范键名（大写形态，也是普通对象形态最终唯一该剩下的键）。 */
  readonly header: 'User-Agent' | 'Originator'
  /** 长度上限常量（用于造超长值）。 */
  readonly maxLength: number
  /** 读路径：从 options 里取覆写值。 */
  readonly of: (options: unknown) => string | undefined
  /** 读路径的归一函数（`of` 的非对象入参分支由它兜底）。 */
  readonly normalize: (value: unknown) => string | undefined
  /** 应用函数：把覆写值写进已经构造好的头里。 */
  readonly apply: (headers: Headers | Record<string, string>, options: unknown) => boolean
}

const CHANNELS: readonly Channel[] = [
  {
    label: 'User-Agent',
    field: 'accountHubUserAgent',
    header: 'User-Agent',
    maxLength: ACCOUNT_HUB_USER_AGENT_MAX_LENGTH,
    of: accountHubUserAgentOf,
    normalize: normalizeAccountHubUserAgent,
    apply: applyAccountHubUserAgent,
  },
  {
    label: 'Originator',
    field: 'accountHubOriginator',
    header: 'Originator',
    maxLength: ACCOUNT_HUB_ORIGINATOR_MAX_LENGTH,
    of: accountHubOriginatorOf,
    normalize: normalizeAccountHubOriginator,
    apply: applyAccountHubOriginator,
  },
]

/** 造一份带覆写值的 options（只带该通道一个字段）。 */
const optionsWith = (channel: Channel, value: unknown): Record<string, unknown> => ({
  provider: 'p-a',
  model: 'a',
  [channel.field]: value,
})

/**
 * 统计某个头名在普通对象里的**全部**键（大小写不敏感）。
 *
 * 这是「绝无双头」判据的落点：`fetch` 拿到普通对象时逐字透传，同名的两个键会
 * 变成同一次请求里的两个头，上游把它们按 `, ` 拼起来 —— 用
 * `headers['User-Agent']` 取值**看不出**这个问题（它只返回其中一个）。
 */
const keysOf = (headers: Record<string, string>, name: string): string[] =>
  Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase())

/** 每个通道各跑一遍同一份用例体（表驱动，避免两条通道的实现漂移）。 */
const eachChannel = (body: (channel: Channel) => void): void => {
  for (const channel of CHANNELS) body(channel)
}

describe('applyAccountHubUserAgent / applyAccountHubOriginator：两个头形态的写入', () => {
  it('Headers 形态：应用成功返回 true，且**整体换掉**既有值（不是追加、不是前缀）', () => {
    eachChannel((channel) => {
      // 预置一个**小写**的框架头 —— 这正是 `attributionHeaders()` 的真实形态，
      // 也正是 `Headers.set()` 大小写不敏感这条性质的用武之地。
      const headers = new Headers({ [channel.header.toLowerCase()]: 'framework/1.0' })

      expect(
        channel.apply(headers, optionsWith(channel, 'Override/9.9')),
        `${channel.label}：配了合法覆写值时必须报告「真的写了」（false 会被适配器当成「没配」）`,
      ).toBe(true)
      expect(
        headers.get(channel.header),
        `${channel.label}：出站值必须是覆写值整体替换，而不是与默认值拼接`,
      ).toBe('Override/9.9')
      // Headers 天然去重：无论怎么读都只有一个值。
      expect(headers.get(channel.header.toLowerCase())).toBe('Override/9.9')
    })
  })

  it('Headers 形态：原本没有该头时也能**新增**（Originator 的常态、UA 的非常态）', () => {
    eachChannel((channel) => {
      const headers = new Headers()
      expect(channel.apply(headers, optionsWith(channel, 'Fresh/1.0'))).toBe(true)
      expect(headers.get(channel.header)).toBe('Fresh/1.0')
    })
  })

  it('普通对象形态：应用成功返回 true 并写入规范键', () => {
    eachChannel((channel) => {
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      expect(channel.apply(headers, optionsWith(channel, 'Override/9.9'))).toBe(true)
      expect(headers[channel.header]).toBe('Override/9.9')
      // 无关头一个都不许被顺手改动。
      expect(headers.Accept).toBe('text/event-stream')
    })
  })

  it('普通对象形态：**异形键被清理**，应用后只剩一个规范键（绝无双头）', () => {
    eachChannel((channel) => {
      // 预置三个异形形态：全小写（框架归属头的真实形态）、全大写（另一个规范形态）、
      // 混合大小写。清理规则是「除规范键 `X` 外，凡 `toLowerCase() === 'x'` 的键都删」。
      const lower = channel.header.toLowerCase()
      const upper = channel.header.toUpperCase()
      const headers: Record<string, string> = {
        [lower]: 'framework/1.0',
        [upper]: 'product/2.0',
        [channel.header]: 'product/3.0',
        Accept: 'text/event-stream',
      }

      expect(channel.apply(headers, optionsWith(channel, 'Override/9.9'))).toBe(true)

      // ⚠️ 这条是本组用例的**核心判据**：清理漏一个键，同一次请求就会带两个同名头。
      expect(
        keysOf(headers, channel.header),
        `${channel.label}：普通对象里同名键必须只剩一个，否则 fetch 会发出双头、上游看到拼接值`,
      ).toEqual([channel.header])
      expect(headers[channel.header]).toBe('Override/9.9')
      // 异形键确实被**删除**（而不是被置成空串留在对象里）。
      expect(lower in headers).toBe(false)
      expect(upper in headers).toBe(false)
      expect(headers.Accept).toBe('text/event-stream')
    })
  })

  it('普通对象形态：只有异形键、没有规范键时也清理干净（新增场景）', () => {
    eachChannel((channel) => {
      const lower = channel.header.toLowerCase()
      const headers: Record<string, string> = { [lower]: 'framework/1.0' }

      expect(channel.apply(headers, optionsWith(channel, 'Override/9.9'))).toBe(true)

      expect(keysOf(headers, channel.header)).toEqual([channel.header])
      expect(headers[channel.header]).toBe('Override/9.9')
      expect(lower in headers).toBe(false)
    })
  })
})

describe('applyAccountHubUserAgent / applyAccountHubOriginator：默认路径零变化', () => {
  it('options 完全没有该通道字段 → 返回 false 且头**逐键不变**', () => {
    eachChannel((channel) => {
      // 两个形态都验：适配器里两种都有（codearts/buddy/lobsterai 是 Headers，
      // trae-cn/qoder 是普通对象），漏测一个形态等于漏掉一半适配器。
      const headerList = new Headers({ [channel.header.toLowerCase()]: 'framework/1.0' })
      const objectHeaders: Record<string, string> = {
        [channel.header.toLowerCase()]: 'framework/1.0',
        Accept: 'text/event-stream',
      }
      const objectSnapshot = { ...objectHeaders }

      expect(
        channel.apply(headerList, { provider: 'p-a', model: 'a' }),
        `${channel.label}：没配覆写值时必须返回 false —— 适配器据此判断「这条请求出站形态有没有变」`,
      ).toBe(false)
      expect(channel.apply(objectHeaders, { provider: 'p-a', model: 'a' })).toBe(false)

      expect(headerList.get(channel.header)).toBe('framework/1.0')
      // 逐键比对（而不是只看该头）：默认路径下**任何**头都不该被动。
      expect(objectHeaders).toEqual(objectSnapshot)
    })
  })

  it('非法值（空串 / 全空白 / 超长 / 含 \\n / 含 \\t / 非字符串）→ 返回 false 且头零变化', () => {
    eachChannel((channel) => {
      const illegal: unknown[] = [
        '', // 空串：缺省即「不覆写」，不需要用空串表达
        '   ', // trim 后为空：同上
        'a'.repeat(channel.maxLength + 1), // 超长
        'Agent/1.0\r\nX-Injected: evil', // CRLF —— 头注入的经典入口
        'Agent/1.0\nX-Injected: evil', // 裸 LF
        'Agent\t1.0', // TAB 也是控制字符
        '\u0000Agent', // NUL
        42, // 非字符串
        null,
        undefined,
        { toString: () => 'Agent/1.0' }, // 有 toString 的对象也不算字符串
      ]

      for (const value of illegal) {
        const headers = new Headers({ [channel.header.toLowerCase()]: 'framework/1.0' })
        const objectHeaders: Record<string, string> = { [channel.header.toLowerCase()]: 'framework/1.0' }

        expect(
          channel.apply(headers, optionsWith(channel, value)),
          `${channel.label}：非法值 ${JSON.stringify(value)} 必须被当成「没配」，绝不能写进出站头`,
        ).toBe(false)
        expect(channel.apply(objectHeaders, optionsWith(channel, value))).toBe(false)

        expect(headers.get(channel.header), `${channel.label}：非法值下出站头必须零变化`).toBe('framework/1.0')
        expect(keysOf(objectHeaders, channel.header)).toEqual([channel.header.toLowerCase()])
      }
    })
  })

  it('恰好等于上限的值**合法**（边界是「> 上限才拒」，不是「>=」）', () => {
    eachChannel((channel) => {
      const boundary = 'a'.repeat(channel.maxLength)
      const headers = new Headers()
      expect(channel.apply(headers, optionsWith(channel, boundary))).toBe(true)
      expect(headers.get(channel.header)).toBe(boundary)
      // 反向：再多一个字符立刻被拒（否则上面那条断言在「判据被改成 >=」时仍是绿的）。
      expect(channel.apply(new Headers(), optionsWith(channel, `${boundary}a`))).toBe(false)
    })
  })

  it('带前后空白的合法值：写出去的是 **trim 之后**的值（判据与落盘形态同源）', () => {
    eachChannel((channel) => {
      const headers = new Headers()
      expect(channel.apply(headers, optionsWith(channel, '  Agent/1.0  '))).toBe(true)
      expect(headers.get(channel.header)).toBe('Agent/1.0')
    })
  })

  it('options 为 null / undefined / 非对象 → 返回 false，不抛错', () => {
    eachChannel((channel) => {
      for (const options of [null, undefined, 'string', 42, true]) {
        const headers = new Headers({ [channel.header.toLowerCase()]: 'framework/1.0' })
        // 适配器的 send() 没有 try/catch：这里抛错等于把一次调用形态异常升级成请求失败。
        expect(() => channel.apply(headers, options), `${channel.label}：options=${String(options)} 不该抛错`).not.toThrow()
        expect(channel.apply(headers, options)).toBe(false)
        expect(headers.get(channel.header)).toBe('framework/1.0')
      }
    })
  })
})

describe('accountHubUserAgentOf / accountHubOriginatorOf：读路径归一', () => {
  it('合法值返回 **trim 之后**的值', () => {
    eachChannel((channel) => {
      expect(channel.of(optionsWith(channel, 'Agent/1.0'))).toBe('Agent/1.0')
      expect(channel.of(optionsWith(channel, '  Agent/1.0  '))).toBe('Agent/1.0')
      // 含内部空格的合法值原样保留（只 trim 首尾）。
      expect(channel.of(optionsWith(channel, ' Agent 1.0 '))).toBe('Agent 1.0')
    })
  })

  it('字段缺席 → undefined（**不是空串**：调用方按 undefined 判「没配」）', () => {
    eachChannel((channel) => {
      expect(channel.of({ provider: 'p-a', model: 'a' })).toBeUndefined()
      expect(channel.of({})).toBeUndefined()
    })
  })

  it('options 非对象（含 null / undefined）→ undefined，不抛错', () => {
    eachChannel((channel) => {
      for (const options of [undefined, null, 'string', 42, true]) {
        expect(() => channel.of(options)).not.toThrow()
        expect(channel.of(options), `${channel.label}：options=${String(options)}`).toBeUndefined()
      }
    })
  })

  it('非法值 → undefined（读路径一律当「没有」，脏值不阻断请求）', () => {
    eachChannel((channel) => {
      const illegal: unknown[] = [
        '',
        '   ',
        'a'.repeat(channel.maxLength + 1),
        'Agent\nInjected',
        'Agent\t1.0',
        42,
        null,
        {},
        [],
      ]
      for (const value of illegal) {
        expect(
          channel.of(optionsWith(channel, value)),
          `${channel.label}：脏值 ${JSON.stringify(value)} 必须归一成 undefined`,
        ).toBeUndefined()
        expect(channel.normalize(value)).toBeUndefined()
      }
    })
  })

  it('两次连续调用结果一致（判据正则**不带 `g` 标志**，不会记住 lastIndex）', () => {
    // 带 `g` 的正则对象 `test()` 会在多次调用间记住 `lastIndex`，同一份配置第二次
    // 校验起结果就随机漂移 —— 这类缺陷在单条用例里完全看不出来，故这里**连调两次**
    // 并逐次断言（含一次合法值夹在两次非法值之间，确保 lastIndex 不会污染后续）。
    eachChannel((channel) => {
      const options = optionsWith(channel, 'Agent/1.0')
      expect(channel.of(options)).toBe('Agent/1.0')
      expect(channel.of(options)).toBe('Agent/1.0')
      expect(channel.of(optionsWith(channel, 'Agent\r\nX: y'))).toBeUndefined()
      expect(channel.of(options)).toBe('Agent/1.0')
      // 控制字符判据连测三次：命中后 lastIndex 若不归零，第二次就会漏判。
      expect(channel.normalize('A\nB')).toBeUndefined()
      expect(channel.normalize('A\nB')).toBeUndefined()
      expect(channel.normalize('A\nB')).toBeUndefined()
    })
  })

  it('两条通道**互不干扰**：只配一条时另一条读不到值', () => {
    // 两条通道共用同一个 options 对象流转，字段名只差后缀。若哪次实现把字段名抄错
    // （例如 Originator 误读 accountHubUserAgent），这条会立刻红。
    const both = { accountHubUserAgent: 'Agent/1.0', accountHubOriginator: 'my-app' }
    expect(accountHubUserAgentOf(both)).toBe('Agent/1.0')
    expect(accountHubOriginatorOf(both)).toBe('my-app')

    const onlyUa = { accountHubUserAgent: 'Agent/1.0' }
    expect(accountHubOriginatorOf(onlyUa)).toBeUndefined()
    const onlyOriginator = { accountHubOriginator: 'my-app' }
    expect(accountHubUserAgentOf(onlyOriginator)).toBeUndefined()
  })
})

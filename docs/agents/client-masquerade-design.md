# 外部 provider 客户端伪装 · 设计方案

> **状态**：已实现（**运输层方案**）。原「宿主磁盘补丁引擎」方案已**整体退役删除** —— 先读 §0.1 决策记录，再看其余章节。
> **范围**：设计 + 落地记录。本文不含实现代码；`src/` / `tests/` / `plugin-src/` 的现状以仓库为准。
> **证据基线**：`@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.1`、`@earendil-works/pi-ai@0.85.1`、本仓 `dsh-account-hub`（`ACCOUNT_HUB_SCHEMA_VERSION = 6`）。
> 文中标注行号的段落均针对上述版本，升级后必须重新核对（见 §9）。
> ⚠️ **§0.1 之后的正文里，凡涉及补丁引擎的旧描述都已改写为运输层口径，或就地标注「历史存档」**；读到未标注的补丁字眼即为文档缺陷，请以 `src/account-hub-masquerade-transport.ts` 为准。

---

## 0. 一句话

让「自动路由」的某条候选，在**转发到外部 provider**（如 `router-4` / 4router.net）时，
按预设整体伪装成**某个官方客户端**的出站身份（UA + `Originator` + 客户端专属头），
从而通过对方的客户端白名单闸门；实现方式是**伪装运输层**：候选条目的伪装参数随
「正在驱动的这一路请求」绑进 `AsyncLocalStorage`，`globalThis.fetch` 包装器在请求
真正出网前，把三个头就地写进**这次请求自己的**头容器 —— **不写宿主磁盘上的任何文件**。
面板里给出一条预设下拉。

---

## 0.1 决策记录：补丁引擎退役，改用 ALS + fetch 运输层

> 本节是**决议记录**，不是设计草案。它回答「为什么上一版方案整份不要了」，
> 以及「现在生效的到底是什么」。日期范围：**2026-09-28 前后这一轮**（与
> `客户端伪装：自动路由候选可伪装成 Codex 客户端出站身份` 等提交同一批）。

### 0.1.1 决策

| 项 | 内容 |
|---|---|
| 决策 | 「客户端伪装**磁盘补丁引擎**」整体退役删除，改用**伪装运输层**（ALS 逐请求作用域 + `globalThis.fetch` 包装器） |
| 退役范围 | `src/masquerade-patch.ts`（771 行）**已删除**；`tests/unit/masquerade-patch.spec.ts`（786 行 / 59 例）**已删除**；旧的状态面（`MASQUERADE_UNAVAILABLE_REASON` 等常量与「打没打上补丁」这类结论）**已删除** |
| 新增 | `src/account-hub-masquerade-transport.ts`（ALS 存储 + `fetch` 包装器 + 三种头容器形态兼容）、`src/account-hub-window-id.ts`（第三条头通道 `x-codex-window-id` 的校验）、`tests/unit/masquerade-transport.spec.ts`（30 例）、`tests/unit/masquerade-transport-wiring.spec.ts`（15 例） |

### 0.1.2 退役根因（这一条必须原样留存，它是整个决策的依据）

旧引擎把补丁写进 **profile 侧 `node_modules` 的两条候选路径**；而宿主实际是按
**installation-first 解析契约**，从**封印的 `app.asar` 内**加载 `rc.2` 副本 ——
**两条路径集合永不相交**。

后果不是「偶尔失效」，而是**结构性失效**：补丁永远维护着一个**没有人读的文件**。
功能看起来在跑（文件被改了、状态面报「已生效」），实际出站的每一个字节都没变。
这类缺陷无法靠「更勤的定时维持」或「更准的锚点匹配」修好 —— 维持得越勤，
维护的那个死文件就越新。

### 0.1.3 生效替代方案（现状）

| 性质 | 落地处 | 含义 |
|---|---|---|
| **逐条目载荷** | `src/auto-route-adapter.ts` 的 `masqueradePayloadOf(entry)` | 载荷由**该条 entry** 现算，与 `forwardOptions` 的三个载体字段**同源**（同一份数据、两个消费点），不是另立真相源 |
| **ALS 包消费侧** | `withMasqueradeAsyncIterable(payload, stream)` 套住 `for await` | async generator 的函数体在**恢复它的 `.next()`** 的上下文里执行，故上下文必须加在消费侧；加在创建点等于什么都没包，且**不会报任何错** |
| **按需安装** | `ensureMasqueradeFetch()`，仅当载荷非 `undefined` 时调用 | 默认路径下 `globalThis.fetch` 与加本功能之前是**同一个对象** |
| **默认路径零改动** | 包装器无载荷时 `base(input, init)` 原样转发 | 三个字段归一后全空的条目（绝大多数）出站逐字节不变 |
| **不写宿主文件** | 全模块零文件 IO | 「锚点漂移 / 版本记账 / 5 分钟定时维持 / 零配置自动还原 / 与第三方补丁抢锚点」这一整类可失败状态**随之整体消失** |

### 0.1.4 刻意保留的东西（别顺手删）

- **公开 RPC 契约**：`masquerade.status` / `masquerade.apply` 仍在，二者共用冻结常量
  `{ available: true, transport: 'als-fetch' }`；`masquerade.apply` 是**刻意保留的无副作用空操作**
  （外部脚本/自动化可能仍在调用，删掉会让调用方把「不需要做任何事」误读成「功能坏了」）。
- **配置面字段**：`entry.masquerade.windowId` 与面板上的预设下拉、`AUTO_ROUTE_*` 常量一律不动
  （用户可见契约）。
- **三个头的取值判据**：仍在 `src/account-hub-user-agent.ts` / `account-hub-originator.ts` /
  `account-hub-window-id.ts` 各一份，运输层只调用它们的 `normalize*`，不复制校验。

---

## 1. 需求与目标

### 1.1 要解决的问题

`router-4`（4router.net）等第三方聚合网关有一条**渠道白名单**：`channel:codex_only`
的渠道只服务「看起来像官方 Codex 客户端」的请求，否则直接 **403**。判据不是密钥，
而是**出站身份**：

| 判据维度 | 官方 Codex 客户端的形态 | 我们默认的形态 | 结果 |
|---|---|---|---|
| `User-Agent` | `codex_exec`（真实值见 §4.3） | `deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)` | 不通过 |
| `Originator` | 有 | **完全不发这个头** | 不通过 |
| `x-codex-window-id` | 有（会话窗口 id） | 不发 | 不通过 |
| 请求体 | `store:false` / `stream:true` / `tool_choice:'auto'` / `parallel_tool_calls:true` + 身份指令 | 无这些字段 | 不通过（**本设计不做 body 伪装**，见 §13 分叉 e） |

本插件现有的 `autoRoute` 候选**已经**支持 `userAgent` / `originator` 两个手填覆写字段
（`src/account-hub-user-agent.ts` / `src/account-hub-originator.ts`，经
`src/auto-route-adapter.ts` 的 `forwardOptions()` 注入）。但那两个字段只覆盖了上表
**前两行的一半**，且第一行在外部 provider 上**根本发不出去** —— 原因见 §3.2。

> **注**：上表最后一行（请求体）本设计**不做** —— body 伪装整体裁撤，`x-dsh-body-masquerade`
> 开关头不发送。残余风险（闸门可能仍拒）已记录在 §13 分叉 e，本文不再展开。

### 1.2 目标

| # | 目标 | 判据 |
|---|---|---|
| G1 | 一条候选可**一键**切换成「Codex 客户端」形态 | 面板上有一个预设下拉，选完保存即生效，无需手填三个字段（UA / Originator / windowId） |
| G2 | 伪装**默认关闭**，关闭时出站请求**逐字节不变** | 与 AGENTS.md「出站协议值不随 provider id / 显示名变化」红线一致 |
| G3 | 伪装只作用于**配了它的那条候选**，不影响其余候选与七个直连 provider | 一条候选开了伪装，另一条没开，两者出站头互不影响 |
| G4 | 伪装**不需要任何维持动作**：不写宿主文件 ⇒ 没有「被 `tsc` 重建抹掉」这回事 | 全模块零文件 IO（§3.1），不存在可失效的落盘状态 |
| G5 | 与 `shabhui/dsh-client-masquerade` **互不破坏**：对方若在场（无论它改的是宿主文件还是别处），本设计都照常工作 | 本设计只在自己进程内包装 `globalThis.fetch`，与任何写宿主文件的机制天然正交（§7） |
| G6 | 出站身份**不随 `provider id` / 显示名变化**（沿用 AGENTS.md 红线） | 载荷只由该条目显式配置的三个值算出，与 provider 命名无关 |
| G7 | 失败方向是**少一个头**，绝不是**请求失败** | 单头异常就地吞掉、请求照常发出（§3.5） |

### 1.3 非目标

- **不做**通用「任意请求头」通道。宿主 `GenerateOptions` 不该有这种字段
  （`src/account-hub-user-agent.ts` 模块头已论证），本设计沿用该纪律：新通道只承载
  **命名枚举**的伪装字段，不是 `Record<string, string>`。
- **不做**其它 provider（buddy / trae / qoder / …）的伪装。七家自有协议，无此需求。
- **不做**对 `discoverModels`（模型列表路径）的伪装。见 §10 风险 R7。
- **不改**七个 provider 适配器的任何一行。

---

## 2. 总体架构

### 2.1 分层

```
┌─ 配置面（本插件，改的是自己的存储） ────────────────────────────────┐
│  accountPool.autoRoute.models[].entries[].masquerade?              │
│    { windowId }                              ← 新增可选字段         │
└───────────────────────────┬────────────────────────────────────────┘
                            │ autoRouteConfigFacts() 变化 ⇒ 运行时重建
┌─ 转发面（本插件，src/auto-route-adapter.ts） ──────────────────────┐
│  forwardOptions(options, entry)                                    │
│    + accountHubUserAgent     （既有通道，预设会写这个字段）          │
│    + accountHubOriginator    （既有通道，预设会写这个字段）          │
│    + accountHubMasquerade?   （载体字段，随 options 流进宿主适配器） │
│  masqueradePayloadOf(entry)                                        │
│    → 载荷（与上面三个载体字段同源，见 §0.1.3）                       │
└───────────────────────────┬────────────────────────────────────────┘
                            │ 载荷绑进 ALS，套住**消费侧**（for await）
                            │ ctx.llm.stream() 重入，宿主按 provider 选适配器
┌─ 宿主适配器（dsh-llm-pi-ai，★本设计不碰它的任何文件） ─────────────┐
│  streamWithSnapshot(options, snapshot)                             │
│    headers: requestHeaders(profile.headers)                        │
│    （原样，无改写：UA / Originator 由内层适配器读载体字段覆写）        │
└───────────────────────────┬────────────────────────────────────────┘
                            │ pi-ai streamSimple(model, context, options)
┌─ pi-ai（@earendil-works/pi-ai，本设计不改） ───────────────────────┐
│  openai-responses.js: createClient(...)                            │
│    Object.assign(headers, optionsHeaders)                          │
│  buildParams(...)                           ← 本设计不涉及（body 不做）│
└───────────────────────────┬────────────────────────────────────────┘
                            │ ★ 出网咽喉：globalThis.fetch 包装器在此读 ALS 载荷，
                            │   把三个头就地写进**这次请求自己的** headers
                            │ HTTPS
                       4router.net /v1/responses
```

### 2.2 数据流（一次请求，逐跳）

| 跳 | 位置 | 发生什么 |
|---|---|---|
| 1 | DSH 会话 | 用户选中的模型是自动模型 `auto-xxx`（provider = `auto-route`） |
| 2 | `AutoRouteAdapter.stream()` | 取队首条目；`forwardOptions()` 把 `entry.userAgent` / `entry.originator` / `entry.masquerade` 挂成三个 `accountHub*` 载体字段 |
| 3 | 宿主 `ctx.llm.stream()` 重入 | 按 `entry.provider`（如 `router-4`）选中 `PiAiAdapter`；多余字段原样带着走 |
| 4 | `AutoRouteAdapter.stream()` | `masqueradePayloadOf(entry)` 由**同一条 entry** 现算载荷；有载荷则 `ensureMasqueradeFetch()`（幂等） |
| 5 | 运输层 · ALS | `withMasqueradeAsyncIterable(payload, upstream)` 套住 `for await` **消费侧**，把载荷绑在驱动这一路流的上下文上 |
| 6 | `PiAiAdapter.streamWithSnapshot()` | `requestHeaders(profile.headers)` 先算出基线头（**含框架归属 UA**）；内层按需读两个载体字段覆写 `user-agent` / `Originator` |
| 7 | pi-ai `createClient()` | `Object.assign(headers, optionsHeaders)` 把头合进 OpenAI 客户端 |
| 8 | pi-ai `buildParams()` | 本设计**不涉及**（body 伪装不做，见 §13 分叉 e） |
| 9 | ★出网咽喉 | `globalThis.fetch` 包装器读 ALS 载荷，把三个头**就地**写进**这次请求自己的** `init.headers` |
| 10 | 出站 | 4router 闸门看到 Codex 形态 ⇒ 放行（若仍拒，见 §13 分叉 e 的残余风险） |

### 2.3 为什么挂在 `globalThis.fetch`（旧「补丁落点」取舍存档）

**现行方案**：出站请求头由内层真实适配器在它自己的 `send()` 里自建，聚合层
（`src/auto-route-adapter.ts`）一点都碰不到；宿主 `ctx.llm.stream(options)` 也没有
「带自定义头」这个入口。与其把三个值逐个穿进七个适配器（七处接线、七处漏接风险），
不如在唯一的出网咽喉 —— `globalThis.fetch` —— 上统一改写。于是本设计**不写宿主任何
文件**，装载随插件进程发生。

**为什么不能只靠 profile 配置**（这条事实仍然成立，是运输层存在的前提）：
`requestHeaders()`（`lib/index.js:1732-1740`）先把与 `attributionHeaders()` 键名
（大小写不敏感）冲突的项**过滤掉**，再把归属头 `...attribution` 铺在后面 —— 归属头
**赢**。故往 profile 的 provider 段里写 `user-agent` 是**无效**的（被静默丢弃）；
`originator` / `x-codex-window-id` 不在归属头键名集合里，本来就能透传。
（真机验证通过的是「UA + originator + `x-codex-window-id` + body」四者齐备的形态；
本设计只做**头三项**，body 不做 —— 如实记录，见 §13 分叉 e。）

> **历史存档（旧补丁引擎的落点取舍，已随 §0.1 退役）**：旧方案选的落点是
> `dsh-llm-pi-ai/lib/index.js` 的调用点 `:1883`（包一层）+ 文件末尾追加注入函数；
> 不选 `pi-ai/openai-responses.js`，是为了避开 masquerade body 补丁在
> `createClient` 的 `Object.assign(headers, optionsHeaders)`（`:197-200`）上的锚点。
> 它当时自认的「代价」是：补丁落到源码 checkout 的 `lib/` 里、`tsc` 一次重建即抹掉、
> 故需要自动维持循环 —— 这套取舍连同它的代价已整体作废，**现在一个宿主文件都不写**。

---

## 3. 运输层设计

### 3.1 落点：`globalThis.fetch`，**不写任何宿主文件**

| 项 | 值 |
|---|---|
| 模块 | `src/account-hub-masquerade-transport.ts` |
| 落点 | `globalThis.fetch` 包装器 + `AsyncLocalStorage` |
| 目标文件 | **无**。全模块零文件 IO：不解析包路径、不读写 `node_modules`、不碰 `app.asar` |
| 安装时机 | 接线方在**载荷非 `undefined`** 时调 `ensureMasqueradeFetch()`（幂等，重复调用不叠层） |
| 模块加载副作用 | **零**：被 import 时不碰 `globalThis.fetch`、不注册任何钩子，安装只发生在显式调用时 |

> ⚠️ **旧「§3.1 目标文件与解析」已随 §0.1 退役删除**（含 pi-ai 侧的目录拼接路径）。
> 它记录的那两条候选路径（`require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')`
> → `join('lib/index.js')`，以及 `<profile>/node_modules/@earendil-works/pi-ai/dist/api/…`
> 优先的两条拼接）**正是退役根因里那两条「永远打不中真文件」的路径**：宿主按
> installation-first 解析契约从封印的 `app.asar` 内加载 rc.2 副本，两者路径集合永不相交。
> 留着这套解析规则只会让后来者重新走上那条死路，故整节删除、不留存档。

### 3.2 为什么必须存在这条通道（`requestHeaders` 的归属头碰撞）

`lib/index.js:1732-1740` 的原文语义（逐行）：

| 行 | 内容 | 语义 |
|---|---|---|
| 1733 | `function requestHeaders(headers)` | 入参 = profile 里该 provider 的 `headers` 段 |
| 1734 | `const attribution = attributionHeaders()` | 取框架归属头，实测为 `{ 'user-agent': 'deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)' }` |
| 1735 | `const reserved = new Set(...toLowerCase())` | 归属头键名集合（小写） |
| 1736-1739 | `{ ...过滤掉 reserved 的 profile.headers, ...attribution }` | **归属头赢** |

结论：`user-agent` 是**保留键名**，profile 里写什么都发不出去。这是本设计必须存在
一条**绕过 profile 的通道**的**唯一**原因（其余两个头本就能透传，但也一并走同一条通道，
避免两套机制并存）。旧方案用「打补丁改宿主文件」绕，已随 §0.1 退役；现行方案用
`globalThis.fetch` 包装器在**出网前**改写，见 §3.3。

### 3.3 载荷的语义规格（`MasqueradePayload`）

载荷是**三个各自独立的可缺席字段**（部分伪装是合法形态：只配了 `userAgent` 的条目
就只换 UA，另外两个头一个字节都不动）：

| 字段 | 出站动作 | 缺省行为 |
|---|---|---|
| `userAgent` | `User-Agent` **整体换成**它（不是追加、不是前缀） | 不动（保留归属头） |
| `originator` | **新增**一个 `Originator` 头并取该值 | 不动（该头本就不存在） |
| `windowId` | **新增**一个 `x-codex-window-id` 头并取该值 | 不动 |

| 纪律 | 说明 |
|---|---|
| 值**在此处不再校验** | 三个字段的判据分别归 `src/account-hub-user-agent.ts` / `account-hub-originator.ts` / `account-hub-window-id.ts`（写路径与读路径共用的唯一判据）。运输层只调用它们的 `normalize*`，**不复制一份校验** —— 三处判据一旦分叉，就会出现「配置面接受、出站面拒绝」这类只在特定输入下现形的缺口 |
| 不做「任意头」 | 载荷是**命名枚举**对象，不是 `Record<string,string>`。理由见 §1.3 |
| 三者归一后全空 ⇒ `undefined` | 这是**默认路径逐字节不变**的判据所在：调用方既不装包装器、也不套 ALS 代理（见 §3.6、§3.8） |
| 判据是「归一后至少一个字段」 | 而**不是**「`entry.masquerade` 在不在」—— UA / Originator 单配（没配 `windowId`）同样是要伪装的请求 |

### 3.4 三种头容器形态与写入纪律

`RequestInit.headers` 的全部三种载体形态各按自己的规矩写，**同一个头名在一次请求里
只能出现一次**（否则上游看到的是拼接值，是最难查的一类缺陷）：

| 形态 | 写法 |
|---|---|
| `Headers` | `set()`，键大小写不敏感，天然覆盖 |
| `string[][]` | 同名的对**就地对调**（保序，不把 `User-Agent` 挪到头的末尾去），多余的重复对删掉，没有则 push 一对新的 |
| 普通对象 | 先删掉同名异形键（`user-agent` 之类），再按规范键名赋值 |

| 纪律 | 说明 |
|---|---|
| 只写**既有的**容器 | 不重建容器、不重建任何对象。`init` 上可能挂着 `duplex`（流式请求体必需）、`signal`、`body` 流等一堆不能复制的字段，故**绝不重建 `init`**；没有载体时才挂一个空对象 |
| `init` 缺席 ⇒ 原样转发 | **不代造 `init`**。openai SDK 的真实调用形状恒为 `(url, init)`；`fetch(request)` 那种 Request 对象形态放弃伪装照常发送（造一个假的 init 去补头，等于替调用方改变请求语义，比不伪装危险得多） |
| 单头写失败只退化成「少一个头」 | 见 §3.5 |
| 值非法 ⇒ 当「没有」 | `normalize*` 已保证「脏值一律当没有、绝不抛错」（配置面到出站面隔着 RPC 反序列化，那里抛错等于把一次配置笔误升级成请求失败） |

### 3.5 失败处置：只允许「少一个头」，**绝不允许请求失败**

| 情形 | 处置 |
|---|---|
| 单个头的值非法（含 CR / LF 让 `Headers.set` 抛 `TypeError`）、容器只读 guard | **就地吞掉该头的异常**，既不外抛、也不连累后面两个头 |
| 一个头都没写成功 | 与「没有载荷」等效：请求照常发出，只是没伪装（返回 `false`） |
| 载荷为 `undefined` | **一次都不碰参数**，直接原样转发（见 §3.7） |
| 容器 `undefined` | 由调用方负责造载体；写入函数不代劳，直接返回 `false` |
| `init` 缺席 | **不代造 `init`**（见 §3.4） |

⚠️ **这条纪律的方向是刻意的**：伪装是**锦上添花**，绝不能把一次配置笔误升级成
**请求失败** —— 后者会直接毁掉一次对话，而前者的代价只是「这次没伪装上」。
这与旧补丁引擎的「锚点不匹配 ⇒ 抛错、不写」是**相反**的取舍方向，原因是失败的性质
不同：旧方案写坏的是**宿主文件**（不可逆、影响所有请求），新方案最坏只是**这一次**
少写一个头（下一次请求照常尝试）。

> **旧「§3.5 失败处置 / §3.6 原子写入 / §3.7 硬链接实测 / §3.8 自动维持循环」已随
> §0.1 整体退役删除**。它们记录的是「临时文件 + rename 原子替换」「pnpm store 硬链接
> 分离」「marker / fence 配对校验」「零命中/多命中一律抛错不写」，以及那个 **5 分钟
> 低频自检定时器** —— 这一整套机制存在的前提是「补丁会被 `tsc` 重建抹掉」，而新版
> **一个宿主文件都不写**，故前提消失、机制整体不需要：没有「打没打上」这种可失败状态，
> 也没有需要自愈的东西。详见 §0.1.2 / §0.1.3。

### 3.6 安装、卸载与共存

| 项 | 行为 |
|---|---|
| 安装 | `ensureMasqueradeFetch()`，**幂等**：重复调用不叠层（先查标记） |
| `base` 捕获 | 在**安装时刻**捕获当时的 `globalThis.fetch`，包装器只转发给它 ⇒ 能与其它同样包装 `globalThis.fetch` 的插件**共存**（后装的套在外层，逐层透传） |
| 卸载 | `releaseMasqueradeFetch()`：**只还原自己那一层**。若当前 `globalThis.fetch` 已不是本模块装的包装器（被别的插件又套了一层、或被测试替换过），**什么都不做** —— 硬还原会踩掉别人的包装 |
| 身份标记 | 挂在包装函数自己身上的 `Symbol.for('dsh-account-hub.masquerade-transport.fetch')`。用 `Symbol.for` 而非 `Symbol()`：同一个模块被两条路径加载出两份实例时（打包器去重失败、ESM/CJS 双份），`Symbol()` 的两份标记互不相等，会各装一层 |
| 与宿主代理插件的关系 | 宿主代理那条走 undici dispatcher 的路子，是**更底层**的一层，与本包装器不冲突 |

### 3.7 默认路径**零变化**（本设计的核心红线）

| 层 | 零变化的表现 |
|---|---|
| 模块加载 | 被 `import` 时**不安装任何东西**（不碰 `globalThis.fetch`、不注册钩子）。安装只发生在显式调用 `ensureMasqueradeFetch()` 时 —— 由接线方决定时机，也让单测能干净地进出这个状态 |
| 安装时机 | 接线方**仅在载荷非 `undefined` 时**才调 `ensureMasqueradeFetch()` ⇒ 默认路径下 `globalThis.fetch` 与加本功能之前是**同一个对象**（哪怕包装器在零载荷时只是纯转发，装它也会改变**所有**出站请求的调用栈形态，而 `globalThis.fetch` 是全进程共享的、别的插件也看得见） |
| 无载荷时的包装器 | `base(input, init)` 原样转发，**连 `init` 的字段都不读** |
| ALS 代理 | 载荷为 `undefined` 时**不套**：`consumed` 就是内层流本身 |

出站请求与加本模块之前**逐字节一致** —— 这是 `AGENTS.md`「出站协议值不随 provider id /
显示名变化」红线的延伸。

### 3.8 核心纪律：ALS 包**消费侧**，不包创建侧

**这条是本设计最容易改错的地方，且改错时不会报任何错。**

async generator 的**函数体**不在创建它的地方执行，而在**每一次恢复它的
`.next()` / `.return()` / `.throw()` 调用的上下文**里执行。故只包住「创建」、
然后让外层 `yield*` 去消费，载荷在整段运行期都是**看不见**的 —— 创建时的上下文
根本不会被函数体继承。

| 落点 | 正确性 |
|---|---|
| `withMasqueradeAsyncIterable(payload, stream)` 套在 `for await` 这一侧 | ✅ 每一次 `.next()` 都进上下文，内层适配器**真正发请求那一刻**看得见载荷 |
| 加在 `ctx.llm.stream(forwarded)` 的创建点 | ❌ 等于什么都没包，且**不报错**，只是「伪装整段静默失效」 |

**代理必须把 `next` / `return` / `throw` 三个方法全部包住**（每次都
`masqueradeStorage.run(payload, ...)`）：

- `next()` → 载荷在「生成器函数体运行 + 它发出的请求」期间可见；
- `return()` → 载荷在「`break` / 提前退出触发的 `finally` 收尾」期间可见；
- `throw()` → 载荷在「异常处理分支」期间可见。

⚠️ **不能只包 `next()`**：真实适配器的流在提前退出时会走 `return()`，那条路径上的
清理逻辑一样可能发请求（销账、上报），掉了载荷就会**用错身份**。少包一个，语义就不闭合。

源迭代器**没实现** `return` / `throw` 时，按迭代协议自己收尾（`return` 回
`{ done: true }`、`throw` 把异常抛回调用方），不能把调用方的退出动作吞掉。

### 3.9 与 `forwardOptions()` 的接线

`src/auto-route-adapter.ts:401-411` 的 `forwardOptions()` 需要**新增一行**，
形态与既有两行逐字对齐：

| 载体字段 | 来源 | 缺省处置 |
|---|---|---|
| `accountHubUserAgent` | `entry.userAgent` | 不挂键（既有） |
| `accountHubOriginator` | `entry.originator` | 不挂键（既有） |
| `accountHubMasquerade` | `entry.masquerade`（★新） | **不挂键** |

**为什么「不挂键」而不是「挂 undefined」**：既有 JSDoc 已论证（`forwardOptions` 的
`reasoningEffort` 一段）—— 挂 `undefined` 会**覆盖**调用方带来的值；且
`accountHubUserAgentOf()` 用的是 `=== undefined` 判定，两种形态等效但语义上
「压根没有这回事」更诚实。三个字段**必须同款**，少一处就是「配了却没生效且无报错」。

### 3.10 与 `autoRouteConfigFacts()` / `entryKey()` 的接线

| 函数 | 位置 | 是否必须扩展 | 漏了会怎样 |
|---|---|---|---|
| `autoRouteConfigFacts` | `src/auto-route.ts:180-195` | **必须** | 用户改了伪装预设，运行时**不重建**，请求仍按旧头发出，且无任何提示（`docs/agents/auto-route-runtime.md` §5 已把这条列为三类漏法之一） |
| `entryKey` | `src/auto-route.ts:436-438` | **必须** | 同 provider + 同模型 + 同档位 + 同 UA + 同 originator、**只有伪装预设不同**的两条候选会被判为重复 ⇒ 后者被静默丢弃 |
| `sanitizeAutoRouteConfig` / `readEntry` | `src/auto-route.ts:394-420` | **必须** | 脏值不会被丢弃；且读路径的「只丢字段、不丢条目」纪律要照抄 |
| `assertValidAutoRouteConfig` | `src/auto-route.ts:534+` | **必须** | 写路径不拒非法值 ⇒ 坏配置落盘 |

**`autoRouteConfigFacts` 的键序纪律**：它用 `JSON.stringify` 做内容指纹，注释明确
要求「输入来自 `sanitizeAutoRouteConfig`，按固定字段顺序新建对象」。新增的
`masquerade` 必须出现在**固定的**位置，且其内部字段（`preset` / `windowId`；`deviceId`
已随 §13 分叉 e 删除）也必须是**显式字面量**、缺省写成 `null` 占位（`undefined` 会被
`JSON.stringify` 整键丢弃，与「键存在但值为 undefined」混为一谈 —— 而两者语义不同）。

---

## 4. 预设与数据模型

### 4.1 存储位置：`autoRoute` 内部，**不动九字段 schema**

这是一个**重要的好消息**，必须先讲清楚：

| 事实 | 出处 | 结论 |
|---|---|---|
| `autoRoute` 整块用 `Schema.any().default(DEFAULT_AUTO_ROUTE_CONFIG)` 承接 | `src/account-pool.ts:246-258` | 新增 entry 字段**不需要**动 schemastery |
| 该注释明确写了理由：「它的形状由 `src/auto-route.ts` 的判据负责（那是唯一真相源），在这里再写一份 schemastery 结构就是第二份判据」 | 同上 | 新增字段只在 `src/auto-route.ts` 扩展，**不碰** `src/account-pool.ts` |
| `persist()` **逐字段枚举**（无 spread） | `src/account-pool.ts` | `autoRoute` 已在枚举列表里 ⇒ **不需要**加第十个字段 |
| 存储域仍是 `dsh_account_hub`、九字段不变 | `ACCOUNT_HUB_SCHEMA_VERSION = 6` | **不需要** bump `schemaVersion` |

**为什么不需要迁移、不需要 bump `schemaVersion`**：新字段是**可选**的，老数据读出来
就是「没有这个字段」= 关闭伪装；读路径丢弃脏值；写路径拒绝非法值。三条合起来满足
「老数据无需迁移即可被新版本正确读取」。**这是有意的**：`schemaVersion` 是为**重命名
类**迁移（如 `buddy`/`workbuddy` 改名）准备的，为一个纯新增可选字段 bump 它，
会让所有用户的配置多跑一次无意义的迁移。

⚠️ **但有一条硬约束**：若将来真要做 `replaceAll` 式重命名迁移，**必须**把九个字段
**全带上**（漏一个 = 用户配置被清空）。本设计不新增字段，故不触发这条，但实现者
若顺手加了新字段，必须同步检查迁移路径。

### 4.2 预设目录

| 预设 id | 显示名 | 状态 | 覆盖内容 |
|---|---|---|---|
| `off`（缺省） | 关闭 | v1 | 不写任何伪装字段 |
| `codex` | Codex 客户端 | v1 | 见 §4.3 |
| `claude` | Claude Code | **预留**（见 §11 分叉 a） | 未定义 |
| `custom` | 自定义 | v1（UI 态，**不持久化**） | 用户手改 UA / Originator 任一值后下拉自动切到此态；出站身份只看两字段实际值（见 §13 分叉 b） |

> **预设是 UI 宏，不是持久化的身份来源**（§13 分叉 b）：选 `codex` 只是把官方真值
> **填进** `entry.userAgent` / `entry.originator` 两格，**不锁只读**；用户手改任一值，
> 下拉自动切「自定义」。出站身份**只看两字段的实际值**，不看预设名；**预设名不持久化**。

### 4.3 `codex` 预设的字段清单

| 载体 / 字段 | 值 | 来源 | 备注 |
|---|---|---|---|
| `entry.userAgent` | `codex_exec`（**真实值以 masquerade 常量为准**） | `shabhui/dsh-client-masquerade` 的 `index.js:71-75`（`PRESETS` 的 `'codex'` 块，**纯字面量、无插值**） | ⚠️ **逐字拷贝，不得手抄重打**。这是通过闸门的实测值 |
| `entry.originator` | 同 UA 的实测值 | 同上（同一块，`:74`） | 用户真机验证过 |
| `accountHubMasquerade.windowId` | UUID | 随伪装头自动生成并逐条目持久化 | `x-codex-window-id` 的值；界面无感；见 §11 分叉 c |

**已裁撤**：`accountHubMasquerade.bodySwitch`（`x-dsh-body-masquerade` 开关头）、请求体
指纹（`store` / `stream` / `tool_choice` / `parallel_tool_calls`）、身份指令
（`You are Codex…`）、指纹版本记账 —— body 伪装整体不做，**这些字段与常量一律不实现、
不发送**（见 §13 分叉 e）。原表所列的 masquerade 常量（`codex-fingerprint.js` 的
`defaults` / `identityInstructions` / `revision` 等）仅作历史存档，本设计不引用。

**纪律**：上表所有**字面量**都是**外部实测值**，必须以 masquerade 的 `PRESETS`
定义（`index.js` 的 `'codex'` 块）为唯一真相源，**不得**在本仓再抄一份、更不得凭
记忆重打（UA 里少一个下划线就是 403，且完全没有可归因的报错）。建议实现时在单测里
钉住「本仓常量 === masquerade 常量」的对照断言。

> ⚠️ **来源路径订正（卡 3 交叉核对）**：两个字面量**不在** `patches/patch-lib.js`，
> 而在 `index.js:71-75` 的 `'codex':` 块内（`'user-agent'` 在 `:73`、`'originator'`
> 在 `:74`）。该块是**纯字面量、无字符串插值**，与真机值逐字符一致 —— 这点很关键：
> `patch-lib.js` 只是 UA 补丁的**逻辑**（它引用 `codex-fingerprint.js` 取
> `engineHeader`），从不持有这两个值。`codex-fingerprint.js` 里也**没有**
> `codex_exec` 字面量（它只有 `engineHeader` / `identityInstructions` / `defaults`）。
> 按旧路径去找值会找不到，进而诱发「凭记忆重打」——正是 R11 要防的失误。

### 4.4 数据模型（★已按 §13 决议收敛）

```
AutoRouteEntry {
  provider, model, effort?, userAgent?, originator?,     // 既有
  masquerade?: {                                          // ★新增（可选）
    windowId: string,                                     //   x-codex-window-id
  }
}
```

| 设计点 | 取值 | 决议依据 |
|---|---|---|
| 挂在哪一级 | **条目**（`entry.masquerade`） | 与 `userAgent` / `originator` 同级 —— 一条候选 = 一次具体出站请求（既有 JSDoc 已定案） |
| 是否与 `userAgent` / `originator` 并存 | **并存**：预设开启时**填入**这两个字段，但**保持可编辑**（不置只读）；手改任一值 ⇒ 下拉自动切「自定义」 | §13 分叉 b（B1 修订版） |
| `preset` 类型 | 字面量联合（`'codex'`），不用 `string` | 自由字符串会让写路径的判据退化成「非空即可」。注意：预设名**不持久化**，出站身份只看 `userAgent` / `originator` 实际值 |
| `windowId` 归属 | **逐条目**，随伪装头自动生成、持久化、此后不变 | §13 分叉 c（C1）；已与 `deviceId` 合并裁定，**只留 `windowId`** |
| `deviceId` | **删除**。其唯一用途是拼 `x-dsh-body-masquerade` 的值，而该头**不发送** | §13 分叉 e（E1 修订版） |
| 是否要 `enabled` 布尔 | 不要。`masquerade` 键**缺席** = 关闭（与 `userAgent` 缺省同款） | — |

### 4.5 降级矩阵（沿用既有三档）

| 档 | 行为 |
|---|---|
| storage（`dsh_account_hub`） | 正常读写 |
| 旧 settings 回退（`jet-hub`） | 同款：`autoRoute` 整块经 `sanitizeAutoRouteConfig`，`masquerade` 脏值**只丢字段、不丢条目** |
| 内存 | 同上；伪装照常工作 —— 运输层活在进程内存里，**不依赖存储**（旧文此处写「补丁维持循环仍在」，那套循环已随 §0.1 退役） |

---

## 5. UI 设计

### 5.1 落点

候选编辑弹窗 `AutoRouteEntryEditor`（`plugin-src/client/account-hub.js:2524-2660`），
当前五行：

| 行 | 内容 | 行号 |
|---|---|---|
| 1 | 供应商 | `:2585-2592` |
| 2 | 模型 | `:2593-2602` |
| 3 | 思考程度 | `:2603-2612` |
| 4 | User-Agent（label + 输入 + ⟲） | `:2614-2635` |
| 5 | Originator（label + 输入 + ⟲） | `:2639-2659` |

**新增第 6 行：客户端伪装**（预设下拉）。位置在 Originator **之后** —— 它是这三行
「身份伪装」组的**总控**，放在组尾（或组首）都比插在中间合理；草案取组尾，
理由是它开启后会把官方真值**填入**上面两行，视觉上「先看到被填入的两格、再看到填入它的宏」。

> 该行**只做「一键填入」**：两格保持可编辑（**不锁只读**），用户手改任一值即自动切「自定义」
> （§13 分叉 b）。界面上**没有**还原按钮、**没有** body 开关，`windowId` 也**不暴露**
> （§13 分叉 c / e / f）。

### 5.2 形态（草案）

| 元素 | 形态 | 说明 |
|---|---|---|
| 控件 | `AutoRouteSelect`（既有下拉，与前三行同款） | 复用既有组件，不引入新控件 |
| 选项 | `关闭` / `Codex 客户端`（+ 预留项） | 选项 id 是预设 id（`''` 哨兵 = 关闭，与 `AUTO_ROUTE_DEFAULT_EFFORT = ''` 同款） |
| 联动 | 选 `codex` ⇒ 把官方真值**填入**上面 UA / Originator 两行；两行**保持可编辑、不锁只读**。用户手改任一值 ⇒ 下拉**自动切到「自定义」** | 见 §13 分叉 b |
| 状态徽标 | 行内**一个**徽标：`出站伪装已就绪`（`AUTO_ROUTE_MASQUERADE_READY`，tone = success） | 数据来自 RPC `masquerade.status`（见 §5.3）。**收到该 RPC 的响应本身就证明运输层在场** —— 故只有「就绪」这一态，没有「未打补丁 / 版本不匹配 / 环境不支持」这三态 |
| 还原入口 | **无**，且**不再需要** | 旧方案要还原宿主文件，才有「怎么撤销」的问题；运输层不写任何文件，清空条目伪装头即彻底关闭（见 §13 分叉 f） |

**预设是「一键填入官方真值」的宏**（§13 分叉 b）：预设名**不持久化**，出站身份只看
`entry.userAgent` / `entry.originator` 两格的实际值，不看预设名。`windowId` 随伪装头
自动生成、逐条目持久化，界面**不暴露**任何生成/管理入口（§13 分叉 c，无感）。

### 5.3 需要的新 RPC

| RPC | 入参 | 出参 | 纪律 |
|---|---|---|---|
| `masquerade.status` | 无 | `{ available: true, transport: 'als-fetch' }`（冻结常量） | **永不抛错**。出参**只剩两项** —— 旧方案那套 `applied` / `reason` / `targetVersion`（回答「打没打上补丁」）随 §0.1 整体消失：运输层活在进程内存里，**没有可失败的在盘状态**，故没有可报的「未生效原因」 |
| `masquerade.apply` | 无 | 同上（**同一个冻结常量对象**） | **刻意保留的无副作用空操作**。它今天不做事，但**不删** —— 外部脚本/自动化可能仍在调用，删掉会让调用方把「不需要做任何事」误读成「功能坏了」（§0.1.4） |
| ~~`masquerade.revert`~~ | — | — | **不提供**（§13 分叉 f：无手动还原入口）。运输层不写任何文件，**没有可还原的对象** |

> ⚠️ **`applied` 字段的消失是刻意的，不要为「兼容」把它补回来**：一个恒为 `true` 的
> `applied` 会让读者重新以为存在「已应用 / 未应用」两态，而那正是被 §0.1 淘汰的模型。
> 查询「运输层在不在」的唯一方式是 `available` + `transport`（见 §5.2 徽标）。

⚠️ **客户端有渲染级单测，`build:client` 冒烟是另一道防线**（订正：原稿称「唯一防线」，
与事实不符 —— 既有 **15 个** spec 真渲染 `plugin-src/client/`，见 §10.1）。`plugin-src/`
**不在** typecheck 视野内（见 `AGENTS.md`），故新增下拉的**模板字符串求值类错误**由
两道闸共同兜住：① 渲染级单测真的把组件渲染出来，能抓住运行期求值错误；② `build:client`
末尾的产物顶层求值冒烟抓**打包产物顶层**求值错误（单测走的是源码改写版、不覆盖这一层）。
那道闸**不得删除、不得跳过**。

### 5.4 常量（与既有风格对齐）

| 常量 | 值 | 对齐对象 |
|---|---|---|
| `AUTO_ROUTE_MASQUERADE_OFF` / `_CODEX` / `_CUSTOM` | `''` / `'codex'` / `'custom'` | 预设 id；`''` 哨兵 = 关闭，与 `AUTO_ROUTE_DEFAULT_EFFORT = ''` 同款 |
| `AUTO_ROUTE_MASQUERADE_READY` | `出站伪装已就绪` | tone = `success`。**只剩这一个**状态常量 |

> ⚠️ **旧表里的四个状态常量（`_APPLIED`「已生效」/ `_NOT_PATCHED`「未打补丁」/
> `_VERSION_MISMATCH`「目标文件版本不匹配」/ `_UNAVAILABLE`「当前环境未安装外部 provider
> 适配器」）全部删除**，它们描述的四种在盘状态已随 §0.1 消失。删掉而不是保留成「永不出现的
> 死常量」，是因为留着会让人以为还存在「打没打上」这条判据（§5.3 同款理由）。

### 5.5 CSS

新增两条规则到 `plugin-src/client/account-hub-styles.js`，**逐字对齐**既有
`.dim-ah-arEditorUaRow` / `.dim-ah-arEditorOriginatorRow` 的写法：

| 规则 | 对齐对象 | 必须保留的细节 |
|---|---|---|
| `.dim-ah-arEditorMasqueradeRow` | `:437` | `display:flex; align-items:center; gap:12px` |
| （输入框若有）`.dim-ah-arEditorMasqueradeInput` | `:441` | **必须显式 `box-sizing: border-box` + `min-width: 0`** —— 宿主全站没有通盘 `box-sizing` 重置，className 落在 ui-primitives 的 wrapper span 上，不声明内容盒会宽出 17px、把右邻按钮挤出弹窗 |

⚠️ 另起类名而不是复用 UA/Originator 那两个（既有注释已论证：共用一个类名会让
「只想调其中一行」的后续改动被迫同时改到另一行）。

---

## 6. 与七家现有链路的关系（零变化承诺）

### 6.1 逐条承诺

| # | 承诺 | 判据 |
|---|---|---|
| Z1 | 七个 provider 适配器（`src/llm-adapter.ts` / `buddy-*` / `lobsterai-*` / `trae-cn-*` / `qoder-*`）**一行不改** | `git diff` 只出现在 `auto-route.ts` / `auto-route-adapter.ts` / 新增文件 / 客户端三文件 |
| Z2 | `masquerade` 缺席时，`forwardOptions()` **不挂任何新键** | 与今天逐字节一致 |
| Z3 | `masqueradePayloadOf(entry)` 在三字段归一后全空时返回 **`undefined`** | 此时既不装 `fetch` 包装器、也不套 ALS 代理，出站逐字节一致 |
| Z4 | `accountHubUserAgent` / `accountHubOriginator` 的既有语义**不变** | `tests/unit/account-hub-header-overrides.spec.ts`（16 例）**全绿**，一例不改 |
| Z5 | 自动路由的转发语义（档位 / 消息重写 / 降级 / 重试策略）**不变** | `tests/unit/auto-route-adapter.spec.ts`（81 例）**全绿** |
| Z6 | 九个存储字段与 `ACCOUNT_HUB_SCHEMA_VERSION` **不变** | `docs/agents/account-hub-storage.md` 无需改 |
| Z7 | 未开启自动路由、或候选未配伪装时，**运输层在不在场都不影响出站** | 载荷为 `undefined` ⇒ 包装器纯转发（`base(input, init)` 原样），ALS 一个字节都不进 |

### 6.2 唯一「有影响」的地方（必须显式承认）

| 影响 | 说明 |
|---|---|
| 包装的是**进程级**的 `globalThis.fetch` | 这是本设计**唯一**越出「只改自己数据」边界的动作：装上去以后，**所有**走 `fetch` 的出站请求都要经过这层包装器（包括别的插件的）。它不改任何文件，也不改七家的行为，但确实动了全进程共享的入口 |
| 故有「按需安装」纪律 | 只在**载荷非 `undefined`** 时才装（见 §3.7）：默认路径下 `globalThis.fetch` 与加本功能之前是**同一个对象**，包装器压根不存在。零载荷时包装器只是纯转发，装它仍然会改变所有出站请求的调用栈形态 |
| 包装器对非伪装请求**只转发** | 载荷缺席 ⇒ `base(input, init)` 原样转发，**连 `init` 的字段都不读**（§3.7） |

**为什么这不违反「红线」**：AGENTS.md 的红线是「**出站协议值**不随 provider id /
显示名变化」—— 它管的是「改名不能改出站身份」。本设计改的是**用户显式开启的、
逐候选的伪装**，且**默认关闭时零变化**；改名的路径完全不经过这里。两者不冲突。

**与旧方案的关键差别**：旧补丁引擎改的是**磁盘上不属于本插件的文件**（宿主适配器产物），
失败是**不可逆的**（写坏文件影响所有请求）；新方案最坏只是**这一次请求**少写一个头
（`globalThis.fetch` 本身没被破坏，下一次照常尝试）。风险量级完全不同，见 §3.5。

---

## 7. 与 `masquerade` 共存矩阵

### 7.1 文件层**已无交集**（旧「锚点对照」整节作废）

本设计**不写宿主任何文件**（§3.1），而 `shabhui/dsh-client-masquerade` 那类工具走的仍是
「改 `dsh-llm-pi-ai/lib/index.js`」的路子。于是旧方案里需要逐条论证的东西——锚点是否
重叠、会不会互相覆盖、自动维持会不会撞车——**在新方案下全部不成立**：

| 旧方案要处理的问题 | 新方案下的状态 |
|---|---|
| 双方锚点是否重叠 | **不存在**：我们不占任何锚点，不读也不写那个文件 |
| 双方同时自动维持的写竞态（旧风险 R4） | **不存在**：我们没有写动作，谈不上竞态 |
| 单边还原后另一方是否崩 | **不存在**：我们既不还原别人的补丁，也不需要别人不还原 |
| 检测对方 marker（旧 §7.4） | **整节删除**：没有可检测的对象，也没有要避让的写入 |

一句话：**共存问题随「不写文件」这个决定一起消失了**。这不是「把冲突处理得更好」，
而是**把冲突的载体本身去掉** —— 与 §0.1 退役旧引擎是同一条思路。

### 7.2 但基线 UA 仍可能被对方改写（唯一还需要说清的一条）

masquerade 若在场，它改的是 `requestHeaders()` 的**里面** —— 即**基线**。我们的运输层
在那之后、出网之前覆写，故：

| masquerade UA 补丁 | 本设计运输层 | 候选配了伪装 | 出站 `user-agent` |
|---|---|---|---|
| 无 | 未装（默认路径） | 否 | 归属 UA（与加本功能前**逐字节一致**） |
| 无 | 装了 | 否 | 归属 UA（包装器零载荷纯转发，**同一结果**，Z3 承诺） |
| 无 | 装了 | 是 | 预设值（运输层覆写） |
| 有 | 装了 | 是 | 预设值（运输层在**基线之上**覆写 ⇒ 我们的值赢） |
| 有 | 装了 | 否 | masquerade 的 codex UA（我们一个头都不碰） |

**结论**：我们的值与 masquerade 的值**不是竞争关系，是覆盖关系** —— 它决定基线，
我们决定终值。故本设计**单独安装即可工作**，不存在「双开才有效」的引导。
（body 伪装整体不做，见 §13 分叉 e；若 4router 闸门因缺 body 指纹仍拒，那是**本方案
自身的**残余风险，与 masquerade 在不在场无关。）

---

## 8. （并入 §7）

---

## 9. 「升级漂移」与「还原」两个概念**一并消失**

### 9.1 为什么这两节被整节删除

旧方案的 §9 处理的是「补丁被 `tsc` 重建 / 包升级覆盖后怎么办」「没有条目再配伪装时怎么把
文件改回去」。这两件事的**共同前提是「我们改过宿主磁盘上的文件」** —— 新版一个宿主文件
都不写（§3.1），故：

| 旧概念 | 新方案下的状态 |
|---|---|
| 升级漂移（D1–D5：`tsc` 重建覆盖补丁、包升级导致锚点漂移、用户手改文件破坏 fence 配对） | **不存在**：没有任何补丁会被覆盖，也没有锚点会漂移 —— 我们只在内存里包装一次 `globalThis.fetch` |
| 版本记账（记录「打补丁时目标的版本号」，实测 `0.1.7-rc.1`） | **整节删除**：没有目标版本这回事。`dsh-llm-pi-ai` 升到哪个版本都与本设计无关（它只是照常发它的请求，我们在更外层改写头） |
| 自动维持循环（marker / fence / 锚点唯一命中四道判据） | **整节删除**：没有「打没打上」这种可失败状态，就没有需要自愈的东西（§3.5 已记录） |
| 还原（读文件、裁 fence 块、把调用点字面量改回原样、临时文件 + rename 写回） | **整节删除**：文件从来没被改过，无需还原，也**不存在「还原后必须逐字节等于打补丁前」这条验收项** |
| 零配置自动还原（清空全部条目伪装头 ⇒ 自动还原官方文件） | **概念不成立**：那时**一个请求都不会装包装器**（载荷全 `undefined`），出站自然地回到加入本功能之前的状态 —— 「自动」是**默认路径零变化**（§3.7）的自然结果，而不是一个需要执行的还原动作 |
| ~~面板还原按钮~~ | 与旧方案一致：**不做**（§13 分叉 f 的结论保留，理由从「有自动还原」变成「压根没有需要还原的东西」） |

### 9.2 与插件卸载的关系（旧条目保留，理由更新）

插件卸载时**什么都不需要做**：没有磁盘残留、没有需要撤回的文件改动。若包装器仍装在进程里
（同一进程内热卸载的边界情形），它只是**纯转发**（载荷来自 ALS，而 ALS 的写入方已随插件
卸载不再被调用 ⇒ 载荷恒为 `undefined`），出站行为与未安装时一致。

> ⚠️ 这条要写进文档的**唯一**目的是消除旧文档留下的错误预期：旧方案里「卸载不会自动还原」
> 是一个**需要向用户交代的风险**；新方案里它**不是一个风险**，因为没有留下任何东西。

---

## 10. 测试策略

> 本节只描述**测试策略**，不写测试代码。

### 10.1 分层

| 层 | 落点 | 内容 |
|---|---|---|
| 运输层单测 | 新增 `tests/unit/masquerade-transport.spec.ts`（**30 例**） | 纯内存：造 `Headers` / `string[][]` / 普通对象三种头容器，断言三头写入形态与幂等安装/卸载。**零文件 IO、不触网**（旧方案那套 `os.tmpdir()` 夹具已随 §0.1 退役） |
| 运输层接线单测 | 新增 `tests/unit/masquerade-transport-wiring.spec.ts`（**15 例**） | 断言「载荷缺席 ⇒ 默认路径零变化」这条红线的每一层：不装包装器、不套 ALS 代理、`base(input, init)` 原样转发 |
| 载体通道单测 | 既有 `tests/unit/auto-route-masquerade.spec.ts`（**23 例**） | 表驱动，覆盖 `masqueradePayloadOf(entry)` 的归一与三字段的结构读取 |
| 转发注入单测 | 扩既有 `tests/unit/auto-route-adapter.spec.ts`（**81 例**） | 断言 `forwardOptions` 三字段的挂键/不挂键 |
| 客户端 | 既有 **15 个** spec 真渲染 `plugin-src/client/`（含 `tests/unit/auto-route-panel.spec.ts` 41 例专测 `AutoRoutePanel`，以及 `qoder-hub-blank-screen` / `account-order-panel` / `account-consumption-panel` 等） | 下拉的选项 / 联动 / 徽标由**渲染级单测**覆盖；`build:client` 的产物顶层求值冒烟是**另一道**防线（专拦模板字符串求值类错误），**不是唯一防线** |
| 端到端 | **人工**，不进 CI | 真机打 4router 请求，看 200 |

### 10.2 运输层必测项（`masquerade-transport.spec.ts`，30 例；**无文件 IO**）

| # | 用例 | 技术要点 |
|---|---|---|
| T1 | 三种头容器形态各写一次 ⇒ 三头到位 | `Headers`（`set()`）/ `string[][]`（就地对调保序）/ 普通对象（先删异形键再赋值） |
| T2 | 同一头名重复对 ⇒ **只留一个**，且留在原位置 | `string[][]` 形态最容易漏；断言长度与顺序 |
| T3 | 载荷 `undefined` ⇒ **一次都不碰参数** | 断言 `init.headers` 与传入时同一引用 |
| T4 | 单头写入抛异常 ⇒ **就地吞掉**，其余两头照写 | 造一个 `Headers` 子类让 `set` 抛 `TypeError`（CR/LF 场景） |
| T5 | 三个头全写失败 ⇒ 返回值表示「没伪装上」，**请求照发** | 绝不外抛 —— 这是与旧引擎「失败即抛」相反的取舍方向（§3.5） |
| T6 | `init` 缺席 ⇒ 原样转发，**不代造 init** | `fetch(url)` 形态 |
| T7 | `ensureMasqueradeFetch()` 连调两次 ⇒ **不叠层** | 断言 `globalThis.fetch` 仍是同一个包装函数对象 |
| T8 | 零载荷下包装器只转发 | 断言 `base` 收到的 `(input, init)` 与调用方传入的逐字段相同 |
| T9 | `releaseMasqueradeFetch()` 只还原自己那层 | 先套一层外部包装器，再释放 ⇒ 外部那层存活 |
| T10 | 归一后脏值 ⇒ 当「没有」处理，绝不抛错 | 复用 `normalize*` 的既有用例矩阵（三字段各一份判据） |

### 10.3 载体与配置必测项

| # | 用例 |
|---|---|
| C1 | 三字段全缺席 ⇒ 注入函数返回**同一引用**（`===` 断言），一个字节都没动 |
| C2 | 只配 UA ⇒ 只换 `user-agent`，其它头不动 |
| C3 | 异形键（`user-agent` / `User-Agent` 同时存在）⇒ 清理干净，**不出现重复头** |
| C4 | 只配 masquerade ⇒ 只写 `x-codex-window-id`（**不写** `x-dsh-body-masquerade`，body 已裁撤），UA 不动 |
| C5 | `masquerade` 缺省 ⇒ `forwardOptions` **不挂键**（`'accountHubMasquerade' in result === false`） |
| C6 | `entryKey` 含 masquerade ⇒ 只有预设不同的两条候选**不**被判重 |
| C7 | `autoRouteConfigFacts` 含 masquerade ⇒ 只改预设也会让 facts 变化 |
| C8 | 读路径：`masquerade` 脏值（非对象 / 未知 preset / 空 windowId / 控制字符）⇒ **只丢该字段、条目照留** |
| C9 | 写路径：同上 ⇒ **整条拒绝**并给出中文原因 |
| C10 | 老数据（无 `masquerade` 键）⇒ 读出即「关闭」，无迁移、无 `schemaVersion` 变化 |
| C11 | 既有 16 例（`account-hub-header-overrides.spec.ts`）**一例不改、全绿** |

### 10.4 变异检验（「改动会被抓住」的证明）

沿用本仓既有做法，实现后必须逐条做。**这一节的变异项全部换过**：旧方案的变异围绕
「锚点/原子写入/fence」，新方案的变异围绕**三个最容易改错又不会报错的地方**：

| 变异 | 期望变红 | 为什么这条最要紧 |
|---|---|---|
| ALS 从 `for await` 消费侧**挪到** `ctx.llm.stream()` 创建点 | 接线单测 | 挪过去**不会报任何错**，只是伪装整段静默失效 —— 本设计第一号陷阱（§3.8） |
| `withMasqueradeAsyncIterable` **只包 `next()`**，不包 `return()` / `throw()` | 接线单测 | 提前退出路径上的清理请求会用错身份（§3.8） |
| 缺省路径也调 `ensureMasqueradeFetch()`（「反正零载荷只是纯转发」） | 接线单测 | 违反默认路径零变化红线：`globalThis.fetch` 会与加功能前**不是同一个对象**（§3.7） |
| 身份标记用 `Symbol()` 而非 `Symbol.for(...)` | 安装幂等用例 | 模块被两条路径加载出两份实例时会各装一层 |
| `string[][]` 形态直接 `push` 新对而不清理重复 | T1 / T2 | 上游会看到拼接值 |
| 普通对象形态不删异形键 | T1 | `User-Agent` 与 `user-agent` 并存，同样拼成两个头 |
| 单头写入失败改成 `throw` | T4 / T5 | 把一次配置笔误升级成**请求失败**（与旧引擎的取舍方向恰好相反，§3.5） |
| `init` 缺席时代造一个 `init` 去补头 | T6 | 替调用方改变请求语义，比不伪装更危险 |
| `forwardOptions` 用 `accountHubMasquerade: entry.masquerade`（挂 undefined） | C5 | 挂 `undefined` 会**覆盖**调用方带来的值 |
| `entryKey` 漏加 masquerade | C6 | 只有伪装不同的两条候选被判重、后者静默丢弃 |
| `autoRouteConfigFacts` 漏加 masquerade | C7 | 用户改了伪装，运行时不重建 |
| `normalize*` 里改成抛错而非「当没有」 | T10 | 出站面抛错会毁掉一次对话 |

### 10.5 回归基线

| 项 | 目标 |
|---|---|
| `pnpm test` | **全绿**。各直接相关套件实测例数：`masquerade-transport.spec.ts` **30 例**、`masquerade-transport-wiring.spec.ts` **15 例**、`auto-route-masquerade.spec.ts` **23 例**、`account-hub-header-overrides.spec.ts` **16 例**（一例不改）、`auto-route-adapter.spec.ts` **81 例**。⚠️ 旧的 `masquerade-patch.spec.ts` **59 例已随 §0.1 删除**，故聚合总数**必须重新以 `pnpm test` 的实测输出为准**，不要沿用旧文档记的 3749 |
| `pnpm typecheck` | 绿（`src/` 在视野内） |
| `pnpm build:client` | 绿，**且产物顶层求值冒烟保留**（AGENTS.md 已列为勿删项） |
| `pnpm build:all` | 绿 |

---

## 11. 风险清单

> **旧方案 R1–R5 已整批消失**（随 §0.1 退役）：它们全部以「我们改了宿主磁盘上的文件」
> 为前提 —— 补丁落到源码 checkout（R1）、升级后锚点漂移（R2）、自动维持盲目重写（R3）、
> 与第三方补丁抢锚点竞态（R4）、单边还原后开关与实效不一致（R5）。
> 新方案**不写任何宿主文件**，这五条风险的载体本身不存在，故不再逐条保留。

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| **R1′** | 包装的是**进程级** `globalThis.fetch` ⇒ 装上以后**所有**走 fetch 的出站请求都经过这层（包括别的插件的） | 中 | ① **按需安装**：仅当载荷非 `undefined` 时才装（§3.7）⇒ 默认路径下它压根不存在；② 包装器对非伪装请求**只转发**，`base(input, init)` 原样透传、连 `init` 字段都不读；③ `releaseMasqueradeFetch()` 只还原自己那层（§3.6） |
| **R2′** | ALS 上错位置（加在创建点而非消费侧）⇒ 伪装**整段静默失效**，且**不报任何错** | **高** | 这是本设计最容易改错处（§3.8）。缓解：① 接线单测断言载荷在 `for await` 侧可见（§10.2 T 组）；② API 形态上只暴露 `withMasqueradeAsyncIterable(payload, stream)` 这一个入口，不提供「绑定创建点」的写法 |
| **R3′** | `init.headers` 只读 guard / 单头值非法 ⇒ 写入抛异常 | 低 | 单头异常**就地吞掉**，其余两头照写；一个都没写成功也只是「这次没伪装」，**绝不升级成请求失败**（§3.5）。取舍方向与旧引擎「失败即抛」**相反**，理由见 §3.5 |
| **R4′** | `masquerade.status` 曾报「可用」而实际未伪装，用户以为已生效 | 低 | 面板徽标现在只有一个正向态 `AUTO_ROUTE_MASQUERADE_READY`「出站伪装已就绪」，其依据是「运输层在进程内、RPC 能应答」；**不承诺**上游闸门一定放行（残余风险见 §13 分叉 e） |
| **R5′** | `discoverModels` 的模型列表路径（`dsh-llm-pi-ai/lib/index.js:2308` 的 `attributionHeaders()`）**仍是框架 UA**，未被伪装 | 低 | 4router 的 `/v1/models` **当前只校验 token、无闸门**（实测）；记入文档，不在 v1 处理 |
| **R6′** | qoder CN 走 wasm 签名链 ⇒ 覆写**不生效**（既有已知边界） | 低 | 与本次无关（本设计只针对外部 provider）；但预设下拉若出现在 qoder 候选上会误导 ⇒ 面板可按 provider 置灰（可选） |
| **R7′** | 伪装本身可能违反对方服务条款 / 导致账号风险 | 中 | **用户自担**；面板上给出一次性告知文案 |
| **R8′** | 客户端下拉的模板字符串错误**不在 typecheck 视野内**（`plugin-src/` 不被 `tsconfig.json` include） | 中 | 两道闸：① 渲染级单测（15 个 spec 真渲染，见 §10.1）；② `build:client` 的产物顶层求值冒烟**必须保留**（AGENTS.md 已列为勿删项），它覆盖单测覆盖不到的**打包产物顶层**求值 |
| **R9′** | 预设字面量手抄错（UA 少一个下划线）⇒ 403 且**无任何可归因报错** | **高** | 常量以 masquerade 的 `PRESETS` 为唯一真相源；单测钉住对照断言（§4.3） |
| ~~**R10′**~~ | ~~`x-dsh-body-masquerade` 的动态注入未真机验证~~ | — | **已随 §13 分叉 e 裁撤**：body 伪装整体不做，该头**不发送**，风险不存在 |

---

## 12. 实现后必须真机验证的清单

设计阶段的推理不能替代真机（本仓既有文档反复强调这一点）。以下每条都要在实现后
在真机上跑一次：

| # | 验证项 | 判据 |
|---|---|---|
| V1 | 配了伪装的候选发一次真实请求，DSH 正常完成这一轮 | 无异常；模型正常回字（本方案不改宿主文件，故**没有**「冷启动能否加载」这类验证项 —— 那一条已随 §0.1 消失） |
| V2 | 候选配 `codex` 预设 → 4router 请求 | **HTTP 200**（对照：关闭时 403） |
| V3 | 抓包看三个头**都在**：`User-Agent` = 预设值、`Originator` 存在、`x-codex-window-id` 存在 | 三个头缺任何一个都算未通过；`x-codex-window-id` 的值应与该条 `entry.masquerade.windowId` 一致 |
| V4 | 关闭预设（或未配伪装的候选）→ 出站头与加功能前**逐字节一致** | 抓包对照。这是**默认路径零变化**红线的真机判据（§3.7） |
| V5 | 同一条候选连发多次 → `x-codex-window-id` **每次都相同** | 它取自条目里已存的值，**不在运行时轮换**（§4.4、分叉 c） |
| V6 | 提前中断一次带伪装的流（`break` / 取消），再发一次带伪装的请求 | 两次都能正常出网 ⇒ 证明 `return()` 路径上的载荷没掉（§3.8 那条最容易改错的纪律） |
| V7 | **清空全部条目的伪装配置** → 再发请求 | 出站回到归属 UA；**没有「还原文件」这一步可验证**，因为从未改过任何文件（旧 V7 的哈希比对已随 §0.1 消失） |
| V8 | 与 `shabhui/dsh-client-masquerade` 同时安装 → 双方各自工作 | 本方案的值在对方基线之上覆写（§7.2）；对方还原时本方案不受影响 |
| V9 | 七个 provider 的既有链路无回归 | `pnpm test` 全绿 + 任选一家真机请求 |

---

## 13. 分叉拍板（2026-09-27 需求方已全部裁定）

> 以下分叉已由需求方逐条拍板，本节从「待拍板」转为**决议记录**。倾向列保留原设计论证，
> 「**拍板**」行为最终结论；两者不一致时以拍板为准。

### ★ 分叉 a：v1 的预设清单范围 — **拍板：A1（v1 只做 codex）**

理由：所有字面量必须来自实测（R11），没有第二个实测来源之前，
做第二个预设就是编造（与 `defaultUserAgent`「不编造」原则直接冲突）。

### ★ 分叉 b：预设与既有 `userAgent` / `originator` 手填字段的关系 — **拍板：B1 修订版（填上但不锁只读，手改自动降级为自定义）**

选 `codex` 预设 ⇒ 把预设值**写进** `entry.userAgent` / `entry.originator`（B1 原案），
但两行**保持可编辑**（不置只读）；用户一旦手动修改任一值，
下拉框**自动切换到「自定义」**。预设纯粹是「一键填入官方真值」的宏，
后续身份判断只看 `entry.userAgent` / `entry.originator` 的实际值，不再看预设名。

### ★ 分叉 c：`windowId` 的归属与生命周期 — **拍板：C1（逐条目，随伪装头一起自动生成）**

（原标题含 `deviceId`；随分叉 e 裁撤 body 伪装，`deviceId` 已删除，见 §4.4。）
每条候选首次带伪装头出站时生成、持久化、此后不变。用户界面上**不暴露**任何
生成/管理入口（无感）。（「重新生成设备身份」按钮：不做。）

### ★ 分叉 d：告警形态 — **拍板：D2（日志 + 面板徽标 + 首次失败在会话内插可见提示）**

理由：伪装静默失效后果严重（请求照样发出去、只是身份没伪装上，没有任何可归因报错），
纯日志不够；D3 拦请求代价过高。
（旧文此处引用的「R5 单边还原后开关与实效不一致」已随 §0.1 消失 —— 新方案没有可失效的
磁盘状态。**结论 D2 本身保留**，但徽标收敛为一个正向态，见 §5.2。）

### ★ 分叉 e：body 伪装是否进 v1 — **拍板：E1 修订版（不做，且不做任何检测/引导）**

需求方明确裁定：**本插件功能一律自持，不检测、不引导安装任何第三方插件**。
body 伪装整体不做（E1），同时**不实现** E3 的检测与引导 UI；
`x-dsh-body-masquerade` 开关头**不发送**。已知残余风险（如实记录，不再讨论）：
真机验证通过的是「UA + originator + `x-codex-window-id` + body」四者齐备的形态，
本方案落地的是前三者（头全套）——该组合未实测过，若 4router 闸门仍拒，
说明其校验进入请求体层面，届时再另立方案（届时再议，本设计不预留接口）。

### ★ 分叉 f：还原入口 — **拍板：F4 的结论保留，但理由已换（不做还原按钮）**

**不提供任何手动还原入口**（UI 上没有任何按钮）。旧 F4 的理由是「零配置即自动还原官方
文件」；新方案下**根本没有需要还原的东西** —— 我们从不写宿主文件（§3.1）。用户想让伪装
彻底消失，把所有条目的伪装清掉即可：那时**一个请求都不会装包装器**（载荷全 `undefined`），
出站自然地回到加入本功能之前的状态。四个 F 选项中 F1/F2/F3 的「按钮 + 状态」全部不做。

### 分叉 g：落点的最终选择 — **已随 §0.1 改判：不设落点**

旧拍板 G1 选的是 `dsh-llm-pi-ai/lib/index.js` 调用点 `:1883` 包一层 + EOF 追加注入函数。
该落点**连同整个补丁引擎一并退役**，理由见 §0.1.2（那两条候选路径与宿主实际加载的
`app.asar` 内 rc.2 副本永不相交）。现行落点是 `globalThis.fetch` 包装器（§3.1），
**没有目标文件**，故「锚点是否与 masquerade 重叠」这类问题不再存在（§7.1）。
（分叉 e 已裁定不做 body ⇒ G2/G3 不再相关。）

### 分叉 h：头部运输层 — **拍板：H1 的原结论保留，实现形态已换代**

结论不变：**新载体 `accountHubMasquerade`，不写用户 profile 配置**。理由仍是 H2 要写
`~/.dsh` 下的用户数据（profile `cordis.patch.yml`），越出本仓红线。
实现形态从「宿主文件里的注入函数读该字段」换成「运输层读同源载荷写进 `init.headers`」
（§3.3、§3.9）—— **载体字段仍在天上飞，只是消费点变了**。

### 分叉 i：谁提供 body 补丁 — **已随分叉 e 裁定而不成立（不适用）**

body 伪装整体不做，本分叉消解。

### 分叉 j：低频定时维持 — **已随 §0.1 作废（机制整体不需要）**

旧拍板是「加 5 分钟低频定时自检」，用来兜住「补丁落在 checkout 里、开发者一 rebuild
就没了」。新版**一个宿主文件都不写**，没有「被 rebuild 抹掉」这回事，故**不存在需要
定时自检的对象**，该定时器不实现。安装动作只发生在载荷非 `undefined` 的请求路径上
（§3.7）。

---

## 附录 A：本设计引用的实证清单

| 事实 | 出处 |
|---|---|
| ~~调用点锚点 `\t\t\t\t\theaders: requestHeaders(profile.headers)` 全文唯一命中（1 hit，5 前导 Tab，45 字节）~~ **（历史存档：旧补丁引擎的落点锚点，已随 §0.1 退役 —— 现行方案没有落点，也就没有锚点）** | ~~`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1883`~~ |
| `requestHeaders()` 归属头碰撞语义（9 行函数体）**（仍有效：这正是现行方案要绕开的那个碰撞，见 §3.2）** | 同上 `:1732-1740` |
| `profileOptions()` 白名单（**不含 headers**）**（仍有效：`headers` 到不了 `profileOptions`，故必须另找通道）** | 同上 `:1669-1682` |
| ~~`options` 在调用点已在作用域内~~ **（历史存档：为旧注入函数论证作用域可见性，现无注入函数）** | ~~同上 `:1879-1882`~~ |
| `discoverModels` 的归属头（未伪装路径） | 同上 `:2308` |
| `attributionHeaders()` 实测值 `{ 'user-agent': 'deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)' }` | `@deepseek-ai/dsh-llm/lib/index.js:770-794` |
| `dsh-llm-pi-ai` 是 ESM（`"type":"module"`、`main: lib/index.js`）、`exports` **含** `./package.json` | 该包 `package.json` |
| pi-ai `exports` **不含** `./package.json` ⇒ `require.resolve` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `@earendil-works/pi-ai/package.json` |
| pi-ai `createClient` 的 `Object.assign(headers, optionsHeaders)` | `pi-ai/dist/api/openai-responses.js:197-200` |
| pi-ai `buildParams` 尾部 `Object.assign(params, options.samplingParams)` | 同上 `:272-275` |
| `streamSimple` 把 `options.headers` 透传 | 同上 `:162-174` |
| pi-ai `buildBaseOptions` 透传 `headers` | `pi-ai/dist/api/simple-options.js:10-35` |
| ~~Junction / Symlink 三级链与 `nlink=1`、`fsutil hardlink list` 单路径~~ **（历史存档：那是为「原子替换写回会不会污染 pnpm store」做的实测，随 §0.1 退役 —— 现行方案零文件 IO，「写回」这回事不存在）** | ~~本机实测（旧 §3.7，该节已删）~~ |
| masquerade 的 codex 指纹常量（`revision: 2` / `engineHeader: x-codex-window-id` / `identityInstructions` / `defaults` / 来源版本）（**body 路线已裁撤，仅存档**；本设计只沿用 `engineHeader` 这一项） | `shabhui/dsh-client-masquerade/patches/codex-fingerprint.js` |
| masquerade 的 body 补丁两锚点与目标解析方式（`--target` / 向上找 profile / `REL = node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`）（**body 路线已裁撤，仅存档**） | `…/patches/apply-pi-ai-codex-body-patch.mjs` |
| ~~本机当前**未安装** masquerade、三个 marker **均不在场**~~ **（历史存档：旧「三个 marker」是补丁引擎写在宿主文件里的落点标记，随 §0.1 退役 —— 现行方案不写宿主文件，没有可检测的落点；唯一的 marker 是 `globalThis.fetch` 包装器身上的 `Symbol.for('dsh-account-hub.masquerade-transport.fetch')`，进程内取用，见 §3.6）** | ~~实测（旧 §7.4，该节已删）~~ |
| `autoRoute` 整块是 `Schema.any()`，形状判据唯一真相源在 `src/auto-route.ts` | `src/account-pool.ts:246-258` |
| 九字段与 `persist()` 逐字段枚举 | 同上 `:225-267` |
| `forwardOptions()` 的**三行**注入形态（`accountHubUserAgent` / `accountHubOriginator` / `accountHubMasquerade`，缺省各不挂键） | `src/auto-route-adapter.ts:466-477` |
| `autoRouteConfigFacts()` 的键序纪律与 `null` 占位 | `src/auto-route.ts:150-195` |
| `entryKey()` 含 userAgent / originator / `masquerade.windowId`（三者任一不同的两条候选必须判为不同条目） | 同上 `:551-570` |
| `readEntry()` 「只丢字段、不丢条目」 | 同上 `:394-420` |
| 候选编辑弹窗五行与既有常量 | `plugin-src/client/account-hub.js:2524-2660`、`:2281-2331` |
| `setEntryField` 的逐字段分支（含真机缺陷教训） | 同上 `:2940-2976` |
| 既有 CSS 的 box-sizing / min-width 教训 | `plugin-src/client/account-hub-styles.js:410-441` |
| `autoroute.model-info` 「尽力而为、永不报错、不编造」契约 | `src/account-hub-rpc.ts:3187-3240` |
| 注册时机必须在 `pool.openStorage()` 之后 | `docs/agents/auto-route-runtime.md` §5 |
| `plugin-src/` 不在 **typecheck** 视野（`tsconfig.json` 只 include `src/`），`build:client` 冒烟是**打包产物顶层**求值的唯一防线 | `AGENTS.md` |
| 但 `plugin-src/client/` **有渲染级单测**：15 个 spec 真渲染它（含 `auto-route-panel.spec.ts` 41 例、`qoder-hub-blank-screen` / `account-order-panel` / `account-consumption-panel` 等） | 本仓实测（卡 3 交叉核对） |
| 出站协议值红线 | `AGENTS.md`「LLM Provider 约定」 |
| ~~测试基线 3749 例全绿（3662 基线 + 卡 1 的 59 + 卡 2 的 28）~~ **（历史存档：那个总数含已删除的 `masquerade-patch.spec.ts` 59 例，**不得沿用** —— 现行基线以实测输出为准，见 §10.5）** | ~~本仓实测~~ |

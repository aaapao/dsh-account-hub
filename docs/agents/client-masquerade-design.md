# 外部 provider 客户端伪装 · 设计方案

> **状态**：设计稿（未实现）。
> **范围**：仅设计。本文不含实现代码、不含测试代码；不涉及对 `src/` / `tests/` / `plugin-src/` 的任何改动。
> **证据基线**：`@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.1`、`@earendil-works/pi-ai@0.85.1`、本仓 `dsh-account-hub`（`ACCOUNT_HUB_SCHEMA_VERSION = 6`）。
> 文中所有行号均针对上述版本，升级后必须重新核对（见 §9）。

---

## 0. 一句话

让「自动路由」的某条候选，在**转发到外部 provider**（如 `router-4` / 4router.net）时，
按预设整体伪装成**某个官方客户端**的出站身份（UA + `Originator` + 客户端专属头），
从而通过对方的客户端白名单闸门；实现方式是**对本机已安装的宿主适配器
产物做一处极小、可自动维持、无配置时自动还原的文本补丁**，并在面板里给出一条预设下拉。

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
| G4 | 补丁**可自动维持**：被 `tsc` 重建 / 包升级覆盖后能自愈，且自愈失败时**明确报错**而不是静默失效 | 面板上有状态徽标；日志有 warn |
| G5 | 补丁在**无任何条目配置伪装头**时**自动还原**，还原后文件与打补丁前逐字节一致 | 见 §9.3、§13 分叉 f |
| G6 | 与 `shabhui/dsh-client-masquerade` **互不破坏**（可同时安装、可各自单独还原） | 见 §8 |
| G7 | 锚点不匹配时**绝不写入**（宁可功能不可用，也不产生半截补丁） | 见 §3.5 |

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
│    + accountHubMasquerade?   （★新通道，只带 codex 专属头）          │
└───────────────────────────┬────────────────────────────────────────┘
                            │ ctx.llm.stream() 重入，宿主按 provider 选适配器
┌─ 宿主适配器（dsh-llm-pi-ai，★本设计唯一的补丁落点） ───────────────┐
│  streamWithSnapshot(options, snapshot)                             │
│    headers: requestHeaders(profile.headers)                        │
│         ↓ 补丁改为                                                   │
│    headers: __dshAccountHubApplyMasquerade(                        │
│               requestHeaders(profile.headers), options)            │
│  （被注入的具名函数定义追加在文件末尾，函数声明提升）                  │
└───────────────────────────┬────────────────────────────────────────┘
                            │ pi-ai streamSimple(model, context, options)
┌─ pi-ai（@earendil-works/pi-ai，本设计 v1 不改） ───────────────────┐
│  openai-responses.js: createClient(...)                            │
│    Object.assign(headers, optionsHeaders)   ← 我们注入的头在此合并   │
│  buildParams(...)                           ← 本设计不涉及（body 不做）│
└───────────────────────────┬────────────────────────────────────────┘
                            │ HTTPS
                       4router.net /v1/responses
```

### 2.2 数据流（一次请求，逐跳）

| 跳 | 位置 | 发生什么 |
|---|---|---|
| 1 | DSH 会话 | 用户选中的模型是自动模型 `auto-xxx`（provider = `auto-route`） |
| 2 | `AutoRouteAdapter.stream()` | 取队首条目；`forwardOptions()` 把 `entry.userAgent` / `entry.originator` / `entry.masquerade` 挂成三个 `accountHub*` 载体字段 |
| 3 | 宿主 `ctx.llm.stream()` 重入 | 按 `entry.provider`（如 `router-4`）选中 `PiAiAdapter`；多余字段原样带着走 |
| 4 | `PiAiAdapter.streamWithSnapshot()` | `requestHeaders(profile.headers)` 先算出基线头（**含框架归属 UA**） |
| 5 | ★补丁点 | 被注入的函数读 `options.accountHub*`，在基线头上做三件事：换 `user-agent`、设 `Originator`、设 `x-codex-window-id` |
| 6 | pi-ai `createClient()` | `Object.assign(headers, optionsHeaders)` 把我们算好的头合进 OpenAI 客户端 |
| 7 | pi-ai `buildParams()` | 本设计**不涉及**（body 伪装不做，见 §13 分叉 e） |
| 8 | 出站 | 4router 闸门看到 Codex 形态 ⇒ 放行（若仍拒，见 §13 分叉 e 的残余风险） |

### 2.3 为什么补丁落点是 `dsh-llm-pi-ai/lib/index.js` 而不是 `pi-ai/openai-responses.js`

这是本设计的**核心取舍**（见 §11 分叉 g）。三条事实：

1. **`profile.headers` 走不到 `user-agent`。** `requestHeaders()`（`lib/index.js:1732-1740`）
   先把与 `attributionHeaders()` 键名（大小写不敏感）冲突的项**过滤掉**，再把归属头
   `...attribution` 铺在后面 —— 归属头**赢**。所以往 profile 的 provider 段里写
   `user-agent` 是**无效**的（被静默丢弃），这正是必须打补丁的唯一原因。
   `originator` / `x-codex-window-id` **不在**归属头键名集合里，
   **不需要**补丁就能透传（见 §11 分叉 h）。
   （真机验证通过的是「UA + originator + `x-codex-window-id` + body」四者齐备的形态；
   本设计只做**头三项**，body 不做 —— 如实记录，见 §13 分叉 e。）
2. **改调用点不碰 `requestHeaders` 函数体。** masquerade 的 UA 补丁锚点是
   `requestHeaders` 那 9 行的**整个函数体**（`:1732-1740`）。我们改的是**调用点**
   `:1883`（实测全文**唯一命中**，5 个前导 Tab，45 字节）。两者**零重叠** ⇒ 可共存。
3. **改 pi-ai 会与 masquerade 的 body 补丁撞锚点。** masquerade body 补丁的第一锚点
   就是 `createClient` 里 `Object.assign(headers, optionsHeaders)` 那一段
   （`openai-responses.js:197-200`）。我们把注入点放在 `dsh-llm-pi-ai` 的上游，
   就绕开了这次碰撞。**（分叉 e 已裁定 body 不做，本条仅存档，作为当时不做 G2 的历史理由。）**

**代价**：`dsh-llm-pi-ai` 是 checkout 产物（见 §9.1），补丁会落到源码仓的 `lib/` 里；
一次 `tsc` 重建即抹掉 —— 这既是缺点（需要自动维持），也是优点（还原极其干净）。

---

## 3. 补丁设计

### 3.1 目标文件与解析

| 项 | 值 |
|---|---|
| 包名 | `@deepseek-ai/dsh-llm-pi-ai` |
| 版本基线 | `0.1.7-rc.1` |
| `package.json` 关键字段 | `"type": "module"`、`"main": "lib/index.js"` |
| `exports` | `"."` / `"./src/*"` / **`"./package.json"`（有）** |
| 目标文件 | `<包目录>/lib/index.js` |
| 解析方式 | `require.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json')` → `dirname` → `join('lib/index.js')` |

**pi-ai 侧**（v1 不改，但 §9 的「共存检查」需要知道它在哪）：

| 项 | 值 |
|---|---|
| 包名 | `@earendil-works/pi-ai` |
| 版本基线 | `0.85.1` |
| `exports` | `.` / `./compat` / `./providers/*` / `./api/*` / `./utils/*` / `./oauth` / `./bedrock-provider` / `./bun-oauth` —— **没有 `./package.json`** |
| 后果 | `require.resolve('@earendil-works/pi-ai/package.json')` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| 解析方式 | **不能**用 `require.resolve`。改为从 `dsh-llm-pi-ai` 的目录出发按目录拼接，两条路径依次尝试：① `<profile>/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`；② `<dsh-llm-pi-ai 目录>/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js` |
| 不存在时 | **不是错误**：说明该 profile 没装 pi-ai，伪装功能整体静默不可用（v1 不写 pi-ai，故仅影响共存检查） |

### 3.2 为什么必须打补丁（`requestHeaders` 的归属头碰撞）

`lib/index.js:1732-1740` 的原文语义（逐行）：

| 行 | 内容 | 语义 |
|---|---|---|
| 1733 | `function requestHeaders(headers)` | 入参 = profile 里该 provider 的 `headers` 段 |
| 1734 | `const attribution = attributionHeaders()` | 取框架归属头，实测为 `{ 'user-agent': 'deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)' }` |
| 1735 | `const reserved = new Set(...toLowerCase())` | 归属头键名集合（小写） |
| 1736-1739 | `{ ...过滤掉 reserved 的 profile.headers, ...attribution }` | **归属头赢** |

结论：`user-agent` 是**保留键名**，profile 里写什么都发不出去。这是本设计必须存在
补丁的**唯一**原因（其余三个头都不需要补丁）。

### 3.3 补丁形态（两段，同一文件）

**规格而非实现**，仅表达形态：

```
段 1（调用点改写）—— 锚点 = 唯一命中的那一行
  原：  <5×TAB>headers: requestHeaders(profile.headers)
  新：  <5×TAB>headers: <注入函数名>(requestHeaders(profile.headers), options)

段 2（函数定义注入）—— 追加到文件末尾
  <marker 起> <fence>
  function <注入函数名>(headers, options) { …见 §3.4… }
  <fence> <marker 止>
```

| 设计点 | 取值 | 理由 |
|---|---|---|
| 段 1 锚点 | 精确字面量 `\t\t\t\t\theaders: requestHeaders(profile.headers)` | 实测全文唯一（1 hit），无需正则、无需上下文行 |
| 段 2 落点 | **文件末尾追加** | ① 模块顶层是语句边界，函数声明**提升**，调用点在前也合法；② 追加**不需要锚点匹配**，少一处可能漂移的匹配点；③ 还原 = 从末尾裁掉围栏块，判定简单 |
| 幂等判据 | 文件内是否含 marker 字符串 | 命中即 `alreadyPatched`，不重复写 |
| 围栏 | 起止各一行 marker + 一对 fence 行 | 还原时按 fence 配对裁剪；**不配对 ⇒ 抛错、不写**（见 §3.5） |
| 注入函数是否 import | **零 import**、零外部依赖 | 该文件是 rollup 产物，插入新 import 会破坏打包假设；函数体只用参数与标准库 |
| 变量来源 | `options` 在调用点**已在作用域内** | `:1879-1882` 已经在用 `options.temperature` / `options.maxTokens` / `options.sessionId`，`options` 是 `streamWithSnapshot` 的形参 |

**段 1 为什么是「包一层」而不是「在后面加一行赋值」**：`headers:` 是对象字面量的一个
属性，后面没有语句边界可以插赋值。包一层是**单行、单表达式**的最小改写，且
`requestHeaders(...)` 的原调用原样保留 ⇒ 基线头仍是**原函数**算出来的，
与 masquerade 的 UA 补丁**天然叠加**（它的返回值喂给我们的函数）。

### 3.4 注入函数的语义规格

输入：`headers`（`requestHeaders()` 的返回值，普通对象）+ `options`（`GenerateOptions`）。

| 载体字段（结构性读取） | 动作 | 缺省行为 |
|---|---|---|
| `options.accountHubUserAgent` | 删掉所有 `user-agent` 异形键后写 `headers['User-Agent'] = 值` | 不动（保留归属头，或 masquerade 覆盖后的值） |
| `options.accountHubOriginator` | 删掉所有 `originator` 异形键后写 `headers['Originator'] = 值` | 不动（该头本就不存在） |
| `options.accountHubMasquerade`（★新） | 按枚举字段写 `x-codex-window-id` | 不动 |
| 三者**全部**缺席 | **原对象原样返回**（同一引用） | 出站逐字节一致 |

| 纪律 | 说明 |
|---|---|
| 校验复用既有判据 | `accountHubUserAgent` / `accountHubOriginator` 的合法性判据**只在** `src/account-hub-user-agent.ts` / `src/account-hub-originator.ts` 各一份。注入函数是宿主侧的**裸函数**、无法 import 插件模块，故它只做**最小防御**（非空字符串即用），合法性由**写路径**（`assertValidAutoRouteConfig`）负责 —— 与七个适配器 `send()` 的既有分工一致 |
| 不做「任意头」 | `accountHubMasquerade` 是**命名枚举**对象（`{ windowId }`，body 开关字段已随分叉 e 裁撤），不是 `Record<string,string>`。理由见 §1.3 |
| 异形键清理 | 必须（`User-Agent` vs `user-agent` 会变成两个头、上游看到拼接值），与 `applyAccountHubUserAgent` 既有做法逐字对齐 |
| 不吞异常 | 注入函数不 try/catch。它是纯字符串拼接，抛错即代码缺陷，应暴露 |

### 3.5 失败处置（每一条都是「不写」而非「猜」）

| 情形 | 处置 | 用户可见 |
|---|---|---|
| 目标包不存在（profile 没装 pi-ai 适配器） | 功能**静默不可用**，不报错 | 面板预设下拉置灰 + 提示「当前环境未安装外部 provider 适配器」 |
| 段 1 锚点**零命中** | **抛错、不写** | 面板红色徽标「目标文件版本不匹配（未打补丁）」；日志 warn 带版本号 |
| 段 1 锚点**多次命中** | **抛错、不写**（与零命中同处置） | 同上。多命中说明该行不是唯一调用点，包一层会漏改另一处 |
| marker 在但 fence **不配对** | **抛错、不写**（半截补丁是坏文件） | 同上 + 提示「请先还原再重打」 |
| 文件只读 / 写入 EPERM | **抛错、不写**，保留原文件 | 面板提示权限问题 |
| 写临时文件失败 | 清理临时文件（容忍 ENOENT），**原文件未动** | 同上 |
| 已打过补丁（marker 命中且 fence 配对） | 幂等跳过，**不重写** | 面板绿色徽标「已生效（v<版本>）」 |

**锚点纪律**（沿用 masquerade 的成熟做法）：精确字面量匹配；不匹配 ⇒ `throw`；
**永远不做 trim / 正则 / 模糊匹配**。理由：模糊匹配在版本漂移时会「匹配到一个看起来
差不多的位置」并写入 —— 那是最坏结果（文件被改坏且没人知道）。

### 3.6 原子写入

沿用 `shabhui/dsh-client-masquerade` 的 `writeDetached` 语义（该做法已被其测试套件
钉死，见 §10.4）：

| 步骤 | 动作 | 为什么 |
|---|---|---|
| 1 | 在**同目录**建临时文件 `target + '.dshcm-' + randomUUID() + '.tmp'` | 同目录才能保证 `rename` 是**同卷原子操作** |
| 2 | 打开标志 `'wx'`（独占创建） | 防止撞上残留临时文件而静默覆写 |
| 3 | 权限位**继承原文件** | 保持可执行位/只读位一致 |
| 4 | `renameSync(tmp, target)` | 原子替换；**顺带与 pnpm store 硬链接分离**（见 §3.7） |
| 5 | `finally` 删临时文件，**容忍 ENOENT** | 成功路径下临时文件已被 rename 走，删它会 ENOENT —— 那是正常路径，不是错误 |

**为什么必须是「临时文件 + rename」而不是 `writeFileSync(target)`**：直接写会把
**半截内容**暴露给正在运行的 DSH 进程（`import` 缓存已加载则无妨，但下一次冷启动
可能读到写了一半的文件）；且如果目标是硬链接，直接写会**污染 pnpm store 里的原件**
（影响所有共享该 store 的项目）。

### 3.7 硬链接 / Junction 实测事实（本机）

| 路径 | 类型 | 指向 |
|---|---|---|
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai` | **Junction** | `…\apps\cli\node_modules\@deepseek-ai\dsh-base\node_modules\@deepseek-ai\dsh-llm-pi-ai` |
| 上者（`apps/cli/...`） | **SymbolicLink** | `..\..\..\..\llm\llm-pi-ai`（= `packages/llm/llm-pi-ai`） |
| `packages/llm/llm-pi-ai` | 普通目录（非 reparse point） | — |
| `~/.dsh/profiles/node_modules/@earendil-works/pi-ai` | **Junction** | `…\dsh-llm-pi-ai\node_modules\@earendil-works\pi-ai` |
| 上者 | **SymbolicLink** | `…\node_modules\.pnpm\@earendil-works+pi-ai@0.85._a68c…\node_modules\@earendil-works\pi-ai` |

| 实测项 | 结果 | 含义 |
|---|---|---|
| `lib/index.js` 的 `nlink` | **1** | 不是硬链接副本 |
| `fsutil hardlink list`（profile 路径） | 只列出 `…\packages\llm\llm-pi-ai\lib\index.js` | profile 侧与 checkout 侧是**同一个文件**（经 Junction/Symlink 到达） |
| `openai-responses.js` 的 `nlink` | **1** | 同上 |
| `fsutil hardlink list`（pi-ai 路径） | 只列出 `.pnpm\@earendil-works+pi-ai@0.85._a68c…\…\openai-responses.js` | 同上 |

**由此得出三条设计结论**：

1. 本机形态下，补丁**会落到源码 checkout 的 `packages/llm/llm-pi-ai/lib/index.js`**。
   这必须在文档与面板里**明确告知**（见 §10 风险 R1）。
2. 但设计**不能依赖**这个形态：别的机器上 pnpm 可能用硬链接把 store 里的文件链到
   profile。`临时文件 + rename` 在两种形态下都正确（硬链接形态下它**分离**副本，
   不动 store）。这就是 §3.6 选它的第二个理由。
3. 还原同样是「写回原文 + rename」⇒ 本机形态下 checkout 侧文件一并还原。
   **`tsc` 一次重建**也会还原（这正是「自动维持循环」要处理的场景，见 §3.8）。

### 3.8 自动维持循环

**要解决的场景**（按发生概率排序）：

| # | 场景 | 症状 |
|---|---|---|
| S1 | 在 checkout 里跑了一次 `pnpm build` / `tsc` | 补丁消失，出站头退回归属 UA，4router **403**，而面板上开关还开着 |
| S2 | DSH 升级 / 重装插件，`dsh-llm-pi-ai` 被新版本覆盖 | 同上；且新版本锚点可能已漂移 |
| S3 | 用户在别的工具里改了该文件 | 同上 |
| S4 | 用户手工还原后又想开 | 需要重打 |

**检查点**（全部是「幂等 + 失败即报」）：

| 触发 | 时机 | 为什么 |
|---|---|---|
| ① 插件启动 | `apply()` 里、`pool.openStorage()` **之后**（与 `ensureAutoRouteRegistration` 同一时机） | 存储未就绪时读到的开关状态可能是错的（既有教训，见 `docs/agents/auto-route-runtime.md` §5） |
| ② 面板打开 | 新增 RPC `masquerade.status` 被调用时**顺带**做一次 | 用户唯一会看到状态的地方；面板打开时补一次，代价是一次文件读 |
| ③ 保存配置 | `autoroute.set` 成功后，若该配置里**存在**开启伪装的条目 | 用户刚打开开关，必须立刻生效 |
| ④ 低频定时 | **5 分钟一次**（见 §13 分叉 j） | 覆盖 S1/S3 这类「用户不在面板上」的静默失效 |

**「维持」不等于「盲目重写」**：每次维持都**重新走完整套判据**（marker → fence 配对 →
锚点唯一命中 → 写入）。任一判据不过 ⇒ **报错、不写**。绝不因为「上次打过」就跳过校验。

**与「还原」的关系**（§13 分叉 f，F4 已定案）：**没有任何条目配置伪装头 ⇒ 补丁不打；
打了的自动还原**。故维持循环与还原**不冲突** —— 二者是同一个判据的两面：维持循环每次
先算「有无任何条目配伪装头」，有则按完整判据链打/校验，无则执行 §9.3 的还原四步。
不存在「用户点了还原、定时器又打回去」的矛盾，因为**根本没有手动还原入口**（UI 上无按钮）。

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
| 内存 | 同上；功能可用但**补丁维持循环仍在**（它不依赖存储） |

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
| 状态徽标 | 行内一个徽标：`已生效` / `未打补丁` / `版本不匹配` / `环境不支持` | 数据来自新 RPC `masquerade.status`（见 §5.3） |
| 还原入口 | **无**。不提供任何手动还原入口（UI 上没有任何按钮） | 见 §13 分叉 f：清空全部条目伪装头即自动还原 |

**预设是「一键填入官方真值」的宏**（§13 分叉 b）：预设名**不持久化**，出站身份只看
`entry.userAgent` / `entry.originator` 两格的实际值，不看预设名。`windowId` 随伪装头
自动生成、逐条目持久化，界面**不暴露**任何生成/管理入口（§13 分叉 c，无感）。

### 5.3 需要的新 RPC

| RPC | 入参 | 出参 | 纪律 |
|---|---|---|---|
| `masquerade.status` | 无 | `{ available: boolean, applied: boolean, reason?: string, targetVersion?: string }` | **尽力而为、永不抛错**（与 `autoroute.model-info` 同款：查不到就回 `{available:false, reason:'…'}`，报错会让面板显示成「加载失败」而误导） |
| `masquerade.apply` | 无 | 同上 | 幂等；失败**要**报错。**内部**调用，不对应任何 UI 按钮（维持循环按「有无条目配伪装头」自动调用） |
| ~~`masquerade.revert`~~ | — | — | **不提供**（§13 分叉 f：无手动还原入口）。还原由维持循环在「无任何条目配伪装头」时**自动**执行 |

⚠️ **客户端有渲染级单测，`build:client` 冒烟是另一道防线**（订正：原稿称「唯一防线」，
与事实不符 —— 既有 **15 个** spec 真渲染 `plugin-src/client/`，见 §10.1）。`plugin-src/`
**不在** typecheck 视野内（见 `AGENTS.md`），故新增下拉的**模板字符串求值类错误**由
两道闸共同兜住：① 渲染级单测真的把组件渲染出来，能抓住运行期求值错误；② `build:client`
末尾的产物顶层求值冒烟抓**打包产物顶层**求值错误（单测走的是源码改写版、不覆盖这一层）。
那道闸**不得删除、不得跳过**。

### 5.4 常量（与既有风格对齐）

| 常量 | 草案值 | 对齐对象 |
|---|---|---|
| `AUTO_ROUTE_MASQUERADE_PLACEHOLDER` | `默认关闭（不伪装）` | `AUTO_ROUTE_ORIGINATOR_PLACEHOLDER`（固定一句、不现算） |
| `AUTO_ROUTE_MASQUERADE_APPLIED` | `已生效` | — |
| `AUTO_ROUTE_MASQUERADE_NOT_PATCHED` | `未打补丁` | — |
| `AUTO_ROUTE_MASQUERADE_VERSION_MISMATCH` | `目标文件版本不匹配` | — |
| `AUTO_ROUTE_MASQUERADE_UNAVAILABLE` | `当前环境未安装外部 provider 适配器` | `AUTO_ROUTE_UA_UNKNOWN_PLACEHOLDER`（宁可明说「不知道」，不给与真相相反的结论） |

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
| Z3 | 注入函数在三字段全缺席时**原对象原样返回** | 出站头逐字节一致 |
| Z4 | `accountHubUserAgent` / `accountHubOriginator` 的既有语义**不变** | `tests/unit/account-hub-header-overrides.spec.ts`（16 例）**全绿**，一例不改 |
| Z5 | 自动路由的转发语义（档位 / 消息重写 / 降级 / 重试策略）**不变** | `tests/unit/auto-route-adapter.spec.ts`（76 例）**全绿** |
| Z6 | 九个存储字段与 `ACCOUNT_HUB_SCHEMA_VERSION` **不变** | `docs/agents/account-hub-storage.md` 无需改 |
| Z7 | 未开启自动路由、或候选未配伪装时，**补丁存在与否都不影响出站** | 补丁只包了一层调用，三字段缺席即原样返回 |

### 6.2 唯一「有影响」的地方（必须显式承认）

| 影响 | 说明 |
|---|---|
| 补丁改的是**宿主适配器产物文件** | 这是本设计**唯一**越出插件边界的动作。它不影响七家的行为（`router-4` 等外部 provider 走的是 `dsh-llm-pi-ai`，与本插件七家适配器是**不同**的 provider），但确实改了磁盘上不属于本插件的文件 |
| 该文件是 checkout 产物 | 见 §9.1 与风险 R1 |

**为什么这不违反「红线」**：AGENTS.md 的红线是「**出站协议值**不随 provider id /
显示名变化」—— 它管的是「改名不能改出站身份」。本设计改的是**用户显式开启的、
逐候选的伪装**，且**默认关闭时零变化**；改名的路径完全不经过这里。两者不冲突。

---

## 7. 与 `masquerade` 共存矩阵

### 7.1 双方补丁的锚点对照

| 工具 | 目标文件 | 锚点 | 重叠？ |
|---|---|---|---|
| masquerade · UA 补丁 | `dsh-llm-pi-ai/lib/index.js` | `requestHeaders()` **整个函数体**（`:1732-1740`，9 行） | **否** |
| masquerade · body 补丁（**历史参考**） | `pi-ai/dist/api/openai-responses.js` | ① `createClient` 的 `Object.assign(headers, optionsHeaders)` 段（`:197-200`）；② `buildParams` 尾部 `Object.assign(params, options.samplingParams)` 段（`:272-275`） | **否**（本设计不碰 pi-ai，§13 分叉 e/g；body 路线已裁撤，此行仅存档） |
| **本设计** · 调用点补丁 | `dsh-llm-pi-ai/lib/index.js` | 调用点 `:1883`（唯一命中）+ **文件末尾追加** | **否** |

**关键**：我们的注入点是「`requestHeaders(...)` 的**外面一层**」，masquerade 改的是
「`requestHeaders` 的**里面**」。两者是**嵌套**关系，不是竞争关系。

### 7.2 组合矩阵（body 裁撤后已退化）

body 伪装整体不做（§13 分叉 e），故原「UA 补丁 × body 补丁 × 本设计」三维矩阵**退化
为仅 UA 补丁一层**。剩下的组合只有四种：

| # | masquerade UA 补丁 | 本设计补丁 | 候选配了伪装 | 结果 |
|---|---|---|---|---|
| 1 | 无 | 无 | 否 | 现状。归属 UA，无 `Originator`，无 codex 头 |
| 2 | 无 | 有 | 否 | **与 #1 逐字节相同**（Z3 承诺） |
| 3 | 无 | 有 | 是 | UA 换成预设值（我们的函数**赢**）、`Originator` / `x-codex-window-id` 就位；body 无指纹 ⇒ 闸门**可能仍拒**（残余风险见 §13 分叉 e，本文不展开） |
| 4 | 有 | 有 | 是 | 我们的函数在 masquerade 的头**之上**覆写 ⇒ 预设值赢；其余 codex 头就位 |
| 5 | 有 | 有 | 否（或条目 UA 为空） | 我们的函数原样返回 / 只补 windowId ⇒ 保留 masquerade 的 codex UA |

**结论不变**：凡两方都写 `user-agent` 时，**我们的函数赢**（它在 masquerade 的返回值
之上再覆写）。masquerade 若在场，只影响它自己那一层 UA 的基线值，与我们的头注入
（`Originator` / `x-codex-window-id`）**正交** —— 不构成「双开才有效」的引导，
本设计**单独安装即可工作**。

### 7.3 还原/卸载的单边场景

| 场景 | 结果 | 说明 |
|---|---|---|
| masquerade 还原（UA），本设计仍在 | **不崩**。`requestHeaders` 回原版（归属 UA）；我们的函数仍在上层跑 ⇒ 若条目配了 UA，**伪装照旧生效**；若没配，UA 退回归属头 ⇒ 闸门拒 | 这是**最需要写进文档**的一条：单边还原后「开关还开着但 UA 没了」 |
| 本设计自动还原，masquerade 仍在 | 不崩。masquerade 的 UA 补丁**完全不受影响**（锚点不重叠）；我们注入的头（`Originator` / `x-codex-window-id`）**不再发出** | masquerade 的 revert 只替换它自己的定界区域，我们的 EOF 块与调用点改写**存活**（反向亦然） |
| 双方同时还原 | 文件回到 stock | 顺序无关（各自只动自己的区域） |
| 双方同时**自动维持** | ⚠️ **竞态风险**：两个工具都会「读文件 → 字符串替换 → 临时文件 + rename」。若同时发生，后写者覆盖先写者 | 见风险 R4；缓解：我们的维持循环**先检测对方 marker**，在场则只校验自己的段、不整文件重写 |

### 7.4 检测对方是否在场

masquerade 的 marker 形态（用于我们的共存检查，**只读不写**）：

| marker | 含义 |
|---|---|
| `dsh-client-masquerade` | 其补丁的通用标记 |
| `applyDshCodexMasquerade` | 其 UA 补丁注入的函数名 |
| `x-dsh-body-masquerade` | body 补丁的开关头名（**body 路线已裁撤，仅存档**；本设计不发送该头） |

⚠️ **本机实测：三个 marker 当前全部不在场**（`dsh-llm-pi-ai/lib/index.js` 与
`pi-ai/openai-responses.js` 均为 stock），且 `~/.dsh` 下**没有**安装 masquerade 插件。
故共存矩阵是**推演**而非实测 —— 这条要写进 §12 的「实现后必须真机验证」清单。

---

## 8. （并入 §7）

---

## 9. 升级漂移与还原

### 9.1 漂移来源

| # | 来源 | 概率 | 补丁命运 | 自动维持能否救 |
|---|---|---|---|---|
| D1 | checkout 里跑 `tsc` / `pnpm build` | **高**（本机补丁就落在 checkout 里） | 被覆盖 | 能（S1） |
| D2 | `dsh-llm-pi-ai` 升级（版本号变化） | 中 | 被覆盖，且**锚点可能漂移** | 能救「覆盖」，**救不了**「锚点漂移」⇒ 报错 |
| D3 | 插件重装（`pnpm install`） | 中 | 同 D2 | 同上 |
| D4 | pi-ai 升级（`0.85.1` → 新版） | 中 | 我们的补丁**不受影响**（本设计不碰 pi-ai，不依赖 body 补丁） | **不适用**（本设计不依赖 body 补丁；原「masquerade body 补丁锚点漂移」的关切已随 §13 分叉 e 裁撤，仅存档） |
| D5 | 用户手工编辑该文件 | 低 | 可能破坏 fence 配对 | 检测到 ⇒ 报错、不写 |

### 9.2 版本记账

补丁块内应记录**打补丁时目标的版本号**（从 `package.json` 读，实测 `0.1.7-rc.1`）。
维持循环每次检查时：

| 判据 | 处置 |
|---|---|
| 版本号相同 + marker 在 + 锚点唯一命中 | 已生效，跳过 |
| 版本号相同 + marker 不在 | 重打 |
| 版本号**不同** | 先按新版本重新校验锚点：唯一命中 ⇒ 重打并更新版本记账；否则 ⇒ 报错、不写 |
| marker 在但版本记账缺失 | 视为「未知版本」⇒ 走「重新校验锚点」分支 |

### 9.3 还原（G5）

| 步骤 | 动作 | 失败处置 |
|---|---|---|
| 1 | 读文件，找 fence 起止 | 不配对 ⇒ **抛错、不写** |
| 2 | 裁掉 fence 块（含 marker 行） | — |
| 3 | 把段 1 的调用点字面量改回 `headers: requestHeaders(profile.headers)` | 找不到注入后的字面量 ⇒ **抛错、不写**（可能被别的工具改过） |
| 4 | 临时文件 + rename 写回 | 同 §3.5 |

**还原后必须逐字节等于打补丁前**：这条应由单测钉住（见 §10.2）。

**还原触发条件**（§13 分叉 f，F4）：**没有任何条目配置伪装头 ⇒ 补丁不打；打了的自动还原**。
这是唯一触发路径 —— **不提供任何手动还原入口**，UI 上也没有按钮。

| 入口 | 形态 | 备注 |
|---|---|---|
| 零配置自动还原 | 维持循环检测到「无任何条目配伪装头」时**自动**执行本节的四步 | 用户想让伪装彻底消失，把所有条目的伪装清掉即可 |
| ~~面板按钮~~ | **不做**（§13 分叉 f） | 原 F1/F2/F3 的「按钮 + 状态」方案全部裁撤 |
| 插件卸载 | **不做**（插件卸载时可能已经没有 `ctx`，写文件不可靠） | 明确写进文档，避免用户以为卸载会自动还原 |

---

## 10. 测试策略

> 本节只描述**测试策略**，不写测试代码。

### 10.1 分层

| 层 | 落点 | 内容 |
|---|---|---|
| 补丁引擎单测 | 新增 `tests/unit/client-masquerade-patch.spec.ts` | 纯文件 IO，用 `os.tmpdir()` 造临时目录，**不触网、不碰真机文件** |
| 载体通道单测 | 扩既有 `tests/unit/account-hub-header-overrides.spec.ts`（16 例） | 表驱动，覆盖新字段的结构读取与「零变化」 |
| 转发注入单测 | 扩既有 `tests/unit/auto-route-adapter.spec.ts`（`:1472-1588` 一带） | 断言 `forwardOptions` 三字段的挂键/不挂键 |
| 配置层单测 | 扩 `tests/unit/auto-route.spec.ts`（若有） | `entryKey` / `autoRouteConfigFacts` / 读写路径 |
| 客户端 | 既有 **15 个** spec 真渲染 `plugin-src/client/`（含 `tests/unit/auto-route-panel.spec.ts` 41 例专测 `AutoRoutePanel`，以及 `qoder-hub-blank-screen` / `account-order-panel` / `account-consumption-panel` 等） | 下拉的选项 / 联动 / 徽标由**渲染级单测**覆盖；`build:client` 的产物顶层求值冒烟是**另一道**防线（专拦模板字符串求值类错误），**不是唯一防线** |
| 端到端 | **人工**，不进 CI | 真机打 4router 请求，看 200 |

### 10.2 补丁引擎必测项

沿用 masquerade `test/patch-hardlinks.test.js`（8770 字节）的成熟技术：

| # | 用例 | 技术要点 |
|---|---|---|
| P1 | 锚点唯一命中 ⇒ 写入成功，两段都在 | — |
| P2 | 锚点零命中 ⇒ **抛错且文件未被修改** | 断言 `readFileSync` 前后逐字节相同 |
| P3 | 锚点多次命中 ⇒ 抛错且不写 | 造一份把该行复制两份的夹具 |
| P4 | 幂等：连打两次，第二次 `alreadyPatched`，文件不变 | — |
| P5 | 还原后**逐字节等于原文** | 与 P1 的原始夹具比对 |
| P6 | fence 不配对 ⇒ 还原抛错且不写 | 手工删掉一个 fence 行 |
| P7 | **硬链接分离**：用 `linkSync` 造 nlink=2，打补丁后断言「另一个链接指向的文件内容不变」 | masquerade 的核心技术；**必须**有，否则 pnpm store 会被污染 |
| P8 | 临时文件在成功/失败路径后都不残留 | 断言目录里只剩目标文件 |
| P9 | 只读文件 ⇒ 抛错、原文件完好 | Windows 下用 `attrib +R` 或 ACL |
| P10 | 文件不存在 ⇒ 抛错（**不是**静默创建） | — |
| P11 | marker 在但版本记账缺失 ⇒ 走重新校验分支 | — |
| P12 | 还原时调用点字面量已被第三方改过 ⇒ 抛错不写 | — |

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

沿用 masquerade 与本仓既有做法，实现后必须逐条做：

| 变异 | 期望变红 |
|---|---|
| 锚点匹配改成 `includes` / `trim` | P2 / P3 |
| 去掉 `rename` 改用 `writeFileSync` | P7 |
| 还原时不校验 fence 配对 | P6 |
| 幂等判据改成「总是写」 | P4 |
| `forwardOptions` 用 `accountHubMasquerade: entry.masquerade`（挂 undefined） | C5 |
| `entryKey` 漏加 masquerade | C6 |
| `autoRouteConfigFacts` 漏加 masquerade | C7 |
| 注入函数在缺省时返回新对象而非原引用 | C1 |
| 异形键清理去掉 | C3 |

### 10.5 回归基线

| 项 | 目标 |
|---|---|
| `pnpm test` | **3749 例全绿**（= 3662 基线 + 卡 1 的 `masquerade-patch.spec.ts` 59 例 + 卡 2 的 `auto-route-masquerade.spec.ts` 28 例；卡 3 未加新用例。含 16 例 `account-hub-header-overrides.spec.ts` + 81 例 `auto-route-adapter.spec.ts` 两个直接相关套件） |
| `pnpm typecheck` | 绿 |
| `pnpm build:client` | 绿，**且产物顶层求值冒烟保留** |
| `pnpm build:all` | 绿 |

---

## 11. 风险清单

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| **R1** | 补丁落到**源码 checkout**（`packages/llm/llm-pi-ai/lib/index.js`），污染开发者的工作树；`git status` 会脏 | 中 | ① 面板与文档**明确告知**；② 该文件在 `lib/`（gitignore 产物），不进版本控制；③ **零配置自动还原**（清空全部条目伪装头，见 §13 分叉 f）；④ `tsc` 重建即还原 |
| **R2** | 升级后锚点漂移 ⇒ 自动维持**报错**而非自愈，用户看到红色徽标但不懂 | 中 | 徽标文案给出**可执行的下一步**（「请升级 dsh-account-hub 到支持该版本的最新版」），并在日志里打印实测到的版本号 |
| **R3** | 自动维持**盲目重写**导致把已漂移的文件改坏 | **高** | 每次维持都走完整判据链，任一不过即**不写**（§3.5） |
| **R4** | 与 masquerade 的自动维持**竞态**（同时读改写） | 中 | 维持前检测对方 marker；在场则只校验自己的段、不整文件重写 |
| **R5** | 单边还原后「开关还开着但伪装已失效」，用户无感 | **高** | 面板徽标**必须**反映「本方补丁在场」与「依赖的对方补丁在场」两个独立状态，任一缺失即黄色告警 |
| ~~**R6**~~ | ~~`x-dsh-body-masquerade` 的**动态注入**未真机验证~~ | — | **已随 §13 分叉 e 裁撤**：body 伪装整体不做，该头**不发送**，风险不存在。原条目仅存档 |
| **R7** | `discoverModels` 的模型列表路径（`dsh-llm-pi-ai/lib/index.js:2308` 的 `attributionHeaders()`）**仍是框架 UA**，未被伪装 | 低 | 4router 的 `/v1/models` **当前只校验 token、无闸门**（实测）；记入文档，不在 v1 处理 |
| **R8** | qoder CN 走 wasm 签名链 ⇒ 覆写**不生效**（既有已知边界） | 低 | 与本次无关（本设计只针对外部 provider）；但预设下拉若出现在 qoder 候选上会误导 ⇒ 面板可按 provider 置灰（可选） |
| **R9** | 伪装本身可能违反对方服务条款 / 导致账号风险 | 中 | **用户自担**；面板上给出一次性告知文案 |
| **R10** | 客户端新增下拉的模板字符串错误**不在 typecheck 视野内**（`plugin-src/` 不被 `tsconfig.json` include） | 中 | 两道闸：① 渲染级单测（15 个 spec 真渲染，见 §10.1）；② `build:client` 的产物顶层求值冒烟**必须保留**（AGENTS.md 已列为勿删项），它覆盖单测覆盖不到的**打包产物顶层**求值 |
| **R11** | 预设字面量手抄错（UA 少一个下划线）⇒ 403 且**无任何可归因报错** | **高** | 常量以 masquerade 为唯一真相源；单测钉住对照断言（§4.3） |

---

## 12. 实现后必须真机验证的清单

设计阶段的推理不能替代真机（本仓既有文档反复强调这一点）。以下每条都要在实现后
在真机上跑一次：

| # | 验证项 | 判据 |
|---|---|---|
| V1 | 打补丁后 DSH 冷启动，`dsh-llm-pi-ai` 正常加载 | 无 `SyntaxError`；模型目录正常 |
| V2 | 候选配 `codex` 预设 → 4router 请求 | **HTTP 200**（对照：关闭时 403） |
| ~~V3~~ | ~~`x-dsh-body-masquerade` 的动态注入真的被 body 补丁读到~~ | **已随 §13 分叉 e 裁撤**：body 伪装不做、该头不发送，验证对象不存在 |
| V4 | 关闭预设 → 出站头与加功能前**逐字节一致** | 抓包对照 |
| V5 | 未配伪装的候选 → 出站头不受补丁存在与否影响 | 抓包对照（打补丁 / 还原两态） |
| V6 | 在 checkout 跑一次 `tsc` → 面板徽标变红 → 自动维持自愈 | 徽标颜色与文件 marker 状态一致 |
| V7 | **清空全部条目的伪装头** → 维持循环**自动还原** → 文件与打补丁前逐字节一致 | 哈希比对（触发方式是清空条目，**不是**点按钮 —— §13 分叉 f） |
| V8 | 与 masquerade 同时安装 → 双方各自单独还原，另一方不受影响 | 四种组合各跑一次（组合数已随 body 裁撤减少，见 §7.2） |
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

理由：R5（伪装静默失效）严重度高，纯日志不够；D3 拦请求代价过高。

### ★ 分叉 e：body 伪装是否进 v1 — **拍板：E1 修订版（不做，且不做任何检测/引导）**

需求方明确裁定：**本插件功能一律自持，不检测、不引导安装任何第三方插件**。
body 伪装整体不做（E1），同时**不实现** E3 的检测与引导 UI；
`x-dsh-body-masquerade` 开关头**不发送**。已知残余风险（如实记录，不再讨论）：
真机验证通过的是「UA + originator + `x-codex-window-id` + body」四者齐备的形态，
本方案落地的是前三者（头全套）——该组合未实测过，若 4router 闸门仍拒，
说明其校验进入请求体层面，届时再另立方案（届时再议，本设计不预留接口）。

### ★ 分叉 f：还原入口与「无开关自动维持」的冲突 — **拍板：F4（不做还原按钮，零配置即还原）**

不提供任何手动还原入口。维持逻辑：**没有任何条目配置伪装头 ⇒ 补丁不打；
打了的自动还原**。用户想让伪装彻底消失，把所有条目的伪装清掉即可，
插件随即自动还原官方文件。四个 F 选项中 F1/F2/F3 的「按钮 + 状态」全部不做。

### 分叉 g：补丁落点的最终选择 — **拍板：G1（`dsh-llm-pi-ai` 调用点，v1）**

`dsh-llm-pi-ai/lib/index.js` 调用点 `:1883` 包一层 + EOF 追加注入函数。
与 masquerade 的 UA 补丁（`:1732-1740` 函数体）零重叠、可共存。
（分叉 e 已裁定不做 body ⇒ G2/G3 不再相关。）

### 分叉 h：头部运输层 — **拍板：H1（新载体 `accountHubMasquerade`，不写用户 profile 配置）**

理由：H2 要写 `~/.dsh` 下的用户数据（profile `cordis.patch.yml`），越出本仓红线；
H1 只改包文件、走插件内部协议通道。

### 分叉 i：谁提供 body 补丁 — **已随分叉 e 裁定而不成立（不适用）**

body 伪装整体不做，本分叉消解。

### 分叉 j：低频定时维持 — **拍板：J2（加 5 分钟低频定时维持）**

三个触发点（启动 / 面板打开 / 保存配置）之外，再加 5 分钟定时自检。
S1 在本机是高概率事件（补丁落在 checkout 里，开发者一 rebuild 就没了）。

---

## 附录 A：本设计引用的实证清单

| 事实 | 出处 |
|---|---|
| 调用点锚点 `\t\t\t\t\theaders: requestHeaders(profile.headers)` 全文唯一命中（1 hit，5 前导 Tab，45 字节） | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1883` |
| `requestHeaders()` 归属头碰撞语义（9 行函数体） | 同上 `:1732-1740` |
| `profileOptions()` 白名单（**不含 headers**） | 同上 `:1669-1682` |
| `options` 在调用点已在作用域内 | 同上 `:1879-1882` |
| `discoverModels` 的归属头（未伪装路径） | 同上 `:2308` |
| `attributionHeaders()` 实测值 `{ 'user-agent': 'deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)' }` | `@deepseek-ai/dsh-llm/lib/index.js:770-794` |
| `dsh-llm-pi-ai` 是 ESM（`"type":"module"`、`main: lib/index.js`）、`exports` **含** `./package.json` | 该包 `package.json` |
| pi-ai `exports` **不含** `./package.json` ⇒ `require.resolve` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `@earendil-works/pi-ai/package.json` |
| pi-ai `createClient` 的 `Object.assign(headers, optionsHeaders)` | `pi-ai/dist/api/openai-responses.js:197-200` |
| pi-ai `buildParams` 尾部 `Object.assign(params, options.samplingParams)` | 同上 `:272-275` |
| `streamSimple` 把 `options.headers` 透传 | 同上 `:162-174` |
| pi-ai `buildBaseOptions` 透传 `headers` | `pi-ai/dist/api/simple-options.js:10-35` |
| Junction / Symlink 三级链与 `nlink=1`、`fsutil hardlink list` 单路径 | 本机实测（§3.7） |
| masquerade 的 codex 指纹常量（`revision: 2` / `engineHeader: x-codex-window-id` / `identityInstructions` / `defaults` / 来源版本）（**body 路线已裁撤，仅存档**；本设计只沿用 `engineHeader` 这一项） | `shabhui/dsh-client-masquerade/patches/codex-fingerprint.js` |
| masquerade 的 body 补丁两锚点与目标解析方式（`--target` / 向上找 profile / `REL = node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`）（**body 路线已裁撤，仅存档**） | `…/patches/apply-pi-ai-codex-body-patch.mjs` |
| 本机当前**未安装** masquerade、三个 marker **均不在场** | 实测（§7.4） |
| `autoRoute` 整块是 `Schema.any()`，形状判据唯一真相源在 `src/auto-route.ts` | `src/account-pool.ts:246-258` |
| 九字段与 `persist()` 逐字段枚举 | 同上 `:225-267` |
| `forwardOptions()` 的两行注入形态 | `src/auto-route-adapter.ts:401-411` |
| `autoRouteConfigFacts()` 的键序纪律与 `null` 占位 | `src/auto-route.ts:150-195` |
| `entryKey()` 含 userAgent / originator | 同上 `:436-438` |
| `readEntry()` 「只丢字段、不丢条目」 | 同上 `:394-420` |
| 候选编辑弹窗五行与既有常量 | `plugin-src/client/account-hub.js:2524-2660`、`:2281-2331` |
| `setEntryField` 的逐字段分支（含真机缺陷教训） | 同上 `:2940-2976` |
| 既有 CSS 的 box-sizing / min-width 教训 | `plugin-src/client/account-hub-styles.js:410-441` |
| `autoroute.model-info` 「尽力而为、永不报错、不编造」契约 | `src/account-hub-rpc.ts:3187-3240` |
| 注册时机必须在 `pool.openStorage()` 之后 | `docs/agents/auto-route-runtime.md` §5 |
| `plugin-src/` 不在 **typecheck** 视野（`tsconfig.json` 只 include `src/`），`build:client` 冒烟是**打包产物顶层**求值的唯一防线 | `AGENTS.md` |
| 但 `plugin-src/client/` **有渲染级单测**：15 个 spec 真渲染它（含 `auto-route-panel.spec.ts` 41 例、`qoder-hub-blank-screen` / `account-order-panel` / `account-consumption-panel` 等） | 本仓实测（卡 3 交叉核对） |
| 出站协议值红线 | `AGENTS.md`「LLM Provider 约定」 |
| 测试基线 3749 例全绿（3662 基线 + 卡 1 的 59 + 卡 2 的 28） | 本仓实测 |

# dsh-account-hub 自动模型 Reasoning 与候选级伪装实施计划

## 目标与计划依据

**目标**：自动模型的能力元数据随当前队首候选变化，暴露该候选目标 provider/model 的 reasoning 支持列表与有效 defaultEffort；`entry.effort` 继续作为请求使用的候选档位和唯一编辑入口。重定义现有 agent/request guard 的历史残留清理，避免把当前聚合 reasoning 下仍有效的值误删。客户端伪装继续限于当前候选；关闭时清掉该候选实际伪装字段，并保证后续无载荷请求不写伪装头。

**批准来源/范围锁定**：以用户已批准且已收敛的功能边界为规范；所有者与测试范围限于本计划所列文件。宿主 checkout 当前不可用，因此不把任何宿主私有实现或未公开事件写成事实。

**架构与技术栈**：复用既有自动路由聚合适配器、账号池/RPC、provider/model resolver、agent/request guard 和候选级 transport；不增加 auto-model 自有的 reasoning 持久化/配置字段，不增新的能力所有者或 fallback。宿主侧 TypeScript、客户端 `plugin-src` 由 esbuild 构建，单测使用 Vitest。

**Aegis 可见性**：本变更跨越公开模型元数据、候选持久数据、请求 guard 与客户端传输，实施计划用于锁住唯一事实来源和清理边界。

## 目标 / 非目标

- **目标**：对当前队首候选解析其目标 provider/model 的 `resolveModelInfo().reasoning` 并暴露支持列表，defaultEffort 采用该候选有效的 `entry.effort`，否则遵循 resolver 提供的 defaultEffort；实际请求仍以当前候选 `entry.effort` 为准。无 reasoning 能力时不推测、伪造或跨 provider 继承能力。
- **目标**：保留现有候选编辑器作为修改 `entry.effort` 的唯一入口；候选变化后重新基于新队首生成自动模型能力元数据。
- **目标**：只在可以识别为旧 guard 历史残留且不再是当前聚合语义有效值时清理；无法安全区分时不做宽泛清除。
- **目标**：关闭伪装只清当前候选实际字段，不扩至 provider 全局；无载荷请求不得写入伪装头。
- **非目标**：不添加自动模型层 reasoning 持久化；不实现宿主弹窗 reasoning 改动回写插件（无公开变更事件）；不猜测或调用宿主私有 API；不覆盖直调绕过 agent/request 的路径（未知、非目标）；不删外部旧补丁文件；不引入全局伪装逻辑；不改其他 provider 协议或出站标识。

## Requirement Ready Check

- **场景**：队首账号/候选切换；候选 effort 有效、缺失或不受目标模型支持；目标模型无 reasoning；历史 guard 数据仍有效或确为陈旧；用户关闭当前候选伪装；之后发出无载荷请求。
- **验收证据**：定向单测验证元数据随队首变、defaultEffort 和 `entry.effort` 边界、有效值保留/确定陈旧值清理、当前候选字段关闭后清空、无载荷请求无伪装头；再通过 typecheck 与 client build。
- **宿主弹窗边界**：插件侧只验收通过既有公开模型元数据契约暴露当前队首能力；宿主 checkout 不可用，不能宣称验证了宿主 UI 私有逻辑。也不实现反向同步。

## Change Necessity

仅改文档或配置不能让自动模型在队首候选改变时，从目标 provider/model 的 resolver 动态取得并暴露 reasoning 元数据；也不能修正现有 guard 对聚合 reasoning 有效值的误清理，或保证“关闭”实际清除候选字段并影响随后 transport 行为。因此确需代码改动，最小边界是现有 adapter/route/注册链、账号池/RPC/候选编辑器与候选级 transport，以及列出的定向测试；不需要新 owner、新 schema 或新增持久字段。

## Ripple Signal

- **规范所有者**：目标 provider/model resolver 的 `resolveModelInfo().reasoning` 是能力支持列表和 resolver defaultEffort 的唯一来源；账号池当前队首 `entry.effort` 是所选候选档位的事实来源；不在自动模型再造一份能力或持久化状态。
- **受影响消费者**：自动模型公开模型元数据的宿主消费方、现有候选编辑器、agent/request guard、伪装 transport/RPC。队首切换会影响公开 reasoning 列表/defaultEffort，guard 对历史值的清理判据也随聚合语义变化。
- **契约/兼容风险**：仅通过已有公开模型信息契约暴露字段；没有可用的宿主弹窗变更事件，不增加反向回写或私有 API 依赖。缺少 resolver 能力时不添加全局默认或额外 fallback。关闭操作限定单个当前候选字段；外部旧补丁文件保留。
- **停止条件**：若不能从现有状态/guard 逻辑安全区分“陈旧残留”和“有效值”，先停止清理范围并回到需求/设计，不得无条件删除；若候选级伪装实际字段无法定位，不扩展到全局清除。

## 兼容与退休边界

- 保持账号池现有候选顺序、字段形态及既有 `entry.effort` 编辑/请求语义；不迁移或删除用户数据，不创建 auto-model 持久字段。
- 将旧 guard 的“无条件清理”责任退休为窄条件判定；保留其对确证陈旧历史残留的止损能力，当前聚合语义有效的值必须保留。代码层仅退休已失效的清理责任，不删除有合法用途的 guard carrier。
- 关闭伪装仅移除当前候选实际伪装字段，避免误伤其他账号/候选；transport 在无载荷时不得写伪装头。外部旧补丁文件明确不删除，且不以此为由再加一条本地 fallback。
- **Anti-Entropy 决定**：内部旧的无条件删除行为按 `delete-first` 退休；合法的 guard 止损能力保留为窄责任。无外部依赖证据时不引入兼容双轨；外部旧补丁不属于本次内部代码删除范围。

## TDD Route

**Aegis TDD off → skipped**（mode=`off`，decision=`skipped`；权威依据为本任务指定的 Aegis TDD off 路由，并无 strict TDD 授权）。测试姿态为实现后的定向回归，不要求 RED/GREEN/REFACTOR 流程。验证仍包括指定单测、typecheck、client build；TDD skipped 不等于跳过测试。

## 按文件拆分的最小任务

1. `src/auto-route-adapter.ts`：在现有自动模型元数据路径按当前队首解析目标 provider/model 的 `resolveModelInfo().reasoning`；仅输出其受支持列表，defaultEffort 采用有效 `entry.effort`，否则遵循 resolver 的 defaultEffort；不引入持久字段或推测能力。
2. `src/auto-route-adapter.ts`（复用 `src/auto-route.ts` 的候选路由逻辑）：保证每次实际候选路由仍以该候选 `entry.effort` 为实际档位；将既有 agent/request guard 的历史残留判定改为聚合语义下的窄条件。有效值不得清除；无法识别陈旧状态时保留并停止扩大清理。
3. `src/index.ts`：只调整既有注册/接线，使公开模型信息请求能够使用 adapter 对当前队首的派生结果；不调用宿主私有 API、不接入不存在的弹窗变更事件。
4. `src/account-hub-rpc.ts`：沿用现有 RPC 边界提供/更新当前候选数据；仅在当前 RPC 缺少完成候选级关闭或编辑所需的现有字段操作时作最小修改，不加模型级字段或全局清理。
5. `src/account-pool.ts`：保持队首与候选实际 `entry.effort`/伪装字段作为唯一持久事实来源；如现有池操作无法精确清当前候选实际字段，只补窄范围操作，不改 schema/迁移。
6. `src/account-hub-masquerade-transport.ts`：保留候选级伪装来源；确保无载荷请求不写伪装头，关闭后不从已清除的当前候选字段重新生成头；不引入全局伪装 fallback。
7. `plugin-src/client/account-hub.js`：现有候选编辑器仍编辑 `entry.effort`；关闭当前候选伪装时提交清除此候选实际字段的操作，不展示/保存 auto-model reasoning 配置，不实现宿主弹窗反向回写。
8. `tests/unit/auto-route-adapter.spec.ts`：覆盖队首变化导致 reasoning 列表/defaultEffort 更新、有效/缺失/不受支持 effort 的决策、无 reasoning 能力不猜测；并在此或 guard 所属的现有测试位置覆盖历史有效值保留与可识别陈旧残留清理。
9. `tests/unit/auto-route-panel.spec.ts`：验证候选编辑器仍以候选 `entry.effort` 为唯一编辑入口；关闭操作作用于当前候选实际字段，不新增模型级 reasoning 状态。
10. `tests/unit/auto-route-masquerade.spec.ts`：覆盖关闭当前候选伪装清空实际字段，且不清除其他候选字段。
11. `tests/unit/masquerade-transport.spec.ts`：覆盖当前候选范围及关闭后的无载荷请求不产生伪装头。

以上测试优先扩展列出的现有 suite；只有发现目标行为无合适现有归属时，才在同一测试目录新增最小测试，不扩展无关覆盖面。

## 验证命令与验收

1. 定向单测：
   `pnpm exec vitest run tests/unit/auto-route-adapter.spec.ts tests/unit/auto-route-panel.spec.ts tests/unit/auto-route-masquerade.spec.ts tests/unit/masquerade-transport.spec.ts`
2. 宿主侧静态检查：`pnpm typecheck`。
3. 客户端构建及其既有产物求值冒烟：`pnpm build:client`。
4. **验收**：以上命令通过；自动模型在队首变化后只暴露新候选 resolver 能力，defaultEffort 与该候选可用 `entry.effort` 一致且请求仍用候选实际值；不产生新 auto-model 持久状态；guard 不误删有效值；关闭只清当前候选实际伪装字段，后续无载荷请求不带伪装头；未改宿主私有接口、全局伪装路径或外部补丁文件。
5. 不运行全量测试/e2e/发布流程，因为不在已批准验证范围内；client build 是插件客户端语义构建闸，不替代宿主 GUI 验证。

## 未知风险

- 当前宿主 checkout 不可用，实际宿主弹窗如何消费公开模型元数据、是否显示当前 `defaultEffort` 尚不能直接验证；本计划只承诺插件输出契约，不作宿主实现事实判断。恢复宿主环境后可做手动弹窗确认，但不得因此实现私有事件。
- `resolveModelInfo().reasoning` 可能缺失或随目标模型变化；必须按当前队首准确选择 provider/model，无能力时保持未声明，不能静态缓存旧候选能力或悄然引入全局兜底。
- 旧 guard 的历史状态若与用户有效值不可区分，将无法安全自动清除；按停止条件保留，提交证据并返回设计决策，不能猜测。
- 候选在 UI 操作与 RPC 更新之间可能被重新排序；更新必须有候选身份/当前记录约束，避免因索引变化误清其他候选。现有身份契约如不足，暂停扩大清除范围。
- 绕过 agent/request 的直接调用路径明确未知且不覆盖；测试与验收不得宣称其行为已修复。

## 执行建议

采用 inline、按依赖顺序实施：先落实 resolver/候选元数据与 guard 语义，再完成候选字段/RPC/UI/transport 的清理闭环，随后跑定向单测、typecheck 和 client build。宿主私有能力、全局行为或新增持久化需求一旦浮现，停止并回到批准范围确认，不自动扩展。

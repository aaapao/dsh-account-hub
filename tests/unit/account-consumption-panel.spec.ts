/**
 * Account Hub「消耗顺序 + 切换粒度」两个选择器的**真渲染**测试。
 *
 * ## 为什么必须真渲染，而不是源码级正则断言
 *
 * 本仓库既有的前端测试多为「读源码、正则断言」（react 不在依赖里），但那**恰好
 * 证不了本次要证的东西**。本次的命题是「面板顶部出现两个并排下拉，改变后发出
 * 正确的 RPC，且选中态跟随宿主返回」—— 这是**渲染结构 + 事件流的输出差异**，
 * 正则只能证明某个字符串被提到过，证明不了组件真的渲染了它、更证明不了 change
 * 会走到哪个 `rpcCall` 上。
 *
 * 因此这里沿用 `qoder-hub-blank-screen.spec.ts` 的路子：把插件源码的 import 换成
 * 占位模块加载，配一个**带 hooks 的 react 占位**，真的渲染 `ProviderPanel`、
 * 真的派发 `onChange`。
 *
 * ## 与 `qoder-hub-blank-screen.spec.ts` 的分工
 *
 * 那个文件守的是「面板渲染不抛错 + 登录按钮可用」（白屏类缺陷的通盘闸门）；
 * 本文件守的是本次新增的这两个控件本身。两者共用同款加载器，但**各自维护一份
 * import 改写表**：一方改了 import 形态，两边都会立刻红，不会静默加载出半成品。
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ui-primitives 是宿主的隐式 baseline（不在本仓库依赖里）：临时目录里必须补一个
// 替身文件，否则 require 会以 Cannot find module 让**整个文件**加载失败。
import { rewriteUiPrimitivesImport, writeUiPrimitivesStub } from './fixtures/ui-primitives-stub.js'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 带 hooks 的最小 react 占位。
 *
 * `useState` / `useRef` / `useCallback` / `useEffect` 四个都要真的能用：本组件
 * 在挂载时发 `consumption.get`，其结果经 `setState` 回灌 —— 没有 effect 队列
 * 就永远停在初始态，测出来的是「占位不完整」而不是被测代码。
 */
const REACT_STUB = `
'use strict';
var current = null;
var effectQueue = [];
/**
 * 每个组件函数一个**独立的**实例槽位表（与真实 react 的 fiber 节点一一对应）。
 *
 * ⚠️ 不能用「一个全局 current」：本测试要展开组件树，父子组件的 hooks 会交错
 * 执行（父渲染 → 展开子 → 子渲染 → 回到父继续）。共享一份槽位会让子组件的
 * useState 写进父组件的槽位，读出来的状态完全错位。
 */
var stores = new Map();
function storeFor(fn) {
  var store = stores.get(fn);
  if (!store) { store = { slots: [], cursor: 0 }; stores.set(fn, store); }
  return store;
}
exports.__renderComponent = function (fn, props) {
  var previous = current;
  var store = storeFor(fn);
  current = store;
  store.cursor = 0;
  try {
    return fn(props);
  } finally {
    current = previous;
  }
};
/**
 * 丢弃全部实例槽位 = **卸载所有组件**。
 *
 * 每个用例必须先调它：槽位表按组件函数缓存，不重置的话第二个用例会**继承**
 * 上一个用例留下的 state（consumption / phase / accounts 等），
 * 于是「挂载时读到的配置」变成上一条测试的残留值 —— 那是一条会因为错误的原因
 * 而变绿或变红的假测试。
 */
exports.__reset = function () { stores.clear(); effectQueue = []; };
exports.__drainEffects = function () {
  var queued = effectQueue;
  effectQueue = [];
  for (var i = 0; i < queued.length; i++) queued[i].run();
};
/**
 * 与真实 react 对齐：**同时**填 props.children 与 children 数组。
 *
 * 只填数组是旧版替身的一个保真度缺口：JSX 的多个子节点在 react 里会进
 * props.children，故像 \React.createElement(Menu, {...}, a, b)\ 这种「多子节点
 * 传给组件」的写法，其子节点在 props.children 里；组件若把它透传下去
 * （ui-primitives 的 Button / Menu / Modal 都这么做），只填数组的替身会让这些
 * 内容在树上凭空消失 —— 表现为「按钮渲染出来了但没有文字」。
 * 本仓库所有代码都用 \React.createElement(组件, props, 子节点…)\，从不用 JSX，
 * 故补上 props.children 不会与既有断言冲突。
 */
exports.createElement = function createElement(type, props) {
  var children = Array.prototype.slice.call(arguments, 2);
  var merged = Object.assign({}, props || {});
  if (children.length === 1) merged.children = children[0];
  else if (children.length > 1) merged.children = children;
  return { type: type, props: merged, children: children };
};
function depsEqual(a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
exports.useState = function useState(initial) {
  var store = current;
  var index = store.cursor++;
  if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
  var set = function (next) {
    store.slots[index] = typeof next === 'function' ? next(store.slots[index]) : next;
  };
  return [store.slots[index], set];
};
exports.useRef = function useRef(initial) {
  var store = current;
  var index = store.cursor++;
  if (!(index in store.slots)) store.slots[index] = { current: initial };
  return store.slots[index];
};
exports.useCallback = function useCallback(fn, deps) {
  var store = current;
  var index = store.cursor++;
  var slot = store.slots[index];
  if (slot && depsEqual(slot.deps, deps)) return slot.fn;
  store.slots[index] = { fn: fn, deps: deps };
  return fn;
};
exports.useEffect = function useEffect(fn, deps) {
  var store = current;
  var index = store.cursor++;
  var slot = store.slots[index];
  if (slot && depsEqual(slot.deps, deps)) return;
  effectQueue.push({ run: fn });
  store.slots[index] = { deps: deps };
};
`

/** 能力矩阵占位（本文件不测积分行为）。 */
const CAPABILITIES_STUB = `
'use strict';
exports.supportsCreditBalance = function () { return true };
exports.supportsDailyCheckin = function () { return true };
`

const IMPORT_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^import \* as React from 'react';$/m, "const React = require('react');"],
  [
    /^import \{ supportsCreditBalance, supportsDailyCheckin \} from '\.\/credits-capabilities\.js';$/m,
    "const { supportsCreditBalance, supportsDailyCheckin } = require('./credits-capabilities.js');",
  ],
  [
    /^import \{ orderAfterDrop, dropPositionFromPointer \} from '\.\/account-order\.js';$/m,
    "const { orderAfterDrop, dropPositionFromPointer } = require('./account-order.js');",
  ],
]

/**
 * 把 `./account-order.js` 按与 `toCjs` 同一套规则转成 CJS 写进临时目录。
 *
 * `account-hub.js` 现在 import 了它：**不写这个文件，`require` 会以
 * `Cannot find module './account-order.js'` 失败** —— 整个文件的所有用例一起红。
 * 那不是「拖拽没测到」，而是「什么都没测到」（本文件第一版就踩了这个）。
 *
 * 这里放**真件**而不是空占位：只求 import 解析成功的话随便给个对象也能加载，
 * 但 `ProviderPanel` 渲染时真的会用到 `orderAfterDrop`（拖拽属性构造里），
 * 只有真函数才能让「面板照常渲染」这件事继续被测到。
 */
function writeOrderModule(dir: string): void {
  const source = readFileSync(resolve(here, '../../plugin-src/client/account-order.js'), 'utf8')
  writeFileSync(join(dir, 'account-order.js'),
    source.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, ''))
}

function toCjs(source: string): string {
  let out = source
  for (const [pattern, replacement] of IMPORT_REWRITES) {
    if (!pattern.test(out)) {
      throw new Error(`account-hub.js 的 import 形态已变化，测试的改写规则失效：${String(pattern)}`)
    }
    out = out.replace(pattern, replacement)
  }
  // ui-primitives 是宿主隐式 baseline（不在本仓库依赖里），临时目录里没有它：
  // 按源码**现算**导入名单并改写为替身 require（见 fixtures/ui-primitives-stub.ts）。
  out = rewriteUiPrimitivesImport(out)
  out = out.replace(/\bexport\s+(?=(?:function|const|let|var|class)\s)/g, '')
  return out.concat(
    '\nmodule.exports.__testExports = {'
    + ' ProviderPanel: ProviderPanel, ConsumptionSelectors: ConsumptionSelectors };\n',
  )
}

interface HookedReact {
  __renderComponent: (component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) => unknown
  __drainEffects: () => void
  /** 卸载全部组件（丢弃 hooks 槽位）。每个用例开头必须调一次，见其定义处。 */
  __reset: () => void
}

function loadClientModule(): {
  ProviderPanel: (props: Record<string, unknown>) => unknown
  ConsumptionSelectors: (props: Record<string, unknown>) => unknown
  hooks: HookedReact
} {
  const cjs = toCjs(readFileSync(resolve(here, '../../plugin-src/client/account-hub.js'), 'utf8'))
  const dir = mkdtempSync(join(tmpdir(), 'account-hub-consumption-'))
  mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '0.0.0-stub', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), REACT_STUB)
  writeFileSync(join(dir, 'credits-capabilities.js'), CAPABILITIES_STUB)
  writeOrderModule(dir)
  writeUiPrimitivesStub(dir, (path, data) => writeFileSync(path, data))
  writeFileSync(join(dir, 'account-hub.js'), cjs)

  const requireFromTemp = createRequire(pathToFileURL(join(dir, 'noop.cjs')).href)
  const loaded = requireFromTemp(join(dir, 'account-hub.js')) as { __testExports: Record<string, unknown> }
  const hooks = requireFromTemp(join(dir, 'node_modules', 'react', 'index.js')) as HookedReact
  tempDir = dir
  return {
    ProviderPanel: loaded.__testExports.ProviderPanel as (props: Record<string, unknown>) => unknown,
    ConsumptionSelectors: loaded.__testExports.ConsumptionSelectors as (props: Record<string, unknown>) => unknown,
    hooks,
  }
}

let tempDir: string | undefined
afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
})

interface ElementNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
  /**
   * Menu 替身挂在返回节点上的自身 props（items / selectedId / onSelect）。
   *
   * 真件是组件，这些 props 只存在于展开**前**的元素上；展开成宿主节点后就没了，
   * 而 spec 里的树是展开过的 —— 故替身把它们原样带出来（见 fixtures 里的说明）。
   */
  menuProps?: {
    items?: Array<{ id: string; label: unknown }>
    selectedId?: string
    onSelect?: (id: string) => void
  }
}

const isElement = (node: unknown): node is ElementNode =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

function expandTree(node: unknown, hooks: HookedReact, depth = 0): unknown {
  if (depth > 50) throw new Error('组件展开超过 50 层：疑似自引用')
  if (Array.isArray(node)) return node.map((child) => expandTree(child, hooks, depth + 1))
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    return expandTree(hooks.__renderComponent(node.type, node.props), hooks, depth + 1)
  }
  return { ...node, children: node.children.map((child) => expandTree(child, hooks, depth + 1)) }
}

function flatten(node: unknown, out: unknown[] = []): unknown[] {
  out.push(node)
  if (isElement(node)) for (const child of node.children) flatten(child, out)
  else if (Array.isArray(node)) for (const child of node) flatten(child, out)
  return out
}

function textsOf(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  if (!isElement(node)) return []
  return node.children.flatMap(textsOf)
}

/** 渲染 → 跑 effect → 排空微任务，直到没有新的 setState 排队。 */
async function renderStable(
  Component: (props: Record<string, unknown>) => unknown,
  props: Record<string, unknown>,
  hooks: HookedReact,
): Promise<unknown> {
  // 先卸载：槽位表按组件函数缓存，不重置会继承上一个用例的状态
  // （见 `__reset` 的说明）。
  hooks.__reset()
  let tree: unknown
  for (let pass = 0; pass < 20; pass++) {
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    // effect 里发起的 RPC 会以 setState 回灌；再展开一次让新状态出现在树上，
    // 多跑几轮直到稳定（本面板挂载时并发发三个 RPC）。
    tree = expandTree(hooks.__renderComponent(Component, props), hooks)
    hooks.__drainEffects()
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return tree
}

/** 记录调用的 rpcCall 替身；`consumption.get` 回一个可指定的配置。 */
function makeRpc(consumption: { order: string; switch: string } = { order: 'sequential', switch: 'per-turn' }) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let current = consumption
  const rpcCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload })
    if (method === 'account.list') return { accounts: [] }
    if (method === 'credits.balances') return { accounts: [] }
    if (method === 'consumption.get') return { provider: payload.provider, consumption: current }
    if (method === 'consumption.set') {
      // 复刻宿主的**部分更新**语义：只覆盖传进来的字段。
      current = {
        order: (payload.order as string) ?? current.order,
        switch: (payload.switch as string) ?? current.switch,
      }
      return { provider: payload.provider, consumption: current }
    }
    return {}
  }
  return { calls, rpcCall, currentConsumption: () => current }
}

const client = loadClientModule()

/**
 * 树里两个消耗配置下拉的**锚点按钮**。
 *
 * 迁移前判据是 `type === 'select'`（原生下拉）；现在锚点是一个宿主标签
 * `button`（.dim-ah-selectAnchor 胶囊），靠 `aria-haspopup="menu"` + `aria-label`
 * 认出来 —— 可读名仍是可访问性的唯一来源，判据跟着它走最稳。
 */
function consumptionSelects(node: unknown): ElementNode[] {
  return flatten(node)
    .filter(isElement)
    .filter((el) => el.type === 'button'
      && el.props['aria-haspopup'] === 'menu'
      && typeof el.props['aria-label'] === 'string')
}

/**
 * 第 index 个下拉的 **Menu 节点**（替身把 `menuProps` 挂在返回节点上）。
 *
 * ⚠️ 只能按整棵树里 Menu 出现的顺序取，不能从锚点按钮往下找：锚点与菜单是
 * **兄弟**（`Menu` 渲染成「锚点 + 列表」）。顺序与 `consumptionSelects` 的锚点
 * 顺序一一对应 —— 每个 Menu 先渲染 anchor，再渲染（展开时的）列表。
 */
function menuNodeOf(tree: unknown, index: number): ElementNode | undefined {
  return flatten(tree)
    .filter(isElement)
    .filter((el) => el.menuProps !== undefined)[index]
}

/**
 * 锚点对应的 Menu **选中值**（`menuProps.selectedId`）。
 *
 * 迁移前读的是原生 `select.props.value`（控件内部取值）；现在选中态交给 Menu 的
 * `selectedId`（真机据此给当前行打勾 / 高亮），锚点文案与它同源 —— 读它才能同时
 * 锁住「锚点显示的是这一档」与「菜单里勾的也是这一档」。
 */
function selectedValueOf(tree: unknown, index: number): string | undefined {
  return menuNodeOf(tree, index)?.menuProps?.selectedId
}

/**
 * 第 index 个下拉**展开后**的菜单项文案（按 DOM 顺序）。
 *
 * ⚠️ 必须从 `Menu` 节点整棵子树里取，不能从锚点按钮往下取：菜单行是锚点的
 * **兄弟**（`Menu` 渲染成「锚点 + 列表」），从锚点往下一个都找不到。
 */
function menuRowsOf(tree: unknown, index: number): string[] {
  const menu = menuNodeOf(tree, index)
  expect(menu, `第 ${index} 个下拉不存在`).toBeDefined()
  return flatten(menu)
    .filter(isElement)
    .filter((el) => el.type === 'button' && el.props.role === 'menuitem')
    .map((el) => textsOf(el).join(''))
}

/**
 * 展开一个选择器的下拉：渲染 → 点锚点 → **不重置 hooks** 地重渲染。
 *
 * 不能复用 `renderStable`：它开头会 `__reset()` 丢掉 hooks 槽位，而 `open` 正是
 * 存在槽位里的 state —— 重置后再渲染会回到「收起」。
 */
function openSelectors(props: Record<string, unknown>, index: number): unknown {
  let tree = expandTree(client.hooks.__renderComponent(client.ConsumptionSelectors, props), client.hooks)
  const anchor = consumptionSelects(tree)[index]!
  ;(anchor.props.onClick as () => void)()
  tree = expandTree(client.hooks.__renderComponent(client.ConsumptionSelectors, props), client.hooks)
  return tree
}

/**
 * 锚点上显示的**当前档**文案（收起时锚点里只有它一个文本）。
 *
 * 这是「宿主配置 → 用户看到的字」这条链路的唯一出口：迁移前读的是原生
 * `select.props.value`（内部取值），现在读的是渲染结果 —— 更能证明用户确实
 * 看见了他选的那一档。
 */
function anchorTextOf(anchor: ElementNode): string {
  return textsOf(anchor).join('')
}

/** 展开菜单内各选项自己的 Tooltip 文案。 */
function optionTooltipsOf(node: unknown): string[] {
  return flatten(node)
    .filter(isElement)
    .map((el) => el.props['data-tooltip'])
    .filter((label): label is string => typeof label === 'string')
}


describe('ConsumptionSelectors：两个并排的下拉（Menu 原语）', () => {
  it('渲染三档消耗顺序与两档切换粒度，文案与需求一致', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const props = {
      provider: 'buddy-cn',
      rpcCall,
      value: { order: 'sequential', switch: 'per-turn' },
      busy: false,
      onChange: () => {},
    }
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, props),
      client.hooks,
    )
    const selects = consumptionSelects(tree)
    expect(selects, '应当恰好两个下拉（消耗顺序 / 切换粒度）').toHaveLength(2)

    // 收起时锚点上只有**当前档**的文案（下拉收起时只显示被选中的那一档）。
    expect(textsOf(selects[0]!)).toEqual(['顺序'])
    expect(textsOf(selects[1]!)).toEqual(['按轮次'])

    // 展开后逐档可见：三档消耗顺序、两档切换粒度（第二档是用户没改的默认值）。
    //
    // ⚠️ 一次点击会把**两个**下拉都展开：本文件的 react 占位按**组件函数**缓存
    // hooks 槽位（`storeFor(fn)`），而两个下拉是同一个 `ConsumptionSelect` 的
    // 两个实例 —— 它们共用那个 `open` 槽位。真机里两个实例各有一份 state，
    // 这里读的是同一份，但「两档 / 三档的文案与顺序」这一断言不受影响。
    const openTree = openSelectors(props, 0)
    expect(menuRowsOf(openTree, 0)).toEqual(['顺序', '遍历', '最高优先'])
    expect(menuRowsOf(openTree, 1)).toEqual(['按请求', '按轮次'])

    const text = textsOf(tree).join('')
    expect(text).not.toContain('消耗顺序')
    expect(text).not.toContain('切换粒度')
    // 设置名通过 aria-label 提供；按钮本身不再挂 Tooltip。
    expect(selects[0]!.props['aria-label']).toBe('消耗顺序')
    expect(selects[1]!.props['aria-label']).toBe('切换粒度')
    expect(selects[0]!.props['data-tooltip']).toBeUndefined()
    expect(selects[1]!.props['data-tooltip']).toBeUndefined()
    // 展开后仍保留每个选项自己的简短提示。
    const optionTips = optionTooltipsOf(openTree)
    expect(optionTips).toContain('总是用排序里的第一个可用账号')
    expect(optionTips).toContain('每次请求轮转下一个账号，用完一轮再从头开始（默认）')
    expect(optionTips).toContain('每一次请求都重新选号')
    expect(optionTips).toContain('一轮对话内固定用同一个账号，下一轮才换（默认，上下文更连贯）')
  })

  it('每档的取值与宿主联合类型逐字一致（改名等于让用户配置失效）', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const props = {
      provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
      busy: false, onChange: () => {},
    }
    // 取值不再挂在 `<option value>` 上，而是菜单项的 **id**（`Menu` 的 onSelect
    // 回传它）。故这里从 items 的 id 读 —— 那是同一份 `CONSUMPTION_*_OPTIONS`，
    // 改名同样等于让用户已保存的配置失效。
    const itemIdsOf = (index: number): string[] => {
      const tree = expandTree(
        client.hooks.__renderComponent(client.ConsumptionSelectors, props),
        client.hooks,
      )
      const menu = flatten(tree).filter(isElement).filter((el) => el.menuProps !== undefined)[index]
      expect(menu, `第 ${index} 个下拉没有 items`).toBeDefined()
      return (menu!.menuProps!.items as Array<{ id: string }>).map((item) => item.id)
    }
    expect(itemIdsOf(0)).toEqual(['sequential', 'round-robin', 'highest-balance'])
    expect(itemIdsOf(1)).toEqual(['per-request', 'per-turn'])
  })

  it('无外框：分组容器只保留等分布局，边框与内边距已删除', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    // 结构上只剩「两个下拉」：容器 → 分组 → Menu（锚点胶囊 + 列表），
    // 中间不再有 head / label / hint。
    const classes = flatten(tree)
      .filter(isElement)
      .map((el) => String(el.props.className ?? ''))
      .filter((name) => name.startsWith('dim-ah-consumption'))
    expect(classes).toEqual([
      'dim-ah-consumption', 'dim-ah-consumptionGroup',
      'dim-ah-consumptionGroup',
    ])
    const styles = readFileSync(resolve(here, '../../plugin-src/client/account-hub-styles.js'), 'utf8')
    const at = styles.indexOf('.dim-ah-consumptionGroup {')
    const group = styles.slice(at, styles.indexOf('}', at))
    // 删框：不得再有 border / padding / 圆角（那是「外面那个框」的构成要素）。
    expect(group).not.toContain('border')
    expect(group).not.toContain('padding')
    expect(group).not.toContain('border-radius')
    // 分组按 flex: 1 1 0 严格平分这一排（basis 取 0 才等宽；留 auto 会被文案拉偏），
    // min-width: 0 让窄面板下继续压缩而不是撑破右栏 —— 两者都不是「框」的构成要素。
    expect(group).toContain('flex: 1 1 0')
    expect(group).toContain('min-width: 0')
    // 被删掉的三个 class 的规则不得残留（否则是「删了节点、留了样式」）。
    expect(styles).not.toContain('.dim-ah-consumptionHead')
    expect(styles).not.toContain('.dim-ah-consumptionLabel')
    expect(styles).not.toContain('.dim-ah-consumptionHint')
  })

  it('两个下拉都是 Menu 锚点：宿主 button + aria-haspopup，且不再有原生表单控件', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    const selects = consumptionSelects(tree)
    expect(selects.map((el) => el.props['aria-label'])).toEqual(['消耗顺序', '切换粒度'])
    for (const select of selects) {
      expect(String(select.props['aria-label']).length).toBeGreaterThan(0)
      // 锚点是**宿主标签** button（不是 Button 原语）：这正是宿主设置页
      // LanguageRow 的形态，故 type 必须是显式的 button（否则在表单里会提交）。
      expect(select.type).toBe('button')
      expect(select.props.type).toBe('button')
      expect(select.props['aria-haspopup']).toBe('menu')
      // 收起态：两个锚点都报 aria-expanded=false。
      expect(select.props['aria-expanded']).toBe(false)
      expect(select.props.className).toBe('dim-ah-selectAnchor')
    }
    // 原生表单控件归零：没有 select / option / input 混进来。
    for (const tag of ['select', 'option', 'input']) {
      const natives = flatten(tree).filter(isElement).filter((el) => el.type === tag)
      expect(natives, `消费配置不应混入原生 ${tag}`).toHaveLength(0)
    }
    const groups = flatten(tree).filter(isElement).filter((el) => el.props.role === 'radiogroup')
    expect(groups, '不再有 radiogroup 容器').toHaveLength(0)
  })

  it('选中态跟随 value（受控：锚点文案由 value 决定，菜单 selectedId 同源）', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'round-robin', switch: 'per-request' },
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    const selects = consumptionSelects(tree)
    // 收起时锚点显示**当前档**的文案（宿主配置 → 文案）。
    expect(textsOf(selects[0]!)).toEqual(['遍历'])
    expect(textsOf(selects[1]!)).toEqual(['按请求'])
    // 选中态同时交给 Menu 的 selectedId（真机据此给当前行打勾 / 高亮），
    // 两处必须同源，否则「显示遍历、菜单勾顺序」这种错位不会被发现。
    const menus = flatten(tree).filter(isElement).filter((el) => el.menuProps !== undefined)
    expect(menus[0]!.menuProps!.selectedId).toBe('round-robin')
    expect(menus[1]!.menuProps!.selectedId).toBe('per-request')
  })

  it('value 缺席 / 非法档位时下拉退回默认档（遍历），不留空白下拉', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        // `value` 整个缺席（消费方漏传）时不能渲染出「没有任何选中项」的下拉。
        provider: 'buddy-cn', rpcCall, value: undefined,
        busy: false, onChange: () => {},
      }),
      client.hooks,
    )
    const selects = consumptionSelects(tree)
    // 锚点文案与菜单选中项都要落到默认档（遍历 / 按轮次），不能是一片空白。
    expect(textsOf(selects[0]!)).toEqual(['遍历'])
    expect(textsOf(selects[1]!)).toEqual(['按轮次'])
    const menus = flatten(tree).filter(isElement).filter((el) => el.menuProps !== undefined)
    expect(menus[0]!.menuProps!.selectedId).toBe('round-robin')
    expect(menus[1]!.menuProps!.selectedId).toBe('per-turn')
  })

  it('busy 期间两个下拉都禁用（写入在途时不许连点）', () => {
    const { rpcCall } = makeRpc()
    client.hooks.__reset()
    const tree = expandTree(
      client.hooks.__renderComponent(client.ConsumptionSelectors, {
        provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
        busy: true, onChange: () => {},
      }),
      client.hooks,
    )
    const selects = consumptionSelects(tree)
    expect(selects).toHaveLength(2)
    expect(selects.every((el) => el.props.disabled === true)).toBe(true)
  })

  it('选中某一档只回调 onChange 一次，且只带该档的字段（不做本地乐观更新）', () => {
    const { rpcCall } = makeRpc()
    const changes: Array<Record<string, unknown>> = []
    client.hooks.__reset()
    const props = {
      provider: 'buddy-cn', rpcCall, value: { order: 'sequential', switch: 'per-turn' },
      busy: false, onChange: (patch: Record<string, unknown>) => changes.push(patch),
    }
    // 选中动作走 Menu 的 onSelect（回传菜单项 id）。
    const selectIn = (index: number, value: string): void => {
      const tree = expandTree(
        client.hooks.__renderComponent(client.ConsumptionSelectors, props),
        client.hooks,
      )
      const menu = flatten(tree).filter(isElement).filter((el) => el.menuProps !== undefined)[index]!
      ;(menu.menuProps!.onSelect as (id: string) => void)(value)
    }
    // 第一个下拉 = 消耗顺序 → 只发 order。
    selectIn(0, 'round-robin')
    expect(changes).toEqual([{ order: 'round-robin' }])
    // 第二个下拉 = 切换粒度 → 只发 switch（两个下拉彼此独立，整体覆盖会冲掉另一半）。
    selectIn(1, 'per-request')
    expect(changes[1]).toEqual({ switch: 'per-request' })
  })
})

describe('ConsumptionSelectors：版面（两个下拉同排、各占一半宽）', () => {
  const styles = readFileSync(
    resolve(here, '../../plugin-src/client/account-hub-styles.js'),
    'utf8',
  )

  /** 取某条选择器的声明块（首个匹配）。 */
  const ruleOf = (selector: string): string => {
    const at = styles.indexOf(selector + ' {')
    expect(at, `account-hub-styles.js 里找不到规则 ${selector}`).toBeGreaterThan(-1)
    return styles.slice(at, styles.indexOf('}', at))
  }

  it('两个下拉同排且各占一半宽：分组等分剩余宽度，锚点填满分组', () => {
    expect(ruleOf('.dim-ah-consumption')).toContain('display: flex')
    expect(ruleOf('.dim-ah-consumption')).not.toContain('flex-wrap: wrap')
    // 等分：flex-basis 为 0 才能忽略两个文案的长短差，否则长文案那侧更宽。
    expect(ruleOf('.dim-ah-consumptionGroup')).toContain('flex: 1 1 0')
    expect(ruleOf('.dim-ah-consumptionGroup')).toContain('min-width: 0')
    // 分组要铺满整列：Menu 的 .root 是 inline-flex，不拉成 grid 就只裹住锚点，
    // 锚点也就不再等宽。
    expect(ruleOf('.dim-ah-consumptionGroup')).toContain('display: grid')
    // 宽度钉在选择器上（基础规则里不写 width，见下一条用例）。
    const stretched = ruleOf('.dim-ah-consumptionGroup .dim-ah-selectAnchor')
    expect(stretched).toContain('width: 100%')
    expect(stretched).toContain('min-width: 0')
    expect(stretched).toContain('justify-content: space-between')
    // 弹层跟着按钮宽：不挂 portal 时 Menu 的 .list 是绝对定位子节点，
    // 靠本类把宿主的 min-width: 144px 压回去。
    expect(ruleOf('.dim-ah-consumptionMenu')).toContain('width: 100%')
    expect(ruleOf('.dim-ah-consumptionMenu')).toContain('min-width: 0')
    expect(styles).not.toContain('.dim-ah-select {')
  })

  it('锚点是宿主设置页那枚胶囊：几何与配色逐字沿用 LanguageRow 的 .selector', () => {
    const anchor = ruleOf('.dim-ah-selectAnchor')
    // 宿主 LanguageRow.module.css 的 .selector 原文（两个 token 也是宿主同名变量）。
    expect(anchor).toContain('display: inline-flex')
    expect(anchor).toContain('align-items: center')
    expect(anchor).toContain('gap: 12px')
    expect(anchor).toContain('height: 36px')
    expect(anchor).toContain('padding: 0 14px')
    expect(anchor).toContain('border: none')
    expect(anchor).toContain('border-radius: 18px')
    expect(anchor).toContain('background: var(--dsw-alias-bg-module-platform)')
    expect(anchor).toContain('font-size: 14px')
    expect(anchor).toContain('line-height: 22px')
    expect(anchor).toContain('color: var(--dsw-alias-label-primary)')
    // 基础规则**不得**写宽度：单枚胶囊要按文案自适应（头部「正式 / Beta」），
    // 需要铺满的两处由各自的后代规则拉伸。
    expect(anchor).not.toContain('width:')
    // hover / 禁用两态取同包 Button.module.css 的取值。
    expect(ruleOf('.dim-ah-selectAnchor:hover:not(:disabled)'))
      .toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(ruleOf('.dim-ah-selectAnchor:disabled')).toContain('cursor: not-allowed')
    expect(ruleOf('.dim-ah-selectAnchor:disabled')).toContain('opacity: 0.4')
    // chevron 是宿主图标组件，只保留「不参与压缩」这一条。
    expect(ruleOf('.dim-ah-selectAnchorChevron')).toContain('flex: none')
    // 基础规则必须排在两个后代规则**之前**：`ruleOf` 取首个匹配，顺序反了
    // 它就会取到后代规则那条（宽度也在里面），上一条用例随即失效。
    const baseAt = styles.indexOf('.dim-ah-selectAnchor {')
    expect(baseAt).toBeLessThan(styles.indexOf('.dim-ah-consumptionGroup .dim-ah-selectAnchor {'))
    expect(baseAt).toBeLessThan(styles.indexOf('.dim-ah-arEditorRow .dim-ah-selectAnchor {'))
  })
})

describe('ProviderPanel：选择器位于账号卡片之前，且读写走 RPC', () => {
  it('挂载时拉一次 consumption.get（与 account.list 并发）', async () => {
    const { calls, rpcCall } = makeRpc({ order: 'sequential', switch: 'per-request' })
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const get = calls.find((c) => c.method === 'consumption.get')
    expect(get, '挂载时应当拉取消耗配置').toBeDefined()
    expect(get!.payload).toEqual({ provider: 'buddy-cn' })
    // 宿主返回的值必须被渲染出来（否则下拉永远显示默认档）。
    // 选中态读 Menu 的 selectedId（锚点文案与它同源，见 `selectedValueOf`）。
    const selects = consumptionSelects(tree)
    expect(selects).toHaveLength(2)
    expect(selectedValueOf(tree, 0)).toBe('sequential')
    expect(selectedValueOf(tree, 1)).toBe('per-request')
  })

  it('选择器在账号卡片列表**之前**（面板顶部，与卡片同宽）', async () => {
    const { rpcCall } = makeRpc()
    const full = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    const nodes = flatten(full).filter(isElement)
    // 选择器的判据是**锚点胶囊**（`aria-haspopup="menu"` + `dim-ah-selectAnchor`）：
    // 原生 select 已不存在，再按 `type === 'select'` 找只会恒为 -1。
    const selectIndex = nodes.findIndex((el) => el.type === 'button'
      && el.props['aria-haspopup'] === 'menu'
      && el.props.className === 'dim-ah-selectAnchor')
    expect(selectIndex, '面板里找不到选择器').toBeGreaterThan(-1)
    // 账号区（空态提示）必须排在选择器之后 —— 两个下拉在账号卡片列表
    // **之前**，这正是需求要求的版面位置。
    //
    // ⚠️ 判据必须用「节点自身的直接文本」而不是 `textsOf`（整棵子树）：外层容器
    // 的子树里同样含这段文本，`findIndex` 会先命中**根节点**（下标 0），
    // 于是断言变成 `11 < 0` 恒失败 —— 那验的是「根节点在最后」这种无关的事。
    const ownTextOf = (el: ElementNode) => el.children
      .filter((child): child is string => typeof child === 'string')
      .join('');
    const emptyIndex = nodes.findIndex((el) => ownTextOf(el) === '尚未配置账号')
    expect(emptyIndex, '找不到账号区空态节点').toBeGreaterThan(-1)
    expect(selectIndex).toBeLessThan(emptyIndex)
  })

  it('选中某一档后发出 consumption.set，且是**部分更新**（只带一个字段）', async () => {
    const { calls, rpcCall } = makeRpc()
    let tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    // 选中动作走 Menu 的 onSelect（回传菜单项 id），与真机点菜单行同一条路径。
    const selectIn = (node: unknown, index: number, value: string): void => {
      const menu = menuNodeOf(node, index)
      expect(menu, `第 ${index} 个下拉不存在`).toBeDefined()
      ;(menu!.menuProps!.onSelect as (id: string) => void)(value)
    }
    selectIn(tree, 0, 'sequential')
    // 让 RPC 的 promise 结算（onSelect 是 async 处理器）。
    for (let i = 0; i < 10; i++) await Promise.resolve()
    const set = calls.find((c) => c.method === 'consumption.set')
    expect(set, '选中一档后应当写回配置').toBeDefined()
    // **只带 order，不带 switch** —— 两个下拉彼此独立，整体覆盖会让另一个
    // 标签页的过期状态把用户刚改的字段冲掉。
    expect(set!.payload).toEqual({ provider: 'buddy-cn', order: 'sequential' })

    // 宿主接受后再渲染：选中态必须跟着宿主返回的值走。
    tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    expect(selectedValueOf(tree, 0), '宿主已接受 sequential，下拉应当显示它')
      .toBe('sequential')
  })

  it('写回失败时不得把选中态改掉（不做乐观更新，与模型开关同理）', async () => {
    const calls: Array<{ method: string }> = []
    const rpcCall = async (method: string, payload: Record<string, unknown>) => {
      calls.push({ method })
      if (method === 'account.list') return { accounts: [] }
      if (method === 'consumption.get') return { provider: payload.provider, consumption: { order: 'round-robin', switch: 'per-turn' } }
      if (method === 'consumption.set') throw new Error('宿主拒绝了这次写入')
      return {}
    }
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    // 选中动作走 Menu 的 onSelect（与真机点菜单行同一条路径）。
    const menu = menuNodeOf(tree, 0)
    expect(menu, '面板里找不到消耗顺序下拉').toBeDefined()
    ;(menu!.menuProps!.onSelect as (id: string) => void)('highest-balance')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(calls.some((c) => c.method === 'consumption.set')).toBe(true)
    // 重新渲染：仍是宿主给的「遍历」（失败没有污染本地状态）。
    const after = expandTree(
      client.hooks.__renderComponent(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }),
      client.hooks,
    )
    expect(selectedValueOf(after, 0)).toBe('round-robin')
  })

  it('consumption.get 失败时面板仍完整可用（下拉退回默认档，不白屏）', async () => {
    const rpcCall = async (method: string) => {
      if (method === 'account.list') return { accounts: [] }
      if (method === 'consumption.get') throw new Error('端点未注册')
      return {}
    }
    const tree = await renderStable(client.ProviderPanel, { provider: 'buddy-cn', rpcCall }, client.hooks)
    // 面板骨架与选择器都还在；无提示框时仍通过可访问名称识别两个设置。
    const selects = consumptionSelects(tree)
    expect(selects).toHaveLength(2)
    expect(selects.map((el) => el.props['aria-label'])).toEqual(['消耗顺序', '切换粒度'])
    expect(selects.every((el) => el.props['data-tooltip'] === undefined)).toBe(true)
    // 退回默认档：遍历 + 按轮次（读 Menu 的 selectedId，与锚点文案同源）。
    expect(selectedValueOf(tree, 0)).toBe('round-robin')
    expect(selectedValueOf(tree, 1)).toBe('per-turn')
  })

  it('七个 provider 都能渲染出这两个下拉（新增 provider 不会漏接线）', async () => {
    for (const provider of ['codearts', 'buddy-cn', 'buddy', 'lobsterai', 'trae-cn', 'qoder', 'qoder-cn']) {
      const { rpcCall } = makeRpc()
      const tree = await renderStable(client.ProviderPanel, { provider, rpcCall }, client.hooks)
      expect(consumptionSelects(tree).length, `${provider} 缺少消耗顺序 / 切换粒度下拉`).toBe(2)
    }
  })
})

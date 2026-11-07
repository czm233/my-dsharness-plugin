#!/usr/bin/env node
/*
 * 连线交互回归（无头）：加载真实 client.js，用「可重渲染」的 React stub 渲染一张
 * 三节点画布（主会话A x100 → 工作B x500 → 结束 x900，同一水平线），按真实交互顺序
 * 覆盖四条连线/建节点路径：
 *   ① 端口拖拽 → 落到目标节点 → 建边（端口取面向对方的同侧端口对）
 *   ② 重复连同一条边 → 被去重
 *   ③ 端口拖拽 → 落到空白 → 弹创建菜单 → 选「工作」→ 新节点 + 自动连线
 *   ④ 工具栏「连线⤳」模式 → 点源节点 → 点目标节点 → 建边
 *   ⑤ 落回源节点自身 → 取消；⑥ 结束节点向外拉 → 拦截
 *
 * 背景（2026-11-07 事故）：2.16.2 重构删掉了 nearestPort 却留下三处调用点，
 * 任何连线落点都抛 ReferenceError——渲染 harness 只测渲染，测不到交互路径，
 * 本脚本是它的交互层补集。
 *
 * 用法：node agent-workflow-board/test/link-drag-sim.cjs
 * 退出码：全绿 0；任何断言失败 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---- DOM stub ----
const ctx2d = { set font(v) {}, measureText: t => ({ width: String(t).length * 12 }) }
// elementFromPoint 可编程：测试按「x,y」注册命中元素
const hitTargets = new Map()
global.document = {
  createElement: () => ({ getContext: () => ctx2d }),
  elementFromPoint: (x, y) => hitTargets.get(`${Math.round(x)},${Math.round(y)}`) || null,
}

// ---- window stub：记录全局 pointer 监听，便于手动派发 ----
const winListeners = new Map()
global.window = {
  __ModuleLoader__: { load: m => { global.__mod = m } },
  innerWidth: 1600,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {} },
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, [])
    winListeners.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    const list = winListeners.get(type) || []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  },
}
const fire = (type, event) => {
  for (const fn of [...(winListeners.get(type) || [])]) fn(event)
}

// ---- React stub：cells/refs 跨「渲染」持久，setters 函数式更新就地生效 ----
const noop = () => {}
let cells = []
let refs = []
let cellCursor = 0
let refCursor = 0
const React = {
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, ref: props && props.ref, children: children.flat(9) }),
  useState(v) {
    const i = cellCursor++
    if (!cells[i]) {
      cells[i] = { value: typeof v === 'function' ? v() : v }
      cells[i].set = next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }
    }
    return [cells[i].value, cells[i].set]
  },
  useRef(v) {
    const i = refCursor++
    if (!refs[i]) refs[i] = { current: v }
    return refs[i]
  },
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: fn => fn(),
  useCallback: fn => fn,
}

// ---- 加载真实 client.js（注入测试钩子，不改原文件）----
const clientPath = path.join(__dirname, '..', 'client.js')
const src = fs.readFileSync(clientPath, 'utf8')
const lines = src.split('\n')
let idx = -1
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i] === '    return {') { idx = i; break }
}
if (idx < 0) { console.error('ANCHOR NOT FOUND: client.js 结构变了，先更新注入锚点'); process.exit(1) }
lines.splice(idx, 0, '    window.__test = { CanvasPage, WORKBENCH, normalizeDoc, emptyDoc, NODE_H, measureNodeWidth }')
const tmp = path.join(os.tmpdir(), 'awb-link-drag-sim.cjs')
fs.writeFileSync(tmp, lines.join('\n'))
require(tmp)
global.__mod.factory(id => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
const T = global.window.__test
if (!T || !T.CanvasPage) { console.error('HOOK FAILED'); process.exit(1) }

// ---- 树工具 ----
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(child => walk(child, visit))
  if (node.props) visit(node)
  if (node.children) walk(node.children, visit)
}
const findBy = (root, pred) => {
  const hits = []
  walk(root, el => { if (pred(el)) hits.push(el) })
  return hits
}
const nodeEl = (root, nodeId) => findBy(root, el => el.props['data-node-id'] === nodeId)[0] || null
const portEl = (root, nodeId, side) => {
  const el = nodeEl(root, nodeId)
  return el ? findBy(el, e => String(e.props.className || '').includes(`awbc-port p-${side}`))[0] || null : null
}
const tap = (root, nodeId) => {
  const el = nodeEl(root, nodeId)
  if (!el) throw new Error('node element not found: ' + nodeId)
  el.props.onPointerDown({ button: 0, clientX: 10, clientY: 10, stopPropagation: noop })
}

// ---- 测试画布 ----
const mkNode = (id, type, label, x, y) => ({ id, type, label, description: '', prompt: '', agent: '', exec: 'subagent', hookKind: '', note: '', x, y })
const baseDoc = () => T.normalizeDoc({
  id: 'sim-canvas',
  name: '连线模拟',
  nodes: [
    mkNode('n_start', 'start', '主会话', 100, 200),
    mkNode('n_work', 'work', '工作B', 500, 200),
    mkNode('n_end', 'end', '结束', 900, 200),
  ],
  edges: [],
})
const render = () => {
  cellCursor = 0
  refCursor = 0
  return T.CanvasPage({ sessionId: 'link-sim' })
}
const fresh = () => {
  cells = []
  refs = []
  cellCursor = 0
  refCursor = 0
  winListeners.clear()
  hitTargets.clear()
  T.WORKBENCH.doc = baseDoc()
  const root = render()
  // 把渲染树里 viewport 的 ref 接上假矩形：startPaletteDrag 落点处理要用它。
  const vp = findBy(root, el => String(el.props.className || '').includes('awbc-viewport'))[0]
  if (vp && vp.ref) {
    vp.ref.current = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }),
      clientWidth: 1600,
      clientHeight: 900,
    }
  }
  return root
}

let failed = 0
const check = (name, cond, detail) => {
  if (cond) console.log('PASS', name)
  else { failed++; console.log('FAIL', name, '::', detail || '') }
}

// ① 端口拖拽 → 落到目标节点 → 建边（同侧端口对：水平邻居=右→左）
{
  const root = fresh()
  const port = portEl(root, 'n_start', 'right')
  if (!port) { check('① 找到主会话右端口', false); } else {
    const fakeTarget = { closest: sel => (sel === '[data-node-id]' ? { getAttribute: () => 'n_work' } : null) }
    hitTargets.set('620,230', fakeTarget)
    port.props.onPointerDown({ button: 0, clientX: 250, clientY: 230, stopPropagation: noop })
    fire('pointermove', { clientX: 500, clientY: 230 })
    fire('pointerup', { clientX: 620, clientY: 230 })
    const doc = cells[0].value
    const added = (doc.edges || []).filter(e => e.from === 'n_start' && e.to === 'n_work')
    check('① 拖到目标节点松开 → 建边', added.length === 1, JSON.stringify(doc.edges))
    check('① 端口取同侧端口对(右→左)', added[0] && added[0].fromPort === 'right' && added[0].toPort === 'left', added[0] ? `${added[0].fromPort}->${added[0].toPort}` : '')
    const menu = cells.find(c => c.value && typeof c.value === 'object' && c.value.fromId)
    check('① 不弹空白落点菜单', !menu, menu ? JSON.stringify(menu.value) : '')
  }
}

// ② 重复连同一条边 → 去重
{
  const root = fresh()
  const port = portEl(root, 'n_start', 'right')
  const fakeTarget = { closest: sel => (sel === '[data-node-id]' ? { getAttribute: () => 'n_work' } : null) }
  hitTargets.set('620,230', fakeTarget)
  for (let round = 0; round < 2; round++) {
    port.props.onPointerDown({ button: 0, clientX: 250, clientY: 230, stopPropagation: noop })
    fire('pointerup', { clientX: 620, clientY: 230 })
  }
  const doc = cells[0].value
  const added = (doc.edges || []).filter(e => e.from === 'n_start' && e.to === 'n_work')
  check('② 重复连线被去重', added.length === 1, `count=${added.length}`)
}

// ③ 端口拖到空白 → 创建菜单 → 选「工作」→ 新节点 + 自动连线（端口面向源）
{
  const root = fresh()
  const port = portEl(root, 'n_work', 'right')
  hitTargets.set('999,230', null) // 空白（与源节点同高的正右侧）
  port.props.onPointerDown({ button: 0, clientX: 650, clientY: 230, stopPropagation: noop })
  fire('pointerup', { clientX: 999, clientY: 230 })
  let doc = cells[0].value
  check('③ 空白落点不立即建边', (doc.edges || []).length === 0, JSON.stringify(doc.edges))
  const tree = render() // linkMenu 已置位 → 重渲染出创建菜单
  const workItem = findBy(tree, el => el.props.className === 'awbc-menu-item' && el.props.key === 'work')[0]
  check('③ 弹出创建菜单含「工作」项', Boolean(workItem))
  if (workItem) {
    workItem.props.onClick()
    doc = cells[0].value
    const newNode = (doc.nodes || []).find(n => !['n_start', 'n_work', 'n_end'].includes(n.id))
    check('③ 新工作节点已创建', Boolean(newNode), JSON.stringify((doc.nodes || []).map(n => n.id)))
    const linked = (doc.edges || []).find(e => e.from === 'n_work' && newNode && e.to === newNode.id)
    check('③ 新节点自动连线', Boolean(linked), JSON.stringify(doc.edges))
    check('③ 自动连线端口面向源(右→左)', Boolean(linked) && linked.fromPort === 'right' && linked.toPort === 'left', linked ? `${linked.fromPort}->${linked.toPort}` : '')
  }
}

// ④ 工具栏连线模式：点源 → 点目标 → 建边
{
  const root = fresh()
  const btn = findBy(root, el => el.props.key === 'connect')[0]
  check('④ 找到工具栏连线按钮', Boolean(btn))
  if (btn) {
    btn.props.onClick()
    let tree = render()
    tap(tree, 'n_start') // 连线模式下点节点 = 选它作源
    tree = render()
    const hint = findBy(tree, el => el.props.key === 'connect-hint')[0]
    check('④ 选源后出现连线提示', Boolean(hint))
    tap(tree, 'n_work')
    const doc = cells[0].value
    const added = (doc.edges || []).filter(e => e.from === 'n_start' && e.to === 'n_work')
    check('④ 两点点击 → 建边', added.length === 1, JSON.stringify(doc.edges))
    tree = render()
    check('④ 建边后提示消失', !findBy(tree, el => el.props.key === 'connect-hint')[0])
  }
}

// ⑤ 落回源节点自身 → 取消（无边、无菜单）
{
  const root = fresh()
  const port = portEl(root, 'n_work', 'right')
  const selfEl = { closest: sel => (sel === '[data-node-id]' ? { getAttribute: () => 'n_work' } : null) }
  hitTargets.set('620,230', selfEl)
  port.props.onPointerDown({ button: 0, clientX: 650, clientY: 230, stopPropagation: noop })
  fire('pointerup', { clientX: 620, clientY: 230 })
  const doc = cells[0].value
  const menu = cells.find(c => c.value && typeof c.value === 'object' && c.value.fromId)
  check('⑤ 落回源节点取消', (doc.edges || []).length === 0 && !menu, JSON.stringify(doc.edges))
}

// ⑥ 结束节点向外拉 → 拦截（不注册监听、不建边）
{
  const root = fresh()
  const port = portEl(root, 'n_end', 'left')
  port.props.onPointerDown({ button: 0, clientX: 880, clientY: 230, stopPropagation: noop })
  const doc = cells[0].value
  check('⑥ end 外拉被拦截', (winListeners.get('pointermove') || []).length === 0 && (doc.edges || []).length === 0)
}

// ⑦ 面板钩子卡拖到节点上 → 节点挂钩子并直接弹时机菜单 → 选时机 → 重开菜单移除
{
  const root = fresh()
  const hookCard = findBy(root, el => el.props.key === 'type-hook')[0]
  check('⑦ 元素库有钩子卡片', Boolean(hookCard))
  if (hookCard) {
    const fakeTarget = { closest: sel => (sel === '[data-node-id]' ? { getAttribute: () => 'n_work' } : null) }
    hitTargets.set('560,225', fakeTarget)
    hookCard.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, preventDefault: noop })
    fire('pointerup', { clientX: 560, clientY: 225 })
    let doc = cells[0].value
    const work = (doc.nodes || []).find(n => n.id === 'n_work')
    check('⑦ 钩子挂到目标节点', work && (work.hooks || []).length === 1, JSON.stringify(work && work.hooks))
    const menuCell = cells.find(c => c.value && typeof c.value === 'object' && c.value.nodeId === 'n_work' && c.value.hookId)
    check('⑦ 拖放后自动弹时机菜单', Boolean(menuCell))
    let tree = render()
    const item = findBy(tree, el => el.props.className === 'awbc-menu-item' && el.props.key === 'subagent-end')[0]
    check('⑦ 菜单含八大时机项', Boolean(item))
    if (item) {
      item.props.onClick()
      doc = cells[0].value
      const work2 = (doc.nodes || []).find(n => n.id === 'n_work')
      check('⑧ 时机已选中', work2.hooks[0].timing === 'subagent-end', JSON.stringify(work2.hooks))
      tree = render()
      check('⑧ 选完菜单关闭', !cells.find(c => c.value && typeof c.value === 'object' && c.value.hookId))
      const chip = findBy(tree, el => el.props.className === 'awbc-hookchip')[0]
      check('⑨ 节点底边长出钩子小块', Boolean(chip))
      if (chip) {
        chip.props.onClick({ clientX: 560, clientY: 260, stopPropagation: noop })
        tree = render()
        const removeBtn = findBy(tree, el => el.props.className === 'awbc-menu-item' && el.props.key === 'hook-remove')[0]
        check('⑨ 点小块重开菜单含移除', Boolean(removeBtn))
        if (removeBtn) {
          removeBtn.props.onClick()
          doc = cells[0].value
          const work3 = (doc.nodes || []).find(n => n.id === 'n_work')
          check('⑨ 移除后钩子清空', ((work3.hooks || []).length === 0), JSON.stringify(work3.hooks))
        }
      }
    }
  }
}

// ⑩ 钩子卡拖到空白 → 不挂、不弹菜单（提示由 toast 承担）
{
  const root = fresh()
  const hookCard = findBy(root, el => el.props.key === 'type-hook')[0]
  hitTargets.set('999,999', null)
  hookCard.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, preventDefault: noop })
  fire('pointerup', { clientX: 999, clientY: 999 })
  const doc = cells[0].value
  const anyHooks = (doc.nodes || []).some(n => (n.hooks || []).length > 0)
  check('⑩ 空白落点不挂钩子', !anyHooks && !cells.find(c => c.value && typeof c.value === 'object' && c.value.hookId))
}

// ⑪ 旧模型迁移：hook 孤岛节点按连线归主，无连线归主会话；hook 节点与旧边消失
{
  cells = []
  refs = []
  cellCursor = 0
  refCursor = 0
  winListeners.clear()
  hitTargets.clear()
  T.WORKBENCH.doc = T.normalizeDoc({
    id: 'sim-legacy',
    name: '旧画布',
    nodes: [
      { id: 'n_start', type: 'start', label: '主会话', x: 100, y: 200 },
      { id: 'n_work', type: 'work', label: '工作B', x: 500, y: 200 },
      { id: 'n_hook', type: 'hook', label: '检查产出', hookKind: 'subagent-end', note: '', x: 700, y: 300 },
      { id: 'n_hook2', type: 'hook', label: '开场动作', hookKind: 'session-start', note: '', x: 100, y: 50 },
    ],
    edges: [
      { id: 'e1', from: 'n_start', to: 'n_work' },
      { id: 'e2', from: 'n_work', to: 'n_hook' },
      { id: 'e3', from: 'n_start', to: 'n_hook2' },
    ],
  })
  render()
  const doc = cells[0].value
  const work = (doc.nodes || []).find(n => n.id === 'n_work')
  const start = (doc.nodes || []).find(n => n.id === 'n_start')
  check('⑪ 旧钩子节点不再出现', !(doc.nodes || []).some(n => n.type === 'hook'), JSON.stringify((doc.nodes || []).map(n => n.type)))
  check('⑪ 有连线的旧钩子归连线对端', work && (work.hooks || []).some(hk => hk.timing === 'subagent-end'), JSON.stringify(work && work.hooks))
  check('⑪ 旧边一并清掉', (doc.edges || []).length === 1 && doc.edges[0].from === 'n_start' && doc.edges[0].to === 'n_work', JSON.stringify(doc.edges))
}

if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
console.log('RESULT: ALL PASS')

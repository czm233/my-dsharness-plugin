#!/usr/bin/env node
/*
 * 渲染层装机门禁（PITFALLS #22 的落盘物）：
 *   stub React/DOM → 把测试钩子注进【真实 client.js】的临时副本 → require 它 →
 *   用 ~/.dsh/storages/agent-workflow-board/canvas-*.json 里的全部画布逐张全量渲染。
 *
 * 用法：node agent-workflow-board/test/render-harness.cjs
 * 退出码：全绿 0；任何一张画布渲染抛错 1。
 *
 * 背景：2.14.5→2.14.7 三连黑屏事故的根因是"装机前只做 node --check（纯语法）+
 * 手拼代码做无头验证（测的不是装出去那份文件）"。此 harness 强制加载真实文件本体，
 * 历史上若先跑它，三个坏版本一个都出不去。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---- stub DOM（client.js 渲染路径只用 canvas 2d 测宽 + window 常量）----
const ctx2d = { set font(v) {}, measureText: t => ({ width: String(t).length * 12 }) }
global.document = { createElement: () => ({ getContext: () => ctx2d }) }
global.window = {
  __ModuleLoader__: { load: m => { global.__mod = m } },
  innerWidth: 1600,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
}

// ---- stub React：createElement 强制求值所有实参（即整棵渲染树真实执行）----
const noop = () => {}
const React = {
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(9) }),
  useState: v => [typeof v === 'function' ? v() : v, noop],
  useRef: v => ({ current: v }),
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: fn => fn(),
  useCallback: fn => fn,
}

// ---- 从真实 client.js 生成带钩子的临时副本（不改原文件）----
const clientPath = path.join(__dirname, '..', 'client.js')
const src = fs.readFileSync(clientPath, 'utf8')
const lines = src.split('\n')
let idx = -1
for (let i = lines.length - 1; i >= 0; i--) {
  // 模块级 return 是 4 空格缩进；组件内部 return 缩进更深
  if (lines[i] === '    return {') { idx = i; break }
}
if (idx < 0) { console.error('ANCHOR NOT FOUND: 模块级 "    return {" 不在了，client.js 结构变了，先更新本 harness 的注入锚点'); process.exit(1) }
lines.splice(idx, 0, '    window.__test = { CanvasPage, WORKBENCH, normalizeDoc, emptyDoc, edgeGeometry, routeAroundNodes, segHitsNode, measureNodeWidth, NODE_H }')
const tmp = path.join(os.tmpdir(), 'awb-render-harness.cjs')
fs.writeFileSync(tmp, lines.join('\n'))
require(tmp)
global.__mod.factory(id => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
const T = global.window.__test
if (!T || !T.CanvasPage) { console.error('HOOK FAILED: 钩子没生效，检查注入位置'); process.exit(1) }

// ---- 逐张渲染真实画布 + 一张空画布 ----
const storageDir = path.join(os.homedir(), '.dsh', 'storages', 'agent-workflow-board')
const files = fs.existsSync(storageDir)
  ? fs.readdirSync(storageDir).filter(f => /^canvas-.*\.json$/.test(f)).sort().map(f => path.join(storageDir, f))
  : []
const cases = files.length > 0 ? files : null
let failed = 0
const labelOf = doc => id => (doc.nodes.find(n => n.id === id) || {}).label || id
const run = (name, rawDoc) => {
  try {
    const doc = T.normalizeDoc(rawDoc)
    T.WORKBENCH.doc = doc
    const tree = T.CanvasPage({ sessionId: 'render-harness' })
    if (!tree || typeof tree !== 'object') throw new Error('render returned nothing')
    // 穿卡断言：任何边的中间段（跳过首尾端口短线）穿过第三方节点 → FAIL
    const nodesById = new Map(doc.nodes.map(n => [n.id, n]))
    let crossings = 0
    for (const edge of doc.edges || []) {
      const from = nodesById.get(edge.from)
      const to = nodesById.get(edge.to)
      if (!from || !to) continue
      const base = T.edgeGeometry(from, to, edge.fromPort, edge.toPort, edge.label)
      const pts = T.routeAroundNodes(base.pts, base.axis, doc.nodes, edge.from, edge.to)
      for (let i = 1; i < pts.length - 2; i++) {
        const a = pts[i]
        const b = pts[i + 1]
        for (const n of doc.nodes) {
          if (n.id === edge.from || n.id === edge.to) continue
          if (T.segHitsNode(a, b, n)) {
            crossings++
            const lbl = id => (doc.nodes.find(nn => nn.id === id) || {}).label || id
            console.log('CROSS', name, '::', lbl(edge.from), '→', lbl(edge.to), '穿过', n.label)
          }
        }
      }
    }
    if (crossings > 0) throw new Error(crossings + ' 处线穿节点')
    console.log('PASS', name)
  } catch (e) {
    failed++
    console.log('FAIL', name, '::', String(e && e.message ? e.message : e).slice(0, 200))
  }
}
if (cases) for (const f of cases) run(path.basename(f), JSON.parse(fs.readFileSync(f, 'utf8')))
// v2.19.0：带 model/onModelMissing 字段的合成画布也要全量渲染（节点模型/角色默认/失效策略三种形态）
run('(model doc)', {
  version: 1,
  id: 'model-sim',
  name: '模型字段渲染',
  projectDir: '',
  updatedAt: 0,
  nodes: [
    { id: 's', type: 'start', label: '主会话', x: 0, y: 0 },
    { id: 'w1', type: 'work', label: '带模型节点', exec: 'subagent', model: { provider: 'p1', id: 'm1' }, onModelMissing: 'fallback', x: 260, y: 0 },
    { id: 'w2', type: 'work', label: '停止策略节点', exec: 'subagent', model: { provider: 'gone', id: 'dead' }, onModelMissing: 'stop', agent: 'some-role', x: 520, y: 0 },
    { id: 'w3', type: 'work', label: '主会话自己做', exec: 'lead', x: 780, y: 0 },
    { id: 'e', type: 'end', label: '结束', x: 1040, y: 0 },
  ],
  edges: [
    { id: 'e1', from: 's', to: 'w1', fromPort: 'right', toPort: 'left', label: '' },
    { id: 'e2', from: 'w1', to: 'w2', fromPort: 'right', toPort: 'left', label: '' },
    { id: 'e3', from: 'w2', to: 'w3', fromPort: 'right', toPort: 'left', label: '' },
    { id: 'e4', from: 'w3', to: 'e', fromPort: 'right', toPort: 'left', label: '' },
  ],
})
// normalizeDoc 必须保留 model/onModelMissing 且强制派发（exec:'lead' 与模型互斥）
{
  const kept = T.normalizeDoc({
    nodes: [
      { id: 's', type: 'start', label: '主会话', x: 0, y: 0 },
      { id: 'w', type: 'work', label: 'W', exec: 'lead', model: { provider: 'p', id: 'm' }, onModelMissing: 'stop', x: 200, y: 0 },
      { id: 'w2', type: 'work', label: 'W2', exec: 'subagent', x: 400, y: 0 },
      // 角色默认模型 + 弹窗降级产物：无 node.model 但显式 onModelMissing，必须保留
      { id: 'w3', type: 'work', label: 'W3', exec: 'subagent', onModelMissing: 'fallback', x: 600, y: 0 },
    ],
    edges: [{ id: 'e1', from: 's', to: 'w' }, { id: 'e2', from: 'w', to: 'w2' }, { id: 'e3', from: 'w2', to: 'w3' }],
  })
  const w = kept.nodes.find(n => n.id === 'w')
  const w2 = kept.nodes.find(n => n.id === 'w2')
  const w3 = kept.nodes.find(n => n.id === 'w3')
  const keepOk = w.model && w.model.provider === 'p' && w.model.id === 'm' && w.onModelMissing === 'stop' && w.exec === 'subagent'
  const cleanOk = w2.model === undefined && w2.onModelMissing === undefined
  const demoteOk = w3.model === undefined && w3.onModelMissing === 'fallback'
  if (keepOk && cleanOk && demoteOk) console.log('PASS (normalizeDoc keeps model / demoted policy / old shape untouched)')
  else { failed++; console.log('FAIL (normalizeDoc model) ::', JSON.stringify({ w, w2, w3 })) }
}
run('(empty doc)', T.emptyDoc())
if (!cases) console.log('(storage 里没有画布，仅渲染空画布)')

if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
console.log('RESULT: ALL PASS')

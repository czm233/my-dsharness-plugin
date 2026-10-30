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
lines.splice(idx, 0, '    window.__test = { CanvasPage, WORKBENCH, normalizeDoc, emptyDoc }')
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
const run = (name, doc) => {
  try {
    T.WORKBENCH.doc = T.normalizeDoc(doc)
    const tree = T.CanvasPage({ sessionId: 'render-harness' })
    if (!tree || typeof tree !== 'object') throw new Error('render returned nothing')
    console.log('PASS', name)
  } catch (e) {
    failed++
    console.log('FAIL', name, '::', String(e && e.message ? e.message : e).slice(0, 200))
  }
}
if (cases) for (const f of cases) run(path.basename(f), JSON.parse(fs.readFileSync(f, 'utf8')))
run('(empty doc)', T.emptyDoc())
if (!cases) console.log('(storage 里没有画布，仅渲染空画布)')

if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
console.log('RESULT: ALL PASS')

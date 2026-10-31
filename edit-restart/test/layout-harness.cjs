#!/usr/bin/env node
/*
 * edit-restart 装机前门禁：加载【真实 client.js】，在最小假 DOM 上跑真实扫描/装饰链路。
 *
 * 用法：node edit-restart/test/layout-harness.cjs
 * 退出码：全绿 0；任何断言失败 1。
 *
 * 假 DOM 复刻 0.2.1-rc.5 真实的 Chat 结构：一条用户消息 =
 *   气泡列（*_userRow）里放气泡本体（*_userStack）与操作行（*_actions，含复制按钮），
 * 助手消息没有 _userRow，必须不被认成用户消息。
 *
 * 覆盖：
 *   1. 认出用户消息（气泡列/气泡本体/操作行），助手消息不误认；
 *   2. 唯一「修改」按钮挂在最新消息的装饰落点上，落点带装饰 class；
 *   3. 切换会话后按钮迁到新会话；
 *   4. 点「修改」→ 按「第 index 条人发消息」定位 → fork 切点 = 该消息自己那一轮的 turn/start
 *      → 改过的文本作为首条消息发进分支会话 → 切到分支会话。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { installDocument, buildConversation, mutations } = require('./stub-dom.cjs')

// ---- document / window / React 桩 ----
const { body } = installDocument()

let rafQueue = []
global.window = {
  __ModuleLoader__: { load: (mod) => { global.__mod = mod } },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length },
  cancelAnimationFrame() {},
  setTimeout: global.setTimeout,
  innerWidth: 1600,
  innerHeight: 900,
  addEventListener() {},
  removeEventListener() {},
}
global.requestAnimationFrame = global.window.requestAnimationFrame
// MutationObserver 桩：订阅回调在 installed 列表里，harness 手动 flush（对齐真实浏览器的一帧）。
const observers = []
global.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.active = false }
  observe() { this.active = true; observers.push(this) }
  disconnect() { this.active = false }
}
const flushMutations = () => {
  mutations.length = 0
  for (const observer of observers) if (observer.active) observer.callback([])
}
// 用真实定时器：client.js 里有超时守卫，桩成"立即执行"会让守卫误触发。
const realSetTimeout = require('node:timers').setTimeout
global.setTimeout = (fn, ms) => { const handle = realSetTimeout(fn, ms); handle.unref?.(); return handle }
global.clearTimeout = () => {}
// fetch 桩：Host 的 resolve 通道可用（返回第 2 条人发消息 = seq 15 / turn 14）
global.fetch = async (url, options) => {
  const body = options && options.body ? JSON.parse(options.body) : {}
  if (String(url).includes('edit-restart/rpc') && body.action === 'resolve') {
    return { status: 200, json: async () => ({ ok: true, found: true, initial: '教我 C++', turnStartSeq: 14, seq: 15 }) }
  }
  if (String(url).includes('edit-restart/rpc') && body.action === 'saveDraft') {
    return { status: 200, json: async () => ({ ok: true, draft: { id: 'draft-1' } }) }
  }
  return { status: 200, json: async () => ({ ok: true }) }
}

const React = {
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(9) }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect() {},
  useLayoutEffect() {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
  memo: (fn) => fn,
}

/** 最小渲染器：把根上渲染的元素建成 DOM；事件处理器写到节点上供测试调用。 */
const roots = []
function toDom(element) {
  if (element === null || element === undefined || typeof element !== 'object' || element.tag === undefined) return null
  if (typeof element.tag === 'function') return toDom(element.tag({ ...element.props, children: element.children }))
  if (element.tag === 'Fragment') return null
  const node = document.createElement(element.tag)
  for (const [key, value] of Object.entries(element.props)) {
    if (/^on[A-Z]/.test(key)) { node[key] = value; continue }
    if (key === 'value') { node.value = value; continue }
    if (key === 'ref' || key === 'children' || value === undefined || value === null || value === false) continue
    if (key.startsWith('data-') || key.startsWith('aria-')) { node.setAttribute(key, value === true ? '' : String(value)); continue }
    if (key === 'className' && typeof value === 'string') {
      node.className = value
      for (const name of value.split(/\s+/)) if (name !== '') node.classList.add(name)
    }
  }
  for (const child of element.children) {
    const childNode = toDom(child)
    if (childNode) node.appendChild(childNode)
  }
  return node
}
const reactDomClient = {
  createRoot(container) {
    const root = {
      container,
      render(element) {
        container.children = []
        if (element === null) return
        const node = toDom(Array.isArray(element) ? element[0] : element)
        if (node) container.appendChild(node)
      },
      unmount() { container.children = [] },
    }
    roots.push(root)
    return root
  },
}
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react-dom/client') return reactDomClient
  throw new Error('unexpected require: ' + id)
}

// ---- 加载真实 client.js（注入测试钩子） ----
const lines = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8').split('\n')
let anchor = -1
for (let i = lines.length - 1; i >= 0; i -= 1) {
  if (lines[i] === '    return {') { anchor = i; break }
}
if (anchor < 0) {
  console.error('ANCHOR NOT FOUND: 模块级 "    return {" 不在了，client.js 结构变了，先更新本 harness 的注入锚点')
  process.exit(1)
}
lines.splice(anchor, 0, '    window.__test = { scanChat, userMessageIn, turnStartFor, humanMessage, isHumanMessage, editableText }')
const tmp = path.join(os.tmpdir(), 'edit-restart-harness.cjs')
fs.writeFileSync(tmp, lines.join('\n'))
require(tmp)
const plugin = global.__mod.factory(requireStub)
const T = global.window.__test

// ---- 假会话服务 ----
const calls = { fork: [], prompt: [], opened: [] }
const events = [
  { type: 'turn/start', seq: 4, data: { turn: 1 } },
  { type: 'user/message', seq: 8, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } },
  { type: 'user/message', seq: 9, surfaceOp: 'append', data: { source: { kind: 'context' }, content: [{ type: 'text', text: '注入上下文' }] } },
  { type: 'assistant/message', seq: 10, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } },
  { type: 'turn/end', seq: 11, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 14, data: { turn: 2 } },
  { type: 'user/message', seq: 15, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '教我 C++' }] } },
  { type: 'assistant/message', seq: 16, data: { turn: 2, step: 1, message: { role: 'assistant', content: [] } } },
]
const fakeSession = {
  events: { getSnapshot: () => ({ entries: events.map((event) => ({ event })) }) },
  getSnapshot: () => ({ running: false, hasMore: false }),
  loadThrough: async () => {},
  prompt: async (content, mode) => { calls.prompt.push({ content, mode }) },
}
// 复刻官方 client service 形状：using 的回调参数是 reference（不是 Session），
// 真正的 Session 只能通过 scope(id) + sessionOf(ctx) 拿到。
const scopeObjects = new Map()
for (const id of ['sess-1', 'sess-2', 'sess-child']) scopeObjects.set(id, { id })
const sessions = {
  binding: (id) => {
    if (id === 'sess-child') return undefined
    const scope = sessions.scope(id)
    return scope ? { session: scope } : undefined
  },
  using: async (id, options, operation) => operation({ ready: Promise.resolve() }),
  scope: (id) => {
    const scope = scopeObjects.get(id)
    if (!scope) return undefined
    Object.setPrototypeOf(scope, fakeSession)
    scope.getSnapshot = () => ({ sessionId: id, running: false, hasMore: false })
    return scope
  },
  sessionOf: (ctx) => (ctx && typeof ctx.getSnapshot === 'function' ? ctx : undefined),
  retain: () => ({ ready: Promise.resolve(), release() {} }),
  fork: async (request) => { calls.fork.push(request); return 'sess-child' },
}
const ctx = {
  locale: { register() {}, bind: () => (key) => key },
  get: (name) => {
    if (name === 'sessions') return sessions
    if (name === 'uiWorkspace') return { openSession: (id) => calls.opened.push(id) }
    return undefined
  },
  effect: (fn) => { const cleanup = fn(); global.__cleanup = cleanup },
}

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok  ${label}`)
  else { failures.push(label); console.error(`FAIL  ${label}${detail === undefined ? '' : ' :: ' + detail}`) }
}

async function main() {
  console.log('[1] 真实 client.js：结构识别与装饰')
  check('模块级 return 已拿到 apply', typeof plugin.apply === 'function')
  const tree = buildConversation('sess-1')
  body.appendChild(tree.content)
  plugin.apply(ctx)
  for (const fn of rafQueue) fn()
  rafQueue = []

  const scanned = T.scanChat(tree.content)
  check('扫描到 2 条用户消息', scanned.length === 2, `got ${scanned.length}`)
  check('认出气泡列/气泡本体/操作行', scanned.length === 2
    && scanned[0].row === tree.first.column && scanned[0].bubble === tree.first.bubble
    && scanned[0].actions === tree.first.actionsRow
    && scanned[1].bubble === tree.second.bubble)

  const actionEl = roots[0].container
  check('「修改」按钮进的是官方操作行（复制按钮旁边）', actionEl.parentElement === tree.second.actionsRow,
    `parent=${actionEl.parentElement && actionEl.parentElement.getAttribute('class')}`)
  check('「修改」按钮沿用复制按钮的类名', actionEl.className === tree.second.copyButton.getAttribute('class'),
    `${actionEl.className} vs ${tree.second.copyButton.getAttribute('class')}`)
  check('落点带装饰 class', tree.second.column.classList.contains('dsh-edit-restart-column'))
  check('两条用户消息的气泡列都打上了 ready 标记',
    tree.content.querySelectorAll('[data-edit-restart-ready]').length === 2)

  console.log('[2] 切换会话：按钮迁到新会话')
  tree.content.remove()
  const other = buildConversation('sess-2')
  body.appendChild(other.content)
  flushMutations()
  const pending = rafQueue
  rafQueue = []
  for (const fn of pending) fn()
  check('切换后触发了重新扫描', pending.length > 0)
  check('按钮迁到新会话的最新消息操作行里', actionEl.parentElement === other.second.actionsRow)

  console.log('[3] 点「修改」→ 定位 → 发送 → fork 切点')
  const fakeEvent = { stopPropagation() {}, preventDefault() {} }
  const onClick = actionEl.onClick || (actionEl.children[0] && actionEl.children[0].onClick)
  check('「修改」按钮有点击处理器', typeof onClick === 'function')
  flushMutations()
  await onClick(fakeEvent)
  for (let tick = 0; tick < 6; tick += 1) await Promise.resolve()

  const layerRoot = roots[1].container
  const layer = layerRoot.children[0]
  check('编辑框顶替气泡位置（气泡列里、紧挨气泡之前）', layer !== undefined
    && layer.getAttribute('data-active') === 'true'
    && layerRoot.parentElement === other.second.column
    && layerRoot.nextElementSibling === other.second.bubble)
  check('编辑期间原气泡让位隐藏', other.second.bubble.style.display === 'none')
  const textarea = layer && layer.querySelector('textarea')
  check('编辑框回填的是第 2 条人发消息的正文', textarea !== undefined && textarea.value === '教我 C++',
    JSON.stringify(textarea && textarea.value))
  const send = layer && layer.querySelector('button.dsh-edit-restart-send')
  check('有发送按钮', send !== undefined)
  await send.onClick()
  check('只 fork 一次', calls.fork.length === 1, JSON.stringify(calls.fork))
  check('fork 切点 = 这条消息自己那一轮的 turn/start(14)', calls.fork[0]?.atSeq === 14, JSON.stringify(calls.fork[0]))
  check('fork 源会话正确', calls.fork[0]?.sessionId === 'sess-2')
  check('新文本发进分支会话', calls.prompt.length === 1 && calls.prompt[0].content[0].text === '教我 C++',
    JSON.stringify(calls.prompt))
  check('切到分支会话', calls.opened[0] === 'sess-child', JSON.stringify(calls.opened))

  if (typeof global.__cleanup === 'function') global.__cleanup()
  console.log('')
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} 项失败`)
    process.exit(1)
  }
  console.log('✓ all green')
}

main().catch((error) => {
  console.error('HARNESS ERROR', error)
  process.exit(1)
})
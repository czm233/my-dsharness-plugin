#!/usr/bin/env node
/*
 * side-chat 装机前门禁：加载【真实 client.js】，用最小 React hook 运行时复刻
 * tab body 的挂载/卸载生命周期，验证「fork 型子代理」新生命周期（0.3.0）。
 *
 * 用法：node side-chat/test/branch-lifecycle.cjs
 * 退出码：全绿 0；任何断言失败 1。
 *
 * 覆盖：
 *   1. tab 类型注册带 keepMounted（会话切走时 body 不卸载）；
 *   2. 首次挂载（无映射）：渲染首条消息界面，不 retain、不创建、无映射；
 *   3. 发送首条消息：POST /api/side-chat/create，映射落 localStorage，
 *      以 subagent 地址对象 retain，渲染出 child 会话；
 *   4. 创建失败：映射不落、回到首条消息界面并显示失败；
 *   5. 切会话导致 body 卸载：只 release，映射必须保留；
 *   6. 切回重挂载：复用同一个 child，不再 POST；
 *   7. 页面重载（模块重新加载、内存映射清空）：仍从 localStorage 复用；
 *   8. 不同父会话同名 tab id（tab1）：互不串号，各自创建；
 *   9. 死映射（child 无法 resolve）：清掉映射，回到首条消息界面；
 *  10. 同一个 tab 永远只绑定一个 child；
 *  11. 预览阶段渲染官方 conversation.view（only chat），划词引用写成引用块进草稿。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---- 浏览器桩 ----
const storage = new Map()
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}
global.document = {
  head: { appendChild: (node) => node },
  createElement: () => ({ textContent: '', remove() {} }),
}
global.window = {
  addEventListener() {},
  removeEventListener() {},
}

// ---- 最小 React hook 运行时 ----
// 只实现 client.js 用到的 hooks；状态更新同步排队，flush() 统一重渲染。
let currentInstance = null
const renderQueue = []
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

function schedule(instance) {
  if (instance.unmounted || instance.queued) return
  instance.queued = true
  renderQueue.push(instance)
}

const React = {
  Fragment: 'Fragment',
  createElement: (tag, props, ...children) => ({ tag, props: props || {}, children }),
  useState(initial) {
    const instance = currentInstance
    const index = instance.cursor++
    if (instance.hooks[index] === undefined) {
      instance.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const cell = instance.hooks[index]
    const set = (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (Object.is(value, cell.value)) return
      cell.value = value
      schedule(instance)
    }
    return [cell.value, set]
  },
  useEffect(effect, deps) {
    const instance = currentInstance
    const index = instance.cursor++
    const previous = instance.hooks[index]
    instance.hooks[index] = {
      kind: 'effect',
      deps: previous && previous.kind === 'effect' ? previous.deps : undefined,
      cleanup: previous && previous.kind === 'effect' ? previous.cleanup : undefined,
      pending: effect,
      nextDeps: deps,
    }
  },
  useLayoutEffect(effect, deps) { React.useEffect(effect, deps) },
  useRef(value) {
    const instance = currentInstance
    const index = instance.cursor++
    if (instance.hooks[index] === undefined) instance.hooks[index] = { kind: 'ref', value }
    return instance.hooks[index]
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}

function commitEffects(instance) {
  for (const cell of instance.hooks) {
    if (cell === undefined || cell.kind !== 'effect' || cell.pending === undefined) continue
    const changed = cell.deps === undefined || !sameDeps(cell.deps, cell.nextDeps)
    if (changed) {
      if (cell.cleanup !== undefined) cell.cleanup()
      cell.cleanup = cell.pending()
      cell.deps = cell.nextDeps
    }
    cell.pending = undefined
    cell.nextDeps = undefined
  }
}

function flush() {
  let guard = 0
  while (renderQueue.length > 0 && guard++ < 100) {
    const instance = renderQueue.shift()
    instance.queued = false
    if (instance.unmounted) continue
    instance.render()
    commitEffects(instance)
  }
}

function mount(component, props) {
  const instance = { component, props, hooks: [], cursor: 0, queued: false, unmounted: false }
  instance.render = () => {
    currentInstance = instance
    instance.cursor = 0
    instance.output = component(props)
    currentInstance = null
  }
  instance.unmount = () => {
    instance.unmounted = true
    for (const cell of instance.hooks) {
      if (cell !== undefined && cell.kind === 'effect' && cell.cleanup !== undefined) {
        cell.cleanup()
        cell.cleanup = undefined
      }
    }
  }
  instance.render()
  commitEffects(instance)
  flush()
  return instance
}

async function settle() {
  for (let tick = 0; tick < 30; tick += 1) {
    await Promise.resolve()
    flush()
  }
}

// ---- 假服务 ----
function createWorld() {
  const byId = { A: { id: 'A' }, B: { id: 'B' } }
  let serial = 0
  const calls = { create: [], retain: [], release: [] }
  const deadChildren = new Set()
  let failNext = false
  const list = {
    phase: 'ready',
    byId,
    subscribe: () => () => {},
  }
  const bindings = {}
  const sessions = {
    list: { getSnapshot: () => list, subscribe: () => () => {} },
    binding(id) { return bindings[id] },
    retain(target) {
      calls.retain.push(target)
      const id = typeof target === 'string' ? target : target.childSessionId
      const reference = {
        sessionId: id,
        ready: deadChildren.has(id) ? Promise.reject(new Error(`subagent/not-found: ${id}`)) : Promise.resolve(),
        release() { calls.release.push(id) },
      }
      if (deadChildren.has(id)) reference.ready.catch(() => {})
      return reference
    },
  }
  const diagnostics = []
  global.fetch = async (path, init) => {
    const body = JSON.parse(init.body)
    // 诊断上报走独立路由，不能混进创建请求的断言
    if (path === '/api/side-chat/log') {
      diagnostics.push(body)
      return { ok: true, status: 204, json: async () => undefined }
    }
    calls.create.push(body)
    if (failNext) {
      failNext = false
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
    }
    serial += 1
    const id = `child-${serial}`
    byId[id] = { id, title: body.text }
    return { ok: true, status: 200, json: async () => ({ childId: id, label: body.text }) }
  }
  return {
    byId, calls, list, sessions, deadChildren, diagnostics,
    markDead(id) { deadChildren.add(id) },
    failNextCreate() { failNext = true },
    // 父会话的活事件窗：预览从 (type, event) 条目里读最近轮次
    bind(id, events) {
      bindings[id] = {
        eventSource: {
          getSnapshot: () => ({ entries: events.map(event => ({ type: 'durable', event })) }),
          subscribe: () => () => {},
        },
      }
    },
  }
}

let loadSerial = 0
function loadPlugin() {
  const loaded = []
  global.window.__ModuleLoader__ = { load: (mod) => loaded.push(mod) }
  // 复制到独立临时文件再 require：package.json 是 type=module，同一路径第二次
  // require 会命中 Node 的 ESM 缓存而不重新执行，模拟不了“页面重载”。
  loadSerial += 1
  const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')
  const copy = path.join(os.tmpdir(), `side-chat-harness-${process.pid}-${loadSerial}.cjs`)
  fs.writeFileSync(copy, source)
  require(copy)
  if (loaded.length !== 1) throw new Error(`expected one module registration, got ${loaded.length}`)
  return loaded[0].factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require: ${specifier}`)
  })
}

function activate(plugin, world) {
  const registered = { slots: new Map(), tabType: undefined }
  const ctx = {
    sessions: world.sessions,
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} },
    inject: (names, callback) => callback(),
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registered.slots.set(options.name, { options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => { registered.tabType = definition; return () => {} },
    },
  }
  plugin.apply(ctx)
  const body = registered.slots.get('sidebar.right.pane.tab')
  if (body === undefined) throw new Error('tab body slot was not registered')
  return { ...registered, ForkChatTab: body.component }
}

const slotCalls = []
function tabProps(sessionId, tabId) {
  return {
    useTabInfo: () => ({ tab: { id: tabId, kind: 'forkchat', signal: new AbortController().signal } }),
    useSession: (selector) => selector({ sessionId }),
    SessionProvider: 'SessionProvider',
    renderSlot: (name, props, options) => {
      slotCalls.push({ name, props, options })
      return null
    },
  }
}

const branchStorageKey = (sessionId, tabId) => `dsh.side-chat.branch.v1.${JSON.stringify([sessionId, tabId])}`
const childOf = (instance) => {
  const provider = instance.output && instance.output.children[0]
  return provider && provider.props && provider.props.session && provider.props.session.sessionId
}
// 首条消息阶段：children[0] 是带 data-sidechat-pane 的容器，内含可选的
// 主对话只读预览，以及固定在最下方的首条消息输入区。
const paneOf = (instance) => {
  const pane = instance.output && instance.output.children[0]
  return pane !== null && pane !== undefined && pane.props && pane.props['data-sidechat-pane'] === '' ? pane : undefined
}
const isPhaseA = (instance) => paneOf(instance) !== undefined
// 预览外面套了一层安全边界（桩环境里 React.Component 缺失，边界退化成
// 透传组件），所以取第一个带 messages 的函数组件 vnode。
const previewOf = (instance) => {
  const pane = paneOf(instance)
  if (pane === undefined) return undefined
  const stack = Array.isArray(pane.children) ? [...pane.children] : []
  while (stack.length > 0) {
    const node = stack.shift()
    if (node === null || node === undefined || typeof node !== 'object') continue
    if (typeof node.tag === 'function' && node.props !== undefined) {
      if (typeof node.props.onQuote === 'function') return node
      if (node.children !== undefined) stack.push(...(Array.isArray(node.children) ? node.children : [node.children]))
      if (node.props.children !== undefined) stack.push(node.props.children)
      continue
    }
    if (Array.isArray(node.children)) stack.push(...node.children)
  }
  return undefined
}
const composerVNodeOf = (instance) => {
  const pane = paneOf(instance)
  if (pane === undefined) return undefined
  const kids = Array.isArray(pane.children) ? pane.children : []
  for (let index = kids.length - 1; index >= 0; index -= 1) {
    if (kids[index] !== null && kids[index] !== undefined && typeof kids[index].tag === 'function') return kids[index]
  }
  return undefined
}
// 函数组件的 vnode 在桩环境里不会自动执行；把它挂成一个可持续重渲染的
// 迷你实例，交互句柄触发的 setState 走正常 flush 重渲染。
function mountComponent(vnode) {
  if (vnode === null || vnode === undefined || typeof vnode.tag !== 'function') return undefined
  const instance = { vnode, hooks: [], cursor: 0, queued: false, unmounted: false }
  instance.render = () => {
    currentInstance = instance
    instance.cursor = 0
    // 复刻 React 语义：children 也出现在 props.children 上
    const kids = instance.vnode.children !== undefined && instance.vnode.children.length > 0
      ? (instance.vnode.children.length === 1 ? instance.vnode.children[0] : instance.vnode.children)
      : instance.vnode.props.children
    instance.output = instance.vnode.tag({ ...instance.vnode.props, children: kids })
    currentInstance = null
  }
  instance.unmount = () => {
    instance.unmounted = true
    for (const cell of instance.hooks) {
      if (cell !== undefined && cell.kind === 'effect' && cell.cleanup !== undefined) {
        cell.cleanup()
        cell.cleanup = undefined
      }
    }
  }
  instance.render()
  commitEffects(instance)
  flush()
  return instance
}
// 父组件状态变化后，把最新 vnode 的 props 灌回已挂载的子实例并重渲染：
// 桩环境不传播 props，这一步等价于真实 React 的 prop 更新。
function syncProps(instance, vnode) {
  if (instance === undefined || vnode === undefined) return
  instance.vnode = vnode
  instance.render()
  commitEffects(instance)
  flush()
}
function flattenText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'object' && node.props && node.props.children !== undefined) return flattenText(node.props.children)
  if (typeof node === 'object' && node.children !== undefined) return flattenText(node.children)
  return ''
}
// 收集可见文本：普通子节点 + 未挂载的函数组件的 props.text（预览正文
// 由 MessageText 渲染，桩环境不会执行它）。
function collectText(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (typeof node === 'string') { out.push(node); continue }
    if (Array.isArray(node)) { stack.push(...node); continue }
    if (typeof node !== 'object') continue
    if (node.props && typeof node.props.text === 'string') out.push(node.props.text)
    const kids = node.children !== undefined ? node.children : (node.props && node.props.children)
    if (kids !== undefined) stack.push(kids)
  }
  return out.join('\n')
}
function findButton(root, label) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (typeof node === 'object') {
      if (node.tag === 'button' && node.props) {
        const text = flattenText(node.children)
        const aria = typeof node.props['aria-label'] === 'string' ? node.props['aria-label'] : ''
        const title = typeof node.props.title === 'string' ? node.props.title : ''
        if (text === label || aria === label || title === label) return node
      }
      const kids = Array.isArray(node.children) ? node.children : (node.children !== undefined && typeof node.children !== 'object' ? [] : node.children)
      if (Array.isArray(kids)) stack.push(...kids)
      else if (kids && typeof kids === 'object') stack.push(kids)
    }
  }
  return undefined
}
function findTextarea(root) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (typeof node === 'object') {
      if (node.tag === 'textarea') return node
      const kids = Array.isArray(node.children) ? node.children : (node.children !== undefined && typeof node.children !== 'object' ? [] : node.children)
      if (Array.isArray(kids)) stack.push(...kids)
      else if (kids && typeof kids === 'object') stack.push(kids)
    }
  }
  return undefined
}

// ---- 断言 ----
const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok  ${label}`)
  else {
    failures.push(label)
    console.error(`FAIL  ${label}${detail === undefined ? '' : ' :: ' + detail}`)
  }
}

async function main() {
  const world = createWorld()

  console.log('[1] tab 类型注册：keepMounted 与会话级 tab key')
  const plugin = loadPlugin()
  const first = activate(plugin, world)
  check('注册 keepMounted: true', first.tabType.keepMounted === true, String(first.tabType.keepMounted))
  check('tab kind 为 forkchat 且 multiple', first.tabType.kind === 'forkchat' && first.tabType.multiple === true)

  console.log('[2] 首次挂载（无映射）：首条消息界面，不 retain 不创建')
  const a1 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('渲染首条消息界面', isPhaseA(a1) === true, String(a1.output && a1.output.children[0] && a1.output.children[0].tag))
  check('没有 retain', world.calls.retain.length === 0, JSON.stringify(world.calls.retain))
  check('没有创建请求', world.calls.create.length === 0, JSON.stringify(world.calls.create))
  check('映射不存在', storage.get(branchStorageKey('A', 'tab1')) === undefined)

  console.log('[3] 发送首条消息：POST 创建 + 地址 retain + 渲染 child')
  const composerInst = mountComponent(composerVNodeOf(a1))
  const composer = composerInst.output
  const textarea = findTextarea(composer)
  const sendButton = findButton(composer, 'first.send')
  check('界面含输入框与发送按钮', textarea !== undefined && sendButton !== undefined)
  textarea.props.onChange({ target: { value: 'hello side chat' } })
  flush()
  syncProps(composerInst, composerVNodeOf(a1))
  const sendButton2 = findButton(composerInst.output, 'first.send')
  await sendButton2.props.onClick()
  await settle()
  check('创建请求携带父会话与文本', JSON.stringify(world.calls.create) === JSON.stringify([{ sessionId: 'A', text: 'hello side chat' }]), JSON.stringify(world.calls.create))
  check('映射写入 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')
  const retainCall = world.calls.retain[world.calls.retain.length - 1]
  check('以 subagent 地址对象 retain', retainCall !== undefined && typeof retainCall === 'object' && retainCall.parentSessionId === 'A' && retainCall.childSessionId === 'child-1' && retainCall.mode === 'continuable', JSON.stringify(retainCall))
  check('渲染的是 child-1', childOf(a1) === 'child-1', String(childOf(a1)))

  console.log('[4] 创建失败：映射不落、回到首条消息界面并显示失败')
  const b0 = mount(first.ForkChatTab, tabProps('B', 'tab9'))
  await settle()
  world.failNextCreate()
  const composerBInst = mountComponent(composerVNodeOf(b0))
  const textareaB = findTextarea(composerBInst.output)
  textareaB.props.onChange({ target: { value: 'will fail' } })
  flush()
  syncProps(composerBInst, composerVNodeOf(b0))
  await findButton(composerBInst.output, 'first.send').props.onClick()
  await settle()
  check('失败后映射不存在', storage.get(branchStorageKey('B', 'tab9')) === undefined)
  check('失败后仍在首条消息界面', isPhaseA(b0) === true, String(b0.output && b0.output.children[0] && b0.output.children[0].tag))
  const failureView = mountComponent(composerVNodeOf(b0))
  check('失败文案已显示', flattenText(failureView.output).includes('fork.error'), flattenText(failureView.output).slice(0, 120))
  failureView.unmount()
  composerBInst.unmount()
  b0.unmount()

  console.log('[5] 切到别的会话导致卸载：只释放引用，映射保留')
  const createCountAfterFailure = world.calls.create.length
  a1.unmount()
  await settle()
  check('卸载时 release 了 child-1', world.calls.release.includes('child-1'), JSON.stringify(world.calls.release))
  check('映射仍在 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[6] 切回 A：重挂载复用同一 child，不再 POST')
  const a2 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('没有新的创建请求', world.calls.create.length === createCountAfterFailure, JSON.stringify(world.calls.create))
  check('重新 retain 的还是 child-1', world.calls.retain.filter((entry) => (typeof entry === 'object' ? entry.childSessionId : entry) === 'child-1').length === 2)
  check('渲染的仍是 child-1', childOf(a2) === 'child-1', String(childOf(a2)))

  console.log('[7] 页面重载：内存清空，仍从 localStorage 复用')
  const reloaded = activate(loadPlugin(), world)
  const a3 = mount(reloaded.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('重载后没有创建请求', world.calls.create.length === createCountAfterFailure, JSON.stringify(world.calls.create))
  check('重载后渲染 child-1', childOf(a3) === 'child-1', String(childOf(a3)))

  console.log('[8] 另一个会话的同名 tab1：不能串用 A 的分支')
  const b1 = mount(first.ForkChatTab, tabProps('B', 'tab1'))
  await settle()
  const composerB1 = mountComponent(composerVNodeOf(b1))
  const textareaB1 = findTextarea(composerB1.output)
  textareaB1.props.onChange({ target: { value: 'hello from B' } })
  flush()
  syncProps(composerB1, composerVNodeOf(b1))
  await findButton(composerB1.output, 'first.send').props.onClick()
  await settle()
  check('B 的 tab1 自己创建一次', JSON.stringify(world.calls.create[world.calls.create.length - 1]) === JSON.stringify({ sessionId: 'B', text: 'hello from B' }), JSON.stringify(world.calls.create))
  check('B 渲染自己的 child-2', childOf(b1) === 'child-2', String(childOf(b1)))
  check('A 的映射没被覆盖', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[9] 死映射：child 无法 resolve 时清映射回到首条消息界面')
  world.markDead('child-1')
  const a4 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('死映射被清除', storage.get(branchStorageKey('A', 'tab1')) === undefined)
  check('回到首条消息界面', isPhaseA(a4) === true, String(a4.output && a4.output.children[0] && a4.output.children[0].tag))
  a4.unmount()

  console.log('[10] 同一个 tab 永远只绑定一个 child')
  const a5 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  const composerA5 = mountComponent(composerVNodeOf(a5))
  const textareaA5 = findTextarea(composerA5.output)
  textareaA5.props.onChange({ target: { value: 'second branch' } })
  flush()
  syncProps(composerA5, composerVNodeOf(a5))
  await findButton(composerA5.output, 'first.send').props.onClick()
  await settle()
  check('重建后渲染自己的 child-3', childOf(a5) === 'child-3', String(childOf(a5)))
  check('A/tab1 映射指向 child-3', storage.get(branchStorageKey('A', 'tab1')) === 'child-3')
  const providerA5 = a5.output.children[0]
  check('SessionProvider 只挂一份', providerA5 !== null && providerA5.props.session !== undefined)

  console.log('[11] 预览阶段复用官方 chat View，划词引用写入侧栏草稿')
  slotCalls.length = 0
  const c1 = mount(first.ForkChatTab, tabProps('C', 'tab1'))
  await settle()
  const preview = previewOf(c1)
  check('预览带划词引用入口', preview !== undefined)
  const previewInst = mountComponent(preview)
  const viewCall = slotCalls.find((call) => call.name === 'conversation.view')
  check('渲染官方 conversation.view（only chat）', viewCall !== undefined && viewCall.options !== undefined && viewCall.options.only === 'chat', JSON.stringify(viewCall === undefined ? null : viewCall.options))
  if (previewInst !== undefined) previewInst.unmount()
  preview.props.onQuote('这一段我不懂')
  flush()
  const quotedDraft = composerVNodeOf(c1) !== undefined ? String(composerVNodeOf(c1).props.draft) : ''
  check('引用以 Markdown 引用块写入草稿', quotedDraft.includes('> 这一段我不懂'), quotedDraft)
  c1.unmount()

  a2.unmount()
  a3.unmount()
  a5.unmount()
  b1.unmount()

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

#!/usr/bin/env node
/*
 * side-chat 装机前门禁：加载【真实 client.js】，用最小 React hook 运行时复刻
 * tab body 的挂载/卸载生命周期，验证「一个 tab 永远只绑定一个分支会话」。
 *
 * 用法：node side-chat/test/branch-lifecycle.cjs
 * 退出码：全绿 0；任何断言失败 1。
 *
 * 覆盖（对应 0.2.1 的真实缺陷）：
 *   1. 首次挂载：fork 一次，retain 该分支，映射落 localStorage；
 *   2. 切会话导致 body 卸载：只 release，映射必须保留；
 *   3. 切回重挂载：复用同一个 child，不再 fork；
 *   4. 页面重载（模块重新加载、内存映射清空）：仍从 localStorage 复用；
 *   5. 不同父会话同名 tab id（tab1）：互不串号，各自 fork；
 *   6. 映射指向已消失的会话：丢弃旧映射并重新 fork；
 *   7. 关闭 tab：archive 该 child 并清掉映射；
 *   8. tab 类型注册带 keepMounted（会话切走时 body 不卸载）。
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
    if (instance.hooks[index] === undefined) instance.hooks[index] = { kind: 'ref', value: { current: value } }
    return instance.hooks[index].value
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
  const calls = { fork: [], retain: [], release: [], archived: [], closed: [] }
  const list = {
    phase: 'ready',
    byId,
    subscribe: () => () => {},
  }
  const sessions = {
    list: { getSnapshot: () => list, subscribe: () => () => {} },
    async fork({ sessionId }) {
      serial += 1
      const id = `child-${serial}`
      calls.fork.push({ sessionId, id })
      byId[id] = { id }
      return id
    },
    retain(id) {
      calls.retain.push(id)
      if (byId[id] === undefined) throw new Error(`sessions.retain: unknown session ${id}`)
      return {
        sessionId: id,
        ready: Promise.resolve(),
        release() { calls.release.push(id) },
      }
    },
  }
  return { byId, calls, list, sessions }
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
  const registered = { slots: new Map(), tabType: undefined, closeHandler: undefined }
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
    sidebarRight: {
      registerCloseHandler: (kind, handler) => { registered.closeHandler = handler; return () => {} },
      close: (tabId) => world.calls.closed.push(tabId),
    },
    uiWorkspace: {
      archiveSession: async (sessionId) => { world.calls.archived.push(sessionId) },
    },
  }
  plugin.apply(ctx)
  const body = registered.slots.get('sidebar.right.pane.tab')
  if (body === undefined) throw new Error('tab body slot was not registered')
  return { ...registered, ForkChatTab: body.component }
}

function tabProps(sessionId, tabId) {
  return {
    useTabInfo: () => ({ tab: { id: tabId, kind: 'forkchat', signal: new AbortController().signal } }),
    useSession: (selector) => selector({ sessionId }),
    SessionProvider: 'SessionProvider',
    renderSlot: () => null,
  }
}

const branchStorageKey = (sessionId, tabId) => `dsh.side-chat.branch.v1.${JSON.stringify([sessionId, tabId])}`
const renderedChild = (instance) => instance.output && instance.output.children[0]
const childOf = (instance) => {
  const provider = renderedChild(instance)
  return provider && provider.props && provider.props.session && provider.props.session.sessionId
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

  console.log('[2] 首次挂载：fork 一次并保留映射')
  const a1 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('fork 恰好一次', world.calls.fork.length === 1, JSON.stringify(world.calls.fork))
  check('fork 的父会话是 A', world.calls.fork[0]?.sessionId === 'A')
  check('渲染的是 fork 出来的 child-1', childOf(a1) === 'child-1', String(childOf(a1)))
  check('映射写入 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[3] 切到别的会话导致卸载：只释放引用，映射保留')
  a1.unmount()
  await settle()
  check('卸载时 release 了 child-1', world.calls.release.includes('child-1'), JSON.stringify(world.calls.release))
  check('映射仍在 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[4] 切回 A：重挂载复用同一分支，不再 fork')
  const a2 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('没有第二次 fork', world.calls.fork.length === 1, JSON.stringify(world.calls.fork))
  check('重新 retain 的还是 child-1', world.calls.retain.filter((id) => id === 'child-1').length === 2)
  check('渲染的仍是 child-1', childOf(a2) === 'child-1', String(childOf(a2)))

  console.log('[5] 页面重载：内存清空，仍从 localStorage 复用')
  const reloaded = activate(loadPlugin(), world)
  const a3 = mount(reloaded.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('重载后没有 fork', world.calls.fork.length === 1, JSON.stringify(world.calls.fork))
  check('重载后渲染 child-1', childOf(a3) === 'child-1', String(childOf(a3)))

  console.log('[6] 另一个会话的同名 tab1：不能串用 A 的分支')
  const b1 = mount(first.ForkChatTab, tabProps('B', 'tab1'))
  await settle()
  check('B 的 tab1 自己 fork 一次', world.calls.fork.length === 2, JSON.stringify(world.calls.fork))
  check('B 的分叉父会话是 B', world.calls.fork[1]?.sessionId === 'B')
  check('B 渲染自己的 child-2', childOf(b1) === 'child-2', String(childOf(b1)))
  check('A 的映射没被覆盖', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[7] 映射指向已消失的会话：重新 fork')
  storage.set(branchStorageKey('A', 'tab9'), 'child-gone')
  const a4 = mount(first.ForkChatTab, tabProps('A', 'tab9'))
  await settle()
  check('丢弃死映射后 fork 一次', world.calls.fork.length === 3, JSON.stringify(world.calls.fork))
  check('新映射覆盖旧值', storage.get(branchStorageKey('A', 'tab9')) === 'child-3')

  console.log('[8] 关闭 tab：归档 child 并清掉映射')
  first.closeHandler('A', { id: 'tab1', kind: 'forkchat' })
  await settle()
  check('归档的是 child-1', world.calls.archived.includes('child-1'), JSON.stringify(world.calls.archived))
  check('A/tab1 映射已清除', storage.get(branchStorageKey('A', 'tab1')) === undefined)
  const a5 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('关闭后重建 tab 会 fork 新分支', world.calls.fork.length === 4, JSON.stringify(world.calls.fork))
  check('新渲染 child-4', childOf(a5) === 'child-4', String(childOf(a5)))

  a2.unmount()
  a3.unmount()
  a5.unmount()
  b1.unmount()
  a4.unmount()

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
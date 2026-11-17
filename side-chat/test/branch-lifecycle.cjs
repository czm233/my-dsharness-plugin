#!/usr/bin/env node
/*
 * side-chat 装机前门禁：加载【真实 client.js】，用最小 React hook 运行时复刻
 * tab body 的挂载/卸载生命周期，验证「打开即原生 fork 真会话」生命周期（0.5.0）。
 *
 * 用法：node side-chat/test/branch-lifecycle.cjs
 * 退出码：全绿 0；任何断言失败 1。
 *
 * 覆盖：
 *   1. tab 类型注册带 keepMounted（会话切走时 body 不卸载）；
 *   2. 首次挂载（无映射）：立刻 fork 一次父会话，显示加载态，不 retain、不落映射；
 *   3. fork 落地：映射写 localStorage，以会话 id 直接 retain，渲染出 child 会话；
 *      不再调用已退役的 /api/side-chat/create；
 *   4. fork 失败：映射不落、错误面板可重试，重试成功后渲染 child；
 *   5. 切会话导致 body 卸载：只 release，映射必须保留；
 *   6. 切回重挂载：复用同一 child，不再 fork；
 *   7. 页面重载（模块重新加载、内存映射清空）：仍从 localStorage 复用；
 *   8. 不同父会话同名 tab id（tab1）：互不串号，各自 fork；
 *   9. 死映射（child 无法 resolve）：清掉映射并自动重新 fork 出新 child；
 *  10. 同一个 tab 永远只绑定一个 child；
 *  11. 诊断上报走独立路由（/api/side-chat/log），不混进任何业务断言。
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
  useMemo(fn) { return fn },
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
  let serial = 0
  const calls = { fork: [], retain: [], release: [], create: [] }
  const deadChildren = new Set()
  let failNextFork = false
  let holdNextForkFlag = false
  let heldResolve = null
  const byId = {}
  const list = {
    phase: 'ready',
    byId,
    subscribe: () => () => {},
  }
  const sessions = {
    list: { getSnapshot: () => list, subscribe: () => () => {} },
    binding(id) { return bindings[id] },
    // 0.5.0：客户端直接 fork 父会话（原生真会话分支）
    fork(opts) {
      calls.fork.push(opts)
      if (failNextFork) {
        failNextFork = false
        return Promise.reject(new Error('fork refused'))
      }
      if (holdNextForkFlag) {
        holdNextForkFlag = false
        return new Promise((resolve) => {
          heldResolve = () => {
            serial += 1
            const id = `child-${serial}`
            byId[id] = { id }
            resolve(id)
          }
        })
      }
      serial += 1
      const id = `child-${serial}`
      byId[id] = { id }
      return Promise.resolve(id)
    },
    retain(target) {
      calls.retain.push(target)
      const id = typeof target === 'string' ? target : target.childSessionId
      const reference = {
        sessionId: id,
        ready: deadChildren.has(id) ? Promise.reject(new Error(`session/not-found: ${id}`)) : Promise.resolve(),
        release() { calls.release.push(id) },
      }
      if (deadChildren.has(id)) reference.ready.catch(() => {})
      return reference
    },
  }
  const bindings = {}
  const diagnostics = []
  global.fetch = async (pathUrl, init) => {
    const body = JSON.parse(init.body)
    // 诊断上报走独立路由，不能混进业务断言
    if (pathUrl === '/api/side-chat/log') {
      diagnostics.push(body)
      return { ok: true, status: 204, json: async () => undefined }
    }
    // 0.4.x 的创建路由已退役；任何对它的调用都算回归
    calls.create.push({ path: pathUrl, body })
    return { ok: false, status: 404, json: async () => ({ error: 'gone' }) }
  }
  return {
    byId, calls, list, sessions, deadChildren, diagnostics,
    markDead(id) { deadChildren.add(id) },
    failNextFork() { failNextFork = true },
    holdNextFork() { holdNextForkFlag = true },
    releaseFork() { const resolve = heldResolve; heldResolve = null; if (resolve) resolve() },
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

function tabProps(sessionId, tabId) {
  return {
    useTabInfo: () => ({ tab: { id: tabId, kind: 'forkchat', signal: new AbortController().signal } }),
    useSession: (selector) => selector({ sessionId }),
    SessionProvider: 'SessionProvider',
    renderSlot: (name, props) => {
      return { slot: name, props }
    },
  }
}

const branchStorageKey = (sessionId, tabId) => `dsh.side-chat.branch.v1.${JSON.stringify([sessionId, tabId])}`
// 绑定阶段：children[0] 是 SessionProvider，其 props.session 携带会话引用
const childOf = (instance) => {
  const provider = instance.output && instance.output.children[0]
  return provider && provider.props && provider.props.session && provider.props.session.sessionId
}
// 加载态：整体是 aria-busy 的居中容器
const isBusy = (instance) => {
  const node = instance.output
  return node !== null && node !== undefined && typeof node === 'object' && node.props && node.props['aria-busy'] === true
}
function findButton(root, label) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (typeof node === 'object') {
      if (node.tag === 'button' && node.props) {
        const text = Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join('') : ''
        if (text === label) return node
      }
      if (Array.isArray(node.children)) stack.push(...node.children)
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

  console.log('[2] 首次挂载（无映射）：立刻 fork 父会话，加载态，不 retain')
  world.holdNextFork()
  const a1 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('挂载即 fork 父会话', JSON.stringify(world.calls.fork) === JSON.stringify([{ sessionId: 'A', increaseTitle: true }]), JSON.stringify(world.calls.fork))
  check('fork 未落地前显示加载态', isBusy(a1) === true, String(a1.output && a1.output.props && a1.output.props['aria-busy']))
  check('fork 未落地前不 retain', world.calls.retain.length === 0, JSON.stringify(world.calls.retain))
  check('映射还不存在', storage.get(branchStorageKey('A', 'tab1')) === undefined)
  world.releaseFork()

  console.log('[3] fork 落地：映射写入 localStorage，以会话 id retain，渲染 child')
  await settle()
  check('映射写入 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')
  const retainCall = world.calls.retain[world.calls.retain.length - 1]
  check('以会话 id 直接 retain', retainCall === 'child-1', JSON.stringify(retainCall))
  check('渲染的是 child-1', childOf(a1) === 'child-1', String(childOf(a1)))
  check('不再调用已退役的创建路由', world.calls.create.length === 0, JSON.stringify(world.calls.create))

  console.log('[4] fork 失败：映射不落、错误面板可重试，重试成功后渲染')
  world.failNextFork()
  const b0 = mount(first.ForkChatTab, tabProps('B', 'tab1'))
  await settle()
  check('失败后映射不存在', storage.get(branchStorageKey('B', 'tab1')) === undefined)
  const retryButton = findButton(b0.output, 'fork.retry')
  check('错误面板带重试按钮', retryButton !== undefined)
  await retryButton.props.onClick()
  await settle()
  check('重试后映射写入', storage.get(branchStorageKey('B', 'tab1')) === 'child-2')
  check('重试后渲染 child-2', childOf(b0) === 'child-2', String(childOf(b0)))

  console.log('[5] 切到别的会话导致卸载：只释放引用，映射保留')
  const forkCountAfterB = world.calls.fork.length
  a1.unmount()
  await settle()
  check('卸载时 release 了 child-1', world.calls.release.includes('child-1'), JSON.stringify(world.calls.release))
  check('映射仍在 localStorage', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')

  console.log('[6] 切回 A：重挂载复用同一 child，不再 fork')
  const a2 = mount(first.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('没有新的 fork', world.calls.fork.length === forkCountAfterB, JSON.stringify(world.calls.fork))
  check('重新 retain 的还是 child-1', world.calls.retain.filter((entry) => entry === 'child-1').length === 2)
  check('渲染的仍是 child-1', childOf(a2) === 'child-1', String(childOf(a2)))

  console.log('[7] 页面重载：内存清空，仍从 localStorage 复用')
  const reloaded = activate(loadPlugin(), world)
  const a3 = mount(reloaded.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('重载后没有新的 fork', world.calls.fork.length === forkCountAfterB, JSON.stringify(world.calls.fork))
  check('重载后渲染 child-1', childOf(a3) === 'child-1', String(childOf(a3)))

  console.log('[8] 另一个会话的同名 tab1：不能串用，各自 fork')
  const d1 = mount(reloaded.ForkChatTab, tabProps('D', 'tab1'))
  await settle()
  check('D 的 tab1 自己 fork 一次', JSON.stringify(world.calls.fork[world.calls.fork.length - 1]) === JSON.stringify({ sessionId: 'D', increaseTitle: true }), JSON.stringify(world.calls.fork))
  check('D 渲染自己的 child-3', childOf(d1) === 'child-3', String(childOf(d1)))
  check('A 的映射没被覆盖', storage.get(branchStorageKey('A', 'tab1')) === 'child-1')
  check('D 的映射独立', storage.get(branchStorageKey('D', 'tab1')) === 'child-3')

  console.log('[9] 死映射：child 无法 resolve 时清映射并自动重新 fork')
  world.markDead('child-1')
  const a4 = mount(reloaded.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('死映射被清除并换成新 child', storage.get(branchStorageKey('A', 'tab1')) === 'child-4', String(storage.get(branchStorageKey('A', 'tab1'))))
  check('自动 fork 出的新 child 已渲染', childOf(a4) === 'child-4', String(childOf(a4)))

  console.log('[10] 同一个 tab 永远只绑定一个 child')
  const a5 = mount(reloaded.ForkChatTab, tabProps('A', 'tab1'))
  await settle()
  check('映射稳定不再变化', storage.get(branchStorageKey('A', 'tab1')) === 'child-4')
  check('渲染的仍是 child-4', childOf(a5) === 'child-4', String(childOf(a5)))
  const providerA5 = a5.output.children[0]
  check('SessionProvider 只挂一份', providerA5 !== null && providerA5.props.session !== undefined)

  console.log('[11] 诊断走独立路由：module 事件已上报，不混入业务')
  check('诊断上报包含 module 事件', world.diagnostics.some((entry) => entry.event === 'module'), JSON.stringify(world.diagnostics))
  check('业务创建路由全程零调用', world.calls.create.length === 0, JSON.stringify(world.calls.create))

  a2.unmount()
  a3.unmount()
  a4.unmount()
  a5.unmount()
  b0.unmount()
  d1.unmount()

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

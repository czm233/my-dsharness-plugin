#!/usr/bin/env node
/**
 * Render-level checks for the turn-cost client half.
 *
 * The real client bundle is executed with a tiny React-compatible runtime, so
 * this exercises the same CostTail/CostPill/CostPanel functions the page loads
 * without pulling in the DSH renderer. Run with:
 *
 *   node turn-cost/test/render-sim.cjs
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

/** Minimal React hook runtime; one component instance is reused per component type. */
function createReactRuntime() {
  const componentStore = new Map()

  function createInstance() {
    return {
      states: {}, refs: {}, effects: {}, layouts: {}, memos: {},
      pending: [], pendingLayout: [],
    }
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const i = hookCurrent.index++
      const inst = hookCurrent.instance
      if (!(i in inst.states)) inst.states[i] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(inst.states[i]) : next
        if (!Object.is(value, inst.states[i])) inst.states[i] = value
      }
      return [inst.states[i], set]
    },
    useRef(initial) {
      const i = hookCurrent.index++
      const inst = hookCurrent.instance
      if (!(i in inst.refs)) inst.refs[i] = { current: initial }
      return inst.refs[i]
    },
    useEffect(fn, deps) {
      const i = hookCurrent.index++
      const inst = hookCurrent.instance
      const prev = inst.effects[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, j) => d !== prev.deps[j])) {
        inst.effects[i] = { deps, fn }
        inst.pending.push(inst.effects[i])
      }
    },
    useLayoutEffect(fn, deps) {
      const i = hookCurrent.index++
      const inst = hookCurrent.instance
      const prev = inst.layouts[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, j) => d !== prev.deps[j])) {
        inst.layouts[i] = { deps, fn }
        inst.pendingLayout.push(inst.layouts[i])
      }
    },
    useMemo(fn, deps) {
      const i = hookCurrent.index++
      const inst = hookCurrent.instance
      const prev = inst.memos[i]
      if (!prev || !deps || deps.length !== prev.deps.length || deps.some((d, j) => d !== prev.deps[j])) {
        inst.memos[i] = { deps, value: fn() }
      }
      return inst.memos[i].value
    },
  }

  function renderComponent(component, props, instance) {
    instance.pending = []
    instance.pendingLayout = []
    const prev = hookCurrent
    hookCurrent = { index: 0, instance, pending: instance.pending, pendingLayout: instance.pendingLayout }
    let output
    try { output = component(props) } finally { hookCurrent = prev }
    for (const layout of instance.pendingLayout) layout.fn()
    for (const effect of instance.pending) effect.fn()
    return output
  }

  function renderTree(element) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (Array.isArray(element)) return element.map(renderTree)
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (element.type && element.type.__portal) {
      return { type: '#portal', container: element.type.container, children: renderTree(element.type.children) }
    }
    if (typeof element.type === 'function') {
      let instance = componentStore.get(element.type)
      if (instance === undefined) {
        instance = createInstance()
        componentStore.set(element.type, instance)
      }
      return { type: element.type.name || 'Component', children: renderTree(renderComponent(element.type, element.props, instance)) }
    }
    return { type: element.type, props: element.props, children: element.children.map(renderTree) }
  }

  return { React, createInstance, renderComponent, renderTree, componentStore }
}

function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { node.forEach(child => textOf(child, out)); return out }
  if (node.children !== undefined) textOf(node.children, out)
  return out
}

function findPortal(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findPortal(child)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.type === '#portal') return node
  return findPortal(node.children)
}

function findPortals(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findPortals(child, out)
    return out
  }
  if (node.type === '#portal') {
    out.push(node)
    return out
  }
  findPortals(node.children, out)
  return out
}

function findButton(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.type === 'button' && typeof node.props?.onClick === 'function') return node
  return findButton(node.children)
}

const ZH = {
  title: '本轮费用', pillTotal: '≈{cost}', model: '提供方 / 模型', cacheHit: '缓存命中',
  switchNote: '换模型后首轮：旧模型缓存不继承',
  switchNoteHit: '换模型后首轮：旧模型缓存不继承，首个请求缓存命中 {percent}%',
  midTurnSwitch: '本轮内切换过模型，按各自单价分别计算',
  unpricedNote: '未收录「{model}」的单价，合计不含该模型',
  unpricedAll: '未收录本轮模型的单价，无法折算费用',
  cacheHitValue: '{percent}% · {tokens} tok', breakdown: '费用明细（按牌价折算）',
  period: '计费时段', peak: '高峰', offPeak: '空闲',
  mixedCurrency: '本轮包含不同币种的模型，不合并合计，按模型分别显示',
  elapsedSeconds: '已过去{count}秒', elapsedMinutes: '已过去{count}分钟',
  elapsedHours: '已过去{count}小时', elapsedHoursMinutes: '已过去{count}小时{minutes}分',
  elapsedDays: '已过去{count}天',
  inputCost: '未缓存输入', cacheReadCost: '缓存读取', cacheWriteCost: '缓存写入', outputCost: '输出',
  total: '合计', unitPrice: '{price}/M tok', listNote: '按模型牌价折算的等效金额，非实际账单',
}

function translate(key, vars) {
  let value = ZH[key] ?? key
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}

async function main() {
  const { React, createInstance, renderComponent, renderTree, componentStore } = createReactRuntime()
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    console,
    document: {
      createElement: () => ({
        dataset: {}, style: {}, parentElement: null, nextElementSibling: null, isConnected: true,
        remove() { this.parentElement = null },
      }),
      head: { appendChild() {} },
      body: {},
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
    Node: class {},
    // Elapsed labels re-arm a timer per visible change; keep them out of the
    // event loop so the check exits on its own.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    },
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(join(ROOT, 'client.js'), 'utf8'), sandbox)
  const api = captured.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') {
      return {
        createPortal: (children, container) => ({ type: { __portal: true, children, container } }),
      }
    }
    return null
  })

  let CostTail
  api.apply({
    effect(fn) { fn(); return () => {} },
    locale: { register: () => () => {} },
    get: () => null,
    slots: {
      inject(_name, fn) { fn() },
      register(_definition, component) { CostTail = component; return {} },
    },
  })
  assert.equal(typeof CostTail, 'function', 'tail slot component is registered')

  // One turn after switching flash -> pro: the first request has little cache,
  // later requests in the same turn reuse the pro prompt.
  const attempts = [
    {
      route: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4-pro' },
      input: 100000, output: 1000, total: 113032, cacheRead: 12032, cacheWrite: 0,
      price: {
        matched: true,
        provider: 'qwen-token-plan-cn',
        model: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        currency: '¥',
        period: 'peak',
        rates: { input: 9, cacheRead: 0.3, cacheWrite: 0, output: 27 },
        cost: { input: 0.9, cacheRead: 0.0036096, cacheWrite: 0, output: 0.027 },
        total: 0.9306096,
      },
    },
  ]

  const callUsage = async () => ({
    attempts, events: 10, matched: 1, interrupted: false, switched: true, routeChanged: false, currency: '$',
    time: Date.now() - 125000,
  })
  let instance = createInstance()
  let anchorPatched = false
  let clockRow = null
  let clockSeat = null
  const state = {
    kind: 'done', attempts, switched: true, routeChanged: false, currency: '$',
    time: Date.now() - 125000,
  }

  function renderTail() {
    instance.pending = []
    instance.pendingLayout = []
    const prev = hookCurrent
    hookCurrent = { index: 0, instance, pending: instance.pending, pendingLayout: instance.pendingLayout }
    let output
    try {
      output = CostTail({
        turn: { turn: 2, status: 'completed' },
        t: translate,
        sessionId: 'session-test',
        callUsage,
        usePrices: (select) => select({ currency: '$' }),
      })
    } finally {
      hookCurrent = prev
    }
    if (!anchorPatched) {
      const ref = Object.values(instance.refs)[0]
      if (ref) {
        const shipped = { parentElement: null, nextElementSibling: null, isConnected: true }
        const parent = {
          children: [shipped],
          insertBefore(seat) { seat.parentElement = this; seat.nextElementSibling = shipped; this.children = [seat, shipped] },
          appendChild(seat) { seat.parentElement = this; this.children.push(seat) },
          isConnected: true,
        }
        shipped.parentElement = parent
        // Same shape as the shipped actions row: the clock is the last content,
        // which is where the elapsed label gets appended.
        const clock = { textContent: '11:03', parentElement: parent, nextElementSibling: null, isConnected: true }
        clockRow = {
          lastElementChild: clock,
          appendChild(seat) {
            clockSeat = seat
            seat.parentElement = this
            this.lastElementChild = seat
          },
        }
        ref.current = {
          closest: () => ({
            querySelector: (selector) => (String(selector).includes('data-clock') ? clockRow : shipped),
          }),
        }
        anchorPatched = true
      }
    }
    for (const layout of instance.pendingLayout) layout.fn()
    for (const effect of instance.pending) effect.fn()
    return output
  }

  // The fake runtime is synchronous; callUsage resolves in a microtask, so the
  // first pass shows the loading state and a direct second pass shows the fold.
  renderTail()
  await Promise.resolve()
  // Seed the component state from the resolved fetch once.
  if (instance.states[0]?.kind !== 'done') {
    instance.states[0] = state
  }
  let tree = renderTail()
  let rendered = renderTree(tree)
  const pillText = textOf(rendered).join(' ').replace(/\s+/g, ' ').trim()
  assert.match(pillText, /≈¥0\.931/)
  assert.match(pillText, /DeepSeek V4 Pro/)
  console.log('ok pill:', pillText)

  // The elapsed label gets its own seat appended after the shipped clock.
  assert.ok(clockSeat, 'elapsed seat is appended to the actions row')
  const elapsedPortal = findPortals(rendered).find(candidate => candidate.container === clockSeat)
  assert.ok(elapsedPortal, 'elapsed label portals into the seat after the clock')
  const elapsedText = textOf(elapsedPortal).join('').replace(/\s+/g, ' ').trim()
  assert.match(elapsedText, /^已过去2分钟$/)
  console.log('ok elapsed:', elapsedText)

  const button = findButton(rendered)
  assert.ok(button, 'pill button is rendered')
  button.props.onClick()
  tree = renderTail()
  rendered = renderTree(tree)
  const portal = findPortal(rendered)
  assert.ok(portal, 'panel portal opens after clicking the pill')
  const panelText = textOf(portal).join(' | ').replace(/\s+/g, ' ').trim()
  assert.match(panelText, /DeepSeek V4 Pro · qwen-token-plan-cn/)
  assert.match(panelText, /首个请求缓存命中 10\.7%/)
  assert.match(panelText, /计费时段 \| 高峰/)
  assert.match(panelText, /¥9\/M tok/)
  assert.match(panelText, /≈¥0\.931/)
  console.log('ok panel:', panelText)

  // The label recomputes as the turn ages: seconds under a minute, then
  // hours+minutes, then days.
  function elapsedFor(ms) {
    instance.states[0] = { ...instance.states[0], time: Date.now() - ms }
    const out = renderTree(renderTail())
    const hit = findPortals(out).find(candidate => candidate.container === clockSeat)
    assert.ok(hit, 'elapsed portal stays mounted')
    return textOf(hit).join('').replace(/\s+/g, ' ').trim()
  }
  assert.match(elapsedFor(45_000), /^已过去4[3-6]秒$/)
  // Offset past the boundary: the fake runtime renders before the tick effect
  // refreshes "now", so the millisecond gap must not flip the unit.
  assert.equal(elapsedFor(3 * 3600_000 + 5 * 60_000 + 30_000), '已过去3小时5分')
  assert.equal(elapsedFor(2 * 86400_000 + 60_000), '已过去2天')
  console.log('ok elapsed ages')

  console.log('\nturn-cost render-sim: all checks passed')
}

// Tiny mutable hook slot shared by the fake React runtime.
let hookCurrent = null

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
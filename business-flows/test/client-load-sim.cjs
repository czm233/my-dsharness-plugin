/**
 * Client-half registration smoke for business-flows: loads the REAL client.js
 * with stubbed ModuleLoader/require/React and a fake ctx, then asserts both
 * slot registrations come out with the right seat names, ids, locale
 * namespace, and injected props (sessionId + callRpc). Catches TDZ/typo/
 * wiring bugs without a browser. Run: node business-flows/test/client-load-sim.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

let failures = 0
function assert(condition, label) {
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
  }
}

const hooks = {}
const reactStub = new Proxy({
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  // single-render hook shim: enough to exhaustively invoke one component body
  useState: (init) => [init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}, {
  get(target, prop) {
    if (prop in target) return target[prop]
    if (typeof prop === 'string') {
      hooks[prop] = hooks[prop] ?? ((...args) => ({ hook: prop, args }))
      return hooks[prop]
    }
    return undefined
  },
})

const registered = []
const slotInjectors = {}
const effects = []
const rpcCalls = []

const ctx = {
  effect(fn, label) { effects.push(label); return fn() },
  locale: {
    register(ns, dicts) { registered.push(['locale', ns, Object.keys(dicts)]) },
    getLocale: () => ({ active: 'zh' }),
  },
  slots: {
    inject(name, fn) { slotInjectors[name] = fn },
    register(spec, component) { registered.push(['slot', spec, component]) },
  },
  get(name) {
    if (name !== 'connection') return undefined
    return { rpc: { call: async (channel, method, payload) => {
      rpcCalls.push({ channel, method, payload })
      return { ok: true, value: { flows: [] } }
    } } }
  },
}

global.window = {
  __ModuleLoader__: {
    load(def) {
      global.__LOADED__ = def
    },
  },
}

const styleElements = []
global.document = {
  createElement(tag) { return { tag, dataset: {}, textContent: '', remove() {} } },
  head: { appendChild(el) { styleElements.push(el) } },
}

const clientPath = path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')
new Function('require', 'window', source)(undefined, global.window)

const def = global.__LOADED__
assert(def && def.id === '@local/business-flows', 'module id')
assert(typeof def.factory === 'function', 'factory present')

const module_ = def.factory((id) => {
  if (id === 'react') return reactStub
  if (id === 'react-dom') return { createPortal: (children) => ({ portal: children }) }
  throw new Error('module unavailable')
})

assert(typeof module_.apply === 'function', 'apply exported')
assert(Array.isArray(module_.inject) && module_.inject.includes('slots') && module_.inject.includes('locale'), 'inject declares slots+locale')

module_.apply(ctx)

// The real slots service invokes each injector to collect contributions; the
// sim must do the same before asserting what got registered.
for (const injector of Object.values(slotInjectors)) injector()

assert(registered.some(([kind, ns]) => kind === 'locale' && ns === 'businessFlows'), 'locale registered under businessFlows')
assert(effects.some((label) => String(label).includes('stylesheet')), 'stylesheet effect installed')

const viewReg = registered.filter(([kind, spec]) => kind === 'slot' && spec.name === 'conversation.view')
assert(viewReg.length === 1, 'one conversation.view registration')
const viewSpec = viewReg[0][1]
assert(viewSpec.id === '@local/business-flows/tab', 'view slot id')
assert(viewSpec.locale === 'businessFlows', 'view slot locale ns')
const viewProps = viewSpec.inject('session-abc')
assert(viewProps.sessionId === 'session-abc' && typeof viewProps.callRpc === 'function', 'view inject passes sessionId+callRpc')
const viewPropsBlank = viewSpec.inject(undefined)
assert(viewPropsBlank.sessionId === undefined, 'view inject tolerates blank session')

const tailReg = registered.filter(([kind, spec]) => kind === 'slot' && spec.name === 'conversation.chat.assistant-actions')
assert(tailReg.length === 1, 'one assistant-actions registration (the shipped action row)')
const tailSpec = tailReg[0][1]
assert(tailSpec.id === '@local/business-flows/collect', 'collect action id')
const tailProps = tailSpec.inject('session-abc')
assert(typeof tailProps.callRpc === 'function', 'collect inject passes callRpc')

const tabLabel = viewSpec.label
assert(typeof tabLabel === 'function' && tabLabel() === '业务流程', 'tab label resolves in zh')

// callRpc round-trip through the fake connection
tailProps.callRpc('list', { sessionId: 's1' }).then(async (value) => {
  assert(Array.isArray(value.flows), 'callRpc resolves value')
  assert(rpcCalls.length === 1 && rpcCalls[0].channel === '/api' && rpcCalls[0].method === 'business-flows/rpc', 'rpc carrier path')
  assert(rpcCalls[0].payload.action === 'list', 'rpc payload action')

  // collect action: one click files this turn, no picker, addressed by messageId
  const tailComponent = tailReg[0][2]
  assert(typeof tailComponent === 'function', 'collect component registered')
  const button = tailComponent({ ...tailProps, t: (key) => key, sessionId: 'session-abc', messageId: 'm-1-final' })
  assert(button && button.type === 'button' && button.props.className === 'bfc-tail-btn', 'collect renders a plain button')
  assert(JSON.stringify(button.children).includes('collect'), 'label is the collect button')
  await button.props.onClick()
  const last = rpcCalls[rpcCalls.length - 1]
  assert(last.payload.action === 'collect', 'click calls collect directly')
  assert(last.payload.sessionId === 'session-abc' && last.payload.messageId === 'm-1-final', 'collect payload carries session + message')
  assert(last.payload.title === undefined && last.payload.flowId === undefined && last.payload.turn === undefined, 'no turn/title/flow picker params sent')

  console.log(failures === 0 ? 'client-load-sim: all assertions passed' : 'client-load-sim: FAILURES above')
  process.exit(failures === 0 ? 0 : 1)
}).catch((error) => {
  console.error('client-load-sim crashed:', error)
  process.exit(1)
})

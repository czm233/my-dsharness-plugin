// Offline gate for the client half: stub the DOM surface client.js touches and
// verify only the latest turn's collapsed think rows get one toggle click while
// the reply is in progress (1.4.0 running gate: `[data-chat-running]` mounted),
// that a finished reply makes the module inert, that per-session watermarks
// reset on session switches (1.3.0 regression: one long session's turn scale
// bricked every shorter session), and that paging regressions behave.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')

const code = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

const state = { loaded: null, observers: [], frames: [], diagPosts: 0 }

// client.js POSTs breadcrumbs to the host route; keep that off the network.
globalThis.fetch = async (url, init) => {
  assert.equal(url, '/api/auto-expand-thinking/rpc')
  const body = JSON.parse(init.body)
  assert.equal(body.action, 'log')
  state.diagPosts += body.lines.length
  return { ok: true }
}

/** Conversation shell body carrying the session id as attribute value. */
function makeScope(id) {
  const scope = {
    id,
    tails: [],
    // 1.4.0 running gate: mirrors the official RunningStatus element, which
    // stays mounted while the reply is in progress and unmounts once the
    // turn's actions row replaces it.
    running: true,
    isConnected: true,
    getAttribute(attr) {
      assert.equal(attr, 'data-conversation-session')
      return scope.id
    },
    querySelector(selector) {
      assert.equal(selector, '[data-chat-running]')
      return scope.running ? { flag: true } : null
    },
    querySelectorAll(selector) {
      assert.equal(selector, '[data-turn-tail]')
      return scope.tails.map((turn) => ({ getAttribute: () => String(turn) }))
    },
  }
  return scope
}

/** Think row root: collapsible disclosure inside a chat-turn region. */
function thinkRoot({ turn, scope, expanded = false, hasRow = true }) {
  const root = {
    rowClicks: 0,
    hasAttribute(attr) {
      return attr === 'data-expanded' ? expanded : false
    },
    closest(selector) {
      if (selector === '[data-chat-turn]') {
        return turn === null ? null : { getAttribute: () => String(turn) }
      }
      assert.equal(selector, '[data-conversation-session]')
      return scope
    },
    querySelector() {
      if (!hasRow) return null
      return { click: () => { root.rowClicks += 1 } }
    },
  }
  return root
}

/** Folded work-step group: header button click mounts its body. */
function stepGroup({ turn, scope, folded = true }) {
  const group = {
    headerClicks: 0,
    folded,
    hasAttribute(attr) {
      return attr === 'data-chat-paging-anchor' ? group.folded : false
    },
    closest(selector) {
      if (selector === '[data-chat-turn]') {
        return { getAttribute: () => String(turn) }
      }
      assert.equal(selector, '[data-conversation-session]')
      return scope
    },
    querySelector(selector) {
      assert.equal(selector, 'button[aria-expanded="false"]')
      return { click: () => { group.headerClicks += 1 } }
    },
  }
  return group
}

function makeDom() {
  const dom = {
    scopes: [],
    roots: [],
    groups: [],
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'div[data-variant="think"]') return dom.roots
      if (selector === '[data-step-process]') return dom.groups
      if (selector === '[data-turn-tail]') {
        return dom.scopes.flatMap((scope) => scope.tails).map((turn) => ({ getAttribute: () => String(turn) }))
      }
      return []
    },
  }
  return dom
}

const documentStub = makeDom()

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.options = null
    this.disconnected = false
    state.observers.push(this)
  }
  observe(target, options) {
    this.options = options
  }
  disconnect() {
    this.disconnected = true
  }
}

const windowStub = {
  __ModuleLoader__: {
    load(module) {
      state.loaded = module
    },
  },
}

new Function(
  'window',
  'document',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  code,
)(
  windowStub,
  documentStub,
  MutationObserverStub,
  (fn) => state.frames.push(fn),
  () => {},
)

assert.ok(state.loaded, 'module loader received the client module')
assert.equal(state.loaded.id, '@local/auto-expand-thinking')

const clientModule = state.loaded.factory()
const setups = []
clientModule.apply({ effect: (fn) => setups.push(fn) })

assert.equal(state.observers.length, 1, 'exactly one MutationObserver')
assert.deepEqual(state.observers[0].options.attributeFilter, ['data-expanded'])

const mutate = () => {
  state.observers[0].callback()
  state.frames.shift()()
}

// Session A open with two turns of history: only the last turn's collapsed row expands.
const scopeA = makeScope('session-a')
scopeA.tails = [1, 2]
documentStub.scopes = [scopeA]
documentStub.roots = [
  thinkRoot({ turn: 1, scope: scopeA }),
  thinkRoot({ turn: 2, scope: scopeA }),
  thinkRoot({ turn: 2, scope: scopeA, expanded: true }),
]
// The last turn also has a folded step group (hiding more reasoning rows),
// an unfolded group, and a folded group in an older turn.
documentStub.groups = [
  stepGroup({ turn: 2, scope: scopeA, folded: true }),
  stepGroup({ turn: 2, scope: scopeA, folded: false }),
  stepGroup({ turn: 1, scope: scopeA, folded: true }),
]
mutate()
assert.equal(documentStub.groups[0].headerClicks, 1, 'last turn folded group clicked once')
assert.equal(documentStub.groups[1].headerClicks, 0, 'unfolded group untouched')
assert.equal(documentStub.groups[2].headerClicks, 0, 'older turn folded group untouched')
assert.equal(documentStub.roots[0].rowClicks, 0, 'older turn row untouched')
assert.equal(documentStub.roots[1].rowClicks, 1, 'last turn collapsed row clicked once')
assert.equal(documentStub.roots[2].rowClicks, 0, 'already-open row untouched')

// Rescan: processed groups and rows never toggle twice.
mutate()
assert.equal(documentStub.groups[0].headerClicks, 1, 'no double click on group')
assert.equal(documentStub.roots[1].rowClicks, 1, 'no double toggle on rescan')

// A late-mounting row in the same (latest) turn still expands.
const lateRow = thinkRoot({ turn: 2, scope: scopeA })
documentStub.roots.push(lateRow)
mutate()
assert.equal(lateRow.rowClicks, 1, 'late row in latest turn expands')

// A group the reader folded after our click stays folded (processed set).
documentStub.groups[0].folded = true
mutate()
assert.equal(documentStub.groups[0].headerClicks, 1, 'manually folded group stays folded')

// Paging up unmounts the latest turn tail: the now-last (older) turn must NOT expand.
scopeA.tails = [1]
const pagedRow = thinkRoot({ turn: 1, scope: scopeA })
documentStub.roots.push(pagedRow)
mutate()
assert.equal(pagedRow.rowClicks, 0, 'older turn skipped while paging')

// Back to the latest turn: fresh elements there expand again.
scopeA.tails = [1, 2]
const backRow = thinkRoot({ turn: 2, scope: scopeA })
documentStub.roots.push(backRow)
mutate()
assert.equal(backRow.rowClicks, 1, 'latest turn re-expands after paging back')

// 1.3.0 regression: session A climbs to a high turn scale, then the reader
// switches to session B whose turn numbers are much lower — B's last turn
// must still expand (1.2.0 shared one watermark across sessions and bricked).
scopeA.tails = [188, 189, 190]
const highRow = thinkRoot({ turn: 190, scope: scopeA })
documentStub.roots = [highRow]
documentStub.groups = []
mutate()
assert.equal(highRow.rowClicks, 1, 'long session latest turn expands')

const scopeB = makeScope('session-b')
scopeB.tails = [9]
scopeA.isConnected = false
documentStub.scopes = [scopeB]
const lowRow = thinkRoot({ turn: 9, scope: scopeB })
documentStub.roots = [lowRow]
mutate()
assert.equal(lowRow.rowClicks, 1, 'short session last turn expands despite lower scale')

// Reopening session A remounts its shell: the stale watermark was dropped with
// the disconnected element, so the freshly mounted last turn expands again.
scopeB.isConnected = false
const scopeA2 = makeScope('session-a')
scopeA2.tails = [1, 2]
documentStub.scopes = [scopeA2]
const reopenRow = thinkRoot({ turn: 2, scope: scopeA2 })
documentStub.roots = [reopenRow]
mutate()
assert.equal(reopenRow.rowClicks, 1, 'remounted session expands its last turn again')

// 1.4.0 running gate: once the reply finished (RunningStatus unmounted) the
// module goes inert — fresh collapsed rows and folded groups of the finished
// turn are left alone instead of being expanded after the fact.
scopeA2.running = false
const doneRow = thinkRoot({ turn: 2, scope: scopeA2 })
const doneGroup = stepGroup({ turn: 2, scope: scopeA2, folded: true })
documentStub.roots = [reopenRow, doneRow]
documentStub.groups = [doneGroup]
mutate()
assert.equal(doneRow.rowClicks, 0, 'finished reply: new collapsed row stays collapsed')
assert.equal(doneGroup.headerClicks, 0, 'finished reply: folded group stays folded')
assert.equal(reopenRow.rowClicks, 1, 'finished reply: earlier expand is not undone')

// The next turn starts: the indicator remounts and the plugin re-arms on the
// new latest turn.
scopeA2.running = true
scopeA2.tails = [1, 2, 3]
const freshRow = thinkRoot({ turn: 3, scope: scopeA2 })
documentStub.roots = [reopenRow, doneRow, freshRow]
documentStub.groups = []
mutate()
assert.equal(freshRow.rowClicks, 1, 'new turn while running expands again')
assert.equal(doneRow.rowClicks, 0, 'rows of the finished turn stay collapsed')

// A think root outside any conversation shell has no running scope to consult
// and must be skipped without crashing.
const strayRow = thinkRoot({ turn: 3, scope: null })
documentStub.roots = [reopenRow, doneRow, freshRow, strayRow]
mutate()
assert.equal(strayRow.rowClicks, 0, 'root outside any shell never expands')

// No chat rendered: scan is a no-op and keeps state.
documentStub.scopes = []
documentStub.roots = []
mutate()

// Teardown disconnects the observer (ctx.effect(setup) returns the cleanup).
setups.map((fn) => fn()).forEach((cleanup) => cleanup())
assert.equal(state.observers[0].disconnected, true, 'observer disconnected on teardown')

console.log('auto-expand-sim: all assertions passed')

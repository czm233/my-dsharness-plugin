// Offline gate for the client half: stub the DOM surface client.js touches and
// verify only the latest turn's collapsed think rows get one toggle click, and
// that flow switches and turn regressions (paging) behave.
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

/** Think row root: collapsible disclosure inside a chat-turn region. */
function thinkRoot({ turn, expanded = false, hasRow = true }) {
  const root = {
    rowClicks: 0,
    hasAttribute(attr) {
      return attr === 'data-expanded' ? expanded : false
    },
    closest(selector) {
      assert.equal(selector, '[data-chat-turn]')
      return turn === null ? null : { getAttribute: () => String(turn) }
    },
    querySelector() {
      if (!hasRow) return null
      return { click: () => { root.rowClicks += 1 } }
    },
  }
  return root
}

/** Folded work-step group: header button click mounts its body. */
function stepGroup({ turn, folded = true }) {
  const group = {
    headerClicks: 0,
    turn,
    folded,
    hasAttribute(attr) {
      return attr === 'data-chat-paging-anchor' ? group.folded : false
    },
    closest(selector) {
      assert.equal(selector, '[data-chat-turn]')
      return { getAttribute: () => String(turn) }
    },
    querySelector(selector) {
      assert.equal(selector, 'button[aria-expanded="false"]')
      return { click: () => { group.headerClicks += 1 } }
    },
  }
  return group
}

function makeDom() {
  return {
    flow: { key: 'flow-a' },
    tails: [1, 2],
    roots: [],
    groups: [],
    querySelector(selector) {
      if (selector === '[data-chat-flow]') {
        return this.flow.key === null ? null : { getAttribute: () => this.flow.key }
      }
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-turn-tail]') {
        return this.tails.map((turn) => ({ getAttribute: () => String(turn) }))
      }
      if (selector === 'div[data-variant="think"]') return this.roots
      if (selector === '[data-step-process]') return this.groups
      return []
    },
  }
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

// Session open with two turns of history: only the last turn's collapsed row expands.
documentStub.roots = [
  thinkRoot({ turn: 1 }),
  thinkRoot({ turn: 2 }),
  thinkRoot({ turn: 2, expanded: true }),
]
// The last turn also has a folded step group (hiding more reasoning rows),
// an unfolded group, and a folded group in an older turn.
documentStub.groups = [
  stepGroup({ turn: 2, folded: true }),
  stepGroup({ turn: 2, folded: false }),
  stepGroup({ turn: 1, folded: true }),
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
const lateRow = thinkRoot({ turn: 2 })
documentStub.roots.push(lateRow)
mutate()
assert.equal(lateRow.rowClicks, 1, 'late row in latest turn expands')

// A group the reader folded after our click stays folded (processed set).
documentStub.groups[0].folded = true
mutate()
assert.equal(documentStub.groups[0].headerClicks, 1, 'manually folded group stays folded')

// Paging up unmounts the latest turn tail: the now-last (older) turn must NOT expand.
documentStub.tails = [1]
const pagedRow = thinkRoot({ turn: 1 })
documentStub.roots.push(pagedRow)
mutate()
assert.equal(pagedRow.rowClicks, 0, 'older turn skipped while paging')

// Back to the latest turn: fresh elements there expand again.
documentStub.tails = [1, 2]
const backRow = thinkRoot({ turn: 2 })
documentStub.roots.push(backRow)
mutate()
assert.equal(backRow.rowClicks, 1, 'latest turn re-expands after paging back')

// Session switch (new flow key): tracking resets, new flow's last turn expands.
documentStub.flow.key = 'flow-b'
documentStub.tails = [1]
const newRow = thinkRoot({ turn: 1 })
documentStub.roots = [thinkRoot({ turn: 1, expanded: true }), newRow]
mutate()
assert.equal(newRow.rowClicks, 1, 'new session last turn expands despite low turn number')

// No chat rendered: scan is a no-op and keeps state.
documentStub.flow.key = null
mutate()

// Teardown disconnects the observer (ctx.effect(setup) returns the cleanup).
setups.map((fn) => fn()).forEach((cleanup) => cleanup())
assert.equal(state.observers[0].disconnected, true, 'observer disconnected on teardown')

console.log('auto-expand-sim: all assertions passed')

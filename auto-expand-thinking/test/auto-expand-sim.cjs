// Offline gate for the client half: stub the DOM surface client.js touches and
// verify the expand pass clicks exactly the collapsed reasoning rows once.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert')

const code = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

const state = {
  loaded: null,
  observers: [],
  frames: [],
}

function makeRoot({ collapsed, hasRow, label }) {
  const root = {
    label,
    clicks: 0,
    rowClicks: 0,
    hasAttribute(attr) {
      return attr === 'data-expanded' ? !collapsed : false
    },
    querySelector() {
      if (!hasRow) return null
      const row = {
        click: () => {
          root.rowClicks += 1
        },
      }
      return row
    },
    click: () => {
      root.clicks += 1
    },
  }
  return root
}

const roots = {
  collapsed: makeRoot({ collapsed: true, hasRow: true, label: 'collapsed' }),
  open: makeRoot({ collapsed: false, hasRow: true, label: 'already-open' }),
  mounting: makeRoot({ collapsed: true, hasRow: false, label: 'row-not-mounted' }),
}

const documentStub = {
  querySelectorAll(selector) {
    assert.equal(selector, 'div[data-variant="think"]')
    return Object.values(roots)
  },
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.observed = null
    this.disconnected = false
    state.observers.push(this)
  }
  observe(target, options) {
    this.observed = { target, options }
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
const teardowns = []
const ctx = {
  effect(fn) {
    teardowns.push(fn)
  },
}
clientModule.apply(ctx)

assert.equal(state.observers.length, 1, 'exactly one MutationObserver')
assert.deepEqual(state.observers[0].observed.options.attributeFilter, ['data-expanded'])
assert.equal(state.frames.length, 1, 'initial scan scheduled')

// First pass: a DOM mutation arrives, the scheduled frame runs the scan;
// collapsed row expands, open row untouched, mounting row waits.
state.observers[0].callback()
state.frames.shift()()
assert.equal(roots.collapsed.rowClicks, 1, 'collapsed row clicked once')
assert.equal(roots.open.rowClicks, 0, 'open row left alone')
assert.equal(roots.mounting.rowClicks, 0, 'missing row not clicked')

// Second pass: processed roots are never re-clicked (manual collapse sticks).
state.observers[0].callback()
state.frames.shift()()
assert.equal(roots.collapsed.rowClicks, 1, 'no double toggle on rescan')
assert.equal(roots.open.rowClicks, 0)

// Teardown disconnects the observer (ctx.effect(setup) returns the cleanup).
teardowns.map((fn) => fn()).forEach((cleanup) => cleanup())
assert.equal(state.observers[0].disconnected, true, 'observer disconnected on teardown')

console.log('auto-expand-sim: all assertions passed')

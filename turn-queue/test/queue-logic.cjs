#!/usr/bin/env node
/**
 * Offline checks for the Turn Queue client half.
 *
 * Runs the real client.js inside a vm sandbox with a stubbed module loader,
 * then drives the session-status source the platform exposes and inspects the
 * persisted queue in localStorage. Renders nothing, so no DOM or React runtime
 * is needed; the header slot is only captured, never mounted.
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

function makeStorage() {
  const map = new Map()
  return {
    read() {
      const raw = map.get('turn-queue.entries.v1')
      return raw === undefined ? [] : JSON.parse(raw).map((entry) => entry.id)
    },
    getItem(key) { return map.get(key) ?? null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
  }
}

function makeList() {
  const state = { phase: 'ready', ids: [], byId: {} }
  const subs = new Set()
  return {
    getSnapshot: () => state,
    subscribe(listener) { subs.add(listener); return () => subs.delete(listener) },
    set(rows) {
      state.ids = rows.map((row) => row.id)
      state.byId = Object.fromEntries(rows.map((row) => [row.id, row]))
      for (const listener of [...subs]) listener()
    },
    subs,
    state,
  }
}

function makeStatus() {
  let snapshot = new Map()
  const subs = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { subs.add(listener); return () => subs.delete(listener) },
    set(map) {
      snapshot = map
      for (const listener of [...subs]) listener()
    },
  }
}

function load(sandbox) {
  let captured
  sandbox.window = {
    __ModuleLoader__: {
      load(entry) { captured = entry.factory(sandbox.require) },
    },
  }
  sandbox.require = (name) => {
    if (name === 'react') return { createElement: () => null, useCallback: (fn) => fn, useSyncExternalStore: () => null }
    throw new Error(`unexpected require ${name}`)
  }
  sandbox.document = {
    createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    head: { appendChild() {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  if (captured === undefined) throw new Error('module loader was not called')
  return captured
}

function boot() {
  const storage = makeStorage()
  const list = makeList()
  const status = makeStatus()
  const opened = []
  const registered = []
  const sandbox = {
    localStorage: storage,
    console: { log() {}, error() {}, warn() {} },
    Date, Map, Set, JSON, Object, Array, Number, String, Promise, Error,
    setTimeout, clearTimeout,
  }
  const mod = load(sandbox)
  const ctx = {
    sessions: { list },
    uiSession: { sessionStatus: status },
    effect(run) { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(_names, run) { run() },
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      return undefined
    },
    slots: {
      inject(_name, factory) { registered.push(factory()) },
      register(config) { return { config } },
    },
  }
  mod.apply(ctx)
  return { storage, list, status, opened, registered, ctx }
}

let failures = 0
function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}`)
  }
}

// 1. Empty start
{
  const env = boot()
  check('starts with an empty queue', env.storage.read().length === 0)
  check('registers one header slot', env.registered.length === 1)
}

// 2. Completion enters the queue in order
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.status.set(new Map([['A', { running: false, completionUnread: true }]]))
  check('first completion is queued', env.storage.read().join(',') === 'A')

  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  env.status.set(new Map([
    ['A', { running: false, completionUnread: true }],
    ['B', { running: false, completionUnread: true }],
  ]))
  check('second completion appends', env.storage.read().join(',') === 'A,B')
}

// 3. Re-running the same session does not duplicate the entry
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.status.set(new Map([['A', { running: false, completionUnread: true }]]))
  env.status.set(new Map([['A', { running: true, completionUnread: false }]]))
  env.status.set(new Map([['A', { running: false, completionUnread: true }]]))
  check('re-completion keeps one entry', env.storage.read().join(',') === 'A')
}

// 4. Visiting the session (unread cleared) drops the entry
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  env.status.set(new Map([
    ['A', { running: false, completionUnread: true }],
    ['B', { running: false, completionUnread: true }],
  ]))
  env.status.set(new Map([
    ['A', { running: false, completionUnread: false }],
    ['B', { running: false, completionUnread: true }],
  ]))
  check('cleared unread drops only that entry', env.storage.read().join(',') === 'B')
}

// 5. Subagent sessions never enter the queue
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'S', displayTitle: 'Child', subagent: { address: { mode: 'continuable' } } },
  ])
  env.status.set(new Map([
    ['A', { running: false, completionUnread: true }],
    ['S', { running: false, completionUnread: true }],
  ]))
  check('subagent completion is filtered', env.storage.read().join(',') === 'A')
}

// 6. Deleted sessions are pruned
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  env.status.set(new Map([
    ['A', { running: false, completionUnread: true }],
    ['B', { running: false, completionUnread: true }],
  ]))
  env.list.set([{ id: 'B', displayTitle: 'Session B', subagent: null }])
  check('removed session is pruned', env.storage.read().join(',') === 'B')
}

// 7. Hard cap of 50 entries, oldest dropped first
{
  const env = boot()
  const rows = []
  for (let index = 0; index < 60; index += 1) {
    rows.push({ id: `S${index}`, displayTitle: `Session ${index}`, subagent: null })
  }
  env.list.set(rows)
  const map = new Map()
  for (const row of rows) map.set(row.id, { running: false, completionUnread: true })
  env.status.set(map)
  const queue = env.storage.read()
  check('caps the queue at 50 entries', queue.length === 50)
  check('keeps the newest entries', queue[0] === 'S10' && queue[49] === 'S59')
}

// 8. A reload restores the persisted queue and prunes dead sessions
{
  const storage = makeStorage()
  storage.setItem('turn-queue.entries.v1', JSON.stringify([
    { id: 'A', at: 1 },
    { id: 'GONE', at: 2 },
    { id: 'B', at: 3 },
  ]))
  const list = makeList()
  list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  const status = makeStatus()
  const sandbox = {
    localStorage: storage,
    console: { log() {}, error() {}, warn() {} },
    Date, Map, Set, JSON, Object, Array, Number, String, Promise, Error,
    setTimeout, clearTimeout,
  }
  const mod = load(sandbox)
  mod.apply({
    sessions: { list },
    uiSession: { sessionStatus: status },
    effect(run) { run() },
    inject(_names, run) { run() },
    get() { return undefined },
    slots: { inject(_n, factory) { factory() }, register: (config) => ({ config }) },
  })
  check('restores the queue and drops dead sessions', storage.read().join(',') === 'A,B')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall queue checks passed')
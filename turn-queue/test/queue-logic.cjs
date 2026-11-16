#!/usr/bin/env node
/**
 * Offline checks for the Turn Queue client half.
 *
 * Runs the real client.js inside a vm sandbox with a stubbed module loader,
 * then drives the session-status source the platform exposes and inspects the
 * persisted queue in localStorage. Renders nothing, so no DOM or React runtime
 * is needed; the header slot is only captured, never mounted.
 *
 * The queue records a running-edge: a session enters when its `running` flag
 * falls from true to false, which is what the platform publishes when a turn
 * settles.
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
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useCallback: (fn) => fn,
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return { IconQueueOutlineRegular: function IconQueueOutlineRegular() { return null } }
    }
    throw new Error(`unexpected require ${name}`)
  }
  sandbox.document = {
    createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    head: { appendChild() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  vm.createContext(sandbox)
  vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })
  if (captured === undefined) throw new Error('module loader was not called')
  return captured
}

function boot() {
  const clock = { now: 100000 }
  const storage = makeStorage()
  const list = makeList()
  const status = makeStatus()
  const opened = []
  const registered = []
  const icons = []
  const sandbox = {
    localStorage: storage,
    console: { log() {}, error() {}, warn() {} },
    Date: { now: () => clock.now },
    CSS: { escape: (value) => value },
    Map, Set, JSON, Object, Array, Number, String, Promise, Error,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  }
  const mod = load(sandbox)
  let goalPhase = 'complete'
  let currentKey
  const archived = []
  const menus = []
  const ctx = {
    sessions: {
      list,
      binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => ({ goal: { phase: goalPhase } }) }) } } }),
    },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: archived }) } },
    contextMenus: { register: (input) => { menus.push(input); return () => {} } },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    uiSession: {
      sessionStatus: status,
      current: { getSnapshot: () => ({ key: currentKey }) },
    },
    effect(run) { const dispose = run(); return typeof dispose === 'function' ? dispose : () => {} },
    get(name) {
      if (name === 'uiWorkspace') return { openSession: (id) => opened.push(id) }
      return undefined
    },
    slots: {
      // Only the header slot renders a component; icon slots contribute one
      // icon component and no element of their own.
      inject(name, factory) {
        if (name === 'contextMenu.icon') {
          for (const value of factory()) icons.push(value)
          return
        }
        // The header slot registers a plain element (no generator).
        registered.push(factory())
      },
      register(config, Component) { return { config, Component } },
    },
  }
  mod.apply(ctx)
  return {
    storage, list, status, opened, registered, icons, ctx, clock, menus, archived,
    setGoal: (phase) => { goalPhase = phase },
    setCurrent: (id) => { currentKey = id },
  }
}

/** Drive one session through a full turn: running, then the unread completion edge. */
function finishTurn(env, id, map = new Map()) {
  map.set(id, { running: true, completionUnread: false })
  env.status.set(new Map(map))
  map.set(id, { running: false, completionUnread: true })
  env.status.set(new Map(map))
  return map
}

/** Render the slot once and click the nth button cell. */
function clickCell(env, index = 0) {
  const tree = env.registered[0].Component()
  const cells = Array.isArray(tree.children[0]) ? tree.children[0] : tree.children
  const buttons = cells.filter((cell) => cell !== null && typeof cell === 'object' && cell.type === 'button')
  buttons[index].props.onClick()
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
  check('registers one sidebar menu action', env.menus.length === 1)
  check('contributes one menu icon', env.icons.length === 1 && env.icons[0].config.key === 'workspace.queue')
  check('slot exposes a component', typeof env.registered[0].Component === 'function')
}

// 2. A settled turn enters the queue, in order
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  const map = finishTurn(env, 'A')
  check('first settled turn is queued', env.storage.read().join(',') === 'A')

  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  finishTurn(env, 'B', map)
  check('second settled turn appends', env.storage.read().join(',') === 'A,B')
}

// 3. Re-running the same session keeps a single entry
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  finishTurn(env, 'A')
  finishTurn(env, 'A')
  check('re-running keeps one entry', env.storage.read().join(',') === 'A')
}

// 4. A session already finished before the plugin loaded is not queued
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.status.set(new Map([['A', { running: false }]]))
  env.clock.now += 9000
  env.status.set(new Map([['A', { running: false }]]))
  check('pre-existing finished session is not queued', env.storage.read().length === 0)
}

// 5. A session with an active goal stays out until the goal settles
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.setGoal('active')
  let map = finishTurn(env, 'A')
  check('active goal is not queued', env.storage.read().length === 0)
  env.setGoal('paused')
  env.status.set(new Map(map))
  check('paused goal is not queued', env.storage.read().length === 0)
  env.setGoal('complete')
  env.status.set(new Map(map))
  check('settled goal is queued', env.storage.read().join(',') === 'A')
}

// 6. An entry is withdrawn when its goal stops being complete
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.setGoal('complete')
  const map = finishTurn(env, 'A')
  check('completed goal is queued', env.storage.read().join(',') === 'A')
  env.setGoal('paused')
  env.status.set(new Map(map))
  check('unfinished goal withdraws the entry', env.storage.read().length === 0)
}

// 7. Subagent sessions never enter the queue
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'S', displayTitle: 'Child', subagent: { address: { mode: 'continuable' } } },
  ])
  const map = finishTurn(env, 'A')
  finishTurn(env, 'S', map)
  check('subagent completion is filtered', env.storage.read().join(',') === 'A')
}

// 8. A session waiting on the user is queued immediately
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'S', displayTitle: 'Child', subagent: { address: { mode: 'continuable' } } },
  ])
  env.status.set(new Map([
    ['A', { running: true, pendingInteraction: { key: 'q1' } }],
    ['S', { running: true, pendingInteraction: { key: 'q1' } }],
  ]))
  check('waiting session is queued while running', env.storage.read().join(',') === 'A')
  env.status.set(new Map([
    ['A', { running: true, pendingInteraction: null }],
  ]))
  check('answering keeps the entry', env.storage.read().join(',') === 'A')
}

// 9. The session on screen never notifies the user about itself
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.setCurrent('A')
  finishTurn(env, 'A')
  check('the session on screen is not queued', env.storage.read().length === 0)

  env.setCurrent('B')
  const env2 = boot()
  env2.list.set([{ id: 'C', displayTitle: 'Session C', subagent: null }])
  env2.setCurrent('Z')
  finishTurn(env2, 'C')
  check('a background session is queued', env2.storage.read().join(',') === 'C')
}

// 10. Opening a session clears its queued events
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.setCurrent('Z')
  const map = finishTurn(env, 'A')
  check('background session queued first', env.storage.read().join(',') === 'A')
  env.setCurrent('A')
  env.status.set(new Map(map))
  check('switching to it clears the entry', env.storage.read().length === 0)
}

// 11. A read event never comes back, but a later event does
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.status.set(new Map([['A', { running: true, pendingInteraction: { key: 'q1' } }]]))
  check('waiting event queued', env.storage.read().join(',') === 'A')
  clickCell(env)
  check('clicking removes it', env.storage.read().length === 0)
  check('clicking opens the session', env.opened.join(',') === 'A')

  // The same question is still pending: the read event must not return.
  env.status.set(new Map([['A', { running: true, pendingInteraction: { key: 'q1' } }]]))
  check('read event stays gone while still pending', env.storage.read().length === 0)

  // User answers, the turn settles: that is a NEW event.
  env.status.set(new Map([['A', { running: true, completionUnread: false }]]))
  env.status.set(new Map([['A', { running: false, completionUnread: true }]]))
  check('the later completion event shows up', env.storage.read().join(',') === 'A')
}

// 12. Deleted sessions are pruned
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  const map = finishTurn(env, 'A')
  finishTurn(env, 'B', map)
  env.list.set([{ id: 'B', displayTitle: 'Session B', subagent: null }])
  check('removed session is pruned', env.storage.read().join(',') === 'B')
}

// 13. Hard cap of 50 entries, oldest dropped first
{
  const env = boot()
  const rows = []
  for (let index = 0; index < 60; index += 1) {
    rows.push({ id: `S${index}`, displayTitle: `Session ${index}`, subagent: null })
  }
  env.list.set(rows)
  const map = new Map()
  for (const row of rows) map.set(row.id, { running: true, completionUnread: false })
  env.status.set(new Map(map))
  for (const row of rows) map.set(row.id, { running: false, completionUnread: true })
  env.status.set(new Map(map))
  const queue = env.storage.read()
  check('caps the queue at 50 entries', queue.length === 50)
  check('keeps the newest entries', queue[0] === 'S10' && queue[49] === 'S59')
}

// 14. Clicking an entry opens the session and removes it from the queue
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  const map = finishTurn(env, 'A')
  finishTurn(env, 'B', map)
  check('two entries queued before the click', env.storage.read().join(',') === 'A,B')

  const tree = env.registered[0].Component()
  const cells = Array.isArray(tree.children[0]) ? tree.children[0] : tree.children
  const button = cells.find((cell) => cell !== null && typeof cell === 'object' && cell.type === 'button')
  check('first entry renders as a button', button !== undefined && button.props.title === 'Session A')
  button.props.onClick()

  check('click opens that session', env.opened.join(',') === 'A')
  check('click removes the entry', env.storage.read().join(',') === 'B')

  const treeAfter = env.registered[0].Component()
  const cellsAfter = Array.isArray(treeAfter.children[0]) ? treeAfter.children[0] : treeAfter.children
  check('the next entry slides into the first slot',
    cellsAfter[0].props.title === 'Session B')
}

// 15. A single slot is rendered while the queue is empty
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  const tree = env.registered[0].Component()
  const cells = Array.isArray(tree.children[0]) ? tree.children[0] : tree.children
  check('empty queue renders exactly one slot', cells.length === 1)
}

// 16. A reload restores the persisted queue and prunes dead sessions
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
  const clock = { now: 100000 }
  const sandbox = {
    localStorage: storage,
    console: { log() {}, error() {}, warn() {} },
    Date: { now: () => clock.now },
    CSS: { escape: (value) => value },
    Map, Set, JSON, Object, Array, Number, String, Promise, Error,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  }
  const mod = load(sandbox)
  mod.apply({
    sessions: { list },
    uiSession: { sessionStatus: status },
    effect(run) { run() },
    get() { return undefined },
    slots: { inject(_n, factory) { factory() }, register: (config) => ({ config }) },
  })
  check('restores the queue and drops dead sessions', storage.read().join(',') === 'A,B')
}

// 17. The sidebar menu queues a session by hand, at the tail
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  finishTurn(env, 'A')
  const action = () => env.menus[0].resolve({ sessionId: 'B', displayTitle: 'Session B' })[0]
  check('menu offers to queue', action().label === 'menu.queue')
  action().run()
  check('menu queues the session at the tail', env.storage.read().join(',') === 'A,B')
  action().run()
  check('queuing twice keeps one row', env.storage.read().join(',') === 'A,B')
}

// 18. Clicking a hand-queued row opens it and takes it out of the queue
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  env.setCurrent('Z')
  env.menus[0].resolve({ sessionId: 'B' })[0].run()
  finishTurn(env, 'A')
  check('hand-queued row keeps its earlier slot', env.storage.read().join(',') === 'B,A')
  const tree = env.registered[0].Component()
  const cells = Array.isArray(tree.children[0]) ? tree.children[0] : tree.children
  cells[0].props.onClick()
  check('click opens that session', env.opened.join(',') === 'B')
  check('click removes the hand-queued row', env.storage.read().join(',') === 'A')
  env.setCurrent('B')
  env.status.set(new Map([['B', { running: false }]]))
  check('the opened row stays gone', env.storage.read().join(',') === 'A')
}

// 19. An automatic event of a hand-queued session keeps that one row in place
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.setCurrent('Z')
  env.menus[0].resolve({ sessionId: 'A' })[0].run()
  finishTurn(env, 'A')
  const raw = JSON.parse(env.storage.getItem('turn-queue.entries.v1'))
  check('one row per session', raw.length === 1 && raw[0].id === 'A')
  check('the row stays hand-queued', raw[0].kind === 'manual')
}

// 20. Queuing a session that already has an automatic row reuses that slot
{
  const env = boot()
  env.list.set([
    { id: 'A', displayTitle: 'Session A', subagent: null },
    { id: 'B', displayTitle: 'Session B', subagent: null },
  ])
  env.status.set(new Map([['A', { running: true, pendingInteraction: { key: 'q1' } }]]))
  finishTurn(env, 'B')
  check('auto rows first', env.storage.read().join(',') === 'A,B')
  env.menus[0].resolve({ sessionId: 'A' })[0].run()
  check('still one row for the session', env.storage.read().join(',') === 'B,A')
  const raw = JSON.parse(env.storage.getItem('turn-queue.entries.v1'))
  check('the row became hand-queued at the tail', raw[1].kind === 'manual')
}

// 21. Archiving a hand-queued session drops its row
{
  const env = boot()
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  env.menus[0].resolve({ sessionId: 'A' })[0].run()
  env.archived.push('A')
  env.list.set([{ id: 'A', displayTitle: 'Session A', subagent: null }])
  check('archived hand-queued row is dropped', env.storage.read().length === 0)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall queue checks passed')
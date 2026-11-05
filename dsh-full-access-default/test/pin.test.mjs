// Host pin contract: created sessions get the configured preset facts; seeded
// sessions keep theirs; Settings names the preset when the config leaves it out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fakeSession(id, seed = []) {
  const log = [...seed]
  return {
    id,
    get seq() { return log.length },
    eventAt: (seq) => log[seq],
    append: (type, data) => { log.push({ type, data }) },
    log,
  }
}

function harness({ settings = {}, config = {}, injected = false, captured = {} } = {}) {
  const listeners = {}
  const ctx = {
    on: (type, fn) => { listeners[type] = fn },
    logger: { info: () => {}, warn: () => {} },
    settings: { get: (key) => settings[key] },
    ...(injected
      ? {
          inject: (services, fn) => {
            const routes = []
            fn({
              effect: (factory) => { routes.push(factory()); return () => {} },
              connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
            })
            captured.routes = routes
          },
        }
      : {}),
  }
  apply(ctx, config)
  return (session) => listeners['session/created'](session)
}

const facts = (session) => session.log.map(({ type, data }) => [type, data])

test('fresh session is pinned to the configured preset', () => {
  const create = harness({ config: { preset: 'danger-full-access' } })
  const session = fakeSession('s1')
  create(session)
  assert.deepEqual(facts(session), [
    ['permission/preset', { preset: 'danger-full-access' }],
    ['sandbox/mode', { mode: 'danger-full-access' }],
    ['approval/policy', { policy: 'never' }],
  ])
})

test('session that already holds facts keeps them', () => {
  const create = harness({ config: { preset: 'danger-full-access' } })
  const session = fakeSession('s2', [{ type: 'approval/policy', data: { policy: 'ask' } }])
  create(session)
  assert.equal(session.log.length, 1)
})

test('diagnostics route is registered through the connection carrier', async () => {
  const captured = {}
  harness({ config: { preset: 'danger-full-access' }, injected: true, captured })
  const route = captured.routes?.find((item) => item?.path === '/api/full-access-default/log')
  assert.equal(route?.methods?.[0], 'POST')
  const response = await route.fetch({ json: async () => ({ event: 'test', detail: { ok: true } }) })
  assert.equal(response.ok, true)
})

test('settings wins when the config leaves the preset out', () => {
  const create = harness({ settings: { defaultPreset: 'workspace-write' } })
  const session = fakeSession('s3')
  create(session)
  assert.deepEqual(facts(session)[0], ['permission/preset', { preset: 'workspace-write' }])
})

test('unknown settings value falls back to full access', () => {
  const create = harness({ settings: { defaultPreset: 'auto' } })
  const session = fakeSession('s4')
  create(session)
  assert.deepEqual(facts(session)[0], ['permission/preset', { preset: 'danger-full-access' }])
})

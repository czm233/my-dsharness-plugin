/**
 * Host-half simulation for business-flows: drives the real index.js apply()
 * against a fake ctx (canned sessionQuery events + captured fetch route) with
 * DSH_HOME pointed at a temp dir, then asserts the RPC contract end-to-end:
 * workspace resolution, create, collect (extraction + duplicate), list order,
 * rename, flow read, remove. Run: node business-flows/test/host-sim.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bfc-sim-'))
  process.env.DSH_HOME = home
  const SESSION_ID = 'test-session-1'
  fs.mkdirSync(path.join(home, 'sessions', '--Users-czm-test-project--', `session-${SESSION_ID}`), { recursive: true })

  const EVENTS = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '第一个问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { turn: 0, message: { content: [{ type: 'text', text: '思考中' }] } } },
    { type: 'tool/call', seq: 3, data: {} },
    { type: 'assistant/message', seq: 4, data: { turn: 0, message: { content: [{ type: 'text', text: '最终答案' }] } } },
    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: '系统提醒' }], source: { kind: 'reminder' } } },
    { type: 'user/message', seq: 6, data: { content: [{ type: 'text', text: '第二个问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 7, data: { turn: 1, message: { content: [{ type: 'text', text: '答案二' }] } } },
  ]

  const routes = new Map()
  const child = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } },
    effect(fn) { return fn() },
  }
  const ctx = {
    inject(_deps, fn) { fn(child) },
    get(name) {
      return name === 'sessionQuery' ? {
        readSession: async (id) => {
          const bare = String(id).startsWith('session-') ? String(id).slice('session-'.length) : String(id)
          if (bare === 'ghost-cwd-1') return { events: EVENTS, cwd: '/Users/czm/test-project' }
          return { events: bare === SESSION_ID || bare === 'other-1' ? (bare === 'other-1' ? [] : EVENTS) : [] }
        },
      } : undefined
    },
  }

  const { apply } = await import('../index.js')
  apply(ctx)

  const route = routes.get('/api/business-flows/rpc')
  assert(route !== undefined, 'route registered')
  assert(typeof route.fetch === 'function', 'route has fetch handler')

  async function rpc(payload) {
    const response = await route.fetch({ json: async () => ({ rpcId: 'sim', payload }) })
    const body = await response.json()
    assert(body && typeof body === 'object' && body.type === 'server-response', 'rpc envelope')
    return body.result
  }

  // 1. create
  let result = await rpc({ action: 'create', sessionId: SESSION_ID, title: '登录流程' })
  assert(result.ok === true, 'create ok')
  const flowId = result.value.flow.id
  assert(/^f-[a-z0-9-]+$/.test(flowId), 'flow id shape')
  assert(result.value.flow.title === '登录流程', 'create title')
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', '--Users-czm-test-project--', 'index.json')), 'index written under workspace key')

  // 2. collect turn 0 into it: question = last user before first assistant of turn, answer = last assistant text
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 0, flowId })
  assert(result.ok === true, 'collect ok')
  assert(result.value.duplicate === undefined, 'first collect not duplicate')
  const entry = result.value.entry
  assert(entry.question === '第一个问题', `question extracted, got: ${entry.question}`)
  assert(entry.answer === '最终答案', `answer is last assistant text, got: ${entry.answer}`)
  assert(entry.turn === 0 && entry.sessionId === SESSION_ID, 'entry keyed by turn+session')

  // 3. duplicate collect
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 0, flowId })
  assert(result.ok === true && result.value.duplicate === true, 'duplicate detected')
  assert(result.value.flow.entries.length === 1, 'duplicate adds nothing')

  // 4. collect turn 1 with a new title (reminder user message must be skipped, floor respected)
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 1, title: '语音识别' })
  assert(result.ok === true, 'collect-into-new ok')
  assert(result.value.entry.question === '第二个问题', `reminder skipped as question, got: ${result.value.entry.question}`)
  assert(result.value.entry.answer === '答案二', 'answer for turn 1')

  // 5. turn without assistant text fails cleanly
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 5, flowId })
  assert(result.ok === false && /no collectable answer/.test(result.error.message), 'empty turn rejected')

  // 6. list: newest-updated first
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  assert(result.ok === true && result.value.flows.length === 2, 'two flows listed')
  assert(result.value.flows[0].title === '语音识别', `newest first, got: ${result.value.flows[0].title}`)

  // 7. rename
  result = await rpc({ action: 'rename', sessionId: SESSION_ID, id: flowId, title: '登录流程（修订）' })
  assert(result.ok === true && result.value.flow.title === '登录流程（修订）', 'rename applied')

  // 8. flow detail
  result = await rpc({ action: 'flow', sessionId: SESSION_ID, id: flowId })
  assert(result.ok === true && result.value.flow.entries.length === 1, 'flow detail readable')

  // 9. remove
  result = await rpc({ action: 'remove', sessionId: SESSION_ID, id: flowId })
  assert(result.ok === true && result.value.removed === true, 'remove ok')
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  assert(result.value.flows.length === 1, 'remove leaves one flow')
  assert(!fs.existsSync(path.join(home, 'storages', 'business-flows', '--Users-czm-test-project--', `${flowId}.json`)), 'flow file gone')

  // 10. session outside any workspace fails with clear error
  result = await rpc({ action: 'list', sessionId: 'ghost-session' })
  assert(result.ok === false && /known workspace/.test(result.error.message), 'unknown workspace rejected')

  // 11. per-workspace isolation: another workspace sees none of these
  fs.mkdirSync(path.join(home, 'sessions', '--Users-czm-other-project--', 'session-other-1'), { recursive: true })
  result = await rpc({ action: 'list', sessionId: 'other-1' })
  assert(result.ok === true && result.value.flows.length === 0, 'other workspace empty')

  // 12. canonical prefixed id resolves to the SAME workspace shelf
  result = await rpc({ action: 'create', sessionId: `session-${SESSION_ID}`, title: '前缀形态' })
  assert(result.ok === true, 'prefixed id accepted')
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  assert(result.ok === true && result.value.flows.some(flow => flow.title === '前缀形态'), 'prefixed id hits same shelf')

  // 13. cwd fallback: id unknown to the store layout but sessionQuery reports cwd
  result = await rpc({ action: 'create', sessionId: 'session-ghost-cwd-1', title: 'cwd 兜底' })
  assert(result.ok === true, 'cwd fallback accepted')
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', '--Users-czm-test-project--', 'index.json')), 'cwd fallback writes under derived key')

  console.log('host-sim: all assertions passed')
}

let failures = 0
function assert(condition, label) {
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
  }
}

main().then(() => {
  if (failures > 0) process.exit(1)
}).catch((error) => {
  console.error('host-sim crashed:', error)
  process.exit(1)
})

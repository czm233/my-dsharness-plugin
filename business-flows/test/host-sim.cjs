/**
 * Host-half simulation for business-flows 0.2: drives the real index.js
 * apply() against a fake ctx (canned sessionQuery events + captured fetch
 * routes) with DSH_HOME pointed at a temp dir, asserting the markdown-note
 * contract end-to-end: workspace resolution (both id shapes), create,
 * collect appends a marker-marked section, duplicate detection, save,
 * upload + asset route, legacy JSON migration, rename/remove.
 * Run: node business-flows/test/host-sim.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bfc-sim-'))
  process.env.DSH_HOME = home
  const SESSION_ID = 'test-session-1'
  const WS = '--Users-czm-test-project--'
  fs.mkdirSync(path.join(home, 'sessions', WS, `session-${SESSION_ID}`), { recursive: true })

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
    connection: { fetch: { register(route) { routes.set(`${route.methods?.[0] ?? 'GET'} ${route.path}`, route); return () => {} } } },
    effect(fn) { return fn() },
  }
  const ctx = {
    inject(_deps, fn) { fn(child) },
    get(name) {
      return name === 'sessionQuery' ? {
        readSession: async (id) => {
          const bare = String(id).startsWith('session-') ? String(id).slice('session-'.length) : String(id)
          if (bare === 'ghost-cwd-1') return { events: EVENTS, cwd: '/Users/czm/test-project' }
          return { events: bare === 'other-1' ? [] : EVENTS }
        },
      } : undefined
    },
  }

  const { apply, _setOpenForTests } = await import('../index.js')
  const opened = []
  _setOpenForTests((target) => { opened.push(target) })
  apply(ctx)

  const route = routes.get('POST /api/business-flows/rpc')
  const assetRoute = routes.get('GET /api/business-flows/asset')
  assert(route !== undefined, 'rpc route registered')
  assert(assetRoute !== undefined, 'asset route registered')

  async function rpc(payload) {
    const response = await route.fetch({ json: async () => ({ rpcId: 'sim', payload }) })
    const body = await response.json()
    assert(body && typeof body === 'object' && body.type === 'server-response', 'rpc envelope')
    return body.result
  }

  // 1. create writes a real empty .md
  let result = await rpc({ action: 'create', sessionId: SESSION_ID, title: '登录流程' })
  assert(result.ok === true, 'create ok')
  const flowId = result.value.flow.id
  const noteFile = path.join(home, 'storages', 'business-flows', WS, `${flowId}.md`)
  assert(fs.existsSync(noteFile), 'real .md file on disk')
  assert(fs.readFileSync(noteFile, 'utf8') === '', 'created note is empty')

  // 2. collect turn 0 appends a section with question + answer + marker
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 0, flowId })
  assert(result.ok === true && result.value.appended === true, 'collect appends')
  let body = fs.readFileSync(noteFile, 'utf8')
  assert(body.includes('第一个问题'), 'question copied into note')
  assert(body.includes('最终答案'), 'answer copied into note')
  assert(body.includes('<!--bfc s=test-session-1 t=0-->'), 'marker present')
  assert(!body.includes('思考中'), 'intermediate narration not stored')

  // 3. duplicate collect does not append twice
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 0, flowId })
  assert(result.ok === true && result.value.duplicate === true, 'duplicate detected')
  assert(fs.readFileSync(noteFile, 'utf8') === body, 'duplicate adds nothing')

  // 4. collect turn 1 into a NEW note via title (reminder user message skipped)
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 1, title: '语音识别' })
  assert(result.ok === true, 'collect-into-new ok')
  const note2 = path.join(home, 'storages', 'business-flows', WS, `${result.value.flow.id}.md`)
  const body2 = fs.readFileSync(note2, 'utf8')
  assert(body2.includes('第二个问题') && body2.includes('答案二'), 'reminder skipped, content stored')

  // 5. canonical prefixed session id hits the same shelf
  result = await rpc({ action: 'collect', sessionId: `session-${SESSION_ID}`, turn: 1, title: '前缀形态' })
  assert(result.ok === true, 'prefixed id accepted')
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', WS, `${result.value.flow.id}.md`)), 'prefixed id same workspace')

  // 6. save overwrites body
  result = await rpc({ action: 'save', sessionId: SESSION_ID, id: flowId, body: '# 手写内容\n\n- 要点一\n' })
  assert(result.ok === true, 'save ok')
  assert(fs.readFileSync(noteFile, 'utf8').startsWith('# 手写内容'), 'save overwrites body')

  // 7. upload + asset route round-trip
  const pngBase64 = Buffer.from('89504e47', 'hex').toString('base64')
  result = await rpc({ action: 'upload', sessionId: SESSION_ID, id: flowId, name: '截图-测试.png', dataBase64: `data:image/png;base64,${pngBase64}` })
  assert(result.ok === true && result.value.name.endsWith('.png'), 'upload ok')
  const assetRes = await assetRoute.fetch({ url: `http://host/api/business-flows/asset?flow=${flowId}&name=${encodeURIComponent(result.value.name)}` })
  assert(assetRes.status === 200, 'asset served')
  const served = Buffer.from(await assetRes.arrayBuffer()).toString('hex')
  assert(served === '89504e47', `asset bytes round-trip, got ${served}`)
  const bad = await assetRoute.fetch({ url: `http://host/api/business-flows/asset?flow=${flowId}&name=../etc/passwd` })
  assert(bad.status === 404, 'traversal rejected')

  // 7b. assets action returns the uploaded image as a data URL (authorized channel)
  result = await rpc({ action: 'assets', sessionId: SESSION_ID, id: flowId, names: [result.value.name, '不存在.png'] })
  assert(result.ok === true, 'assets ok')
  const keys = Object.keys(result.value.images)
  assert(keys.length === 1, `one image returned, got ${keys.length}`)
  assert(String(Object.values(result.value.images)[0]).startsWith('data:image/png;base64,'), 'data URL shape')

  // 8. flow returns the markdown body
  result = await rpc({ action: 'flow', sessionId: SESSION_ID, id: flowId })
  assert(result.ok === true && result.value.flow.body.startsWith('# 手写内容'), 'flow returns body')

  // 9. legacy 0.1 structured note migrates to markdown on first read
  const legacyId = 'f-legacy'
  fs.writeFileSync(path.join(home, 'storages', 'business-flows', WS, `${legacyId}.json`), JSON.stringify({
    id: legacyId, title: '旧笔记', createdAt: 1, updatedAt: 2,
    entries: [{ at: 1700000000000, sessionId: 'session-x', turn: 3, question: '旧问题', answer: '旧答案' }],
  }), 'utf8')
  result = await rpc({ action: 'flow', sessionId: SESSION_ID, id: legacyId })
  assert(result.ok === true && result.value.flow.body.includes('旧问题') && result.value.flow.body.includes('旧答案'), 'legacy migrated to md')
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', WS, `${legacyId}.md`)), 'legacy .md written')
  assert(!fs.existsSync(path.join(home, 'storages', 'business-flows', WS, `${legacyId}.json`)), 'legacy .json removed')

  // 10. list reflects md files; rename + remove
  result = await rpc({ action: 'rename', sessionId: SESSION_ID, id: flowId, title: '登录流程（修订）' })
  assert(result.ok === true && result.value.flow.title === '登录流程（修订）', 'rename applied')
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  assert(result.ok === true && result.value.flows.length === 4, `four notes listed, got ${result.value.flows?.length}`)
  result = await rpc({ action: 'remove', sessionId: SESSION_ID, id: flowId })
  assert(result.ok === true && result.value.removed === true, 'remove ok')
  assert(!fs.existsSync(noteFile), 'note file gone')
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  assert(result.value.flows.length === 3, 'remove leaves three')

  // 11. unknown workspace + empty turn fail cleanly
  result = await rpc({ action: 'list', sessionId: 'ghost-session' })
  assert(result.ok === false && /known workspace/.test(result.error.message), 'unknown workspace rejected')
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 5, flowId })
  assert(result.ok === false && /no collectable answer/.test(result.error.message), 'empty turn rejected')

  // 12. cwd fallback: id unknown to the store layout but sessionQuery reports cwd
  result = await rpc({ action: 'create', sessionId: 'session-ghost-cwd-1', title: 'cwd 兜底' })
  assert(result.ok === true, 'cwd fallback accepted')
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', '--Users-czm-test-project--', 'index.json')), 'cwd fallback writes under derived key')

  // 13. openPath: URL / existing file open, missing file and relative path rejected
  result = await rpc({ action: 'openPath', sessionId: SESSION_ID, path: 'https://example.com/x.html' })
  assert(result.ok === true && result.value.opened === true, 'http url opens')
  const existFile = path.join(home, 'storages', 'business-flows', WS, 'f-legacy.md')
  result = await rpc({ action: 'openPath', sessionId: SESSION_ID, path: existFile })
  assert(result.ok === true && result.value.opened === true, 'existing file opens')
  assert(opened.includes(existFile), 'opener received the file path')
  result = await rpc({ action: 'openPath', sessionId: SESSION_ID, path: '/nonexistent/nope.html' })
  assert(result.ok === false && /path not found/.test(result.error.message), 'missing path rejected')
  result = await rpc({ action: 'openPath', sessionId: SESSION_ID, path: 'relative/path.html' })
  assert(result.ok === false && /absolute paths/.test(result.error.message), 'relative path rejected')

  // 14. create without title names the note after the current timestamp
  const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( \(\d+\))?$/
  result = await rpc({ action: 'create', sessionId: SESSION_ID })
  assert(result.ok === true && STAMP.test(result.value.flow.title), `timestamp title, got ${result.value.flow?.title}`)
  assert(result.value.flow.title.startsWith(String(new Date().getFullYear())), 'timestamp title is today')
  const firstAuto = result.value.flow.title
  result = await rpc({ action: 'create', sessionId: SESSION_ID, title: '' })
  assert(result.ok === true && STAMP.test(result.value.flow.title), 'empty title also uses timestamp')
  assert(result.value.flow.title !== firstAuto, 'same-second auto title deduped')
  result = await rpc({ action: 'list', sessionId: SESSION_ID })
  const autoTitles = result.value.flows.filter(meta => STAMP.test(meta.title)).map(meta => meta.title)
  assert(new Set(autoTitles).size === autoTitles.length, 'auto names unique')

  // 14b. collect with neither flowId nor title creates a timestamp-named note
  result = await rpc({ action: 'collect', sessionId: SESSION_ID, turn: 1 })
  assert(result.ok === true && STAMP.test(result.value.flow.title), `collect auto-names, got ${result.value.flow?.title}`)
  assert(fs.existsSync(path.join(home, 'storages', 'business-flows', WS, `${result.value.flow.id}.md`)), 'auto-named note is a real .md')

  // 15. search hits titles and bodies
  result = await rpc({ action: 'search', sessionId: SESSION_ID, query: '语音识别' })
  assert(result.ok === true && result.value.flows.some(flow => flow.title === '语音识别'), 'search by title')
  result = await rpc({ action: 'search', sessionId: SESSION_ID, query: '答案二' })
  assert(result.ok === true && result.value.flows.some(flow => flow.title === '语音识别'), 'search by body')
  result = await rpc({ action: 'search', sessionId: SESSION_ID, query: 'ZZZ-不存在的词' })
  assert(result.ok === true && result.value.flows.length === 0, 'no match → empty')

  if (failures === 0) console.log("host-sim: all assertions passed")
}

let failures = 0
function assert(condition, label) {
  if (!condition) {
    failures += 1
    console.error(`FAIL: ${label}`)
  }
}

main().then(() => {
  if (failures > 0) {
    console.error(`host-sim: ${failures} assertion(s) failed`)
    process.exit(1)
  }
}).catch((error) => {
  console.error('host-sim crashed:', error)
  process.exit(1)
})

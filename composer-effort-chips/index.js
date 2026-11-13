/**
 * Host half of the composer bundle: per-session persona prompt sections.
 *
 * 人格清单是磁盘上的纯 JSON（见 personasPath），客户端只负责挑一个。
 * section 的 text 是函数，每次 assemble 都重读 bindings，所以切换人格后
 * 下一条消息即生效；没选人格时渲染空串，整段被过滤掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SECTION_NAME = 'persona:active'
// 官方 personaPrefix 在 order 0；紧跟其后，又排在各工具说明之前。
const SECTION_ORDER = 1
const MAX_PROMPT_BYTES = 16384
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

function storageDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'composer-effort-chips')
}

function presetsPath() {
  return path.join(storageDir(), 'personas.json')
}

function bindingsPath() {
  return path.join(storageDir(), 'bindings.json')
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function readPresets() {
  const doc = readJson(presetsPath(), {})
  const list = doc && Array.isArray(doc.presets) ? doc.presets : []
  const seen = new Set()
  const presets = []
  for (const entry of list) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = entry && typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!ID_PATTERN.test(id) || !name || seen.has(id)) continue
    seen.add(id)
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.slice(0, MAX_PROMPT_BYTES) : ''
    presets.push({ id, name, prompt })
  }
  return presets
}

function readBindings() {
  const doc = readJson(bindingsPath(), {})
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}
}

function currentPersonaId(sessionId) {
  if (!sessionId) return ''
  const id = readBindings()[sessionId]
  return typeof id === 'string' ? id : ''
}

function personaText(sessionId) {
  const presetId = currentPersonaId(sessionId)
  if (!presetId) return ''
  const preset = readPresets().find(entry => entry.id === presetId)
  return preset ? preset.prompt.trim() : ''
}

function selectPersona(sessionId, presetId) {
  const bindings = readBindings()
  if (presetId === '') delete bindings[sessionId]
  else bindings[sessionId] = presetId
  writeJson(bindingsPath(), bindings)
}

const attached = new Set()

function attachSection(agent) {
  if (!agent || !agent.ctx) return
  const sessionId = String(agent.id || '')
  if (!sessionId || attached.has(sessionId)) return
  const systemPrompt = agent.ctx.systemPrompt
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return
  systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // 人格正文可能含 {{…}}，不能被当成变量插值。
    interpolate: false,
    text: () => personaText(sessionId),
  })
  attached.add(sessionId)
}

/** 已存在的会话在插件加载前没有 section，选择人格时补挂一次。 */
function ensureSection(ctx, sessionId) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent) attachSection(agent)
  } catch {
    /* 补挂失败不影响存储 */
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function validSessionId(value) {
  return typeof value === 'string' && value !== '' && value.length <= 128 && !value.includes('/')
}

export function apply(ctx) {
  // 每个会话创建时挂一条空壳 section；选谁由下面的 text 函数现查。
  ctx.on('agent/created', payload => {
    try {
      attachSection(payload && payload.agent)
    } catch {
      /* 注入失败不影响会话创建 */
    }
  })

  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.connection
    if (!connection || !connection.fetch) return
    connectionCtx.effect(() =>
      connection.fetch.register({
        path: '/api/composer-effort-chips/rpc',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          let body = null
          try {
            body = await request.json()
          } catch {
            return json({ error: 'bad-body' }, 400)
          }
          if (!body || typeof body !== 'object') return json({ error: 'bad-body' }, 400)
          const sessionId = body.sessionId
          if (!validSessionId(sessionId)) return json({ error: 'bad-session' }, 400)
          try {
            if (body.action === 'list') {
              return json({
                presets: readPresets().map(({ id, name }) => ({ id, name })),
                selected: currentPersonaId(sessionId),
              })
            }
            if (body.action === 'select') {
              const presetId = typeof body.presetId === 'string' ? body.presetId : ''
              if (presetId !== '' && !readPresets().some(entry => entry.id === presetId)) {
                return json({ error: 'unknown-persona' }, 404)
              }
              selectPersona(sessionId, presetId)
              ensureSection(ctx, sessionId)
              return json({ ok: true, selected: presetId })
            }
            return json({ error: 'unknown-action' }, 400)
          } catch {
            return json({ error: 'storage-failed' }, 500)
          }
        },
      }),
    )
  })
}
/**
 * Host half of Business Flows (业务流程).
 *
 * A per-workspace markdown shelf — a built-in Obsidian, nothing more:
 * every note is a REAL <flowId>.md file under
 * ~/.dsh/storages/business-flows/<workspace-key>/, images live in a sibling
 * <flowId>.assets/ folder and are referenced relatively, so the notes stay
 * readable/editable outside DSH too. <workspace-key> is the session-store
 * directory name that encodes the session's cwd, so every session of the
 * same project shares one shelf and other projects see their own.
 *
 * Collecting appends the turn's question + answer as a markdown section
 * (marker comment enables duplicate detection); the note is plain text from
 * then on — the user edits and appends freely in the tab.
 *
 * RPC actions (client → host, /api/business-flows/rpc):
 *   list    { sessionId }                          → { flows }
 *   flow    { sessionId, id }                      → { flow: {id,title,body} }
 *   create  { sessionId, title }                   → { flow }
 *   rename  { sessionId, id, title }               → { flow }
 *   remove  { sessionId, id }                      → { removed: true }
 *   collect { sessionId, turn, flowId? | title? }  → { flow, duplicate? }
 *   save    { sessionId, id, body }                → { flow }
 *   upload  { sessionId, id, name, dataBase64 }    → { name }
 * GET /api/business-flows/asset?flow=<id>&name=<file> serves note images.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE = '/api/business-flows/rpc'
const ASSET_ROUTE = '/api/business-flows/asset'
const LIMITS = {
  titleMax: 60,
  questionMax: 20000,
  answerMax: 120000,
  bodyMax: 512 * 1024,
  uploadMax: 12 * 1024 * 1024,
  flowsMax: 200,
}
const ASSET_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

function dshHome() {
  const raw = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : ''
  return raw !== '' ? raw : path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function storageRoot() {
  return path.join(dshHome(), 'storages', 'business-flows')
}

function sanitizeSessionId(raw) {
  const id = String(raw ?? '').trim()
  return /^[\w][\w.-]{0,99}$/.test(id) ? id : ''
}

function sanitizeFlowId(raw) {
  const id = String(raw ?? '').trim()
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : ''
}

function sanitizeTitle(raw) {
  const title = String(raw ?? '').replace(/\s+/g, ' ').trim()
  return title.slice(0, LIMITS.titleMax)
}

function mintFlowId() {
  return sanitizeFlowId(`f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`) || `f-${Date.now().toString(36)}`
}

/**
 * Resolve the workspace key of a session from the session-store layout:
 * ~/.dsh/sessions/<encoded-workspace>/session-<id>/… — the encoded directory
 * name is itself filesystem-safe, so it doubles as the storage folder name.
 * The client-prop session id may arrive with or without the canonical
 * `session-` prefix; try every shape. @returns {string} encoded workspace
 * directory name, or '' when unknown.
 */
function workspaceKeyFor(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return ''
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const candidates = [...new Set([raw, bare, `session-${bare}`])]
  const root = sessionsRoot()
  let entries
  try {
    entries = fs.readdirSync(root)
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!(entry.startsWith('--') && entry.endsWith('--'))) continue
    for (const candidate of candidates) {
      try {
        fs.accessSync(path.join(root, entry, candidate))
        return entry
      } catch {
        /* not in this workspace */
      }
    }
  }
  return ''
}

function notePath(wsDir, id) {
  return path.join(wsDir, `${sanitizeFlowId(id)}.md`)
}

function assetsDir(wsDir, id) {
  return path.join(wsDir, `${sanitizeFlowId(id)}.assets`)
}

async function readBody(wsDir, id) {
  try {
    return await fsp.readFile(notePath(wsDir, id), 'utf8')
  } catch {
    return null
  }
}

async function writeBody(wsDir, id, body) {
  await fsp.mkdir(wsDir, { recursive: true })
  await fsp.writeFile(notePath(wsDir, id), String(body ?? ''), 'utf8')
}

/**
 * One-time migration: legacy 0.1 notes stored entries as structured JSON.
 * Fold them into a markdown body, write the .md, drop the .json.
 */
async function migrateLegacyJson(wsDir, id, legacy) {
  if (legacy === null || typeof legacy !== 'object' || !Array.isArray(legacy.entries)) return null
  const sections = legacy.entries.map((entry) => {
    if (entry === null || typeof entry !== 'object') return ''
    const at = new Date(Number(entry.at ?? 0))
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = Number.isFinite(at.getTime())
      ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
      : ''
    const question = String(entry.question ?? '').slice(0, LIMITS.questionMax)
    const answer = String(entry.answer ?? '').slice(0, LIMITS.answerMax)
    const marker = entry.sessionId !== undefined && entry.turn !== undefined
      ? ` <!--bfc s=${String(entry.sessionId).replace(/--/g, '')} t=${Number(entry.turn)}-->`
      : ''
    const quoted = question !== '' ? `> ${question.replace(/\n+/g, '\n> ')}\n\n` : ''
    return `## ${stamp}${marker}\n\n${quoted}${answer}\n`
  })
  const body = sections.filter(Boolean).join('\n')
  await writeBody(wsDir, id, body)
  await fsp.rm(path.join(wsDir, `${sanitizeFlowId(id)}.json`), { force: true })
  return body
}

async function readNote(wsDir, id, titleFallback) {
  const flowId = sanitizeFlowId(id)
  if (flowId === '') return null
  let body = await readBody(wsDir, flowId)
  if (body === null) {
    // legacy structured note → fold into markdown on first touch
    try {
      const raw = await fsp.readFile(path.join(wsDir, `${flowId}.json`), 'utf8')
      body = await migrateLegacyJson(wsDir, flowId, JSON.parse(raw))
    } catch {
      body = null
    }
  }
  if (body === null) return null
  return { id: flowId, title: titleFallback ?? flowId, body }
}

async function readIndex(wsDir) {
  try {
    const raw = await fsp.readFile(path.join(wsDir, 'index.json'), 'utf8')
    const index = JSON.parse(raw)
    if (index !== null && typeof index === 'object' && Array.isArray(index.flows)) return index
  } catch {
    /* missing or corrupt → rebuild below */
  }
  return null
}

async function writeIndex(wsDir, flows) {
  await fsp.mkdir(wsDir, { recursive: true })
  await fsp.writeFile(path.join(wsDir, 'index.json'), JSON.stringify({ flows }, null, 2), 'utf8')
}

/** Notes of one workspace: scan the real .md files, merge stored titles, newest first. */
async function listFlows(wsDir) {
  let names
  try {
    names = await fsp.readdir(wsDir)
  } catch {
    return []
  }
  const index = await readIndex(wsDir)
  const titleById = new Map((index?.flows ?? []).map(meta => [meta.id, meta]))
  // scan real .md notes plus legacy 0.1 structured .json notes (migrated on open)
  const ids = names
    .filter(name => (name.endsWith('.md') || (name.endsWith('.json') && name !== 'index.json')))
    .map(name => name.slice(0, name.lastIndexOf('.')))
  const metas = []
  for (const id of ids) {
    const stored = titleById.get(id)
    let createdAt = stored?.createdAt ?? 0
    let stat = null
    try {
      stat = await fsp.stat(notePath(wsDir, id))
    } catch {
      try {
        stat = await fsp.stat(path.join(wsDir, `${id}.json`))
      } catch {
        continue
      }
    }
    const updatedAt = stat.mtimeMs
    if (!createdAt) createdAt = updatedAt
    metas.push({ id, title: stored?.title ?? id, createdAt, updatedAt })
  }
  metas.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  const same = JSON.stringify(metas.map(m => [m.id, m.title, Math.round(m.createdAt), Math.round(m.updatedAt)]))
    === JSON.stringify((index?.flows ?? []).map(m => [m.id, m.title, Math.round(m.createdAt), Math.round(m.updatedAt)]))
  if (!same) await writeIndex(wsDir, metas).catch(() => {})
  return metas
}

/** Serialize mutations per workspace: rapid double-collect must not lose a section. */
const locks = new Map()
function withLock(key, fn) {
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  locks.set(key, next.catch(() => {}))
  return next
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim() === '') continue
    parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Extract the (question, answer) pair of one turn from session events.
 * The question is the last human prompt before the turn's first assistant
 * message (and after the previous turn's last one); the answer is the turn's
 * last committed assistant text. Returns null when the turn has no answer.
 */
function extractTurn(events, turn) {
  let question = ''
  let answer = ''
  let floorSeq = 0
  let targetFirstSeq = Number.POSITIVE_INFINITY
  for (const event of events) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'assistant/message') {
      const eventTurn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
      if (eventTurn !== undefined && eventTurn < turn) floorSeq = Math.max(floorSeq, Number(event.seq ?? 0))
      if (eventTurn === turn) {
        targetFirstSeq = Math.min(targetFirstSeq, Number(event.seq ?? 0))
        const text = textOfContent(event.data?.message?.content)
        if (text !== '') answer = text
      }
    }
  }
  if (!Number.isFinite(targetFirstSeq)) return null
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source !== undefined && source !== null && typeof source.kind === 'string' && source.kind !== 'user') continue
    const seq = Number(event.seq ?? 0)
    if (seq <= floorSeq || seq >= targetFirstSeq) continue
    const text = textOfContent(event.data?.content)
    if (text !== '') question = text
  }
  if (answer === '') return null
  return { question: question.slice(0, LIMITS.questionMax), answer: answer.slice(0, LIMITS.answerMax) }
}

function stampOf(at) {
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sectionOf(qa, sessionId, turn, at) {
  const marker = `<!--bfc s=${String(sessionId).replace(/-{2,}/g, '-')} t=${Number(turn)}-->`
  const quoted = qa.question !== '' ? `> ${qa.question.replace(/\n+/g, '\n> ')}\n\n` : ''
  return `## ${stampOf(at)} ${marker}\n\n${quoted}${qa.answer}\n`
}

function contentTypeOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  return ASSET_TYPES[ext] ?? null
}

export function apply(ctx) {
  ctx.inject(['sessionQuery', 'connection'], (child) => {
    child.effect(() => {
      const disposables = [
        child.connection.fetch.register({
          path: ROUTE,
          methods: ['POST'],
          fetch: (request) => serve(request),
        }),
        child.connection.fetch.register({
          path: ASSET_ROUTE,
          methods: ['GET'],
          fetch: (request) => serveAsset(request),
        }),
      ]
      return () => {
        for (const dispose of disposables) dispose()
      }
    }, 'business-flows: rpc + asset routes')
  })

  async function requireWorkspace(sessionId) {
    let key = workspaceKeyFor(sessionId)
    if (key === '') key = await workspaceFromSnapshot(sessionId)
    if (key === '') throw new Error('session does not belong to a known workspace')
    return key
  }

  /** Fallback: derive the encoded workspace name from the session's recorded cwd. */
  async function workspaceFromSnapshot(sessionId) {
    try {
      const query = ctx.get('sessionQuery')
      const snapshot = query !== undefined && query !== null && typeof query.readSession === 'function'
        ? await query.readSession(sessionId)
        : null
      const cwd = snapshot?.cwd ?? snapshot?.header?.cwd ?? snapshot?.session?.cwd
      if (typeof cwd === 'string' && cwd.startsWith('/')) {
        return `--${cwd.slice(1).replace(/\//g, '--')}--`
      }
    } catch {
      /* fallback only */
    }
    return ''
  }

  async function createFlow(wsDir, title) {
    const existing = await listFlows(wsDir)
    if (existing.length >= LIMITS.flowsMax) throw new Error('flow limit reached')
    const now = Date.now()
    const flow = { id: mintFlowId(), title, createdAt: now, updatedAt: now }
    await writeBody(wsDir, flow.id, '')
    await writeIndex(wsDir, [flow, ...existing])
    return { ...flow, body: '' }
  }

  async function collectFor(payload) {
    const sessionId = sanitizeSessionId(payload.sessionId)
    if (sessionId === '') throw new Error('sessionId is required')
    const turn = Number(payload.turn)
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('turn must be a non-negative integer')
    const query = ctx.get('sessionQuery')
    if (query === undefined || query === null || typeof query.readSession !== 'function') {
      throw new Error('sessionQuery.readSession is unavailable')
    }
    const snapshot = await query.readSession(sessionId)
    const qa = extractTurn(snapshot?.events ?? [], turn)
    if (qa === null) throw new Error('this turn has no collectable answer')
    const wsKey = await requireWorkspace(sessionId)
    const wsDir = path.join(storageRoot(), wsKey)
    return withLock(wsKey, async () => {
      let flow = null
      let title = ''
      const flowId = sanitizeFlowId(payload.flowId)
      if (flowId !== '') {
        const metas = await listFlows(wsDir)
        const meta = metas.find(entry => entry.id === flowId)
        if (meta === undefined) throw new Error('flow not found')
        title = meta.title
        flow = { id: flowId }
      } else {
        const newTitle = sanitizeTitle(payload.title)
        if (newTitle === '') throw new Error('title is required')
        const created = await createFlow(wsDir, newTitle)
        flow = { id: created.id }
        title = created.title
      }
      let body = await readBody(wsDir, flow.id) ?? ''
      const marker = `<!--bfc s=${String(sessionId).replace(/-{2,}/g, '-')} t=${turn}-->`
      if (body.includes(marker)) return { flow: { ...flow, title, body }, duplicate: true }
      const at = Date.now()
      body = `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}\n${sectionOf(qa, sessionId, turn, at)}`
      await writeBody(wsDir, flow.id, body.slice(0, LIMITS.bodyMax))
      const metas = await listFlows(wsDir)
      return { flow: metas.find(entry => entry.id === flow.id) ?? { ...flow, title }, appended: true }
    })
  }

  async function uploadFor(payload, wsDir) {
    const id = sanitizeFlowId(payload.id)
    if (id === '') throw new Error('id is required')
    let raw = String(payload.dataBase64 ?? '')
    const comma = raw.indexOf(',')
    if (raw.startsWith('data:') && comma >= 0) raw = raw.slice(comma + 1)
    if (raw === '' || raw.length > LIMITS.uploadMax) throw new Error('image too large or empty')
    const baseName = path.basename(String(payload.name ?? '')).replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').slice(0, 80)
    const ext = path.extname(baseName).slice(1).toLowerCase()
    if (!(ext in ASSET_TYPES)) throw new Error('unsupported image type')
    const dir = assetsDir(wsDir, id)
    await fsp.mkdir(dir, { recursive: true })
    let name = baseName
    try {
      await fsp.access(path.join(dir, name))
      name = `${path.basename(baseName, path.extname(baseName))}-${Date.now().toString(36)}.${ext}`
    } catch {
      /* unique */
    }
    await fsp.writeFile(path.join(dir, name), Buffer.from(raw, 'base64'))
    return { name }
  }

  async function serve(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = body?.rpcId
    const respond = (result) => Response.json({ type: 'server-response', rpcId, result })
    try {
      const payload = body?.payload !== null && typeof body?.payload === 'object' ? body.payload : {}
      const action = String(payload.action ?? '')
      const sessionId = sanitizeSessionId(payload.sessionId)
      if (sessionId === '') throw new Error('sessionId is required')
      const wsKey = await requireWorkspace(sessionId)
      const wsDir = path.join(storageRoot(), wsKey)
      let value
      if (action === 'list') {
        value = { flows: await listFlows(wsDir) }
      } else if (action === 'flow') {
        const metas = await listFlows(wsDir)
        const meta = metas.find(entry => entry.id === sanitizeFlowId(payload.id))
        const note = meta === undefined ? null : await readNote(wsDir, meta.id, meta.title)
        if (note === null) throw new Error('flow not found')
        value = { flow: { ...meta, body: note.body } }
      } else if (action === 'create') {
        const title = sanitizeTitle(payload.title)
        if (title === '') throw new Error('title is required')
        value = { flow: await withLock(wsKey, () => createFlow(wsDir, title)) }
      } else if (action === 'rename' || action === 'remove') {
        const id = sanitizeFlowId(payload.id)
        if (id === '') throw new Error('id is required')
        value = await withLock(wsKey, async () => {
          if (action === 'rename') {
            const title = sanitizeTitle(payload.title)
            if (title === '') throw new Error('title is required')
            const metas = await listFlows(wsDir)
            if (!metas.some(entry => entry.id === id)) throw new Error('flow not found')
            const updated = metas.map(meta => meta.id === id ? { ...meta, title } : meta)
            await writeIndex(wsDir, updated)
            return { flow: updated.find(meta => meta.id === id) }
          }
          await fsp.rm(notePath(wsDir, id), { force: true })
          await fsp.rm(assetsDir(wsDir, id), { recursive: true, force: true })
          const metas = (await listFlows(wsDir)).filter(entry => entry.id !== id)
          await writeIndex(wsDir, metas)
          return { removed: true }
        })
      } else if (action === 'collect') {
        value = await collectFor(payload)
      } else if (action === 'save') {
        const id = sanitizeFlowId(payload.id)
        if (id === '') throw new Error('id is required')
        if (typeof payload.body !== 'string') throw new Error('body must be a string')
        value = await withLock(wsKey, async () => {
          const metas = await listFlows(wsDir)
          if (!metas.some(entry => entry.id === id)) throw new Error('flow not found')
          await writeBody(wsDir, id, payload.body.slice(0, LIMITS.bodyMax))
          const next = await listFlows(wsDir)
          return { flow: next.find(entry => entry.id === id) ?? null }
        })
      } else if (action === 'upload') {
        value = await withLock(wsKey, () => uploadFor(payload, wsDir))
      } else {
        throw new Error(`unknown action ${JSON.stringify(action)}`)
      }
      return respond({ ok: true, value })
    } catch (error) {
      return respond({
        ok: false,
        error: { code: 'internal', message: String(error?.message ?? error), details: {} },
      })
    }
  }

  async function serveAsset(request) {
    let url
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const flowId = sanitizeFlowId(url.searchParams.get('flow'))
    const name = path.basename(String(url.searchParams.get('name') ?? ''))
    const type = contentTypeOf(name)
    if (flowId === '' || name === '' || type === null) return new Response('not found', { status: 404 })
    const candidates = []
    const root = storageRoot()
    let entries
    try {
      entries = fs.readdirSync(root)
    } catch {
      return new Response('not found', { status: 404 })
    }
    for (const entry of entries) {
      if (entry.startsWith('--') && entry.endsWith('--')) candidates.push(path.join(root, entry, `${flowId}.assets`, name))
    }
    for (const file of candidates) {
      try {
        const data = await fsp.readFile(file)
        return new Response(data, {
          headers: { 'content-type': type, 'cache-control': 'private, max-age=2592000, immutable' },
        })
      } catch {
        /* try next workspace */
      }
    }
    return new Response('not found', { status: 404 })
  }
}

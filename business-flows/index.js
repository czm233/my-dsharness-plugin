/**
 * Host half of Business Flows (业务流程).
 *
 * A per-workspace note shelf: one "business flow" is a note that collects
 * (question, answer) pairs picked from conversation turns. Storage lives in
 * ~/.dsh/storages/business-flows/<workspace-key>/ — outside every project
 * directory. <workspace-key> is the session-store directory name that encodes
 * the session's cwd (~/.dsh/sessions/--Users-…-<project>--), so notes follow
 * the DSH notion of "project": every session in the same workspace shares the
 * same shelf, and switching projects switches the shelf.
 *
 * The turn's text is read through the sessionQuery service (the same source
 * turn-cost folds usage from); only question/answer text is stored, tool
 * traffic and context reminders stay out.
 *
 * RPC actions (client → host, /api/business-flows/rpc):
 *   list    { sessionId }                    → { flows }
 *   flow    { sessionId, id }                → { flow }
 *   create  { sessionId, title }             → { flow }
 *   rename  { sessionId, id, title }         → { flow }
 *   remove  { sessionId, id }                → { removed: true }
 *   collect { sessionId, turn, flowId? | title? } → { flow, entry?, duplicate? }
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE = '/api/business-flows/rpc'
const LIMITS = {
  titleMax: 60,
  questionMax: 20000,
  answerMax: 120000,
  entriesMax: 200,
  flowsMax: 200,
}

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

function flowPath(wsDir, id) {
  return path.join(wsDir, `${sanitizeFlowId(id)}.json`)
}

async function readFlow(wsDir, id) {
  try {
    const raw = await fsp.readFile(flowPath(wsDir, id), 'utf8')
    const flow = JSON.parse(raw)
    if (flow === null || typeof flow !== 'object' || sanitizeFlowId(flow.id) !== sanitizeFlowId(id)) return null
    if (!Array.isArray(flow.entries)) flow.entries = []
    return flow
  } catch {
    return null
  }
}

async function writeFlow(wsDir, flow) {
  await fsp.mkdir(wsDir, { recursive: true })
  await fsp.writeFile(flowPath(wsDir, flow.id), JSON.stringify(flow, null, 2), 'utf8')
}

function metaOf(flow) {
  return { id: flow.id, title: flow.title, createdAt: flow.createdAt, updatedAt: flow.updatedAt, count: flow.entries.length }
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

/** Flows of one workspace, newest-updated first. Reads index.json, falls back to scanning. */
async function listFlows(wsDir) {
  const index = await readIndex(wsDir)
  if (index !== null) return index.flows
  let names
  try {
    names = await fsp.readdir(wsDir)
  } catch {
    return []
  }
  const metas = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'index.json') continue
    const flow = await readFlow(wsDir, name.slice(0, -5))
    if (flow !== null) metas.push(metaOf(flow))
  }
  metas.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
  await writeIndex(wsDir, metas).catch(() => {})
  return metas
}

/** Serialize mutations per workspace: rapid double-collect must not lose an entry. */
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
 * last committed assistant text — the same "one reply per turn" rule the
 * side-chat preview uses. Returns null when the turn has no assistant text.
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

export function apply(ctx) {
  ctx.inject(['sessionQuery', 'connection'], (child) => {
    child.effect(() => {
      const dispose = child.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        fetch: (request) => serve(request),
      })
      return () => {
        dispose()
      }
    }, 'business-flows: rpc route')
  })

  /** @returns {Promise<string>} encoded workspace key */
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
    const now = Date.now()
    const flow = { id: mintFlowId(), title, createdAt: now, updatedAt: now, entries: [] }
    const existing = await listFlows(wsDir)
    if (existing.length >= LIMITS.flowsMax) throw new Error('flow limit reached')
    await writeFlow(wsDir, flow)
    await writeIndex(wsDir, [metaOf(flow), ...existing])
    return flow
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
      const flowId = sanitizeFlowId(payload.flowId)
      if (flowId !== '') {
        flow = await readFlow(wsDir, flowId)
        if (flow === null) throw new Error('flow not found')
      } else {
        const title = sanitizeTitle(payload.title)
        if (title === '') throw new Error('title is required')
        flow = await createFlow(wsDir, title)
      }
      const existing = flow.entries.findIndex(entry => entry !== null && typeof entry === 'object'
        && entry.sessionId === sessionId && Number(entry.turn) === turn)
      if (existing >= 0) return { flow, duplicate: true }
      const now = Date.now()
      flow.entries.push({ at: now, sessionId, turn, question: qa.question, answer: qa.answer })
      if (flow.entries.length > LIMITS.entriesMax) flow.entries = flow.entries.slice(-LIMITS.entriesMax)
      flow.updatedAt = now
      await writeFlow(wsDir, flow)
      const flows = await listFlows(wsDir)
      const meta = metaOf(flow)
      const next = [meta, ...flows.filter(entry => entry.id !== flow.id)]
      await writeIndex(wsDir, next)
      return { flow, entry: flow.entries[flow.entries.length - 1] }
    })
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
        const flow = await readFlow(wsDir, payload.id)
        if (flow === null) throw new Error('flow not found')
        value = { flow }
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
            const flow = await readFlow(wsDir, id)
            if (flow === null) throw new Error('flow not found')
            flow.title = title
            flow.updatedAt = Date.now()
            await writeFlow(wsDir, flow)
          } else {
            await fsp.rm(flowPath(wsDir, id), { force: true })
          }
          const flows = (await listFlows(wsDir)).filter(entry => entry.id !== id)
          const refreshed = []
          for (const meta of flows) {
            if (action === 'rename' && meta.id === id) {
              const flow = await readFlow(wsDir, id)
              refreshed.push(flow === null ? meta : metaOf(flow))
            } else {
              refreshed.push(meta)
            }
          }
          refreshed.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
          await writeIndex(wsDir, refreshed)
          return action === 'rename' ? { flow: await readFlow(wsDir, id) } : { removed: true }
        })
      } else if (action === 'collect') {
        value = await collectFor(payload)
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
}

/**
 * Host half of Side Chat (侧边对话), fork-subagent edition.
 *
 * The Client half posts the first side-chat message to `/api/side-chat/create`;
 * this half resolves the live parent Agent for the session and starts one
 * continuable child activation through the `fork` subagent backend
 * (`dsh-subagent-fork-in-process`), whose seed is the parent's completed
 * conversation turns. The child therefore continues the parent conversation
 * with full inherited context, never joins the left session list, and is
 * chatted with through the official subagent delivery surface.
 *
 * Service access follows the shipped plugins' conventions: only the optional
 * web carrier (`connection`) goes through a runtime inject sub-context, and
 * the core services resolve lazily via ctx.get at request time — the same way
 * goal-round-driver reaches `subagents`. `resolveAgent` lives on the session
 * controller's `agents` sub-controller (the same resolver the Host's own
 * fileUploads agent resolver calls); both shapes are probed defensively.
 *
 * Diagnostics: the desktop client has no console, so every create attempt and
 * lifecycle marker appends one JSON line under ~/Library/Application Support/
 * dsh-side-chat/host.log — readable post-mortem without touching the UI.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.env.HOME ?? '.', 'Library', 'Application Support', 'dsh-side-chat')
const LOG_FILE = join(LOG_DIR, 'host.log')
const CHILDREN_FILE = join(LOG_DIR, 'children.json')

/** Append one bounded diagnostics line; never throws into the request path. */
function log(event, extra = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const body = JSON.stringify({ t: new Date().toISOString(), event, ...extra })
    appendFileSync(LOG_FILE, `${body.slice(0, 2000)}\n`)
  } catch { /* diagnostics only */ }
}

// ---------------------------------------------------------------------------
// Settlement-notice suppression.
//
// A side-chat child is created with `delivery: 'caller'`, which suppresses the
// delegation return guidance and, on that activation, the settlement notice.
// The shipped manager closes the activation once the child goes idle, so every
// later message cold-resumes it — and `coldResume` materializes the activation
// without forwarding `delivery`, which falls back to `'parent'`. From then on
// each answered turn posts "Background subagent <id> finished ..." into the
// parent conversation, waking it for no reason (the side chat is a chat, not a
// delegation).
//
// The fix stays local and fail-open: remember the ids of children this plugin
// created (persisted so a restart still covers their resumes) and drop that one
// message shape — `source.kind === 'subagent-settled'` naming such a child —
// when it is handed to an Agent. Every other message, and every child that
// belongs to a real delegation, passes through untouched.
// ---------------------------------------------------------------------------

/** Child session ids this plugin created (in memory + persisted). */
const sideChatChildren = new Set()

/** Agents whose delivery methods are already wrapped. */
const guardedAgents = new WeakSet()

/** Load the persisted child ids; failures just leave the set empty. */
function loadChildren() {
  try {
    const parsed = JSON.parse(readFileSync(CHILDREN_FILE, 'utf8'))
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') sideChatChildren.add(id)
  } catch { /* first run or unreadable */ }
  // Backfill from the create trail: a child made before this bookkeeping
  // existed still needs its notices suppressed after a resume.
  try {
    const trail = readFileSync(LOG_FILE, 'utf8')
    for (const line of trail.split('\n')) {
      if (!line.includes('"event":"created"')) continue
      const id = JSON.parse(line)?.childId
      if (typeof id === 'string') sideChatChildren.add(id)
    }
  } catch { /* no trail yet */ }
}

/** Persist the current child ids; failures keep the in-memory set usable. */
function saveChildren() {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(CHILDREN_FILE, JSON.stringify([...sideChatChildren]))
  } catch { /* diagnostics only */ }
}

/** Record one child this plugin created. */
function rememberChild(childId) {
  if (sideChatChildren.has(childId)) return
  sideChatChildren.add(childId)
  saveChildren()
}

/**
 * The child a settlement notice names, when it is a settlement notice.
 * @param message - candidate user message.
 * @returns the sender child id, or undefined for any other message.
 */
function settlementChildOf(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object') return undefined
  if (source.kind !== 'subagent-settled') return undefined
  return typeof source.senderSessionId === 'string' ? source.senderSessionId : undefined
}

/**
 * Drop settlement notices from this plugin's own children on one Agent.
 * @param agent - live Agent whose delivery methods are wrapped.
 */
function guardAgent(agent) {
  if (agent === null || typeof agent !== 'object' || guardedAgents.has(agent)) return
  guardedAgents.add(agent)
  for (const name of ['followup', 'steer', 'inject', 'send']) {
    const original = agent[name]
    if (typeof original !== 'function') continue
    agent[name] = function guardedDelivery(message, ...rest) {
      try {
        const childId = settlementChildOf(message)
        if (childId !== undefined && sideChatChildren.has(childId)) {
          log('settlement suppressed', { childId, via: name })
          return undefined
        }
      } catch { /* fail open: deliver normally */ }
      return original.call(this, message, ...rest)
    }
  }
}

/** Cap the catalog label so one long first message cannot flood the tab strip. */
const LABEL_MAX = 40

/**
 * Resolve the live parent Agent for one ordinary session.
 * @param ctx - Host plugin context.
 * @param sessionId - ordinary session identity.
 * @returns the live Agent.
 */
async function resolveParentAgent(ctx, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('session controller unavailable (ctx.get sessionController)')
  // resolveAgent lives on the .agents sub-controller; probe both shapes.
  const resolver = controller.agents?.resolveAgent ?? controller.resolveAgent
  if (typeof resolver !== 'function') throw new Error('resolveAgent not found on session controller')
  const found = await (controller.agents !== undefined
    ? controller.agents.resolveAgent(sessionId)
    : controller.resolveAgent(sessionId))
  if (found !== null && typeof found === 'object' && 'error' in found) throw found.error
  const parent = found?.agent
  if (parent === undefined) throw new Error(`session "${sessionId}" resolved no agent`)
  return parent
}

/**
 * Create one fork-backend continuable child for the session.
 * @param ctx - Host plugin context.
 * @param body - `{ sessionId, text }` from the Client half.
 * @returns `{ childId, label }`.
 */
async function createBranch(ctx, body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (sessionId === '' || text === '') throw new Error('sessionId and text are required')

  if (typeof ctx.get !== 'function') throw new Error('host context exposes no service lookup')
  const subagents = ctx.get('subagents')
  if (typeof subagents?.startActivation !== 'function') throw new Error('subagent service unavailable')

  const parent = await resolveParentAgent(ctx, sessionId)
  guardAgent(parent)

  const label = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text
  const { childId } = await subagents.startActivation({
    provider: 'fork',
    label,
    request: {
      prompt: [{ type: 'text', text }],
      parent,
    },
    // `caller` keeps the child a plain conversation: the service appends the
    // delegation return guidance ("your parent agent id is …, report with
    // send_message") only for non-caller delivery, and it skips the settlement
    // notice to the parent. The catalog entry is established either way, so
    // the child stays reachable from the parent's subagent header.
    delivery: 'caller',
    // startActivation reads signal.throwIfAborted during creation; a
    // never-aborted signal lets the child persist as a background activation
    // after the route resolves (the delegation tools pass their exec signal).
    signal: new AbortController().signal,
  })
  if (typeof childId !== 'string' || childId === '') throw new Error('subagent service returned no childId')
  rememberChild(childId)
  return { childId, label }
}

/**
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  loadChildren()
  log('host apply', { hasInject: typeof ctx.inject === 'function', hasGet: typeof ctx.get === 'function', children: sideChatChildren.size })

  // Guard every Agent that appears from now on: settlement notices for this
  // plugin's children are dropped before they reach the parent conversation.
  try {
    ctx.on('agent/created', payload => {
      try { guardAgent(payload?.agent) } catch { /* fail open */ }
    })
  } catch { /* the hook is best-effort */ }

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (child) => {
    // Diagnostics: the desktop client has no console, so the browser half POSTs
    // what it observed (module table, render failures) to a Host route that
    // appends one JSON line outside the workspace. Diagnostic-only.
    child.effect(() => {
      const disposeDiag = child.connection.fetch.register({
        path: '/api/side-chat/log',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 800) : ''
            appendFileSync(join(LOG_DIR, 'client-events.jsonl'),
              `${JSON.stringify({ t: new Date().toISOString(), event: String(body?.event ?? ''), detail })}\n`)
          } catch (error) {
            log('diag write failed', { error: String(error) })
          }
          return new Response(null, { status: 204 })
        },
      })
      return () => { disposeDiag() }
    }, 'side-chat: diag route')

    log('connection injected', { hasFetch: typeof child.connection?.fetch?.register === 'function' })
    child.effect(() => {
      const dispose = child.connection.fetch.register({
        path: '/api/side-chat/create',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = null
          try {
            body = await request.json()
          } catch (error) {
            log('bad body', { error: String(error) })
            return Response.json({ error: 'bad-body' }, { status: 400 })
          }
          try {
            const result = await createBranch(ctx, body)
            log('created', { childId: result.childId })
            return Response.json(result)
          } catch (error) {
            const message = String((error && error.message) || error)
            log('create failed', { error: message })
            return Response.json({ error: message }, { status: 500 })
          }
        },
      })
      return () => { dispose() }
    }, 'side-chat: create route')
  })
}

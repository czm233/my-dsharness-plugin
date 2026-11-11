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

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.env.HOME ?? '.', 'Library', 'Application Support', 'dsh-side-chat')
const LOG_FILE = join(LOG_DIR, 'host.log')

/** Append one bounded diagnostics line; never throws into the request path. */
function log(event, extra = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const body = JSON.stringify({ t: new Date().toISOString(), event, ...extra })
    appendFileSync(LOG_FILE, `${body.slice(0, 2000)}\n`)
  } catch { /* diagnostics only */ }
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

  const label = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text
  const { childId } = await subagents.startActivation({
    provider: 'fork',
    label,
    request: {
      prompt: [{ type: 'text', text }],
      parent,
    },
    delivery: 'parent',
  })
  if (typeof childId !== 'string' || childId === '') throw new Error('subagent service returned no childId')
  return { childId, label }
}

/**
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  log('host apply', { hasInject: typeof ctx.inject === 'function', hasGet: typeof ctx.get === 'function' })
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (child) => {
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

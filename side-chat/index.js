/**
 * Host half of Side Chat (侧边对话), native-fork edition.
 *
 * Since 0.5.0 the Client half forks the branch session itself through the
 * client session service (`sessions.fork`) — a plain Host session, not a
 * subagent child — so this half carries no creation logic, no subagent
 * delivery semantics, and no settlement handling anymore. What remains is the
 * diagnostics: the desktop client has no console, so the browser half POSTs
 * what it observed (module load, fork failures) to a Host route that appends
 * one JSON line under ~/Library/Application Support/dsh-side-chat/ — readable
 * post-mortem without touching the UI.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.env.HOME ?? '.', 'Library', 'Application Support', 'dsh-side-chat')

/** Append one bounded diagnostics line; never throws into the request path. */
function log(event, extra = {}) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const body = JSON.stringify({ t: new Date().toISOString(), event, ...extra })
    appendFileSync(join(LOG_DIR, 'host.log'), `${body.slice(0, 2000)}\n`)
  } catch { /* diagnostics only */ }
}

/**
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  log('host apply', { hasInject: typeof ctx.inject === 'function' })

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection'], (child) => {
    log('connection injected', { hasFetch: typeof child.connection?.fetch?.register === 'function' })
    // Diagnostics: the desktop client has no console, so the browser half
    // POSTs what it observed to a Host route that appends one JSON line
    // outside the workspace. Diagnostic-only.
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
  })
}

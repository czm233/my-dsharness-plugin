/**
 * Host half: sessions created without permission facts of their own get the
 * configured preset pinned.
 *
 * Why the shipped default is not enough: `session.create` reuses the previous
 * blank session when asked to, and a reused session keeps the permission facts
 * from its own creation, so Settings › General only decides the first
 * conversation of a process. `session/created` fires once per ordinary session
 * (reused id included), which makes it the one seam that sees every new
 * conversation.
 *
 * The pin appends the same three durable facts a manual switch appends —
 * `permission/preset`, `sandbox/mode`, `approval/policy` — through the session
 * append path and the services' own setters, so replay reconstructs the same
 * policy and the log reads like a user switch. Sessions that already hold any
 * of those facts (restored sessions, children forked from a parent) are left
 * untouched; switching a live session stays a per-session `/permission`.
 */

/** Shipped preset table (name → knob bundle). */
const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
}

/** Facts that mark a session as already having its permissions settled. */
const FACT_TYPES = ['permission/preset', 'sandbox/mode', 'approval/policy']

/** Settings namespace key consulted when the plugin config leaves `preset` unset. */
const SETTINGS_PRESET = 'defaultPreset'

/** Used when neither the config nor Settings names a usable preset. */
const FALLBACK_PRESET = 'danger-full-access'

/**
 * Read one config value, unwrapping a Cordis config ref.
 * @param config - plugin config object.
 * @param key - field name.
 * @returns the plain value, or `undefined`.
 */
function configValue(config, key) {
  const value = config?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Whether one created session already carries a permission fact.
 * @param session - the created session.
 * @returns whether any preset/sandbox/approval event is already recorded.
 */
function hasPermissionFacts(session) {
  const last = typeof session?.seq === 'number' ? session.seq : 0
  for (let seq = last - 1; seq >= 0; seq -= 1) {
    const type = session.eventAt?.(seq)?.type
    if (FACT_TYPES.includes(type)) return true
  }
  return false
}

/**
 * @param ctx - plugin context.
 * @param config - plugin config; `preset` names the preset pinned on new sessions.
 */
export function apply(ctx, config = {}) {
  const configured = configValue(config, 'preset')
  registerDiagnostics(ctx)

  /** Resolve the preset to pin at creation time (Settings is read lazily). */
  const presetOf = () => {
    if (typeof configured === 'string' && Object.hasOwn(PRESETS, configured)) return configured
    try {
      const stored = ctx.settings?.get?.(SETTINGS_PRESET)
      if (typeof stored === 'string' && Object.hasOwn(PRESETS, stored)) return stored
    } catch (error) {
      ctx.logger?.warn?.(`[full-access-default] settings/${SETTINGS_PRESET} unreadable: ${String(error)}`)
    }
    return FALLBACK_PRESET
  }

  ctx.on('session/created', (session) => {
    try {
      if (typeof session?.append !== 'function') return
      if (hasPermissionFacts(session)) return
      const preset = presetOf()
      const spec = PRESETS[preset]
      session.append('permission/preset', { preset })
      session.append('sandbox/mode', { mode: spec.sandbox })
      session.append('approval/policy', { policy: spec.approval })
      ctx.logger?.info?.(`[full-access-default] ${session.id}: pinned to ${preset}`)
    } catch (error) {
      ctx.logger?.warn?.(`[full-access-default] pinning ${session?.id} failed: ${String(error)}`)
    }
  })
}
// ---------------------------------------------------------------------------
// Diagnostics: the desktop client has no console, so the browser half POSTs its
// mount/session observations to a Host route that appends one JSON line to a
// file outside the workspace. Remove this block together with `report()` in
// client.js once the feature is verified.

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.env.HOME ?? '.', 'Library', 'Application Support', 'dsh-client-plugin-full-access-default')
const LOG_FILE = join(LOG_DIR, 'client-events.jsonl')

/** Keep each line bounded so a runaway caller cannot fill the disk. */
function trim(value, depth = 0) {
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (value === null || typeof value !== 'object' || depth > 3) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => trim(item, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, item]) => [key, trim(item, depth + 1)]))
}

/** Append one client observation; never throws into the request path. */
function record(body) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...trim(body) })}\n`)
  } catch {
    // diagnostics only
  }
}

/**
 * Register the diagnostics route through the optional web carrier.
 * @param ctx - Host context whose `connection` service owns fetch routes.
 */
export function registerDiagnostics(ctx) {
  ctx.inject(['connection'], (child) => {
    child.effect(() => {
      const dispose = child.connection.fetch.register({
        path: '/api/full-access-default/log',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            record(await request.json())
          } catch {
            record({ event: 'unparsable' })
          }
          return Response.json({ ok: true })
        },
      })
      return () => { dispose() }
    }, 'full-access-default: diagnostics route')
  })
}

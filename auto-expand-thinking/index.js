/**
 * Host half of auto-expand-thinking.
 *
 * The browser half has no console (desktop client), so its scan breadcrumbs
 * are POSTed here and appended under ~/.dsh/storages/auto-expand-thinking/.
 *
 *   POST /api/auto-expand-thinking/rpc   { action, ... }
 *     { action: 'log', lines }   → append diagnostic lines
 *     { action: 'clear' }        → truncate the diagnostic log
 *
 * Same shape as edit-restart's host half (serialized appends, size-trimmed).
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG_SIZE_LIMIT = 256 * 1024

function storageDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'auto-expand-thinking')
}

function stamp() {
  const now = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

let logChain = Promise.resolve()
/** Serialize appends: concurrent read-modify-write cycles corrupt lines. */
function appendLog(lines) {
  const task = logChain.then(() => appendLogNow(lines), () => appendLogNow(lines))
  logChain = task.catch(() => {})
  return task
}

async function appendLogNow(lines) {
  await fsp.mkdir(storageDir(), { recursive: true })
  const file = path.join(storageDir(), 'client.log')
  let previous = ''
  try {
    const stat = await fsp.stat(file)
    const text = await fsp.readFile(file, 'utf8')
    previous = stat.size > LOG_SIZE_LIMIT ? `--- trimmed ---\n${text.slice(-LOG_SIZE_LIMIT / 2)}` : text
  } catch (_missing) {
    previous = ''
  }
  const body = lines.map((line) => `${stamp()} ${line}`).join('\n')
  await fsp.writeFile(file, `${previous}${previous === '' ? '' : '\n'}${body}\n`, 'utf8')
}

export function apply(ctx) {
  ctx.inject(['connection'], (child) => {
    appendLog(['host loaded']).catch(() => {})
    child.effect(() => child.connection.fetch.register({
      path: '/api/auto-expand-thinking/rpc',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = null
        try {
          body = await request.json()
        } catch {
          return new Response('bad body', { status: 400 })
        }
        const action = typeof body?.action === 'string' ? body.action : ''
        try {
          if (action === 'log') {
            const lines = Array.isArray(body.lines) ? body.lines.map((line) => String(line)).slice(0, 200) : []
            await appendLog(lines)
            return Response.json({ ok: true })
          }
          if (action === 'clear') {
            await fsp.mkdir(storageDir(), { recursive: true })
            await fsp.writeFile(path.join(storageDir(), 'client.log'), '', 'utf8')
            return Response.json({ ok: true })
          }
          return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
        } catch (error) {
          await appendLog([`error ${action}: ${String(error?.stack ?? error)}`]).catch(() => {})
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 })
        }
      },
    }), 'auto-expand-thinking: rpc route')
  })
}

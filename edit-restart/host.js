/**
 * Host half of edit-restart: a tiny diagnostic log sink for the browser half.
 *
 * The desktop client has no developer console, so the client posts breadcrumbs
 * (scan results, click path, fork result) here and they land in
 * ~/.dsh/storages/edit-restart/client.log for the developer to read.
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROUTE = 'edit-restart/rpc'
const LOG_SIZE_LIMIT = 256 * 1024

function storageDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'edit-restart')
}

function stamp() {
  const now = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

async function append(lines) {
  await fsp.mkdir(storageDir(), { recursive: true })
  const file = path.join(storageDir(), 'client.log')
  let previous = ''
  try {
    const stat = await fsp.stat(file)
    if (stat.size > LOG_SIZE_LIMIT) {
      previous = (await fsp.readFile(file, 'utf8')).slice(-LOG_SIZE_LIMIT / 2)
      previous = `--- trimmed ---\n${previous}`
    } else {
      previous = await fsp.readFile(file, 'utf8')
    }
  } catch (_missing) {
    previous = ''
  }
  const body = lines.map((line) => `${stamp()} ${line}`).join('\n')
  await fsp.writeFile(file, `${previous}${previous === '' ? '' : '\n'}${body}\n`, 'utf8')
}

export function apply(ctx) {
  ctx.inject(['connection'], (child) => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/edit-restart/rpc',
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
            await append(lines)
            return Response.json({ ok: true })
          }
          if (action === 'clear') {
            await fsp.mkdir(storageDir(), { recursive: true })
            await fsp.writeFile(path.join(storageDir(), 'client.log'), '', 'utf8')
            return Response.json({ ok: true })
          }
          return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
        } catch (error) {
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 })
        }
      },
    }), 'edit-restart: diag route')
  })
  void ROUTE
}

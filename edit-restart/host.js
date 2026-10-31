/**
 * Host half of edit-restart.
 *
 *   POST /api/edit-restart/rpc   { action, ... }
 *     { action: 'log', lines }                  → 追加诊断到 ~/.dsh/storages/edit-restart/client.log
 *     { action: 'clear' }                       → 清空诊断日志
 *     { action: 'saveDraft', sessionId, turnStartSeq, messageIndex, text, initial }
 *                                               → 保存一份待发送草稿（客户端无法可靠使用 prompt 时由 AI 代为发出）
 *     { action: 'drafts' }                      → 列出所有草稿
 *     { action: 'send', draftId }               → 在当前 Host 进程内用 session 服务把草稿做成分支并发出
 *     { action: 'forget', draftId }             → 删除草稿
 *
 * 草稿保存在 ~/.dsh/storages/edit-restart/drafts.json；`send` 只在当前进程的 Agent 注册表里找会话，
 * 找不到就如实报错（不会强行恢复一个可能跑着别的工作的 Agent）。
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

let logChain = Promise.resolve()
/** 串行化追加：并发请求同时读写同一个文件会把行写坏（实测出现被截断的乱码行）。 */
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

async function readDrafts() {
  try {
    const raw = await fsp.readFile(path.join(storageDir(), 'drafts.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.drafts) ? parsed.drafts : []
  } catch (_missing) {
    return []
  }
}

async function writeDrafts(drafts) {
  await fsp.mkdir(storageDir(), { recursive: true })
  await fsp.writeFile(path.join(storageDir(), 'drafts.json'), JSON.stringify({ drafts }, null, 2), 'utf8')
}

/** 在 Host 进程里找 live agent（限定当前 profile 的注册表）。 */
function liveAgent(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (!agents || typeof agents.get !== 'function') return null
  return agents.get(sessionId) ?? null
}

/** 分支 + 发首条消息：只用 shipped 的 session 服务，不碰持久化文件。 */
async function sendDraft(ctx, draft) {
  const sessionId = String(draft.sessionId)
  const turnStartSeq = Number(draft.turnStartSeq)
  if (!Number.isSafeInteger(turnStartSeq) || turnStartSeq < 0) throw new Error('draft has no valid turnStartSeq')
  const source = liveAgent(ctx, sessionId)
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (!source || !source.session) throw new Error(`session ${sessionId} is not live in this host process`)
  if (!sessions || typeof sessions.fork !== 'function') throw new Error('session store is unavailable')
  const child = await sessions.fork(source.session, { at: turnStartSeq })
  const childId = String(child?.id ?? child?.sessionId ?? child)
  let agent = null
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  for (let attempt = 0; attempt < 40 && agent === null; attempt += 1) {
    agent = agents?.get?.(childId) ?? null
    if (agent === null) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (agent === null || typeof agent.session?.append !== 'function') {
    await appendLog([`send: branch ${childId} created but its agent did not become live`])
    return { childId, sent: false }
  }
  const { randomUUID } = await import('node:crypto')
  agent.session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(draft.text) }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  await appendLog([`send: branch ${childId} created and message appended`])
  return { childId, sent: true }
}

export function apply(ctx) {
  // 把当前 Host 进程的 ctx 暴露给同进程的诊断脚本（桌面端没有控制台，只能由进程内脚本代调 RPC）。
  try {
    globalThis.__editRestartCtx = ctx
    const host = ctx.get('typertGateway') ?? ctx.get('connection')?.gateway
    if (host) globalThis.__editRestartGateway = host
  } catch (_noCtx) { /* 非标准装配下忽略 */ }

  ctx.inject(['connection'], (child) => {
    // 启动即写一条心跳：既能确认 Host 半被载入，也方便对时。
    appendLog(['host loaded']).catch(() => {})
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
            await appendLog(lines)
            return Response.json({ ok: true })
          }
          if (action === 'clear') {
            await fsp.mkdir(storageDir(), { recursive: true })
            await fsp.writeFile(path.join(storageDir(), 'client.log'), '', 'utf8')
            return Response.json({ ok: true })
          }
          if (action === 'saveDraft') {
            const drafts = await readDrafts()
            const draft = {
              id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              sessionId: String(body.sessionId ?? ''),
              turnStartSeq: Number(body.turnStartSeq),
              messageIndex: Number(body.messageIndex),
              text: String(body.text ?? ''),
              initial: String(body.initial ?? ''),
              createdAt: Date.now(),
            }
            drafts.push(draft)
            await writeDrafts(drafts)
            await appendLog([`saveDraft ${draft.id} session=${draft.sessionId} turnStartSeq=${draft.turnStartSeq}`])
            return Response.json({ ok: true, draft })
          }
          if (action === 'drafts') {
            return Response.json({ ok: true, drafts: await readDrafts() })
          }
          if (action === 'send') {
            const drafts = await readDrafts()
            const draft = drafts.find((item) => item.id === body.draftId)
            if (!draft) return Response.json({ ok: false, error: 'draft not found' }, { status: 404 })
            const result = await sendDraft(ctx, draft)
            await appendLog([`send ${draft.id} -> ${JSON.stringify(result)}`])
            return Response.json({ ok: true, ...result })
          }
          if (action === 'forget') {
            const drafts = (await readDrafts()).filter((item) => item.id !== body.draftId)
            await writeDrafts(drafts)
            return Response.json({ ok: true })
          }
          return Response.json({ ok: false, error: 'unknown action' }, { status: 400 })
        } catch (error) {
          await appendLog([`error ${action}: ${String(error?.stack ?? error)}`]).catch(() => {})
          return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 })
        }
      },
    }), 'edit-restart: rpc route')
  })
}

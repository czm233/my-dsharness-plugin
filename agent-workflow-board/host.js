/**
 * Host half of the Agent Workflow Board (流程画布).
 *
 * One authenticated POST route on the shared connection fetch bridge serves
 * the whole editor API — the exact shape workflow-lite proves works on this
 * build (single method, buffered body, parameters in the JSON document, no
 * query strings):
 *
 *   POST /api/agent-canvas/rpc   body: { action, ... }
 *     { action: 'list' }                    -> { canvases: [{id,name,updatedAt}] }
 *     { action: 'get', id }                 -> { canvas } | { error: 'not-found' } 404
 *     { action: 'put', canvas }             -> { canvas }
 *     { action: 'delete', id }              -> { ok: true }
 *     { action: 'agents' }                  -> { agents: [{id,name,description,order}] }
 *     { action: 'bind', sessionId, canvasId }   -> { binding: {canvasId,boundAt} }
 *     { action: 'unbind', sessionId }           -> { ok: true }
 *     { action: 'getBinding', sessionId }       -> { binding } | { binding: null }
 *     { action: 'getStatus', id }               -> { status: {label: {status,note,updatedAt}} }
 *     { action: 'specPreview', canvas }         -> { spec }  (compileSpec on the client's current doc)
 *
 * Canvases persist as JSON documents under the DSH internal storage area
 * (~/.dsh/storages/agent-workflow-board/), never inside project directories.
 * The agent roster comes live from the agentPresets service, so the palette
 * always reflects the installed system- and user-level presets.
 *
 * Session integration (M2/M3):
 *   - agent/created       → bound sessions get the compiled execution spec
 *                           (compileSpec, re-read each prompt assembly).
 *   - sessionProjections  → agentWorkflowBoard projection folds subagent
 *                           tool/call + tool/result into node lanes.
 *   - tools.register      → canvas_report lets the main session report node
 *                           progress; status.json also feeds the M3 fence.
 *   - tools/pre-execute   → the fence: denies subagent dispatch when the
 *                           canvas' current running node is not a dispatch
 *                           work node. Deny text teaches the way back.
 */

import { promises as fsp } from 'node:fs'
import { readFileSync as fspSyncRead } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fspSync = { readFile: fspSyncRead }

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const MAX_DOC_BYTES = 512 * 1024

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function storageDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'agent-workflow-board')
}

function canvasPath(id) {
  return path.join(storageDir(), `canvas-${id}.json`)
}

function sanitizeId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : ''
}

async function readCanvas(id) {
  const text = await fsp.readFile(canvasPath(id), 'utf8')
  if (text.length > MAX_DOC_BYTES) throw new Error('canvas too large')
  return JSON.parse(text)
}

async function writeCanvas(canvas) {
  await fsp.mkdir(storageDir(), { recursive: true })
  const body = JSON.stringify(canvas, null, 2)
  if (body.length > MAX_DOC_BYTES) throw new Error('canvas too large')
  await fsp.writeFile(canvasPath(canvas.id), body, 'utf8')
}

// --- session bindings (M2.1) ---------------------------------------------
// One JSON document maps sessionId -> { canvasId, boundAt }. Small by design;
// read-modify-write whole file on each bind/unbind.
function bindingsPath() {
  return path.join(storageDir(), 'bindings.json')
}

// --- M2.4 运行状态（canvas_report 上报） ------------------------------------
function statusPath() {
  return path.join(storageDir(), 'status.json')
}

async function readStatus() {
  try {
    const raw = JSON.parse(await fsp.readFile(statusPath(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

async function writeStatus(map) {
  await fsp.mkdir(storageDir(), { recursive: true })
  await fsp.writeFile(statusPath(), JSON.stringify(map, null, 2), 'utf8')
}

async function reportNodeStatus(canvasId, label, status, note) {
  const map = await readStatus()
  const entry = map[canvasId] && typeof map[canvasId] === 'object' ? { ...map[canvasId] } : {}
  entry[label] = { status, note: typeof note === 'string' ? note.slice(0, 200) : '', updatedAt: Date.now() }
  map[canvasId] = entry
  await writeStatus(map)
}

async function readBindings() {
  try {
    const text = await fsp.readFile(bindingsPath(), 'utf8')
    const raw = JSON.parse(text)
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

async function writeBindings(map) {
  await fsp.mkdir(storageDir(), { recursive: true })
  await fsp.writeFile(bindingsPath(), JSON.stringify(map, null, 2), 'utf8')
}

function sanitizeSessionId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 ? value : ''
}

// 同步读取（prompt 组装是同步 text 函数，画布很小，可接受）。
function readCanvasSync(id) {
  const text = fspSync.readFile(canvasPath(id), 'utf8')
  return JSON.parse(text)
}

function readBindingsSync() {
  try {
    const raw = JSON.parse(fspSync.readFile(bindingsPath(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

// 八种钩子时机 → 注入规范时的措辞（对应 DSH 事件：agent/created、
// agent/inbox/claimed、tools/pre-execute、tools/post-execute、subagent/start、
// subagent/end、agent/turn-stopping、agent/disposed）。
const HOOK_TIMING_TEXT = {
  'session-start': '会话开始时（进入第一个流程节点之前）先完成',
  'user-message': '收到每条用户消息后，先完成本动作再处理消息',
  'before-dispatch': '每次派发子 agent 之前先核对',
  'after-dispatch': '每次子 agent 派发完成、结果返回后，先按本动作评估结果再继续',
  'subagent-start': '每个子 agent 启动时，向其交代本动作要点',
  'subagent-end': '每个子 agent 结束时，先按本动作核对其产出再继续',
  'turn-stop': '每轮结束收尾时，先按本动作确认进度（必要时用 canvas_report 上报）',
  'session-end': '向用户做最终收尾汇报之前先完成',
}

/**
 * M2.2: compile a canvas document into the structured execution spec injected
 * into the bound session's system prompt. Returns '' when the canvas is not
 * runnable (no Main entry) — the renderer drops empty sections, so an
 * unrunnable canvas simply contributes nothing.
 */
const TYPE_NAMES = { start: '主会话', work: '工作', router: '判断', end: '结束', hook: '钩子' }

function compileSpec(doc) {
  const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : []
  const edges = Array.isArray(doc && doc.edges) ? doc.edges : []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const start = nodes.find(node => node.type === 'start')
  if (!start) return ''
  const outs = new Map()
  for (const edge of edges) {
    if (!outs.has(edge.from)) outs.set(edge.from, [])
    outs.get(edge.from).push(edge)
  }
  // 拓扑顺序：从主会话沿边 BFS，孤岛节点不进规范。
  const order = []
  const seen = new Set([start.id])
  const queue = [start.id]
  while (queue.length > 0) {
    const id = queue.shift()
    const node = byId.get(id)
    if (!node) continue
    order.push(node)
    for (const edge of outs.get(id) || []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        queue.push(edge.to)
      }
    }
  }
  const labelOf = node => (node && node.label ? String(node.label) : String(node.id))
  const lines = [`本会话按流程画布「${(doc && doc.name) || '未命名'}」执行。严格按以下节点顺序推进：`]
  let step = 0
  for (const node of order) {
    // 钩子节点是时机动作不是流程步骤：不占步骤号，末尾时机段统一注入。
    if (node.type === 'hook') continue
    step += 1
    const n = step
    const outsOfNode = outs.get(node.id) || []
    if (node.type === 'start') {
      lines.push(`${n}. 【主会话】${labelOf(node)}：入口，由你（主会话）自己理解并启动流程，不要派子 agent。`)
    } else if (node.type === 'work') {
      const exec = node.exec === 'lead' ? '由你（主会话）自己做' : '派一个子 agent 执行'
      const agentNote = node.agent ? `，子 agent 使用 agent preset「${node.agent}」` : ''
      const promptNote = node.prompt ? `任务说明：${node.prompt}` : '（节点未写任务说明，按节点名称理解）'
      lines.push(`${n}. 【工作】${labelOf(node)}：${exec}${agentNote}。${promptNote}`)
    } else if (node.type === 'router') {
      const branches = outsOfNode
        .map(edge => `标签「${edge.label || '(未命名)'}」→ 节点「${labelOf(byId.get(edge.to))}」`)
        .join('；')
      lines.push(`${n}. 【判断】${labelOf(node)}：${node.description || '按条件选择分支'}。可选分支：${branches}。由你根据判断说明选择唯一一条分支继续，其余分支不执行。`)
    } else if (node.type === 'end') {
      lines.push(`${n}. 【结束】${labelOf(node)}：${node.description || '流程收尾'}。到达此节点表示流程完成：回到主会话向用户汇报整体结果。`)
    } else {
      lines.push(`${n}. ${labelOf(node)}`)
    }
  }
  lines.push('执行约束：只能沿图中连出的边推进；一个工作节点完成后再进入下一节点；判断节点只走一条分支；到达结束节点即向用户汇报并停止。')
  lines.push('进度上报：用 canvas_report 工具上报进度——进入一个节点时 status="running" 并填该节点的名称（label，与上面【】中的名称完全一致）；完成后 status="done"；失败时 status="error" 并在 note 说明原因。画布上会实时亮灯。')
  // 钩子节点（M3 生效）：不占流程步骤号，按触发时机单独成段注入提示词。
  // 钩子取自全量节点——它是时机动作不是流程步骤，不接线（孤岛）也生效。
  const hooks = nodes.filter(node => node.type === 'hook')
  if (hooks.length > 0) {
    lines.push('时机动作（钩子节点，提示性——到对应时机先完成动作再继续，不改变流程走向）：')
    for (const hook of hooks) {
      const kindText = HOOK_TIMING_TEXT[hook.hookKind] || ''
      const note = hook.note || hook.label || '关键时机动作'
      lines.push(kindText ? `- ${kindText}「${labelOf(hook)}」：${note}` : `- 「${labelOf(hook)}」（未设触发时机）：${note}`)
    }
  }
  return lines.join('\n')
}

// --- M3 硬约束围栏（tools/pre-execute） -------------------------------------
// 从 status.json 取该画布最近上报的 running 节点作为「当前节点」：
//   工作节点(派发型) → 放行；主会话/判断/结束/主会话自己做 的工作节点 → deny。
// 只在能确凿知道当前节点时拦截；任何异常一律放行（宁漏勿误伤）。
// deny 会变成工具结果 "Error: <reason>"，模型能看到原因并自我纠正。

function pickRunningLabel(statusEntry) {
  if (!statusEntry || typeof statusEntry !== 'object') return ''
  let best = ''
  let bestAt = 0
  for (const [label, value] of Object.entries(statusEntry)) {
    if (!value || typeof value !== 'object' || value.status !== 'running') continue
    const at = Number(value.updatedAt) || 0
    if (at >= bestAt) {
      bestAt = at
      best = label
    }
  }
  return best
}

function fenceReasonFor(node) {
  const label = node.label || node.id
  if (node.type === 'start') return `流程画布围栏：当前节点是「${label}」（主会话入口），按画布规则流程由你自己启动，此处不派子 agent。`
  if (node.type === 'work') return `流程画布围栏：当前工作节点「${label}」的执行方式是「主会话自己做」，不允许派子 agent，请你自己完成该节点的任务。`
  if (node.type === 'router') return `流程画布围栏：当前节点是「${label}」（判断），判断由你自己完成——按判断说明选一条分支，用 canvas_report 上报进度并推进到下一个工作节点后再派发。`
  if (node.type === 'end') return `流程画布围栏：当前节点是「${label}」（结束），流程应在此收尾并向用户汇报，不再派发子 agent。`
  return `流程画布围栏：当前节点是「${label}」，此处不在允许派发的节点上，请先推进流程。`
}

/** Minimal structural normalization; the client owns the full schema. */
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined
  const id = sanitizeId(raw.id)
  if (!id) return undefined
  return {
    version: 1,
    id,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '',
    updatedAt: Number(raw.updatedAt) || 0,
    nodes: raw.nodes.slice(0, 200),
    edges: raw.edges.slice(0, 400),
  }
}

async function listCanvases() {
  let names = []
  try {
    names = await fsp.readdir(storageDir())
  } catch {
    return []
  }
  const canvases = []
  for (const name of names) {
    const match = /^canvas-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.json$/.exec(name)
    if (!match) continue
    try {
      const raw = await readCanvas(match[1])
      if (raw && typeof raw === 'object') {
        canvases.push({ id: match[1], name: typeof raw.name === 'string' ? raw.name : '', updatedAt: Number(raw.updatedAt) || 0 })
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  canvases.sort((a, b) => b.updatedAt - a.updatedAt)
  return canvases
}

async function listAgents(ctx) {
  try {
    // ctx.get() answers undefined for a missing service; raw property access
    // on a cordis context can throw, so never touch ctx.agentPresets directly.
    const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (!presets || typeof presets.list !== 'function') return []
    const roster = await presets.list()
    const agents = (Array.isArray(roster) ? roster : []).map(preset => ({
      id: String((preset && preset.id) || ''),
      name: String((preset && preset.name) || '') || String((preset && preset.id) || ''),
      description: String((preset && preset.description) || ''),
      order: Number(preset && preset.order) || 0,
    }))
    agents.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    return agents
  } catch {
    return []
  }
}

// NOTE: `connection` is deliberately NOT a module-level inject. On a
// loader-mounted host row that leaves the whole fiber pending until a web
// carrier composes (and forever in profiles without one), so the routes never
// register. Follow the workflow-lite pattern instead: apply() starts without
// it and registers the route from a `ctx.inject(['connection'])` sub-context.
export const inject = []

// --- M2.3 节点亮灯投影 -----------------------------------------------------
// fold 会话日志里的 tool/call（subagent 派发）与 tool/result，把「哪个工作节点
// 在跑/完成/失败」发布给前端。匹配规则（M1 拍板）：节点 label === 派发参数
// description 精确匹配。viewSchema 只需要 .parse 接口，用 shim 避免引入 zod 依赖。
const boardViewSchema = {
  parse(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.lanes)) throw new Error('bad agentWorkflowBoard view')
    return value
  },
}

const boardProjectionDefinition = {
  key: 'agentWorkflowBoard',
  stateVersion: 1,
  init: () => ({ lanes: [] }),
  apply: (state, event) => {
    const data = event && event.data
    if (event.type === 'tool/call' && data && data.name === 'subagent') {
      const desc = data.arguments && typeof data.arguments.description === 'string' ? data.arguments.description.trim() : ''
      if (!desc) return state
      const lanes = state.lanes.filter(lane => lane.label !== desc)
      lanes.push({ label: desc, status: 'running', startedAt: Date.now(), callId: typeof data.callId === 'string' ? data.callId : '' })
      return { lanes }
    }
    if (event.type === 'tool/result' && data && data.message && typeof data.message.callId === 'string') {
      const index = state.lanes.findIndex(lane => lane.callId && lane.callId === data.message.callId)
      if (index < 0) return state
      const lane = { ...state.lanes[index] }
      lane.status = data.message.isError ? 'error' : 'done'
      lane.endedAt = Date.now()
      const lanes = state.lanes.slice()
      lanes[index] = lane
      return { lanes }
    }
    return state
  },
  wire: {
    viewSchema: boardViewSchema,
    view: state => ({
      lanes: state.lanes.map(lane => ({ label: lane.label, status: lane.status, startedAt: lane.startedAt })),
    }),
  },
}

export function apply(ctx) {
  // M2.2: 只对「创建时已绑定画布」的会话注入执行规范（与 preset 修订语义一致，
  // 进行中的会话不追认）。规范文本在每次 prompt 组装时动态读取画布 ——
  // 执行期间改图只影响后续派发。注册在 agent.ctx 上 = agent 级 scope，随 agent 自动清理。
  ctx.on('agent/created', async payload => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.ctx) return
      const systemPrompt = agent.ctx.systemPrompt
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return
      const sessionId = String(agent.id || '')
      if (!sessionId) return
      const binding = readBindingsSync()[sessionId]
      if (!binding || !binding.canvasId) return
      const canvasId = sanitizeId(binding.canvasId)
      if (!canvasId) return
      systemPrompt.section({
        name: 'agent-workflow-board:spec',
        order: 500,
        interpolate: false,
        text: () => {
          try {
            return compileSpec(readCanvasSync(canvasId))
          } catch {
            return ''
          }
        },
      })
    } catch {
      /* never break agent creation */
    }
  })

  // M2.3: 注册会话投影。亮灯是增强功能：服务缺失或注册失败都不能影响编辑器。
  try {
    const projections = (ctx.root && ctx.root.sessionProjections) || ctx.sessionProjections
    if (projections && typeof projections.register === 'function') {
      ctx.effect(() => projections.register(boardProjectionDefinition))
    }
  } catch {
    /* projection registration is best-effort */
  }

  // M2.4: canvas_report —— 绑定了画布的会话用它在节点进入/完成/失败时上报进度，
  // 画布编辑器轮询 getStatus 把状态画成节点亮灯。注册失败只损失上报能力。
  try {
    const tools = ctx.root && ctx.root.tools ? ctx.root.tools : ctx.tools
    if (tools && typeof tools.register === 'function') {
      tools.register({
        name: 'canvas_report',
        description: '流程画布进度上报。会话绑定了流程画布时，每进入一个节点调用一次 status="running" 并给出节点名 label；该节点完成后再调用一次 status="done"；失败用 status="error" 并在 note 里说明原因。未绑定画布的会话不需要调用。',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['running', 'done', 'error'] },
            label: { type: 'string', description: '流程画布上的节点名称（与画布里节点名称完全一致）' },
            note: { type: 'string', description: '可选：一句话说明（失败原因等）' },
          },
          required: ['status', 'label'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { recorded: { type: 'boolean', const: true } },
            required: ['recorded'],
            additionalProperties: false,
          },
          render: () => [{ type: 'text', text: '画布进度已上报。' }],
        },
        async execute(args, exec) {
          const agent = exec && exec.agent
          const sessionId = agent ? String(agent.id || '') : ''
          if (!sessionId) return { recorded: false }
          const binding = readBindingsSync()[sessionId]
          const canvasId = binding && sanitizeId(binding.canvasId)
          if (!canvasId) return { recorded: false }
          const status = args && args.status === 'done' ? 'done' : args && args.status === 'error' ? 'error' : 'running'
          const label = args && typeof args.label === 'string' ? args.label.trim().slice(0, 80) : ''
          if (!label) return { recorded: false }
          await reportNodeStatus(canvasId, label, status, args && args.note)
          return { recorded: true }
        },
      })
    }
  } catch {
    /* canvas_report is best-effort */
  }

  // M3 硬约束围栏：已绑定画布的会话在「当前节点不允许派发」时拦截 subagent。
  // waterfall 语义：放行必须 return next()（透传给审批等后续监听），
  // 只有 deny 才短路；围栏自身任何异常都放行，绝不阻断正常执行。
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (!exec || exec.name !== 'subagent' || typeof next !== 'function') return next()
        const agent = exec.agent
        const sessionId = agent ? String(agent.id || '') : ''
        const binding = sessionId ? readBindingsSync()[sessionId] : null
        const canvasId = binding && binding.canvasId ? sanitizeId(binding.canvasId) : ''
        if (!canvasId) return next()
        const statusEntry = (await readStatus())[canvasId]
        const runningLabel = pickRunningLabel(statusEntry)
        if (!runningLabel) return next()
        const canvas = await readCanvas(canvasId)
        const nodes = Array.isArray(canvas && canvas.nodes) ? canvas.nodes : []
        const current = nodes.find(node => node && String(node.label || '').trim() === runningLabel)
        if (!current) return next()
        if (current.type === 'work' && current.exec !== 'lead') return next()
        return { kind: 'deny', reason: fenceReasonFor(current) }
      } catch {
        return next()
      }
    })
  } catch {
    /* fence is best-effort */
  }

  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.connection
    if (!connection || !connection.fetch) return

    connectionCtx.effect(
      function () {
        return connection.fetch.register({
          path: '/api/agent-canvas/rpc',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async function (request) {
            let body = null
            try {
              body = await request.json()
            } catch {
              return json({ error: 'bad-body' }, 400)
            }
            const action = body && typeof body === 'object' ? body.action : ''
            try {
              if (action === 'list') return json({ canvases: await listCanvases() })
              if (action === 'agents') return json({ agents: await listAgents(ctx) })
              if (action === 'get') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                let canvas
                try {
                  canvas = normalizeStored(await readCanvas(id))
                } catch {
                  return json({ error: 'not-found' }, 404)
                }
                if (!canvas) return json({ error: 'not-found' }, 404)
                return json({ canvas })
              }
              if (action === 'put') {
                const canvas = normalizeStored(body.canvas)
                if (!canvas) return json({ error: 'bad-canvas' }, 400)
                canvas.updatedAt = Date.now()
                await writeCanvas(canvas)
                return json({ canvas })
              }
              if (action === 'delete') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                try {
                  await fsp.unlink(canvasPath(id))
                } catch {
                  /* already gone */
                }
                // 清理指向已删除画布的会话绑定。
                try {
                  const bindings = await readBindings()
                  let changed = false
                  for (const key of Object.keys(bindings)) {
                    if (bindings[key] && bindings[key].canvasId === id) {
                      delete bindings[key]
                      changed = true
                    }
                  }
                  if (changed) await writeBindings(bindings)
                } catch {
                  /* binding cleanup is best-effort */
                }
                return json({ ok: true })
              }
              if (action === 'bind') {
                const sessionId = sanitizeSessionId(body.sessionId)
                const canvasId = sanitizeId(body.canvasId)
                if (!sessionId || !canvasId) return json({ error: 'bad-binding' }, 400)
                try {
                  await readCanvas(canvasId)
                } catch {
                  return json({ error: 'not-found' }, 404)
                }
                const bindings = await readBindings()
                bindings[sessionId] = { canvasId, boundAt: Date.now() }
                await writeBindings(bindings)
                return json({ binding: bindings[sessionId] })
              }
              if (action === 'unbind') {
                const sessionId = sanitizeSessionId(body.sessionId)
                if (!sessionId) return json({ error: 'bad-session' }, 400)
                const bindings = await readBindings()
                const removed = bindings[sessionId]
                delete bindings[sessionId]
                if (removed) await writeBindings(bindings)
                return json({ ok: true })
              }
              if (action === 'getBinding') {
                const sessionId = sanitizeSessionId(body.sessionId)
                if (!sessionId) return json({ error: 'bad-session' }, 400)
                const bindings = await readBindings()
                return json({ binding: bindings[sessionId] || null })
              }
              if (action === 'getStatus') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                const map = await readStatus()
                return json({ status: map[id] || {} })
              }
              if (action === 'specPreview') {
                // 画布内「规范预览」：直接编译客户端传来的当前画布（含未保存修改），
                // 和注入用的是同一个 compileSpec —— 看到的就是模型会收到的。
                const canvas = body && typeof body.canvas === 'object' && body.canvas ? body.canvas : null
                if (!canvas) return json({ error: 'bad-canvas' }, 400)
                return json({ spec: compileSpec(canvas) })
              }
              return json({ error: 'unknown-action' }, 400)
            } catch (error) {
              return json({ error: String((error && error.message) || error) }, 500)
            }
          },
        })
      },
      'agent-workflow-board: rpc route',
    )
  })
}

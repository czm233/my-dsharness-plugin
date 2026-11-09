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
 *     { action: 'agents' }                  -> { agents: [{id,name,description}] }（画布角色库）
 *     { action: 'bind', sessionId, canvasId }   -> { binding: {canvasId,boundAt} }
 *     { action: 'unbind', sessionId }           -> { ok: true }
 *     { action: 'getBinding', sessionId }       -> { binding } | { binding: null }
 *     { action: 'getStatus', id }               -> { status: {label: {status,note,updatedAt}} }
 *     { action: 'specPreview', canvas }         -> { spec }  (compileSpec on the client's current doc)
 *     { action: 'listModels' }                  -> { models: [{provider,id,name}] | null }（null=未知）
 *     { action: 'checkModels', canvas, sessionId? } -> { ok, issues }（启动主检查）
 *
 * v2.19.0 节点级模型：工作节点可带 { model:{provider,id}, onModelMissing }，
 * 角色 .md frontmatter 可带 provider:/model: 作默认值。生效模型 = 节点 ?? 角色。
 * 绑定时宿主向会话 append 官方 subagent/model-selection-policy 事件授权画布
 * 路由（方案A，PLAN-node-model.md 阶段0结论4）；围栏在派发时校正 subagent 的
 * provider/model 参数；compileSpec 按 ok/missing+fallback/missing+stop 三态措辞。
 *
 * Canvases persist as JSON documents under the DSH internal storage area
 * (~/.dsh/storages/agent-workflow-board/), never inside project directories.
 * The agent roster is the board's private role library under agents/ — one
 * Markdown file per role (frontmatter + persona body), unlimited count, and
 * deliberately NOT agentPresets: presets are global session modes, and
 * registering a role there would pollute the new-session mode picker.
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
import { readFileSync as fspSyncRead, readdirSync as fspSyncReaddir } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fspSync = { readFile: fspSyncRead, readdir: fspSyncReaddir }

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

// 锁详情：画布被哪些会话引用、各会话是否正在运行（agent.status === 'running'）。
// 注意：agents.get() 对任何打开过的会话都返回句柄（空闲也算），必须看 status 才是真"运行中"。
// 拿不到注册表或读不出 status 时 alive=unknown，降级为锁定。
async function lockInfo(canvasId, ctx) {
  const bindings = await readBindings()
  const holders = Object.keys(bindings).filter(sid => bindings[sid] && bindings[sid].canvasId === canvasId)
  let registry = null
  try {
    registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  } catch {
    registry = undefined
  }
  if (!registry && ctx && ctx.agents && typeof ctx.agents.get === 'function') registry = ctx.agents
  const sessions = holders.map(sid => {
    let alive = null
    if (registry && typeof registry.get === 'function') {
      try {
        const agent = registry.get(sid)
        if (!agent) alive = false
        else if (agent.status === 'running' || agent.status === 'idle') alive = agent.status === 'running'
        else alive = null
      } catch {
        alive = null
      }
    }
    return { sessionId: sid, alive }
  })
  const degraded = !registry
  const locked = degraded || sessions.some(s => s.alive !== false)
  return { locked, sessions, degraded }
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

// --- v2.19.0 节点级模型：目录缓存与路由解析 ---------------------------------
// 数据源与 list_subagent_models 工具同源：ctx.get('llm')（@deepseek-ai/dsh-llm）。
//   listProviders()            → 同步，已注册 adapter 的渠道 [{id,name}]
//   listModels(providerId)     → 异步，渠道广告目录 [{provider,id,name}]
//   resolveModelInfo(p,m)      → 异步精确解析；目录外的合法路由靠它兜底确认
// 目录拿不到（服务缺失/全部渠道失败/零渠道）→ null =「未知」，一律按可用放行，
// 绝不误伤（与围栏同一原则）。目录 30 秒缓存；resolveModelInfo 命中记入
// verifiedRoutes 常驻集合，供 compileSpec 的同步路径复用（prompt 组装是同步的）。
const MODEL_TTL_MS = 30000
let catalogCache = { at: 0, value: null }
let catalogInFlight = null
const verifiedRoutes = new Set()

function routeKey(provider, id) {
  return `${provider}\u0000${id}`
}

function llmOf(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (service && typeof service.listProviders === 'function') return service
  } catch { /* fall through */ }
  try {
    if (ctx.llm && typeof ctx.llm.listProviders === 'function') return ctx.llm
  } catch { /* fall through */ }
  try {
    if (ctx.root && ctx.root.llm && typeof ctx.root.llm.listProviders === 'function') return ctx.root.llm
  } catch { /* fall through */ }
  return null
}

async function fetchCatalog(ctx) {
  const llm = llmOf(ctx)
  if (!llm) return null
  try {
    const providers = Array.isArray(llm.listProviders()) ? llm.listProviders() : []
    if (providers.length === 0) return null // 零渠道按未知处理，不误判 missing
    const models = []
    let anySuccess = false
    for (const provider of providers.slice(0, 50)) {
      const pid = provider && typeof provider.id === 'string' ? provider.id : ''
      if (!pid) continue
      try {
        const listed = await llm.listModels(pid)
        anySuccess = true
        for (const entry of Array.isArray(listed) ? listed : []) {
          if (!entry || typeof entry.id !== 'string' || !entry.id) continue
          models.push({ provider: pid, id: entry.id.slice(0, 200), name: typeof entry.name === 'string' && entry.name ? entry.name.slice(0, 200) : entry.id.slice(0, 200) })
        }
      } catch {
        /* 单渠道失败跳过，其余渠道照常 */
      }
    }
    return anySuccess ? models : null
  } catch {
    return null
  }
}

async function getCatalog(ctx) {
  const now = Date.now()
  if (catalogCache.value !== null && now - catalogCache.at < MODEL_TTL_MS) return catalogCache.value
  if (catalogInFlight) return catalogInFlight
  catalogInFlight = fetchCatalog(ctx)
    .then(value => {
      catalogInFlight = null
      if (value !== null) catalogCache = { at: Date.now(), value }
      return value !== null ? value : catalogCache.value
    })
    .catch(() => {
      catalogInFlight = null
      return catalogCache.value
    })
  return catalogInFlight
}

/** 异步精确判定：true=可用 false=不可用 null=未知（目录拿不到）。 */
async function routeAvailable(ctx, provider, id) {
  if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) return null
  if (verifiedRoutes.has(routeKey(provider, id))) return true
  const catalog = await getCatalog(ctx)
  if (catalog === null) return null
  if (catalog.some(entry => entry.provider === provider && entry.id === id)) {
    verifiedRoutes.add(routeKey(provider, id))
    return true
  }
  const llm = llmOf(ctx)
  if (llm && typeof llm.resolveModelInfo === 'function') {
    try {
      await llm.resolveModelInfo(provider, id)
      verifiedRoutes.add(routeKey(provider, id))
      return true
    } catch {
      return false
    }
  }
  return false
}

/** 同步判定（compileSpec 用）：只查常驻缓存，拿不到 → null 按可用处理。 */
function routeAvailableSync(provider, id) {
  if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) return null
  if (verifiedRoutes.has(routeKey(provider, id))) return true
  const catalog = catalogCache.value
  if (catalog === null) return null
  return catalog.some(entry => entry.provider === provider && entry.id === id)
}

/** 节点的期望路由：节点覆盖 > 角色默认 > 无。只对派发型工作节点生效。 */
function wantedRouteFor(node, rosterById) {
  if (!node || node.type !== 'work' || node.exec === 'lead') return null
  const model = node.model
  if (model && typeof model === 'object' && typeof model.provider === 'string' && model.provider && typeof model.id === 'string' && model.id) {
    return { provider: model.provider, id: model.id, source: 'node' }
  }
  const role = node.agent && rosterById ? rosterById.get(node.agent) : null
  if (role && typeof role.provider === 'string' && role.provider && typeof role.model === 'string' && role.model) {
    return { provider: role.provider, id: role.model, source: 'role' }
  }
  return null
}

/**
 * 统一解析：{ wanted, effective, status }。
 * status: none（没设）| ok | missing | unknown（目录拿不到，按 ok 处理不误伤）。
 * available(provider,id) → true/false/null，同步异步两个路径共用本函数。
 */
function resolveNodeModel(node, rosterById, available) {
  const wanted = wantedRouteFor(node, rosterById)
  if (!wanted) return { wanted: null, effective: null, status: 'none' }
  const verdict = typeof available === 'function' ? available(wanted.provider, wanted.id) : null
  if (verdict === null) return { wanted, effective: wanted, status: 'unknown' }
  if (verdict) return { wanted, effective: wanted, status: 'ok' }
  return { wanted, effective: null, status: 'missing' }
}

function modelPolicyOf(node) {
  return node && node.onModelMissing === 'stop' ? 'stop' : 'fallback'
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
  const rosterById = new Map(readRosterSync(doc && typeof doc.projectDir === 'string' ? doc.projectDir : '').map(agent => [agent.id, agent]))
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
  // 钩子清单（新模型：node.hooks 数组；兼容旧画布的 type:'hook' 孤岛节点）。
  // 分派型时机（派发前/后、子agent启/停）跟着所属节点走，注入该节点的步骤段落；
  // 会话型时机（会话开始/用户消息/每轮结束/会话结束）与旧钩子节点统一进全局时机段。
  const DISPATCH_TIMINGS = new Set(['before-dispatch', 'after-dispatch', 'subagent-start', 'subagent-end'])
  const nodeHooks = new Map()
  const globalHooks = []
  for (const node of nodes) {
    if (node.type === 'hook') {
      globalHooks.push({ timing: node.hookKind || '', note: node.note || node.label || '关键时机动作', owner: '', legacyLabel: labelOf(node) })
      continue
    }
    for (const hk of Array.isArray(node.hooks) ? node.hooks : []) {
      const entry = { timing: hk.timing || '', note: (hk.note || '').trim() || '关键时机动作', owner: labelOf(node) }
      if (DISPATCH_TIMINGS.has(hk.timing)) {
        if (!nodeHooks.has(node.id)) nodeHooks.set(node.id, [])
        nodeHooks.get(node.id).push(entry)
      } else {
        globalHooks.push(entry)
      }
    }
  }
  const lines = [`本会话按流程画布「${(doc && doc.name) || '未命名'}」执行。严格按以下节点顺序推进：`]
  lines.push('启动动作（先于一切节点）：盘点本会话现存子智能体——用你的子代理管理工具查看，仍在运行或待命的逐个停止；若无停止工具或无法停止，明确声明「既往子智能体与既往上下文一律忽略，本会话只按本流程推进」。完成后再进入第 1 个节点。')
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
      const role = node.agent ? rosterById.get(node.agent) : null
      let agentNote = ''
      if (role && role.prompt) {
        agentNote = `，子 agent 使用角色「${role.name}」执行，派发提示词开头原样附上角色人设：\n【角色人设·${role.name}】\n${role.prompt.slice(0, 4000)}\n【人设结束】`
      } else if (role) {
        agentNote = `，子 agent 使用角色「${role.name}」执行`
      } else if (node.agent) {
        agentNote = `，子 agent 使用 agent preset「${node.agent}」`
      }
      // v2.19.0 节点级模型：同步解析（目录缓存拿不到 = unknown，按可用处理不误伤）。
      const resolved = resolveNodeModel(node, rosterById, routeAvailableSync)
      const routeText = resolved.wanted ? `${resolved.wanted.provider}/${resolved.wanted.id}` : ''
      if (resolved.status === 'missing' && modelPolicyOf(node) === 'stop') {
        // 兜底路径：正常情况下启动检查已拦下；走到这里就明确停住，不派发。
        lines.push(`${n}. 【工作】${labelOf(node)}：节点设定的模型 ${routeText} 当前不可用，流程在此停止——不要派发该节点，向用户说明「模型 ${routeText} 不可用」并等待用户重新选择模型后再继续。`)
      } else {
        let modelNote = ''
        if (resolved.status === 'ok' || resolved.status === 'unknown') {
          modelNote = `派发时 subagent 工具参数必须带 provider="${resolved.wanted.provider}" model="${resolved.wanted.id}"（本节点指定模型，不要改用其他模型，也不要省略）。`
        } else if (resolved.status === 'missing') {
          modelNote = `注意：节点设定的模型 ${routeText} 当前不可用，本节点改用默认模型执行（派发时不带 provider/model 参数），完成汇报时注明「原定模型 ${routeText} 不可用，已用默认模型」。`
        }
        const promptNote = node.prompt ? `任务说明：${node.prompt}` : '（节点未写任务说明：按节点名称理解职责，以上游节点派发的要求为准执行，完成后交棒下一节点）'
        lines.push(`${n}. 【工作】${labelOf(node)}：${exec}${agentNote}。${modelNote}${promptNote}`)
      }
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
    // 该节点的分派型钩子：写在节点自己的段落里——谁的钩子跟着谁走。
    const hooksOf = nodeHooks.get(node.id)
    if (hooksOf) {
      for (const hk of hooksOf) lines.push(`   ↳ ${HOOK_TIMING_TEXT[hk.timing] || '时机动作'}：${hk.note}`)
    }
  }
  lines.push('执行约束：只能沿图中连出的边推进；一个工作节点完成后再进入下一节点；判断节点只走一条分支；到达结束节点即向用户汇报并停止。')
  lines.push('进度上报：用 canvas_report 工具上报进度——进入一个节点时 status="running" 并填该节点的名称（label，与上面【】中的名称完全一致）；完成后 status="done"；失败时 status="error" 并在 note 说明原因。画布上会实时亮灯。')
  // 全局时机段：旧 hook 孤岛节点 + 各节点的会话型钩子统一在此注入（提示性，不改流程走向）。
  // 挂在主会话上的会话型钩子不加归属标注——主会话本身就代表整张画布。
  const startLabel = labelOf(start)
  const timingLines = []
  for (const hk of globalHooks) {
    const kindText = HOOK_TIMING_TEXT[hk.timing] || ''
    if (kindText) {
      const ownerTag = hk.owner && !hk.legacyLabel && hk.owner !== startLabel ? `（设于节点「${hk.owner}」）` : ''
      const nameTag = hk.legacyLabel ? `「${hk.legacyLabel}」` : ''
      timingLines.push(`- ${kindText}${nameTag}${ownerTag}：${hk.note}`)
    } else {
      const nameTag = hk.legacyLabel ? `「${hk.legacyLabel}」` : hk.owner ? `「${hk.owner}」的钩子` : '「钩子」'
      timingLines.push(`- ${nameTag}（未设触发时机）：${hk.note}`)
    }
  }
  if (timingLines.length > 0) {
    lines.push('时机动作（钩子，提示性——到对应时机先完成动作再继续，不改变流程走向）：')
    for (const line of timingLines) lines.push(line)
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

/**
 * v2.19.0 模型围栏（方案A，阶段0已确认可行）：当前 running 节点是派发型且有
 * 生效模型时——参数缺失或不一致 → 整体替换 exec.arguments 改写为节点模型
 * （arguments 的值被官方 deepFreeze，不能原地改，但 exec 对象本身可写，
 * dispatchToolBody 读的是同一个 exec）；节点模型失效 → 删掉指向失效路由的
 * 参数后放行（默认模型兜底）。任何异常放行（宁漏勿误伤）。
 */
async function applyModelFence(ctx, exec, node, canvas) {
  try {
    const rosterById = new Map(readRosterSync(canvas && typeof canvas.projectDir === 'string' ? canvas.projectDir : '').map(agent => [agent.id, agent]))
    const wanted = wantedRouteFor(node, rosterById)
    if (!wanted) return
    const args = exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments) ? exec.arguments : null
    if (!args) return
    const verdict = await routeAvailable(ctx, wanted.provider, wanted.id)
    if (verdict !== false) {
      if (args.provider !== wanted.provider || args.model !== wanted.id) {
        const rewritten = { ...args, provider: wanted.provider, model: wanted.id }
        // 路由被改写时力度一并去掉：按官方语义，换路由后省略的力度回落模型默认
        delete rewritten.reasoning_effort
        exec.arguments = rewritten
      }
      return
    }
    if (args.provider === wanted.provider && args.model === wanted.id) {
      const stripped = { ...args }
      delete stripped.provider
      delete stripped.model
      delete stripped.reasoning_effort
      exec.arguments = stripped
    }
  } catch {
    /* 围栏异常一律放行 */
  }
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
    projectDir: typeof raw.projectDir === 'string' ? raw.projectDir.slice(0, 4096) : '',
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

// --- v2.6.0 角色库：画布私有 agent 名册 -------------------------------------
// 角色与「会话模式」（agentPresets）分家：模式是全局户口（DSH 出厂四件套，
// 注册即上新建会话的模式单）；角色是画布户口——一个角色一个 Markdown 文件，
// 存 ~/.dsh/storages/agent-workflow-board/agents/<id>.md，数量不限、不进模式单。
// 格式照 Claude Code 的 .claude/agents：YAML 头（name/description）+ Markdown
// 正文（人设提示词，compileSpec 在派发时原样附给子 agent）。
function rosterDir() {
  return path.join(storageDir(), 'agents')
}

// v2.6.1 双档角色库：项目目录必须是绝对路径（host 只读它的 agents/ 子目录）。
function sanitizeProjectDir(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.length > 4096) return ''
  return trimmed
}

function parseAgentFile(id, text) {
  const trimmed = String(text || '')
  let name = ''
  let description = ''
  // v2.19.0：角色默认模型（可选 frontmatter 字段 provider: / model:）
  let provider = ''
  let model = ''
  let body = trimmed
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('\n---', 3)
    if (end !== -1) {
      const head = trimmed.slice(3, end)
      body = trimmed.slice(end + 4).replace(/^\s*\n/, '')
      for (const line of head.split('\n')) {
        const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line.trim())
        if (!match) continue
        if (match[1] === 'name') name = match[2].trim().slice(0, 80)
        if (match[1] === 'description') description = match[2].trim().slice(0, 200)
        if (match[1] === 'provider') provider = match[2].trim().slice(0, 120)
        if (match[1] === 'model') model = match[2].trim().slice(0, 200)
      }
    }
  }
  return { id, name: name || id, description, provider, model, prompt: body.trim().slice(0, 8000) }
}

// v2.6.1：用户级 = storageDir()/agents；项目级 = <projectDir>/agents。
// 后读项目级、同名覆盖（照 Claude Code 约定：项目定义高于用户定义）。
function readRosterSync(projectDir) {
  const project = sanitizeProjectDir(projectDir)
  const sources = [{ dir: rosterDir(), scope: 'user' }]
  if (project) sources.push({ dir: path.join(project, 'agents'), scope: 'project' })
  const byId = new Map()
  for (const source of sources) {
    let names = []
    try {
      names = fspSync.readdir(source.dir)
    } catch {
      continue
    }
    for (const name of names) {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.md$/.exec(name)
      if (!match) continue
      try {
        const text = fspSync.readFile(path.join(source.dir, name), 'utf8')
        byId.set(match[1], Object.assign(parseAgentFile(match[1], text), { scope: source.scope }))
      } catch {
        /* skip unreadable entries */
      }
      if (byId.size >= 100) break
    }
  }
  const agents = [...byId.values()]
  agents.sort((a, b) => a.id.localeCompare(b.id))
  return agents
}

function listAgents(projectDir) {
  // 客户端只要展示字段；人设正文留在宿主侧给 compileSpec 用。
  // v2.19.0 附带角色默认模型（provider/model），供节点面板显示「默认（角色）」来源。
  return Promise.resolve(
    readRosterSync(projectDir).map(agent => ({ id: agent.id, name: agent.name, description: agent.description, scope: agent.scope, provider: agent.provider || '', model: agent.model || '' }))
  )
}

// v2.8.0 角色编辑：名册不再只读——画布 GUI 直接新建/编辑/删除角色 .md。
// scope=user 写 storageDir()/agents；scope=project 写 <projectDir>/agents。
function agentFilePath(id, scope, projectDir) {
  if (scope === 'project') {
    const project = sanitizeProjectDir(projectDir)
    if (!project) return ''
    return path.join(project, 'agents', `${id}.md`)
  }
  return path.join(rosterDir(), `${id}.md`)
}

function serializeAgentFile(agent) {
  const oneLine = value => String(value || '').replace(/[\r\n]+/g, ' ').trim()
  const provider = oneLine(agent.provider)
  const model = oneLine(agent.model)
  const modelLines = provider && model ? `provider: ${provider}\nmodel: ${model}\n` : ''
  return `---\nname: ${oneLine(agent.name)}\ndescription: ${oneLine(agent.description)}\n${modelLines}---\n\n${String(agent.prompt || '').trim()}\n`
}

// NOTE: `connection` is deliberately NOT a module-level inject. On a
// loader-mounted host row that leaves the whole fiber pending until a web
// carrier composes (and forever in profiles without one), so the routes never
// register. Follow the workflow-lite pattern instead: apply() starts without
// it and registers the route from a `ctx.inject(['connection'])` sub-context.
export const inject = []

// 测试钩子：host-spec-sim / model-fence-sim 的临时副本导出用——预置目录缓存
// 与 verifiedRoutes，让同步/异步解析走确定路径（测的是真实 host.js 代码）。
const __modelTestHooks = {
  setCatalog(models) {
    catalogCache = { at: Date.now(), value: Array.isArray(models) ? models : null }
  },
  markVerified(provider, id) {
    verifiedRoutes.add(routeKey(provider, id))
  },
  reset() {
    catalogCache = { at: 0, value: null }
    catalogInFlight = null
    verifiedRoutes.clear()
  },
}

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
      // v2.19.0：记录派发实际请求的模型（tool/call 落库的是模型原始参数，
      // 在围栏改写之前——正常路径 compileSpec 已要求主会话自己带对参数）。
      const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {}
      const model = typeof args.provider === 'string' && args.provider && typeof args.model === 'string' && args.model ? `${args.provider}/${args.model}` : ''
      const lanes = state.lanes.filter(lane => lane.label !== desc)
      lanes.push({ label: desc, status: 'running', startedAt: Date.now(), callId: typeof data.callId === 'string' ? data.callId : '', model })
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
      lanes: state.lanes.map(lane => ({ label: lane.label, status: lane.status, startedAt: lane.startedAt, model: typeof lane.model === 'string' ? lane.model : '' })),
    }),
  },
}

// --- v2.19.0 会话模型授权（阶段0调研结论4，用户拍板方案A） --------------------
// DSH 运行时约束：会话没有记录 subagent/model-selection-policy 事件时，
// subagent 显式传 provider/model 只允许等于父会话当前路由（官方
// assertAllowedModelSelection）。所以画布「启动」绑定时，宿主给会话 append
// 官方同名事件，授权本画布用到的全部路由（与官方设置服务同一写法）。
// 策略「先到先 recorded」（官方投影 apply 只认第一条），因此：
//   - 绑定前先用我们自己的只读投影（本定义）查会话是否已有策略；
//   - 无策略 → append 画布路由并集；已有且覆盖 → 不动；已有但不覆盖 → 报
//     policy 问题（无法追加，只能换新会话启动）。
// 子会话自动继承父策略（官方 agent/created 逻辑），无需处理。
const modelPolicyProjectionDefinition = {
  key: 'agentWorkflowBoardModelPolicy',
  stateVersion: 1,
  init: () => null,
  apply: (state, event) => {
    if (state !== null) return state
    if (!event || event.type !== 'subagent/model-selection-policy') return state
    const list = event.data && Array.isArray(event.data.allowedModels) ? event.data.allowedModels : null
    if (!list || list.length === 0) return state
    const routes = []
    for (const entry of list) {
      if (!entry || typeof entry.provider !== 'string' || !entry.provider || typeof entry.model !== 'string' || !entry.model) continue
      routes.push({ provider: entry.provider, model: entry.model })
    }
    return routes.length > 0 ? routes : state
  },
}

/** 画布全部派发节点的期望路由并集（去重，含 missing 的——授权只是允许清单）。 */
function collectCanvasRoutes(canvas) {
  const nodes = Array.isArray(canvas && canvas.nodes) ? canvas.nodes : []
  const rosterById = new Map(readRosterSync(canvas && typeof canvas.projectDir === 'string' ? canvas.projectDir : '').map(agent => [agent.id, agent]))
  const seen = new Set()
  const routes = []
  for (const node of nodes) {
    const wanted = wantedRouteFor(node, rosterById)
    if (!wanted) continue
    const key = routeKey(wanted.provider, wanted.id)
    if (seen.has(key)) continue
    seen.add(key)
    routes.push({ provider: wanted.provider, model: wanted.id })
  }
  return routes
}

function agentsRegistry(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (registry && typeof registry.get === 'function') return registry
  } catch { /* fall through */ }
  if (ctx && ctx.agents && typeof ctx.agents.get === 'function') return ctx.agents
  return null
}

/**
 * 绑定时保证会话具备画布所需的路由授权。
 * 返回 { appended, covered, routes }；任何异常吞掉（授权失败不阻断绑定，
 * 派发失败时官方报错会教模型/用户回头处理）。
 */
async function ensureModelPolicy(ctx, sessionId, canvas, policyHandlePromise) {
  const result = { appended: false, covered: true, routes: [] }
  try {
    const routes = collectCanvasRoutes(canvas)
    result.routes = routes
    if (routes.length === 0) return result
    const registry = agentsRegistry(ctx)
    const agent = registry ? registry.get(sessionId) : null
    const session = agent && agent.session
    if (!session || typeof session.append !== 'function') return result
    let existing = null
    if (policyHandlePromise) {
      const handle = await policyHandlePromise
      if (handle && typeof handle.stateOf === 'function') existing = handle.stateOf(session)
    }
    if (Array.isArray(existing) && existing.length > 0) {
      result.covered = routes.every(route => existing.some(entry => entry.provider === route.provider && entry.model === route.model))
      return result
    }
    session.append('subagent/model-selection-policy', { allowedModels: routes })
    result.appended = true
    return result
  } catch {
    return result
  }
}

/**
 * 启动主检查 + compileSpec 兜底共用的检查函数（异步精确版）。
 * issues: [{kind:'model'|'policy', nodeId, label, wanted, policy}]
 *   kind=model  → 设定模型不可用；policy=fallback 不阻断 / stop 阻断
 *   kind=policy → 会话已有授权策略但不含该路由（阻断，需换新会话或改模型）
 * ok = 没有阻断项。目录拿不到（unknown）不产生 issue。
 */
async function checkCanvasModels(ctx, doc, sessionId, policyHandlePromise) {
  const issues = []
  const nodes = Array.isArray(doc && doc.nodes) ? doc.nodes : []
  const rosterById = new Map(readRosterSync(doc && typeof doc.projectDir === 'string' ? doc.projectDir : '').map(agent => [agent.id, agent]))
  const wantedByNode = []
  for (const node of nodes) {
    const wanted = wantedRouteFor(node, rosterById)
    if (!wanted) continue
    wantedByNode.push({ node, wanted })
    const verdict = await routeAvailable(ctx, wanted.provider, wanted.id)
    if (verdict === false) {
      issues.push({ kind: 'model', nodeId: String(node.id), label: String(node.label || node.id), wanted: { provider: wanted.provider, id: wanted.id }, source: wanted.source, policy: modelPolicyOf(node) })
    }
  }
  // 会话授权覆盖检查（仅当调用方给了 sessionId 且能读到会话时）。
  if (sessionId && policyHandlePromise && wantedByNode.length > 0) {
    try {
      const registry = agentsRegistry(ctx)
      const agent = registry ? registry.get(sessionId) : null
      const session = agent && agent.session
      const handle = await policyHandlePromise
      const existing = session && handle && typeof handle.stateOf === 'function' ? handle.stateOf(session) : null
      if (Array.isArray(existing) && existing.length > 0) {
        for (const { node, wanted } of wantedByNode) {
          const covered = existing.some(entry => entry.provider === wanted.provider && entry.model === wanted.id)
          if (!covered) {
            issues.push({ kind: 'policy', nodeId: String(node.id), label: String(node.label || node.id), wanted: { provider: wanted.provider, id: wanted.id }, source: wanted.source, policy: 'stop' })
          }
        }
      }
    } catch {
      /* 读不到策略状态就跳过覆盖检查（宁漏勿误伤） */
    }
  }
  const ok = issues.every(issue => issue.kind === 'model' && issue.policy === 'fallback')
  return { ok, issues }
}

// --- v2.7.0 启动/停止：规范段的统一挂载口 -----------------------------------
// section 按名字注册一次即常驻，text() 在每次 prompt 组装时**现查 bindings**：
// 未启动/已停止/换图都只是「绑定状态变了」，text 自己返回新内容或空串，
// 无需摘除段。specAttached 防止同一会话重复挂载；活会话查找走 agents 注册表。
const SPEC_SECTION_NAME = 'agent-workflow-board:spec'
const specAttached = new Set()

function attachSpec(ctx, sessionId, agentLike) {
  try {
    if (!sessionId || specAttached.has(sessionId)) return
    let live = agentLike || null
    if (!live) {
      let agents = null
      try {
        agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      } catch {
        agents = undefined
      }
      if (!agents && ctx && ctx.agents && typeof ctx.agents.get === 'function') agents = ctx.agents
      if (!agents || typeof agents.get !== 'function') return
      live = agents.get(sessionId)
    }
    if (!live || !live.ctx) return
    const systemPrompt = live.ctx.systemPrompt
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return
    systemPrompt.section({
      name: SPEC_SECTION_NAME,
      order: 500,
      interpolate: false,
      text: () => {
        try {
          const binding = readBindingsSync()[sessionId]
          const canvasId = binding && binding.canvasId ? sanitizeId(binding.canvasId) : ''
          if (!canvasId) return ''
          return compileSpec(readCanvasSync(canvasId))
        } catch {
          return ''
        }
      },
    })
    specAttached.add(sessionId)
  } catch {
    /* 启动注入是增强能力，失败不影响围栏/上报 */
  }
}

export function apply(ctx) {
  // v2.7.0：所有会话创建时统一挂载规范段（text 现查 bindings，未启动渲染空串被丢弃）。
  // 之后用户在画布点「启动」，bind rpc 通过 agents 注册表给活会话补挂/命中缓存——
  // 中途启动即时生效，无需新会话；解绑=停止，text 变空即失效。
  ctx.on('agent/created', async payload => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.ctx) return
      attachSpec(ctx, String(agent.id || ''), agent)
    } catch {
      /* never break agent creation */
    }
  })

  // M2.3: 注册会话投影。亮灯是增强功能：服务缺失或注册失败都不能影响编辑器。
  // v2.19.0：另注册一个只读投影，读会话已有的模型授权策略（host 内部用，无 wire）。
  let modelPolicyReady = null
  try {
    const projections = (ctx.root && ctx.root.sessionProjections) || ctx.sessionProjections
    if (projections && typeof projections.register === 'function') {
      ctx.effect(() => projections.register(boardProjectionDefinition))
      ctx.effect(() => {
        modelPolicyReady = Promise.resolve(projections.register(modelPolicyProjectionDefinition))
        modelPolicyReady.catch(() => {})
      })
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
        if (current.type === 'work' && current.exec !== 'lead') {
          await applyModelFence(ctx, exec, current, canvas)
          return next()
        }
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
              if (action === 'agents') return json({ agents: await listAgents(sanitizeProjectDir(body.projectDir)) })
              if (action === 'agentGet') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                const agent = readRosterSync(sanitizeProjectDir(body.projectDir)).find(entry => entry.id === id)
                if (!agent) return json({ error: 'not-found' }, 404)
                return json({ agent })
              }
              if (action === 'agentPut') {
                const id = sanitizeId(body.id)
                const prompt = String(body.prompt || '').trim()
                if (!id || !prompt) return json({ error: 'bad-agent' }, 400)
                const scope = body.scope === 'project' ? 'project' : 'user'
                const projectDir = sanitizeProjectDir(body.projectDir)
                const filePath = agentFilePath(id, scope, projectDir)
                if (!filePath) return json({ error: 'bad-project-dir' }, 400)
                await fsp.mkdir(path.dirname(filePath), { recursive: true })
                if (scope === 'user') {
                  // 数量上限 100（与 readRosterSync 一致，只对用户级目录计数）
                  let names = []
                  try { names = await fsp.readdir(path.dirname(filePath)) } catch { names = [] }
                  const known = new Set(names.map(name => name.replace(/\.md$/, '')))
                  if (!known.has(id) && known.size >= 100) return json({ error: 'too-many-agents' }, 400)
                }
                const text = serializeAgentFile({
                  name: String(body.name || '').slice(0, 80),
                  description: String(body.description || '').slice(0, 200),
                  provider: String(body.provider || '').slice(0, 120),
                  model: String(body.model || '').slice(0, 200),
                  prompt: prompt.slice(0, 8000),
                })
                await fsp.writeFile(filePath, text, 'utf8')
                return json({ ok: true })
              }
              if (action === 'agentDelete') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                const filePath = agentFilePath(id, body.scope === 'project' ? 'project' : 'user', sanitizeProjectDir(body.projectDir))
                if (!filePath) return json({ error: 'bad-project-dir' }, 400)
                try {
                  await fsp.unlink(filePath)
                } catch {
                  /* already gone */
                }
                return json({ ok: true })
              }
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
                // 绑定锁：方案被「存活会话」绑定期间禁止修改（删画布仍允许，删时会清绑定）
                try {
                  const lock = await lockInfo(canvas.id, ctx)
                  if (lock.locked) return json({ error: 'bound-locked', sessions: lock.sessions }, 409)
                } catch {
                  /* 锁检查失败不阻塞保存（best-effort） */
                }
                // 名称唯一：与其他画布重名则拒绝（客户端通常会先自行改名避开）。
                if (canvas.name) {
                  const canvases = await listCanvases()
                  if (canvases.some(entry => entry.id !== canvas.id && entry.name === canvas.name)) {
                    return json({ error: 'dup-name' }, 409)
                  }
                }
                canvas.updatedAt = Date.now()
                await writeCanvas(canvas)
                return json({ canvas })
              }
              if (action === 'getLock') {
                const id = sanitizeId(body.id)
                if (!id) return json({ error: 'missing-id' }, 400)
                return json(await lockInfo(id, ctx))
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
              if (action === 'listModels') {
                // v2.19.0：当前可用模型目录（30s 缓存）。null = 未知（≠ 空），
                // 客户端把「未知」退化为只显示「默认」项，不阻断任何操作。
                const models = await getCatalog(ctx)
                return json({ models })
              }
              if (action === 'checkModels') {
                // v2.19.0：启动主检查（客户端 toggleRun 前调用）。传当前画布文档
                // （含未保存修改）与可选 sessionId（检查会话授权覆盖）。
                const canvas = body && typeof body.canvas === 'object' && body.canvas ? body.canvas : null
                if (!canvas) return json({ error: 'bad-canvas' }, 400)
                const result = await checkCanvasModels(ctx, canvas, sanitizeSessionId(body.sessionId), modelPolicyReady)
                return json(result)
              }
              if (action === 'bind') {
                const sessionId = sanitizeSessionId(body.sessionId)
                const canvasId = sanitizeId(body.canvasId)
                if (!sessionId || !canvasId) return json({ error: 'bad-binding' }, 400)
                let canvas
                try {
                  canvas = await readCanvas(canvasId)
                } catch {
                  return json({ error: 'not-found' }, 404)
                }
                const bindings = await readBindings()
                bindings[sessionId] = { canvasId, boundAt: Date.now() }
                await writeBindings(bindings)
                attachSpec(ctx, sessionId)
                // v2.19.0 方案A：给会话授权画布所需模型路由（无策略时 append 官方事件）
                const policy = await ensureModelPolicy(ctx, sessionId, canvas, modelPolicyReady)
                return json({ binding: bindings[sessionId], modelPolicy: { appended: policy.appended, covered: policy.covered } })
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

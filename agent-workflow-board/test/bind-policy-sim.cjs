#!/usr/bin/env node
/*
 * v2.19.0 绑定授权链路模拟（方案A 接线验证，PITFALLS「测真实代码」原则）：
 * 加载真实 host.js 的 apply()，用 mock 的 cordis ctx / connection / agents
 * 注册表 / sessionProjections 驱动，然后直接调用注册出来的 RPC 路由，断言：
 *   ① bind：会话无策略 → 向 session append 官方 subagent/model-selection-policy
 *      事件，allowedModels = 画布全部生效路由并集（节点模型 + 角色默认，去重）；
 *   ② bind：会话已有覆盖策略 → 不重复 append，covered=true；
 *   ③ bind：已有策略但不覆盖 → 不 append，covered=false；
 *   ④ checkModels(带 sessionId)：策略不覆盖 → kind='policy' 阻断 issue，ok=false；
 *   ⑤ bind：画布没有任何模型 → 不 append（事件 schema 要求 min(1)）；
 *   ⑥ listModels：llm 服务缺失 → { models: null }（未知 ≠ 空）；
 *   ⑦ agents RPC 带回角色 frontmatter 的 provider/model。
 *
 * 用法：node agent-workflow-board/test/bind-policy-sim.cjs
 * 退出码：全绿 0；任何断言失败 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// 隔离存储：DSH_HOME 指向临时目录（host.js 的 storageDir 每次调用现读 env）
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-bind-home-'))
process.env.DSH_HOME = testHome
const boardDir = path.join(testHome, 'storages', 'agent-workflow-board')
fs.mkdirSync(path.join(boardDir, 'agents'), { recursive: true })
fs.writeFileSync(
  path.join(boardDir, 'agents', 'r1.md'),
  '---\nname: 角色一\ndescription: d\nprovider: p2\nmodel: m2\n---\n\n人设。\n',
  'utf8',
)

const canvasWithModels = {
  version: 1, id: 'c1', name: '模型画布', projectDir: '', updatedAt: 1,
  nodes: [
    { id: 's', type: 'start', label: '主会话', x: 0, y: 0 },
    { id: 'w1', type: 'work', label: 'W1', exec: 'subagent', model: { provider: 'p1', id: 'm1' }, x: 200, y: 0 },
    { id: 'w2', type: 'work', label: 'W2', exec: 'subagent', agent: 'r1', x: 400, y: 0 },
    { id: 'w3', type: 'work', label: 'W3', exec: 'subagent', model: { provider: 'p1', id: 'm1' }, x: 600, y: 0 },
    { id: 'e', type: 'end', label: '结束', x: 800, y: 0 },
  ],
  edges: [],
}
const canvasNoModels = {
  version: 1, id: 'c2', name: '无模型画布', projectDir: '', updatedAt: 1,
  nodes: [
    { id: 's', type: 'start', label: '主会话', x: 0, y: 0 },
    { id: 'w1', type: 'work', label: 'W1', exec: 'subagent', x: 200, y: 0 },
    { id: 'e', type: 'end', label: '结束', x: 400, y: 0 },
  ],
  edges: [],
}
fs.writeFileSync(path.join(boardDir, 'canvas-c1.json'), JSON.stringify(canvasWithModels), 'utf8')
fs.writeFileSync(path.join(boardDir, 'canvas-c2.json'), JSON.stringify(canvasNoModels), 'utf8')

// 真实 host.js 原样加载（apply 是它的正式导出）
const tmp = path.join(os.tmpdir(), 'awb-bind-policy-sim.mjs')
fs.writeFileSync(tmp, fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8'))

import(tmp).then(async ({ apply }) => {
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('PASS', name)
    else { failed++; console.log('FAIL', name, '::', detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)) }
  }

  // --- mock 运行时 -----------------------------------------------------------
  const appendedEvents = []
  const fakeSession = {
    append: (type, data) => { appendedEvents.push({ type, data }); return { seq: appendedEvents.length } },
  }
  const fakeAgent = {
    id: 'sess-1',
    status: 'idle',
    session: fakeSession,
    ctx: { systemPrompt: { section: () => {} } },
  }
  let policyState = null // 投影 stateOf 的返回值：null = 会话还没有策略
  const projections = {
    register: def => {
      if (def && def.key === 'agentWorkflowBoardModelPolicy') return Promise.resolve({ stateOf: () => policyState })
      return Promise.resolve({ stateOf: () => ({ lanes: [] }) })
    },
  }
  const agentsRegistry = { get: sid => (sid === 'sess-1' ? fakeAgent : null) }
  const eventHandlers = {}
  let routeConfig = null
  const connectionCtx = {
    connection: { fetch: { register: cfg => { routeConfig = cfg; return () => {} } } },
    effect: fn => fn(),
  }
  const ctx = {
    on: (event, fn) => { eventHandlers[event] = fn },
    effect: fn => fn(),
    get: name => (name === 'agents' ? agentsRegistry : undefined),
    root: { sessionProjections: projections, tools: { register: () => {} } },
    tools: { register: () => {} },
    sessionProjections: projections,
    inject: (deps, fn) => fn(connectionCtx),
  }
  apply(ctx)
  await new Promise(resolve => setImmediate(resolve)) // 让 modelPolicyReady 的 promise 落定
  if (!routeConfig) { console.error('ROUTE NOT REGISTERED'); process.exit(1) }
  const call = async body => {
    const res = await routeConfig.fetch({ json: async () => body })
    return { status: res.status, body: await res.json() }
  }

  // --- ① 无策略 → append 画布路由并集（w1/w3 同路由去重 + 角色 r1 的 p2/m2）----
  {
    const { body } = await call({ action: 'bind', sessionId: 'sess-1', canvasId: 'c1' })
    const policyEvents = appendedEvents.filter(e => e.type === 'subagent/model-selection-policy')
    const routes = policyEvents[0] ? policyEvents[0].data.allowedModels.map(r => `${r.provider}/${r.model}`).sort() : []
    check('① bind 写入授权事件', policyEvents.length === 1, appendedEvents)
    check('① allowedModels = 路由并集去重', JSON.stringify(routes) === JSON.stringify(['p1/m1', 'p2/m2'].sort()), routes)
    check('① bind 响应 modelPolicy.appended', body.binding && body.modelPolicy && body.modelPolicy.appended === true, body)
  }

  // --- ② 已有覆盖策略 → 不重复 append ----------------------------------------
  {
    policyState = [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }]
    const before = appendedEvents.length
    const { body } = await call({ action: 'bind', sessionId: 'sess-1', canvasId: 'c1' })
    check('② 覆盖策略 → 不再 append', appendedEvents.length === before)
    check('② covered=true appended=false', body.modelPolicy.covered === true && body.modelPolicy.appended === false, body.modelPolicy)
  }

  // --- ③④ 策略不覆盖 → 不 append；checkModels 报 policy 阻断 ------------------
  {
    policyState = [{ provider: 'p1', model: 'm1' }] // 缺 p2/m2（角色 r1 的路由）
    const before = appendedEvents.length
    const { body: bindBody } = await call({ action: 'bind', sessionId: 'sess-1', canvasId: 'c1' })
    check('③ 不覆盖 → 不 append', appendedEvents.length === before)
    check('③ covered=false', bindBody.modelPolicy.covered === false, bindBody.modelPolicy)
    const { body: chk } = await call({ action: 'checkModels', canvas: canvasWithModels, sessionId: 'sess-1' })
    const policyIssues = (chk.issues || []).filter(i => i.kind === 'policy')
    check('④ checkModels 报 policy issue（只报未覆盖的 w2）', policyIssues.length === 1 && policyIssues[0].nodeId === 'w2', chk.issues)
    check('④ ok=false（policy 阻断）', chk.ok === false)
  }

  // --- ⑤ 无模型画布 → 不 append ----------------------------------------------
  {
    policyState = null
    const before = appendedEvents.length
    const { body } = await call({ action: 'bind', sessionId: 'sess-1', canvasId: 'c2' })
    check('⑤ 无模型画布 → 不 append', appendedEvents.length === before)
    check('⑤ appended=false covered=true', body.modelPolicy.appended === false && body.modelPolicy.covered === true, body.modelPolicy)
  }

  // --- ⑥ listModels：无 llm 服务 → null（未知 ≠ 空） --------------------------
  {
    const { body } = await call({ action: 'listModels' })
    check('⑥ llm 缺失 → models=null', body.models === null, body)
  }

  // --- ⑦ agents RPC 带回角色 provider/model ----------------------------------
  {
    const { body } = await call({ action: 'agents', projectDir: '' })
    const r1 = (body.agents || []).find(a => a.id === 'r1')
    check('⑦ agents 带角色默认模型', r1 && r1.provider === 'p2' && r1.model === 'm2', r1)
  }

  if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
  console.log('RESULT: ALL PASS')
}).catch(err => {
  console.error('LOAD FAILED:', String(err && err.stack || err).slice(0, 800))
  process.exit(1)
})

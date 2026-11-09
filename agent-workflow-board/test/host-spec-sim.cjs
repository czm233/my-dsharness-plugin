#!/usr/bin/env node
/*
 * host 提示词组装验证（钩子注入语义 + v2.19.0 节点级模型语义）：
 * 加载真实 host.js（临时副本注入 compileSpec 等导出），用合成画布断言：
 *   ① 分派型钩子（派发前/子agent结束时）作为 ↳ 子行出现在所属节点的步骤行之后；
 *   ② 会话型钩子（会话开始）进全局时机段；挂在主会话上的不带归属标注；
 *   ③ 旧画布的 hook 孤岛节点保持原全局注入格式（兼容）；
 *   ④ 未设时机的钩子出现在全局段并标注「未设触发时机」；
 *   ⑤ 模型语义：无模型不写指令 / 节点模型 / 角色默认 / 节点覆盖角色 /
 *      missing+fallback / missing+stop / 目录拿不到按 ok（unknown 不误伤）/
 *      exec=lead 与模型互斥；
 *   ⑥ checkCanvasModels 的 ok/issues 三态与 collectCanvasRoutes 并集去重。
 *
 * 用法：node agent-workflow-board/test/host-spec-sim.cjs
 * 退出码：全绿 0；任何断言失败 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8')
const tmp = path.join(os.tmpdir(), 'awb-host-spec-sim.mjs')
fs.writeFileSync(
  tmp,
  src + '\nexport { compileSpec, checkCanvasModels, collectCanvasRoutes, resolveNodeModel, wantedRouteFor, __modelTestHooks }\n',
)

// 隔离：DSH_HOME 指向临时目录，名册/存储不碰真实 ~/.dsh
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-spec-home-'))
process.env.DSH_HOME = testHome
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-spec-project-'))
fs.mkdirSync(path.join(projectDir, 'agents'), { recursive: true })
fs.writeFileSync(
  path.join(projectDir, 'agents', 'test-role.md'),
  '---\nname: 测试角色\ndescription: 角色默认模型\nprovider: p1\nmodel: m-role\n---\n\n人设正文。\n',
  'utf8',
)

import(tmp).then(async ({ compileSpec, checkCanvasModels, collectCanvasRoutes, resolveNodeModel, __modelTestHooks }) => {
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('PASS', name)
    else { failed++; console.log('FAIL', name, '::', detail || '') }
  }
  const lineOf = (spec, label) => spec.split('\n').find(l => l.includes(`【工作】${label}`)) || ''
  // 带角色的节点人设含换行，模型指令落在同一编号段落内——按段落取样
  const sectionOf = (spec, label) => {
    const all = spec.split('\n')
    const start = all.findIndex(l => l.includes(`【工作】${label}`))
    if (start < 0) return ''
    let end = all.length
    for (let i = start + 1; i < all.length; i++) {
      if (/^\d+\.\s/.test(all[i])) { end = i; break }
    }
    return all.slice(start, end).join('\n')
  }

  // --- 原有用例：钩子注入语义（画布无模型字段，2.18.4 行为必须不变） -----------
  const doc = {
    id: 'sim',
    name: '钩子注入模拟',
    nodes: [
      { id: 's', type: 'start', label: '主会话', x: 0, y: 0, hooks: [{ id: 'hk1', timing: 'session-start', note: '盘点环境' }] },
      { id: 'a', type: 'work', label: '工作A', x: 200, y: 0, hooks: [{ id: 'hk2', timing: 'before-dispatch', note: '核对输入' }, { id: 'hk3', timing: 'subagent-end', note: '核对产出' }, { id: 'hk4', timing: '', note: '还没想好' }] },
      { id: 'e', type: 'end', label: '结束', x: 400, y: 0 },
      // 旧画布兼容：hook 孤岛节点（有 timing）与无连线旧钩子（无 timing）
      { id: 'h1', type: 'hook', label: '收尾检查', hookKind: 'session-end', note: '', x: 400, y: 100 },
      { id: 'h2', type: 'hook', label: '旧钩子', hookKind: '', note: '', x: 0, y: 100 },
    ],
    edges: [
      { id: 'e1', from: 's', to: 'a' },
      { id: 'e2', from: 'a', to: 'e' },
    ],
  }
  const spec = compileSpec(doc)
  const lines = spec.split('\n')
  const workLineIdx = lines.findIndex(l => l.includes('【工作】工作A'))
  check('工作A 进入步骤序号', workLineIdx > 0, spec.slice(0, 200))
  check('① 派发前钩子是工作A的↳子行', lines[workLineIdx + 1] === '   ↳ 每次派发子 agent 之前先核对：核对输入', lines.slice(workLineIdx, workLineIdx + 4).join(' | '))
  check('① 子agent结束钩子紧跟第二条', lines[workLineIdx + 2] === '   ↳ 每个子 agent 结束时，先按本动作核对其产出再继续：核对产出', lines[workLineIdx + 2])
  const timingIdx = lines.findIndex(l => l.includes('时机动作（钩子'))
  check('② 全局时机段存在', timingIdx > 0)
  const timingBlock = lines.slice(timingIdx).join('\n')
  check('② 会话开始钩子进全局段且主会话不带归属标注', timingBlock.includes('会话开始时（进入第一个流程节点之前）先完成：盘点环境') && !timingBlock.includes('设于节点「主会话」'), timingBlock)
  check('③ 旧钩子节点保持全局注入', timingBlock.includes('「收尾检查」'), timingBlock)
  check('④ 未设时机的钩子被标注', timingBlock.includes('未设触发时机'), timingBlock)
  check('④ 节点上的未设时机钩子不进↳子行', !lines.some(l => l.startsWith('   ↳') && l.includes('还没想好')))
  check('⑤ 无模型画布不写模型指令（2.18.4 行为不变）', !lineOf(spec, '工作A').includes('provider='), lineOf(spec, '工作A'))

  // --- v2.19.0 模型语义 -------------------------------------------------------
  const modelDoc = {
    id: 'sim-model',
    name: '模型模拟',
    projectDir,
    nodes: [
      { id: 's', type: 'start', label: '主会话', x: 0, y: 0 },
      { id: 'w0', type: 'work', label: '无模型', exec: 'subagent', x: 100, y: 0 },
      { id: 'w1', type: 'work', label: '节点模型', exec: 'subagent', model: { provider: 'p1', id: 'm1' }, x: 200, y: 0 },
      { id: 'w2', type: 'work', label: '角色默认', exec: 'subagent', agent: 'test-role', x: 300, y: 0 },
      { id: 'w3', type: 'work', label: '节点覆盖', exec: 'subagent', agent: 'test-role', model: { provider: 'p1', id: 'm2' }, x: 400, y: 0 },
      { id: 'w4', type: 'work', label: '失效回退', exec: 'subagent', model: { provider: 'gone', id: 'dead' }, x: 500, y: 0 },
      { id: 'w5', type: 'work', label: '失效停止', exec: 'subagent', model: { provider: 'gone', id: 'dead' }, onModelMissing: 'stop', x: 600, y: 0 },
      { id: 'w6', type: 'work', label: '主做带模型', exec: 'lead', model: { provider: 'p1', id: 'm1' }, x: 700, y: 0 },
      { id: 'e', type: 'end', label: '结束', x: 800, y: 0 },
    ],
    edges: ['s:w0', 'w0:w1', 'w1:w2', 'w2:w3', 'w3:w4', 'w4:w5', 'w5:w6', 'w6:e'].map((pair, i) => {
      const [from, to] = pair.split(':')
      return { id: 'e' + i, from, to }
    }),
  }

  // 目录可用：p1 渠道有 m1/m2/m-role；gone/dead 不存在 → missing
  __modelTestHooks.setCatalog([
    { provider: 'p1', id: 'm1', name: 'M1' },
    { provider: 'p1', id: 'm2', name: 'M2' },
    { provider: 'p1', id: 'm-role', name: 'MR' },
  ])
  const mSpec = compileSpec(modelDoc)
  check('⑤ 无模型节点不写模型指令', !lineOf(mSpec, '无模型').includes('provider='), lineOf(mSpec, '无模型'))
  check('⑤ 节点模型 → 参数必须带 provider/model', lineOf(mSpec, '节点模型').includes('provider="p1" model="m1"'), lineOf(mSpec, '节点模型'))
  check('⑤ 角色默认模型生效', sectionOf(mSpec, '角色默认').includes('provider="p1" model="m-role"'), sectionOf(mSpec, '角色默认'))
  const overrideLine = sectionOf(mSpec, '节点覆盖')
  check('⑤ 节点覆盖角色（m2 而非 m-role）', overrideLine.includes('model="m2"') && !overrideLine.includes('m-role'), overrideLine)
  const fallbackLine = lineOf(mSpec, '失效回退')
  check('⑤ missing+fallback → 默认模型执行并注明', fallbackLine.includes('gone/dead') && fallbackLine.includes('不可用') && fallbackLine.includes('默认模型') && fallbackLine.includes('注明') && !fallbackLine.includes('provider="gone"'), fallbackLine)
  const stopLine = lineOf(mSpec, '失效停止')
  check('⑤ missing+stop → 流程在此停止', stopLine.includes('gone/dead') && stopLine.includes('流程在此停止') && !stopLine.includes('provider="gone"'), stopLine)
  check('⑤ exec=lead 与模型互斥（不写指令）', !lineOf(mSpec, '主做带模型').includes('provider='), lineOf(mSpec, '主做带模型'))
  // missing+stop 节点的钩子仍注入（continue 会丢钩子，防回归）
  const stopIdx = mSpec.split('\n').findIndex(l => l.includes('【工作】失效停止'))
  check('⑤ stop 节点行存在', stopIdx > 0)

  // 目录拿不到（unknown）→ 全部按 ok 处理，不误伤
  __modelTestHooks.reset()
  const uSpec = compileSpec(modelDoc)
  check('⑤ 目录拿不到 → 失效节点也按 ok 写参数（unknown 不误伤）', lineOf(uSpec, '失效回退').includes('provider="gone" model="dead"'), lineOf(uSpec, '失效回退'))
  check('⑤ 目录拿不到 → stop 节点不写「停止」', !lineOf(uSpec, '失效停止').includes('流程在此停止'), lineOf(uSpec, '失效停止'))

  // --- checkCanvasModels（异步精确版） ----------------------------------------
  __modelTestHooks.setCatalog([
    { provider: 'p1', id: 'm1', name: 'M1' },
    { provider: 'p1', id: 'm2', name: 'M2' },
    { provider: 'p1', id: 'm-role', name: 'MR' },
  ])
  const result = await checkCanvasModels({}, modelDoc, '', null)
  const kinds = result.issues.map(issue => `${issue.kind}:${issue.nodeId}:${issue.policy}`).sort()
  check('⑥ checkModels 命中 missing 两节点', JSON.stringify(kinds) === JSON.stringify(['model:w4:fallback', 'model:w5:stop']), JSON.stringify(kinds))
  check('⑥ 有 stop → ok=false', result.ok === false)
  const onlyFallback = await checkCanvasModels({}, { ...modelDoc, nodes: modelDoc.nodes.filter(node => node.id !== 'w5') }, '', null)
  check('⑥ 只有 fallback → ok=true', onlyFallback.ok === true && onlyFallback.issues.length === 1)
  __modelTestHooks.reset()
  const unknown = await checkCanvasModels({}, modelDoc, '', null)
  check('⑥ 目录拿不到 → 无 issue 且 ok', unknown.ok === true && unknown.issues.length === 0, JSON.stringify(unknown))

  // --- collectCanvasRoutes：并集去重（w4/w5 同路由只算一条） -------------------
  const routes = collectCanvasRoutes(modelDoc)
  const routeKeys = routes.map(route => `${route.provider}/${route.model}`).sort()
  check('⑥ 路由并集去重', JSON.stringify(routeKeys) === JSON.stringify(['gone/dead', 'p1/m-role', 'p1/m1', 'p1/m2'].sort()), JSON.stringify(routeKeys))

  // --- resolveNodeModel 状态机 -------------------------------------------------
  __modelTestHooks.setCatalog([{ provider: 'p1', id: 'm1', name: 'M1' }])
  const roster = new Map([['test-role', { id: 'test-role', name: '测试角色', provider: 'p1', model: 'm-role' }]])
  const availSync = (p, i) => (p === 'p1' && i === 'm1' ? true : null)
  check('⑥ status=none（没设模型）', resolveNodeModel({ type: 'work', exec: 'subagent' }, roster, availSync).status === 'none')
  check('⑥ status=ok', resolveNodeModel({ type: 'work', exec: 'subagent', model: { provider: 'p1', id: 'm1' } }, roster, availSync).status === 'ok')
  check('⑥ status=unknown 按 ok 用', resolveNodeModel({ type: 'work', exec: 'subagent', model: { provider: 'x', id: 'y' } }, roster, availSync).status === 'unknown')
  check('⑥ 角色默认 wanted.source=role', resolveNodeModel({ type: 'work', exec: 'subagent', agent: 'test-role' }, roster, availSync).wanted.source === 'role')
  check('⑥ lead 节点不解析模型', resolveNodeModel({ type: 'work', exec: 'lead', model: { provider: 'p1', id: 'm1' } }, roster, availSync).status === 'none')

  if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
  console.log('RESULT: ALL PASS')
}).catch(err => {
  console.error('LOAD FAILED:', String(err && err.stack || err).slice(0, 800))
  process.exit(1)
})

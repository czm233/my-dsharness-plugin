#!/usr/bin/env node
/*
 * v2.19.0 模型围栏模拟（对应 tools/pre-execute 里的 applyModelFence）：
 * 加载真实 host.js（临时副本导出 applyModelFence），用合成 exec/canvas 断言：
 *   ① 参数缺失 → 改写为节点模型（provider/model 注入）；
 *   ② 参数不一致 → 改写为节点模型，且 reasoning_effort 被去掉（换路由回落默认力度）；
 *   ③ 参数已正确 → 不动；
 *   ④ 节点模型失效（目录确凿不含）→ 删掉指向失效路由的 provider/model/effort 后放行；
 *   ⑤ 节点模型失效但参数指向别的路由 → 不动（只删指向失效路由的参数）；
 *   ⑥ 目录拿不到（unknown）→ 按可用处理，照改写（不误伤）；
 *   ⑦ 角色默认模型同样触发改写（wanted = 节点 ?? 角色）；
 *   ⑧ 异常放行：exec.arguments 非对象 / 节点无模型 → 原样放行不抛错；
 *   ⑨ arguments 值被 deepFreeze（官方流水线语义）→ 整体替换仍生效。
 *
 * 用法：node agent-workflow-board/test/model-fence-sim.cjs
 * 退出码：全绿 0；任何断言失败 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8')
const tmp = path.join(os.tmpdir(), 'awb-model-fence-sim.mjs')
fs.writeFileSync(tmp, src + '\nexport { applyModelFence, __modelTestHooks }\n')

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-fence-home-'))
process.env.DSH_HOME = testHome
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-fence-project-'))
fs.mkdirSync(path.join(projectDir, 'agents'), { recursive: true })
fs.writeFileSync(
  path.join(projectDir, 'agents', 'fence-role.md'),
  '---\nname: 围栏角色\ndescription: d\nprovider: p1\nmodel: m-role\n---\n\n人设。\n',
  'utf8',
)

const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

import(tmp).then(async ({ applyModelFence, __modelTestHooks }) => {
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('PASS', name)
    else { failed++; console.log('FAIL', name, '::', detail === undefined ? '' : JSON.stringify(detail)) }
  }

  const canvas = { id: 'fence', name: '围栏模拟', projectDir, nodes: [], edges: [] }
  const nodeWith = model => ({ id: 'w', type: 'work', label: '工作', exec: 'subagent', ...(model ? { model } : {}) })
  const execWith = args => ({ name: 'subagent', arguments: args === undefined ? undefined : deepFreeze(args), agent: { id: 'sess-1' } })
  const ctxNoLlm = {} // 无 llm 服务：目录只能来自 setCatalog 的缓存

  const m1 = { provider: 'p1', id: 'm1' }
  const dead = { provider: 'gone', id: 'dead' }

  // 目录：p1 有 m1/m-role；gone/dead 不存在
  const seed = () => __modelTestHooks.setCatalog([
    { provider: 'p1', id: 'm1', name: 'M1' },
    { provider: 'p1', id: 'm-role', name: 'MR' },
  ])
  seed()

  // ① 参数缺失 → 注入节点模型
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p' })
    await applyModelFence(ctxNoLlm, exec, nodeWith(m1), canvas)
    check('① 参数缺失 → 改写注入', exec.arguments.provider === 'p1' && exec.arguments.model === 'm1' && exec.arguments.description === '任务', exec.arguments)
  }

  // ② 参数不一致 → 改写 + 去掉力度
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p', provider: 'other', model: 'x', reasoning_effort: 'high' })
    await applyModelFence(ctxNoLlm, exec, nodeWith(m1), canvas)
    check('② 不一致 → 改写为节点模型', exec.arguments.provider === 'p1' && exec.arguments.model === 'm1', exec.arguments)
    check('② 换路由时 reasoning_effort 被去掉', exec.arguments.reasoning_effort === undefined, exec.arguments)
  }

  // ③ 参数已正确 → 不动
  {
    __modelTestHooks.reset(); seed()
    const args = deepFreeze({ description: '任务', prompt: 'p', provider: 'p1', model: 'm1', reasoning_effort: 'low' })
    const exec = { name: 'subagent', arguments: args, agent: { id: 's' } }
    await applyModelFence(ctxNoLlm, exec, nodeWith(m1), canvas)
    check('③ 已正确 → 原样不动（含力度保留）', exec.arguments === args && exec.arguments.reasoning_effort === 'low', exec.arguments)
  }

  // ④ 节点模型失效 + 参数指向失效路由 → 删参放行
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p', provider: 'gone', model: 'dead', reasoning_effort: 'high' })
    await applyModelFence(ctxNoLlm, exec, nodeWith(dead), canvas)
    check('④ 失效 → 删掉失效路由参数', exec.arguments.provider === undefined && exec.arguments.model === undefined && exec.arguments.reasoning_effort === undefined && exec.arguments.description === '任务', exec.arguments)
  }

  // ⑤ 节点模型失效但参数指向别的路由 → 不动
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p', provider: 'p1', model: 'm1' })
    await applyModelFence(ctxNoLlm, exec, nodeWith(dead), canvas)
    check('⑤ 参数指向别的可用路由 → 不动', exec.arguments.provider === 'p1' && exec.arguments.model === 'm1', exec.arguments)
  }

  // ⑥ 目录拿不到（unknown）→ 按可用处理照改写
  {
    __modelTestHooks.reset() // catalog=null 且无 llm → unknown
    const exec = execWith({ description: '任务', prompt: 'p' })
    await applyModelFence(ctxNoLlm, exec, nodeWith(dead), canvas)
    check('⑥ unknown → 照改写不误伤', exec.arguments.provider === 'gone' && exec.arguments.model === 'dead', exec.arguments)
  }

  // ⑦ 角色默认模型触发改写
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p' })
    await applyModelFence(ctxNoLlm, exec, { id: 'w', type: 'work', label: '工作', exec: 'subagent', agent: 'fence-role' }, canvas)
    check('⑦ 角色默认模型 → 改写', exec.arguments.provider === 'p1' && exec.arguments.model === 'm-role', exec.arguments)
  }

  // ⑧ 异常放行：arguments 非对象 / 节点无模型 / 节点是 lead
  {
    __modelTestHooks.reset(); seed()
    const exec1 = { name: 'subagent', arguments: undefined, agent: { id: 's' } }
    await applyModelFence(ctxNoLlm, exec1, nodeWith(m1), canvas)
    check('⑧ arguments 非对象 → 不抛错不动', exec1.arguments === undefined)
    const exec2 = execWith({ description: '任务', prompt: 'p' })
    await applyModelFence(ctxNoLlm, exec2, nodeWith(null), canvas)
    check('⑧ 节点无模型 → 不动', exec2.arguments.provider === undefined, exec2.arguments)
    const exec3 = execWith({ description: '任务', prompt: 'p' })
    await applyModelFence(ctxNoLlm, exec3, { id: 'w', type: 'work', label: '工作', exec: 'lead', model: m1 }, canvas)
    check('⑧ lead 节点 → 不动（互斥）', exec3.arguments.provider === undefined, exec3.arguments)
  }

  // ⑨ frozen arguments 整体替换仍生效（①已隐含，此处显式断言可写性语义）
  {
    __modelTestHooks.reset(); seed()
    const exec = execWith({ description: '任务', prompt: 'p' })
    const frozenBefore = exec.arguments
    let threw = false
    try {
      await applyModelFence(ctxNoLlm, exec, nodeWith(m1), canvas)
    } catch {
      threw = true
    }
    check('⑨ deepFreeze 参数可被整体替换且不抛错', !threw && exec.arguments !== frozenBefore && exec.arguments.model === 'm1', exec.arguments)
  }

  if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
  console.log('RESULT: ALL PASS')
}).catch(err => {
  console.error('LOAD FAILED:', String(err && err.stack || err).slice(0, 800))
  process.exit(1)
})

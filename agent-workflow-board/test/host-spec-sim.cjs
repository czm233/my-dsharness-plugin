#!/usr/bin/env node
/*
 * host 提示词组装验证（钩子注入语义）：加载真实 host.js（临时副本注入 compileSpec 导出），
 * 用合成画布断言：
 *   ① 分派型钩子（派发前/子agent结束时）作为 ↳ 子行出现在所属节点的步骤行之后；
 *   ② 会话型钩子（会话开始）进全局时机段；挂在主会话上的不带归属标注；
 *   ③ 旧画布的 hook 孤岛节点保持原全局注入格式（兼容）；
 *   ④ 未设时机的钩子出现在全局段并标注「未设触发时机」。
 *
 * 用法：node agent-workflow-board/test/host-spec-sim.cjs
 * 退出码：全绿 0；任何断言失败 1。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8')
const tmp = path.join(os.tmpdir(), 'awb-host-spec-sim.mjs')
fs.writeFileSync(tmp, src + '\nexport { compileSpec }\n')
import(tmp).then(({ compileSpec }) => {
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
  let failed = 0
  const check = (name, cond, detail) => {
    if (cond) console.log('PASS', name)
    else { failed++; console.log('FAIL', name, '::', detail || '') }
  }
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
  if (failed > 0) { console.error(`RESULT: ${failed} FAILED`); process.exit(1) }
  console.log('RESULT: ALL PASS')
}).catch(err => {
  console.error('LOAD FAILED:', String(err && err.stack || err).slice(0, 400))
  process.exit(1)
})

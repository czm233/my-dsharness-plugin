#!/usr/bin/env node
/*
 * side-chat 装机前门禁（host 半）：加载【真实 index.js】，验证「侧边对话自己的
 * 子代理不给主会话发结算通知」这条抑制逻辑，同时确认别人的委托通知不受影响。
 *
 * 用法：node side-chat/test/host-suppress.cjs
 * 退出码：全绿 0；任何断言失败 1。
 *
 * 背景（0.3.4 实测缺陷）：子代理每轮 idle 后 activation 会被关闭，下一句冷恢
 * 复时官方 coldResume 不转发 delivery，默认回落 parent —— 于是每轮答完都往主
 * 会话塞一条 "Background subagent <id> finished ..." 并唤醒它。
 *
 * 覆盖：
 *   1. 创建路由返回 childId 后，该 id 进入抑制名单并落盘；
 *   2. 该 child 的结算消息（source.kind=subagent-settled）被投递层丢弃；
 *   3. 别的 child 的结算消息照常投递（不误伤真实委托）；
 *   4. 普通用户消息照常投递；
 *   5. agent/created 新出现的父代理同样被接管（覆盖重启后冷恢复）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok  ${label}`)
  else {
    failures.push(label)
    console.error(`FAIL  ${label}${detail === undefined ? '' : ' :: ' + detail}`)
  }
}

// 隔离 HOME：host 半把日志与名单写到 ~/Library/Application Support/dsh-side-chat
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'side-chat-home-'))
process.env.HOME = home

const SETTLE = (childId) => ({
  id: `m-${Math.random().toString(36).slice(2)}`,
  role: 'user',
  content: [{ type: 'text', text: `Background subagent ${childId} finished and will do no further work unless you send it more.` }],
  source: { kind: 'subagent-settled', form: 'notice', summary: 'x', senderSessionId: childId },
})
const PLAIN = () => ({ id: 'plain', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })

/** 造一个最小活代理：投递方法记录调用。 */
function createAgent(id) {
  const received = []
  return {
    id,
    received,
    followup(message) { received.push(['followup', message]) },
    steer(message) { received.push(['steer', message]) },
    inject(message) { received.push(['inject', message]) },
    send(message, target) { received.push(['send', message, target]) },
  }
}

async function main() {
  const plugin = await import(path.resolve(__dirname, '..', 'index.js'))
  const parent = createAgent('session-parent')

  // 假服务：路由、会话控制器、子代理缝。
  let route = null
  let startedParent = null
  const created = []
  const ctx = {
    on: () => () => {},
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    inject: (names, callback) => callback({
      effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
      connection: {
        fetch: {
          register: (definition) => { route = definition; return () => {} },
        },
      },
    }),
    get: (name) => {
      if (name === 'sessionController') {
        return { agents: { resolveAgent: async () => ({ agent: parent }) } }
      }
      if (name === 'subagents') {
        return {
          async startActivation(spec) {
            startedParent = spec.request.parent
            created.push(spec)
            return { childId: 'child-ours', messageId: 'm1' }
          },
        }
      }
      return undefined
    },
  }

  console.log('[1] 装机：路由注册')
  plugin.apply(ctx)
  check('注册了 POST /api/side-chat/create', route !== null && route.path === '/api/side-chat/create' && route.methods.includes('POST'))

  console.log('[2] 创建：childId 进入抑制名单并落盘')
  const response = await route.fetch({ json: async () => ({ sessionId: 'session-parent', text: '你好' }) })
  const payload = await response.json()
  check('返回 childId', payload.childId === 'child-ours', JSON.stringify(payload))
  check('startActivation 拿到活父代理', startedParent === parent)
  check('delivery 为 caller', created[0]?.delivery === 'caller', String(created[0]?.delivery))
  const childrenFile = path.join(home, 'Library', 'Application Support', 'dsh-side-chat', 'children.json')
  check('名单落盘', fs.existsSync(childrenFile) && fs.readFileSync(childrenFile, 'utf8').includes('child-ours'))

  console.log('[3] 自己的子代理结算消息被丢弃')
  parent.followup(SETTLE('child-ours'))
  parent.steer(SETTLE('child-ours'))
  parent.inject(SETTLE('child-ours'))
  parent.send(SETTLE('child-ours'), 'next-turn')
  check('followup/steer/inject/send 全部拦截', parent.received.length === 0, JSON.stringify(parent.received.map(entry => entry[0])))

  console.log('[4] 别的子代理结算消息照常投递')
  parent.followup(SETTLE('child-someone-else'))
  check('未误伤真实委托', parent.received.length === 1 && parent.received[0][0] === 'followup', JSON.stringify(parent.received.map(entry => entry[0])))

  console.log('[5] 普通用户消息照常投递')
  parent.followup(PLAIN())
  check('普通消息放行', parent.received.length === 2)

  console.log('[6] 重启后新代理同样被接管（agent/created）')
  let createdHandler = null
  const ctx2 = { ...ctx, on: (name, handler) => { if (name === 'agent/created') createdHandler = handler; return () => {} }, get: ctx.get }
  plugin.apply(ctx2)
  const fresh = createAgent('session-parent-2')
  check('注册了 agent/created 监听', createdHandler !== null)
  createdHandler({ agent: fresh })
  fresh.followup(SETTLE('child-ours'))
  check('名单里的 child 在新代理上也被拦截', fresh.received.length === 0, JSON.stringify(fresh.received))

  fs.rmSync(home, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
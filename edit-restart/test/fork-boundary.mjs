#!/usr/bin/env node
/*
 * edit-restart 门禁：fork 切点不得把「排队还没被消费的消息」带进新会话。
 *
 * 真实事故（2026-11-18）：用户在两轮之间把消息排进队列，那条消息随后作为单独一轮跑完；
 * 编辑它时切点落在它被消费之前，fork 出来的新会话于是把它当 pending 又放了一遍
 * ——编辑 C 却先重放一遍 B。
 *
 * 用法：node edit-restart/test/fork-boundary.mjs
 */
import { forkBoundary } from '../host.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`  ok  ${label}`)
  else {
    failures.push(label)
    console.error(`FAIL  ${label}${detail === undefined ? '' : ' :: ' + detail}`)
  }
}

const ev = (seq, type, data) => ({ seq, type, data })
const splice = (seq, target, start, removedCount, inserted = []) => ev(seq, 'agent/inbox/spliced', { target, start, removedCount, inserted })
const message = (id) => ({ id, content: [{ type: 'text', text: id }] })

/** 两条已完成的轮次 + 第 3 轮 + 被编辑消息所在的第 4 轮；splices 由调用方插进去。 */
function fixture(extra) {
  const base = [
    ev(0, 'permission/preset', {}),
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'step/start', { turn: 1 }),
    ev(3, 'user/message', {}),
    ev(4, 'assistant/message', {}),
    ev(5, 'step/end', {}),
    ev(6, 'turn/end', { turn: 1 }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'step/start', { turn: 2 }),
    ev(9, 'user/message', {}),
    ev(10, 'assistant/message', {}),
    ev(11, 'step/end', {}),
    ev(12, 'turn/end', { turn: 2 }),
    ev(13, 'turn/start', { turn: 3 }),
    ev(14, 'step/start', { turn: 3 }),
    ev(15, 'user/message', {}),
    ev(16, 'assistant/message', {}),
    ev(17, 'step/end', {}),
    ev(18, 'turn/end', { turn: 3 }),
    ev(19, 'turn/start', { turn: 4 }),
    ev(20, 'step/start', { turn: 4 }),
    ev(21, 'user/message', { content: [{ type: 'text', text: 'B' }] }),
  ]
  const events = [...base, ...extra].sort((left, right) => left.seq - right.seq)
  // 插进来的事件用小数 seq 排位，最后压成连续整数（真实日志 seq 连续）
  events.forEach((event, index) => { event.seq = index })
  const turnStart = events.find((event) => event.type === 'turn/start' && event.data.turn === 4).seq
  const target = events.find((event) => event.type === 'user/message' && event.data?.content?.[0]?.text === 'B').seq
  return { events, turnStart, target }
}

console.log('[1] 有排队消息：切点推到它被消费之后')
{
  // 上一轮里排了 A、B：A 被这一轮开始吃掉，B 留到被编辑那一轮才被吃
  const { events, turnStart, target } = fixture([
    splice(12.1, 'next-turn', 0, undefined, [message('A')]),
    splice(12.2, 'next-turn', 1, undefined, [message('B')]),
    splice(13.1, 'next-turn', 0, 1, []),
    splice(19.1, 'next-turn', 0, 1, []),
  ])
  const cut = forkBoundary(events, turnStart, target)
  const consumedAt = events.find((event) => event.type === 'agent/inbox/spliced' && event.seq > turnStart).seq
  check(`切点 = B 被消费的事件（${consumedAt}），不是上一轮结束（${turnStart - 1}）`, cut === consumedAt, String(cut))
  check('切点在被改消息之前', cut < target, `${cut} < ${target}`)
}

console.log('[2] 没有排队消息：切点就是上一条消息之后')
{
  const { events, turnStart, target } = fixture([])
  const cut = forkBoundary(events, turnStart, target)
  check(`切点 = ${turnStart - 1}（上一轮 turn/end）`, cut === turnStart - 1, String(cut))
}

console.log('[3] 排队消息在被改消息之前一直没消费：不越过这条消息')
{
  const { events, turnStart, target } = fixture([
    splice(12.5, 'next-turn', 0, undefined, [message('B')]),
  ])
  const cut = forkBoundary(events, turnStart, target)
  check('退回上一轮结束处', cut === turnStart - 1, String(cut))
  check('绝不越过被改消息', cut < target)
}

console.log('[4] 排队在 next-step 里同样处理')
{
  const { events, turnStart, target } = fixture([
    splice(12.5, 'next-step', 0, undefined, [message('S')]),
    splice(19.2, 'next-step', 0, 1, []),
  ])
  const cut = forkBoundary(events, turnStart, target)
  const consumedAt = events.find((event) => event.seq > turnStart && event.type === 'agent/inbox/spliced').seq
  check(`切点 = next-step 被消费的事件（${consumedAt}）`, cut === consumedAt, String(cut))
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败`)
  process.exit(1)
}
console.log('✓ all green')
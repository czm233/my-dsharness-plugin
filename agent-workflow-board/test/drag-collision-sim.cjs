#!/usr/bin/env node
/*
 * 拖拽碰撞逐帧模拟（PITFALLS #24 的落盘物，随节点实体化撤回一并入库存档）：
 * 模拟 A 节点从下方 30 帧连续上推撞 B 的完整交互。实体化功能已按用户决定撤回，
 * 此文件作为将来若重启该功能时的「入场券」——先跑通/扩展本模拟再动 client.js。
 * 已验证的预期行为：A 停在 B 底边 + GAP（y=252），30 帧不瞬移、不横跳、不穿卡。
 */
// 手写转写版模拟：与 client.js 2.17.x 碰撞块逻辑一致
const NODE_H = 46
const GAP = 6
const segRectHit = (a, b, node) => {
  const pad = 4
  const x0 = node.x - pad, y0 = node.y - pad
  const x1 = node.x + 140 + pad, y1 = node.y + NODE_H + pad
  let t0 = 0, t1 = 1
  const dx = b.x - a.x, dy = b.y - a.y
  const p = [-dx, dx, -dy, dy]
  const q = [a.x - x0, x1 - a.x, a.y - y0, y1 - a.y]
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false }
    else {
      const t = q[i] / p[i]
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t }
      else { if (t < t0) return false; if (t < t1) t1 = t }
    }
  }
  return true
}
const node = { id: 'a', x: 320, y: 500, label: 'A' }
const multiIds = []
const doc = { nodes: [node, { id: 'b', x: 320, y: 200, label: 'B' }] }
const origins = new Map([['a', { x: 320, y: 500 }]])
const dragRef = { current: { appliedX: 0, appliedY: 0 } }
const zoomRef = { current: 1 }
const others = doc.nodes.filter(item => item.id !== node.id)
const measureNodeWidth = () => 140
const hitOne = (x, y, o) => x < o.x + 140 && x + 140 > o.x && y < o.y + NODE_H && y + NODE_H > o.y
const hitAny = (x, y) => others.some(o => hitOne(x, y, o))
for (let f = 1; f <= 30; f++) {
  var dx = 0
  var dy = -25 * f
  var wx = dx
  var wy = dy
  if (!multiIds.includes(node.id)) {
    const GAP = 6
    const w = 140
    const baseX = origins.get('a').x
    const baseY = origins.get('a').y
    const hitOne2 = (x, y, o) => x < o.x + 140 && x + 140 > o.x && y < o.y + NODE_H && y + NODE_H > o.y
    const hitAny2 = (x, y) => others.some(o => hitOne2(x, y, o))
    let ax = dragRef.current.appliedX || 0
    let ay = dragRef.current.appliedY || 0
    const rawX = baseX + dx
    const rawY = baseY + dy
    const fromPt = { x: baseX + ax, y: baseY + ay }
    const toPt = { x: rawX, y: rawY }
    const pathOrEndBlocked = others.some(o => segRectHit(fromPt, toPt, o) || hitOne2(toPt.x, toPt.y, o))
    if (pathOrEndBlocked) {
      const blockers = others.filter(o => segRectHit(fromPt, toPt, o) || hitOne2(toPt.x, toPt.y, o))
      const movingX = Math.abs(toPt.x - fromPt.x) >= Math.abs(toPt.y - fromPt.y)
      if (movingX) {
        ax = (wx >= 0 ? Math.min(...blockers.map(o => o.x - GAP - w)) : Math.max(...blockers.map(o => o.x + 140 + GAP))) - baseX
        ay = toPt.y - baseY
      } else {
        ay = (wy >= 0 ? Math.min(...blockers.map(o => o.y - GAP - NODE_H)) : Math.max(...blockers.map(o => o.y + NODE_H + GAP))) - baseY
        ax = toPt.x - baseX
      }
    } else {
      ax = toPt.x - baseX
      ay = toPt.y - baseY
    }
    dragRef.current.appliedX = ax
    dragRef.current.appliedY = ay
    wx = ax
    wy = ay
  }
  node.x = 320 + wx
  node.y = 500 + wy
  console.log('frame', f, 'A =', Math.round(node.x), Math.round(node.y))
}

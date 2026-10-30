#!/usr/bin/env node
/*
 * 画布快照工具（连线改动视觉自查用，配合 PITFALLS #22/#23）：
 *   node agent-workflow-board/test/canvas-snapshot.cjs <canvas.json> <out.svg>
 * 生成与浏览器一致的 SVG（节点卡/端口/正交连线/分道/避障/箭头/是-否配色），
 * 再用 qlmanage 转 PNG 查看。注意 qlmanage 会挂起，务必加超时：
 *   qlmanage -t -s 1600 -o /tmp out.svg >/dev/null 2>&1 & QP=$!; sleep 10; kill $QP 2>/dev/null
 * 几何函数从 ../client.js 实时抠取，保证测的就是装出去那份代码。
 */
let measureCtx = null
const document = { createElement: () => ({ getContext: () => ({ set font(v){}, measureText: t => ({ width: t.length * 12 }) }) }) }
const NODE_W=232, NODE_H=46
const PORTS=['top','right','bottom','left']
const PORT_DIRS={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]}
    function measureNodeWidth(label) {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
      measureCtx.font = '600 12px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
      const text = Math.ceil(measureCtx.measureText(String(label || '')).width)
      return Math.round(Math.min(600, Math.max(76, text + 60)))
    }

    function portPoint(node, port) {
      const w = measureNodeWidth(node.label)
      switch (port) {
        case 'top': return { x: node.x + w / 2, y: node.y }
        case 'bottom': return { x: node.x + w / 2, y: node.y + NODE_H }
        case 'left': return { x: node.x, y: node.y + NODE_H / 2 }
        default: return { x: node.x + w, y: node.y + NODE_H / 2 }
      }
    }

    function nearestPort(node, px, py) {
      let best = 'right'
      let bestD = Infinity
      for (const port of PORTS) {
        const pt = portPoint(node, port)
        const d = (pt.x - px) ** 2 + (pt.y - py) ** 2
        if (d < bestD) {
          bestD = d
          best = port
        }
      }
      return best
    }

    function bestPorts(from, to) {
      const best = bestPair(from, to)
      return [best.fp, best.tp]
    }

    function pairScore(from, to, fp, tp) {
      const p1 = portPoint(from, fp)
      const p2 = portPoint(to, tp)
      const d1 = PORT_DIRS[fp]
      const d2 = PORT_DIRS[tp]
      const sameAxis = (d1[0] !== 0) === (d2[0] !== 0)
      const perpOff = sameAxis ? (d1[1] !== 0 ? Math.abs(p1.x - p2.x) : Math.abs(p1.y - p2.y)) : Infinity
      const turns = sameAxis && perpOff <= 12 ? 0 : sameAxis ? 2 : 1
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      return { turns, score: turns * 10000 + len }
    }

    function bestPair(from, to, fixedFp) {
      let best = null
      for (const fp of PORTS) {
        if (fixedFp && fp !== fixedFp) continue
        for (const tp of PORTS) {
          const s = pairScore(from, to, fp, tp)
          if (!best || s.score < best.score) best = { fp, tp, score: s.score }
        }
      }
      return best
    }

    function edgeGeometry(from, to, fromPort, toPort, label) {
      let fp = PORTS.includes(fromPort) ? fromPort : 'right'
      let tp = PORTS.includes(toPort) ? toPort : 'left'
      if (from.type === 'router' && (label === '是' || label === '否')) {
        // 判断分支：语义出端（是=右/否=下）只作为小幅偏好（-30px，远小于一档拐弯 10000），
        // 几何明显更优（更少拐弯/更短）的组合照常胜出，不再硬性钉死出端
        const semanticFp = label === '是' ? 'right' : 'bottom'
        let best = null
        for (const f of PORTS) {
          for (const t of PORTS) {
            const s = pairScore(from, to, f, t)
            const score = s.score - (f === semanticFp ? 30 : 0)
            if (!best || score < best.score) best = { fp: f, tp: t, score }
          }
        }
        fp = best.fp
        tp = best.tp
      } else {
        // 其他节点：出/入端都按「最少拐弯优先、其次最短」选
        const best = bestPair(from, to)
        fp = best.fp
        tp = best.tp
      }
      // 同轴端口背向纠正：比如 下→下 但目标就在正下方，会走出 S 形回头路；
      // 此时按相对位置改用面向彼此的端口（下→上 直连）。
      if (fp === tp && (fp === 'top' || fp === 'bottom')) {
        const targetBelow = to.y + NODE_H / 2 >= from.y + NODE_H / 2
        const away = fp === 'top' ? !targetBelow : targetBelow
        if (away) {
          fp = targetBelow ? 'bottom' : 'top'
          tp = targetBelow ? 'top' : 'bottom'
        }
      } else if (fp === tp && (fp === 'left' || fp === 'right')) {
        const targetRight = to.x >= from.x
        const away = fp === 'left' ? !targetRight : targetRight
        if (away) {
          fp = targetRight ? 'right' : 'left'
          tp = targetRight ? 'left' : 'right'
        }
      }
      const p1 = portPoint(from, fp)
      const p2 = portPoint(to, tp)
      const d1 = PORT_DIRS[fp]
      const d2 = PORT_DIRS[tp]
      // 两点几乎重合（节点叠在一起等极端情况）：退化为一条短直线，避免后续计算越界
      if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 2) {
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
        return { pts: [p1, mid, p2], axis: 'h' }
      }
      // 电路板式走线：端口沿法线伸出引出线，再横平竖直达目标端口，直角倒圆角。
      // 引出线长度随两端间距自适应：间距小时收缩，两端引出线永不互相插进对方。
      const stub = Math.min(24, Math.max(6, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2 - 2))
      const a = { x: p1.x + d1[0] * stub, y: p1.y + d1[1] * stub }
      const b = { x: p2.x + d2[0] * stub, y: p2.y + d2[1] * stub }
      // 正交阶梯点：横竖分明，杜绝斜线
      const v1 = d1[1] !== 0
      const v2 = d2[1] !== 0
      // 近对齐直连：两端同轴正对且垂直偏差 ≤12px 时，合并为一条直线，避免几像素的小台阶弯折
      if (v1 === v2 && (v1 ? Math.abs(p1.x - p2.x) <= 12 : Math.abs(p1.y - p2.y) <= 12)) {
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
        const ddx = Math.abs(p2.x - p1.x)
        const ddy = Math.abs(p2.y - p1.y)
        return { pts: [p1, mid, p2], axis: ddx >= ddy ? 'h' : 'v' }
      }
      let pts = [p1, a, b, p2]
      if (v1 === v2) {
        // 同轴：反向(上↔下/左↔右)走中位线，同向走 S 阶梯
        if (v1) {
          const midY = (a.y + b.y) / 2
          pts = [p1, a, { x: a.x, y: midY }, { x: b.x, y: midY }, b, p2]
        } else {
          const midX = (a.x + b.x) / 2
          pts = [p1, a, { x: midX, y: a.y }, { x: midX, y: b.y }, b, p2]
        }
      } else if (v1) {
        // 垂直出、水平入：拐点取 (a.x, b.y)
        pts = [p1, a, { x: a.x, y: b.y }, b, p2]
      } else {
        // 水平出、垂直入：拐点取 (b.x, a.y)
        pts = [p1, a, { x: b.x, y: a.y }, b, p2]
      }
      // 去重与去共线：删掉 <1px 的重复点和在直线上毫无作用的中间点
      const dx = Math.abs(p2.x - p1.x)
      const dy = Math.abs(p2.y - p1.y)
      // 原始阶梯点（不去共线）——避障需要完整拐点；去重/去共线由 routeAroundNodes 收尾
      return { pts, axis: dx >= dy ? 'h' : 'v' }
    }

    function roundedPath(pts, r = 14) {
      if (!pts || pts.length === 0) return ''
      if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
      let d = `M ${pts[0].x} ${pts[0].y}`
      for (let i = 1; i < pts.length - 1; i++) {
        const p = pts[i - 1]
        const c = pts[i]
        const n = pts[i + 1]
        const d1 = Math.hypot(c.x - p.x, c.y - p.y)
        const d2 = Math.hypot(n.x - c.x, n.y - c.y)
        if (d1 < 1 || d2 < 1) continue
        const rr = Math.min(r, d1 / 2, d2 / 2)
        const t1 = { x: c.x + ((p.x - c.x) / d1) * rr, y: c.y + ((p.y - c.y) / d1) * rr }
        const t2 = { x: c.x + ((n.x - c.x) / d2) * rr, y: c.y + ((n.y - c.y) / d2) * rr }
        d += ` L ${t1.x} ${t1.y} Q ${c.x} ${c.y} ${t2.x} ${t2.y}`
      }
      const last = pts[pts.length - 1]
      d += ` L ${last.x} ${last.y}`
      return d
    }

    function polylineMid(pts) {
      let total = 0
      const segs = []
      for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
        segs.push(len)
        total += len
      }
      let remain = total / 2
      for (let i = 0; i < segs.length; i++) {
        if (remain <= segs[i]) {
          const t = segs[i] ? remain / segs[i] : 0
          return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t }
        }
        remain -= segs[i]
      }
      return pts[0]
    }

    // 线段是否穿过（外扩4px的）节点矩形：水平段看 y 落带 + x 区间，垂直段对称
    function segHitsNode(a, b, node) {
      const r = { x: node.x, y: node.y, w: measureNodeWidth(node.label), h: NODE_H }
      const dx = Math.abs(b.x - a.x)
      const dy = Math.abs(b.y - a.y)
      // 近水平（垂直偏差 ≤12px）按水平段判定，近垂直同理——微斜的直连线也要能检出穿卡
      if (dy <= 12 && dx > 4) {
        const y = (a.y + b.y) / 2
        const lo = Math.min(a.x, b.x)
        const hi = Math.max(a.x, b.x)
        return y > r.y - 4 && y < r.y + r.h + 4 && hi > r.x - 4 && lo < r.x + r.w + 4
      }
      if (dx <= 12 && dy > 4) {
        const x = (a.x + b.x) / 2
        const lo = Math.min(a.y, b.y)
        const hi = Math.max(a.y, b.y)
        return x > r.x - 4 && x < r.x + r.w + 4 && hi > r.y - 4 && lo < r.y + r.h + 4
      }
      return false
    }

    // 避障绕行：中间长段若穿过任何第三方节点，把该段平移到清空带（上/下/左/右就近），最多迭代 6 轮
    function routeAroundNodes(pts, axis, nodes, skipA, skipB) {
      let cur = pts
      const clear = 14
      const usedLines = [] // 已使用的绕行线：后续绕行就近吸附，避免同一批绕行出现 1~2px 的小台阶
      for (let round = 0; round < 6; round++) {
        let changed = false
        for (let i = 0; i < cur.length - 1; i++) {
          const a = cur[i]
          const b = cur[i + 1]
          if (Math.hypot(b.x - a.x, b.y - a.y) < 30) continue
          const others = nodes.filter(n => n.id !== skipA && n.id !== skipB)
          if (!others.some(n => segHitsNode(a, b, n))) continue
          if (axis === 'h') {
            const lo = Math.min(a.x, b.x)
            const hi = Math.max(a.x, b.x)
            let y = a.y
            for (let k = 0; k < 4; k++) {
              const hits = others.filter(n => lo < n.x + measureNodeWidth(n.label) + 4 && hi > n.x - 4 && y > n.y - 4 && y < n.y + NODE_H + 4)
              if (hits.length === 0) break
              const belowMax = Math.max(...hits.map(n => n.y + NODE_H)) + clear
              const aboveMin = Math.min(...hits.map(n => n.y)) - clear
              y = Math.abs(y - belowMax) <= Math.abs(y - aboveMin) ? belowMax : aboveMin
              const snapY = usedLines.find(u => Math.abs(u - y) <= 4)
              if (snapY !== undefined) y = snapY
              else usedLines.push(y)
            }
            if (y !== a.y) {
              cur = [...cur.slice(0, i + 1), { x: a.x, y }, { x: b.x, y }, ...cur.slice(i + 1)]
              changed = true
              break
            }
          } else {
            const lo = Math.min(a.y, b.y)
            const hi = Math.max(a.y, b.y)
            let x = a.x
            for (let k = 0; k < 4; k++) {
              const hits = others.filter(n => lo < n.y + NODE_H + 4 && hi > n.y - 4 && x > n.x - 4 && x < n.x + measureNodeWidth(n.label) + 4)
              if (hits.length === 0) break
              const rightMax = Math.max(...hits.map(n => n.x + measureNodeWidth(n.label))) + clear
              const leftMin = Math.min(...hits.map(n => n.x)) - clear
              x = Math.abs(x - rightMax) <= Math.abs(x - leftMin) ? rightMax : leftMin
              const snapX = usedLines.find(u => Math.abs(u - x) <= 4)
              if (snapX !== undefined) x = snapX
              else usedLines.push(x)
            }
            if (x !== a.x) {
              cur = [...cur.slice(0, i + 1), { x, y: a.y }, { x, y: b.y }, ...cur.slice(i + 1)]
              changed = true
              break
            }
          }
        }
        if (!changed) break
      }
      // 去重与去共线
      const clean = []
      for (const pt of cur) {
        const prevPt = clean[clean.length - 1]
        if (prevPt && Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) < 1) continue
        clean.push(pt)
      }
      for (let i = 1; i < clean.length - 1; ) {
        const p = clean[i - 1]
        const c = clean[i]
        const n = clean[i + 1]
        const cross = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x)
        if (Math.abs(cross) < 0.5) clean.splice(i, 1)
        else i++
      }
      return clean
    }

const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
const TILE = { start:'#e6edf3', work:'#4d6bfe', router:'#c78a1d', end:'#22a06b', hook:'#e5534b' }
const GLYPH = { start:'S', work:'W', router:'R', end:'E', hook:'H' }
const nodeSvg = node => {
  const w = measureNodeWidth(node.label)
  const x = node.x, y = node.y
  const tile = TILE[node.type] || '#4d6bfe'
  let s = `<g>`
  s += `<rect x="${x}" y="${y}" width="${w}" height="46" rx="10" fill="#1a2029" stroke="#39414d"/>`
  s += `<rect x="${x+10}" y="${y+10}" width="26" height="26" rx="7" fill="${tile}"/>`
  s += `<text x="${x+23}" y="${y+27}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="PingFang SC">${GLYPH[node.type]||'?'}</text>`
  s += `<text x="${x+45}" y="${y+27}" font-size="12" font-weight="600" fill="#e6edf3" font-family="PingFang SC" dominant-baseline="central">${esc(node.label||node.id)}</text>`
  for (const p of PORTS) {
    const pt = portPoint(node, p)
    s += `<circle cx="${pt.x}" cy="${pt.y}" r="5" fill="#0e1116" stroke="#8b949e" stroke-width="2"/>`
  }
  s += `</g>`
  return s
}
const edgeSvg = (edge, g, lane, from, to) => {
  const pts = lane ? g.pts.map((pt, idx) => (idx === 0 || idx === g.pts.length - 1 ? pt : g.axis === 'h' ? { x: pt.x, y: pt.y + lane } : { x: pt.x + lane, y: pt.y })) : g.pts
  const color = edge.label === '是' ? '#34c77b' : edge.label === '否' ? '#e5534b' : '#8b949e'
  let s = `<path d="${roundedPath(pts)}" fill="none" stroke="${color}" stroke-width="1.6"/>`
  const n = pts.length
  const p2 = pts[n-1], pv = pts[n-2]
  const len = Math.hypot(p2.x-pv.x, p2.y-pv.y) || 1
  const ux = (p2.x-pv.x)/len, uy = (p2.y-pv.y)/len
  const tipX = p2.x - ux*1, tipY = p2.y - uy*1
  const bx = tipX - ux*9, by = tipY - uy*9
  const px = -uy, py = ux
  s += `<polygon points="${tipX},${tipY} ${bx+px*4},${by+py*4} ${bx-px*4},${by-py*4}" fill="${color}"/>`
  const mid = polylineMid(pts)
  if (edge.label) s += `<text x="${mid.x}" y="${mid.y+4}" text-anchor="middle" font-size="10" fill="${color}" font-family="PingFang SC">${esc(edge.label)}</text>`
  return s
}
const doc = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
const nodesById = new Map(doc.nodes.map(n => [n.id, n]))
const geosById = new Map()
for (const edge of doc.edges || []) {
  const from = nodesById.get(edge.from), to = nodesById.get(edge.to)
  if (!from || !to) continue
  const geo = edgeGeometry(from, to, edge.fromPort, edge.toPort, edge.label)
  geo.pts = routeAroundNodes(geo.pts, geo.axis, doc.nodes, edge.from, edge.to)
  geosById.set(edge.id, geo)
}
  const principalOf = g => {
    let best = -1
    let line = 0
    let lo = 0
    let hi = 0
    for (let i = 1; i < g.pts.length; i++) {
      const a = g.pts[i - 1]
      const b = g.pts[i]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len > best) {
        best = len
        if (g.axis === 'h') {
          line = a.y
          lo = Math.min(a.x, b.x)
          hi = Math.max(a.x, b.x)
        } else {
          line = a.x
          lo = Math.min(a.y, b.y)
          hi = Math.max(a.y, b.y)
        }
      }
    }
    return { line, span: [lo, hi] }
  }
  // 走廊合并：同轴且主段直线坐标相差 ≤10px 的边归入同一条走廊（近邻合并，避免错几像素就漏分组）
  const items = [...geosById.entries()].map(([id, g]) => ({ id, axis: g.axis, line: principalOf(g).line }))
  const corridorGroups = []
  for (const axis of ['h', 'v']) {
    const pool = items.filter(item => item.axis === axis).sort((a, b) => a.line - b.line)
    let group = null
    for (const item of pool) {
      if (group && item.line - group.line <= 10) group.ids.push(item.id)
      else {
        group = { line: item.line, ids: [item.id] }
        corridorGroups.push(group)
      }
    }
  }
  // 车道：走廊内主段区间互相重叠才让道；车道序号居中扇形展开（档距 8px），不往单侧堆
  const laneOffsets = new Map()
  for (const group of corridorGroups) {
    if (group.ids.length < 2) continue
    const placed = []
    const laneSeq = []
    for (const id of group.ids) {
      const span = principalOf(geosById.get(id)).span
      let lane = 0
      const clash = () => placed.some(item => item.lane === lane && span[0] < item.span[1] - 2 && item.span[0] < span[1] - 2)
      while (clash()) lane++
      placed.push({ lane, span })
      laneSeq.push(lane)
    }
    const maxLane = Math.max(...laneSeq)
    group.ids.forEach((id, i) => {
      if (maxLane > 0) laneOffsets.set(id, (laneSeq[i] - maxLane / 2) * 8)
    })
  }
let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9
for (const n of doc.nodes){ minX=Math.min(minX,n.x); minY=Math.min(minY,n.y); maxX=Math.max(maxX,n.x+measureNodeWidth(n.label)); maxY=Math.max(maxY,n.y+NODE_H) }
for (const [,g] of geosById) for (const pt of g.pts){ minX=Math.min(minX,pt.x); minY=Math.min(minY,pt.y); maxX=Math.max(maxX,pt.x); maxY=Math.max(maxY,pt.y) }
const PAD=50
minX-=PAD; minY-=PAD; maxX+=PAD; maxY+=PAD
const W=maxX-minX, H=maxY-minY
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${minX} ${minY} ${W} ${H}">`
svg += `<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="#12161d"/>`
for (const [id,g] of geosById) {
  const edge = doc.edges.find(e => e.id === id)
  const lane = laneOffsets.get(id) || 0
  svg += edgeSvg(edge, g, lane, nodesById.get(edge.from), nodesById.get(edge.to))
}
for (const n of doc.nodes) svg += nodeSvg(n)
svg += `</svg>`
require('fs').writeFileSync(process.argv[3], svg)
console.log('svg written', Math.round(W), 'x', Math.round(H))

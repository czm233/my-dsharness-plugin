#!/usr/bin/env node
/**
 * 降级档位状态机模拟（PITFALLS #22/#25 的教训：装机前用真实逻辑跑一遍）。
 *
 * 复制 client.js 里 nextMode / widthsFor / estimateFor 的语义，验证：
 *   1. 宽→窄 单调降级，不回头
 *   2. 窄→宽 单调回升
 *   3. 临界点抖动被滞回吸收
 *   4. 不会因「当前档更窄」而反复升降
 *   5. 极窄停在 tight
 *   6. 宽敞宽度保持 full
 *
 * 断言失败即退出码 1。
 */
const MODE_FULL = 'full'
const MODE_COMPACT = 'compact'
const MODE_TIGHT = 'tight'
const DEMOTE_SLACK = 6
const PROMOTE_SLACK = 24
const ORDER = [MODE_TIGHT, MODE_COMPACT, MODE_FULL]

function nextMode(mode, widths, available) {
  if (!available) return mode
  const index = ORDER.indexOf(mode)
  // 升档：逐级升，每级都要求目标档实测放得下
  const up = ORDER[index + 1]
  if (up !== undefined) {
    const w = widths[up]
    if (w > 0 && available - w >= PROMOTE_SLACK) return up
  }
  // 降档：当前档超宽
  const currentWidth = widths[mode]
  if (currentWidth > 0 && currentWidth - available > DEMOTE_SLACK) {
    return ORDER[Math.max(0, index - 1)]
  }
  return mode
}

const REAL = { [MODE_FULL]: 420, [MODE_COMPACT]: 300, [MODE_TIGHT]: 240 }
// 与实现一致的估算：按 full 宽度折算
const ESTIMATE_TIGHT = 190
const ESTIMATE_COMPACT = 260
function estimate(mode, fullWidth) {
  if (mode === MODE_FULL) return fullWidth
  if (fullWidth <= 0) return mode === MODE_COMPACT ? 260 : 190
  return mode === MODE_COMPACT ? Math.round(fullWidth * 0.62) : Math.round(fullWidth * 0.48)
}

function makeRunner() {
  // 只记实测值；未知为 0（保守按放不下处理）
  const measured = { [MODE_FULL]: 0, [MODE_COMPACT]: 0, [MODE_TIGHT]: 0 }
  return function run(mode, available) {
    measured[mode] = REAL[mode]
    const full = measured[MODE_FULL]
    const widths = {
      [MODE_FULL]: full,
      [MODE_COMPACT]: measured[MODE_COMPACT] || estimate(MODE_COMPACT, full),
      [MODE_TIGHT]: measured[MODE_TIGHT] || estimate(MODE_TIGHT, full),
    }
    return nextMode(mode, widths, available)
  }
}

let failures = 0
function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('1. 宽 → 窄：单调降级')
{
  const run = makeRunner()
  let mode = MODE_FULL
  const seen = [mode]
  for (let w = 560; w >= 120; w -= 4) {
    mode = run(mode, w)
    if (mode !== seen[seen.length - 1]) seen.push(mode)
  }
  check('顺序恰为 full→compact→tight', seen.join('→') === 'full→compact→tight', seen.join('→'))
}

console.log('2. 窄 → 宽：单调回升（真实场景：首次渲染是 full，缩窄后才从 tight 回升）')
{
  const run = makeRunner()
  // 真实路径：先在大屏渲染一次（full 被实测），再缩到最窄，再放宽。
  let mode = run(MODE_FULL, 1200)
  for (let w = 1200; w >= 120; w -= 4) mode = run(mode, w)
  const seen = [mode]
  for (let w = 120; w <= 560; w += 4) {
    mode = run(mode, w)
    if (mode !== seen[seen.length - 1]) seen.push(mode)
  }
  check('顺序恰为 tight→compact→full', seen.join('→') === 'tight→compact→full', seen.join('→'))
}

console.log('3. 临界点抖动被吸收')
{
  const run = makeRunner()
  let mode = MODE_FULL
  const trail = []
  for (let i = 0; i < 60; i += 1) {
    const w = 426 + (i % 2 === 0 ? 3 : -3)
    mode = run(mode, w)
    trail.push(mode)
  }
  const switches = trail.filter((m, i) => i > 0 && m !== trail[i - 1]).length
  check('60 次抖动切换 ≤ 1 次', switches <= 1, `实际 ${switches} 次`)
}

console.log('4. 不会因「当前档更窄」而反复升降')
{
  const run = makeRunner()
  let mode = run(MODE_FULL, 380)
  check('380px → compact', mode === MODE_COMPACT, mode)
  let stable = true
  for (let i = 0; i < 10; i += 1) {
    mode = run(mode, 380)
    if (mode !== MODE_COMPACT) stable = false
  }
  check('380px 稳定停在 compact', stable, mode)
}

console.log('5. 极窄停在 tight')
{
  const run = makeRunner()
  let mode = MODE_FULL
  for (let w = 420; w >= 80; w -= 10) mode = run(mode, w)
  check('极窄 → tight', mode === MODE_TIGHT, mode)
}

console.log('6. 大屏保持 full 不动')
{
  const run = makeRunner()
  let mode = MODE_FULL
  for (const w of [1200, 900, 700, 600]) mode = run(mode, w)
  check('宽敞宽度始终 full', mode === MODE_FULL, mode)
}

console.log('7. 首帧即在窄窗口：仍应正确收敛到 tight')
{
  // 真实路径：首帧渲染 full（DOM 量得到 420，即使被裁），随后 evaluate
  const run = makeRunner()
  let mode = MODE_FULL
  for (let i = 0; i < 8; i += 1) mode = run(mode, 200)
  check('200px 窄窗口收敛到 tight', mode === MODE_TIGHT, mode)
  // 再放宽 → 逐级回升
  let m2 = mode
  for (let w = 200; w <= 520; w += 4) m2 = run(m2, w)
  check('放宽后回到 full', m2 === MODE_FULL, m2)
}

console.log('8. 宽度来回拖动不残留错误档位')
{
  const run = makeRunner()
  let mode = MODE_FULL
  const widths = [800, 300, 500, 250, 700, 320, 460, 600]
  for (const w of widths) {
    // 每个宽度稳定一下再换
    for (let i = 0; i < 3; i += 1) mode = run(mode, w)
  }
  // 最后稳定在 600px：full(420) 放得下且余量 180 ≥ 24 → full
  check('600px 稳定回 full', mode === MODE_FULL, mode)
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
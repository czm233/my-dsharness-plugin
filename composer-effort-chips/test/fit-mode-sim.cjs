#!/usr/bin/env node
/**
 * 档位展开/收缩判定测试。
 *
 * 复刻 client.js 里 measureChipWidths / availableForRow / 滞回判定 的语义，
 * 重点验证「窄屏要收起、宽屏要展开」这两个方向都不会卡死。
 */
const COLLAPSE_SLACK = 4
const EXPAND_SLACK = 16

// 模拟：胶囊自然宽度（scrollWidth，不受压缩影响）
const CHIP_WIDTHS = [52, 38, 34, 38] // 默认 / Low / High / Max
const GAP = 4
const NEED = CHIP_WIDTHS.reduce((a, b) => a + b, 0) + (CHIP_WIDTHS.length - 1) * GAP

// 模拟：父容器总宽 - 兄弟（渠道 96 + 模型 96 + 发送按钮 32）- 间距
function haveFor(parentWidth) {
  const siblings = 96 + 96 + 32
  const gaps = 3 * 8
  return Math.max(0, parentWidth - siblings - gaps)
}

function decide(collapsed, need, have) {
  if (!need || !have) return collapsed
  if (!collapsed && need - have > COLLAPSE_SLACK) return true
  if (collapsed && have - need > EXPAND_SLACK) return false
  return collapsed
}

let fail = 0
const check = (name, got, want) => {
  const ok = got === want
  if (!ok) fail++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${got}, want ${want}`}`)
}

console.log(`胶囊需要 ${NEED}px`)
console.log(`父容器 600px 时可拿到 ${haveFor(600)}px`)
console.log(`父容器 300px 时可拿到 ${haveFor(300)}px\n`)

console.log('1. 宽屏 → 展开')
check('父容器 600px 保持展开', decide(false, NEED, haveFor(600)), false)

console.log('2. 窄屏 → 收起')
check('父容器 300px 触发收起', decide(false, NEED, haveFor(300)), true)

console.log('3. 收起后拉宽 → 重新展开')
check('父容器 600px 时展回', decide(true, NEED, haveFor(600)), false)

console.log('4. 展开后又缩窄 → 再收起（来回都能动）')
{
  let c = false
  const trail = []
  for (let w = 600; w >= 250; w -= 10) {
    c = decide(c, NEED, haveFor(w))
    trail.push(w > 420 ? false : c)
  }
  check('缩窄过程中最终收起', c, true)

  const back = []
  let c2 = c
  for (let w = 250; w <= 600; w += 10) {
    c2 = decide(c2, NEED, haveFor(w))
    back.push(c2)
  }
  check('拉宽过程中最终展开', c2, false)
  const switches = back.filter((v, i) => i > 0 && v !== back[i - 1]).length
  check('拉宽过程切换次数 ≤ 1', switches <= 1, true)
}

console.log('5. 临界点抖动被吸收')
{
  const critical = NEED + 96 + 96 + 32 + 24 // 使 have ≈ need
  let c = false
  const trail = []
  for (let i = 0; i < 40; i++) {
    c = decide(c, NEED, haveFor(critical + (i % 2 === 0 ? 3 : -3)))
    trail.push(c)
  }
  const switches = trail.filter((v, i) => i > 0 && v !== trail[i - 1]).length
  check('40 次抖动切换 ≤ 1', switches <= 1, true)
}

if (fail) { console.error(`\n${fail} 项失败`); process.exit(1) }
console.log('\n全部通过')
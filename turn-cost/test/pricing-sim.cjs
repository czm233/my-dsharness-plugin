#!/usr/bin/env node
/**
 * Offline checks for the route-aware price fold.
 *
 * The UI cannot be exercised without the DSH host, but the part that decides
 * which model's rate a turn uses — and whether a mid-session switch is
 * reported — is pure data. Run with: node turn-cost/test/pricing-sim.cjs
 */
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const PEAK_FRIDAY = Date.parse('2026-11-13T02:00:00Z') // 10:00 Beijing, Friday
const PEAK_FRIDAY_EVENING = Date.parse('2026-11-13T12:00:00Z') // 20:00 Beijing, Friday
const SATURDAY = Date.parse('2026-11-14T02:00:00Z') // 10:00 Beijing, Saturday
const SATURDAY_LATE = Date.parse('2026-11-14T15:00:00Z') // 23:00 Beijing, Saturday

function attemptEvent(turn, provider, model, usage, time) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      message: { source: { provider, model } },
      usage: {
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
      },
    },
  }
}

async function main() {
  const pricing = await import('../pricing.js')
  const { foldTurnAttempts } = await import('../index.js')
  const table = pricing.normalizePriceTable(JSON.parse(readFileSync(join(root, 'prices.json'), 'utf8')))

  // Exact, case-insensitive, and dated-id prefix resolution.
  assert.equal(pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4.1-flash').key, 'deepseek-v4.1-flash')
  assert.equal(pricing.matchPrice(table, 'qwen-token-plan-cn', 'DeepSeek-V4.1-Flash').key, 'deepseek-v4.1-flash')
  assert.equal(pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4.1-flash-1017').key, 'deepseek-v4.1-flash')
  assert.equal(pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4-pro').key, 'deepseek-v4-pro')
  assert.equal(pricing.matchPrice(table, 'zai-coding-cn', 'glm-5.3-flash').key, 'glm-5.3-flash')
  assert.equal(pricing.matchPrice(table, 'unknown', 'not-a-model'), undefined)
  // Domestic models price in CNY; foreign models stay in USD.
  assert.equal(pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4.1-flash').entry.currency, '¥')
  assert.equal(pricing.matchPrice(table, 'zai-coding-cn', 'glm-5.3-flash').entry.currency, '¥')
  assert.equal(pricing.matchPrice(table, 'rightcode', 'claude-opus-5-5').entry.currency, '$')
  // Bailian's pay-as-you-go DeepSeek cache is 10% of input; the token-plan
  // route uses the model vendor's official cache price above.
  const bailian = pricing.matchPrice(table, 'aliyunbailian', 'deepseek-v4.1-flash-1017')
  assert.equal(bailian.key, 'deepseek-v4.1-flash')
  assert.equal(bailian.entry.currency, '¥')
  assert.equal(pricing.ratesAt(bailian.entry, PEAK_FRIDAY).cacheRead, 0.2)
  console.log('ok price matching')


  // DeepSeek weekdays only; Bailian every day 08-22.
  const flash = pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4.1-flash').entry
  const pro = pricing.matchPrice(table, 'qwen-token-plan-cn', 'deepseek-v4-pro').entry
  assert.equal(pricing.ratesAt(flash, PEAK_FRIDAY).period, 'peak')
  assert.equal(pricing.ratesAt(flash, SATURDAY_LATE).period, 'offPeak')
  assert.equal(pricing.ratesAt(pro, PEAK_FRIDAY).period, 'peak')
  assert.equal(pricing.ratesAt(pro, PEAK_FRIDAY_EVENING).period, 'offPeak')
  assert.equal(pricing.ratesAt(pro, SATURDAY).period, 'offPeak')
  console.log('ok peak/off-peak schedules')

  // Same token counts, different model => different price.
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
  const flashCost = pricing.priceAttempt(flash, usage, PEAK_FRIDAY, table.currency).total
  const proCost = pricing.priceAttempt(pro, usage, PEAK_FRIDAY, table.currency).total
  assert.ok(proCost > flashCost * 2, `pro ${proCost} should dwarf flash ${flashCost}`)
  assert.equal(flashCost.toFixed(4), '10.0000')
  assert.equal(proCost.toFixed(4), '36.0000')
  assert.equal(pricing.priceAttempt(flash, usage, PEAK_FRIDAY, table.currency).currency, '¥')
  console.log('ok per-model cost')

  // A mid-session model switch is detected and the new turn is priced with the
  // new model's rate, including a cache-miss (no inherited cache discount).
  const switchedEvents = [
    attemptEvent(1, 'qwen-token-plan-cn', 'deepseek-v4.1-flash', { input: 1_000_000 }, PEAK_FRIDAY),
    attemptEvent(2, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 1_000_000 }, PEAK_FRIDAY),
    { type: 'turn/end', time: PEAK_FRIDAY + 1234, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const switched = foldTurnAttempts(switchedEvents, 2, table)
  assert.equal(switched.switched, true)
  assert.equal(switched.previousRoute.model, 'deepseek-v4.1-flash')
  assert.equal(switched.attempts.length, 1)
  // The clock row prints the turn/end time; the elapsed label counts from the
  // same instant, so both always agree. No turn/start in the log => no duration.
  assert.equal(switched.endedAt, PEAK_FRIDAY + 1234)
  assert.equal(switched.startedAt, undefined)
  assert.equal(switched.attempts[0].price.label, 'DeepSeek V4 Pro')
  assert.equal(switched.attempts[0].price.currency, '¥')
  assert.equal(switched.attempts[0].price.rates.input, 9)
  assert.equal(switched.attempts[0].price.cost.input, 9)
  assert.equal(switched.attempts[0].price.cost.cacheRead, 0)
  console.log('ok switch detection + new-model pricing')

  // The fold also carries this turn's own turn/start so the client can print
  // how long the turn ran (end − start), even across earlier turns in between.
  const timed = foldTurnAttempts([
    { type: 'turn/start', time: PEAK_FRIDAY - 60_000, data: { turn: 1 } },
    attemptEvent(1, 'qwen-token-plan-cn', 'deepseek-v4.1-flash', { input: 10 }, PEAK_FRIDAY),
    { type: 'turn/end', time: PEAK_FRIDAY - 30_000, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', time: PEAK_FRIDAY - 5_000, data: { turn: 2 } },
    attemptEvent(2, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 10 }, PEAK_FRIDAY),
    { type: 'turn/end', time: PEAK_FRIDAY + 1234, data: { turn: 2, reason: { kind: 'completed' } } },
  ], 2, table)
  assert.equal(timed.startedAt, PEAK_FRIDAY - 5_000)
  assert.equal(timed.endedAt, PEAK_FRIDAY + 1234)
  console.log('ok turn duration fold (startedAt tracks the queried turn)')

  // Same model across turns stays quiet; a mid-turn route change is flagged.
  const sameEvents = [
    attemptEvent(1, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 10 }, PEAK_FRIDAY),
    attemptEvent(2, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 10 }, PEAK_FRIDAY),
  ]
  assert.equal(foldTurnAttempts(sameEvents, 2, table).switched, false)
  const midTurn = [
    attemptEvent(1, 'qwen-token-plan-cn', 'deepseek-v4.1-flash', { input: 10 }, PEAK_FRIDAY),
    attemptEvent(2, 'qwen-token-plan-cn', 'deepseek-v4.1-flash', { input: 10 }, PEAK_FRIDAY),
    attemptEvent(2, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 10 }, PEAK_FRIDAY),
  ]
  assert.equal(foldTurnAttempts(midTurn, 2, table).routeChanged, true)
  console.log('ok same-model and mid-turn cases')

  // An unlisted model is reported as unpriced rather than charged a made-up rate.
  const unknown = foldTurnAttempts([
    attemptEvent(1, 'someone', 'mystery-model', { input: 1_000_000 }, PEAK_FRIDAY),
  ], 1, table)
  assert.equal(unknown.attempts[0].price.matched, false)
  assert.equal(unknown.attempts[0].price.cost, undefined)
  console.log('ok unpriced model')

  // Cached input uses the cache rate, not the miss rate.
  const cached = foldTurnAttempts([
    attemptEvent(1, 'qwen-token-plan-cn', 'deepseek-v4-pro', { input: 1_000_000, cacheRead: 1_000_000 }, PEAK_FRIDAY),
  ], 1, table)
  assert.equal(cached.attempts[0].price.cost.cacheRead, 0.3)
  assert.equal(cached.attempts[0].price.cost.input, 9)
  console.log('ok cache-read rate')

  // The RPC answer the client half reads: the completion instant must travel
  // under `time` (the field CostTail settles into its state), and the fold must
  // still carry the per-attempt prices.
  const host = await import('../index.js')
  let route
  host.apply({
    get: (name) => (name === 'sessionQuery'
      ? { readSession: async () => ({ events: switchedEvents }) }
      : undefined),
    inject: (_names, fn) => fn({
      effect: (effect) => effect(),
      connection: { fetch: { register: (definition) => { route = definition; return () => {} } } },
    }),
  })
  assert.ok(route, 'host registers the turn-cost rpc route')
  const response = await route.fetch(new Request('http://127.0.0.1/api/turn-cost/rpc', {
    method: 'POST',
    body: JSON.stringify({ rpcId: 'r1', payload: { action: 'usage', sessionId: 'session-test', turn: 2 } }),
  }))
  const answer = await response.json()
  assert.equal(answer.result.ok, true)
  assert.equal(answer.result.value.time, PEAK_FRIDAY + 1234)
  assert.equal(answer.result.value.attempts.length, 1)
  assert.equal(answer.result.value.attempts[0].price.label, 'DeepSeek V4 Pro')
  console.log('ok rpc payload')

  console.log('\nturn-cost pricing-sim: all checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
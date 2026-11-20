/** Host half: prices + per-turn token usage folded from the durable session log, served over one /api route. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { matchPrice, normalizePriceTable, priceAttempt, routeKey } from './pricing.js'

const PRICES_PATH = fileURLToPath(new URL('./prices.json', import.meta.url))

/** Read and normalize prices.json; a broken table leaves routes unpriced instead of inventing a rate. */
function loadPrices() {
  try {
    const raw = JSON.parse(readFileSync(PRICES_PATH, 'utf8'))
    const table = normalizePriceTable(raw)
    if (Object.keys(table.models).length === 0 && Object.keys(table.providers).length === 0) {
      console.error('[turn-cost] prices.json has no usable model entries; turns stay unpriced')
    }
    return table
  } catch (error) {
    console.error('[turn-cost] failed to read prices.json; turns stay unpriced', error)
    return normalizePriceTable({})
  }
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Last usage chunk of a recorded assistant stream, matching the shipped reader. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

function routeOf(message) {
  const source = message?.source
  if (typeof source?.provider === 'string' && source.provider.length > 0
    && typeof source.model === 'string' && source.model.length > 0) {
    return { provider: source.provider, model: source.model }
  }
  return undefined
}

/** Keep one attempt only when its buckets are coherent; totals fall back to the known buckets. */
function normalizeUsage(usage, route) {
  if (usage === undefined || usage === null) return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  const known = inputTokens
    + (isCount(cacheReadTokens) ? cacheReadTokens : 0)
    + (isCount(cacheWriteTokens) ? cacheWriteTokens : 0)
  let total
  if (isCount(totalTokens)) total = totalTokens
  else if (isCount(cacheReadTokens) && isCount(cacheWriteTokens)) total = known + outputTokens
  else return undefined
  return {
    input: inputTokens,
    output: outputTokens,
    total,
    cacheRead: isCount(cacheReadTokens) ? cacheReadTokens : undefined,
    cacheWrite: isCount(cacheWriteTokens) ? cacheWriteTokens : undefined,
    reasoning: isCount(reasoningTokens) && reasoningTokens <= outputTokens ? reasoningTokens : undefined,
    route,
  }
}

/** Attach the exact route's list price and computed cost to one attempt. */
function priceOf(table, route, attempt, at) {
  if (route === undefined) return undefined
  const match = matchPrice(table, route.provider, route.model)
  if (match === undefined) {
    return {
      matched: false,
      provider: route.provider,
      model: route.model,
      currency: table.currency,
    }
  }
  const priced = priceAttempt(match.entry, attempt, at, table.currency)
  return {
    matched: true,
    provider: route.provider,
    model: route.model,
    label: match.entry.label ?? route.model,
    currency: priced.currency,
    period: priced.period,
    rates: priced.rates,
    cost: priced.parts,
    total: priced.total,
  }
}

/** One settled attempt per assistant/message; the client aggregates. Returns fold counts for diagnosis.
 * ESC-interrupted turns carry no usage at all (the upstream request is cancelled before any usage
 * chunk arrives), so interrupted/aborted flags are folded alongside to let the client explain that
 * state instead of presenting it as a folding failure. */
function foldTurnAttempts(events, turn, table) {
  const attempts = []
  let matched = 0
  let interrupted = false
  let aborted = false
  // Completion instant of the turn: the same `turn/end` time the shipped row
  // prints as its clock, so "time since" counts from the displayed minute.
  // `startedAt` is this turn's own `turn/start`, giving the run duration.
  let endedAt
  let startedAt
  let lastStartAt
  let previousRoute
  let firstRoute
  let lastRoute
  let routeChanged = false
  for (const event of events) {
    if (event?.type === 'turn/start') {
      // Events are chronological, so the last start seen before this turn's
      // end is this turn's own start (older logs may lack data.turn).
      const at = Number(event.time)
      if (Number.isFinite(at)) lastStartAt = at
      continue
    }
    if (event?.type === 'turn/end') {
      if (Number(event.data?.turn) === turn) {
        const at = Number(event.time)
        if (Number.isFinite(at)) endedAt = at
        startedAt = lastStartAt
        if (event.data?.reason?.kind === 'aborted') aborted = true
      }
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const data = event.data
    const eventTurn = Number(data?.turn)
    const route = routeOf(data.message)
    if (eventTurn !== turn) {
      if (eventTurn < turn && route !== undefined) previousRoute = route
      continue
    }
    matched += 1
    if (data.interrupted === true) interrupted = true
    if (route !== undefined) {
      if (firstRoute === undefined) firstRoute = route
      else if (routeKey(route) !== routeKey(lastRoute)) routeChanged = true
      lastRoute = route
    }
    const usage = data.usage !== undefined ? data.usage : lastStreamUsage(data.stream)
    const attempt = normalizeUsage(usage, route)
    if (attempt !== undefined) {
      const at = Number(event.time)
      attempts.push({
        ...attempt,
        at: Number.isFinite(at) ? at : undefined,
        price: priceOf(table, route, attempt, at),
      })
    }
  }
  const switched = routeKey(previousRoute) !== undefined
    && routeKey(firstRoute) !== undefined
    && routeKey(previousRoute) !== routeKey(firstRoute)
  return { attempts, matched, interrupted, aborted, previousRoute, switched, routeChanged, endedAt, startedAt }
}

function asRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('payload must be an object')
  }
  return value
}

export function apply(ctx) {
  const prices = loadPrices()

  // Module-level inject stays empty on purpose; services attach here through a
  // child context so a missing connection never stalls the whole fiber.
  ctx.inject(['sessionQuery', 'connection'], (child) => {
    child.effect(() => {
      const dispose = child.connection.fetch.register({
        path: '/api/turn-cost/rpc',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => serve(request),
      })
      return () => { dispose() }
    }, 'turn-cost: rpc route')
  })

  async function usageFor(payload) {
    const record = asRecord(payload)
    const sessionId = String(record.sessionId ?? '')
    const turn = Number(record.turn)
    if (sessionId === '') throw new Error('sessionId is required')
    if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('turn must be a non-negative integer')
    const query = ctx.get('sessionQuery')
    if (query === undefined || query === null || typeof query.readSession !== 'function') {
      throw new Error('sessionQuery.readSession is unavailable')
    }
    const snapshot = await query.readSession(sessionId)
    const events = snapshot?.events ?? []
    const folded = foldTurnAttempts(events, turn, prices)
    return {
      attempts: folded.attempts,
      matched: folded.matched,
      events: events.length,
      interrupted: folded.interrupted,
      aborted: folded.aborted,
      previousRoute: folded.previousRoute,
      switched: folded.switched,
      routeChanged: folded.routeChanged,
      // The clock printed by the shipped row, so the elapsed label counts from
      // exactly the minute the user sees. startedAt feeds the run-duration
      // label next to it.
      time: folded.endedAt,
      startedAt: folded.startedAt,
      currency: prices.currency,
    }
  }

  async function serve(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = body?.rpcId
    const respond = (result) => Response.json({ type: 'server-response', rpcId, result })
    try {
      const payload = asRecord(body?.payload ?? {})
      const action = String(payload.action ?? '')
      let value
      if (action === 'prices') value = { currency: prices.currency }
      else if (action === 'usage') value = await usageFor(payload)
      else throw new Error(`unknown action ${JSON.stringify(action)}`)
      return respond({ ok: true, value })
    } catch (error) {
      return respond({
        ok: false,
        error: { code: 'internal', message: String(error?.message ?? error), details: {} },
      })
    }
  }
}

export { foldTurnAttempts }
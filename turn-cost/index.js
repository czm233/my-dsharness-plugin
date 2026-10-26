/** Host half: prices + per-turn token usage folded from the durable session log, served over one /api route. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** GLM-5.3-Flash international list prices (USD per million tokens) used when prices.json is missing or invalid. */
const DEFAULT_PRICES = {
  currency: '$',
  perMillion: { input: 0.15, cacheRead: 0.03, cacheWrite: 0, output: 0.5 },
}

function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Read and validate prices.json; any problem falls back to the built-in defaults. */
function loadPrices() {
  try {
    const file = fileURLToPath(new URL('./prices.json', import.meta.url))
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const perMillion = raw?.perMillion
    if (typeof raw?.currency !== 'string' || raw.currency.length === 0
      || !isPrice(perMillion?.input) || !isPrice(perMillion?.cacheRead)
      || !isPrice(perMillion?.cacheWrite) || !isPrice(perMillion?.output)) {
      console.error('[turn-cost] prices.json is invalid; using GLM-5.3-Flash list prices')
      return DEFAULT_PRICES
    }
    return raw
  } catch (error) {
    console.error('[turn-cost] failed to read prices.json; using GLM-5.3-Flash list prices', error)
    return DEFAULT_PRICES
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

/** One settled attempt per assistant/message; the client aggregates. Returns fold counts for diagnosis. */
function foldTurnAttempts(events, turn) {
  const attempts = []
  let matched = 0
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const data = event.data
    if (Number(data?.turn) !== turn) continue
    matched += 1
    const usage = data.usage !== undefined ? data.usage : lastStreamUsage(data.stream)
    const attempt = normalizeUsage(usage, routeOf(data.message))
    if (attempt !== undefined) attempts.push(attempt)
  }
  return { attempts, matched }
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
    const folded = foldTurnAttempts(events, turn)
    return { attempts: folded.attempts, matched: folded.matched, events: events.length }
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
      if (action === 'prices') value = prices
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

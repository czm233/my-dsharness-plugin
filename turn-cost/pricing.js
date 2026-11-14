/**
 * Per-model list-price resolution for one turn.
 *
 * Every assistant attempt carries the exact provider/model that produced it, so
 * a turn is priced attempt by attempt instead of with one global rate. That is
 * what makes a mid-session model switch show the new model's price instead of
 * the previous model's price.
 *
 * Price entries are USD per 1M tokens. `input` is the uncached input rate,
 * `cacheRead` the prompt-cache hit rate, `cacheWrite` the cache write rate, and
 * `output` the completion rate. Rates are stored as [off-peak, peak]; models
 * without time-of-day pricing repeat one number in both slots.
 */

/** Beijing peak windows: DeepSeek weekdays 09-12 / 14-18; Bailian 08-22 daily. */
export const PEAK_HOURS = Object.freeze({
  deepseek: 'deepseek',
  bailian: 'bailian',
})

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Normalize one rate into the [off-peak, peak] pair; `undefined` when absent. */
function normalizeRate(value) {
  if (finiteNonNegative(value)) return [value, value]
  if (Array.isArray(value) && value.length > 0) {
    if (value.every(finiteNonNegative)) {
      if (value.length >= 2) return [value[0], value[1]]
      return [value[0], value[0]]
    }
  }
  if (typeof value === 'object' && value !== null) {
    if (finiteNonNegative(value.offPeak) && finiteNonNegative(value.peak)) {
      return [value.offPeak, value.peak]
    }
  }
  return undefined
}

function normalizeEntry(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const input = normalizeRate(raw.input)
  const output = normalizeRate(raw.output)
  if (input === undefined || output === undefined) return undefined
  return {
    label: typeof raw.label === 'string' && raw.label.length > 0
      ? raw.label
      : typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined,
    peak: raw.peak === true,
    hours: raw.hours === PEAK_HOURS.bailian ? PEAK_HOURS.bailian : PEAK_HOURS.deepseek,
    input,
    cacheRead: normalizeRate(raw.cacheRead) ?? input,
    cacheWrite: normalizeRate(raw.cacheWrite) ?? [0, 0],
    output,
  }
}

/**
 * Normalize the on-disk table. The file owns model entries and optional
 * provider-scoped overrides; the returned table is plain JSON-safe data so the
 * same file can be validated in a test without the DSH host.
 */
export function normalizePriceTable(raw) {
  const currency = typeof raw?.currency === 'string' && raw.currency.length > 0 ? raw.currency : '$'
  const models = {}
  const providers = {}
  if (typeof raw === 'object' && raw !== null) {
    for (const [id, value] of Object.entries(raw.models ?? {})) {
      if (typeof id !== 'string' || id.length === 0) continue
      const entry = normalizeEntry(value)
      if (entry !== undefined) models[id.toLowerCase()] = entry
    }
    for (const [providerId, providerValue] of Object.entries(raw.providers ?? {})) {
      if (typeof providerId !== 'string' || providerId.length === 0) continue
      if (typeof providerValue !== 'object' || providerValue === null) continue
      const source = providerValue.models ?? providerValue
      const scoped = {}
      for (const [id, value] of Object.entries(source)) {
        if (typeof id !== 'string' || id.length === 0) continue
        const entry = normalizeEntry(value)
        if (entry !== undefined) scoped[id.toLowerCase()] = entry
      }
      if (Object.keys(scoped).length > 0) providers[providerId.toLowerCase()] = scoped
    }
  }
  return { currency, models, providers }
}

/** Model ids that may appear behind a gateway prefix ("vendor/model"). */
function modelCandidates(model) {
  const id = String(model ?? '').toLowerCase().trim()
  if (id === '') return []
  const parts = id.split('/')
  const last = parts[parts.length - 1]
  return last === id ? [id] : [id, last]
}

function findInBucket(bucket, candidates, source) {
  if (bucket === undefined) return undefined
  for (const id of candidates) {
    if (bucket[id] !== undefined) return { entry: bucket[id], key: id, source }
  }
  let best
  for (const [key, entry] of Object.entries(bucket)) {
    for (const id of candidates) {
      if (id.startsWith(key) && (best === undefined || key.length > best.key.length)) {
        best = { entry, key, source }
      }
    }
  }
  return best
}

/**
 * Resolve the price entry for one route: provider-scoped exact/prefix match
 * first, then the global model table. Prefix matching keeps dated ids such as
 * `deepseek-v4.1-flash-1017` on the base model entry.
 */
export function matchPrice(table, provider, model) {
  const candidates = modelCandidates(model)
  if (candidates.length === 0) return undefined
  const providerKey = String(provider ?? '').toLowerCase().trim()
  const scoped = providerKey === '' ? undefined : table.providers[providerKey]
  return findInBucket(scoped, candidates, 'provider') ?? findInBucket(table.models, candidates, 'model')
}

function beijingParts(at) {
  const date = at instanceof Date ? at : new Date(Number(at))
  const time = Number.isFinite(date.getTime()) ? date.getTime() : Date.now()
  const shifted = new Date(time + 8 * 3600000)
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() }
}

/**
 * Index into the [off-peak, peak] rate pair. DeepSeek uses Beijing weekday
 * 09-12 / 14-18 (holidays are not modeled); Bailian uses 08-22 every day.
 */
export function periodIndex(at, hours) {
  const { weekday, hour } = beijingParts(at)
  if (hours === PEAK_HOURS.bailian) return hour >= 8 && hour < 22 ? 1 : 0
  if (weekday === 0 || weekday === 6) return 0
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 1 : 0
}

/** Resolve the four rates for the attempt's wall-clock time. */
export function ratesAt(entry, at) {
  const index = entry.peak ? periodIndex(at, entry.hours) : 0
  return {
    period: index === 1 ? 'peak' : 'offPeak',
    input: entry.input[index],
    cacheRead: entry.cacheRead[index],
    cacheWrite: entry.cacheWrite[index],
    output: entry.output[index],
  }
}

/**
 * Price one normalized attempt. `usage.input` is uncached input and
 * `usage.cacheRead`/`cacheWrite` are optional. Costs are returned per bucket so
 * the panel can show the same numbers it charges.
 */
export function priceAttempt(entry, usage, at, currency) {
  const rates = ratesAt(entry, at)
  const input = Number(usage?.input ?? 0)
  const output = Number(usage?.output ?? 0)
  const cacheRead = Number(usage?.cacheRead ?? 0)
  const cacheWrite = Number(usage?.cacheWrite ?? 0)
  const parts = {
    input: input * rates.input / 1_000_000,
    cacheRead: cacheRead * rates.cacheRead / 1_000_000,
    cacheWrite: cacheWrite * rates.cacheWrite / 1_000_000,
    output: output * rates.output / 1_000_000,
  }
  return {
    currency,
    rates,
    period: rates.period,
    parts,
    total: parts.input + parts.cacheRead + parts.cacheWrite + parts.output,
  }
}

/** Stable route identity for switch detection (case-insensitive). */
export function routeKey(route) {
  if (typeof route?.provider !== 'string' || route.provider.length === 0) return undefined
  if (typeof route?.model !== 'string' || route.model.length === 0) return undefined
  return `${route.provider.toLowerCase()}\u0000${route.model.toLowerCase()}`
}
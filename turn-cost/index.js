/** Host half: loads the price table and serves it to the browser half over the package RPC. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** GLM-5.3-Flash CN list prices (CNY per million tokens) used when prices.json is missing or invalid. */
const DEFAULT_PRICES = {
  currency: '¥',
  perMillion: { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8 },
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

export function apply() {
  const prices = loadPrices()
  if (typeof harness !== 'undefined' && harness !== null && typeof harness.handle === 'function') {
    harness.handle('turnCost/prices', () => prices)
  } else {
    console.error('[turn-cost] harness seat unavailable; the browser half will use its built-in default prices')
  }
}

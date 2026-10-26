// Browser half of the Turn Cost plugin: derives each completed Turn's token
// usage from the session log through a Conversation node definition, prices it
// with the configured per-million list prices, and renders a money pill IN the
// turn-tail actions row, exactly where the shipped usage pill sits (portaled
// next to it; the shipped pill is hidden by stylesheet while this plugin runs).
// Optional services resolve through ctx.get so a missing channel degrades to
// visible diagnostics instead of a silently pending declared inject.

window.__ModuleLoader__.load({
  id: '@local/turn-cost',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React

    const NS = 'turnCost'
    const LOG = '[turn-cost]'

    const zh = {
      'title': '本轮费用',
      'pillTotal': '≈{cost}',
      'pillTokens': '{tokens} tok',
      'model': '提供方 / 模型',
      'cacheHit': '缓存命中',
      'input': '未缓存输入',
      'cacheRead': '缓存读取',
      'cacheWrite': '缓存写入',
      'output': '输出',
      'reasoning': '（其中推理 {tokens}）',
      'breakdown': '费用明细（按牌价折算）',
      'inputCost': '输入 · 未缓存',
      'cacheReadCost': '缓存读取',
      'cacheWriteCost': '缓存写入',
      'outputCost': '输出',
      'total': '合计',
      'unitPrice': '{price}/M tok',
      'listNote': '按模型牌价折算的等效金额，非实际账单',
    }
    const en = {
      'title': 'Turn cost',
      'pillTotal': '≈{cost}',
      'pillTokens': '{tokens} tok',
      'model': 'Provider / model',
      'cacheHit': 'Cache hit',
      'input': 'Uncached input',
      'cacheRead': 'Cached input',
      'cacheWrite': 'Cache write',
      'output': 'Output',
      'reasoning': ' ({tokens} reasoning)',
      'breakdown': 'Cost breakdown (list price)',
      'inputCost': 'Input · uncached',
      'cacheReadCost': 'Cached input',
      'cacheWriteCost': 'Cache write',
      'outputCost': 'Output',
      'total': 'Total',
      'unitPrice': '{price}/M tok',
      'listNote': 'Estimated at list prices, not an actual bill',
    }

    /** GLM-5.3-Flash CN list prices; replaced by the Host half's prices.json over the package RPC. */
    const DEFAULT_PRICES = {
      currency: '¥',
      perMillion: { input: 0.8, cacheRead: 0.23, cacheWrite: 0, output: 2.8 },
    }

    /** Minimal observable snapshot store: stable snapshot between sets, stable subscribe identity. */
    function createSnapshotStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        set(next) {
          if (next === value) return
          value = next
          for (const fn of [...listeners]) fn()
        },
      }
    }

    const pricesStore = createSnapshotStore(DEFAULT_PRICES)

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

    /**
     * Turn-scoped usage accumulator: one settled attempt per assistant/message,
     * matching the shipped per-turn meter's attempt summation. Publishes no view node.
     */
    const usageDefinition = {
      kind: 'turnCost',
      match: (event) => {
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
        if (event.type === 'assistant/message') return { id: String(event.data.turn), role: 'update' }
        return null
      },
      start: (_context, match) => ({ turn: match.event.data.turn, attempts: [] }),
      update: (context, match) => {
        if (context.state === undefined || match.event.type !== 'assistant/message') return context.state
        const data = match.event.data
        const usage = data.usage !== undefined ? data.usage : lastStreamUsage(data.stream)
        const attempt = normalizeUsage(usage, routeOf(data.message))
        if (attempt === undefined) return context.state
        return { ...context.state, attempts: [...context.state.attempts, attempt] }
      },
      buildLocationData: (context, scope, previous) => {
        if (scope !== 'turn' || context.state === undefined) return null
        if (previous?.kind === 'turn' && previous.key === 'turnCost'
          && previous.value.attempts === context.state.attempts) return previous
        return {
          kind: 'turn',
          turn: context.state.turn,
          key: 'turnCost',
          value: { attempts: context.state.attempts },
        }
      },
    }

    /** Sum attempts into the displayed usage; optional buckets survive only when every attempt reported them. */
    function aggregate(attempts) {
      if (attempts === undefined || attempts.length === 0) return undefined
      let input = 0
      let output = 0
      let total = 0
      let cacheRead = 0
      let cacheWrite = 0
      let reasoning = 0
      let allCacheRead = true
      let allCacheWrite = true
      let allReasoning = true
      const routes = []
      let allRoutes = true
      for (const attempt of attempts) {
        input += attempt.input
        output += attempt.output
        total += attempt.total
        if (attempt.cacheRead === undefined) allCacheRead = false
        else cacheRead += attempt.cacheRead
        if (attempt.cacheWrite === undefined) allCacheWrite = false
        else cacheWrite += attempt.cacheWrite
        if (attempt.reasoning === undefined) allReasoning = false
        else reasoning += attempt.reasoning
        if (attempt.route === undefined) allRoutes = false
        else if (!routes.some(r => r.provider === attempt.route.provider && r.model === attempt.route.model)) {
          routes.push(attempt.route)
        }
      }
      return {
        uncachedInputTokens: input,
        outputTokens: output,
        totalTokens: total,
        cacheReadTokens: allCacheRead ? cacheRead : undefined,
        cacheWriteTokens: allCacheWrite ? cacheWrite : undefined,
        reasoningTokens: allReasoning ? reasoning : undefined,
        routes: allRoutes ? routes : undefined,
      }
    }

    function formatCompactTokens(value) {
      if (value < 1000) return String(value)
      const scale = candidate => candidate >= 100
        ? String(Math.round(candidate))
        : String(Math.round(candidate * 10) / 10)
      if (value < 1_000_000) return `${scale(value / 1000)}K`
      return `${scale(value / 1_000_000)}M`
    }

    function formatExactTokens(value) {
      return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function formatMoney(value, currency) {
      const abs = Math.abs(value)
      const text = abs >= 1 ? value.toFixed(2) : abs >= 0.01 ? value.toFixed(3) : value.toFixed(4)
      return `${currency}${text}`
    }

    function formatPrice(value, currency) {
      return `${currency}${Number(value.toFixed(4))}`
    }

    const IconCoin = () => h('svg', {
      viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true,
    },
      h('ellipse', { cx: 8, cy: 3.9, rx: 6, ry: 2.6, stroke: 'currentColor' }),
      h('path', { d: 'M2 3.9V12c0 1.45 2.68 2.6 6 2.6s6-1.15 6-2.6V3.9', stroke: 'currentColor' }),
      h('path', { d: 'M2 8c0 1.44 2.68 2.6 6 2.6S14 9.44 14 8', stroke: 'currentColor' }),
    )

    const CSS = [
      // The shipped usage pill yields its seat to this plugin's pill.
      '[data-turn-tail] button[aria-haspopup=\'dialog\']:not([data-turn-cost-trigger]) { display: none !important; }',
      '.dsh-turn-cost-slot { display: inline-flex; align-items: center; min-width: 0; }',
      '.dsh-turn-cost-row { display: flex; justify-content: flex-end; align-items: center; height: calc(28px + var(--dsh-content-font-delta, 0px)); }',
      '.dsh-turn-cost { display: inline-flex; min-width: 0; position: relative; }',
      '.dsh-turn-cost-trigger { display: inline-flex; align-items: center; gap: 4px; min-width: 0; height: calc(28px + var(--dsh-content-font-delta, 0px)); padding: 6px 8px; border: none; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-tertiary); font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); font-variant-numeric: tabular-nums; line-height: calc(24px + var(--dsh-content-font-delta, 0px)); white-space: nowrap; cursor: pointer; }',
      '.dsh-turn-cost-trigger svg { width: calc(15px + var(--dsh-content-font-delta, 0px)); height: calc(15px + var(--dsh-content-font-delta, 0px)); flex: none; }',
      '.dsh-turn-cost-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
      '.dsh-turn-cost-sub { opacity: 0.7; }',
      '.dsh-turn-cost-trigger:hover, .dsh-turn-cost-trigger[aria-expanded=\'true\'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
      '.dsh-turn-cost-probe { opacity: 0.55; cursor: help; }',
      '.dsh-turn-cost-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: max-content; min-width: min(300px, calc(100vw - 24px)); max-width: min(440px, calc(100vw - 24px)); padding: 16px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: default; }',
      '.dsh-turn-cost-title { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 8px; color: var(--dsw-alias-label-primary); font-weight: 500; }',
      '.dsh-turn-cost-title-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }',
      '.dsh-turn-cost-title-label svg { width: 14px; height: 14px; flex: none; }',
      '.dsh-turn-cost-title-value { font-variant-numeric: tabular-nums; }',
      '.dsh-turn-cost-rule { margin-bottom: 10px; border-top: 0.5px solid var(--dsw-alias-border-l2); }',
      '.dsh-turn-cost-details { display: grid; grid-template-columns: minmax(96px, auto) minmax(0, 1fr); gap: 6px 16px; margin: 0; color: var(--dsw-alias-label-tertiary); }',
      '.dsh-turn-cost-details dt, .dsh-turn-cost-details dd { min-width: 0; margin: 0; }',
      '.dsh-turn-cost-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }',
      '.dsh-turn-cost-route { overflow-wrap: anywhere; }',
      '.dsh-turn-cost-reasoning { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }',
      '.dsh-turn-cost-breakdown { margin: 2px 0 8px; color: var(--dsw-alias-label-primary); font-weight: 500; }',
      '.dsh-turn-cost-total dd { font-weight: 600; }',
      '.dsh-turn-cost-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
    ].join('\n')

    function detailRow(term, value, extraClass) {
      return [
        h('dt', { key: 'dt' }, term),
        h('dd', { key: 'dd', ...(extraClass === undefined ? {} : { className: extraClass }) }, value),
      ]
    }

    function CostPanel(props) {
      const { usage, parts, total, routes, hitText, prices, t, panelRef, pos } = props
      const currency = prices.currency
      const perMillion = prices.perMillion
      const detailRows = [
        ...(routes !== '' ? detailRow(t('model'), routes, 'dsh-turn-cost-route') : []),
        ...(hitText !== null ? detailRow(t('cacheHit'), `${hitText}%`) : []),
        ...detailRow(t('input'), `${formatExactTokens(usage.uncachedInputTokens)} tok`),
        ...(usage.cacheReadTokens !== undefined
          ? detailRow(t('cacheRead'), `${formatExactTokens(usage.cacheReadTokens)} tok`) : []),
        ...(usage.cacheWriteTokens !== undefined
          ? detailRow(t('cacheWrite'), `${formatExactTokens(usage.cacheWriteTokens)} tok`) : []),
        ...detailRow(
          t('output'),
          [
            `${formatExactTokens(usage.outputTokens)} tok`,
            ...(usage.reasoningTokens !== undefined
              ? [h('span', { key: 'r', className: 'dsh-turn-cost-reasoning' },
                t('reasoning', { tokens: `${formatExactTokens(usage.reasoningTokens)} tok` }))]
              : []),
          ],
        ),
      ]
      const costRows = [
        ...detailRow(
          t('inputCost'),
          `${formatMoney(parts.input, currency)} · ${t('unitPrice', { price: formatPrice(perMillion.input, currency) })}`,
        ),
        ...(usage.cacheReadTokens !== undefined
          ? detailRow(
            t('cacheReadCost'),
            `${formatMoney(parts.cacheRead, currency)} · ${t('unitPrice', { price: formatPrice(perMillion.cacheRead, currency) })}`,
          ) : []),
        ...(usage.cacheWriteTokens !== undefined
          ? detailRow(
            t('cacheWriteCost'),
            `${formatMoney(parts.cacheWrite, currency)} · ${t('unitPrice', { price: formatPrice(perMillion.cacheWrite, currency) })}`,
          ) : []),
        ...detailRow(
          t('outputCost'),
          `${formatMoney(parts.output, currency)} · ${t('unitPrice', { price: formatPrice(perMillion.output, currency) })}`,
        ),
        ...detailRow(t('total'), t('pillTotal', { cost: formatMoney(total, currency) }), 'dsh-turn-cost-total'),
      ]
      return h('div', {
        ref: panelRef,
        className: 'dsh-turn-cost-panel',
        role: 'dialog',
        'aria-label': t('title'),
        style: pos ?? { visibility: 'hidden', left: 0, top: 0 },
      },
        h('div', { className: 'dsh-turn-cost-title' },
          h('span', { className: 'dsh-turn-cost-title-label' }, h(IconCoin), t('title')),
          h('span', { className: 'dsh-turn-cost-title-value' },
            t('pillTotal', { cost: formatMoney(total, currency) })),
        ),
        h('div', { className: 'dsh-turn-cost-rule', 'aria-hidden': true }),
        h('dl', { className: 'dsh-turn-cost-details' }, detailRows),
        h('div', { className: 'dsh-turn-cost-rule', 'aria-hidden': true }),
        h('div', { className: 'dsh-turn-cost-breakdown' }, t('breakdown')),
        h('dl', { className: 'dsh-turn-cost-details' }, costRows),
        h('div', { className: 'dsh-turn-cost-note' }, t('listNote')),
      )
    }

    function CostPill(props) {
      const { usage, prices, t, diagnostic } = props
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const [pos, setPos] = useState(null)

      useLayoutEffect(() => {
        if (!open) {
          setPos(null)
          return
        }
        const root = rootRef.current
        const panel = panelRef.current
        if (root === null || panel === null) return
        const rect = root.getBoundingClientRect()
        const margin = 12
        const gap = 8
        const width = panel.offsetWidth
        const height = panel.offsetHeight
        let left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - margin - width)
        let top = rect.top - gap - height
        if (top < margin) top = Math.min(rect.bottom + gap, window.innerHeight - margin - height)
        setPos({ left: `${left}px`, top: `${top}px` })
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onClick = (event) => {
          const root = rootRef.current
          const panel = panelRef.current
          if (event.target instanceof Node
            && root?.contains(event.target) !== true
            && panel?.contains(event.target) !== true) {
            setOpen(false)
          }
        }
        document.addEventListener('keydown', onKeyDown)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          document.removeEventListener('click', onClick, true)
        }
      }, [open])

      const label = diagnostic === true
        ? '¥?'
        : t('pillTotal', { cost: formatMoney(props.total, prices.currency) })
      const title = diagnostic === true
        ? props.diagnosticText
        : t('listNote')

      return h('span', { className: 'dsh-turn-cost', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'dsh-turn-cost-trigger' + (diagnostic === true ? ' dsh-turn-cost-probe' : ''),
          'data-turn-cost-trigger': '',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title,
          onClick: () => { if (diagnostic !== true) setOpen(!open) },
        },
          h(IconCoin),
          h('span', { className: 'dsh-turn-cost-label' }, label),
          diagnostic !== true
            ? h('span', { className: 'dsh-turn-cost-sub' },
              t('pillTokens', { tokens: formatCompactTokens(usage.totalTokens) }))
            : null,
        ),
        open && createPortal(
          h(CostPanel, { usage, parts: props.parts, total: props.total, routes: props.routes, hitText: props.hitText, prices, t, panelRef, pos }),
          document.body,
        ),
      )
    }

    function CostTail(props) {
      const { owner, t } = props
      const prices = props.usePrices(value => value)
      const entry = owner?.turn?.data instanceof Map ? owner.turn.data.get('turnCost') : undefined
      const usage = useMemo(() => aggregate(entry?.attempts), [entry])

      const parts = useMemo(() => {
        if (usage === undefined) return undefined
        const perMillion = prices.perMillion
        return {
          input: usage.uncachedInputTokens * perMillion.input / 1_000_000,
          cacheRead: (usage.cacheReadTokens ?? 0) * perMillion.cacheRead / 1_000_000,
          cacheWrite: (usage.cacheWriteTokens ?? 0) * perMillion.cacheWrite / 1_000_000,
          output: usage.outputTokens * perMillion.output / 1_000_000,
        }
      }, [usage, prices])
      const total = usage === undefined ? 0
        : parts.input + parts.cacheRead + parts.cacheWrite + parts.output
      let hitText = null
      if (usage !== undefined && usage.cacheReadTokens !== undefined) {
        const prompt = usage.totalTokens - usage.outputTokens
        if (prompt > 0) {
          hitText = (usage.cacheReadTokens / prompt * 100).toFixed(1)
          if (hitText === '100.0' && usage.uncachedInputTokens > 0) hitText = '99.9'
        }
      }
      const routes = usage?.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''

      let diagnostic = false
      let diagnosticText = ''
      if (usage === undefined) {
        diagnostic = true
        const keys = owner?.turn?.data instanceof Map ? Array.from(owner.turn.data.keys()).join(',') : 'no-map'
        diagnosticText = LOG + ' uiConv:' + (diag.uiConversation ? 'ok' : 'MISSING')
          + ' def:' + (diag.definition ? 'ok' : 'NO')
          + ' data:[' + keys + ']'
        console.log(LOG, 'tail without usage:', diagnosticText)
      }

      // Inline seat: portal the pill next to the shipped usage pill inside the
      // actions row; without that anchor, fall back to a dedicated row.
      const anchorRef = useRef(null)
      const [slot, setSlot] = useState(null)
      useLayoutEffect(() => {
        const cell = anchorRef.current?.closest('[data-turn-tail]')
        const shipped = cell?.querySelector('button[aria-haspopup=\'dialog\']:not([data-turn-cost-trigger])')
        if (shipped === undefined || shipped === null || shipped.parentElement === null) {
          setSlot('fallback')
          return undefined
        }
        const span = document.createElement('span')
        span.className = 'dsh-turn-cost-slot'
        shipped.parentElement.insertBefore(span, shipped)
        setSlot(span)
        return () => { span.remove() }
      }, [entry])

      const body = h(CostPill, {
        usage, prices, t, diagnostic, diagnosticText, parts, total, routes, hitText,
      })
      if (slot === 'fallback') {
        return h('div', { ref: anchorRef, className: 'dsh-turn-cost-row', 'data-turn-cost-row': '' }, body)
      }
      return h('span', { ref: anchorRef, 'data-turn-cost-row': '' },
        slot !== null && slot !== 'fallback' ? createPortal(body, slot) : null)
    }

    const diag = { uiConversation: false, definition: false, rpc: false }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        console.log(LOG, 'apply (v3, inline seat)')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-cost: dictionaries')

        const styleElement = document.createElement('style')
        styleElement.dataset.plugin = '@local/turn-cost'
        styleElement.textContent = CSS
        document.head.appendChild(styleElement)
        ctx.effect(() => styleElement.remove(), 'turn-cost: stylesheet')

        const uiConversation = ctx.get('uiConversation')
        diag.uiConversation = uiConversation !== undefined && uiConversation !== null
        console.log(LOG, 'ctx.get(uiConversation) ->', diag.uiConversation ? 'present' : 'MISSING')
        if (diag.uiConversation) {
          try {
            uiConversation.events.register(usageDefinition)
            diag.definition = true
            console.log(LOG, 'usage definition registered')
          } catch (error) {
            console.error(LOG, 'definition registration failed', error)
          }
        } else {
          console.error(LOG, 'uiConversation service unavailable; usage fold cannot register')
        }

        try {
          if (typeof host !== 'undefined' && host !== null && typeof host.call === 'function') {
            host.call('turnCost/prices').then((next) => {
              diag.rpc = true
              console.log(LOG, 'prices from host:', JSON.stringify(next))
              if (next !== null && typeof next === 'object'
                && typeof next.currency === 'string' && next.currency.length > 0
                && next.perMillion !== null && typeof next.perMillion === 'object') {
                pricesStore.set(next)
              }
            }).catch((error) => { console.error(LOG, 'prices RPC failed; defaults stay', error) })
          } else {
            console.error(LOG, 'host seat unavailable; defaults stay')
          }
        } catch (error) {
          console.error(LOG, 'host.call threw synchronously', error)
        }

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: '@local/turn-cost',
          order: 90,
          locale: NS,
          inject: () => ({ hooks: { prices: pricesStore } }),
        }, CostTail))
        console.log(LOG, 'tail slot registered', JSON.stringify(diag))
      },
    }
  },
})

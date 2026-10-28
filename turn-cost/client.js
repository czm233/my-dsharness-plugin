// Browser half of the Turn Cost plugin: renders a money pill immediately LEFT
// of the shipped usage pill in the turn-tail actions row (portaled next to it;
// the shipped pill and every native affordance stay untouched). Per-turn token
// usage is folded on the HOST half from the durable session log and fetched
// through the bundle RPC route (/api/turn-cost/rpc), so no client-side
// conversation service dependency exists.

window.__ModuleLoader__.load({
  id: '@local/turn-cost',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useRef, useEffect, useLayoutEffect, useMemo } = React

    const NS = 'turnCost'
    const LOG = '[turn-cost]'
    const RPC_CHANNEL = '/api'
    // Carrier joins `<channel>/<method>`; the host route path stays /api/turn-cost/rpc.
    const RPC_METHOD = 'turn-cost/rpc'

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
      'inputCost': '未缓存输入',
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
      'inputCost': 'Uncached input',
      'cacheReadCost': 'Cached input',
      'cacheWriteCost': 'Cache write',
      'outputCost': 'Output',
      'total': 'Total',
      'unitPrice': '{price}/M tok',
      'listNote': 'Estimated at list prices, not an actual bill',
    }

    /** GLM-5.3-Flash CN list prices; replaced by the Host half's prices.json over the RPC route. */
    const DEFAULT_PRICES = {
      currency: '$',
      perMillion: { input: 0.15, cacheRead: 0.03, cacheWrite: 0, output: 0.5 },
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

    const ICON_SIZE = 'calc(15px + var(--dsh-content-font-delta, 0px))'
    /** Dollar-coin glyph (candidate 2): outline circle with a $ mark. */
    const IconCoin = () => h('svg', {
      viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true,
      style: { width: ICON_SIZE, height: ICON_SIZE, flex: 'none', display: 'block' },
      stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      h('circle', { cx: 8, cy: 8, r: 6.4 }),
      h('path', { d: 'M9.9 5.9c-.3-.8-1-1.2-1.9-1.2-1.1 0-1.9.5-1.9 1.4 0 1.9 3.9 1.2 3.9 3.2 0 .9-.8 1.5-2 1.5-1 0-1.7-.4-2-1.2' }),
      h('path', { d: 'M8 3.9v8.2' }),
    )

    /** Non-critical chrome (hover, dialog surface); pill base styles are inline. */
    const CSS = [
      '.dsh-turn-cost-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }',
      '.dsh-turn-cost-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: max-content; min-width: min(300px, calc(100vw - 24px)); max-width: min(440px, calc(100vw - 24px)); padding: 16px; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-specific-menu, #1d1f23); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.35)); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: default; }',
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
      '.dsh-turn-cost-total-line { display: flex; justify-content: space-between; gap: 16px; margin: 0 0 8px; color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }',
      '.dsh-turn-cost-note { margin-top: 10px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }',
    ].join('\n')

    const PILL_STYLE = {
      display: 'inline-flex',
      flex: 'none',
      alignItems: 'center',
      gap: 4,
      height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
      padding: '6px 8px',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    }

    function detailRow(term, value, extraClass) {
      return [
        h('dt', { key: 'dt' }, term),
        h('dd', { key: 'dd', ...(extraClass === undefined ? {} : { className: extraClass }) }, value),
      ]
    }

    function CostPanel(props) {
      // Cost-only panel: token details live in the shipped usage dialog, so
      // this panel skips them and shows just the priced breakdown.
      const { usage, parts, total, prices, t, panelRef, pos } = props
      const currency = prices.currency
      const perMillion = prices.perMillion
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
        h('div', { className: 'dsh-turn-cost-breakdown' }, t('breakdown')),
        h('div', { className: 'dsh-turn-cost-total-line' },
          h('span', null, t('total')),
          h('span', null, t('pillTotal', { cost: formatMoney(total, currency) })),
        ),
        h('dl', { className: 'dsh-turn-cost-details' }, costRows),
      )
    }

    function CostPill(props) {
      const { usage, prices, t, mode, errorText, probeLabel, probeTitle, probeLines } = props
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
        // Open below the trigger; flip above when there is no room.
        let top = rect.bottom + gap
        if (top + height > window.innerHeight - margin) top = rect.top - gap - height
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

      const label = mode === 'ok'
        ? t('pillTotal', { cost: formatMoney(props.total, prices.currency) })
        : mode === 'loading' ? '¥…' : mode === 'error' ? '¥?·失败' : (probeLabel ?? '¥?·诊断')
      const clickable = mode === 'ok' || mode === 'probe'

      return h('span', { className: 'dsh-turn-cost', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'dsh-turn-cost-trigger',
          style: mode !== 'ok' ? { ...PILL_STYLE, opacity: 0.75, cursor: 'pointer' } : PILL_STYLE,
          'data-turn-cost-trigger': '',
          'aria-haspopup': mode === 'ok' ? 'dialog' : undefined,
          'aria-expanded': open,
          title: mode === 'probe' ? probeTitle : mode === 'error' ? `${LOG} ${errorText}` : t('listNote'),
          onClick: () => { if (clickable) setOpen(!open) },
        },
          h(IconCoin),
          h('span', {
            style: mode === 'probe'
              ? { whiteSpace: 'nowrap' }
              : { overflow: 'hidden', textOverflow: 'ellipsis' },
          }, label),
        ),
        open && mode === 'ok' && createPortal(
          h(CostPanel, { usage, parts: props.parts, total: props.total, prices, t, panelRef, pos }),
          document.body,
        ),
        open && mode === 'probe' && createPortal(
          h('div', {
            className: 'dsh-turn-cost-panel',
            role: 'status',
            style: pos ?? { visibility: 'hidden', left: 0, top: 0 },
            ref: panelRef,
          },
            h('div', { className: 'dsh-turn-cost-title' },
              h('span', { className: 'dsh-turn-cost-title-label' }, h(IconCoin), '诊断'),
              h('span', { className: 'dsh-turn-cost-title-value' }, '¥?'),
            ),
            h('div', { className: 'dsh-turn-cost-rule', 'aria-hidden': true }),
            ...(Array.isArray(probeLines) ? probeLines : []).map((line, index) => h('div', {
              key: index,
              style: { fontSize: 11, lineHeight: '17px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, line)),
          ),
          document.body,
        ),
      )
    }

    function CostTail(props) {
      const { turn: turnLocation, t, sessionId, callUsage } = props
      const prices = props.usePrices(value => value)
      // Tail owner fields are flattened onto props: props.turn is the TurnLocation.
      const turnNo = typeof turnLocation?.turn === 'number' ? turnLocation.turn : undefined
      const status = turnLocation?.status

      const [state, setState] = useState({ kind: 'loading' })
      useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || turnNo === undefined) {
          setState({ kind: 'idle' })
          return undefined
        }
        let cancelled = false
        setState({ kind: 'loading' })
        callUsage(sessionId, turnNo).then(
          (value) => {
            if (!cancelled) setState({
              kind: 'done',
              attempts: Array.isArray(value?.attempts) ? value.attempts : [],
              events: Number(value?.events ?? -1),
              matched: Number(value?.matched ?? -1),
              // ESC-interrupted turns record no usage anywhere in the session
              // log, so that state gets its own explanation, not the generic
              // "no usage" failure probe.
              interrupted: value?.interrupted === true || value?.aborted === true,
            })
          },
          (error) => {
            if (!cancelled) {
              const message = String(error?.message ?? error)
              console.error(LOG, 'usage rpc failed:', message)
              setState({ kind: 'error', message })
            }
          },
        )
        return () => { cancelled = true }
      }, [sessionId, turnNo, status, callUsage])

      const usage = useMemo(
        () => state.kind === 'done' ? aggregate(state.attempts) : undefined,
        [state],
      )

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

      // Every state stays visible on the pill itself, so one screenshot is a
      // full diagnosis; nothing is ever silently hidden.
      let body
      if (usage !== undefined) {
        body = h(CostPill, { usage, prices, t, mode: 'ok', parts, total })
      } else {
        let label
        const lines = [
          `sessionId: ${sessionId ?? '无'}`,
          `turnNo: ${turnNo ?? '无'}`,
          `turn.status: ${status ?? '无'}`,
        ]
        if (state.kind === 'idle') {
          label = '¥?·无坐标'
          lines.unshift('状态: 无坐标')
        } else if (state.kind === 'loading') {
          label = '¥…'
          lines.unshift('状态: 正在请求 Host…')
        } else if (state.kind === 'error') {
          label = '¥?·失败'
          lines.unshift(`状态: 请求失败 · ${state.message}`)
        } else if (state.interrupted && state.attempts.length === 0) {
          // Interrupted before any settled usage: the platform log genuinely
          // has no token counts for this turn, so say that instead of posing
          // it as a folding failure.
          label = '¥—·中断无计费'
          lines.unshift('状态: 本轮被中断(ESC),上游未返回 usage')
          lines.push('平台日志没有这轮的 token 数,无法折算金额')
          lines.push(`事件总数: ${state.events}`)
          lines.push(`命中 assistant/message: ${state.matched}`)
        } else {
          label = '¥?·无用量'
          lines.unshift('状态: 完成但未折叠到用量')
          lines.push(`事件总数: ${state.events}`)
          lines.push(`命中 assistant/message: ${state.matched}`)
          lines.push(`attempts: ${state.attempts.length}`)
        }
        body = h(CostPill, { prices, t, mode: 'probe', probeLabel: label, probeLines: lines })
      }

      // Inline seat: portal the pill immediately left of the shipped usage pill
      // inside the actions row. The tail DOM can be rebuilt at any moment (ESC
      // mid-turn, status flips, virtualized re-renders), so keep re-anchoring
      // via a MutationObserver instead of inserting the seat exactly once.
      const anchorRef = useRef(null)
      const [slot, setSlot] = useState(null)
      useLayoutEffect(() => {
        const seat = document.createElement('span')
        seat.dataset.turnCostSeat = ''
        seat.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:0;flex:0 0 auto;height:calc(28px + var(--dsh-content-font-delta, 0px));vertical-align:middle;'
        let settled = false
        const attach = () => {
          const cell = anchorRef.current?.closest('[data-turn-tail]') ?? null
          const shipped = cell?.querySelector('button[aria-haspopup=\'dialog\']:not([data-turn-cost-trigger])')
          if (shipped && shipped.parentElement) {
            // Re-insert whenever the seat is no longer exactly in position;
            // identical re-inserts are cheap no-ops for the browser.
            if (seat.parentElement !== shipped.parentElement || seat.nextElementSibling !== shipped) {
              shipped.parentElement.insertBefore(seat, shipped)
            }
            setSlot(prev => (prev === seat ? prev : seat))
            settled = true
          } else {
            setSlot(prev => (prev === 'fallback' ? prev : 'fallback'))
          }
        }
        attach()
        const observer = new MutationObserver(attach)
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          seat.remove()
        }
      }, [])

      if (slot === 'fallback') {
        return h('div', {
          ref: anchorRef,
          style: {
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
            height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
          },
          'data-turn-cost-row': '',
        }, body)
      }
      return h('span', { ref: anchorRef, 'data-turn-cost-row': '' },
        slot !== null && slot !== 'fallback' ? createPortal(body, slot) : null)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        console.log(LOG, 'apply (v7, interrupted-turn state)')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-cost: dictionaries')

        ctx.effect(() => {
          const styleElement = document.createElement('style')
          styleElement.dataset.plugin = '@local/turn-cost'
          styleElement.textContent = CSS
          document.head.appendChild(styleElement)
          return () => { styleElement.remove() }
        }, 'turn-cost: stylesheet')

        /** One shaped RPC call through the client connection carrier. */
        async function callRpc(action, args) {
          const service = ctx.get('connection')
          if (service === undefined || service === null || typeof service.rpc?.call !== 'function') {
            throw new Error('connection service is unavailable')
          }
          const result = await service.rpc.call(RPC_CHANNEL, RPC_METHOD, { action, ...args })
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            throw new Error(String(result?.error?.message ?? 'rpc returned no payload'))
          }
          return result.value
        }

        callRpc('prices', {}).then((next) => {
          if (next !== null && typeof next === 'object'
            && typeof next.currency === 'string' && next.currency.length > 0
            && next.perMillion !== null && typeof next.perMillion === 'object') {
            pricesStore.set(next)
          }
        }).catch((error) => { console.error(LOG, 'prices rpc failed; defaults stay', error) })

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: '@local/turn-cost',
          order: 90,
          locale: NS,
          inject: () => ({
            hooks: { prices: pricesStore },
            callUsage: (sessionId, turn) => callRpc('usage', { sessionId: String(sessionId), turn }),
          }),
        }, CostTail))
        console.log(LOG, 'tail slot registered')
      },
    }
  },
})

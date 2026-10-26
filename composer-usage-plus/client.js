window.__ModuleLoader__.load({
  id: '@local/composer-usage-plus',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const NS = 'composerUsagePlus';
    const SLOT = 'conversation.composer.dock';
    const STYLE_ID = '@local/composer-usage-plus/usage.css';
    const CURRENCY_SYMBOLS = { cny: '¥', usd: '$' };

    /**
     * Per-model list prices in currency units per 1M tokens.
     * Each bucket is [offPeak, peak]; models without time-of-day pricing repeat
     * one price. Peak hours (DeepSeek only) are 09:00-12:00 and 14:00-18:00
     * Beijing time, Monday to Friday.
     * Sources: DeepSeek API Docs "Models & Pricing", z.ai "Pricing" (2026-10).
     */
    const PRICING = {
      'deepseek-flash': {
        peak: true,
        cny: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
        usd: { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
      },
      'deepseek-v4-pro': {
        peak: true,
        cny: { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
        usd: { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] },
      },
      'glm-5.3-flash': { peak: false, usd: { hit: [0.03, 0.03], miss: [0.15, 0.15], out: [0.5, 0.5] } },
      'glm-5.3-flashx': { peak: false, usd: { hit: [0.075, 0.075], miss: [0.37, 0.37], out: [1.25, 1.25] } },
      'glm-5.3': { peak: false, usd: { hit: [0.26, 0.26], miss: [1.4, 1.4], out: [4.4, 4.4] } },
      'glm-5.2': { peak: false, usd: { hit: [0.26, 0.26], miss: [1.4, 1.4], out: [4.4, 4.4] } },
      'glm-5.1': { peak: false, usd: { hit: [0.26, 0.26], miss: [1.4, 1.4], out: [4.4, 4.4] } },
      'glm-5': { peak: false, usd: { hit: [0.2, 0.2], miss: [1, 1], out: [3.2, 3.2] } },
      'glm-4.7': { peak: false, usd: { hit: [0.11, 0.11], miss: [0.6, 0.6], out: [2.2, 2.2] } },
      'glm-4.6': { peak: false, usd: { hit: [0.11, 0.11], miss: [0.6, 0.6], out: [2.2, 2.2] } },
    };

    /** Subscription gateways whose plans cover token usage without per-token billing. */
    const PLAN_PROVIDERS = ['zai-coding', 'coding-plan'];

    /** Exact id first, then the longest id the model name starts with. */
    function matchPricing(modelId) {
      const model = typeof modelId === 'string' ? modelId.toLowerCase() : '';
      if (model === '') return undefined;
      if (PRICING[model]) return PRICING[model];
      let best;
      Object.keys(PRICING).forEach(function (key) {
        if (model.indexOf(key) === 0 && (best === undefined || key.length > best.length)) best = key;
      });
      return best === undefined ? undefined : PRICING[best];
    }

    function isPlanProvider(providerId) {
      const provider = typeof providerId === 'string' ? providerId.toLowerCase() : '';
      return PLAN_PROVIDERS.some(function (key) {
        return provider.indexOf(key) >= 0;
      });
    }

    const CSS = [
      // Pill — same metrics as the shipped composer stats pills.
      // margin-left:auto pushes the block to the far right of the dock row.
      '.cudP_anchor{min-width:0;display:inline-flex;margin-left:auto;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.cudP_pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:1px 8px;',
      'border-radius:var(--dsw-radius-sm,6px);max-width:100%;',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));',
      'font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;',
      'white-space:nowrap;background:0 0;border:none;cursor:pointer;transition:background-color .1s,color .1s}',
      'button.cudP_pill:hover,.cudP_pill[aria-expanded=true]{',
      'background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));',
      'color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}',
      '.cudP_icon{flex:none;display:inline-flex}',
      '.cudP_icon svg{width:14px;height:14px}',
      '.cudP_label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      // Dialog — copied look of the shipped stats dialog.
      '.cudP_panel{z-index:1100;box-sizing:border-box;position:fixed;border:0;padding:16px;',
      'border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-overlay));',
      'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.25));',
      'color:var(--dsw-alias-label-secondary);cursor:default;font-size:12px;line-height:18px;',
      'width:max-content;min-width:min(320px,calc(100vw - 24px));max-width:min(480px,calc(100vw - 24px))}',
      '.cudP_title{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;',
      'font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.cudP_titleLabel{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.cudP_titleValue{font-variant-numeric:tabular-nums}',
      '.cudP_rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
      // Breakdown table.
      '.cudP_table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
      '.cudP_table th{color:var(--dsw-alias-label-tertiary);font-weight:400;text-align:left;',
      'padding:2px 0;white-space:nowrap}',
      '.cudP_table td{color:var(--dsw-alias-label-secondary);padding:3px 0;vertical-align:top;text-align:left}',
      '.cudP_table th+th,.cudP_table td+td{text-align:right;padding-left:16px;white-space:nowrap}',
      '.cudP_mutedCell{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.cudP_totalRow td{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:6px;',
      'color:var(--dsw-alias-label-primary)}',
      '.cudP_notes{margin:10px 0 0;padding:0;color:var(--dsw-alias-label-tertiary);display:grid;gap:2px;',
      'list-style:none}',
      '.cudP_quota{margin:0 0 12px;display:grid;gap:6px}',
      '.cudP_quotaRow{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:2px 10px;align-items:center}',
      '.cudP_quotaLabel{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis}',
      '.cudP_track{display:block;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.cudP_fill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}',
      '.cudP_quotaValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;',
      'text-align:right;white-space:nowrap}',
      '.cudP_quotaError{margin:0 0 10px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
    ].join('');

    /** Coin icon, drawn inline so the plugin needs no other client package. */
    const ICON = h(
      'span',
      { className: 'cudP_icon', 'aria-hidden': true },
      h(
        'svg',
        {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('circle', { cx: 8, cy: 8, r: 6.4 }),
        h('path', { d: 'M5.7 5.4 8 8l2.3-2.6' }),
        h('path', { d: 'M8 8v3.6' }),
        h('path', { d: 'M6.1 9.3h3.8' }),
        h('path', { d: 'M6.1 11h3.8' }),
      ),
    );

    /** Finite non-negative count, or 0. */
    function num(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    /** Compact token count: 842, 12.3k, 1.13M. */
    function compactTokens(value) {
      if (value < 1000) return String(Math.round(value));
      if (value < 1e6) {
        const scaled = value / 1e3;
        return (scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10) + 'k';
      }
      const scaled = value / 1e6;
      return (scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 100) / 100) + 'M';
    }

    /** Exact token count with thousands separators. */
    function exactTokens(value) {
      return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** Unit price text; precision adapts to sub-cent rates, without trailing zeros. */
    function priceText(value, symbol) {
      const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
      const text = value.toFixed(digits);
      return symbol + (digits > 2 ? String(parseFloat(text)) : text);
    }

    function beijingParts(date) {
      const shifted = new Date(date.getTime() + 8 * 3600000);
      return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
    }

    /** Index into the [off-peak, peak] rate pair. */
    function periodIndex(date) {
      const { weekday, hour } = beijingParts(date);
      if (weekday === 0 || weekday === 6) return 0;
      return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 1 : 0;
    }

    function readSelection(raw) {
      const selection = raw && typeof raw === 'object' ? raw : undefined;
      const current = (selection && selection.next) || (selection && selection.current) || {};
      return {
        modelId: typeof current.model === 'string' ? current.model : '',
        providerId: typeof current.provider === 'string' ? current.provider : '',
      };
    }

    function pickPercent(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /**
     * Pull quota percentages out of the official zai-org glm-plan-usage shape:
     * data.limits = [{ type: 'TOKENS_LIMIT' | 'TIME_LIMIT' | ..., percentage }],
     * with a flat-fields fallback for the older community-documented shape.
     */
    function extractQuota(envelope) {
      if (!envelope || typeof envelope !== 'object') return { error: 'network' };
      if (envelope.ok !== true) {
        const reason =
          typeof envelope.reason === 'string' && envelope.reason.length > 0
            ? envelope.reason
            : typeof envelope.status === 'number'
              ? 'HTTP ' + envelope.status
              : 'upstream';
        return { error: reason };
      }
      let data = envelope.body;
      if (data && typeof data === 'object' && data.data && typeof data.data === 'object') data = data.data;
      if (!data || typeof data !== 'object') return { error: 'shape' };
      const limits = [];
      if (Array.isArray(data.limits)) {
        for (const item of data.limits) {
          if (!item || typeof item !== 'object') continue;
          const percent = pickPercent(item.percentage);
          const type = typeof item.type === 'string' ? item.type.toUpperCase() : '';
          if (percent === null || type === '') continue;
          limits.push({ type: type, percent: percent });
        }
      }
      if (limits.length === 0) {
        const five = pickPercent(data.tokenUsage5Hour) ?? pickPercent(data.tokenUsage5h);
        const week =
          pickPercent(data.tokenUsage7Day) ?? pickPercent(data.tokenUsageWeek) ?? pickPercent(data.tokenUsageWeekly);
        const mcp = pickPercent(data.mcpUsage1Month);
        if (five !== null) limits.push({ type: 'TOKENS_LIMIT', percent: five });
        if (week !== null) limits.push({ type: 'WEEK_LIMIT', percent: week });
        if (mcp !== null) limits.push({ type: 'TIME_LIMIT', percent: mcp });
      }
      if (limits.length === 0) return { error: 'shape' };
      return { limits: limits };
    }

    function UsageBreakdown({ useProjection, t }) {
      const rawUsage = useProjection('tokenUsage');
      const rawSelection = useProjection('modelSelection');
      const selectionInfo = readSelection(rawSelection);
      const plan = isPlanProvider(selectionInfo.providerId);
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const [quota, setQuota] = React.useState(null);
      const anchorRef = React.useRef(null);
      const panelRef = React.useRef(null);

      React.useEffect(
        function () {
          if (!open) return undefined;
          function onKeyDown(event) {
            if (event.key === 'Escape') setOpen(false);
          }
          function onPointerDown(event) {
            const anchor = anchorRef.current;
            const panel = panelRef.current;
            if (anchor && anchor.contains(event.target)) return;
            if (panel && panel.contains(event.target)) return;
            setOpen(false);
          }
          document.addEventListener('keydown', onKeyDown);
          document.addEventListener('pointerdown', onPointerDown);
          return function () {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown);
          };
        },
        [open],
      );

      React.useLayoutEffect(
        function () {
          if (!open) {
            setPos(null);
            return undefined;
          }
          function place() {
            const anchor = anchorRef.current;
            if (!anchor) return;
            const rect = anchor.getBoundingClientRect();
            const width = panelRef.current ? panelRef.current.offsetWidth : 320;
            const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
            setPos({ left: left, bottom: Math.max(12, window.innerHeight - rect.top + 6) });
          }
          place();
          window.addEventListener('resize', place);
          return function () {
            window.removeEventListener('resize', place);
          };
        },
        [open],
      );

      React.useEffect(
        function () {
          if (!plan) return undefined;
          let cancelled = false;
          let timer = null;
          async function load() {
            try {
              const response = await fetch('/api/composer-usage.quota');
              const body = await response.json();
              if (!cancelled) setQuota({ at: Date.now(), envelope: body });
            } catch {
              if (!cancelled) setQuota({ at: Date.now(), envelope: null });
            }
          }
          load();
          timer = setInterval(load, 60000);
          return function () {
            cancelled = true;
            clearInterval(timer);
          };
        },
        [plan],
      );

      if (rawUsage === undefined || rawUsage === null) return null;

      const usage = {
        uncached: num(rawUsage.uncachedInputTokens),
        output: num(rawUsage.outputTokens),
        cacheRead: num(rawUsage.cacheReadTokens),
        cacheWrite: num(rawUsage.cacheWriteTokens),
      };
      const total = usage.uncached + usage.output + usage.cacheRead + usage.cacheWrite;
      if (total === 0) return null;

      const modelId = selectionInfo.modelId;
      const pricing = matchPricing(modelId);

      const rows = [
        { key: 'input', name: t('usage.rowInput'), tokens: usage.uncached },
        { key: 'read', name: t('usage.rowRead'), tokens: usage.cacheRead },
        { key: 'write', name: t('usage.rowWrite'), tokens: usage.cacheWrite },
        { key: 'output', name: t('usage.rowOutput'), tokens: usage.output },
      ];

      let inlineLabel;
      let notes = [];
      let symbol = '';
      let digits = 4;
      let shownTotal = null;

      if (pricing && !plan) {
        const currencyKey = pricing.cny ? 'cny' : 'usd';
        symbol = CURRENCY_SYMBOLS[currencyKey];
        const rates = pricing[currencyKey];
        const index = pricing.peak ? periodIndex(new Date()) : 0;
        const units = { input: rates.miss[index], read: rates.hit[index], write: rates.miss[index], output: rates.out[index] };
        rows.forEach(function (row) {
          row.unit = units[row.key];
          row.cost = (row.tokens * row.unit) / 1e6;
        });
        const totalCost = rows.reduce(function (sum, row) {
          return sum + row.cost;
        }, 0);
        // One shared precision, so the listed amounts add up exactly to the total.
        digits = totalCost >= 1 ? 2 : totalCost >= 0.01 ? 3 : 4;
        const scale = Math.pow(10, digits);
        shownTotal = rows.reduce(function (sum, row) {
          return sum + Math.round(row.cost * scale) / scale;
        }, 0);
        inlineLabel = '≈' + symbol + shownTotal.toFixed(digits);
        const billedInput = usage.uncached + usage.cacheRead + usage.cacheWrite;
        const hitText =
          billedInput > 0 ? Math.min(100, (usage.cacheRead / billedInput) * 100).toFixed(1) + '%' : null;
        notes = [
          pricing.peak ? (index === 1 ? t('usage.peakNote') : t('usage.offNote')) : null,
          hitText === null ? null : t('usage.hitNote', { hit: hitText }),
          modelId.indexOf('deepseek') === 0 ? t('usage.writeNote') : null,
          modelId.indexOf('glm') === 0 ? t('usage.storageNote') : null,
          t('usage.estimateNote'),
        ].filter(function (line) {
          return line !== null;
        });
      } else {
        // Subscription plan or unlisted model: never invent prices.
        inlineLabel = compactTokens(total) + ' tok';
        rows.forEach(function (row) {
          row.unit = null;
          row.cost = null;
        });
        notes = [
          plan ? t('usage.planNote', { model: modelId === '' ? t('usage.unknownModel') : modelId }) : null,
          plan ? null : t('usage.unknownNote', { model: modelId === '' ? t('usage.unknownModel') : modelId }),
        ].filter(function (line) {
          return line !== null;
        });
      }

      const quotaView = plan ? extractQuota(quota ? quota.envelope : null) : null;
      let quotaBars = [];
      if (quotaView !== null && quotaView.limits) {
        const labelOf = function (type) {
          if (type.indexOf('WEEK') >= 0 || /7[_\s-]?D/i.test(type)) return t('usage.quotaWeek');
          if (type.indexOf('TIME') >= 0) return t('usage.quotaMcp');
          if (/5\s*H/i.test(type)) return t('usage.quota5h');
          if (type.indexOf('PROMPT') >= 0) return t('usage.quota5h');
          // Per the live response: plain TOKENS_LIMIT is the weekly token quota;
          // another token bucket beside it would be the 5-hour window.
          if (type === 'TOKENS_LIMIT') return t('usage.quotaWeek');
          if (type.indexOf('TOKEN') >= 0) return t('usage.quota5h');
          return type;
        };
        const seenTypes = {};
        const seenLabels = {};
        quotaBars = quotaView.limits.map(function (item) {
          const type = item.type;
          seenTypes[type] = (seenTypes[type] || 0) + 1;
          let label;
          if (type === 'TOKENS_LIMIT') {
            // The gateway repeats TOKENS_LIMIT per window: the first occurrence is
            // the 5-hour token window, the next one is the weekly window.
            label = seenTypes[type] === 1 ? t('usage.quota5h') : t('usage.quotaWeek');
          } else {
            label = labelOf(type);
          }
          if (seenLabels[label] === true) label = type + ' (' + seenTypes[type] + ')';
          seenLabels[label] = true;
          return { label: label, percent: item.percent, raw: item };
        });
      }

      const quotaBar = function (bar, key) {
        const clamped = Math.max(0, Math.min(100, bar.percent));
        // bar.percent is "used" from the API; the bar and the 剩 X% label both
        // visualize the remaining quota, so fill with 100 - used.
        const left = 100 - clamped;
        return h(
          'div',
          { key: key, className: 'cudP_quotaRow', title: JSON.stringify(bar.raw).slice(0, 300) },
          h('span', { className: 'cudP_quotaLabel' }, bar.label),
          h(
            'span',
            { className: 'cudP_track' },
            h('span', { className: 'cudP_fill', style: { width: left + '%' } }),
          ),
          h(
            'span',
            {
              className: 'cudP_quotaValue',
              title: t('usage.quotaUsed', { percent: clamped.toFixed(1), left: left.toFixed(1) }),
            },
            t('usage.quotaLeft', { left: left.toFixed(1) }),
          ),
        );
      };
      let quotaSection = null;
      if (quotaView !== null) {
        if (quotaView.error !== undefined) {
          quotaSection = h(
            'div',
            { className: 'cudP_quotaError' },
            t('usage.quotaError', { reason: quotaView.error }),
          );
        } else if (quotaBars.length > 0) {
          quotaSection = h(
            'div',
            { className: 'cudP_quota' },
            quotaBars.map(function (bar, position) {
              return quotaBar(bar, 'limit:' + position + ':' + bar.label);
            }),
          );
        }
      }

      const quotaBadge = function (label, template) {
        for (const bar of quotaBars) {
          if (bar.label !== label) continue;
          const left = Math.max(0, Math.min(100, 100 - bar.percent));
          return template({ percent: Math.round(left) });
        }
        return null;
      };
      const inlineBadges = [];
      const badge5 = quotaBadge(t('usage.quota5h'), function (o) {
        return t('usage.quotaInline', o);
      });
      if (badge5 !== null) inlineBadges.push(badge5);
      const badgeWeek = quotaBadge(t('usage.quotaWeek'), function (o) {
        return t('usage.quotaInlineWeek', o);
      });
      if (badgeWeek !== null) inlineBadges.push(badgeWeek);

      const costText = function (value) {
        return value === null ? '—' : symbol + value.toFixed(digits);
      };
      const unitText = function (value) {
        return value === null ? '—' : priceText(value, symbol);
      };

      const cell = function (key, content, muted) {
        return h('td', { key: key, className: muted === true ? 'cudP_mutedCell' : undefined }, content);
      };
      const bodyRows = rows.map(function (row) {
        return h(
          'tr',
          { key: row.key },
          cell(row.key + ':name', row.name),
          cell(row.key + ':unit', unitText(row.unit), row.unit === null),
          cell(row.key + ':tokens', exactTokens(row.tokens)),
          cell(row.key + ':cost', costText(row.cost), row.cost === null),
        );
      });
      const totalRow = h(
        'tr',
        { key: 'total', className: 'cudP_totalRow' },
        cell('total:name', t('usage.rowTotal')),
        cell('total:unit', '—', true),
        cell('total:tokens', exactTokens(total)),
        cell('total:cost', costText(shownTotal), shownTotal === null),
      );

      return h(
        'span',
        { className: 'cudP_anchor', 'data-composer-stat': 'usage', ref: anchorRef },
        h(
          'button',
          {
            type: 'button',
            className: 'cudP_pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': t('usage.openDetail'),
            onClick: function () {
              setOpen(function (value) {
                return !value;
              });
            },
          },
          ICON,
          h('span', { className: 'cudP_label' }, inlineLabel),
          inlineBadges.length === 0 ? null : h('span', { className: 'cudP_sep', 'aria-hidden': true }, '·'),
          inlineBadges.length === 0
            ? null
            : h('span', { className: 'cudP_label', title: t('usage.quotaInlineTitle') }, inlineBadges.join(' · ')),
        ),
        open &&
          ReactDOM.createPortal(
            h(
              'div',
              {
                className: 'cudP_panel',
                role: 'dialog',
                'aria-label': t('usage.dialogTitle'),
                ref: panelRef,
                style: pos === null ? { visibility: 'hidden' } : { left: pos.left, bottom: pos.bottom },
              },
              h(
                'div',
                { className: 'cudP_title' },
                h('span', { className: 'cudP_titleLabel' }, ICON, t('usage.dialogTitle')),
                h('span', { className: 'cudP_titleValue' }, t('usage.count', { count: exactTokens(total) })),
              ),
              h('div', { className: 'cudP_rule', 'aria-hidden': true }),
              quotaSection,
              h(
                'table',
                { className: 'cudP_table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('usage.colItem')),
                    h('th', null, t('usage.colUnit')),
                    h('th', null, t('usage.colTokens')),
                    h('th', null, t('usage.colCost')),
                  ),
                ),
                h('tbody', null, bodyRows.concat([totalRow])),
              ),
              notes.length === 0
                ? null
                : h(
                    'ul',
                    { className: 'cudP_notes' },
                    notes.map(function (line, position) {
                      return h('li', { key: position }, line);
                    }),
                  ),
            ),
            document.body,
          ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(function () {
          const tag = document.createElement('style');
          tag.dataset.plugin = '@local/composer-usage-plus';
          tag.dataset.pluginCss = STYLE_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () {
            tag.remove();
          };
        }, 'composer-usage-plus: styles');

        ctx.effect(
          function () {
            return ctx.locale.register(NS, {
              zh: {
                'usage.openDetail': '查看用量明细与费用估算',
                'usage.dialogTitle': '用量明细',
                'usage.count': '{count} tok',
                'usage.colItem': '项目',
                'usage.colUnit': '单价/百万',
                'usage.colTokens': '用量',
                'usage.colCost': '金额',
                'usage.rowInput': '输入（未命中缓存）',
                'usage.rowRead': '缓存读取（命中）',
                'usage.rowWrite': '缓存写入',
                'usage.rowOutput': '输出',
                'usage.rowTotal': '合计',
                'usage.unknownModel': '当前模型',
                'usage.peakNote': '当前按高峰时段单价估算，空闲时段为半价。',
                'usage.offNote': '当前按空闲时段单价估算，高峰时段为两倍。',
                'usage.hitNote': '缓存命中率 {hit}。',
                'usage.quota5h': '5 小时额度',
                'usage.quotaWeek': '7 天额度',
                'usage.quotaMcp': 'MCP 月度',
                'usage.quotaUsed': '已用 {percent}% · 剩 {left}%',
                'usage.quotaLeft': '剩 {left}%',
                'usage.quotaInline': '5h 剩 {percent}%',
                'usage.quotaInlineWeek': '7d 剩 {percent}%',
                'usage.quotaInlineTitle': 'GLM 套餐额度剩余百分比',
                'usage.quotaError': '套餐额度暂时无法获取（{reason}）。',
                'usage.writeNote': 'DeepSeek 自动缓存：「缓存写入」并入「输入」按未命中价计费，故恒为 0。',
                'usage.storageNote': 'GLM 缓存写入（存储）当前限时免费，不计费。',
                'usage.planNote': '当前渠道为订阅套餐（GLM Coding Plan），token 用量包含在套餐额度内，不另行计费。',
                'usage.unknownNote': '未收录「{model}」的单价，暂无法估算费用，仅显示用量。',
                'usage.estimateNote': '金额为按官方单价折算的估算值，非账单。',
              },
              en: {
                'usage.openDetail': 'View usage breakdown and estimated cost',
                'usage.dialogTitle': 'Usage breakdown',
                'usage.count': '{count} tok',
                'usage.colItem': 'Item',
                'usage.colUnit': 'Price/1M',
                'usage.colTokens': 'Tokens',
                'usage.colCost': 'Cost',
                'usage.rowInput': 'Input (cache miss)',
                'usage.rowRead': 'Cache read (hit)',
                'usage.rowWrite': 'Cache write',
                'usage.rowOutput': 'Output',
                'usage.rowTotal': 'Total',
                'usage.unknownModel': 'current model',
                'usage.peakNote': 'Estimated at peak rates; off-peak is half price.',
                'usage.offNote': 'Estimated at off-peak rates; peak is double.',
                'usage.hitNote': 'Cache hit rate {hit}.',
                'usage.quota5h': '5-hour quota',
                'usage.quotaWeek': '7-day quota',
                'usage.quotaMcp': 'MCP monthly',
                'usage.quotaUsed': 'used {percent}% · {left}% left',
                'usage.quotaLeft': '{left}% left',
                'usage.quotaInline': '5h {percent}% left',
                'usage.quotaInlineWeek': '7d {percent}% left',
                'usage.quotaInlineTitle': 'GLM plan quota remaining percentage',
                'usage.quotaError': 'Plan quota is temporarily unavailable ({reason}).',
                'usage.writeNote': 'DeepSeek caches automatically: writes fold into "Input" at miss price, so this stays 0.',
                'usage.storageNote': 'GLM cache-write storage is free for a limited time and not billed.',
                'usage.planNote': 'This channel is a subscription plan (GLM Coding Plan); token usage is covered by the plan quota.',
                'usage.unknownNote': 'No unit price listed for "{model}"; showing usage only.',
                'usage.estimateNote': 'Amounts are estimates from list prices, not a bill.',
              },
            });
          },
          'composer-usage-plus: dictionaries',
        );

        ctx.slots.inject(SLOT, function () {
          return ctx.slots.register(
            {
              name: SLOT,
              id: 'usage',
              order: 1,
              priority: -1,
              locale: NS,
            },
            UsageBreakdown,
          );
        });
      },
    };
  },
});

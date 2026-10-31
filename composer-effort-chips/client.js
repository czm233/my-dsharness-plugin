window.__ModuleLoader__.load({
  id: '@local/composer-effort-chips',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useSyncExternalStore = React.useSyncExternalStore || null;

    function useDirectory(store) {
      const subscribe = React.useCallback((fn) => store.subscribe(fn), [store]);
      const getSnapshot = React.useCallback(() => store.getSnapshot(), [store]);
      if (useSyncExternalStore) return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [state, setState] = React.useState(() => store.getSnapshot());
      React.useEffect(() => {
        setState(store.getSnapshot());
        return store.subscribe(() => setState(store.getSnapshot()));
      }, [store]);
      return state;
    }

    function providerOrder(id) {
      return id === 'deepseek-account' ? 0 : id === 'deepseek-official' ? 1 : 2;
    }

    // Last {model, reasoningEffort} seen per channel id, shared by every
    // composer instance in the page.
    const lastSelectionByProvider = new Map();

    const chipBase = {
      appearance: 'none',
      border: 'none',
      borderRadius: 999,
      padding: '2px 10px',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #999)',
    };
    const chipActive = {
      ...chipBase,
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.25))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontWeight: 600,
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      minWidth: 0,
      maxWidth: '100%',
      overflowX: 'auto',
      overflowY: 'hidden',
      scrollbarWidth: 'thin',
    };

    function groupLabel(group) {
      return group.name || group.label || group.title || group.id;
    }

    const pickerButtonBase = {
      appearance: 'none',
      border: 'none',
      borderRadius: 999,
      padding: '2px 8px',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      maxWidth: 180,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #999)',
    };
    const pickerButtonOpen = {
      ...pickerButtonBase,
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.25))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontWeight: 600,
    };
    const pickerValueStyle = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: 'var(--dsw-alias-label-primary, inherit)',
      fontWeight: 600,
    };
    const menuStyle = {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: 0,
      zIndex: 40,
      minWidth: 160,
      maxWidth: 260,
      maxHeight: 280,
      overflowY: 'auto',
      padding: 4,
      borderRadius: 10,
      border: '1px solid rgba(255,255,255,0.12)',
      background: '#343439',
      color: '#e8e8ea',
      boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
    };
    const menuItemBase = {
      appearance: 'none',
      border: 'none',
      borderRadius: 6,
      padding: '5px 8px',
      fontSize: 12,
      lineHeight: '16px',
      cursor: 'pointer',
      textAlign: 'left',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      background: 'transparent',
      color: 'inherit',
    };
    const menuItemActive = {
      ...menuItemBase,
      background: 'rgba(255,255,255,0.14)',
      fontWeight: 600,
    };

    function Dropdown(props) {
      const { label, value, disabled, options, onPick, ariaLabel, narrow } = props;
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('mousedown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);
      return h(
        'div',
        { style: { position: 'relative', flex: 'none' }, ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            style: narrow
              ? {
                  ...(open ? pickerButtonOpen : pickerButtonBase),
                  padding: '2px 6px',
                  minWidth: MIN_PICKER_WIDTH,
                  maxWidth: 120,
                }
              : (open ? pickerButtonOpen : pickerButtonBase),
            disabled,
            'aria-label': ariaLabel,
            'aria-expanded': open,
            onClick: () => setOpen((v) => !v),
          },
          // 只显示当前值；分类名留在 aria-label / 悬停提示里，不占宽度。
          h('span', { style: pickerValueStyle, title: ariaLabel }, value),
        ),
        open &&
          h(
            'div',
            { style: menuStyle, role: 'listbox' },
            options.length === 0 && h('div', { style: { padding: '5px 8px', fontSize: 12, opacity: 0.6 } }, '—'),
            options.map((option) =>
              h(
                'button',
                {
                  key: option.key,
                  type: 'button',
                  role: 'option',
                  'aria-selected': option.active,
                  style: option.active ? menuItemActive : menuItemBase,
                  title: option.label,
                  onClick: () => {
                    setOpen(false);
                    option.onPick();
                  },
                },
                (option.active ? '● ' : '') + option.label,
              ),
            ),
          ),
      );
    }

    // ---------------------------------------------------------------------
    // 工具栏宽度降级
    //
    // 窄屏 / 右栏挤占时，整排按钮放不下会被裁掉。按可用宽度分三档降级：
    //   full    —— 全展开：渠道 + 模型 + 全部档位胶囊
    //   compact —— 档位收成一个下拉（渠道/模型保持）
    //   tight   —— 渠道/模型/档位全部收成下拉，只占最少的宽度
    //
    // 判定用「实测内容宽 vs 可用宽」，带滞回（hysteresis）避免在临界点抖动：
    // 降级要超出 6px 才触发，回升要富余 24px 才恢复，两者之间有 18px 死区。
    // 宽度来源是这一排的父容器（ResizeObserver），拿不到时退回视口宽度。
    // ---------------------------------------------------------------------
    const MODE_FULL = 'full';
    const MODE_COMPACT = 'compact';
    const MODE_TIGHT = 'tight';
    const DEMOTE_SLACK = 6;
    const PROMOTE_SLACK = 24;

    // 一个档位按钮/下拉按钮的最小宽度（px）：小于它宁可降级也不挤压。
    const MIN_PICKER_WIDTH = 72;

    // 每一档「渲染出来需要多宽」，只记实测值。
    //
    // 未渲染过的档位宽度未知（0）。未知时保守按「放不下」处理：
    // 升档要求目标档已知且确实放得下，降档只看当前档已知宽度。
    // 这样升/降都基于同一份实测数据，不会在边界上互相打架。
    //
    // 初始档位由 CSS 决定（full 先渲染），所以 full 总能拿到实测；
    // 页面从窄变宽时，full 早在首次渲染时量过了。
    const widthByMode = { [MODE_FULL]: 0, [MODE_COMPACT]: 0, [MODE_TIGHT]: 0 };

    /** 读出当前档位的实测宽度并记入缓存。 */
    function measureMode(el, mode) {
      if (!el) return;
      const choices = el.querySelector('[data-composer-effort-choices]');
      if (!choices) return;
      // scrollWidth 可能被父级 overflow 裁成可视宽度，所以再按子项宽度
      // 累加一次取较大值——胶囊是 flex:none，累加结果就是真实自然宽度。
      let sum = 0;
      for (const child of choices.children) {
        const rect = child.getBoundingClientRect();
        sum += rect.width;
      }
      const gap = children => Math.max(0, children - 1) * 4;
      const summed = sum > 0 ? sum + gap(choices.children.length) : 0;
      const width = Math.max(choices.scrollWidth, summed);
      if (Number.isFinite(width) && width > 0) widthByMode[mode] = width;
    }

    // 未实测档位的估算宽度：按 full 宽度折算。
    //
    // full = 渠道 + 模型 + 每个档位一个胶囊；compact 把所有胶囊收成一个
    // 下拉；tight 再把渠道/模型压窄。比例是粗估，只用于决定首次该去哪档，
    // 一旦该档被渲染过就改用实测值。
    function estimateFor(mode, fullWidth) {
      if (mode === MODE_FULL) return fullWidth;
      if (fullWidth <= 0) return mode === MODE_COMPACT ? 260 : 190;
      if (mode === MODE_COMPACT) return Math.round(fullWidth * 0.62);
      return Math.round(fullWidth * 0.48);
    }

    // 各档宽度：实测过就用实测值（永不回退到估算），没测过才用估算。
    //
    // 这是消除振荡的关键——估算和实测有落差，若两者混用，升档按估算
    // 判定「放得下」、升过去实测发现放不下又降回，就会在两个档间来回跳。
    // 一旦某档被实测过，它的宽度就固定下来，判定标准不再变化。
    function widthsSnapshot() {
      const full = widthByMode[MODE_FULL];
      return {
        [MODE_FULL]: full,
        [MODE_COMPACT]: widthByMode[MODE_COMPACT] || estimateFor(MODE_COMPACT, full),
        [MODE_TIGHT]: widthByMode[MODE_TIGHT] || estimateFor(MODE_TIGHT, full),
      };
    }

    function invalidateWidths() {
      widthByMode[MODE_FULL] = 0;
      widthByMode[MODE_COMPACT] = 0;
      widthByMode[MODE_TIGHT] = 0;
    }

    // 判断核心：问「目标档放得下吗」，不问「当前档放得下吗」。
    //
    // 拿当前档判断会死循环：compact 只要 300px，380px 时判定放得下 →
    // 升到 full（要 420px）→ 放不下 → 降回 compact → 又判定放得下 …
    //
    // 规则（order = tight < compact < full，宽度递增）：
    //   1. 能升就升到「最高的、确实放得下的」那一档；
    //      宽度未知的档位保守当作放不下，避免把内容挤出去。
    //   2. 否则降：当前档放不下（超出 DEMOTE_SLACK）就降一档，
    //      最低到 tight。
    // 升档要求比降档更宽松一点点没有意义——所以升档直接用「放得下」，
    // 降档留 DEMOTE_SLACK 的容差，形成稳定的滞回。
    //
    // 未知宽度（0）来自「这一档还没渲染过」。为避免永远升不上去，
    // 调用方会在必要时做一次「试探性升档」：升过去量一次，放不下再回来。
    //
    // @param widths 各档实测宽度 {full, compact, tight}，0 表示未知
    function nextMode(mode, widths, available) {
      if (!available) return mode;
      const order = [MODE_TIGHT, MODE_COMPACT, MODE_FULL];
      const index = order.indexOf(mode);

      // 1. 升档：逐级升，每级都要求目标档实测放得下。
      //    一次跨两级（tight→full）视觉跳变太大，而且 full 放不下时
      //    要整段回退；逐级升的每一步都稳定。
      const up = order[index + 1];
      if (up !== undefined) {
        const upWidth = widths[up];
        // 升档要求目标档不仅放得下，还要留出 PROMOTE_SLACK 的余量；
        // 降档留 DEMOTE_SLACK 的容差。两者之间是死区，宽度在临界点
        // 小幅抖动时档位不变（对称滞回）。
        if (upWidth > 0 && available - upWidth >= PROMOTE_SLACK) return up;
      }

      // 2. 降档：当前档放不下，降一档。
      const currentWidth = widths[mode];
      if (currentWidth > 0 && currentWidth - available > DEMOTE_SLACK) {
        return order[Math.max(0, index - 1)];
      }
      return mode;
    }

    // 降级档位是全页共享的：同一时刻侧边栏/窗口宽度对所有 composer 一致。
    // 由一个测量者写入，两个渲染器订阅。
    const fitStore = (() => {
      let mode = MODE_FULL;
      const listeners = new Set();
      return {
        get: () => mode,
        set(next) {
          if (next === mode) return;
          mode = next;
          listeners.forEach((fn) => fn());
        },
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
    })();

    function useFitStore() {
      const subscribe = React.useCallback((fn) => fitStore.subscribe(fn), []);
      const getSnapshot = React.useCallback(() => fitStore.get(), []);
      if (useSyncExternalStore) return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      const [value, setValue] = React.useState(getSnapshot);
      React.useEffect(() => {
        setValue(getSnapshot());
        return fitStore.subscribe(() => setValue(getSnapshot()));
      }, []);
      return value;
    }

    /**
     * 找出真正决定「这一排能占多宽」的容器。
     *
     * 官方结构（ui-conversation InputBar）：
     *   div.toolbar  >  div.row(width:100%)  >  ...  >  div.standardControls
     *                                                   └─ 我们的两个注册项
     * standardControls 是 display:flex; min-width:0，宽度由内容撑开，
     * 它的 clientWidth 永远等于内容宽——用它判断会永远判「放得下」。
     * 真正被约束的是上面的 row（width:100%）。
     *
     * 判据：上溯到第一个「宽度由外部决定」的祖先——它的 clientWidth
     * 不会随内容变化，而且能容纳我们这一排。最多上溯 8 层。
     */
    function findMeasuredHost(el) {
      const own = el.getBoundingClientRect().width || 0;
      let node = el.parentElement;
      let best = node || el;
      let hops = 0;
      while (node && hops < 8) {
        hops += 1;
        const width = node.clientWidth;
        if (width > 0) {
          const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
          // 百分比宽 / 固定宽 = 由外部约束；被内容撑开的元素这两个都不是。
          const constrained = style !== null && (/^\d+(\.\d+)?px$/.test(style.width) || style.width === '100%');
          if (constrained && width >= own) {
            best = node;
            // 再上溯一层通常是带左右内边距的行，可用宽度以它为准。
            const up = node.parentElement;
            if (up && up.clientWidth > 0 && up.clientWidth >= width) return up;
            return node;
          }
        }
        node = node.parentElement;
      }
      return best;
    }

    /**
     * 算出「这一排还能占多宽」。
     *
     * 行宽减去两端的固定占位：
     *   - 左侧：从行起点到我们这排左边界的距离（+、权限、计划等）
     *   - 右侧：从我们这排右边界到行末尾的距离（发送按钮等）
     * 这两个距离不含我们自己，所以 window = host.clientWidth - left - right
     * 就是纯粹留给我们的空间。再稍微扣一点避免贴边。
     */
    function availableWidth(el, host) {
      if (!host || host.clientWidth <= 0) return 0;
      const hostRect = host.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (hostRect.width <= 0) return host.clientWidth;
      const left = Math.max(0, elRect.left - hostRect.left);
      const right = Math.max(0, hostRect.right - elRect.right);
      const padding = 8;
      return Math.max(0, host.clientWidth - left - right - padding);
    }

    /**
     * 观察宿主容器宽度，产出当前应处的降级档。
     * @param rootRef 这一排的 DOM 节点
     */
    function useFitMode(rootRef, contentKey) {
      const mode = useFitStore();
      const modeRef = React.useRef(mode);
      modeRef.current = mode;

      // 诊断：把最近一次测量结果暴露到 window，便于在控制台核对。
      React.useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        window.__effortChipsDebug = window.__effortChipsDebug || { events: [] };
        return undefined;
      }, []);

      // 档位数量/文字变了（换模型）：各档宽度全部失效，重新测。
      React.useEffect(() => {
        invalidateWidths();
      }, [contentKey]);

      React.useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined;
        const el = rootRef.current;
        if (!el) return undefined;
        // 直接父容器（官方 standardControls）是 display:flex; min-width:0，
        // 宽度由内容撑开——它的 clientWidth 永远等于内容宽，用它判断会永远
        // 判「放得下」。所以要往上找到真正被约束的那一层（输入框行 width:100%）。
        const host = findMeasuredHost(el);
        let frame = 0;
        const evaluate = () => {
          frame = 0;
          // 可用宽度不是整行宽度：左边「+ / 权限 / 计划」、右边发送按钮
          // 等都在同一行里占位。用「我们这排的右边界 - 左边界能延伸到的位置」
          // 来算，再留出发送按钮等固定占位。
          const available = availableWidth(el, host);
          // 先记下当前档的实测宽度，再用「各档宽度 vs 可用宽度」决定去哪档。
          measureMode(el, modeRef.current);
          const widths = widthsSnapshot();
          const next = nextMode(modeRef.current, widths, available);
          if (typeof window !== 'undefined' && window.__effortChipsDebug) {
            const dbg = window.__effortChipsDebug;
            dbg.events.push({
              t: Date.now(),
              mode: modeRef.current,
              available: Math.round(available),
              widths: { full: Math.round(widths[MODE_FULL]), compact: Math.round(widths[MODE_COMPACT]), tight: Math.round(widths[MODE_TIGHT]) },
              host: host ? host.className : null,
              hostWidth: host ? host.clientWidth : 0,
              next,
            });
            if (dbg.events.length > 40) dbg.events.shift();
          }
          if (next !== modeRef.current) {
            fitStore.set(next);
            return;
          }
          // 还没量到任何宽度（DOM 尚未布局完，或内容还没渲染）→ 稍后重试，
          // 否则会永远停在初始档位。
          if (!widths[MODE_FULL] || !available) {
            if (typeof window !== 'undefined') {
              window.setTimeout(schedule, 120);
            }
          }
        };
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(evaluate);
        };
        const observer = new ResizeObserver(schedule);
        // 观察 host 自身和它上面两层：右栏挤压时变的是更外层的列容器，
        // host 的 clientWidth 会跟着变但自身不一定收到 resize 通知。
        observer.observe(host);
        let probe = host.parentElement;
        for (let i = 0; i < 2 && probe; i += 1) {
          observer.observe(probe);
          probe = probe.parentElement;
        }
        observer.observe(el);
        // 档位区在胶囊↔下拉之间切换时会换成新节点，每次渲染重新挂观察。
        const choices = el.querySelector('[data-composer-effort-choices]');
        if (choices) observer.observe(choices);
        // 兜底：右栏挤压 / 侧边栏展开时变化的是外层容器，host 本身不一定
        // 收到通知（它的宽度由父级决定）。所以再看 window 的 resize。
        const onResize = () => {
          schedule();
          // 尺寸变了，各档实测宽度可能已过时，下一次 evaluate 会重新量当前档。
        };
        if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
        schedule();
        return () => {
          if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
          observer.disconnect();
          if (frame !== 0) cancelAnimationFrame(frame);
        };
      }, [rootRef, mode]);

      return mode;
    }

    /** 档位收成下拉：按钮显示当前档位名，点开选。 */
    function EffortDropdown(props) {
      const { chips, effectiveEffort, disabled, label, onPick } = props;
      const active = chips.find((chip) =>
        chip.effort === undefined ? effectiveEffort === undefined : chip.effort === effectiveEffort,
      );
      return h(Dropdown, {
        label,
        value: active ? active.label : '—',
        disabled,
        ariaLabel: label,
        options: chips.map((chip) => ({
          key: chip.key,
          label: chip.label,
          active: chip === active,
          onPick: () => onPick(chip.effort),
        })),
      });
    }

    function ChannelModelPickers(props) {
      const { locked, available, directory, select, t } = props;
      const state = useDirectory(directory);
      React.useEffect(() => {
        if (available) directory.load?.();
      }, [available, directory]);

      if (!available) return null;

      const groups = [...state.groups].sort(
        (a, b) => providerOrder(a.id) - providerOrder(b.id),
      );
      const current = state.current;
      let currentModel = null;
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === current?.provider && model.id === current.model) currentModel = model;
        }
      }
      const busy = state.pending !== null;
      const disabled = !!locked || busy || !current;
      const currentGroup = groups.find((group) => group.id === current?.provider);

      // Remember the last selection per channel (including changes made
      // through the shipped selector) so hopping channels restores the
      // model you actually left behind, not the channel's first model.
      React.useEffect(() => {
        if (current?.provider && current?.model) {
          lastSelectionByProvider.set(current.provider, {
            model: current.model,
            reasoningEffort: current.reasoningEffort,
          });
        }
      }, [current?.provider, current?.model, current?.reasoningEffort]);

      const channelOptions = groups.map((group) => ({
        key: group.id,
        label: groupLabel(group),
        active: group.id === current?.provider,
        onPick: () => {
          if (group.id === current?.provider) return;
          // Restore the model last used on this channel when it still
          // exists; otherwise fall back to the channel's first model.
          const remembered = lastSelectionByProvider.get(group.id);
          const target =
            (remembered && group.models.find((model) => model.id === remembered.model)) ||
            group.models[0];
          if (!target) {
            select({ provider: group.id });
            return;
          }
          const efforts = target.reasoning?.efforts;
          const effort =
            remembered?.reasoningEffort ??
            lastSelectionByProvider.get(current.provider)?.reasoningEffort;
          const keep =
            effort !== undefined &&
            Array.isArray(efforts) &&
            efforts.some((level) => level.id === effort);
          select({
            provider: group.id,
            model: target.id,
            ...(keep ? { reasoningEffort: effort } : {}),
          });
        },
      }));

      const modelOptions = (currentGroup?.models ?? []).map((model) => ({
        key: model.id,
        label: model.name || model.id,
        active: model.id === current?.model,
        onPick: () => {
          if (model.id === current?.model) return;
          // Keep the current effort when the new model supports it.
          const effort = current?.reasoningEffort;
          const efforts = model.reasoning?.efforts;
          const keep =
            effort !== undefined &&
            Array.isArray(efforts) &&
            efforts.some((level) => level.id === effort);
          select({
            provider: current.provider,
            model: model.id,
            ...(keep ? { reasoningEffort: effort } : {}),
          });
        },
      }));

      const mode = useFitStore();
      const narrow = mode === MODE_TIGHT;

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: narrow ? 2 : 4,
            flex: 'none',
            minWidth: 0,
            opacity: disabled ? 0.6 : 1,
          },
          'data-composer-channel-model-pickers': true,
          'data-fit-mode': mode,
        },
        h(Dropdown, {
          key: 'channel',
          label: t('channelLabel'),
          value: currentGroup ? groupLabel(currentGroup) : '—',
          disabled,
          options: channelOptions,
          ariaLabel: t('channelLabel'),
          narrow,
        }),
        h(Dropdown, {
          key: 'model',
          label: t('modelLabel'),
          value: currentModel ? currentModel.name || currentModel.id : '—',
          disabled,
          options: modelOptions,
          ariaLabel: t('modelLabel'),
          narrow,
        }),
      );
    }

    function FlatModelPicker(props) {
      const { locked, available, directory, load, select, t } = props;
      const state = useDirectory(directory);
      React.useEffect(() => {
        if (available) load();
      }, [available, load]);

      if (!available) return null;

      const groups = [...state.groups].sort(
        (a, b) => providerOrder(a.id) - providerOrder(b.id),
      );
      const current = state.current;
      let currentModel = null;
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === current?.provider && model.id === current.model) currentModel = model;
        }
      }
      const reasoning = currentModel?.reasoning;
      const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort;

      // Known reasoning-effort sets, verified against vendor docs (2026-10).
      // DSH/pi-ai level vocabulary: off / minimal / low / medium / high /
      // xhigh / max — each key's wire spelling is remappable per model in
      // `reasoningEfforts` config, so these ids travel to any provider.
      const MODEL_EFFORT_TABLE = [
        // gpt-5.1-codex-max adds xhigh on top of the GPT-5 set.
        { match: /codex-max/i, efforts: ['off', 'low', 'medium', 'high', 'xhigh'] },
        // OpenAI GPT-5: minimal/low/medium/high (minimal≈off); GPT-5.1
        // defaults to none (=off). o-series: low/medium/high.
        { match: /(^|[\/-])(gpt-5|o[13456])([.\-/]|$)/i, efforts: ['off', 'low', 'medium', 'high'] },
        // Claude 4.5+: adaptive thinking effort low/medium/high, plus off.
        { match: /claude/i, efforts: ['off', 'low', 'medium', 'high'] },
        // Gemini 2.5/3: thinking budget off/low/high (dynamic≈default).
        { match: /gemini/i, efforts: ['off', 'low', 'high'] },
        // Grok: reasoning effort low/high.
        { match: /grok/i, efforts: ['low', 'high'] },
        // GLM-5.3 / 5.3-FLASH: docs.z.ai — ONLY max/high/low, thinking is
        // forced on (no off). Default is max.
        { match: /glm-5\.3/i, efforts: ['low', 'high', 'max'] },
        // GLM-5.2 and older: accepts none→xhigh (maps xhigh→max etc.);
        // effective selectable levels reduce to off/low/high/max.
        { match: /glm/i, efforts: ['off', 'low', 'high', 'max'] },
        // DeepSeek R1/reasoner: always reasons, no effort parameter.
        { match: /deepseek-(r\d|reasoner)/i, efforts: ['high'] },
        // Qwen 3: thinking on/off, effort low/high.
        { match: /qwq|qwen3/i, efforts: ['off', 'low', 'high'] },
        // Kimi k-series: thinking on/off.
        { match: /kimi|moonshot/i, efforts: ['off', 'high'] },
      ];
      const matchEfforts = (model) => {
        const haystack = `${model.id} ${model.name ?? ''}`;
        for (const entry of MODEL_EFFORT_TABLE) {
          if (entry.match.test(haystack)) return entry.efforts;
        }
        return null;
      };
      // Last-resort fallback for models unknown to the table.
      const GENERIC_EFFORTS = ['off', 'low', 'high', 'max'];

      const effortChips = [];
      const effortLevels = reasoning
        ? reasoning.efforts
        : (matchEfforts(currentModel ?? {}) ?? GENERIC_EFFORTS).map((id) => ({
            id,
            name: id.charAt(0).toUpperCase() + id.slice(1),
          }));
      if (!reasoning || reasoning.defaultEffort === undefined) {
        effortChips.push({ key: 'provider-default', effort: undefined, label: t('providerDefault') });
      }
      for (const level of effortLevels) {
        effortChips.push({ key: `effort:${level.id}`, effort: level.id, label: level.name });
      }

      const busy = state.pending !== null;
      const disabled = !!locked || busy || !current;
      const pickEffort = (effort) => {
        if (disabled) return;
        select({
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        });
      };

      // 这一排是多项选择器的共同测量点：先量出「全展开需要多宽」，
      // 再与父容器实际可用宽度比较，得出降级档。档位多时它最宽，
      // 所以由它当测量者是安全的。
      const rootRef = React.useRef(null);
      // 档位集合变了（换模型 / 档位文案变化）就要重测全展开宽度。
      const contentKey = effortChips.map((chip) => chip.label).join('|');
      const mode = useFitMode(rootRef, contentKey);
      const stacked = mode !== MODE_FULL;

      return h(
        'div',
        { style: rowStyle, 'data-composer-effort-chips': true, ref: rootRef },
        effortChips.length > 0 &&
          h(
            'div',
            {
              key: 'efforts',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                flex: 'none',
                opacity: disabled ? 0.6 : 1,
              },
              role: 'group',
              'aria-label': t('effortLabel'),
              // 测量基准：这里的子项始终按「胶囊」的自然宽度计入，
              // 折叠成下拉时不参与测量，避免自己把自己越量越窄。
              'data-composer-effort-choices': true,
            },
            stacked
              ? h(EffortDropdown, {
                  chips: effortChips,
                  effectiveEffort,
                  disabled,
                  label: t('effortLabel'),
                  onPick: pickEffort,
                })
              : effortChips.map((chip) => {
                  const active =
                    chip.effort === undefined
                      ? effectiveEffort === undefined
                      : chip.effort === effectiveEffort;
                  return h(
                    'button',
                    {
                      key: chip.key,
                      type: 'button',
                      style: active ? chipActive : chipBase,
                      disabled,
                      onClick: () => pickEffort(chip.effort),
                    },
                    chip.label,
                  );
                }),
          ),
      );
    }

    return {
      inject: ['slots', 'locale', 'modelDirectories', 'sessions'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.locale.register('composerEffortChips', {
            zh: { providerDefault: '默认', effortLabel: '推理强度', channelLabel: '渠道', modelLabel: '模型' },
            en: { providerDefault: 'Default', effortLabel: 'Reasoning effort', channelLabel: 'Channel', modelLabel: 'Model' },
          }),
        );
        // Freeze the shipped model trigger's width so effort-name changes
        // don't push the effort chips row around. The shipped trigger is the
        // only button holding the model-selection CSS-module's label/effort
        // spans, which keeps this selector narrow and stable across builds'
        // hash prefixes.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const style = document.createElement('style');
          style.dataset.plugin = '@local/composer-effort-chips';
          style.dataset.pluginCss = 'frozen-model-trigger';
          style.textContent = [
            // Freeze the shipped model trigger's width so effort-name changes
            // don't push the effort chips row around.
            'button:has([class*="triggerEffort"]) {',
            '  width: 176px;',
            '  flex: none;',
            '}',
            // Layout: the composer row directly parents our entries and also
            // contains the shipped model seat somewhere below. Reversing that
            // row renders [ours..., shipped seat] as [shipped seat, ...ours]
            // — the shipped selector ends up leftmost and our cluster owns
            // the spot next to Send — independent of hashed class names.
            '*:has(> [data-composer-effort-chips]):has(.htuFrW_root) {',
            '  flex-direction: row-reverse;',
            '}',
          ].join('\n');
          document.head.appendChild(style);
          return () => style.remove();
        });
        // JS fallback for the visual reorder — only active when the CSS row
        // flip above is NOT (e.g. :has() unavailable): find the shipped
        // model-select root, climb from it to the child of the COMMON
        // ancestor that also contains our row, and physically move that
        // wrapper in front of our cluster. The official node stays attached
        // to its parent the whole time (only repositioned), so React
        // insert/remove using it as a reference keeps working. Idempotent.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          let timer = 0;
          const reconcile = () => {
            timer = 0;
            try {
              const ours = document.querySelector('[data-composer-effort-chips]');
              if (!ours) return;
              for (const root of document.querySelectorAll('.htuFrW_root')) {
                if (root.contains(ours) || ours.contains(root)) continue;
                // Climb from the shipped root to its child-of-common-ancestor.
                let a = root;
                let hops = 0;
                while (a.parentElement && !a.parentElement.contains(ours) && hops < 12) {
                  a = a.parentElement;
                  hops += 1;
                }
                const row = a.parentElement;
                if (!row || !row.contains(ours)) continue;
                // CSS owns the reorder whenever the flip is in effect.
                if (getComputedStyle(row).flexDirection === 'row-reverse') return;
                // Direct child of the row that contains our cluster.
                let target = ours;
                while (target.parentElement !== row) target = target.parentElement;
                if (target === a) continue;
                // Only act while the shipped seat sits AFTER our cluster.
                if (!(target.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
                row.insertBefore(a, target);
                return;
              }
            } catch (error) {
              console.error('[composer-effort-chips] seat reorder failed:', error);
            }
          };
          const schedule = () => {
            if (timer === 0) timer = setTimeout(reconcile, 60);
          };
          schedule();
          const observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: true });
          return () => {
            observer.disconnect();
            if (timer !== 0) clearTimeout(timer);
          };
        });
        const t = ctx.locale.bind('composerEffortChips');
        ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
          const models = scope.modelDirectories;
          const sessions = scope.sessions;
          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'composer-effort-chips',
                // Highest order in the right slot = rightmost in the row,
                // i.e. immediately left of the shipped model selector / send
                // button; channel/model pickers (order 11) sit to their left.
                order: 20,
                inject: (sessionId) => {
                  const directory = models.directoryFor(sessionId);
                  const available = sessions.subagentAddress(sessionId) === undefined;
                  return {
                    available,
                    directory: directory.store,
                    load: () => {
                      if (available) directory.load().catch(() => {});
                    },
                    select: (selection) =>
                      available ? directory.select(selection) : Promise.resolve(undefined),
                    t,
                  };
                },
              },
              FlatModelPicker,
            ),
          );
          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'composer-channel-model-pickers',
                // Right side of the composer, immediately after the effort
                // chips (order 10) so channel/model sit right next to them.
                order: 11,
                inject: (sessionId) => {
                  const directory = models.directoryFor(sessionId);
                  const available = sessions.subagentAddress(sessionId) === undefined;
                  return {
                    available,
                    directory: directory.store,
                    select: (selection) =>
                      available ? directory.select(selection) : Promise.resolve(undefined),
                    t,
                  };
                },
              },
              ChannelModelPickers,
            ),
          );
        });
      },
    };
  },
});

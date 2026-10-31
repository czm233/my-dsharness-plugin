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

    // 档位胶囊：常态形态。当前档高亮。
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

    // 不加 overflow 裁剪：下拉菜单是 position:absolute 向上弹出的，
    // overflow:hidden/auto 会把菜单切掉，表现为「按钮点不开」。
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      minWidth: 0,
      maxWidth: '100%',
      flex: '0 1 auto',
    };

    // ------------------------------------------------------------------
    // 档位该展开还是收起
    //
    // 常态展开（一排胶囊）；宽度不够才收成下拉。只比较两个实测值：
    //   需要多宽 = 胶囊自然宽度之和（含间距）
    //   可用多宽 = 父容器宽度减去兄弟节点（渠道/模型）占用的部分
    // 滞回：超出 4px 才收，富余 16px 才展，临界点不会来回跳。
    // ------------------------------------------------------------------
    const COLLAPSE_SLACK = 4;
    const EXPAND_SLACK = 16;

    // 「展开成一排」需要多宽：展开时实测并记住，收起后沿用上次实测值。
    // 收起时那个锚点就没了，绝不能因此返回 0——否则判定会以为「量不到」
    // 而永远停住，既收不回去也展不回来。
    const chipWidthCache = { value: 0 };

    function measureChipWidths(el) {
      if (!el) return chipWidthCache.value;
      const row = el.querySelector('[data-composer-effort-chips-row]');
      if (!row) return chipWidthCache.value;
      // 关键：胶囊被父级 flex 压缩时，getBoundingClientRect 返回的是压缩后的
      // 宽度，会让我们以为「展开只占这么点」，于是永远不收起。
      // scrollWidth 是不受压缩影响的自然内容宽度，用它。
      let total = 0;
      let count = 0;
      for (const child of row.children) {
        const width = child.scrollWidth || 0;
        if (width > 0) {
          total += width;
          count += 1;
        }
      }
      if (count > 0) {
        // 胶囊自身有 padding 和 border，scrollWidth 已包含；再加间距。
        chipWidthCache.value = total + Math.max(0, count - 1) * 4;
        return chipWidthCache.value;
      }
      // 兜底：整排的 scrollWidth（同样不受压缩影响）。
      const fallback = row.scrollWidth || el.scrollWidth || 0;
      if (fallback > 0) chipWidthCache.value = fallback;
      return chipWidthCache.value;
    }

    function availableForRow(el) {
      if (!el) return 0;
      const parent = el.parentElement;
      if (!parent) return 0;
      const parentRect = parent.getBoundingClientRect();
      if (parentRect.width <= 0) return 0;

      // 父容器里所有兄弟节点（渠道/模型、发送按钮等）占掉的宽度。
      // 注意：我等自己当前可能被压缩过，所以不能用「剩余可见宽度」反推，
      // 必须用「父容器总宽 - 兄弟实际占用」这个与自身形态无关的量。
      let siblings = 0;
      let siblingsCount = 0;
      for (const child of parent.children) {
        if (child === el) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width > 0) {
          siblings += rect.width;
          siblingsCount += 1;
        }
      }
      // 兄弟之间还有 gap（官方工具栏 12px / 我们内部 4px），补回去。
      const gaps = Math.max(0, siblingsCount) * 8;
      const available = parentRect.width - siblings - gaps;
      return available > 0 ? available : 0;
    }

    /** 观察这一排，决定档位是否收成下拉。 */
    function useCollapsed(ref, deps) {
      const [collapsed, setCollapsed] = React.useState(false);
      const collapsedRef = React.useRef(collapsed);
      collapsedRef.current = collapsed;

      React.useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined;
        const el = ref.current;
        if (!el) return undefined;
        let frame = 0;
        const evaluate = () => {
          frame = 0;
          const need = measureChipWidths(el);
          const have = availableForRow(el);
          if (!need || !have) return;
          if (!collapsedRef.current && need - have > COLLAPSE_SLACK) setCollapsed(true);
          else if (collapsedRef.current && have - need > EXPAND_SLACK) setCollapsed(false);
        };
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(evaluate);
        };
        const observer = new ResizeObserver(schedule);
        // 自己 + 直接父容器（渠道/模型所在层）+ 上两层：右栏挤压变的是外层列。
        observer.observe(el);
        let node = el.parentElement;
        for (let i = 0; i < 3 && node; i += 1) {
          observer.observe(node);
          node = node.parentElement;
        }
        if (typeof window !== 'undefined') window.addEventListener('resize', schedule);
        schedule();
        return () => {
          observer.disconnect();
          if (frame !== 0) cancelAnimationFrame(frame);
          if (typeof window !== 'undefined') window.removeEventListener('resize', schedule);
        };
      }, [ref, JSON.stringify(deps)]);

      return collapsed;
    }

    function groupLabel(group) {
      return group.name || group.label || group.title || group.id;
    }

    // 渠道 / 模型按钮：各自一个最大宽度，超出时文字省略。
    // minWidth:0 是省略生效的前提——flex 子项默认最小宽等于内容宽，
    // 没有它 textOverflow:ellipsis 永远不会触发。
    const PICKER_MAX_WIDTH = 96;

    const pickerButtonBase = {
      appearance: 'none',
      border: 'none',
      borderRadius: 999,
      padding: '2px 8px',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: '0 1 auto',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      minWidth: 0,
      maxWidth: PICKER_MAX_WIDTH,
      overflow: 'hidden',
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
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
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
      const { label, value, disabled, options, onPick, ariaLabel } = props;
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
            style: open ? pickerButtonOpen : pickerButtonBase,
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

      return h(
        'div',
        {
          style: { display: 'flex', alignItems: 'center', gap: 4, flex: 'none', opacity: disabled ? 0.6 : 1 },
          'data-composer-channel-model-pickers': true,
        },
        h(Dropdown, {
          key: 'channel',
          label: t('channelLabel'),
          value: currentGroup ? groupLabel(currentGroup) : '—',
          disabled,
          options: channelOptions,
          ariaLabel: t('channelLabel'),
        }),
        h(Dropdown, {
          key: 'model',
          label: t('modelLabel'),
          value: currentModel ? currentModel.name || currentModel.id : '—',
          disabled,
          options: modelOptions,
          ariaLabel: t('modelLabel'),
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

      const activeChip = effortChips.find((chip) =>
        chip.effort === undefined
          ? effectiveEffort === undefined
          : chip.effort === effectiveEffort,
      ) || effortChips[0];

      const isActive = (chip) => (chip.effort === undefined
        ? effectiveEffort === undefined
        : chip.effort === effectiveEffort);

      const rootRef = React.useRef(null);
      // 换模型导致档位集合变化时，重新判断一次要不要收起。
      const collapsed = useCollapsed(rootRef, effortChips.map((chip) => chip.label));

      // 常态：一排胶囊，点一下直接挂档。
      const chipsRow = h(
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
          'data-composer-effort-chips-row': true,
        },
        effortChips.map((chip) => h(
          'button',
          {
            key: chip.key,
            type: 'button',
            style: isActive(chip) ? chipActive : chipBase,
            disabled,
            onClick: () => pickEffort(chip.effort),
          },
          chip.label,
        )),
      );

      // 降级：放不下时收成一个下拉。
      const dropdown = h(Dropdown, {
        key: 'effort-dropdown',
        label: t('effortLabel'),
        value: activeChip ? activeChip.label : '—',
        disabled,
        ariaLabel: t('effortLabel'),
        options: effortChips.map((chip) => ({
          key: chip.key,
          label: chip.label,
          active: isActive(chip),
          onPick: () => pickEffort(chip.effort),
        })),
      });

      return h(
        'div',
        { style: rowStyle, 'data-composer-effort-chips': true, ref: rootRef },
        effortChips.length > 0 && (collapsed ? dropdown : chipsRow),
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

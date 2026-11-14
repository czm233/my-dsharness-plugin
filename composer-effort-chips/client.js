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
      return id === 'qwen-token-plan-cn' ? 0 : id === 'zai-coding-cn' ? 1 : id === 'myself' ? 2 : id === 'rightcode' ? 3 : id === 'rightcode-gpt' ? 4 : 5;
    }

    // Last {model, reasoningEffort} seen per channel id, shared by every
    // composer instance in the page.
    const lastSelectionByProvider = new Map();

    /** Host half's single POST endpoint (same shape as the workflow board's). */
    const PERSONA_API = '/api/composer-effort-chips/rpc';
    async function personaCall(payload) {
      const response = await fetch(PERSONA_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }

    // 档位胶囊：当前档高亮，点一下直接挂档。
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

    function groupLabel(group) {
      return group.name || group.label || group.title || group.id;
    }

    // 渠道 / 模型按钮：各自一个最大宽度，超出时文字省略。
    // minWidth:0 是省略生效的前提——flex 子项默认最小宽等于内容宽，
    // 没有它 textOverflow:ellipsis 永远不会触发。
    const PICKER_MAX_WIDTH = 96;

    // 选择器直接沿用档位胶囊的视觉与盒模型（chipBase/chipActive）：
    // 文字直接挂在 button 上，不再套 span —— span 带 overflow:hidden 会把
    // 基线变成盒底边，导致整行比胶囊低半行。
    const pickerLayout = {
      padding: '2px 8px',
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: PICKER_MAX_WIDTH,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };
    const pickerButtonBase = { ...chipBase, ...pickerLayout };
    const pickerButtonOpen = { ...chipActive, ...pickerLayout };
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

    // fit 下拉（模型）：不限宽不省略，任何模型名都完整显示。
    const fitButtonOverrides = {
      flex: '0 0 auto',
      minWidth: 'auto',
      maxWidth: 'none',
      overflow: 'visible',
    };
    const fitValueOverrides = {
      minWidth: 'auto',
      overflow: 'visible',
    };
    const fitMenuOverrides = { maxWidth: 'none' };
    const fitItemOverrides = { overflow: 'visible' };

    function Dropdown(props) {
      const { label, value, disabled, options, onPick, ariaLabel, fit } = props;
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
        // 必须是 flex：普通块里行内块按钮会多出行框的下沉空间，
        // 外层按 center 对齐时这段空隙把按钮整体压下去半条行高。
        { style: { position: 'relative', display: 'flex', alignItems: 'center', flex: 'none' }, ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            style: {
              ...(open ? pickerButtonOpen : pickerButtonBase),
              ...(fit ? fitButtonOverrides : {}),
              ...(fit ? fitValueOverrides : {}),
            },
            disabled,
            'aria-label': ariaLabel,
            title: ariaLabel,
            'aria-expanded': open,
            onClick: () => setOpen((v) => !v),
          },
          // 只显示当前值；分类名留在 aria-label / 悬停提示里，不占宽度。
          value,
        ),
        open &&
          h(
            'div',
            { style: { ...menuStyle, ...(fit ? fitMenuOverrides : {}) }, role: 'listbox' },
            options.length === 0 && h('div', { style: { padding: '5px 8px', fontSize: 12, opacity: 0.6 } }, '—'),
            options.map((option) =>
              h(
                'button',
                {
                  key: option.key,
                  type: 'button',
                  role: 'option',
                  'aria-selected': option.active,
                  style: {
                    ...(option.active ? menuItemActive : menuItemBase),
                    ...(fit ? fitItemOverrides : {}),
                  },
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

    // 人格选择：只换系统提示词里的一段，不重建会话。
    // 列表来自 host 侧的 personas.json；未选时显示「默认」，代表不注入。
    function PersonaPicker(props) {
      const { sessionId, t } = props;
      const [state, setState] = React.useState({ presets: [], selected: '', ready: false });
      React.useEffect(() => {
        let alive = true;
        personaCall({ action: 'list', sessionId })
          .then((data) => {
            if (!alive) return;
            setState({
              presets: Array.isArray(data.presets) ? data.presets : [],
              selected: typeof data.selected === 'string' ? data.selected : '',
              ready: true,
            });
          })
          .catch((error) => {
            if (alive) setState({ presets: [], selected: '', ready: true });
          });
        return () => { alive = false; };
      }, [sessionId]);

      const pick = (presetId) => {
        const previous = state;
        setState((current) => ({ ...current, selected: presetId }));
        personaCall({ action: 'select', sessionId, presetId }).catch(() => setState(previous));
      };

      if (!state.ready) return null;

      const active = state.presets.find((preset) => preset.id === state.selected);
      const options = [
        {
          key: '__none',
          label: t('personaNone'),
          active: active === undefined,
          onPick: () => pick(''),
        },
        ...state.presets.map((preset) => ({
          key: preset.id,
          label: preset.name,
          active: state.selected === preset.id,
          onPick: () => pick(preset.id),
        })),
      ];

      return h(Dropdown, {
        // 未选时显示控件名而不是「默认」——推理强度那边已经有一个「默认」。
        value: active ? active.name : t('personaLabel'),
        ariaLabel: t('personaLabel'),
        options,
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
          fit: true,
        }),
      );
    }

    // 子智能体对话（右栏）没有官方模型位：那里按会话保存的选择只承诺「下一次触发」，
    // 而子智能体的模型是父会话派发时定下的。所以这里只读、不可选，显示不了就说显示不了。
    const FIXED_MODEL_LABEL = {
      border: 'none',
      padding: '2px 8px',
      fontSize: 12,
      lineHeight: '18px',
      whiteSpace: 'nowrap',
      maxWidth: 240,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      fontVariantNumeric: 'tabular-nums',
      cursor: 'default',
    };

    function SubagentModelLabel(props) {
      const { directory, load } = props;
      const state = useDirectory(directory);
      React.useEffect(() => {
        load();
      }, [load]);
      const current = state.current;
      let name = null;
      if (current) {
        for (const group of state.groups) {
          if (group.id !== current.provider) continue;
          for (const model of group.models) {
            if (model.id === current.model) name = model.name || model.id;
          }
        }
      }
      const text = name !== null
        ? name
        : current
          ? `${current.provider} / ${current.model}`
          : state.status === 'loading' ? '…' : '—';
      const title = current ? `${current.provider} / ${current.model}` : text;
      return h('span', { style: FIXED_MODEL_LABEL, title, 'data-subagent-model': '' }, text);
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

      // 档位铺成一排胶囊：当前档高亮，点一下直接挂档。
      return h(
        'div',
        { style: rowStyle, 'data-composer-effort-chips': true },
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
            },
            effortChips.map((chip) => {
              const active = chip.effort === undefined
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
            zh: { providerDefault: '默认', effortLabel: '推理强度', channelLabel: '渠道', modelLabel: '模型', personaLabel: '助手', personaNone: '默认' },
            en: { providerDefault: 'Default', effortLabel: 'Reasoning effort', channelLabel: 'Channel', modelLabel: 'Model', personaLabel: 'Assistant', personaNone: 'Default' },
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
                  // 子智能体会话照常拉目录（只读展示），但选不了。
                  return {
                    available,
                    directory: directory.store,
                    load: () => {
                      directory.load().catch(() => {});
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
          // 助手（人格）选择器：坐在渠道/模型与推理强度之间。
          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'composer-persona-picker',
                order: 12,
                inject: (sessionId) => ({ sessionId, t }),
              },
              PersonaPicker,
            ),
          );
          // 子智能体对话没有模型位，也没有可选的渠道/模型：只放一个当前模型的只读标签。
          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'composer-subagent-model',
                order: 11,
                inject: (sessionId) => {
                  const directory = models.directoryFor(sessionId);
                  return {
                    available: sessions.subagentAddress(sessionId) !== undefined,
                    directory: directory.store,
                    load: () => {
                      directory.load().catch(() => {});
                    },
                  };
                },
              },
              (props) => {
                if (!props.available) return null;
                return h(SubagentModelLabel, { directory: props.directory, load: props.load });
              },
            ),
          );
        });
      },
    };
  },
});

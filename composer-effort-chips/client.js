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

      const effortChips = [];
      if (reasoning) {
        if (reasoning.defaultEffort === undefined) {
          effortChips.push({ key: 'provider-default', effort: undefined, label: t('providerDefault') });
        }
        for (const level of reasoning.efforts) {
          effortChips.push({ key: `effort:${level.id}`, effort: level.id, label: level.name });
        }
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
            zh: { providerDefault: '默认', effortLabel: '推理强度' },
            en: { providerDefault: 'Default', effortLabel: 'Reasoning effort' },
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
            'button:has([class*="triggerEffort"]) {',
            '  width: 176px;',
            '  flex: none;',
            '}',
          ].join('\n');
          document.head.appendChild(style);
          return () => style.remove();
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
                order: 10,
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
        });
      },
    };
  },
});

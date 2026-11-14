// Client half of the Turn Queue plugin — PLACEMENT PROBE.
//
// Renders the probe frame inside `conversation.session.header.utilities`, the
// shipped header row that sits between the title cluster and the corner
// controls. On screen that is the row above the view tabs: the model picker,
// fork, overflow and sidebar buttons live to its right, so the frame lands
// immediately left of that button group.
//
// Three slots are filled with the three most recent session titles as
// stand-ins. No completion tracking, no clicks, no persistence yet.

window.__ModuleLoader__.load({
  id: '@local/turn-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOG = '[turn-queue]'

    const CSS = `
      .tqFrame {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 5px;
        box-sizing: border-box;
        border: 1px dashed var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.5));
        border-radius: 9px;
      }
      .tqCard {
        display: flex;
        align-items: center;
        width: 148px;
        height: 20px;
        padding: 0 8px;
        box-sizing: border-box;
        border-radius: 6px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));
        color: var(--dsw-alias-label-secondary, inherit);
        font-size: 12px;
        line-height: 20px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tqCard[data-empty="true"] {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
        opacity: 0.45;
      }
    `

    function createQueueArea(sessions) {
      return function QueueArea() {
        const subscribe = React.useCallback(
          (listener) => sessions.list.subscribe(listener),
          [],
        )
        const snapshot = React.useSyncExternalStore(
          subscribe,
          () => sessions.list.getSnapshot(),
        )
        const rows = (snapshot.ids ?? []).slice(0, 3)
          .map((id) => snapshot.byId[id])
          .filter((row) => row !== undefined)
        const cells = [0, 1, 2].map((index) => {
          const label = rows[index]?.displayTitle ?? rows[index]?.title
          return label === undefined
            ? h('div', { key: index, className: 'tqCard', 'data-empty': 'true' })
            : h('div', { key: index, className: 'tqCard', title: label }, label)
        })
        return h('div', { className: 'tqFrame', 'data-turn-queue': '' }, cells)
      }
    }

    return {
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/turn-queue'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'turn-queue: stylesheet')

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: '@local/turn-queue',
          order: 10,
        }, createQueueArea(ctx.sessions)))

        console.log(LOG, 'queue area registered in conversation.session.header.utilities')
      },
    }
  },
})
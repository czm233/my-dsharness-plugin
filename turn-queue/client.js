// Client half of the Turn Queue plugin.
//
// A FIFO queue of sessions that just finished work, pinned at the start of
// `conversation.session.header.utilities` (immediately left of the shipped
// Finder / fork / overflow buttons). Entries come from the shipped session
// status source: a session enters the queue when `completionUnread` flips on,
// which the platform raises when a background session's turn settles and the
// session is not the one on screen. Opening the session clears that flag, so
// the queue also drops the entry when the user visits it by any route.
//
// Clicking an entry opens that session and removes it immediately; the next
// entry slides into its place. The queue keeps up to 50 entries, shows the
// three oldest, and survives reloads through localStorage.

window.__ModuleLoader__.load({
  id: '@local/turn-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOG = '[turn-queue]'
    const STORAGE_KEY = 'turn-queue.entries.v1'
    const MAX_ENTRIES = 50
    const VISIBLE = 3

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
        width: 181px;
        height: 20px;
        padding: 0 8px;
        box-sizing: border-box;
        border: none;
        border-radius: 6px;
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));
        color: var(--dsw-alias-label-secondary, inherit);
        font-family: inherit;
        font-size: 12px;
        line-height: 20px;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      @media (hover: hover) {
        .tqCard:not([data-empty="true"]):hover {
          background: var(--dsw-alias-interactive-bg-pressed, rgba(127, 127, 127, 0.26));
          color: var(--dsw-alias-label-primary, inherit);
        }
      }
      .tqCard[data-empty="true"] {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
        opacity: 0.45;
        cursor: default;
        pointer-events: none;
      }
    `

    function readStored() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((entry) => entry !== null && typeof entry === 'object'
          && typeof entry.id === 'string' && entry.id !== '')
      } catch {
        return []
      }
    }

    /** Queue state shared by the header slot and the plugin lifetime. */
    function createQueueStore(ctx) {
      let entries = []
      let snapshot = []
      let unread = new Map()
      const listeners = new Set()

      const sessionRow = (id) => {
        try {
          return ctx.sessions.list.getSnapshot().byId[id]
        } catch {
          return undefined
        }
      }
      /** The roster is only trustworthy once the list store leaves its pending phase. */
      const listReady = () => {
        try {
          return ctx.sessions.list.getSnapshot().phase === 'ready'
        } catch {
          return false
        }
      }
      const isSubagent = (id) => {
        const row = sessionRow(id)
        return row !== undefined && row.subagent !== null && row.subagent !== undefined
      }
      const exists = (id) => !listReady() || sessionRow(id) !== undefined

      const publish = () => {
        snapshot = entries.slice()
        for (const listener of listeners) listener()
      }
      const persist = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
        } catch {
          /* storage unavailable: keep the in-memory queue */
        }
      }
      const commit = () => {
        persist()
        publish()
      }

      /** Drop entries whose session disappeared (deleted, archived out of the list). */
      const pruneMissing = () => {
        const before = entries.length
        entries = entries.filter((entry) => exists(entry.id))
        return entries.length !== before
      }

      const sync = () => {
        let changed = false
        let status
        try {
          status = ctx.uiSession.sessionStatus.getSnapshot()
        } catch {
          return
        }
        const nextUnread = new Map()
        for (const [id, row] of status) {
          const now = row !== undefined && row !== null && row.completionUnread === true
          nextUnread.set(id, now)
          if (isSubagent(id)) continue
          const was = unread.get(id) === true
          if (now && !was) {
            if (!entries.some((entry) => entry.id === id)) {
              entries.push({ id, at: Date.now() })
              changed = true
            }
          } else if (!now && was) {
            const before = entries.length
            entries = entries.filter((entry) => entry.id !== id)
            if (entries.length !== before) changed = true
          }
        }
        unread = nextUnread
        if (pruneMissing()) changed = true
        if (entries.length > MAX_ENTRIES) {
          entries = entries.slice(entries.length - MAX_ENTRIES)
          changed = true
        }
        if (changed) commit()
      }

      const dismiss = (id) => {
        const before = entries.length
        entries = entries.filter((entry) => entry.id !== id)
        if (entries.length !== before) commit()
      }

      const start = () => {
        const stored = readStored().slice(-MAX_ENTRIES)
        entries = stored.filter((entry) => exists(entry.id))
        if (entries.length !== stored.length) persist()
        publish()
        const disposers = []
        try {
          disposers.push(ctx.uiSession.sessionStatus.subscribe(sync))
        } catch (error) {
          console.error(LOG, 'session status subscribe failed', error)
        }
        try {
          disposers.push(ctx.sessions.list.subscribe(sync))
        } catch (error) {
          console.error(LOG, 'session list subscribe failed', error)
        }
        sync()
        return () => {
          for (const dispose of disposers) dispose()
        }
      }

      return {
        start,
        dismiss,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot: () => snapshot,
      }
    }

    function titleOf(snapshot, id) {
      const row = snapshot.byId[id]
      const title = row?.displayTitle ?? row?.title
      return typeof title === 'string' && title !== '' ? title : id
    }

    function createQueueArea(store, sessions) {
      return function QueueArea() {
        const subscribeQueue = React.useCallback(
          (listener) => store.subscribe(listener),
          [],
        )
        const entries = React.useSyncExternalStore(subscribeQueue, store.getSnapshot)
        const subscribeList = React.useCallback(
          (listener) => sessions.list.subscribe(listener),
          [],
        )
        const snapshot = React.useSyncExternalStore(
          subscribeList,
          () => sessions.list.getSnapshot(),
        )

        const cells = []
        for (let index = 0; index < VISIBLE; index += 1) {
          const entry = entries[index]
          if (entry === undefined) {
            cells.push(h('div', { key: `empty-${index}`, className: 'tqCard', 'data-empty': 'true' }))
            continue
          }
          const label = titleOf(snapshot, entry.id)
          cells.push(h('button', {
            key: entry.id,
            type: 'button',
            className: 'tqCard',
            title: label,
            'data-session': entry.id,
            onClick: () => { void store.open(entry.id) },
          }, label))
        }
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

        const store = createQueueStore(ctx)
        store.open = (id) => {
          store.dismiss(id)
          try {
            const workspace = ctx.get('uiWorkspace')
            workspace?.openSession?.(id)
          } catch (error) {
            console.error(LOG, 'openSession failed', error)
          }
        }
        // The header slot registers immediately; queue syncing waits for the
        // session-status source so a missing service never hides the frame.
        ctx.inject(['uiSession'], () => {
          ctx.effect(() => store.start(), 'turn-queue: queue syncing')
        })

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: '@local/turn-queue',
          order: -1000,
        }, createQueueArea(store, ctx.sessions)))

        console.log(LOG, 'queue slot registered')
      },
    }
  },
})
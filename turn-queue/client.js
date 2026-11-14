// Client half of the Turn Queue plugin.
//
// A FIFO queue of sessions that need a look, pinned at the start of
// `conversation.session.header.utilities` (immediately left of the shipped
// Finder / fork / overflow buttons).
//
// The queue stores EVENTS, not sessions:
//   - `waiting`: the session raised a pending interaction (a question, an
//     approval) and is blocked on the user. Enqueued immediately.
//   - `done`: the session stayed idle after a turn settled. Enqueued after a
//     settle window so multi-round goal work is not announced mid-task.
//
// A click opens the session and marks THAT event read. The same event never
// returns, even while the session is still waiting; a later event (the user
// answers and the turn finishes, or a new question) is a new event and shows
// up again. This keeps "state enqueues" and "action dequeues" from fighting.

window.__ModuleLoader__.load({
  id: '@local/turn-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const LOG = '[turn-queue]'
    const STORAGE_KEY = 'turn-queue.entries.v1'
    const READ_KEY = 'turn-queue.read.v1'
    const MAX_ENTRIES = 50
    const MAX_READ = 300
    const VISIBLE = 3
    // A session must stay idle this long before its turn counts as finished work.
    const SETTLE_MS = 8000

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
      .tqCard[data-waiting="true"] {
        box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, rgba(90, 140, 255, 0.9));
      }
    `

    const entryKey = (id, token) => `${id}|${token}`

    function readEntries() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw === null) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter((entry) => entry !== null && typeof entry === 'object'
          && typeof entry.id === 'string' && entry.id !== '')
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind === 'waiting' ? 'waiting' : 'done',
            token: typeof entry.token === 'string' && entry.token !== '' ? entry.token : `legacy:${String(entry.at ?? 0)}`,
            at: typeof entry.at === 'number' ? entry.at : 0,
          }))
      } catch {
        return []
      }
    }

    function readReads() {
      try {
        const raw = localStorage.getItem(READ_KEY)
        if (raw === null) return new Map()
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return new Map()
        const map = new Map()
        for (const item of parsed) {
          if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number') map.set(item[0], item[1])
        }
        return map
      } catch {
        return new Map()
      }
    }

    /** Queue state shared by the header slot and the plugin lifetime. */
    function createQueueStore(ctx) {
      let entries = []
      let snapshot = []
      let runningState = new Map()
      const pending = new Map()
      let read = new Map()
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
      /**
       * A goal that has not reached `complete` means the task is still owned by
       * the session: active rounds continue by themselves, and paused or blocked
       * rounds are waiting on the user rather than finishing work.
       */
      const hasUnfinishedGoal = (id) => {
        try {
          const binding = typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(id) : undefined
          const phase = binding?.session?.projections?.faceOf?.('goal')?.getSnapshot?.()?.goal?.phase
          return phase !== undefined && phase !== null && phase !== 'complete'
        } catch {
          return false
        }
      }

      const publish = () => {
        snapshot = entries.slice()
        for (const listener of listeners) listener()
      }
      const persist = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
          localStorage.setItem(READ_KEY, JSON.stringify([...read.entries()]))
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

      /** Forget read marks of sessions that no longer exist, and cap the set. */
      const pruneRead = () => {
        let changed = false
        if (listReady()) {
          for (const key of [...read.keys()]) {
            const id = key.slice(0, key.lastIndexOf('|'))
            if (id !== '' && !exists(id)) {
              read.delete(key)
              changed = true
            }
          }
        }
        if (read.size > MAX_READ) {
          const sorted = [...read.entries()].sort((a, b) => a[1] - b[1])
          for (const [key] of sorted.slice(0, read.size - MAX_READ)) read.delete(key)
          changed = true
        }
        return changed
      }

      /** Enqueue one event unless it was already read or is already queued. */
      const enqueue = (id, kind, token) => {
        const key = entryKey(id, token)
        if (read.has(key)) return false
        const existing = entries.find((entry) => entry.id === id)
        if (existing !== undefined) {
          if (existing.token === token) return false
          // One row per session: a newer event replaces the older one and moves
          // to the newest position.
          entries = entries.filter((entry) => entry.id !== id)
        }
        entries.push({ id, kind, token, at: Date.now() })
        return true
      }

      const sync = () => {
        let changed = false
        let status
        try {
          status = ctx.uiSession.sessionStatus.getSnapshot()
        } catch {
          return
        }
        const now = Date.now()
        const nextRunning = new Map()
        for (const [id, row] of status) {
          const running = row !== undefined && row !== null && row.running === true
          nextRunning.set(id, running)
          const interaction = row?.pendingInteraction
          if (interaction !== undefined && interaction !== null) {
            // A session blocked on the user is the one thing worth surfacing
            // immediately, even while its turn is still open.
            pending.delete(id)
            if (!isSubagent(id)) {
              const token = `w:${String(interaction.key ?? 'pending')}`
              if (enqueue(id, 'waiting', token)) changed = true
            }
            continue
          }
          if (running || isSubagent(id)) {
            // A live turn, or a subagent, never settles into the queue.
            pending.delete(id)
            continue
          }
          if (runningState.get(id) === true) {
            // The turn just ended: hold the entry until the session stays idle.
            pending.set(id, now)
            continue
          }
          const since = pending.get(id)
          if (since === undefined || now - since < SETTLE_MS) continue
          if (hasUnfinishedGoal(id)) continue
          pending.delete(id)
          if (enqueue(id, 'done', `d:${since}`)) changed = true
        }
        for (const id of [...pending.keys()]) {
          if (!nextRunning.has(id)) pending.delete(id)
        }
        runningState = nextRunning
        // Drop entries whose task turned out to still belong to a live goal.
        const beforeGoalFilter = entries.length
        entries = entries.filter((entry) => entry.kind === 'waiting' || !hasUnfinishedGoal(entry.id))
        if (entries.length !== beforeGoalFilter) changed = true
        if (pruneMissing()) changed = true
        if (pruneRead()) changed = true
        if (entries.length > MAX_ENTRIES) {
          entries = entries.slice(entries.length - MAX_ENTRIES)
          changed = true
        }
        if (changed) commit()
      }

      /** Mark one event read so it can never come back, and drop it from the row. */
      const dismiss = (entry) => {
        read.set(entryKey(entry.id, entry.token), Date.now())
        entries = entries.filter((item) => !(item.id === entry.id && item.token === entry.token))
        commit()
      }

      const start = () => {
        read = readReads()
        const stored = readEntries().slice(-MAX_ENTRIES)
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
        // Status pushes are the primary source; the poll only guarantees the
        // queue still converges if a push is dropped or the subscription lands
        // after the edge it was meant to observe.
        const poll = setInterval(sync, 1500)
        return () => {
          clearInterval(poll)
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
        // An empty queue still needs one slot to show where it lives; the row
        // only grows to three when entries actually exist.
        const count = Math.min(VISIBLE, Math.max(1, entries.length))
        for (let index = 0; index < count; index += 1) {
          const entry = entries[index]
          if (entry === undefined) {
            cells.push(h('div', { key: `empty-${index}`, className: 'tqCard', 'data-empty': 'true' }))
            continue
          }
          const label = titleOf(snapshot, entry.id)
          cells.push(h('button', {
            key: entryKey(entry.id, entry.token),
            type: 'button',
            className: 'tqCard',
            title: label,
            'data-session': entry.id,
            'data-waiting': entry.kind === 'waiting' ? 'true' : undefined,
            onClick: () => { void store.open(entry) },
          }, label))
        }
        return h('div', { className: 'tqFrame', 'data-turn-queue': '' }, cells)
      }
    }

    return {
      inject: ['slots', 'sessions', 'uiSession'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/turn-queue'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'turn-queue: stylesheet')

        /** Scroll the sidebar roster to the row of the session that just opened. */
        const revealInSidebar = (id) => {
          if (typeof document === 'undefined') return
          const selector = `[data-row-key="session:${id}"]`
          const attempt = (tries) => {
            const row = document.querySelector(selector)
            if (row !== null) {
              row.scrollIntoView({ block: 'center' })
              return
            }
            if (tries > 0) setTimeout(() => attempt(tries - 1), 150)
          }
          attempt(10)
        }

        const store = createQueueStore(ctx)
        store.open = (entry) => {
          store.dismiss(entry)
          try {
            const workspace = ctx.get('uiWorkspace')
            workspace?.openSession?.(entry.id)
          } catch (error) {
            console.error(LOG, 'openSession failed', error)
          }
          revealInSidebar(entry.id)
        }
        ctx.effect(() => store.start(), 'turn-queue: queue syncing')

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
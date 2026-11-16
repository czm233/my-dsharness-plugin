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
    const { IconQueueOutlineRegular: IconQueue } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    const LOG = '[turn-queue]'
    const NS = 'turn-queue'
    const DICTS = {
      zh: { 'menu.queue': '加入队列' },
      en: { 'menu.queue': 'Add to queue' },
    }
    const STORAGE_KEY = 'turn-queue.entries.v1'
    const READ_KEY = 'turn-queue.read.v1'
    const MAX_ENTRIES = 50
    const MAX_READ = 300
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
        max-width: 180px;
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
        background: var(--dsw-alias-state-warn-secondary, #f7ad31);
        color: #3b2a00;
      }
      @media (hover: hover) {
        .tqCard[data-waiting="true"]:hover {
          background: var(--dsw-alias-state-warn-primary, #f59e0b);
        }
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
            kind: entry.kind === 'waiting' ? 'waiting' : entry.kind === 'manual' ? 'manual' : 'done',
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
      let unreadState = new Map()
      let tokenSeq = 0
      const deferred = new Map()
      let baseline = true
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
      const isArchived = (id) => {
        try {
          const archived = ctx.workspaces?.list?.getSnapshot?.()?.archivedSessionIds
          return Array.isArray(archived) && archived.includes(id)
        } catch {
          return false
        }
      }
      /** Rows the user picked in the sidebar by hand. */
      const isPinned = (entry) => entry.kind === 'manual'
      const exists = (id) => !listReady() || sessionRow(id) !== undefined
      /** The session currently shown in the main view, if any. */
      const currentId = () => {
        try {
          return ctx.uiSession.current?.getSnapshot?.()?.key
        } catch {
          return undefined
        }
      }
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
        entries = entries.filter((entry) => exists(entry.id) && !(isPinned(entry) && isArchived(entry.id)))
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
        // One row per session: a newer event replaces the older one inside that
        // row instead of moving it to the end.
        return merge(id, kind, token)
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
        const onScreen = currentId()
        const nextUnread = new Map()
        for (const [id, row] of status) {
          const unread = row !== undefined && row !== null && row.completionUnread === true
          nextUnread.set(id, unread)
          const interaction = row?.pendingInteraction
          if (interaction !== undefined && interaction !== null) {
            // A session blocked on the user is worth surfacing immediately, even
            // while its turn is still open - unless the user is already looking
            // at it, in which case the question is right there in front of them.
            if (!isSubagent(id) && id !== onScreen) {
              const token = `w:${String(interaction.key ?? 'pending')}`
              if (enqueue(id, 'waiting', token)) changed = true
            }
            continue
          }
          if (isSubagent(id)) continue
          // The platform raises this flag at the exact moment a background turn
          // settles, so it is the notification edge we forward - no settling
          // timer. The first pass only records the baseline so sessions that
          // finished before the plugin loaded stay quiet.
          if (unread && unreadState.get(id) !== true && !baseline && id !== onScreen) {
            tokenSeq += 1
            const token = `c:${now}:${tokenSeq}`
            if (hasUnfinishedGoal(id)) deferred.set(id, token)
            else if (enqueue(id, 'done', token)) changed = true
          }
        }
        // A deferred completion belongs to a goal that later settles.
        for (const [id, token] of [...deferred.entries()]) {
          if (!nextUnread.has(id) && !isSubagent(id)) { deferred.delete(id); continue }
          if (hasUnfinishedGoal(id)) continue
          deferred.delete(id)
          if (enqueue(id, 'done', token)) changed = true
        }
        unreadState = nextUnread
        baseline = false
        // Opening a session counts as reading its events, hand-queued rows
        // included: the user is looking at it, so its row leaves the queue.
        if (onScreen !== undefined && entries.some((entry) => entry.id === onScreen && !isPinned(entry))) {
          const now = Date.now()
          for (const entry of entries) {
            if (entry.id === onScreen && !isPinned(entry)) read.set(entryKey(entry.id, entry.token), now)
          }
          entries = entries.filter((entry) => entry.id !== onScreen || isPinned(entry))
          changed = true
        }
        // Drop entries whose task turned out to still belong to a live goal.
        const beforeGoalFilter = entries.length
        entries = entries.filter((entry) => entry.kind !== 'done' || !hasUnfinishedGoal(entry.id))
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

      /**
       * Fold a new event into its session's row while keeping the row's slot.
       * A row the user queued by hand absorbs the event and stays `manual`: the
       * bookmark keeps its place until the user opens or unqueues it.
       */
      const merge = (id, kind, token) => {
        const index = entries.findIndex((entry) => entry.id === id)
        if (index === -1) {
          entries.push({ id, kind, token, at: Date.now() })
          return true
        }
        const current = entries[index]
        if (current.token === token) return false
        const next = current.kind === 'manual'
          ? { ...current, token, at: Date.now() }
          : { id, kind, token, at: Date.now() }
        const rest = entries.slice()
        rest.splice(index, 1, next)
        entries = rest
        return true
      }

      /**
       * Put a session in the queue by hand. It joins as `manual` at the tail
       * of the queue; an automatic row of the same session becomes that same
       * row moved to the tail, so a session only ever occupies one slot.
       */
      const queue = (id) => {
        if (typeof id !== 'string' || id === '') return false
        if (entries.some((entry) => entry.id === id && entry.kind === 'manual')) return false
        tokenSeq += 1
        const existing = entries.find((entry) => entry.id === id)
        const rest = entries.filter((entry) => entry.id !== id)
        rest.push({
          id,
          kind: 'manual',
          token: existing?.token ?? `m:${Date.now()}:${tokenSeq}`,
          at: Date.now(),
        })
        entries = rest
        commit()
        return true
      }

      const start = () => {
        read = readReads()
        const stored = readEntries().slice(-MAX_ENTRIES)
        entries = stored.filter((entry) => exists(entry.id) && !(isPinned(entry) && isArchived(entry.id)))
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
        queue,
        isQueued: (id) => entries.some((entry) => entry.id === id && entry.kind === 'manual'),
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
            'data-manual': entry.kind === 'manual' ? 'true' : undefined,
            onClick: () => { void store.open(entry) },
          }, label))
        }
        return h('div', { className: 'tqFrame', 'data-turn-queue': '' }, cells)
      }
    }

    return {
      inject: ['slots', 'sessions', 'uiSession', 'contextMenus', 'locale'],
      apply(ctx) {
        const t = typeof ctx.locale?.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => DICTS.zh[key] ?? key
        ctx.effect(() => ctx.locale?.register?.(NS, DICTS), 'turn-queue: dictionaries')
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
          // Opening is the action that dequeues, whether the row came from an
          // event or was queued by hand.
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

        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({
            name: 'contextMenu.icon',
            key: 'workspace.queue',
          }, IconQueue)
        })

        // Sidebar right-click: queue a session by hand, or take it back out.
        // The action resolves live, so the label flips with the current state.
        ctx.effect(() => {
          const service = ctx.get?.('contextMenus') ?? ctx.contextMenus
          if (service === undefined || service === null || typeof service.register !== 'function') {
            console.error(LOG, 'context menu service unavailable; right-click action off')
            return undefined
          }
          return service.register({
            id: 'turn-queue.queue-session',
            target: 'session',
            order: 50,
            resolve: ({ sessionId }) => [{
              id: 'queue',
              label: t('menu.queue'),
              icon: { key: 'workspace.queue' },
              run: () => { store.queue(sessionId) },
            }],
          })
        }, 'turn-queue: sidebar menu action')

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
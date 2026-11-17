/**
 * Client half of Side Chat (侧边对话), native-fork edition.
 *
 * Opening the tab immediately forks the parent session through the client
 * session service (`sessions.fork`, latest completed-turn prefix) and binds
 * the tab to the child. From the first paint the tab hosts the official
 * Conversation factory for a real session: the full composer with model,
 * effort, and permission controls, the status bar, and the inherited history
 * rendered exactly like the main pane. The previous custom first-message
 * composer and the read-only parent preview are gone — the real thing
 * replaces both, and quoting uses the client's built-in text interaction.
 *
 * A tab owns exactly one child:
 *   - `keepMounted: true` keeps the body mounted while another session or
 *     tab is on screen, so a live side chat never unwinds.
 *   - the tab → child mapping is persisted in localStorage, so a remount
 *     (full reload, session view retirement) re-binds the same child.
 *     Tab ids are minted per session, so the key is (session id, tab id).
 *   - a mapping whose session no longer resolves is dropped; the eager fork
 *     then creates a fresh child on the next pass.
 */

window.__ModuleLoader__.load({
  id: '@local/side-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'side-chat'
    const KIND = 'forkchat'
    const TAB_ID = '@local/side-chat/forkchat'
    const CONV_SLOT = 'sidechat.conversation'

    let clientCtx = null

    const zh = {
      'guide.label': '侧边对话',
      'guide.desc': '把当前会话分出一个分支，在右栏继续聊',
      'tab.title': '侧边对话',
      'fork.error': '创建分支失败',
      'fork.retry': '重试',
    }
    const en = {
      'guide.label': 'Side chat',
      'guide.desc': 'Fork the current session and keep chatting in the right sidebar',
      'tab.title': 'Side chat',
      'fork.error': 'Failed to create the branch',
      'fork.retry': 'Retry',
    }

    // One branch per tab, remembered across body remounts and page reloads.
    // The key is (owning session id, tab id): the sidebar mints tab ids per
    // session layout (`tab1`, `tab2`, …), so a tab id alone collides across
    // sessions and would hand another session's branch to this tab.
    const BRANCH_STORAGE = 'dsh.side-chat.branch.v1.'
    const branches = new Map()
    const branchListeners = new Set()

    function tabKey(sessionId, tabId) {
      return JSON.stringify([sessionId, tabId])
    }

    function readBranch(key) {
      if (branches.has(key)) return branches.get(key)
      try {
        const stored = localStorage.getItem(BRANCH_STORAGE + key)
        if (stored !== null && stored !== '') {
          branches.set(key, stored)
          return stored
        }
      } catch (_storageUnavailable) { /* keep the in-memory map */ }
      return undefined
    }

    function rememberBranch(key, childId) {
      branches.set(key, childId)
      try { localStorage.setItem(BRANCH_STORAGE + key, childId) } catch (_storageUnavailable) { /* noop */ }
      branchListeners.forEach(fn => fn())
    }

    function forgetBranch(key) {
      branches.delete(key)
      try { localStorage.removeItem(BRANCH_STORAGE + key) } catch (_storageUnavailable) { /* noop */ }
      branchListeners.forEach(fn => fn())
    }

    function useBranch(key) {
      const [childId, setChildId] = React.useState(() => key === undefined ? undefined : readBranch(key))
      React.useEffect(() => {
        if (key === undefined) return undefined
        const sync = () => setChildId(readBranch(key))
        branchListeners.add(sync)
        sync()
        return () => branchListeners.delete(sync)
      }, [key])
      return childId
    }

    // Silent diagnostic trail (the desktop client has no console): what the
    // tab decided, readable from the profile's localStorage.
    function recordDiag(event, detail) {
      try {
        const body = JSON.stringify({ event, detail: String(detail === undefined ? '' : detail).slice(0, 800) })
        fetch('/api/side-chat/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        }).catch(() => {})
      } catch (_unavailable) { /* diagnostics stay silent */ }
    }

    function sessionDisplayName(sessionId) {
      try {
        const row = clientCtx.sessions.list.getSnapshot().byId[sessionId]
        return (row && (row.title || row.name)) || sessionId
      } catch (_unknownStoreShape) {
        return sessionId
      }
    }

    // Eager-fork dedupe across remounts and React's double effect pass: one
    // in-flight fork per tab key, cleared on settle so a retry can run.
    const forkInFlight = new Set()

    /** Fixed Chat selection used by the embedded Conversation occurrence. */
    function FixedChatConversationView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /**
     * Render the shared Conversation content for the branch child session,
     * mirroring the shipped sidebar chat panel: embedded variant, no width
     * handles, no main header. The ambient session is the child (bound by the
     * body's SessionProvider); props.sessionId from the body wins when
     * present.
     */
    function ConversationPanel(props) {
      const session = props.useSession(value => value)
      const active = props.useConversation(value => value).activeTargets.size > 0
      const sessionId = props.sessionId || (session && (session.sessionId || session.id))
      const phase = active || (session && (!session.blank && !session.awaitingFirstTurn || session.running))
        ? 'active'
        : session && session.promptAttempted ? 'engaging' : 'blank'
      return props.renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase,
        hero: phase === 'blank',
      }, { slots: { views: FixedChatConversationView } })
    }

    /**
     * Tab body: binds the tab's child — forked from the parent the moment the
     * tab opens without a mapping — and hosts the conversation slot hosting
     * the official surface. `keepMounted` keeps this body alive while its
     * session is off screen; unmount only happens on tab close or a full
     * reload, and the replacement mount resolves the very same child.
     */
    function ForkChatTab(props) {
      const { tab } = props.useTabInfo()
      const parent = props.useSession(value => value)
      const parentId = parent && (parent.sessionId || parent.id)
      const key = parentId === undefined ? undefined : tabKey(parentId, tab.id)
      const childId = useBranch(key)
      const [bound, setBound] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [healSeq, setHealSeq] = React.useState(0)
      const bodyRef = React.useRef(null)
      const t = translator

      // Open-tab eager fork. Without a mapping the tab forks the parent right
      // away, so the official conversation surface exists from the first
      // paint; a failed fork stops the automatic passes until a retry.
      React.useEffect(() => {
        if (childId !== undefined || key === undefined || parentId === undefined) return undefined
        if (failure !== null || forkInFlight.has(key)) return undefined
        forkInFlight.add(key)
        clientCtx.sessions.fork({ sessionId: parentId, increaseTitle: true })
          .then((created) => {
            forkInFlight.delete(key)
            rememberBranch(key, created)
          })
          .catch((error) => {
            forkInFlight.delete(key)
            const message = String((error && error.message) || error)
            recordDiag('fork-failed', message)
            setFailure(message)
          })
        return undefined
      }, [childId, key, parentId, failure])

      // Retain the child through its exact session identity once the mapping
      // holds one; a reference whose session no longer resolves drops the
      // stale mapping so the eager fork creates a fresh child.
      React.useEffect(() => {
        if (childId === undefined || key === undefined) return undefined
        let reference = null
        let cancelled = false
        try {
          reference = clientCtx.sessions.retain(childId, { source: 'sideChat', signal: tab.signal })
        } catch (_unresolvable) {
          forgetBranch(key)
          return undefined
        }
        reference.ready.catch(() => {
          if (!cancelled) {
            forgetBranch(key)
            setBound(null)
          }
        })
        if (!cancelled) setBound({ childId, reference })
        return () => {
          cancelled = true
          try { reference.release() } catch (_alreadyReleased) { /* noop */ }
        }
        // tab.signal is occurrence-scoped and would re-run creation-adjacent
        // work if it were a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [childId])

      // Composer self-heal. Two audit stages 400ms/500ms apart, so the
      // single-frame race between the editor's DOM update and React's
      // re-render never triggers one, and IME composition (placeholder hidden
      // by CSS while composing) is skipped. The persisted draft is restored on
      // the rebuilt shell, so typed text survives the remount.
      React.useEffect(() => {
        const body = bodyRef.current
        if (body === null || typeof MutationObserver === 'undefined') return undefined
        let firstTimer = 0
        let confirmTimer = 0
        let heals = 0
        const observe = () => {
          if (firstTimer !== 0 || confirmTimer !== 0) return
          firstTimer = setTimeout(() => {
            firstTimer = 0
            if (!composerDesynced(body)) return
            confirmTimer = setTimeout(() => {
              confirmTimer = 0
              if (heals >= 3 || !composerDesynced(body)) return
              heals += 1
              recordHealTrace(key)
              setHealSeq(seq => seq + 1)
            }, 500)
          }, 400)
        }
        const observer = new MutationObserver(observe)
        observer.observe(body, { childList: true, characterData: true, subtree: true })
        return () => {
          observer.disconnect()
          if (firstTimer !== 0) clearTimeout(firstTimer)
          if (confirmTimer !== 0) clearTimeout(confirmTimer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key, bound])

      if (childId === undefined) {
        if (failure !== null) {
          return h('div', { style: styles.errorPane },
            h('div', { style: styles.errorText }, `${t('fork.error')}: ${failure}`),
            h('button', { type: 'button', style: styles.retryButton, onClick: () => setFailure(null) }, t('fork.retry')))
        }
        return h('div', { style: styles.center, 'aria-busy': true }, h('div', { style: styles.spinner }))
      }
      if (bound === null || bound.childId !== childId) {
        return h('div', { style: styles.center, 'aria-busy': true }, h('div', { style: styles.spinner }))
      }
      return h('div', { style: styles.body, ref: bodyRef },
        h(props.SessionProvider, {
          key: `sidechat-conv-${healSeq}`,
          session: bound.reference,
        }, props.renderSlot(CONV_SLOT, { sessionId: bound.childId })))
    }

    /**
     * Composer desync signature. The official composer renders its placeholder
     * overlay only while the input store's draft is empty, so a visible
     * placeholder beside non-empty editable text is impossible in a consistent
     * composer: the visible editor and the store the composer subscribes to
     * have split into two input shells (observed after the underlying session
     * binding churns). Remounting the tab's conversation subtree rebuilds the
     * scope and re-wires one shell for both.
     */
    function composerDesynced(body) {
      for (const placeholder of body.querySelectorAll('[data-composer-placeholder]')) {
        const editable = placeholder.previousElementSibling
        if (editable === null) continue
        const visible = typeof placeholder.checkVisibility === 'function'
          ? placeholder.checkVisibility()
          : placeholder.getClientRects().length > 0
        if (!visible) continue
        if ((editable.textContent || '').trim() !== '') return true
      }
      return false
    }

    /** Silent diagnostic trail for heals (read post-mortem from leveldb), capped. */
    const HEAL_STORAGE = 'dsh.side-chat.heal.v1'
    function recordHealTrace(key) {
      try {
        const list = JSON.parse(localStorage.getItem(HEAL_STORAGE) || '[]')
        if (!Array.isArray(list)) return
        list.push({ t: Date.now(), key })
        while (list.length > 20) list.shift()
        localStorage.setItem(HEAL_STORAGE, JSON.stringify(list))
      } catch (_storageUnavailable) { /* diagnostics stay silent */ }
    }

    /** Live tab chip: the branch child's display name. */
    function BranchTitle(props) {
      const { tab } = props.useTabInfo()
      const parent = props.useSession(value => value)
      const parentId = parent && (parent.sessionId || parent.id)
      const childId = useBranch(parentId === undefined ? undefined : tabKey(parentId, tab.id))
      const t = translator
      const label = childId === undefined ? t('tab.title') : sessionDisplayName(childId)
      return h('span', { style: styles.title }, label)
    }

    /** Closure-bound translator; slot registrations only carry `locale: NS`
     *  for bookkeeping — components read through this binding. */
    let translator = (key) => zh[key] || key

    const styles = {
      body: {
        width: '100%',
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        display: 'flex',
        position: 'relative',
      },
      center: {
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: 12,
        gap: 8,
      },
      spinner: {
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: '2px solid var(--dsw-alias-border-l1)',
        borderTopColor: 'var(--dsw-alias-label-tertiary)',
        animation: 'sidechat-spin 0.8s linear infinite',
      },
      errorPane: {
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        textAlign: 'center',
      },
      errorText: {
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-state-error-primary)',
        overflowWrap: 'anywhere',
      },
      retryButton: {
        height: 26,
        padding: '0 14px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-button-floating-fill)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }

    return {
      inject: ['sessions', 'slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        clientCtx = ctx
        recordDiag('module', 'native-fork')
        ctx.effect(() => {
          styles.spinnerKeyframes = document.head.appendChild(Object.assign(document.createElement('style'), {
            textContent: '@keyframes sidechat-spin{to{transform:rotate(360deg)}}',
          }))
          return () => styles.spinnerKeyframes.remove()
        }, 'side-chat: keyframes')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries')

        const t = ctx.locale.bind(NS)
        translator = t

        ctx.inject(['sidebarRightTabs'], () => {
          try {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            multiple: true,
            // Hold the body (and the Session view hosting it) while its session
            // is off screen: switching sessions must not unwind a live branch.
            keepMounted: true,
            title: () => t('tab.title'),
            guide: [{
              id: 'fork-chat',
              order: 90,
              title: () => t('guide.label'),
              description: () => t('guide.desc'),
            }],
          }), 'side-chat: tab type')
          } catch (error) {
            recordDiag('tab-type-failed', (error && error.stack) || error)
            throw error
          }
        })

        ctx.slots.inject('sidebar.right.pane.tab', () => { try { return ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          children: { [CONV_SLOT]: { kind: 'single', scope: 'session' } },
        }, ForkChatTab) } catch (error) { recordDiag('slot-tab-body-failed', (error && error.stack) || error); throw error } }, 'side-chat: tab body')

        ctx.slots.inject('sidebar.right.pane.tab.title', () => { try { return ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, BranchTitle) } catch (error) { recordDiag('slot-tab-title-failed', (error && error.stack) || error); throw error } }, 'side-chat: tab title')

        ctx.slots.inject(CONV_SLOT, () => { try { return ctx.slots.register({
          name: CONV_SLOT,
          locale: NS,
        }, ConversationPanel) } catch (error) { recordDiag('slot-conversation-failed', (error && error.stack) || error); throw error } }, 'side-chat: conversation')
      },
    }
  },
})

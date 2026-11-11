/**
 * Client half of Side Chat (侧边对话).
 *
 * Adds one guide entry to the official right Sidebar. Picking it forks the
 * session on screen (a real session, full inherited history, `increaseTitle`
 * suffixes the name) and opens the branch in a new `forkchat` tab that
 * renders the shared Conversation factory bound to the child session — the
 * same mechanism the shipped subagent Sidebar chat uses. The branch therefore
 * also shows in the left session list (archived sessions are read-only, so
 * hiding it there is not an option). Closing the tab asks whether to keep it
 * in the list or archive it; archiving the branch from the left list instead
 * closes the tab automatically, so a dead read-only side chat never lingers.
 *
 * A tab owns exactly one branch:
 *   - `keepMounted: true` keeps the body (and the official Session view that
 *     hosts it) mounted while another session is on screen, so switching
 *     sessions never unwinds a live side chat.
 *   - the tab → child-session mapping is persisted in localStorage, so a
 *     remount (full reload, session view retirement) re-binds the same branch
 *     instead of forking another one. Tab ids are minted per session, so the
 *     key is (session id, tab id), never the tab id alone.
 *
 * Structure mirrors @deepseek-ai/dsh-client-ui-subagent's registerSidebarChat:
 *   - one tab type (`forkchat`, page kind, `multiple: true`)
 *   - one tab body slot declaring a nested session-scoped conversation slot
 *   - one conversation slot rendering the shared `conversation.content`
 *     factory in `embedded` variant with the View fixed to Chat
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

    // The apply() ctx, captured for component closures: `ctx` is not a module
    // binding, so views reach services through this captured reference.
    let clientCtx = null

    const zh = {
      'guide.label': '侧边对话',
      'guide.desc': '把当前会话分出一个分支，在右栏继续聊',
      'tab.title': '侧边对话',
      'forking.label': '正在创建分支…',
      'fork.error': '创建分支失败',
      'close.title': '保留这个侧边对话？',
      'close.keep': '保留',
      'close.keepHint': '关闭标签页，会话留在左侧列表',
      'close.discard': '不保留',
      'close.discardHint': '关闭标签页并归档这个会话',
      'close.failed': '操作失败',
    }
    const en = {
      'guide.label': 'Side chat',
      'guide.desc': 'Fork the current session and keep chatting in the right sidebar',
      'tab.title': 'Side chat',
      'forking.label': 'Creating branch…',
      'fork.error': 'Failed to create branch',
      'close.title': 'Keep this side chat?',
      'close.keep': 'Keep',
      'close.keepHint': 'Close the tab; the session stays in the sidebar list',
      'close.discard': 'Discard',
      'close.discardHint': 'Close the tab and archive the session',
      'close.failed': 'Operation failed',
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

    // Session-catalog readers: a persisted branch is reused only while its
    // session still exists, so a stale mapping cannot resurrect a dead tab.
    function sessionsList() {
      try { return clientCtx.sessions.list.getSnapshot() } catch (_serviceUnavailable) { return undefined }
    }

    function sessionKnown(sessionId) {
      const list = sessionsList()
      return list !== undefined && list.byId[sessionId] !== undefined
    }

    function waitForSessionList() {
      return new Promise((resolve) => {
        let unsubscribe = () => {}
        const check = () => {
          const list = sessionsList()
          if (list !== undefined && list.phase === 'ready') {
            unsubscribe()
            resolve()
          }
        }
        try {
          unsubscribe = clientCtx.sessions.list.subscribe(check)
        } catch (_serviceUnavailable) {
          resolve()
          return
        }
        check()
      })
    }

    // Close confirmation. The Sidebar's close handler is synchronous and a
    // thrown handler preserves the tab, so a close attempt is blocked here,
    // the tab keeps rendering this body, and the dialog decides the outcome:
    // an accepted close is re-issued through ctx.sidebarRight.close().
    const closeGates = new Map()
    const closeListeners = new Set()
    const acceptedCloses = new Set()
    const archivedBranches = new Set()
    function setCloseGate(key, value) {
      if (value === undefined) closeGates.delete(key)
      else closeGates.set(key, value)
      closeListeners.forEach(fn => fn())
    }
    function useCloseGate(key) {
      const [state, setState] = React.useState(() => key === undefined ? undefined : closeGates.get(key))
      React.useEffect(() => {
        if (key === undefined) return undefined
        const fn = () => setState(closeGates.get(key))
        closeListeners.add(fn)
        fn()
        return () => closeListeners.delete(fn)
      }, [key])
      return state
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

    /**
     * How a close of a branch tab treats the session. `archive` archives the
     * branch and lets the tab close straight away; `ask` (active) blocks the
     * close and shows CloseConfirm: keep leaves the session in the left list,
     * discard archives it.
     */
    const CLOSE_MODE = 'ask'

    /**
     * Sidebar close handler for this tab kind. A tab still forking closes
     * straight away; a tab holding a branch blocks the close for the dialog,
     * which re-issues the close through ctx.sidebarRight.close().
     */
    function handleCloseRequest(sessionId, tab) {
      const key = tabKey(sessionId, tab.id)
      if (acceptedCloses.delete(key)) return
      const childId = readBranch(key)
      if (childId === undefined) return
      if (CLOSE_MODE === 'ask') {
        setCloseGate(key, 'confirming')
        throw new Error('side-chat: close awaits confirmation')
      }
      archiveBranch(key, childId)
    }

    /** Archive a branch session when it still exists; failures stay silent. */
    function archiveBranch(key, childId) {
      if (archivedBranches.has(key)) return
      archivedBranches.add(key)
      forgetBranch(key)
      clientCtx.uiWorkspace.archiveSession(childId).catch(() => {
        archivedBranches.delete(key)
      })
    }

    function sessionDisplayName(sessionId) {
      try {
        const row = clientCtx.sessions.list.getSnapshot().byId[sessionId]
        return (row && (row.title || row.name)) || sessionId
      } catch (_unknownStoreShape) {
        return sessionId
      }
    }

    /** Fixed Chat selection used by the embedded Conversation occurrence. */
    function FixedChatConversationView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /**
     * Render the shared Conversation content for the branch session, mirroring
     * the shipped sidebar chat panel: embedded variant, no width handles, no
     * main header. The ambient session is the branch (bound by the body's
     * SessionProvider); props.sessionId from the body wins when present.
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
     * Tab body: binds the tab's branch (reusing the persisted child, or
     * forking the session on screen on first open) and hosts the conversation
     * slot. `keepMounted` keeps this body alive while its session is off
     * screen; unmount only happens on tab close or a full reload, so the
     * branch mapping is never discarded here — the replacement mount resolves
     * the very same child instead of forking again.
     */
    function ForkChatTab(props) {
      const { tab } = props.useTabInfo()
      const parent = props.useSession(value => value)
      const parentId = parent && (parent.sessionId || parent.id)
      const key = parentId === undefined ? undefined : tabKey(parentId, tab.id)
      const gate = useCloseGate(key)
      const [bound, setBound] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [healSeq, setHealSeq] = React.useState(0)
      const bodyRef = React.useRef(null)
      const t = translator

      React.useEffect(() => {
        if (key === undefined || parentId === undefined) return undefined
        let cancelled = false
        let reference = null
        ;(async () => {
          try {
            let childId = readBranch(key)
            if (childId !== undefined && !sessionKnown(childId)) {
              await waitForSessionList()
              if (cancelled) return
              if (!sessionKnown(childId)) childId = undefined
            }
            if (childId === undefined) {
              childId = await clientCtx.sessions.fork({ sessionId: parentId, increaseTitle: true })
              if (cancelled) return
              rememberBranch(key, childId)
            }
            reference = clientCtx.sessions.retain(childId, { source: 'sideChat', signal: tab.signal })
            if (cancelled) {
              reference.release()
              reference = null
              return
            }
            setBound({ key, childId, reference })
          } catch (error) {
            if (!cancelled) setFailure({ key, error })
          }
        })()
        return () => {
          cancelled = true
          if (reference !== null) {
            try { reference.release() } catch (_alreadyReleased) { /* noop */ }
            reference = null
          }
        }
        // Resolve once per (session, tab); tab.signal is occurrence-scoped and
        // would re-run the fork path if it were a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key, parentId])

      // Archive watchdog. Archived sessions are read-only (prompting gets
      // blocked), so once the branch is archived from the left list the tab
      // has no purpose: clear the mapping and close this tab automatically.
      React.useEffect(() => {
        if (bound === null || bound.key !== key) return undefined
        let workspaces
        try { workspaces = clientCtx.uiWorkspace.workspaces } catch (_serviceUnavailable) { return undefined }
        const list = workspaces !== undefined ? workspaces.list : undefined
        if (list === undefined || typeof list.subscribe !== 'function') return undefined
        const sync = () => {
          if (acceptedCloses.has(bound.key)) return
          const snapshot = list.getSnapshot()
          if (snapshot === undefined || !Array.isArray(snapshot.archivedSessionIds)) return
          if (!snapshot.archivedSessionIds.includes(bound.childId)) return
          forgetBranch(bound.key)
          setCloseGate(bound.key, undefined)
          acceptedCloses.add(bound.key)
          clientCtx.sidebarRight.close(tab.id)
        }
        sync()
        const unsubscribe = list.subscribe(sync)
        return () => {
          try { unsubscribe() } catch (_alreadyUnsubscribed) { /* noop */ }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key, bound])

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

      if (failure !== null && failure.key === key) {
        const error = failure.error
        return h('div', { style: styles.center }, `${t('fork.error')}: ${(error && (error.message || error)) || ''}`)
      }
      if (bound === null || bound.key !== key) {
        return h('div', { style: styles.center, 'aria-busy': true }, h('div', { style: styles.spinner }))
      }
      return h('div', { style: styles.body, ref: bodyRef },
        h(props.SessionProvider, {
          key: `sidechat-conv-${healSeq}`,
          session: bound.reference,
        }, props.renderSlot(CONV_SLOT, { sessionId: bound.childId })),
        gate === 'confirming' ? h(CloseConfirm, { gateKey: key, tabId: tab.id, childId: bound.childId }) : null)
    }

    /**
     * The close confirmation. Mounted inside the tab body because the blocked
     * close keeps the body alive; keep closes the tab and leaves the branch in
     * the left list, discard archives it; both clear the branch mapping and
     * re-issue the close through the controller after marking it accepted.
     */
    function CloseConfirm(props) {
      const { gateKey, tabId, childId } = props
      const t = translator
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const cancel = React.useCallback(() => { setCloseGate(gateKey, undefined) }, [gateKey])

      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          cancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [cancel])

      const keep = () => {
        acceptedCloses.add(gateKey)
        forgetBranch(gateKey)
        setCloseGate(gateKey, undefined)
        clientCtx.sidebarRight.close(tabId)
      }

      const discard = async () => {
        if (busy) return
        setBusy(true)
        setFailure(null)
        try {
          await clientCtx.uiWorkspace.archiveSession(childId)
          forgetBranch(gateKey)
          acceptedCloses.add(gateKey)
          setCloseGate(gateKey, undefined)
          clientCtx.sidebarRight.close(tabId)
        } catch (error) {
          setFailure(`${t('close.failed')}: ${(error && (error.message || error)) || ''}`)
          setBusy(false)
        }
      }

      return h('div', { style: styles.overlay, onClick: cancel },
        h('div', { style: styles.dialog, onClick: (event) => event.stopPropagation() },
          h('div', { style: styles.dialogTitle }, t('close.title')),
          failure !== null ? h('div', { style: styles.dialogError }, failure) : null,
          h('div', { style: styles.dialogActions },
            h('button', {
              type: 'button',
              style: styles.button,
              title: t('close.discardHint'),
              disabled: busy,
              onClick: discard,
            }, t('close.discard')),
            h('button', {
              type: 'button',
              style: { ...styles.button, ...styles.buttonPrimary },
              title: t('close.keepHint'),
              disabled: busy,
              onClick: keep,
            }, t('close.keep')))))
    }

    /** Live tab chip: the branch session's display name. */
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
      overlay: {
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.28)',
        padding: 16,
      },
      dialog: {
        width: 260,
        maxWidth: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 12,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.2))',
      },
      dialogTitle: {
        fontSize: 13.5,
        lineHeight: 1.4,
        color: 'var(--dsw-alias-label-primary)',
      },
      dialogError: {
        fontSize: 11,
        lineHeight: 1.4,
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-word',
      },
      dialogActions: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
      },
      button: {
        height: 28,
        padding: '0 12px',
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      buttonPrimary: {
        background: 'var(--dsw-alias-interactive-bg-hover)',
        borderColor: 'transparent',
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
      title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }

    return {
      inject: ['sessions', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => {
          styles.spinnerKeyframes = document.head.appendChild(Object.assign(document.createElement('style'), {
            textContent: '@keyframes sidechat-spin{to{transform:rotate(360deg)}}',
          }))
          return () => styles.spinnerKeyframes.remove()
        }, 'side-chat: keyframes')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat: dictionaries')

        const t = ctx.locale.bind(NS)
        translator = t

        // Block the close of a tab that already holds a branch, so the body can
        // ask whether to keep the session. A thrown handler preserves the tab.
        ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, handleCloseRequest), 'side-chat: close handler')

        // Slot-scoped translator: slot registrations accept a `locale` and the
        // framework hands components a bound `t` prop.
        ctx.inject(['sidebarRightTabs'], () => {
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
        })

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          children: { [CONV_SLOT]: { kind: 'single', scope: 'session' } },
        }, ForkChatTab), 'side-chat: tab body')

        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, BranchTitle), 'side-chat: tab title')

        ctx.slots.inject(CONV_SLOT, () => ctx.slots.register({
          name: CONV_SLOT,
          locale: NS,
        }, ConversationPanel), 'side-chat: conversation')
      },
    }
  },
})

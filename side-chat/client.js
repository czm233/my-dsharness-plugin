/**
 * Client half of Side Chat (侧边对话), fork-subagent edition.
 *
 * The guide entry opens a first-message surface in the official right
 * Sidebar; sending the first message asks the Host half to create a
 * continuable child session through the `fork` subagent backend
 * (`dsh-subagent-fork-in-process`), whose seed is the parent's completed
 * conversation turns — the child continues this conversation with full
 * inherited context. The tab then renders the shared Conversation factory
 * bound to that child, exactly like the shipped subagent Sidebar chat;
 * the session's own subagent projections drive delivery, queueing, and the
 * composer semantics.
 *
 * Subagent children never join the left session list, so there is no
 * archive interplay at all: closing the tab only closes the tab, and the
 * child stays reachable from the parent's subagent catalog.
 *
 * A tab owns exactly one child:
 *   - `keepMounted: true` keeps the body mounted while another session or
 *     tab is on screen, so a live side chat never unwinds.
 *   - the tab → child mapping is persisted in localStorage, so a remount
 *     (full reload, session view retirement) re-binds the same child.
 *     Tab ids are minted per session, so the key is (session id, tab id).
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
    const CREATE_PATH = '/api/side-chat/create'

    // The apply() ctx, captured for component closures: `ctx` is not a module
    // binding, so views reach services through this captured reference.
    let clientCtx = null

    const zh = {
      'guide.label': '侧边对话',
      'guide.desc': '把当前会话分出一个分支，在右栏继续聊',
      'tab.title': '侧边对话',
      'first.placeholder': '发消息，开始侧边对话',
      'first.send': '发送',
      'fork.error': '创建分支失败',
    }
    const en = {
      'guide.label': 'Side chat',
      'guide.desc': 'Fork the current session and keep chatting in the right sidebar',
      'tab.title': 'Side chat',
      'first.placeholder': 'Send a message to start this side chat',
      'first.send': 'Send',
      'fork.error': 'Failed to create branch',
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
     * Render the shared Conversation content for the branch child session,
     * mirroring the shipped sidebar chat panel: embedded variant, no width
     * handles, no main header. The ambient session is the child (bound by the
     * body's SessionProvider); props.sessionId from the body wins when
     * present. The child session's subagent projections drive delivery.
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
     * First-message surface shown until the child exists. Sending posts the
     * text to the Host route, which creates the fork-backend child with the
     * parent's inherited context; the draft survives a failed attempt.
     */
    function FirstMessage({ onSend, pending, failure, t }) {
      const [draft, setDraft] = React.useState('')
      const submit = async () => {
        const text = draft.trim()
        if (text === '' || pending) return
        const ok = await onSend(text)
        if (ok) setDraft('')
      }
      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        event.preventDefault()
        submit()
      }
      return h('div', { style: styles.firstWrap },
        h('textarea', {
          style: styles.firstInput,
          value: draft,
          placeholder: t('first.placeholder'),
          'aria-label': t('guide.label'),
          disabled: pending,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown,
        }),
        h('div', { style: styles.firstRow },
          failure !== null ? h('div', { style: styles.firstError }, `${t('fork.error')}: ${failure}`) : null,
          h('button', {
            type: 'button',
            style: { ...styles.firstSend, ...(pending ? styles.firstSendBusy : null) },
            disabled: pending || draft.trim() === '',
            onClick: submit,
          }, t('first.send'))))
    }

    /**
     * Tab body: binds the tab's child (creating it from the first message, or
     * re-binding the persisted one) and hosts the conversation slot.
     * `keepMounted` keeps this body alive while its session is off screen;
     * unmount only happens on tab close or a full reload, so the branch
     * mapping is never discarded here — the replacement mount resolves the
     * very same child.
     */
    function ForkChatTab(props) {
      const { tab } = props.useTabInfo()
      const parent = props.useSession(value => value)
      const parentId = parent && (parent.sessionId || parent.id)
      const key = parentId === undefined ? undefined : tabKey(parentId, tab.id)
      const childId = useBranch(key)
      const [bound, setBound] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [healSeq, setHealSeq] = React.useState(0)
      const bodyRef = React.useRef(null)
      const t = translator

      // Create the child from the first message through the Host route.
      const send = React.useCallback(async (text) => {
        if (key === undefined || parentId === undefined || pending) return false
        setPending(true)
        setFailure(null)
        try {
          const response = await fetch(CREATE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: parentId, text }),
          })
          const payload = typeof response.json === 'function' ? await response.json() : undefined
          if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
          if (payload === undefined || typeof payload.childId !== 'string' || payload.childId === '') throw new Error('missing childId')
          rememberBranch(key, payload.childId)
          return true
        } catch (error) {
          setFailure(String((error && error.message) || error))
          return false
        } finally {
          setPending(false)
        }
      }, [key, parentId, pending])

      // Retain the child through its durable direct-parent address once the
      // mapping holds one; a reference whose session no longer resolves drops
      // the stale mapping so the tab falls back to the first-message surface.
      React.useEffect(() => {
        if (childId === undefined || parentId === undefined) return undefined
        const address = { parentSessionId: parentId, childSessionId: childId, mode: 'continuable' }
        let reference = null
        let cancelled = false
        try {
          reference = clientCtx.sessions.retain(address, { source: 'sideChat', signal: tab.signal })
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
      }, [childId, parentId])

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

      if (childId !== undefined && (bound === null || bound.childId !== childId)) {
        return h('div', { style: styles.center, 'aria-busy': true }, h('div', { style: styles.spinner }))
      }
      return h('div', { style: styles.body, ref: bodyRef },
        bound !== null && bound.childId === childId
          ? h(props.SessionProvider, {
              key: `sidechat-conv-${healSeq}`,
              session: bound.reference,
            }, props.renderSlot(CONV_SLOT, { sessionId: bound.childId }))
          : h(FirstMessage, { onSend: send, pending, failure, t }))
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
      firstWrap: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 10,
        padding: 16,
      },
      firstInput: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 96,
        maxHeight: 220,
        resize: 'none',
        borderRadius: 12,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-specific-input-major)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: 1.5,
        padding: '10px 12px',
        outline: 'none',
      },
      firstRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        minHeight: 24,
      },
      firstError: {
        marginRight: 'auto',
        fontSize: 11,
        lineHeight: 1.4,
        color: 'var(--dsw-alias-state-error-primary)',
        wordBreak: 'break-word',
      },
      firstSend: {
        height: 28,
        padding: '0 14px',
        borderRadius: 999,
        border: 'none',
        background: 'var(--dsw-alias-button-info-fill)',
        color: '#fff',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      firstSendBusy: {
        opacity: 0.6,
        cursor: 'default',
      },
      title: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }

    return {
      inject: ['sessions', 'slots', 'locale', 'sidebarRightTabs'],
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

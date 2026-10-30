/**
 * Client half of Side Chat (侧边对话).
 *
 * Adds one guide entry to the official right Sidebar. Picking it forks the
 * session on screen (a real session, full inherited history, `increaseTitle`
 * suffixes the name) and opens the branch in a new `forkchat` tab that
 * renders the shared Conversation factory bound to the child session — the
 * same mechanism the shipped subagent Sidebar chat uses. Closing the tab
 * releases only the view; the branch session stays in the left sidebar.
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
    }
    const en = {
      'guide.label': 'Side chat',
      'guide.desc': 'Fork the current session and keep chatting in the right sidebar',
      'tab.title': 'Side chat',
      'forking.label': 'Creating branch…',
      'fork.error': 'Failed to create branch',
    }

    // Module-level map: tab id -> branch record. The tab body writes it after
    // the fork resolves; the live title chip reads it so every tab chip shows
    // its own branch session name.
    const branches = new Map()
    const branchListeners = new Set()
    function setBranch(tabId, record) {
      branches.set(tabId, record)
      branchListeners.forEach(fn => fn())
    }
    function dropBranch(tabId) {
      if (branches.delete(tabId)) branchListeners.forEach(fn => fn())
    }
    function useBranch(tabId) {
      const [record, setRecord] = React.useState(() => branches.get(tabId))
      React.useEffect(() => {
        const fn = () => setRecord(branches.get(tabId))
        branchListeners.add(fn)
        fn()
        return () => branchListeners.delete(fn)
      }, [tabId])
      return record
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
     * Tab body: forks the session on screen once, binds the branch reference
     * and hosts the conversation slot. Unmount (tab close, session switch)
     * releases only the view reference; the branch session itself survives.
     */
    function ForkChatTab(props) {
      const { tab } = props.useTabInfo()
      const parent = props.useSession(value => value)
      const branch = useBranch(tab.id)
      const t = translator

      React.useEffect(() => {
        if (branch) return undefined
        const parentId = parent && (parent.sessionId || parent.id)
        if (!parentId) return undefined
        let released = false
        let reference = null
        ;(async () => {
          try {
            const childId = await clientCtx.sessions.fork({ sessionId: parentId, increaseTitle: true })
            if (released) return
            reference = clientCtx.sessions.retain(childId, { source: 'sideChat', signal: tab.signal })
            setBranch(tab.id, { childId, reference })
          } catch (error) {
            if (!released) setBranch(tab.id, { error })
          }
        })()
        return () => {
          released = true
          if (reference) {
            try { reference.release() } catch (_alreadyReleased) { /* noop */ }
          }
          dropBranch(tab.id)
        }
        // Fork exactly once per tab occurrence.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [tab.id])

      if (branch && branch.error) {
        return h('div', { style: styles.center }, `${t('fork.error')}: ${branch.error.message || branch.error}`)
      }
      if (!branch || !branch.reference) {
        return h('div', { style: styles.center, 'aria-busy': true }, h('div', { style: styles.spinner }))
      }
      return h(props.SessionProvider, { session: branch.reference }, props.renderSlot(CONV_SLOT, { sessionId: branch.childId }))
    }

    /** Live tab chip: the branch session's display name. */
    function BranchTitle(props) {
      const { tab } = props.useTabInfo()
      const branch = useBranch(tab.id)
      const t = translator
      let label = t('tab.title')
      if (branch && branch.childId) {
        label = sessionDisplayName(branch.childId)
      }
      return h('span', { style: styles.title }, label)
    }

    /** Closure-bound translator; slot registrations only carry `locale: NS`
     *  for bookkeeping — components read through this binding. */
    let translator = (key) => zh[key] || key

    const styles = {
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
      inject: ['sessions', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
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

        // Slot-scoped translator: slot registrations accept a `locale` and the
        // framework hands components a bound `t` prop.
        ctx.inject(['sidebarRightTabs'], () => {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            multiple: true,
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

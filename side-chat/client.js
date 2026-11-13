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
 * Before that child exists the tab is not empty: it shows the parent's own
 * recent turns as a read-only preview read from the live Session event feed,
 * so the reply that prompted the side chat can be read (and quoted) right
 * away. A selection made there offers a quote action that appends the
 * selection to the side-chat draft as a Markdown blockquote. The preview is
 * text-only and never mounts the parent's conversation surface, so the main
 * pane keeps its composer, draft, and scroll state untouched.
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

    // The shell provides the shared primitives module to every client plugin
    // (the shipped quote plugin requires it the same way). A build that lacks
    // it degrades to plain text instead of failing the module load.
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') ?? null } catch (_unavailable) { return null }
    })()
    const MarkdownText = primitives !== null && typeof primitives.MarkdownText === 'function'
      ? primitives.MarkdownText
      : null

    /** Turns of the parent conversation the pre-branch preview shows. */
    const PREVIEW_TURNS = 6
    /** Longest selection a single quote action carries. */
    const QUOTE_LIMIT = 4000

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
      'quote.add': '引用',
      'markdown.copy': '复制',
      'markdown.copied': '已复制',
      'markdown.code': '代码',
      'markdown.wrap': '换行',
      'markdown.unwrap': '不换行',
      'markdown.footnotes': '脚注',
    }
    const en = {
      'guide.label': 'Side chat',
      'guide.desc': 'Fork the current session and keep chatting in the right sidebar',
      'tab.title': 'Side chat',
      'first.placeholder': 'Send a message to start this side chat',
      'first.send': 'Send',
      'fork.error': 'Failed to create branch',
      'quote.add': 'Quote',
      'markdown.copy': 'Copy',
      'markdown.copied': 'Copied',
      'markdown.code': 'Code',
      'markdown.wrap': 'Wrap',
      'markdown.unwrap': 'Unwrap',
      'markdown.footnotes': 'Footnotes',
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

    /**
     * Markdown labels for standalone text rendering. The chat View builds the
     * same shape from its own dictionary; only code blocks and footnotes read
     * these.
     * @param t - translator bound to this plugin's namespace.
     * @returns labels accepted by the primitives MarkdownText.
     */
    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('markdown.copy'),
          copiedLabel: t('markdown.copied'),
          toolbarLabels: {
            codeLabel: t('markdown.code'),
            wrapLabel: t('markdown.wrap'),
            unwrapLabel: t('markdown.unwrap'),
          },
        },
        footnotes: t('markdown.footnotes'),
      }
    }

    /** Concatenated text blocks of one message content array. */
    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (block.type !== 'text' || typeof block.text !== 'string') continue
        if (block.text.trim() === '') continue
        parts.push(block.text)
      }
      return parts.join('\n\n').trim()
    }

    /**
     * Read the parent's recent visible turns from the live Session event feed.
     * Only the human's own prompts and the assistant's committed text qualify:
     * context reminders (their source kinds differ) and tool traffic stay out,
     * so the preview reads as the conversation the user remembers.
     * @param parentId - owning session identity, when known.
     * @returns the last {@link PREVIEW_TURNS} messages, oldest first.
     */
    function previewMessages(parentId) {
      if (parentId === undefined || clientCtx === null || clientCtx === undefined) return []
      let binding
      try {
        binding = typeof clientCtx.sessions.binding === 'function' ? clientCtx.sessions.binding(parentId) : undefined
      } catch (_bindingUnavailable) {
        return []
      }
      if (binding === undefined || binding.eventSource === undefined) return []
      const payload = binding.eventSource.getSnapshot()
      const entries = payload !== null && payload !== undefined && Array.isArray(payload.entries) ? payload.entries : []
      const messages = []
      // One reply per turn: a multi-step turn narrates between tool calls, and
      // only its last text is the answer worth re-reading.
      const replyAt = new Map()
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || entry.type === 'transient') continue
        const event = entry.event
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'user/message') {
          const source = event.data !== undefined ? event.data.source : undefined
          if (source !== undefined && source.kind !== 'user') continue
          const text = textOfContent(event.data !== undefined ? event.data.content : undefined)
          if (text !== '') messages.push({ key: `u${event.seq}`, role: 'user', text })
          continue
        }
        if (event.type === 'assistant/message') {
          const message = event.data !== undefined ? event.data.message : undefined
          const text = textOfContent(message !== undefined ? message.content : undefined)
          if (text === '') continue
          const turn = event.data !== undefined && typeof event.data.turn === 'number' ? event.data.turn : undefined
          const previous = turn === undefined ? undefined : replyAt.get(turn)
          if (previous !== undefined) {
            messages[previous] = { key: `a${event.seq}`, role: 'assistant', text }
            continue
          }
          messages.push({ key: `a${event.seq}`, role: 'assistant', text })
          if (turn !== undefined) replyAt.set(turn, messages.length - 1)
        }
      }
      return messages.slice(-PREVIEW_TURNS)
    }

    /** Subscribe the preview to the parent's live event window. */
    function usePreviewMessages(parentId) {
      const [messages, setMessages] = React.useState(() => previewMessages(parentId))
      React.useEffect(() => {
        setMessages(previewMessages(parentId))
        if (parentId === undefined) return undefined
        let binding
        try {
          binding = typeof clientCtx.sessions.binding === 'function' ? clientCtx.sessions.binding(parentId) : undefined
        } catch (_bindingUnavailable) {
          return undefined
        }
        if (binding === undefined || binding.eventSource === undefined) return undefined
        if (typeof binding.eventSource.subscribe !== 'function') return undefined
        return binding.eventSource.subscribe(() => setMessages(previewMessages(parentId)))
      }, [parentId])
      return messages
    }

    /**
     * Render one message body. Falls back to the literal text when the shared
     * Markdown renderer is unavailable or throws, so the preview can never take
     * the tab down with it.
     */
    function MessageText(props) {
      if (MarkdownText === null) return h('div', { style: styles.plainText }, props.text)
      return h(MarkdownBoundary, { fallback: props.text },
        h(MarkdownText, { text: props.text, labels: props.labels }))
    }

    /** Contain one markdown failure inside the preview. */
    const MarkdownBoundary = typeof React.Component === 'function'
      ? class MarkdownBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }

        static getDerivedStateFromError() {
          return { failed: true }
        }

        render() {
          if (!this.state.failed) return this.props.children
          return h('div', { style: styles.plainText }, this.props.fallback)
        }
      }
      : function MarkdownPassthrough(props) {
        return props.children
      }

    /**
     * Read-only transcript of the parent's recent turns, shown while the tab
     * has no branch yet. Selecting text inside it offers the quote action at
     * the selection, so a passage can be carried into the side-chat draft
     * without leaving the tab.
     */
    function ParentPreview(props) {
      const { messages, onQuote, t } = props
      const hostRef = React.useRef(null)
      const [pending, setPending] = React.useState(null)
      const tailKey = messages.length === 0 ? '' : messages[messages.length - 1].key
      const labels = React.useMemo(() => markdownLabels(t), [t])

      // Follow the live tail so a reply that lands while the tab is open stays
      // in view without the user chasing it.
      React.useEffect(() => {
        const host = hostRef.current
        if (host !== null && host !== undefined) host.scrollTop = host.scrollHeight
      }, [tailKey])

      React.useEffect(() => {
        const host = hostRef.current
        if (host === null || host === undefined) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const review = () => {
          const selection = typeof window !== 'undefined' && typeof window.getSelection === 'function'
            ? window.getSelection()
            : null
          if (selection === null || selection.isCollapsed || selection.rangeCount === 0) { setPending(null); return }
          const range = selection.getRangeAt(0)
          if (!host.contains(range.commonAncestorContainer)) { setPending(null); return }
          const text = selection.toString().trim()
          if (text === '') { setPending(null); return }
          const box = range.getBoundingClientRect()
          const base = host.getBoundingClientRect()
          setPending({
            text: text.length > QUOTE_LIMIT ? text.slice(0, QUOTE_LIMIT) : text,
            top: Math.max(2, box.top - base.top + host.scrollTop - 32),
            left: Math.max(2, box.left - base.left),
          })
        }
        // The selection settles after the pointer/key event itself.
        const defer = () => setTimeout(review, 0)
        document.addEventListener('pointerup', defer)
        document.addEventListener('keyup', defer)
        return () => {
          document.removeEventListener('pointerup', defer)
          document.removeEventListener('keyup', defer)
        }
      }, [])

      return h('div', {
        ref: hostRef,
        style: styles.preview,
        'data-sidechat-preview': '',
        onScroll: () => setPending(null),
      },
        messages.map(message => message.role === 'user'
          ? h('div', { key: message.key, style: styles.previewUser }, message.text)
          : h('div', { key: message.key, style: styles.previewAssistant },
            h(MessageText, { text: message.text, labels }))),
        pending === null ? null : h('button', {
          type: 'button',
          style: { ...styles.quoteAction, top: pending.top, left: pending.left },
          onPointerDown: (event) => event.preventDefault(),
          onClick: () => {
            onQuote(pending.text)
            setPending(null)
          },
        }, t('quote.add')))
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
     * First-message composer shown until the child exists. Sending posts the
     * text to the Host route, which creates the fork-backend child with the
     * parent's inherited context; the draft survives a failed attempt. The
     * draft is owned by the tab so the preview's quote action can append to it.
     */
    function FirstMessage({ onSend, pending, failure, t, draft, onDraftChange, inputRef, centered }) {
      const submit = async () => {
        const text = draft.trim()
        if (text === '' || pending) return
        const ok = await onSend(text)
        if (ok) onDraftChange('')
      }
      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
        event.preventDefault()
        submit()
      }
      return h('div', { style: centered ? styles.firstWrapCentered : styles.firstWrap },
        h('textarea', {
          ref: inputRef,
          style: styles.firstInput,
          value: draft,
          placeholder: t('first.placeholder'),
          'aria-label': t('guide.label'),
          disabled: pending,
          onChange: (event) => onDraftChange(event.target.value),
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
      const [draft, setDraft] = React.useState('')
      const [caretSeq, setCaretSeq] = React.useState(0)
      const bodyRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const t = translator

      // The parent transcript is previewed only until this tab owns a branch;
      // once the child exists its own inherited history replaces it.
      const previews = usePreviewMessages(childId === undefined ? parentId : undefined)

      // Carry a preview selection into the draft as a Markdown blockquote,
      // then hand the caret back to the composer.
      const insertQuote = React.useCallback((text) => {
        const quoted = text
          .split('\n')
          .map(line => line.trim() === '' ? '>' : `> ${line}`)
          .join('\n')
        setDraft(current => current.trim() === ''
          ? `${quoted}\n`
          : `${current.replace(/\s+$/, '')}\n\n${quoted}\n`)
        setCaretSeq(seq => seq + 1)
      }, [])

      React.useEffect(() => {
        if (caretSeq === 0) return
        const node = inputRef.current
        if (node === null || node === undefined) return
        node.focus()
        const end = node.value.length
        try { node.setSelectionRange(end, end) } catch (_unsupported) { /* noop */ }
      }, [caretSeq])

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
          : h('div', { style: styles.firstPane, 'data-sidechat-pane': '' },
              previews.length === 0
                ? null
                : h(ParentPreview, { messages: previews, onQuote: insertQuote, t }),
              h(FirstMessage, {
                onSend: send,
                pending,
                failure,
                t,
                draft,
                onDraftChange: setDraft,
                inputRef,
                centered: previews.length === 0,
              })))
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
      firstPane: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      },
      preview: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: '14px 16px 6px',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-primary)',
        userSelect: 'text',
      },
      previewUser: {
        alignSelf: 'flex-end',
        maxWidth: '90%',
        padding: '8px 11px',
        borderRadius: 12,
        background: 'var(--dsw-specific-input-major)',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      previewAssistant: {
        minWidth: 0,
        overflowWrap: 'anywhere',
      },
      plainText: {
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      },
      quoteAction: {
        position: 'absolute',
        zIndex: 30,
        height: 26,
        padding: '0 10px',
        borderRadius: 999,
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-button-floating-fill)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: 'var(--dsw-elevation-panel)',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      firstWrap: {
        flex: 'none',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px 16px 14px',
      },
      firstWrapCentered: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 8,
        padding: '16px 16px 40px',
      },
      firstInput: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 64,
        maxHeight: 200,
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

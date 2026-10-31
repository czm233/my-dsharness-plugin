/**
 * edit-restart（修改重发） · Client half
 *
 * 官方 Chat 不对外提供「用户消息操作行」的挂载点，所以这里走 DOM 装饰的路子，
 * 但严格守住两条底线（PITFALLS #6）：
 *   1. 只给「当前会话」的气泡列容器加 class / 属性，绝不往 Chat 里插陌生节点；
 *   2. 「修改」按钮、编辑框、「已修改」标记都由应用内的独立 React 根渲染，再搬进目标列，
 *      搬的永远只有自己渲染出来的节点。
 *
 * 交互：
 *   1. 用户消息的复制行旁边出现一个「修改」按钮（挂在最新一条用户消息上）；
 *   2. 点它就地展开编辑框（气泡列竖排：气泡 → 修改 → 复制 → 编辑框 → 标记）；
 *   3. 点发送：按这条消息所在轮次的 turn/start 原生 fork 出新会话，再把改过的文本
 *      作为新会话第一条消息发出（原会话原样保留），然后切到分支会话；
 *   4. 改过的那条消息在本次页面加载内保留「已修改」标记。
 *
 * 定位方式：消息 index = 它在当前会话里的第几条用户消息（官方气泡列 *_userRow），
 * 会话记录里按同样规则数 append 的人发 user/message；对不上就明确报错，不会误改别的消息。
 */

window.__ModuleLoader__.load({
  id: '@local/edit-restart',
  factory(require) {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const h = React.createElement

    const NS = 'editRestart'
    const LOG = '[edit-restart]'
    const P = 'dsh-edit-restart'
    const HOST_ATTR = 'data-edit-restart-host'
    const LAYER_ATTR = 'data-edit-restart-layer'
    const ACTION_ATTR = 'data-edit-restart-action'
    const MARKER_ATTR = 'data-edit-restart-marker'
    const READY_ATTR = 'data-edit-restart-ready'
    const INDEX_ATTR = 'data-edit-restart-index'
    const EDITED_ATTR = 'data-edit-restart-edited'
    const COLUMN_CLASS = `${P}-column`

    const zh = {
      'action': '修改',
      'title': '修改这条消息并重发',
      'cancel': '取消',
      'send': '发送',
      'saveDraft': '保存草稿',
      'draftSaved': '草稿已保存到 ~/.dsh/storages/edit-restart/drafts.json',
      'sending': '生成分支并发送…',
      'needText': '内容不能为空',
      'busy': '会话正在运行，结束后再修改',
      'stale': '找不到这条消息，可能已不在当前记录里',
      'forkFailed': '创建分支失败：{message}',
      'sendFailed': '分支已创建，但发送失败：{message}',
      'edited': '已修改',
      'editedTitle': '由这条消息改出，原会话保留',
    }
    const en = {
      'action': 'Edit',
      'title': 'Edit this message and resend',
      'cancel': 'Cancel',
      'send': 'Send',
      'saveDraft': 'Save draft',
      'draftSaved': 'Draft saved to ~/.dsh/storages/edit-restart/drafts.json',
      'sending': 'Branching and sending…',
      'needText': 'Message cannot be empty',
      'busy': 'Wait for the session to finish running',
      'stale': 'This message is no longer in the session record',
      'forkFailed': 'Could not create the branch: {message}',
      'sendFailed': 'Branch created, but sending failed: {message}',
      'edited': 'Edited',
      'editedTitle': 'Branched from this message; the original session is kept',
    }

    /** `${conversation session}|${index}` → 分支会话 id（只在本次页面加载内有效）。 */
    const editedAt = new Map()
    /** 正在重发的源会话 id。 */
    const resending = new Set()

    // ---- 官方 DOM 的发现与校验（0.2.1-rc.5 实测结构）----
    // 一条用户消息的真实 DOM：
    //   [class*="_userRow"]（气泡列：竖排 flex、右对齐）
    //     ├─ [class*="_userStack"]（气泡本体：文字/附件）
    //     └─ [class*="_actions"]（操作行：复制等图标按钮）
    // 哈希前缀随版本变，只认类名后缀。
    const tagOf = (node) => String(node?.localName ?? node?.tagName ?? '').toLowerCase()
    const isTag = (node, tag) => !!node && node.nodeType === 1 && tagOf(node) === tag
    const classListOf = (node) => String(node?.getAttribute?.('class') || '').split(/\s+/).filter(Boolean)
    const hasClassLike = (node, suffix) => classListOf(node).some((name) => name.endsWith(suffix))

    /**
     * 认出一条用户消息：气泡列（_userRow）、气泡本体（_userStack）、操作行（含按钮）与按钮列表。
     * 结构对不上一律返回 null，调用方不得装饰。
     */
    function userMessageIn(row) {
      if (!hasClassLike(row, '_userRow')) return null
      let bubble = null
      let actions = null
      for (const child of Array.from(row.children)) {
        if (hasClassLike(child, '_userStack') && bubble === null && child.querySelector('button') === null) {
          bubble = child
          continue
        }
        if (actions === null && child.querySelector('button') !== null) actions = child
      }
      if (bubble === null || actions === null) return null
      const buttons = Array.from(actions.querySelectorAll('button'))
      if (buttons.length === 0) return null
      return { row, bubble, actions, buttons }
    }

    /** 枚举当前会话内容区里每一条用户消息（返回顺序即先后）。 */
    function scanChat(host) {
      const found = []
      for (const node of host.querySelectorAll('div')) {
        if (!hasClassLike(node, '_userRow')) continue
        const hit = userMessageIn(node)
        if (hit !== null) found.push(hit)
      }
      return found
    }

    /** 消息所属会话：取最近的 data-conversation-session 宿主。 */
    const sessionIdOfHost = (host) => {
      const value = host.getAttribute('data-conversation-session')
      return value === null || value === '' ? null : value
    }

    // ---- 会话记录读取（走 client session 正式接口，不解析 DOM 内容） ----
    const isHumanMessage = (event) => !!event && typeof event === 'object'
      && event.type === 'user/message'
      && event.surfaceOp === 'append'
      && event.data?.source?.kind === 'user'

    /** 把可编辑部分拼回文本；附件用占位符表达（编辑器不复制二进制）。 */
    function editableText(content) {
      const parts = []
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
        else if (block?.type === 'image') parts.push('[图片]')
        else if (block?.type === 'file') parts.push(`[文件 ${block.file?.name ?? ''}]`)
      }
      return parts.join('\n\n')
    }

    const entriesOf = (session) => {
      const snapshot = session?.events?.getSnapshot?.()
      const entries = snapshot?.entries
      return Array.isArray(entries) ? entries : []
    }

    /** 兼容两种装载方式：entries 里直接是事件，或包一层 { event }。 */
    const eventOf = (entry) => {
      if (!entry || typeof entry !== 'object') return undefined
      if (typeof entry.type === 'string' && typeof entry.seq === 'number') return entry
      if (entry.event && typeof entry.event.type === 'string') return entry.event
      return undefined
    }

    /** 第 index 条人发消息（只数 append 的人发消息，与 Chat 渲染的口径一致）。 */
    function humanMessage(entries, index) {
      let seen = 0
      for (const entry of entries) {
        const event = eventOf(entry)
        if (!isHumanMessage(event)) continue
        if (seen === index) return event
        seen += 1
      }
      return undefined
    }

    /** 这条消息所属轮次的 turn/start seq（它开出来的那一轮）。 */
    function turnStartFor(entries, messageSeq) {
      let answer
      for (const entry of entries) {
        const event = eventOf(entry)
        if (!event) continue
        if (event.seq > messageSeq) break
        if (event.type === 'turn/start') answer = event.seq
      }
      return answer
    }

    const PENCIL = 'M9.9 2.6a1.3 1.3 0 0 1 1.85 0l1.65 1.65a1.3 1.3 0 0 1 0 1.85L6.1 13.4l-3.35.7.7-3.35L9.9 2.6Z'
    const CHECK = 'M3.5 8.5l3 3 6-6.5'

    const CSS = [
      // 气泡列竖排：气泡(默认 0) → 修改(1) → 复制(2) → 编辑框(3) → 标记(4)
      `.${COLUMN_CLASS}{gap:6px;}`,
      // 操作行（复制按钮那一格）排在「修改」按钮后面：气泡 → 修改 → 复制
      `[${HOST_ATTR}] .${COLUMN_CLASS} > [class*="_actions"]{order:2 !important;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${ACTION_ATTR}]{
  order:1 !important;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:0 0;border:none;
  justify-content:center;align-items:center;padding:6px;display:inline-flex;flex:0 0 auto;cursor:pointer;font:inherit;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${ACTION_ATTR}] svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${ACTION_ATTR}]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${ACTION_ATTR}][aria-disabled="true"]{cursor:default;opacity:.4;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${ACTION_ATTR}][aria-disabled="true"]:hover{background:0 0;color:var(--dsw-alias-label-tertiary);}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > [${LAYER_ATTR}]{order:3 !important;display:none;width:100%;box-sizing:border-box;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > [${LAYER_ATTR}][data-active="true"]{display:flex;}`,
      // 编辑器卡片
      `[${LAYER_ATTR}]{flex-direction:column;gap:8px;padding:10px;border-radius:14px;text-align:left;
  background:var(--dsw-alias-bg-elevated,#26262b);border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  box-shadow:0 14px 36px rgba(0,0,0,.38);color:var(--dsw-alias-label-primary,#e8e8ea);}`,
      `[${LAYER_ATTR}] textarea{box-sizing:border-box;width:100%;min-height:60px;max-height:40vh;resize:vertical;
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));border-radius:10px;padding:9px 12px;
  background:var(--dsw-specific-bubble,rgba(255,255,255,.06));color:inherit;font:inherit;font-size:14px;
  line-height:22px;outline:none;white-space:pre-wrap;}`,
      `[${LAYER_ATTR}] textarea:focus{border-color:var(--dsw-alias-button-primary-fill,#4c8bf5);}`,
      `[${LAYER_ATTR}] .${P}-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;}`,
      `[${LAYER_ATTR}] .${P}-note{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f28b82);}`,
      `[${LAYER_ATTR}] .${P}-hint{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8f8f97);}`,
      `[${LAYER_ATTR}] button{appearance:none;cursor:pointer;font:inherit;font-size:13px;line-height:18px;border-radius:999px;padding:5px 14px;border:1px solid transparent;}`,
      `[${LAYER_ATTR}] .${P}-cancel{background:transparent;border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#cfcfd4);}`,
      `[${LAYER_ATTR}] .${P}-send{background:var(--dsw-alias-button-primary-fill,#4c8bf5);color:#fff;}`,
      `[${LAYER_ATTR}] .${P}-draft{background:transparent;border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#cfcfd4);}`,
      `[${LAYER_ATTR}] button:disabled{opacity:.5;cursor:default;}`,
      // 已修改标记
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${MARKER_ATTR}]{order:4 !important;display:none;
  width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:0 0;border:none;
  justify-content:center;align-items:center;padding:6px;flex:0 0 auto;cursor:default;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${MARKER_ATTR}] svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS}[${EDITED_ATTR}="true"] > button[${MARKER_ATTR}]{display:inline-flex;}`,
    ].join('\n')

    // ---- 「修改」按钮 ----
    function ActionButton(props) {
      const { t, onOpen } = props
      return h('button', {
        type: 'button',
        [ACTION_ATTR]: '',
        title: t('action'),
        'aria-label': t('action'),
        onClick: (event) => {
          event.stopPropagation()
          event.preventDefault()
          onOpen()
        },
      }, h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: PENCIL, stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' })))
    }

    /** 编辑框：回车发送（direct），或点「保存草稿」交给 Host（save）。 */
    function MessageLayer(props) {
      const { t, initial, onClose, onSubmit } = props
      const [text, setText] = React.useState(initial)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [done, setDone] = React.useState('')
      const boxRef = React.useRef(null)
      const closedRef = React.useRef(false)

      React.useLayoutEffect(() => {
        const box = boxRef.current
        if (box === null) return
        box.focus()
        box.setSelectionRange(box.value.length, box.value.length)
      }, [])

      const cancel = () => {
        if (busy || closedRef.current) return
        closedRef.current = true
        onClose()
      }

      const submit = async () => {
        if (busy || closedRef.current) return
        const next = text.trim()
        if (next === '') {
          setError(t('needText'))
          return
        }
        setBusy(true)
        setError('')
        try {
          const result = await onSubmit(next, 'direct')
          closedRef.current = true
          onClose()
          window.setTimeout(() => { void result }, 0)
        } catch (failure) {
          setBusy(false)
          setError(String(failure?.message ?? failure))
        }
      }

      const saveDraft = async () => {
        if (busy || closedRef.current) return
        const next = text.trim()
        if (next === '') {
          setError(t('needText'))
          return
        }
        setBusy(true)
        setError('')
        try {
          await onSubmit(next, 'save')
          setDone(t('draftSaved'))
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          event.preventDefault()
          cancel()
          return
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target === boxRef.current) {
          event.preventDefault()
          submit()
        }
      }

      return h('div', { [LAYER_ATTR]: '', 'data-active': 'true', onKeyDown },
        h('textarea', {
          ref: boxRef,
          value: text,
          rows: Math.min(10, Math.max(3, String(text).split("\n").length)),
          'aria-label': t('title'),
          onChange: (event) => setText(event.target.value),
        }),
        h('div', { className: `${P}-bar` },
          error !== '' ? h('span', { className: `${P}-note` }, error)
            : done !== '' ? h('span', { className: `${P}-hint` }, done)
              : busy ? h('span', { className: `${P}-hint` }, t('sending')) : null,
          h('button', { type: 'button', className: `${P}-cancel`, disabled: busy, onClick: cancel }, t('cancel')),
          h('button', { type: 'button', className: `${P}-draft`, disabled: busy, onClick: saveDraft }, t('saveDraft')),
          h('button', { type: 'button', className: `${P}-send`, disabled: busy, onClick: submit },
            busy ? t('sending') : t('send'))))
    }

    // ---- 诊断：桌面端没有控制台，客户端把面包屑 POST 到 Host 落盘（~/.dsh/storages/edit-restart/client.log） ----
    const diagBuffer = []
    function diag(...parts) {
      const line = parts.map((part) => {
        if (typeof part === 'string') return part
        try { return JSON.stringify(part) } catch (_circular) { return String(part) }
      }).join(' ')
      diagBuffer.push(line)
      if (diagBuffer.length > 40) diagBuffer.splice(0, diagBuffer.length - 40)
      try {
        fetch('/api/edit-restart/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'log', lines: [line] }),
        }).catch(() => {})
      } catch (_noFetch) { /* 离线时不留痕 */ }
    }
    function describe(el) {
      if (!el) return String(el)
      const cls = String(el.getAttribute?.('class') || '')
      return `${String(el.tagName || '').toLowerCase()}${cls ? '.' + cls.split(/\s+/).filter(Boolean).join('.') : ''}`
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      const styleEl = document.createElement('style')
      styleEl.dataset.plugin = '@local/edit-restart'
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      // 三个固定 React 根：修改按钮、编辑框、已修改标记（同一时刻只开一个编辑框）。
      // 装饰落点就是官方气泡列（_userRow）：气泡本体与操作行都在它里面。
      const slotOf = (hit) => hit.row

      const actionEl = document.createElement('button')
      const layerEl = document.createElement('div')
      const markerEl = document.createElement('button')
      markerEl.type = 'button'
      markerEl.setAttribute(MARKER_ATTR, '')
      markerEl.disabled = true
      markerEl.tabIndex = -1
      markerEl.title = t('editedTitle')
      markerEl.setAttribute('aria-label', t('edited'))
      markerEl.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
      const actionRoot = createRoot(actionEl)
      const layerRoot = createRoot(layerEl)

      let host = null // 当前内容区
      let sessionId = null // 当前会话
      let current = null // 打开中的编辑框：{ slot, index }
      let frame = 0
      let actionReady = false

      const sessionsOf = () => {
        const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (!service || typeof service.retain !== 'function') throw new Error('session service is unavailable')
        return service
      }
      /**
       * 在某个会话的作用域里执行操作。
       * 关键：client 端 `using(target, options, fn)` 回调拿到的**不是** Session 对象
       * （官方实现是 retain 出来的 reference），所以这里用 scope(id) 借已保留的作用域上下文，
       * 再用 sessionOf(ctx) 取这个作用域绑定的 Session。
       */
      const withSession = async (id, operation) => {
        const service = sessionsOf()
        const sessionIn = (scopedCtx) => {
          if (!scopedCtx) return null
          // 1) 官方正路：作用域上下文 → sessionOf → 业务 Session
          try {
            const fromScope = service.sessionOf.call(service, scopedCtx)
            if (fromScope && typeof fromScope.getSnapshot === 'function') return fromScope
          } catch (_noScope) { /* 下一个途径 */ }
          // 2) 兜底：某些装配里查询会话对象就是 Session 本身
          if (typeof scopedCtx.getSnapshot === 'function') return scopedCtx
          return null
        }
        const scoped = typeof service.scope === 'function' ? service.scope(id) : undefined
        const ready = scoped ? sessionIn(scoped) : null
        if (ready) return operation(ready)
        // 作用域还没建立：临时 retain 一次，等它就绪后执行，再释放。
        const reference = service.retain(id, {})
        try {
          await reference.ready
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const found = sessionIn(typeof service.scope === 'function' ? service.scope(id) : undefined)
            if (found) return await operation(found)
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          throw new Error('session binding is unavailable')
        } finally {
          try { reference.release() } catch (_released) { /* already released */ }
        }
      }

      const editedKey = () => `${sessionId}|${current?.index}`

      function paintMarker() {
        if (current === null) return
        current.slot.setAttribute(EDITED_ATTR, editedAt.has(editedKey()) ? 'true' : 'false')
        if (markerEl.parentElement !== current.slot) current.slot.appendChild(markerEl)
      }

      function closeEditor() {
        if (current === null) return
        const slot = current.slot
        const key = editedKey()
        current = null
        layerRoot.render(null)
        if (slot && slot.isConnected !== false) {
          slot.setAttribute(EDITED_ATTR, editedAt.has(key) ? 'true' : 'false')
        }
        if (markerEl.parentElement && markerEl.parentElement.getAttribute(EDITED_ATTR) !== 'true') markerEl.remove()
      }

      /** 记录里第 index 条人发消息的正文与 fork 切点；会话在跑直接拒绝。 */
      async function resolveTarget(id, index) {
        return withSession(id, async (session) => {
          const snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null
          if (snapshot && snapshot.running === true) throw new Error(t('busy'))
          let entries = entriesOf(session)
          let event = humanMessage(entries, index)
          if (!isHumanMessage(event) && typeof session.loadThrough === 'function') {
            // 窗口没覆盖到这条消息：按已有起始 seq 往前翻页，最多 40 页。
            for (let page = 0; page < 40 && !isHumanMessage(event); page += 1) {
              const first = entries.length > 0 ? eventOf(entries[0]) : undefined
              const from = typeof first?.seq === 'number' ? first.seq : -1
              if (from <= 0) break
              try { await session.loadThrough(from - 1) } catch (error) {
                console.warn(LOG, 'loadThrough failed', error)
                break
              }
              entries = entriesOf(session)
              event = humanMessage(entries, index)
            }
          }
          if (!isHumanMessage(event)) throw new Error(t('stale'))
          const turnStartSeq = turnStartFor(entries, event.seq)
          if (!Number.isSafeInteger(turnStartSeq)) throw new Error(t('stale'))
          return { initial: editableText(event.data.content), turnStartSeq }
        })
      }

      /** 原生 fork（切点 = 这条消息自己那一轮的 turn/start），再把改过的文本作为首条消息发出。 */
      async function resend(id, index, turnStartSeq, text, mode) {
        if (mode === 'save') {
          const response = await fetch('/api/edit-restart/rpc', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'saveDraft', sessionId: id, turnStartSeq, messageIndex: index, text, initial: '' }),
          })
          const payload = await response.json().catch(() => null)
          if (!payload || payload.ok !== true) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
          diag('draft saved', { draftId: payload.draft?.id })
          return payload.draft?.id
        }
        if (resending.has(id)) throw new Error(t('busy'))
        resending.add(id)
        try {
          let childId
          try {
            childId = await sessionsOf().fork({ sessionId: id, atSeq: turnStartSeq, increaseTitle: true })
            diag('fork ok', { childId, turnStartSeq })
          } catch (failure) {
            diag('fork failed', String(failure?.message ?? failure))
            throw new Error(t('forkFailed').replace('{message}', String(failure?.message ?? failure)))
          }
          editedAt.set(`${id}|${index}`, childId)
          if (current !== null) paintMarker()
          try {
            await withSession(childId, async (session) => {
              await session.prompt([{ type: 'text', text }], 'plain')
            })
            diag('prompt ok', { childId })
          } catch (failure) {
            throw new Error(t('sendFailed').replace('{message}', String(failure?.message ?? failure)))
          }
          try {
            const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
            workspace?.openSession?.(childId)
          } catch (error) {
            console.warn(LOG, 'open branch failed', error)
          }
          return childId
        } finally {
          resending.delete(id)
        }
      }

      async function openEditor(slot, index) {
        diag('openEditor', { slot: describe(slot), index, sessionId })
        if (sessionId === null || slot === null) return
        if (current !== null && current.slot === slot) return
        const id = sessionId
        let target
        try {
          target = await resolveTarget(id, index)
        } catch (failure) {
          diag('resolveTarget failed', String(failure?.message ?? failure))
          actionEl.title = String(failure?.message ?? failure)
          throw failure
        }
        diag('resolveTarget ok', { initial: target.initial.slice(0, 40), turnStartSeq: target.turnStartSeq })
        closeEditor()
        current = { slot, index }
        if (actionEl.parentElement !== slot) slot.appendChild(actionEl)
        if (layerEl.parentElement !== slot) slot.appendChild(layerEl)
        slot.appendChild(markerEl)
        layerRoot.render(h(MessageLayer, {
          t,
          initial: target.initial,
          onClose: () => closeEditor(),
          onSubmit: (text, mode) => resend(id, index, target.turnStartSeq, text, mode),
        }))
        // React 渲染完之后再确认一次位置
        if (layerEl.parentElement !== slot) slot.appendChild(layerEl)
        paintMarker()
      }

      /** 枚举当前会话的人发消息并装饰；按钮只挂一处（最新消息优先）。 */
      function scan() {
        const contentHost = document.querySelector('[data-conversation-content]')
        const next = contentHost === null ? null : sessionIdOfHost(contentHost)
        const items = contentHost === null ? [] : scanChat(contentHost)
        if (contentHost === null || next === null || items.length === 0) {
          if (current !== null) closeEditor()
          actionEl.remove()
          markerEl.remove()
          return
        }
        contentHost.setAttribute(HOST_ATTR, '')
        host = contentHost
        report(`scan session=${next} users=${items.length} actionParent=${describe(actionEl.parentElement)}`)
        items.forEach((item, index) => {
          const slot = slotOf(item)
          if (slot.hasAttribute(READY_ATTR)) return
          slot.setAttribute(READY_ATTR, '')
          slot.setAttribute(INDEX_ATTR, String(index))
          slot.classList.add(COLUMN_CLASS)
          slot.setAttribute(EDITED_ATTR, editedAt.has(`${next}|${index}`) ? 'true' : 'false')
        })
        if (sessionId !== next) {
          if (current !== null) closeEditor()
          sessionId = next
        }
        const target = current !== null && current.slot.isConnected !== false
          ? current.slot
          : slotOf(items[items.length - 1])
        if (actionEl.parentElement !== target) target.appendChild(actionEl)
        if (!actionReady) {
          actionReady = true
          actionRoot.render(h(ActionButton, {
            t,
            onOpen: () => {
              const slot = actionEl.parentElement
              diag('click', { slot: describe(slot), index: slot && slot.getAttribute(INDEX_ATTR) })
              if (slot === null) return
              openEditor(slot, Number(slot.getAttribute(INDEX_ATTR))).catch((error) => {
                console.warn(LOG, 'open editor failed', error)
                actionEl.title = String(error?.message ?? error)
                actionEl.setAttribute('aria-disabled', 'true')
                window.setTimeout(() => {
                  actionEl.title = t('action')
                  actionEl.removeAttribute('aria-disabled')
                }, 2400)
              })
            },
          }))
        }
        if (current !== null) {
          if (current.slot.isConnected === false) {
            closeEditor()
          } else {
            if (actionEl.parentElement !== current.slot) current.slot.appendChild(actionEl)
            if (layerEl.parentElement !== current.slot) current.slot.appendChild(layerEl)
            if (markerEl.parentElement !== current.slot) current.slot.appendChild(markerEl)
          }
        } else if (markerEl.parentElement && markerEl.parentElement.getAttribute(EDITED_ATTR) !== 'true') {
          markerEl.remove()
        }
      }

      let lastReport = ''
      const report = (text) => {
        if (text === lastReport) return
        lastReport = text
        diag(text)
      }

      const schedule = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          scan()
        })
      }

      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      diag('boot 0.6.0', `host=${describe(document.querySelector('[data-conversation-content]'))}`, `fetch=${typeof fetch}`)
      scan()

      return () => {
        observer.disconnect()
        if (frame !== 0) window.cancelAnimationFrame(frame)
        actionReady = false
        actionRoot.unmount()
        layerRoot.unmount()
        actionEl.remove()
        layerEl.remove()
        markerEl.remove()
        styleEl.remove()
        if (host !== null) host.removeAttribute(HOST_ATTR)
      }
    }

    return {
      inject: ['locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'edit-restart: dictionaries')
        ctx.effect(() => apply(ctx), 'edit-restart: chat wiring')
      },
    }
  },
})

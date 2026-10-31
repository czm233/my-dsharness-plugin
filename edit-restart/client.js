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
      'sending': '生成分支并发送…',
      'needText': '内容不能为空',
      'busy': '会话正在运行，结束后再修改',
      'stale': '找不到这条消息，可能已不在当前记录里',
      'sessionUnavailable': '拿不到这个会话，请稍后重试',
      'timeout': '读取会话超时，请稍后重试',
      'close': '知道了',
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
      'sending': 'Branching and sending…',
      'needText': 'Message cannot be empty',
      'busy': 'Wait for the session to finish running',
      'stale': 'This message is no longer in the session record',
      'sessionUnavailable': 'This session is not available right now',
      'timeout': 'Reading the session timed out. Try again.',
      'close': 'OK',
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
      const copyClass = buttons[0].getAttribute('class') || undefined
      return { row, bubble, actions, buttons, copyClass }
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
      // 编辑器：顶替气泡的位置（插在气泡前方、临时隐藏气泡），右对齐、同宽同圆角
      `[${LAYER_ATTR}]{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;
  align-self:flex-end;padding:10px 12px;border-radius:var(--dsw-radius-xl,14px);
  background:var(--dsw-specific-bubble,rgba(255,255,255,.06));
  border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#e8e8ea);}`,
      `[${LAYER_ATTR}][data-error="true"]{background:transparent;border-color:transparent;padding:0;}`,
      `[${LAYER_ATTR}] textarea{box-sizing:border-box;width:100%;min-height:56px;max-height:44vh;resize:vertical;
  border:none;outline:none;background:transparent;color:inherit;font:inherit;
  font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));
  white-space:pre-wrap;padding:0;}`,
      `[${LAYER_ATTR}] .${P}-bar{display:flex;align-items:center;justify-content:flex-end;gap:8px;}`,
      `[${LAYER_ATTR}] .${P}-note{flex:1;min-width:0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-state-error-primary,#f28b82);}`,
      `[${LAYER_ATTR}] .${P}-hint{flex:1;min-width:0;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#8f8f97);}`,
      `[${LAYER_ATTR}] button{appearance:none;cursor:pointer;font:inherit;font-size:12px;line-height:18px;
  border-radius:999px;padding:4px 12px;border:1px solid transparent;}`,
      `[${LAYER_ATTR}] .${P}-cancel{background:transparent;border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  color:var(--dsw-alias-label-secondary,#cfcfd4);}`,
      `[${LAYER_ATTR}] .${P}-send{background:var(--dsw-alias-button-primary-fill,#4c8bf5);color:#fff;}`,
      `[${LAYER_ATTR}] button:disabled{opacity:.5;cursor:default;}`,
      // 「修改」按钮：并进官方操作行，className 直接复制官方按钮（见 ActionButton），这里只兜底尺寸
      `[${HOST_ATTR}] [class*="_actions"] > button[${ACTION_ATTR}]{flex:0 0 auto;}`,
      // 已修改标记
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${MARKER_ATTR}]{order:4 !important;display:none;
  width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:0 0;border:none;
  justify-content:center;align-items:center;padding:6px;flex:0 0 auto;cursor:default;}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS} > button[${MARKER_ATTR}] svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));}`,
      `[${HOST_ATTR}] .${COLUMN_CLASS}[${EDITED_ATTR}="true"] > button[${MARKER_ATTR}]{display:inline-flex;}`,
    ].join('\n')

    /** 失败提示卡：让"点不动"变成看得见的一句话（不写进 Chat，只借同一个装饰落点）。 */
    function ErrorCard(props) {
      const { t, message, onClose } = props
      return h('div', { [LAYER_ATTR]: '', 'data-active': 'true', 'data-error': 'true' },
        h('div', { className: `${P}-bar`, style: { alignItems: 'center' } },
          h('span', { className: `${P}-note`, style: { flex: '1' } }, message),
          h('button', { type: 'button', className: `${P}-cancel`, onClick: onClose }, t('close'))))
    }

    // ---- 「修改」按钮 ----
    function ActionButton(props) {
      const { t, onOpen, className } = props
      return h('button', {
        type: 'button',
        className,
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
            : busy ? h('span', { className: `${P}-hint` }, t('sending')) : null,
          h('button', { type: 'button', className: `${P}-cancel`, disabled: busy, onClick: cancel }, t('cancel')),
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
        const asSession = (candidate) => (candidate && typeof candidate.getSnapshot === 'function'
          && typeof candidate.prompt === 'function' ? candidate : null)
        const viaBinding = () => {
          try {
            const binding = typeof service.binding === 'function' ? service.binding(id) : undefined
            return asSession(binding?.session) ?? asSession(binding)
          } catch (_noBinding) { return null }
        }
        const viaScope = () => {
          try {
            const scoped = typeof service.scope === 'function' ? service.scope(id) : undefined
            if (!scoped) return null
            const fromScope = typeof service.sessionOf === 'function' ? service.sessionOf(scoped) : undefined
            return asSession(fromScope) ?? asSession(scoped)
          } catch (_noScope) { return null }
        }
        const resolve = () => viaBinding() ?? viaScope()
        const immediate = resolve()
        if (immediate) return operation(immediate)
        diag('session not retained yet', id)
        // 作用域还没建立：临时 retain 一次，等它就绪后再取，最后释放。
        const reference = service.retain(id, {})
        try {
          await reference.ready
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const found = resolve()
            if (found) return await operation(found)
            await new Promise((done) => setTimeout(done, 50))
          }
          diag('session binding unavailable', id)
          throw new Error(t('sessionUnavailable'))
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
        if (current.bubble && current.bubble.isConnected !== false) {
          current.bubble.style.display = current.bubbleDisplay ?? ''
        }
        if (current.error === true) {
          current = null
          layerRoot.render(null)
          layerEl.remove()
          return
        }
        const slot = current.slot
        const key = editedKey()
        current = null
        layerRoot.render(null)
        if (slot && slot.isConnected !== false) {
          slot.setAttribute(EDITED_ATTR, editedAt.has(key) ? 'true' : 'false')
        }
        if (markerEl.parentElement && markerEl.parentElement.getAttribute(EDITED_ATTR) !== 'true') markerEl.remove()
      }

      /** 在当前落点显示一张失败卡，替换掉静默失败。 */
      function showError(slot, message) {
        if (!slot) return
        const hit = hits.get(slot)
        const bubble = hit ? hit.bubble : null
        current = { slot, index: Number(slot.getAttribute(INDEX_ATTR)), error: true }
        if (layerEl.parentElement !== slot) slot.insertBefore(layerEl, bubble ?? null)
        layerEl.style.width = '100%'
        layerRoot.render(h(ErrorCard, { t, message, onClose: () => closeEditor() }))
      }

      /** 先问 Host 要这条消息（Host 只读日志，不依赖 client 的会话绑定）。 */
      async function resolveViaHost(id, index) {
        const response = await fetch('/api/edit-restart/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'resolve', sessionId: id, messageIndex: index }),
        })
        const payload = await response.json().catch(() => null)
        if (!payload || payload.ok !== true) throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
        if (payload.found !== true) throw new Error(t('stale'))
        if (!Number.isSafeInteger(payload.turnStartSeq)) throw new Error(t('stale'))
        return { initial: String(payload.initial ?? ''), turnStartSeq: payload.turnStartSeq }
      }

      /** 记录里第 index 条人发消息的正文与 fork 切点；会话在跑直接拒绝。 */
      async function resolveTarget(id, index) {
        try {
          const viaHost = await resolveViaHost(id, index)
          diag('resolve via host ok', { turnStartSeq: viaHost.turnStartSeq })
          return viaHost
        } catch (hostFailure) {
          diag('resolve via host failed, falling back', String(hostFailure?.message ?? hostFailure))
        }
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
      async function resend(id, index, turnStartSeq, text) {
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

      /** row → 这条消息的官方零件（气泡本体、操作行、复制按钮类名），scan 时刷新。 */
      const hits = new Map()

      async function openEditor(slot, index) {
        if (sessionId === null || slot === null) return
        if (current !== null && current.slot === slot) return
        const id = sessionId
        const hit = hits.get(slot)
        const bubble = hit ? hit.bubble : null
        let target
        try {
          target = await Promise.race([
            resolveTarget(id, index),
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error(t('timeout'))), 8000)
            }),
          ])
        } catch (failure) {
          diag('resolveTarget failed', String(failure?.message ?? failure))
          throw failure
        }
        diag('resolveTarget ok', { turnStartSeq: target.turnStartSeq })
        closeEditor()
        current = { slot, index, bubble, bubbleDisplay: bubble ? bubble.style.display : '' }
        // 编辑器顶替气泡：插在气泡前面，气泡临时让位。
        if (bubble) {
          bubble.style.display = 'none'
          if (layerEl.nextElementSibling !== bubble || layerEl.parentElement !== slot) {
            slot.insertBefore(layerEl, bubble)
          }
        } else if (layerEl.parentElement !== slot) {
          slot.appendChild(layerEl)
        }
        const width = bubble && bubble.getBoundingClientRect ? bubble.getBoundingClientRect().width : 0
        layerEl.style.width = width > 0 ? `${Math.max(240, Math.round(width))}px` : '100%'
        layerRoot.render(h(MessageLayer, {
          t,
          initial: target.initial,
          onClose: () => closeEditor(),
          onSubmit: (text) => resend(id, index, target.turnStartSeq, text),
        }))
        if (layerEl.parentElement !== slot) slot.insertBefore(layerEl, bubble ?? null)
        paintMarker()
      }

      /** 枚举当前会话的用户消息，把「修改」按钮挂进官方操作行（复制按钮旁边）。 */
      function scan() {
        const contentHost = document.querySelector('[data-conversation-content]')
        const next = contentHost === null ? null : sessionIdOfHost(contentHost)
        const items = contentHost === null ? [] : scanChat(contentHost)
        if (contentHost === null || next === null || items.length === 0) {
          if (current !== null) closeEditor()
          actionEl.remove()
          markerEl.remove()
          hits.clear()
          return
        }
        contentHost.setAttribute(HOST_ATTR, '')
        host = contentHost
        const latest = items[items.length - 1]
        hits.clear()
        items.forEach((item, index) => {
          hits.set(item.row, item)
          if (!item.row.hasAttribute(READY_ATTR)) {
            item.row.setAttribute(READY_ATTR, '')
            item.row.classList.add(COLUMN_CLASS)
          }
          item.row.setAttribute(INDEX_ATTR, String(index))
          item.row.setAttribute(EDITED_ATTR, editedAt.has(`${next}|${index}`) ? 'true' : 'false')
          // 让「修改」按钮在复制按钮旁边：同属官方操作行，复制按钮的类名也照抄一份。
          if (item !== latest) {
            const stale = item.actions.querySelector(`button[${ACTION_ATTR}]`)
            if (stale) stale.remove()
          }
        })
        if (sessionId !== next) {
          if (current !== null) closeEditor()
          sessionId = next
        }
        report(`scan session=${next} users=${items.length} actionRow=${describe(latest.actions)}`)
        // 按钮只保留一个，挂进最新一条消息的官方操作行
        if (actionEl.parentElement !== latest.actions) latest.actions.appendChild(actionEl)
        actionEl.className = latest.copyClass
        if (!actionReady) {
          actionReady = true
          actionRoot.render(h(ActionButton, {
            t,
            onOpen: () => {
              // 从按钮往上找它的气泡列（不依赖 closest 的属性子串选择器）
              let row = actionEl.parentElement
              while (row && !hasClassLike(row, '_userRow')) row = row.parentElement
              if (row === null) return
              diag('click', { row: describe(row), index: row.getAttribute(INDEX_ATTR) })
              openEditor(row, Number(row.getAttribute(INDEX_ATTR))).catch((error) => {
                console.warn(LOG, 'open editor failed', error)
                diag('open editor failed (visible)', String(error?.message ?? error))
                showError(row, String(error?.message ?? error))
              })
            },
          }))
        }
        if (current !== null) {
          if (current.slot.isConnected === false) {
            closeEditor()
          } else if (markerEl.parentElement !== current.slot) {
            current.slot.appendChild(markerEl)
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
      diag('boot 0.10.0', `host=${describe(document.querySelector('[data-conversation-content]'))}`, `fetch=${typeof fetch}`)
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

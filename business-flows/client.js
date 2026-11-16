/**
 * Client half of Business Flows (业务流程).
 *
 * Two registrations:
 *   1. A `conversation.view` tab (the same seat family as the workflow
 *      canvas): left column lists this workspace's notes, right pane reads
 *      one note as markdown — collected sections keep the original question
 *      and answer, the whole body is editable in place (编辑 → textarea →
 *      保存), so appending notes by hand is the normal workflow.
 *   2. A `conversation.chat.turnTail` seat (the same tail row as turn-cost):
 *      a small 「收藏」 button per turn. Picking a note (or creating one)
 *      appends that turn's question + answer as a markdown section; nothing
 *      on screen is scraped, the host re-reads the turn from the session log.
 *
 * Images pasted (or dropped) into the editor upload into the note's
 * <flowId>.assets/ folder next to the .md file on disk and are referenced
 * relatively, so the note stays Obsidian-compatible; the reader swaps those
 * relative refs for the host asset route when rendering.
 */

window.__ModuleLoader__.load({
  id: '@local/business-flows',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useRef, useEffect, useCallback } = React

    const NS = 'businessFlows'
    const RPC_CHANNEL = '/api'
    const RPC_METHOD = 'business-flows/rpc'
    const ASSET_REF = /\.assets\//

    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') ?? null } catch (_unavailable) { return null }
    })()
    const defined = (value) => value !== undefined && value !== null
    const MarkdownText = primitives !== null && defined(primitives.MarkdownText) ? primitives.MarkdownText : null

    const zh = {
      'title': '业务流程',
      'collect': '收藏',
      'saved': '已收藏',
      'collectFailed': '收藏失败',
      'loadFailed': '读取失败',
      'newFlow': '新建业务流程',
      'titlePh': '名称',
      'create': '创建',
      'cancel': '取消',
      'save': '保存',
      'edit': '编辑',
      'saveFailed': '保存失败',
      'uploadFailed': '图片上传失败',
      'openFailed': '打开失败',
      'rename': '改名',
      'del': '删除',
      'confirmDelete': '删除？',
      'empty': '这个工程还没有收藏',
      'pickHint': '从左侧选择一条',
      'markdown.copy': '复制',
      'markdown.copied': '已复制',
      'markdown.code': '代码',
      'markdown.wrap': '换行',
      'markdown.unwrap': '不换行',
      'markdown.footnotes': '脚注',
    }
    const en = {
      'title': 'Business Flows',
      'collect': 'Save',
      'saved': 'Saved',
      'collectFailed': 'Save failed',
      'loadFailed': 'Load failed',
      'newFlow': 'New flow',
      'titlePh': 'Name',
      'create': 'Create',
      'cancel': 'Cancel',
      'save': 'Save',
      'edit': 'Edit',
      'saveFailed': 'Save failed',
      'uploadFailed': 'Image upload failed',
      'openFailed': 'Open failed',
      'rename': 'Rename',
      'del': 'Delete',
      'confirmDelete': 'Delete?',
      'empty': 'Nothing collected in this workspace yet',
      'pickHint': 'Pick one on the left',
      'markdown.copy': 'Copy',
      'markdown.copied': 'Copied',
      'markdown.code': 'Code',
      'markdown.wrap': 'Wrap',
      'markdown.unwrap': 'Unwrap',
      'markdown.footnotes': 'Footnotes',
    }

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

    const CSS = `
      /* 本视图挂载时隐藏常驻输入区与宽度拖柄，整块对话区归笔记页用（同流程画布契约） */
      [data-conversation-content]:has([data-business-flows-view]) [data-conversation-region=composer],[data-conversation-content]:has([data-business-flows-view]) [data-width-handle]{display:none !important}
      /* 设计语言照 agent-workflow-board：顶部工具栏 + 左侧面板 + 可拖拽分隔条 + 统一 dsw token */
      .bfc{display:flex;flex-direction:column;height:100%;min-height:0;flex:1 1 0;overflow:hidden;
        color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-1,transparent)}
      /* --- 顶部工具栏 --- */
      .bfc-toolbar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
      .bfc-brand{flex:0 0 auto;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;
        background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-size:12px;font-weight:700}
      .bfc-title{flex:0 1 auto;min-width:60px;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bfc-sub{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .bfc-spacer{flex:1 1 auto}
      .bfc-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);
        font:inherit;padding:2px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}
      .bfc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
      .bfc-btn:disabled{opacity:.4;cursor:not-allowed}
      .bfc-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .bfc-btn.danger{border-color:transparent;color:var(--dsw-alias-state-error-primary,#e5484d)}
      /* --- 左侧面板 --- */
      .bfc-palette{flex:0 0 auto;width:240px;min-width:0;display:flex;flex-direction:column;min-height:0;
        border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
      .bfc-pal-head{display:flex;align-items:baseline;gap:6px;padding:10px 12px 6px}
      .bfc-pal-title{font-weight:600;font-size:12px}
      .bfc-pal-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bfc-pal-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:4px}
      .bfc-card{position:relative;display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:8px;cursor:pointer;user-select:none}
      .bfc-card:hover{background:var(--dsw-alias-bg-layer-2)}
      .bfc-card.active{background:var(--dsw-alias-bg-layer-2)}
      .bfc-card.active .bfc-card-title{color:var(--dsw-alias-brand-primary)}
      .bfc-card-title{flex:1 1 auto;min-width:0;font-weight:500;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bfc-card-actions{display:none;flex:0 0 auto;gap:2px}
      .bfc-card:hover .bfc-card-actions,.bfc-card.active .bfc-card-actions{display:flex}
      .bfc-icon-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;
        padding:1px 4px;border-radius:4px;cursor:pointer;line-height:1}
      .bfc-icon-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
      .bfc-row-form{display:flex;align-items:center;gap:4px;padding:4px 6px;width:100%}
      .bfc-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}
      .bfc-input:focus{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
      .bfc-pal-foot{padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}
      .bfc-new-btn{width:100%;text-align:left;border:1px dashed var(--dsw-alias-border-l1);background:transparent;
        color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;cursor:pointer}
      .bfc-new-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
      /* --- 拖拽分隔条 --- */
      .bfc-resizer{flex:0 0 8px;cursor:col-resize;background:transparent;position:relative;z-index:5}
      .bfc-resizer:hover,.bfc-resizer.active{background:var(--dsw-alias-border-l1)}
      /* --- 右侧内容 --- */
      .bfc-stage{flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0}
      .bfc-reader{flex:1 1 auto;overflow:auto;padding:16px 20px 28px;min-height:0;font-size:13px;line-height:1.7}
      .bfc-reader-empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .bfc-editor-wrap{flex:1 1 auto;display:flex;min-height:0}
      .bfc-editor{flex:1 1 auto;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;background:transparent;
        color:var(--dsw-alias-label-primary);font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;padding:14px 20px;min-height:0}
      .bfc-note-error{padding:8px 20px;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}
      .bfc-a :first-child{margin-top:0}
      /* --- turnTail 收藏按钮与菜单（独立语境，沿用同一 token） --- */
      .bfc-tail-btn{border:none;background:none;color:var(--dsw-alias-label-secondary,inherit);opacity:.8;font-size:12px;line-height:1;
        padding:5px 8px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
      .bfc-tail-btn:hover:not(:disabled){opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}
      .bfc-tail-btn[disabled]{opacity:.45;cursor:default}
      .bfc-menu{position:fixed;z-index:10000;min-width:200px;max-width:280px;max-height:300px;overflow:auto;
        background:var(--dsw-alias-bg-layer-1,#1e1f22);color:var(--dsw-alias-label-primary,inherit);
        border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:10px;
        box-shadow:0 8px 28px rgba(0,0,0,.28);padding:4px;font-size:12px}
      .bfc-menu-item{display:block;width:100%;text-align:left;border:none;background:none;color:inherit;
        padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bfc-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
      .bfc-menu-item:disabled{opacity:.5;cursor:default}
      .bfc-menu-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.25));margin:4px 2px}
      .bfc-menu-note{padding:6px 10px;opacity:.6;white-space:nowrap}
      .bfc-menu-error{padding:6px 10px;color:var(--dsw-alias-state-error-primary,#e5484d);white-space:normal;max-width:260px}
      .bfc-new-row{display:flex;gap:4px;padding:4px 6px 2px}
      .bfc-mini-btn{border:none;background:none;color:inherit;opacity:.75;font-size:12px;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}
      .bfc-mini-btn:hover:not(:disabled){opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
      .bfc-mini-btn:disabled{opacity:.4;cursor:default}
      .bfc-mini-btn.primary{opacity:1;font-weight:600}
      .bfc-a{line-height:1.65}
      .bfc-error{padding:10px 14px;color:var(--dsw-alias-state-error-primary,#e5484d)}
`

    const ctxRef = { service: null }

    /** One shaped RPC call through the client connection carrier. */
    async function callRpc(action, args) {
      const service = ctxRef.service
      if (service === null || typeof service.rpc?.call !== 'function') {
        throw new Error('connection service is unavailable')
      }
      const result = await service.rpc.call(RPC_CHANNEL, RPC_METHOD, { action, ...args })
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new Error(String(result?.error?.message ?? 'rpc returned no payload'))
      }
      return result.value
    }

    /**
     * Split a note body into markdown / image segments at image-only lines.
     * Image segments carry the asset NAME (as stored on disk next to the
     * note); the images prop maps names to data URLs fetched over the
     * authorized RPC channel — plain <img> GETs cannot authenticate.
     */
    function bodySegments(body) {
      const segments = []
      let text = ''
      for (const line of String(body ?? '').split('\n')) {
        const md = /^\s*(?:>\s*)*!\[[^\]]*\]\([^\s)]*\.assets\/([^\s)]+)[^)]*\)\s*$/.exec(line)
        const wiki = md === null ? /^\s*(?:>\s*)*!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]\s*$/.exec(line) : null
        if (md !== null || wiki !== null) {
          if (text.trim() !== '') segments.push({ type: 'md', text })
          text = ''
          segments.push({ type: 'img', name: (md !== null ? md[1] : wiki[1]).trim() })
        } else {
          text += `${line}\n`
        }
      }
      if (text.trim() !== '') segments.push({ type: 'md', text })
      return segments
    }

    /**
     * Wrap bare absolute local paths (`/Users/…`, `/Volumes/…`) in markdown
     * links with a custom `bfc-path:` scheme so they become clickable; the
     * reader intercepts clicks on that scheme and asks the host to open the
     * file with the platform default handler. Skips fenced code blocks and
     * never touches the stored body — this is a render-time transform only.
     */
    function linkifyPaths(text) {
      if (typeof text !== 'string' || text === '') return text ?? ''
      let inFence = false
      return text.split('\n').map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence
          return line
        }
        if (inFence) return line
        return line.replace(/(^|[\s(（【「"'<])(\/(?:Users|Volumes|private|home|opt|tmp)[^\s()<>）】」"',；。！？]+)/g, (all, lead, target) => `${lead}[${target}](bfc-path:${encodeURIComponent(target)})`)
      }).join('\n')
    }

    function AnswerBody(props) {
      const { segments, labels, images } = props
      if (segments.length === 0) return null
      const renderMd = (text, key) => (MarkdownText !== null
        ? h(MarkdownText, { key, text: linkifyPaths(text), labels })
        : h('div', { key, style: { whiteSpace: 'pre-wrap' } }, linkifyPaths(text)))
      if (segments.length === 1 && segments[0].type === 'md') return renderMd(segments[0].text, 'm0')
      return h('div', { className: 'bfc-a' },
        segments.map((segment, index) => segment.type === 'img'
          ? (typeof images?.[segment.name] === 'string'
            ? h('img', {
              key: `i${index}`,
              src: images[segment.name],
              alt: segment.name,
              style: { maxWidth: '100%', borderRadius: 8, margin: '8px 0' },
            })
            : null)
          : renderMd(segment.text, `m${index}`)),
      )
    }

    /** The turn-tail 「收藏」 button with its note picker menu. */
    function CollectTail(props) {
      const { t, callRpc } = props
      const turnLocation = props.turn
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const turnNo = typeof turnLocation?.turn === 'number' ? turnLocation.turn : undefined

      const [open, setOpen] = useState(false)
      const [phase, setPhase] = useState('list')
      const [flows, setFlows] = useState(null)
      const [title, setTitle] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [done, setDone] = useState(false)
      const [pos, setPos] = useState(null)
      const btnRef = useRef(null)
      const menuRef = useRef(null)
      const inputRef = useRef(null)

      const openMenu = useCallback(() => {
        if (done || busy || sessionId === '' || turnNo === undefined) return
        const rect = btnRef.current?.getBoundingClientRect()
        if (rect) setPos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 250) })
        setPhase('list')
        setError('')
        setTitle('')
        setFlows(null)
        setOpen(true)
        callRpc('list', { sessionId }).then(
          (value) => setFlows(Array.isArray(value?.flows) ? value.flows : []),
          (failure) => { setFlows([]); setError(String(failure?.message ?? failure)) },
        )
      }, [busy, callRpc, done, sessionId, turnNo])

      const disabled = done || sessionId === '' || turnNo === undefined

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const target = event.target
          if (menuRef.current?.contains(target)) return
          if (btnRef.current?.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      useEffect(() => {
        if (open && phase === 'new') inputRef.current?.focus()
      }, [open, phase])

      const collect = useCallback(async (args) => {
        setBusy(true)
        setError('')
        try {
          await callRpc('collect', { sessionId, turn: turnNo, ...args })
          setDone(true)
          setOpen(false)
        } catch (failure) {
          setError(`${t('collectFailed')}：${String(failure?.message ?? failure)}`)
        } finally {
          setBusy(false)
        }
      }, [callRpc, sessionId, t, turnNo])

      const submitNew = () => {
        const trimmed = title.trim()
        if (trimmed === '' || busy) return
        collect({ title: trimmed })
      }

      const menu = open && pos !== null
        ? createPortal(
          h('div', {
            ref: menuRef,
            className: 'bfc-menu',
            style: { top: pos.top, left: pos.left },
            onMouseDown: (event) => event.stopPropagation(),
          },
            flows === null
              ? h('div', { className: 'bfc-menu-note' }, '…')
              : flows.map((flow) => h('button', {
                key: flow.id,
                type: 'button',
                className: 'bfc-menu-item',
                disabled: busy,
                title: flow.title,
                onClick: () => collect({ flowId: flow.id }),
              }, flow.title)),
            flows !== null ? h('div', { className: 'bfc-menu-sep' }) : null,
            phase === 'list'
              ? h('button', {
                type: 'button',
                className: 'bfc-menu-item',
                disabled: busy,
                onClick: () => { setPhase('new') },
              }, `＋ ${t('newFlow')}`)
              : h('div', { className: 'bfc-new-row' },
                h('input', {
                  ref: inputRef,
                  className: 'bfc-input',
                  value: title,
                  placeholder: t('titlePh'),
                  maxLength: 60,
                  onChange: (event) => setTitle(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitNew()
                    if (event.key === 'Escape') setPhase('list')
                  },
                }),
                h('button', { type: 'button', className: 'bfc-mini-btn primary', disabled: busy || title.trim() === '', onClick: submitNew }, t('create')),
                h('button', { type: 'button', className: 'bfc-mini-btn', disabled: busy, onClick: () => { setPhase('list') } }, t('cancel'))),
            error !== '' ? h('div', { className: 'bfc-menu-error' }, error) : null,
          ),
          document.body,
        )
        : null

      return h('span', { ref: btnRef, style: { display: 'inline-flex', position: 'relative' } },
        h('button', {
          type: 'button',
          className: 'bfc-tail-btn',
          disabled,
          title: t('collect'),
          onClick: openMenu,
        }, done ? t('saved') : `＋ ${t('collect')}`),
        menu,
      )
    }

    /** Note pane: read (rendered markdown) or edit (raw textarea + paste images). */
    function FlowsPage(props) {
      const safeProps = props && typeof props === 'object' ? props : {}
      const t = typeof safeProps.t === 'function' ? safeProps.t : (key) => zh[key] || key
      const sessionId = typeof safeProps.sessionId === 'string' ? safeProps.sessionId : ''
      const rpc = typeof safeProps.callRpc === 'function' ? safeProps.callRpc : callRpc

      const [flows, setFlows] = useState(null)
      const [error, setError] = useState('')
      const [selectedId, setSelectedId] = useState('')
      const [detail, setDetail] = useState(null)
      const [creating, setCreating] = useState(false)
      const [newTitle, setNewTitle] = useState('')
      const [renameId, setRenameId] = useState('')
      const [renameTitle, setRenameTitle] = useState('')
      const [confirmId, setConfirmId] = useState('')
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [noteError, setNoteError] = useState('')
      const [images, setImages] = useState({})
      const taRef = useRef(null)
      const labels = markdownLabels(t)

      const segmentList = detail === null ? [] : bodySegments(detail.body)

      // Fetch note images as data URLs over the authorized RPC channel.
      useEffect(() => {
        if (detail === null || sessionId === '') {
          setImages({})
          return undefined
        }
        const names = [...new Set(segmentList.filter(segment => segment.type === 'img').map(segment => segment.name))]
        if (names.length === 0) {
          setImages({})
          return undefined
        }
        let cancelled = false
        rpc('assets', { sessionId, id: detail.id, names }).then(
          (value) => { if (!cancelled) setImages(value?.images ?? {}) },
          () => { if (!cancelled) setImages({}) },
        )
        return () => { cancelled = true }
      }, [detail?.id, detail?.body, rpc, sessionId])

      const reload = useCallback(async () => {
        if (sessionId === '') { setFlows([]); return }
        try {
          const value = await rpc('list', { sessionId })
          setFlows(Array.isArray(value?.flows) ? value.flows : [])
          setError('')
        } catch (failure) {
          setFlows([])
          setError(String(failure?.message ?? failure))
        }
      }, [rpc, sessionId])

      useEffect(() => {
        setSelectedId('')
        setDetail(null)
        setEditing(false)
        reload()
      }, [reload])

      const openFlow = useCallback(async (id) => {
        setSelectedId(id)
        setDetail(null)
        setEditing(false)
        try {
          const value = await rpc('flow', { sessionId, id })
          setDetail(value?.flow ?? null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [rpc, sessionId])

      const submitCreate = async () => {
        const trimmed = newTitle.trim()
        if (trimmed === '' || sessionId === '') return
        try {
          const value = await rpc('create', { sessionId, title: trimmed })
          setCreating(false)
          setNewTitle('')
          await reload()
          if (value?.flow?.id) openFlow(value.flow.id)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const submitRename = async () => {
        const trimmed = renameTitle.trim()
        if (trimmed === '' || renameId === '') return
        try {
          const value = await rpc('rename', { sessionId, id: renameId, title: trimmed })
          setRenameId('')
          setRenameTitle('')
          await reload()
          if (renameId === selectedId && value?.flow) setDetail(prev => prev === null ? prev : { ...prev, title: value.flow.title })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const submitRemove = async (id) => {
        try {
          await rpc('remove', { sessionId, id })
          setConfirmId('')
          await reload()
          if (id === selectedId) { setSelectedId(''); setDetail(null); setEditing(false) }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const startEdit = () => {
        setDraft(typeof detail?.body === 'string' ? detail.body : '')
        setNoteError('')
        setEditing(true)
      }

      const submitSave = async () => {
        if (detail === null) return
        try {
          await rpc('save', { sessionId, id: detail.id, body: draft })
          setDetail(prev => prev === null ? prev : { ...prev, body: draft })
          setEditing(false)
          setNoteError('')
          reload()
        } catch (failure) {
          setNoteError(`${t('saveFailed')}：${String(failure?.message ?? failure)}`)
        }
      }

      /** Insert text at the editor cursor (used by the image upload path). */
      const insertAtCursor = useCallback((text) => {
        const ta = taRef.current
        setDraft(prev => {
          const start = ta !== null && typeof ta.selectionStart === 'number' ? ta.selectionStart : prev.length
          const end = ta !== null && typeof ta.selectionEnd === 'number' ? ta.selectionEnd : start
          const next = prev.slice(0, start) + text + prev.slice(end)
          requestAnimationFrame(() => {
            if (taRef.current !== null) taRef.current.setSelectionRange(start + text.length, start + text.length)
          })
          return next
        })
      }, [])

      const uploadImage = useCallback(async (file) => {
        if (detail === null) return
        const type = String(file.type ?? '')
        const match = /^image\/(png|jpeg|jpg|gif|webp)$/.exec(type)
        if (match === null) {
          setNoteError(`${t('uploadFailed')}：${type || 'unknown'}`)
          return
        }
        setNoteError('')
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? ''))
            reader.onerror = () => reject(new Error('read failed'))
            reader.readAsDataURL(file)
          })
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
          const d = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
          const value = await rpc('upload', { sessionId, id: detail.id, name: `截图-${stamp}.${ext}`, dataBase64: dataUrl })
          if (typeof value?.name !== 'string' || value.name === '') throw new Error('no asset name returned')
          const ref = `![${value.name}](${detail.id}.assets/${value.name})`
          if (editing) {
            insertAtCursor(`\n${ref}\n`)
          } else {
            // reading view: append the image to the note and save right away
            const body = `${typeof detail.body === 'string' ? detail.body : ''}${typeof detail.body === 'string' && detail.body !== '' && !detail.body.endsWith('\n') ? '\n' : ''}\n${ref}\n`
            await rpc('save', { sessionId, id: detail.id, body })
            setDetail(prev => prev === null ? prev : { ...prev, body })
          }
        } catch (failure) {
          setNoteError(`${t('uploadFailed')}：${String(failure?.message ?? failure)}`)
        }
      }, [detail, editing, insertAtCursor, rpc, sessionId, t])

      const imageFromEvent = useCallback((transfer) => {
        if (!transfer) return null
        const items = transfer.items
        if (items) {
          for (const item of items) {
            if (item !== null && typeof item === 'object' && item.kind === 'file' && String(item.type ?? '').startsWith('image/')) {
              const file = item.getAsFile()
              if (file !== null) return file
            }
          }
        }
        const files = transfer.files
        if (files && files.length > 0) {
          return Array.from(files).find(candidate => String(candidate.type ?? '').startsWith('image/')) ?? null
        }
        return null
      }, [])

      const onEditorPaste = (event) => {
        const file = imageFromEvent(event.clipboardData)
        if (file === null) return
        event.preventDefault()
        uploadImage(file)
      }

      const onEditorDrop = (event) => {
        const file = imageFromEvent(event.dataTransfer)
        if (file === null) return
        event.preventDefault()
        uploadImage(file)
      }

      /** Reading view: local-path and http(s) links open through the host. */
      const onReaderClick = (event) => {
        const target = event.target
        const anchor = target !== null && typeof target === 'object' && typeof target.closest === 'function'
          ? target.closest('a')
          : null
        if (anchor === null) return
        const href = typeof anchor.getAttribute === 'function' ? (anchor.getAttribute('href') ?? '') : ''
        if (href === '') return
        let path = null
        if (href.startsWith('bfc-path:')) {
          try { path = decodeURIComponent(href.slice('bfc-path:'.length)) } catch { path = null }
        } else if (/^https?:\/\//i.test(href)) {
          path = href
        }
        if (path === null) return
        event.preventDefault()
        event.stopPropagation()
        rpc('openPath', { sessionId, path }).then(
          () => setNoteError(''),
          (failure) => setNoteError(`${t('openFailed')}：${String(failure?.message ?? failure)}`),
        )
      }

      const [paletteW, setPaletteW] = useState(240)
      const startResize = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startW = paletteW
        const onMove = (moveEvent) => setPaletteW(Math.min(420, Math.max(170, startW + moveEvent.clientX - startX)))
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }

      const rows = flows === null ? [] : flows
      return h('div', { className: 'bfc', 'data-business-flows-view': '' },
        h('div', { className: 'bfc-toolbar' },
          h('span', { className: 'bfc-brand' }, '流'),
          h('span', { className: 'bfc-title' }, detail !== null ? detail.title : t('title')),
          h('span', { className: 'bfc-spacer' }),
          detail === null
            ? null
            : editing
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'bfc-btn primary', onClick: submitSave }, t('save')),
                h('button', { type: 'button', className: 'bfc-btn', onClick: () => setEditing(false) }, t('cancel')))
              : h('button', { type: 'button', className: 'bfc-btn', onClick: startEdit }, t('edit')),
        ),
        h('div', { style: { flex: '1 1 auto', display: 'flex', minHeight: 0 } },
          h('div', { className: 'bfc-palette', style: { width: paletteW } },
            h('div', { className: 'bfc-pal-head' },
              h('span', { className: 'bfc-pal-title' }, t('title')),
              flows !== null ? h('span', { className: 'bfc-pal-sub' }, String(rows.length)) : null,
            ),
            h('div', { className: 'bfc-pal-scroll' },
              rows.map((flow) => {
                if (renameId === flow.id) {
                  return h('div', { key: flow.id, className: 'bfc-row-form' },
                    h('input', {
                      className: 'bfc-input',
                      value: renameTitle,
                      maxLength: 60,
                      autoFocus: true,
                      onChange: (event) => setRenameTitle(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') submitRename()
                        if (event.key === 'Escape') setRenameId('')
                      },
                    }),
                    h('button', { type: 'button', className: 'bfc-mini-btn primary', onClick: submitRename }, t('save')),
                    h('button', { type: 'button', className: 'bfc-mini-btn', onClick: () => setRenameId('') }, t('cancel')),
                  )
                }
                if (confirmId === flow.id) {
                  return h('div', { key: flow.id, className: 'bfc-row-form' },
                    h('span', { style: { flex: 1, fontSize: 12 } }, t('confirmDelete')),
                    h('button', { type: 'button', className: 'bfc-mini-btn primary', style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' }, onClick: () => submitRemove(flow.id) }, t('del')),
                    h('button', { type: 'button', className: 'bfc-mini-btn', onClick: () => setConfirmId('') }, t('cancel')),
                  )
                }
                return h('div', {
                  key: flow.id,
                  className: `bfc-card${selectedId === flow.id ? ' active' : ''}`,
                  onClick: () => openFlow(flow.id),
                },
                  h('span', { className: 'bfc-card-title', title: flow.title }, flow.title),
                  h('span', { className: 'bfc-card-actions', onClick: (event) => event.stopPropagation() },
                    h('button', {
                      type: 'button',
                      className: 'bfc-icon-btn',
                      title: t('rename'),
                      onClick: () => { setConfirmId(''); setRenameId(flow.id); setRenameTitle(flow.title) },
                    }, '✎'),
                    h('button', {
                      type: 'button',
                      className: 'bfc-icon-btn',
                      title: t('del'),
                      onClick: () => { setRenameId(''); setConfirmId(flow.id) },
                    }, '✕'),
                  ),
                )
              }),
            ),
            h('div', { className: 'bfc-pal-foot' },
              creating
                ? h('div', { className: 'bfc-row-form' },
                  h('input', {
                    className: 'bfc-input',
                    value: newTitle,
                    placeholder: t('titlePh'),
                    maxLength: 60,
                    autoFocus: true,
                    onChange: (event) => setNewTitle(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') submitCreate()
                      if (event.key === 'Escape') setCreating(false)
                    },
                  }),
                  h('button', { type: 'button', className: 'bfc-mini-btn primary', disabled: newTitle.trim() === '', onClick: submitCreate }, t('create')),
                  h('button', { type: 'button', className: 'bfc-mini-btn', onClick: () => setCreating(false) }, t('cancel')),
                )
                : h('button', { type: 'button', className: 'bfc-new-btn', onClick: () => { setNewTitle(''); setCreating(true) } }, `＋ ${t('newFlow')}`),
            ),
          ),
          h('div', { className: 'bfc-resizer', onMouseDown: startResize }),
          h('div', { className: 'bfc-stage' },
            error !== '' ? h('div', { className: 'bfc-error' }, `${t('loadFailed')}：${error}`) : null,
            detail !== null && noteError !== '' ? h('div', { className: 'bfc-note-error' }, noteError) : null,
            detail === null
              ? h('div', { className: 'bfc-reader' },
                h('div', { className: 'bfc-reader-empty' },
                  rows.length === 0 && flows !== null ? t('empty') : (flows === null ? null : t('pickHint'))))
              : editing
                ? h('div', { className: 'bfc-editor-wrap' },
                  h('textarea', {
                    ref: taRef,
                    className: 'bfc-editor',
                    value: draft,
                    autoFocus: true,
                    spellCheck: false,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                        event.preventDefault()
                        submitSave()
                      }
                    },
                    onPaste: onEditorPaste,
                    onDrop: onEditorDrop,
                  }))
                : h('div', { className: 'bfc-reader', onDrop: onEditorDrop, onClickCapture: onReaderClick },
                  h(AnswerBody, { segments: segmentList, labels, images })),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxRef.service = null
        ctx.effect(() => {
          try { ctxRef.service = ctx.get('connection') ?? null } catch { ctxRef.service = null }
          return () => { ctxRef.service = null }
        }, 'business-flows: connection')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'business-flows: dictionaries')

        ctx.effect(() => {
          const styleElement = document.createElement('style')
          styleElement.dataset.plugin = '@local/business-flows'
          styleElement.textContent = CSS
          document.head.appendChild(styleElement)
          return () => { styleElement.remove() }
        }, 'business-flows: stylesheet')

        const tabLabel = () => (ctx.locale.getLocale().active.startsWith('zh') ? zh['title'] : en['title'])

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: '@local/business-flows/tab',
          order: 16,
          label: tabLabel,
          locale: NS,
          inject: (sessionId) => ({ sessionId: sessionId === undefined ? undefined : String(sessionId), callRpc }),
        }, FlowsPage))

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: '@local/business-flows/collect',
          order: 95,
          locale: NS,
          inject: () => ({ callRpc }),
        }, CollectTail))
      },
    }
  },
})

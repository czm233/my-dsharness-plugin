/**
 * Client half of Business Flows (业务流程).
 *
 * Two registrations:
 *   1. A `conversation.view` tab (the same seat family as the workflow
 *      canvas): left column lists this workspace's collected flows, right
 *      pane reads one as a replayed conversation — the human's prompt and
 *      the assistant's committed answer, rendered with the official
 *      MarkdownText (code blocks included; Mermaid stays a code block for now).
 *   2. A `conversation.chat.turnTail` seat (the same tail row as turn-cost):
 *      a small 「收藏」 button per turn. Picking a flow (or creating one)
 *      stores that turn's question + answer through the host RPC; nothing on
 *      screen is scraped, the host re-reads the turn from the session log.
 *
 * The workspace is derived host-side from the session's cwd, so the same
 * shelf shows for every session of the same project and nowhere else.
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
.bfc-input{flex:1;min-width:0;font-size:12px;padding:5px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));
  background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;outline:none}
.bfc-mini-btn{border:none;background:none;color:inherit;opacity:.75;font-size:12px;padding:4px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}
.bfc-mini-btn:hover:not(:disabled){opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16))}
.bfc-mini-btn:disabled{opacity:.4;cursor:default}
.bfc-mini-btn.primary{opacity:1;font-weight:600}
.bfc-page{display:flex;height:100%;min-height:0;font-size:13px}
.bfc-side{width:220px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));min-height:0}
.bfc-side-head{padding:12px 14px 8px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.bfc-side-list{flex:1;overflow:auto;padding:0 6px;min-height:0}
.bfc-row{position:relative;display:flex;align-items:center;gap:4px;padding:6px 8px;border-radius:8px;cursor:pointer}
.bfc-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.bfc-row.active{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18))}
.bfc-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bfc-row-actions{display:none;flex:none;gap:2px}
.bfc-row:hover .bfc-row-actions,.bfc-row.active .bfc-row-actions{display:flex}
.bfc-icon-btn{border:none;background:none;color:inherit;opacity:.6;font-size:12px;padding:2px 4px;border-radius:5px;cursor:pointer;line-height:1}
.bfc-icon-btn:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2))}
.bfc-row-form{display:flex;align-items:center;gap:4px;padding:4px 6px;width:100%}
.bfc-side-foot{padding:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.bfc-new-btn{width:100%;text-align:left;border:none;background:none;color:inherit;opacity:.7;font-size:12px;
  padding:6px 8px;border-radius:8px;cursor:pointer}
.bfc-new-btn:hover{opacity:1;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12))}
.bfc-main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
.bfc-reader-head{padding:14px 18px 10px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}
.bfc-reader{flex:1;overflow:auto;padding:14px 18px 24px;min-height:0}
.bfc-reader-empty{height:100%;display:flex;align-items:center;justify-content:center;opacity:.55}
.bfc-entry{margin-bottom:18px}
.bfc-q{margin-bottom:8px}
.bfc-q-role{opacity:.55;margin-right:8px;font-size:12px}
.bfc-q-text{white-space:pre-wrap;opacity:.85}
.bfc-a{line-height:1.65}
.bfc-at{margin-top:6px;font-size:11px;opacity:.45}
.bfc-error{padding:10px 14px;color:var(--dsw-alias-state-error-primary,#e5484d)}
`

    function timeLabel(at) {
      const d = new Date(Number(at))
      if (!Number.isFinite(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function AnswerBody(props) {
      const { text, labels } = props
      if (MarkdownText !== null) return h(MarkdownText, { text, labels })
      return h('div', { className: 'bfc-a' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, text))
    }

    /** The turn-tail 「收藏」 button with its flow picker menu. */
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

    function EntryView(props) {
      const { entry, labels, t } = props
      return h('div', { className: 'bfc-entry' },
        h('div', { className: 'bfc-q' },
          h('span', { className: 'bfc-q-role' }, '你'),
          h('div', { className: 'bfc-q-text' }, entry.question),
        ),
        h(AnswerBody, { text: entry.answer, labels }),
        h('div', { className: 'bfc-at' }, timeLabel(entry.at)),
      )
    }

    /** The workspace tab: flows on the left, one replayed conversation on the right. */
    function FlowsPage(props) {
      const safeProps = props && typeof props === 'object' ? props : {}
      const t = typeof safeProps.t === 'function' ? safeProps.t : (key) => zh[key] || key
      const sessionId = typeof safeProps.sessionId === 'string' ? safeProps.sessionId : ''

      const [flows, setFlows] = useState(null)
      const [error, setError] = useState('')
      const [selectedId, setSelectedId] = useState('')
      const [detail, setDetail] = useState(null)
      const [creating, setCreating] = useState(false)
      const [newTitle, setNewTitle] = useState('')
      const [renameId, setRenameId] = useState('')
      const [renameTitle, setRenameTitle] = useState('')
      const [confirmId, setConfirmId] = useState('')
      const labels = markdownLabels(t)

      const reload = useCallback(async () => {
        if (sessionId === '') { setFlows([]); return }
        try {
          const value = await safeProps.callRpc('list', { sessionId })
          setFlows(Array.isArray(value?.flows) ? value.flows : [])
          setError('')
        } catch (failure) {
          setFlows([])
          setError(String(failure?.message ?? failure))
        }
      }, [safeProps.callRpc, sessionId])

      useEffect(() => {
        setSelectedId('')
        setDetail(null)
        reload()
      }, [reload])

      const openFlow = useCallback(async (id) => {
        setSelectedId(id)
        setDetail(null)
        try {
          const value = await safeProps.callRpc('flow', { sessionId, id })
          setDetail(value?.flow ?? null)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [safeProps.callRpc, sessionId])

      const submitCreate = async () => {
        const trimmed = newTitle.trim()
        if (trimmed === '' || sessionId === '') return
        try {
          const value = await safeProps.callRpc('create', { sessionId, title: trimmed })
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
          const value = await safeProps.callRpc('rename', { sessionId, id: renameId, title: trimmed })
          setRenameId('')
          setRenameTitle('')
          await reload()
          if (renameId === selectedId && value?.flow) setDetail(value.flow)
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const submitRemove = async (id) => {
        try {
          await safeProps.callRpc('remove', { sessionId, id })
          setConfirmId('')
          await reload()
          if (id === selectedId) { setSelectedId(''); setDetail(null) }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }

      const rows = flows === null ? [] : flows
      return h('div', { className: 'bfc-page' },
        h('div', { className: 'bfc-side' },
          h('div', { className: 'bfc-side-head' }, t('title')),
          h('div', { className: 'bfc-side-list' },
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
                  h('button', { type: 'button', className: 'bfc-mini-btn primary', style: { color: '#e5484d' }, onClick: () => submitRemove(flow.id) }, t('del')),
                  h('button', { type: 'button', className: 'bfc-mini-btn', onClick: () => setConfirmId('') }, t('cancel')),
                )
              }
              return h('div', {
                key: flow.id,
                className: `bfc-row${selectedId === flow.id ? ' active' : ''}`,
                onClick: () => openFlow(flow.id),
              },
                h('span', { className: 'bfc-row-title', title: flow.title }, flow.title),
                h('span', { className: 'bfc-row-actions', onClick: (event) => event.stopPropagation() },
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
          h('div', { className: 'bfc-side-foot' },
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
        h('div', { className: 'bfc-main' },
          error !== '' ? h('div', { className: 'bfc-error' }, `${t('loadFailed')}：${error}`) : null,
          detail === null
            ? h('div', { className: 'bfc-reader' },
              h('div', { className: 'bfc-reader-empty' },
                rows.length === 0 && flows !== null ? t('empty') : (flows === null ? null : t('pickHint'))))
            : h(React.Fragment, null,
              h('div', { className: 'bfc-reader-head', title: detail.title }, detail.title),
              h('div', { className: 'bfc-reader' },
                (Array.isArray(detail.entries) ? detail.entries : []).map((entry, index) => h(EntryView, {
                  key: `${entry.at ?? ''}-${entry.sessionId ?? ''}-${entry.turn ?? ''}-${index}`,
                  entry, labels, t,
                }))),
            ),
        ),
      )
    }

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

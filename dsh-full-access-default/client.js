// Browser half: one settings row that decides what new sessions run under.
//
// The Host half pins the configured preset on every session it creates, so
// Settings must show that key or it shows a permission picker that no longer
// decides anything. The shipped "权限" row writes `permission/defaultPreset`,
// which the Host's pin then applies to reused sessions as well — good — but the
// shipped row is mounted by another plugin and its control cannot be rebound,
// so this module hides that row and mounts its own control in the same place.
//
// Mounting follows turn-cost's proven seam: a page-level MutationObserver finds
// the shipped row, hides it, and React renders a real control into a seat
// inserted in front of it. Hiding is a display toggle on an element this module
// owns; unmount restores it.

window.__ModuleLoader__.load({
  id: '@local/dsh-full-access-default',
  factory(require) {
    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const h = React.createElement

    // Shipped settings namespace/field; the Host pins whatever this names.
    const SETTINGS_NS = 'permission'
    const FIELD = 'defaultPreset'
    // Bundle-patch preset, used until a preset is chosen in the row.
    const FALLBACK_PRESET = 'danger-full-access'
    const NS = 'fullAccessDefault'
    const ACCESS_NS = 'permission.access'
    const HIDDEN = 'data-full-access-hidden'
    const SEAT_ID = 'dsh-full-access-seat'
    const LABEL_KEYS = {
      'read-only': 'preset.readOnly',
      'workspace-write': 'preset.workspaceWrite',
      'danger-full-access': 'preset.fullAccess',
    }
    const STANDARD_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']

    const zh = {
      title: '新会话权限',
      description: '新建会话时使用的权限模式',
      saving: '保存中',
      failed: '保存失败',
    }
    const en = {
      title: 'New session permission',
      description: 'Permission mode used when a session is created',
      saving: 'Saving',
      failed: 'Save failed',
    }

    // 诊断落盘:桌面客户端没有控制台,客户端行为写进 Host 路由能落到的文件。
    const LOG_PATH = '/api/full-access-default/log'
    function report(event, detail) {
      try {
        const body = JSON.stringify({ event, detail, at: new Date().toISOString() })
        fetch(LOG_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
          .catch(() => {})
      } catch {
        // 诊断失败不影响功能
      }
    }

    /** Title-case a conventional preset name the way the shipped picker does. */
    function displayName(value) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return value
      return value.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    }

    /** Snapshot-store hook (the store contract shipped rows use). */
    function useStore(store) {
      const [snapshot, setSnapshot] = React.useState(() => store.getSnapshot())
      React.useEffect(() => {
        setSnapshot(store.getSnapshot())
        return store.subscribe(() => setSnapshot(store.getSnapshot()))
      }, [store])
      return snapshot
    }

    function PresetRow({ form, t, tAccess }) {
      const state = useStore(form)
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const chosen = state.value?.[FIELD]
      const current = typeof chosen === 'string' && chosen !== '' ? chosen : FALLBACK_PRESET
      const options = [...STANDARD_PRESETS]
      if (!options.includes(current)) options.push(current)
      const label = (value) => {
        const key = LABEL_KEYS[value]
        const known = key === undefined ? undefined : tAccess(key)
        return typeof known === 'string' && known !== '' ? known : displayName(value)
      }
      const write = (next) => {
        setFailed(false)
        setSaving(true)
        form.set(FIELD, next)
          .then((accepted) => { if (accepted === false) setFailed(true) })
          .catch(() => setFailed(true))
          .finally(() => setSaving(false))
      }
      return h('div', {
        'data-full-access-row': '',
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '24px', padding: '16px 0',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('div', { key: 'text' }, [
          h('div', { key: 'title', style: { fontSize: '14px', lineHeight: '20px' } }, t('title')),
          h('div', {
            key: 'desc',
            role: failed ? 'alert' : undefined,
            style: {
              marginTop: '4px', fontSize: '12px', lineHeight: '18px',
              color: 'var(--dsw-alias-label-secondary)',
            },
          }, failed ? t('failed') : saving ? t('saving') : t('description')),
        ]),
        h('select', {
          key: 'select',
          'data-full-access-select': '',
          'aria-label': t('title'),
          value: current,
          disabled: saving || state.writable === false,
          onChange: (event) => write(event.target.value),
          style: {
            minWidth: '8em', padding: '4px 8px', fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)', background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
          },
        }, options.map((value) => h('option', { key: value, value }, label(value)))),
      ])
    }

    /** Is this element the shipped "权限" row on the General settings page? */
    function isShippedPermissionRow(element) {
      if (element.querySelector('button[aria-haspopup="menu"]') === null) return false
      return /仅可查看|Read Only/.test(element.textContent ?? '')
    }

    return {
      inject: ['configForms', 'locale'],
      apply(ctx) {
        report('client/apply', { hasConfigForms: ctx.get('configForms') !== undefined })
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'full-access-default: settings row dictionary')
        const t = ctx.locale.bind(NS)
        const access = ctx.locale.bind(ACCESS_NS)
        const tAccess = (key) => {
          try {
            const value = access?.(key)
            return typeof value === 'string' ? value : undefined
          } catch {
            return undefined
          }
        }
        const form = ctx.configForms.get(SETTINGS_NS)

        // The row itself scrolls like every other general row (2 lines of copy
        // plus control); content beyond that is reachable by touching it.
        const STYLE_ID = 'dsh-full-access-style'
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/dsh-full-access-default'
          style.dataset.pluginCss = STYLE_ID
          style.textContent = [
            '[data-full-access-row]{max-height:72px;overflow-y:auto;box-sizing:border-box}',
            '[data-full-access-row] [data-full-access-select]{flex:none}',
          ].join('')
          document.head.appendChild(style)
        }
        // Re-anchor when the settings surface is resized or re-parented.
        const onResize = () => { mount() }
        window.addEventListener('resize', onResize)

        let lastReported = ''
        const note = (state) => {
          if (state === lastReported) return
          lastReported = state
          report('row/mount', { state })
        }
        note('applied')
        const hiddenRows = new Set()
        let root = null
        let mountedSeat = null
        const mount = () => {
          let slot = null
          for (const candidate of document.querySelectorAll('[data-slot="settings.general.item"]')) {
            const child = candidate.firstElementChild
            if (child !== null && isShippedPermissionRow(child)) {
              slot = candidate
              break
            }
          }
          if (slot === null) {
            note('no-shipped-row')
            return
          }
          const shipped = slot.firstElementChild
          if (shipped !== null && !shipped.hasAttribute(HIDDEN)) {
            shipped.setAttribute(HIDDEN, '1')
            shipped.style.display = 'none'
            hiddenRows.add(shipped)
          }
          for (const node of hiddenRows) if (!node.isConnected) hiddenRows.delete(node)
          let seat = slot.querySelector(`[data-seat="${SEAT_ID}"]`)
          if (seat === null) {
            seat = document.createElement('div')
            seat.setAttribute('data-seat', SEAT_ID)
            seat.style.cssText = 'display:block;width:100%;'
            slot.insertBefore(seat, slot.firstElementChild)
          }
          if (root === null || mountedSeat !== seat) {
            if (root !== null) root.unmount()
            root = createRoot(seat)
            mountedSeat = seat
          }
          root.render(h(PresetRow, { form, t, tAccess }))
          note('seated')
        }

        const observer = new MutationObserver(mount)
        observer.observe(document.body, { childList: true, subtree: true })
        mount()
        ctx.effect(() => () => {
          observer.disconnect()
          window.removeEventListener('resize', onResize)
          if (root !== null) root.unmount()
          for (const node of hiddenRows) {
            node.removeAttribute(HIDDEN)
            node.style.display = ''
          }
          for (const node of document.querySelectorAll(`[data-seat="${SEAT_ID}"]`)) node.remove()
        }, 'full-access-default: settings row mount')
      },
    }
  },
})
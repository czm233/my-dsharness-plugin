// Browser half: expand the reasoning ("思考") rows of the latest chat turn only.
//
// The shipped ReasoningRow renders one disclosure per reasoning block and its
// open state starts collapsed until the reader clicks it, no matter what the
// work-details settings say (those settings only fold whole turn processes).
// This module keeps a page-level MutationObserver over the chat DOM and
// expands collapsed think rows, but only inside the latest turn of each
// conversation:
//
// - `[data-conversation-session]` is the conversation shell's content body and
//   carries the session id as its attribute value (1.3.0). Per-session
//   tracking replaced the 1.2.0 flow key: that release read
//   `data-chat-flow-key` off the first `[data-chat-flow]` element, but DSH
//   now renders that attribute on the (key-less) chat column and on step-group
//   bodies, while the keyed elements are per-chat-node flow items — so the
//   key read as '' forever, `highest` never reset on session switches and one
//   long session's turn numbers bricked every shorter session.
// - `[data-turn-tail]` exists once per rendered turn and carries the
//   per-session turn number, so the last match inside the scope identifies the
//   latest turn of that session;
// - every chat node sits under an ancestor tagged `data-chat-turn`, used to
//   tell which turn a think row belongs to;
// - `highest` never decreases within one session, so paging away from the last
//   turn (which unmounts its tail) cannot make an older turn look like the
//   latest and get expanded by accident; scope entries whose shell element
//   left the document are dropped, so stale scales never leak into remounts;
// - completed work-step groups fold to a header button under group-folding
//   presentation modes, and reasoning rows inside them are not mounted; the
//   latest turn's folded groups are one-click-expanded first so those rows
//   mount and get expanded on the following scan.
// - 1.4.0 running gate: the shipped RunningStatus mounts `div[data-chat-running]`
//   at the flow tail exactly while the session is running or holding its slot
//   (turn still open) and unmounts it once the turn's actions row replaces it,
//   so its presence inside the conversation scope is the DOM's "reply in
//   progress" bit. Scans only click while it is mounted.
// - 1.5.0 fold-back: when the gate closes (reply finished) every row this
//   module expanded during the run is toggled closed again, so the transcript
//   ends as it started; the next turn's indicator re-arms expansion.
//
// Each think root element is processed at most once for expansion (WeakSet):
// rows the reader collapses afterwards stay collapsed, rows already open are
// left alone, and rows that mount later in the same turn still expand. React
// owns the state; we only deliver the same click a reader would, on the
// `[data-disclosure-row][data-expandable]` element where DisclosureRow binds
// its toggle handler. Rows this module expanded are remembered per scope; the
// first scan after the running gate closes folds them back (a second toggle
// click) unless the reader already collapsed them (`data-expanded` gone) or
// they unmounted with their group.
//
// Diagnostics: the desktop client has no console, so scans POST a
// signature-gated breadcrumb to the host route, which appends it to
// ~/.dsh/storages/auto-expand-thinking/client.log (same pattern as
// edit-restart). Logging failures are swallowed; they never affect behavior.

window.__ModuleLoader__.load({
  id: '@local/auto-expand-thinking',
  factory() {
    const ROOT_SELECTOR = 'div[data-variant="think"]'
    const ROW_SELECTOR = '[data-disclosure-row][data-expandable]'
    const TAIL_SELECTOR = '[data-turn-tail]'
    const TURN_ATTR = 'data-chat-turn'
    const TURN_ANCESTOR = `[${TURN_ATTR}]`
    // Conversation shell body carrying the session id as attribute value.
    const SCOPE_SELECTOR = '[data-conversation-session]'
    const SCOPE_ATTR = 'data-conversation-session'
    // Folded work-step group: the shipped ChatGroupSeat collapses to its
    // header button whenever the presentation policy groups completed steps.
    // Reasoning rows inside a folded group are not mounted at all, so the
    // think-row pass below never sees them; this module therefore also
    // one-click-expands the folded groups of the latest turn.
    const GROUP_SELECTOR = '[data-step-process]'
    const GROUP_FOLDED_ATTR = 'data-chat-paging-anchor'
    const GROUP_HEADER_SELECTOR = 'button[aria-expanded="false"]'
    // RunningStatus flag (1.4.0): mounted per flow while the reply is in
    // progress, unmounted once the turn closes. Its presence inside a
    // conversation scope gates every click below.
    const RUNNING_SELECTOR = '[data-chat-running]'

    const processed = new WeakSet()
    const processedGroups = new WeakSet()
    /** scope key → { el, highest }; el only guards staleness. */
    const trackedScopes = new Map()
    let frame = 0
    let lastSig = ''

    /** Scope element a chat node renders in, or null outside any shell. */
    function scopeOf(element) {
      return element.closest(SCOPE_SELECTOR)
    }

    function scopeKeyOf(scopeEl) {
      return scopeEl === null ? '' : scopeEl.getAttribute(SCOPE_ATTR) ?? ''
    }

    /** Latest turn number inside a scope, or null. */
    function lastTailTurnIn(scopeEl) {
      const tails = (scopeEl ?? document).querySelectorAll(TAIL_SELECTOR)
      if (tails.length === 0) return null
      const value = Number(tails[tails.length - 1].getAttribute('data-turn-tail'))
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    }

    /** Per-session state: turn watermark + rows we expanded, reset when the
     * scope left the document. */
    function trackScope(scopeEl, key) {
      let entry = trackedScopes.get(key)
      if (entry !== undefined && entry.el !== null && !entry.el.isConnected) entry = undefined
      if (entry === undefined) {
        entry = { el: scopeEl, highest: 0, ours: new Set() }
        trackedScopes.set(key, entry)
      }
      return entry
    }

    function diag(line) {
      try {
        fetch('/api/auto-expand-thinking/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'log', lines: [line] }),
        }).catch(() => {})
      } catch (_offline) {
        /* 离线时不留痕 */
      }
    }

    /** Owner turn number of an element, or null when untagged. */
    function ownerTurnOf(element) {
      const owner = element.closest(TURN_ANCESTOR)
      if (owner === null) return null
      const value = Number(owner.getAttribute(TURN_ATTR))
      return Number.isSafeInteger(value) ? value : null
    }

    function scan() {
      frame = 0
      let clicked = 0
      let inTurn = 0
      let elsewhere = 0
      let open = 0
      let groupsClicked = 0
      let idle = 0
      let collapsed = 0
      const samples = []
      const ownerCounts = new Map()
      const scopeLabels = []
      try {
        // Bucket roots and folded groups by conversation scope first, then
        // run the watermark + latest-turn passes per scope.
        const buckets = new Map()
        const roots = document.querySelectorAll(ROOT_SELECTOR)
        for (const root of roots) {
          const scopeEl = scopeOf(root)
          let bucket = buckets.get(scopeEl)
          if (bucket === undefined) {
            bucket = { key: scopeKeyOf(scopeEl), roots: [], groups: [] }
            buckets.set(scopeEl, bucket)
          }
          bucket.roots.push(root)
        }
        for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
          if (processedGroups.has(group) || !group.hasAttribute(GROUP_FOLDED_ATTR)) continue
          const scopeEl = scopeOf(group)
          const bucket = buckets.get(scopeEl)
          if (bucket === undefined) continue
          bucket.groups.push(group)
        }
        for (const [scopeEl, bucket] of buckets) {
          if (scopeLabels.length < 3) scopeLabels.push(bucket.key.slice(0, 24) || '(none)')
          const turn = lastTailTurnIn(scopeEl)
          if (turn === null) continue
          const entry = trackScope(scopeEl, bucket.key)
          // Running gate (1.4.0): expand only while the official
          // RunningStatus element is mounted. Holding (paused / waiting
          // mid-turn) keeps it mounted, so only a closed turn reaches the
          // fold-back below.
          if (scopeEl === null || scopeEl.querySelector(RUNNING_SELECTOR) === null) {
            // Fold-back (1.5.0): toggle closed the rows we expanded during
            // the run. Reader-collapsed rows lost `data-expanded` and stay
            // put; rows unmounted with their group are skipped.
            for (const root of entry.ours) {
              if (!root.isConnected || !root.hasAttribute('data-expanded')) continue
              const row = root.querySelector(ROW_SELECTOR)
              if (row === null) continue
              row.click()
              collapsed += 1
            }
            entry.ours.clear()
            idle += 1
            if (samples.length < 3) samples.push('idle')
            continue
          }
          if (turn < entry.highest) continue
          entry.highest = turn
          entry.el = scopeEl
          // Folded work-step groups hide their reasoning rows entirely; open
          // the latest turn's folded groups first so the rows mount.
          for (const group of bucket.groups) {
            if (ownerTurnOf(group) !== turn) continue
            const header = group.querySelector(GROUP_HEADER_SELECTOR)
            if (header === null) continue
            processedGroups.add(group)
            header.click()
            groupsClicked += 1
          }
          for (const root of bucket.roots) {
            if (processed.has(root)) continue
            if (root.hasAttribute('data-expanded')) {
              processed.add(root)
              open += 1
              continue
            }
            const rootTurn = ownerTurnOf(root)
            if (rootTurn !== turn) {
              elsewhere += 1
              ownerCounts.set(rootTurn, (ownerCounts.get(rootTurn) ?? 0) + 1)
              if (samples.length < 3) samples.push(`elsewhere(turn=${rootTurn})`)
              continue
            }
            inTurn += 1
            const row = root.querySelector(ROW_SELECTOR)
            if (row === null) {
              if (samples.length < 3) samples.push('norow')
              continue
            }
            processed.add(root)
            row.click()
            entry.ours.add(root)
            clicked += 1
          }
        }
        // Drop scopes whose shell left the document so their turn scale
        // cannot leak into a later remount of the same session.
        for (const [key, entry] of trackedScopes) {
          if (entry.el !== null && !entry.el.isConnected) trackedScopes.delete(key)
        }
        const tailValues = [...document.querySelectorAll(TAIL_SELECTOR)].map((tail) => tail.getAttribute('data-turn-tail')).slice(-12).join(',')
        const histogram = [...ownerCounts.entries()].map(([owner, count]) => `${owner}:${count}`).slice(0, 8).join(',')
        const sig = `${clicked}|${inTurn}|${elsewhere}|${open}|${groupsClicked}|${idle}|${collapsed}|${buckets.size}|${samples.join(',')}|${histogram}|${tailValues}`
        if (sig !== lastSig) {
          lastSig = sig
          diag(`scan scopes=[${scopeLabels.join(',')}] tails=[${tailValues}] roots=${roots.length} inTurn=${inTurn} clicked=${clicked} elsewhere=${elsewhere} open=${open} groupsClicked=${groupsClicked} idle=${idle} collapsed=${collapsed}${histogram !== '' ? ` owners=${histogram}` : ''}${samples.length > 0 ? ` samples=${samples.join(',')}` : ''}`)
        }
      } catch (error) {
        diag(`scan-error ${String(error?.stack ?? error)}`)
      }
    }

    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(scan)
    }

    return {
      inject: [],
      apply(ctx) {
        diag('client applied')
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-expanded'],
        })
        schedule()
        ctx.effect(() => () => {
          observer.disconnect()
          if (frame !== 0) {
            cancelAnimationFrame(frame)
            frame = 0
          }
        }, 'auto-expand-thinking: observer teardown')
      },
    }
  },
})

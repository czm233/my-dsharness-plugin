// Browser half: expand the reasoning ("思考") rows of the latest chat turn only.
//
// The shipped ReasoningRow renders one disclosure per reasoning block and its
// open state starts collapsed until the reader clicks it, no matter what the
// work-details settings say (those settings only fold whole turn processes).
// This module keeps a page-level MutationObserver over the chat DOM and
// expands collapsed think rows, but only inside the latest turn:
//
// - `[data-turn-tail]` exists once per rendered turn and carries the turn
//   number, so the last match in document order identifies the latest turn;
// - every chat node sits under an ancestor tagged `data-chat-turn`, used to
//   tell which turn a think row belongs to;
// - `[data-chat-flow-key]` identifies the rendered chat flow, so switching
//   sessions resets tracking instead of comparing turn numbers across flows;
// - `highest` never decreases within one flow, so paging away from the last
//   turn (which unmounts its tail) cannot make an older turn look like the
//   latest and get expanded by accident;
// - completed work-step groups fold to a header button under group-folding
//   presentation modes, and reasoning rows inside them are not mounted; the
//   latest turn's folded groups are one-click-expanded first so those rows
//   mount and get expanded on the following scan.
//
// Each think root element is processed at most once (WeakSet): rows the
// reader collapses afterwards stay collapsed, rows already open are left
// alone, and rows that mount later in the same turn still expand. React owns
// the state; we only deliver the same click a reader would, on the
// `[data-disclosure-row][data-expandable]` element where DisclosureRow binds
// its toggle handler.
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
    const FLOW_SELECTOR = '[data-chat-flow]'
    const FLOW_KEY_ATTR = 'data-chat-flow-key'
    // Folded work-step group: the shipped ChatGroupSeat collapses to its
    // header button whenever the presentation policy groups completed steps.
    // Reasoning rows inside a folded group are not mounted at all, so the
    // think-row pass below never sees them; this module therefore also
    // one-click-expands the folded groups of the latest turn.
    const GROUP_SELECTOR = '[data-step-process]'
    const GROUP_FOLDED_ATTR = 'data-chat-paging-anchor'
    const GROUP_HEADER_SELECTOR = 'button[aria-expanded="false"]'

    const processed = new WeakSet()
    const processedGroups = new WeakSet()
    let frame = 0
    let flowKey = null
    let highest = 0
    let lastSig = ''

    /** null when no chat flow is rendered (settings open, empty state, …). */
    function currentFlowKey() {
      const flow = document.querySelector(FLOW_SELECTOR)
      return flow === null ? null : flow.getAttribute(FLOW_KEY_ATTR) ?? ''
    }

    /** Latest turn number present in the DOM, or null. */
    function lastTailTurn() {
      const tails = document.querySelectorAll(TAIL_SELECTOR)
      if (tails.length === 0) return null
      const value = Number(tails[tails.length - 1].getAttribute('data-turn-tail'))
      return Number.isSafeInteger(value) && value >= 0 ? value : null
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
      let groupsFolded = 0
      const samples = []
      const ownerCounts = new Map()
      try {
        const key = currentFlowKey()
        if (key === null) {
          if (lastSig !== 'no-flow') {
            lastSig = 'no-flow'
            diag('scan no-flow')
          }
          return
        }
        if (key !== flowKey) {
          flowKey = key
          highest = 0
        }
        const turn = lastTailTurn()
        const roots = document.querySelectorAll(ROOT_SELECTOR)
        if (turn !== null && turn >= highest) {
          highest = turn
          // Folded work-step groups hide their reasoning rows entirely; open
          // the latest turn's folded groups first so the rows mount.
          for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
            if (processedGroups.has(group) || !group.hasAttribute(GROUP_FOLDED_ATTR)) continue
            const groupTurn = ownerTurnOf(group)
            if (groupTurn !== turn) continue
            const header = group.querySelector(GROUP_HEADER_SELECTOR)
            if (header === null) continue
            processedGroups.add(group)
            header.click()
            groupsClicked += 1
          }
          for (const root of roots) {
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
            clicked += 1
          }
          for (const group of document.querySelectorAll(GROUP_SELECTOR)) {
            if (processedGroups.has(group) || !group.hasAttribute(GROUP_FOLDED_ATTR)) continue
            if (ownerTurnOf(group) === turn) groupsFolded += 1
          }
        } else {
          for (const root of roots) {
            if (processed.has(root) || root.hasAttribute('data-expanded')) continue
            elsewhere += 1
          }
        }
        const tailValues = [...document.querySelectorAll(TAIL_SELECTOR)].map((tail) => tail.getAttribute('data-turn-tail')).slice(-12).join(',')
        const histogram = [...ownerCounts.entries()].map(([owner, count]) => `${owner}:${count}`).slice(0, 8).join(',')
        const sig = `${key}|${turn}|${highest}|${clicked}|${inTurn}|${elsewhere}|${open}|${groupsClicked}|${groupsFolded}|${samples.join(',')}|${histogram}|${tailValues}`
        if (sig !== lastSig) {
          lastSig = sig
          diag(`scan flow=${key.slice(0, 24)} tails=[${tailValues}] highest=${highest} roots=${roots.length} inTurn=${inTurn} clicked=${clicked} elsewhere=${elsewhere} open=${open} groupsClicked=${groupsClicked} groupsFolded=${groupsFolded}${histogram !== '' ? ` owners=${histogram}` : ''}${samples.length > 0 ? ` samples=${samples.join(',')}` : ''}`)
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

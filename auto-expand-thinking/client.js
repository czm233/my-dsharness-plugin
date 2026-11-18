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
//   latest and get expanded by accident.
//
// Each think root element is processed at most once (WeakSet): rows the
// reader collapses afterwards stay collapsed, rows already open are left
// alone, and rows that mount later in the same turn still expand. React owns
// the state; we only deliver the same click a reader would, on the
// `[data-disclosure-row][data-expandable]` element where DisclosureRow binds
// its toggle handler.

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

    const processed = new WeakSet()
    let frame = 0
    let flowKey = null
    let highest = 0

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

    function scan() {
      frame = 0
      const key = currentFlowKey()
      if (key === null) return
      if (key !== flowKey) {
        flowKey = key
        highest = 0
      }
      const turn = lastTailTurn()
      if (turn === null || turn < highest) return
      highest = turn
      for (const root of document.querySelectorAll(ROOT_SELECTOR)) {
        if (processed.has(root) || root.hasAttribute('data-expanded')) continue
        const owner = root.closest(TURN_ANCESTOR)
        if (owner === null || Number(owner.getAttribute(TURN_ATTR)) !== turn) continue
        const row = root.querySelector(ROW_SELECTOR)
        if (row !== null) {
          processed.add(root)
          row.click()
        }
      }
    }

    function schedule() {
      if (frame === 0) frame = requestAnimationFrame(scan)
    }

    return {
      inject: [],
      apply(ctx) {
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

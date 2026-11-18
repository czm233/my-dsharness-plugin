// Browser half: expand every chat reasoning ("思考") row automatically.
//
// The shipped ReasoningRow renders one disclosure per reasoning block and its
// open state starts collapsed until the reader clicks it, no matter what the
// work-details settings say (those settings only fold whole turn processes).
// This module keeps a page-level MutationObserver over the disclosure DOM:
// every `div[data-variant="think"]` that mounts without `data-expanded` gets
// one programmatic click on its `[data-disclosure-row][data-expandable]`
// element, which is exactly where DisclosureRow binds the toggle handler.
//
// Each root element is processed at most once (WeakSet): rows the reader
// collapses afterwards stay collapsed, and rows already open are left alone.
// React owns the state; we only deliver the same click a reader would.

window.__ModuleLoader__.load({
  id: '@local/auto-expand-thinking',
  factory() {
    const ROOT_SELECTOR = 'div[data-variant="think"]'
    const ROW_SELECTOR = '[data-disclosure-row][data-expandable]'

    const processed = new WeakSet()
    let frame = 0

    /** Deliver one toggle click to a collapsed reasoning row. */
    function expandRoot(root) {
      const row = root.querySelector(ROW_SELECTOR)
      if (row === null) return false
      processed.add(root)
      row.click()
      return true
    }

    function scan() {
      frame = 0
      for (const root of document.querySelectorAll(ROOT_SELECTOR)) {
        if (processed.has(root) || root.hasAttribute('data-expanded')) continue
        expandRoot(root)
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

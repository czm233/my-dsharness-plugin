/**
 * Host half of Side Chat (侧边对话), fork-subagent edition.
 *
 * The Client half posts the first side-chat message to `/api/side-chat/create`;
 * this half resolves the live parent Agent for the session and starts one
 * continuable child activation through the `fork` subagent backend
 * (`dsh-subagent-fork-in-process`), whose seed is the parent's completed
 * conversation turns. The child therefore continues the parent conversation
 * with full inherited context, never joins the left session list, and is
 * chatted with through the official subagent delivery surface.
 */

/** Cap the catalog label so one long first message cannot flood the tab strip. */
const LABEL_MAX = 40

/**
 * Create one fork-backend continuable child for the session.
 * @param child - injected Host context carrying the session controller,
 *   subagent service, and connection.
 * @param body - `{ sessionId, text }` from the Client half.
 * @returns `{ childId, label }`.
 */
async function createBranch(child, body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (sessionId === '' || text === '') throw new Error('sessionId and text are required')

  const controller = child['session-controller']
  const subagents = child.subagents
  if (typeof controller?.resolveAgent !== 'function') throw new Error('session controller unavailable')
  if (typeof subagents?.startActivation !== 'function') throw new Error('subagent service unavailable')

  const found = await controller.resolveAgent(sessionId)
  if (found !== null && typeof found === 'object' && 'error' in found) throw found.error
  const parent = found?.agent
  if (parent === undefined) throw new Error(`session "${sessionId}" resolved no agent`)

  const label = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text
  const { childId } = await subagents.startActivation({
    provider: 'fork',
    label,
    request: {
      prompt: [{ type: 'text', text }],
      parent,
    },
    delivery: 'parent',
  })
  if (typeof childId !== 'string' || childId === '') throw new Error('subagent service returned no childId')
  return { childId, label }
}

/**
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['session-controller', 'subagents', 'connection'], (child) => {
    child.effect(() => {
      const dispose = child.connection.fetch.register({
        path: '/api/side-chat/create',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const result = await createBranch(child, await request.json())
            return Response.json(result)
          } catch (error) {
            child.logger?.warn?.(`[side-chat] create failed: ${String(error)}`)
            return Response.json({ error: String((error && error.message) || error) }, { status: 500 })
          }
        },
      })
      return () => { dispose() }
    }, 'side-chat: create route')
  })
}

/**
 * Host half of composer-effort-chips.
 *
 * 只做一件事：接收 Client 半上传来的档位布局测量数据并落盘，供开发时
 * 用文件读取核对（用户环境是桌面客户端，没有可用的控制台）。
 *
 *   POST /api/composer-effort-chips/probe   body: {frames: [...]}
 *     -> 写入 ~/.dsh/storages/composer-effort-chips/probe.json
 *
 * 不参与任何渲染逻辑。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROUTE = '/api/composer-effort-chips/probe'

function storageDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'storages', 'composer-effort-chips')
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function apply(ctx) {
  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.connection
    if (!connection || !connection.fetch) return

    connectionCtx.effect(
      function () {
        return connection.fetch.register({
          path: ROUTE,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async function (request) {
            let body = null
            try {
              body = await request.json()
            } catch {
              return json({ error: 'bad-body' }, 400)
            }
            const frames = body && Array.isArray(body.frames) ? body.frames : null
            if (frames === null) return json({ error: 'missing-frames' }, 400)
            try {
              const dir = storageDir()
              fs.mkdirSync(dir, { recursive: true })
              fs.writeFileSync(
                path.join(dir, 'probe.json'),
                JSON.stringify({ updatedAt: new Date().toISOString(), frames }, null, 2),
              )
              return json({ ok: true, count: frames.length })
            } catch (error) {
              return json({ error: String((error && error.message) || error) }, 500)
            }
          },
        })
      },
      'composer-effort-chips: probe route',
    )
  })
}
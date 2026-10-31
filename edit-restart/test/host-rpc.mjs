/**
 * edit-restart 的 Host→客户端诊断通道（桌面端没有控制台时用它）。
 * 必须用宿主自己的 Electron 以 node 身份运行（见 usage）。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<DSH>/Contents/MacOS/DeepSeek Harness" \
 *     edit-restart/test/host-rpc.mjs "<json payload file>"
 *
 * 载荷文件：{ "type": "http", "url": "/api/edit-restart/rpc", "body": "<string>" }
 *         | { "type": "rpc", "channel": "/api", "method": "edit-restart/rpc", "payload": {...} }
 */
import { promises as fsp } from 'node:fs'

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const requestFile = process.argv[2]
const log = (...parts) => console.log('[host-rpc]', ...parts)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const request = JSON.parse(await fsp.readFile(requestFile, 'utf8'))
log('request', JSON.stringify(request).slice(0, 200))

const gatewayMod = await import(`file://${encodeURI(ASAR)}/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`)
log('exports', Object.keys(gatewayMod).join(','))

/** 在进程里找出第一个满足条件的 gateway 实例（cordis Service 的共享单例）。 */
function findGateway() {
  for (const [name, value] of Object.entries(gatewayMod)) {
    if (typeof value !== 'function') continue
    try {
      const instance = value()
      if (instance && (typeof instance.invoke === 'function' || typeof instance.stream === 'function')) return { name, instance }
    } catch (_notShared) { /* 不是共享单例，跳过 */ }
  }
  return null
}

let found = null
for (let attempt = 0; attempt < 240 && found === null; attempt += 1) {
  found = findGateway()
  if (found === null) await delay(500)
}
if (found === null) {
  log('no live gateway instance')
  process.exit(1)
}
log('gateway via', found.name, Object.getOwnPropertyNames(Object.getPrototypeOf(found.instance)).slice(0, 12).join(','))

try {
  if (request.type === 'http') {
    const entryNames = ['handleRequest', 'handle', 'fetch', 'serve']
    const entry = entryNames.map((name) => found.instance[name]).find((fn) => typeof fn === 'function')
    if (!entry) throw new Error(`no http entry (${entryNames.join('/')})`)
    const response = await entry.call(found.instance, `http://127.0.0.1${request.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body })
    const text = typeof response?.text === 'function' ? await response.text() : JSON.stringify(response)
    log('RESULT', text)
  } else {
    const result = await found.instance.invoke(request)
    log('RESULT', JSON.stringify(result))
  }
} catch (error) {
  log('FAILED', String(error?.stack ?? error))
  process.exit(1)
}

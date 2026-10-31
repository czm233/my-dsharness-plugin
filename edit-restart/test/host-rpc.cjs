#!/usr/bin/env node
/*
 * edit-restart 的 Host→客户端诊断通道（桌面端没有控制台时用它）：
 * 在同一安装目录里启动一个 Electron(以 node 身份运行) 进程，import Host 侧使用的
 * @deepseek-ai/dsh-api-gateway，找到当前 live 的 gateway 实例，替客户端调用一次 RPC。
 *
 * 用法：
 *   node edit-restart/test/host-rpc.cjs "'/api', 'edit-restart/rpc', { action: 'drafts' }"
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const GATEWAY = `file://${encodeURI(ASAR)}/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`

const call = process.argv[2]
if (!call) {
  console.error('usage: node host-rpc.cjs "<channel>, <method>, <payload-json>"')
  process.exit(2)
}

const worker = `
import { pathToFileURL } from 'node:url'
const mod = await import(${JSON.stringify(GATEWAY)})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let service = null
for (let attempt = 0; attempt < 240 && service === null; attempt += 1) {
  try {
    const created = new mod.TypertGatewayService()
    service = created
  } catch (error) {
    if (attempt === 0) console.log('[worker] ctor failed:', String(error?.message ?? error))
  }
  if (service === null) await delay(500)
}
console.log('[worker] service', service ? Object.getOwnPropertyNames(Object.getPrototypeOf(service)) : 'none')
const [channel, method, payload] = [${call}]
const result = await service.invoke({ channel, method, payload })
console.log('RESULT', JSON.stringify(result))
`

const child = spawn('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', ['--input-type=module', '-e', worker], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 0))

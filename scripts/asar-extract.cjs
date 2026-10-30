#!/usr/bin/env node
/**
 * 从安装包 app.asar 里抽出官方 DSH 包的 client/host 实现，用于核对扩展点契约。
 *
 * 背景（PITFALLS #25）：官方 README 只描述行为、不写字段类型；凭 README 猜
 * 扩展点字段形状会崩掉官方 UI（如 guide entry 的 title 是函数而非字符串）。
 * 唯一可靠来源是装出去的那份 `lib/client.js`。
 *
 * 用法：
 *   node scripts/asar-extract.cjs @deepseek-ai/dsh-client-ui-sidebar-right client.js /tmp/out.js
 *   node scripts/asar-extract.cjs @deepseek-ai/dsh-client-ui-subagent client.js /tmp/out.js --dir dsh
 *   node scripts/asar-extract.cjs --list @deepseek-ai/dsh-client-ui-sidebar-right
 *
 * 参数：<包名> <lib 内文件名> <输出路径>
 *   --dir <root>   包所在根，默认 dsh/node_modules（也可 node_modules）
 *   --list         只列出该包 lib/ 下的文件名
 *
 * asar 布局：前 8 字节 pickle 头（@4 = header pickle 大小），header 是
 * {files: {...}} 目录树，文件数据自 8 + headerPickleSize 起按 offset 定位。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

function openArchive(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerPickleSize = head.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerPickleSize)
  fs.readSync(fd, headerBuf, 0, headerPickleSize, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'))
  return { fd, header, dataStart: 8 + headerPickleSize }
}

function resolveNode(header, parts) {
  let node = header
  for (const part of parts) {
    node = (node.files ?? node)[part]
    if (node === undefined) return undefined
  }
  return node
}

function main() {
  const args = process.argv.slice(2)
  const asarPath = process.env.DSH_ASAR || DEFAULT_ASAR
  if (args.includes('--list')) {
    const pkg = args[args.indexOf('--list') + 1]
    const dirIdx = args.indexOf('--dir')
    const dir = dirIdx >= 0 ? args[dirIdx + 1] : 'dsh/node_modules'
    const { header } = openArchive(asarPath)
    const node = resolveNode(header, [...dir.split('/'), ...pkg.split('/'), 'lib'])
    if (node === undefined) {
      console.error(`not found: ${dir}/${pkg}/lib`)
      process.exit(1)
    }
    console.log(Object.keys(node.files).join('\n'))
    return
  }
  const [pkg, libFile, out] = args
  if (!pkg || !libFile || !out) {
    console.error('usage: node scripts/asar-extract.cjs <package> <libFile> <out> [--dir root]')
    process.exit(2)
  }
  const dirIdx = args.indexOf('--dir')
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : 'dsh/node_modules'
  const { fd, header, dataStart } = openArchive(asarPath)
  const file = resolveNode(header, [...dir.split('/'), ...pkg.split('/'), 'lib', libFile])
  if (file === undefined || file.size === undefined) {
    console.error(`not found: ${dir}/${pkg}/lib/${libFile}`)
    process.exit(1)
  }
  const buf = Buffer.alloc(file.size)
  fs.readSync(fd, buf, 0, file.size, dataStart + Number(file.offset))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf)
  console.log(`${out} (${file.size} bytes)`)
}

main()
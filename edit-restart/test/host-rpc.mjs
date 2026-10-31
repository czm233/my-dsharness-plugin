/**
 * edit-restart 的 Host→客户端诊断通道（桌面端没有控制台时用它）。
 *
 * 以「宿主自己的 Electron 可执行文件 + ELECTRON_RUN_AS_NODE」在 app.asar 的真实运行时里
 * import Host 侧官方 gateway，找到当前 live 的服务实例，替客户端发起一次 RPC。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<DSH.app>/Contents/MacOS/DeepSeek Harness" \
 *     edit-restart/test/host-rpc.mjs "<channel>, <method>, <payload-json>"
 */
const ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** 找出 Host 运行时里所有已经创建过的 cordis Service 实例（gateway 是其中之一）。 */
function findGatewayService() {
  const { TypertGatewayService } = globalThis.__gateway
  void TypertGatewayService
  return null
}
void ASAR

const { default: mod } = await import(`file://${encodeURI(ASAR)}/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`)
console.log('exports', Object.keys(mod))
console.log(process.argv.slice(2))

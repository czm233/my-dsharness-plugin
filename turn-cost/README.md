# @local/turn-cost

在每轮回答末尾的 turn-tail 操作栏里显示按模型牌价折算的金额（≈$x.xx）与模型名，点击可展开费用构成、缓存命中率和换模型提示。

## 原理

- 金额 pill 渲染在原生「用量」pill 的左侧（portal 插入该单元格操作栏，原生功能不动；找不到锚点时退回独立一行），插件停用即完全还原。
- Host 半从持久化会话日志折叠该轮所有 `assistant/message`，每条尝试都带自己的 `source.provider / source.model`；金额按该条尝试的 route 单独定价后求和，所以会话中途从 flash 换到 pro，本轮立即按 pro 的单价计算，不会沿用上一轮的旧价。
- 同一轮内若出现多个模型（例如中途 fallback / 换模型），面板按模型分别列出费用。
- 换模型后的首轮会标出「上一个模型的输入缓存不再复用」；缓存命中率按服务端实际上报的 `cacheReadTokens` 显示。

## 单价

`prices.json`：`models` 按模型 id（大小写不敏感，支持前缀匹配带日期后缀的 id）列出单价，单位是 USD / 1M tokens；`input` 是未缓存输入，`cacheRead` 是缓存命中，`cacheWrite` 是缓存写入，`output` 是输出。数组形式 `[空闲, 高峰]` 用于分时价格，单值表示固定价。

```json
{
  "currency": "$",
  "models": {
    "example-model": {
      "label": "Example Model",
      "shortLabel": "Example",
      "peak": true,
      "input": [0.15, 0.3],
      "cacheRead": [0.003, 0.006],
      "cacheWrite": [0, 0],
      "output": [0.6, 1.2]
    }
  }
}
```

- `peak: true` 时按 attempt 的时间选择高峰/空闲价：`hours: "deepseek"`（默认）为北京时间工作日 09–12、14–18；`hours: "bailian"` 为北京时间每天 08–22。
- 可选 `providers` 覆盖表按 provider 覆盖同名模型。
- 未收录的模型不会套用别的模型的价格：面板显示「未收录单价」，合计不含该模型。

金额是“按牌价折算的等效金额”，不是实际账单；订阅套餐不按 token 计费。

## 开发检查

```bash
node turn-cost/test/pricing-sim.cjs
```

覆盖价格匹配、峰谷时段、同 token 下 flash/pro 的差价、跨轮换模型检测、同轮内换模型、未收录模型和缓存命中价。
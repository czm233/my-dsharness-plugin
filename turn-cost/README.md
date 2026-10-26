# @local/turn-cost

把每轮回答末尾的“本轮用量 N tok”替换为按模型牌价折算的金额（≈¥x.xx），点击可展开 token 明细与费用构成。

## 原理

- 金额 pill 渲染在 turn-tail 操作栏内、原生「用量」pill 的**左侧**（portal 插入该单元格操作栏，原生功能一律不动；找不到锚点时退回独立一行），插件停用即完全还原。
- 每轮 token 数据通过自注册的 Conversation 节点定义（`kind: 'turnCost'`）从会话事件的 `assistant/message` 折叠而来，与原生 turn-tail 面板的口径一致（未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理，含重试的多次尝试求和）。

## 单价

`prices.json`（每次页面刷新后生效）：

```json
{
  "currency": "¥",
  "perMillion": { "input": 0.8, "cacheRead": 0.23, "cacheWrite": 0, "output": 2.8 }
}
```

默认值是 GLM-5.3-Flash 的国内牌价（输入 ¥0.8/M、缓存命中 ¥0.23/M、输出 ¥2.8/M，缓存存储限时免费记 0）。金额为“按牌价折算的等效金额”，不是实际账单——订阅套餐不按 token 计费。

Host 半通过 `harness.handle('turnCost/prices')` 把该表提供给浏览器半；若 RPC 通道不可用，浏览器半使用内置的同值默认价。

## 已知限制

- 显示的金额取决于会话事件里的 provider 报告用量；个别请求缺用量桶时对应行省略、金额按已有桶计算。
- 隐藏原生 pill 依赖 `[data-turn-tail]` 与 `aria-haspopup='dialog'` 这两个稳定 DOM 契约；若未来版本改变结构，最坏情况是“金额与原生 token 数同时显示”，不会崩溃。

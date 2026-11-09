# 计划：节点级模型选择（agent-workflow-board 2.19.0）

## 目标

工作节点可以指定 provider + model（如 UI 用 Claude、后端用 GPT），子代理按指定模型执行。
模型失效时（例如以前选的 GLM 已不存在）不让节点直接报错，按节点设定降级或停止。

## 已定决策

| 问题 | 决定 |
|---|---|
| 模型挂在哪层 | 角色给默认值，节点可覆盖；都没设 = 默认模型 |
| 围栏遇到模型不一致 | 自动改写 subagent 参数（阶段 0 已确认可改参，方案 A 成立） |
| 模型失效 | 节点开关「用默认模型（默认）/ 停止」；保存的值不清空 |
| 检查时机 | 点「启动」时主检查 + compileSpec 兜底，共用一个检查函数 |
| 适用节点 | 只有派发型工作节点；选了模型的节点强制派发，`exec: 'lead'` 与模型互斥 |
| 会话级模型授权（阶段 0 新增） | 绑定时插件向会话 append 官方 model-selection-policy 事件，授权画布路由并集（用户 2026-11-09 拍板方案 A） |

## 数据结构

节点（`doc.nodes[]`，type=work）新增可选字段：

```json
{ "model": { "provider": "anthropic", "id": "claude-xxx" }, "onModelMissing": "fallback" }
```

- `onModelMissing`: `"fallback"`（缺省）| `"stop"`
- 角色 .md frontmatter 新增可选 `provider:` / `model:`
- 生效模型 = 节点.model ?? 角色.model ?? 无
- 旧画布没有这些字段，行为与 2.18.4 完全一致（无需迁移）

## 阶段 0：调研（先做，结论写进本文件末尾）

1. 宿主侧怎么拿「当前可用的 provider/model 列表」：查 DSH 里 `list_subagent_models` 工具背后的服务（app.asar 中搜 `list_subagent_models`），确认 host.js 的 ctx 能否调用同一服务。拿不到时退路：读 profile 配置里的渠道表（只读，不改 `~/.dsh/profiles/*`，AGENTS.md §22）。
2. `tools/pre-execute` 的 `exec` 对象：确认 `exec.arguments` 能否在 `next()` 前修改并生效。不能改参 → 围栏改为 deny + 提示正确参数（方案 B）。
3. subagent 的 provider/model 参数在 tool/call 事件里的字段名，供投影记录「实际用了哪个模型」。

## 阶段 1：宿主 host.js

1. `listModels()`：返回 `[{provider, id, label}]`，带 30 秒缓存；失败返回 `null`（未知 ≠ 空）。
2. `resolveNodeModel(node, roster, available)` → `{ wanted, effective, status }`
   - status: `none`（没设）| `ok` | `missing` | `unknown`（列表拿不到，按 ok 处理，不误伤）
   - missing + fallback → effective = null；missing + stop → 报告阻断
3. `checkCanvasModels(doc)` → `{ ok, issues:[{nodeId,label,wanted,policy}] }`，启动与编译共用。
4. RPC 新增 action：`listModels`、`checkModels`。
5. compileSpec 工作节点段落：
   - ok：追加「派发时 subagent 参数必须带 provider="…" model="…"」
   - missing+fallback：不写模型参数，追加「设定的 X 不可用，用默认模型执行，汇报时注明」
   - missing+stop：该节点段落写「模型 X 不可用，流程在此停止，向用户说明并等待重新选择」（兜底路径，正常情况启动时已拦下）
6. 围栏（tools/pre-execute）：当前 running 节点是派发型且有生效模型时
   - 参数缺失或不一致 → 改写为节点模型（方案 A）或 deny 并给出正确参数（方案 B）
   - 节点模型失效 → 删掉参数里的失效模型后放行
   - 任何异常放行（保持现有「宁漏勿误伤」原则）
7. 投影 lane 增加 `model` 字段，记录 tool/call 实际带的模型。

## 阶段 2：客户端 client.js

1. 节点设置面板：工作节点加「模型」下拉（选项来自 `listModels`，首项「默认」）+「不可用时」二选一。选了模型时把执行方式锁为派发。
2. 角色编辑器：加同样的模型下拉，写入 frontmatter。
3. 画布节点卡片：模型失效时红色标记，悬停提示「X 不可用，将用默认模型 / 将停止」。不加常驻文字（用户级 AGENTS.md §2/§14）。
4. `toggleRun` 启动前调用 `checkModels`：
   - 无问题 → 照旧绑定
   - 只有 fallback 问题 → 照旧绑定，toast 一句「N 个节点改用默认模型」
   - 有 stop 问题 → 不绑定，弹窗列出节点，每行一个模型下拉可就地改选；改完保存再启动
5. locale 补文案（中/英）。

## 阶段 3：测试（门禁，AGENTS.md §3.5 第 4 条）

1. `test/host-spec-sim.cjs` 新增用例：无模型 / 节点模型 / 角色默认 / 节点覆盖角色 / missing+fallback / missing+stop / 列表拿不到。断言 compileSpec 输出文本。
2. 新增 `test/model-fence-sim.cjs`：模拟 pre-execute，覆盖改写、失效删参、异常放行。
3. `test/render-harness.cjs`：用带 model 字段与不带的真实画布全量渲染，必须全绿。
4. `test/link-drag-sim.cjs` 回归。

## 阶段 4：装机与真实验证

1. 升版本 2.19.0，更新 README 表格（AGENTS.md 现有插件表）与 `index.json`。
2. `plugin_manager` remove_bundle + install_bundle（host.js 改动必须重装），自行重载界面。
3. 冒烟（真实操作）：
   - 两个工作节点分别选两个已配置模型 → 启动 → 确认两个子代理实际模型不同（看投影 lane.model / 会话日志）
   - 手工把某节点 model.id 改成不存在的值：fallback 节点用默认模型跑完并在汇报中注明；stop 节点启动时弹窗拦下
   - 打开 2.18.4 的旧画布，行为不变
4. 每个阶段完成即 commit；用户验收后再 push（push 前做敏感信息扫描）。

## 风险

- 阶段 0 第 2 条不成立 → 只能 deny 重派，多一轮往返，但结果正确。
- 模型列表拿不到 → 全部按 unknown 放行，退化为「只靠提示词」，不会阻断。
- 调度、汇总仍由主会话模型完成，不在本功能范围。

## 阶段 0 调研结论（2026-11-09，源码出自 app.asar 内官方包）

1. **模型列表**：host ctx 可用 `ctx.get('llm')`（`@deepseek-ai/dsh-llm` 注册的服务，与 `list_subagent_models` 工具同源）。方法：
   - `listProviders()` → 同步，`[{id, name, ...}]`（已注册且有 adapter 的渠道）
   - `await listModels(providerId)` → 广告目录 `[{provider, id, name, description?}]`；目录是 advisory，不在目录 ≠ 一定不能用，还可用 `await resolveModelInfo(providerId, modelId, signal)` 精确解析（不存在则抛 LlmError）。missing 判定 = 目录未命中且 resolveModelInfo 也失败。
   - 任何一步异常 → 列表视为拿不到（unknown），按 ok 放行，与计划一致。
2. **围栏改参（方案 A 成立）**：`tools/pre-execute` 收到的 exec 对象未被冻结，官方流水线自己就会改 `exec.signal`；`exec.arguments` 的**值**被 deepFreeze（不能原地改属性），但属性本身可**整体重赋值**：`exec.arguments = { ...exec.arguments, provider, model }`。`dispatchToolBody` 之后读的是同一个 exec 对象的 `exec.arguments`，改写生效。后续 guards / ask（审批）看到的也是改写后的参数。
3. **tool/call 字段名**：subagent 工具参数为 `provider` / `model` / `reasoning_effort`（snake_case）。`tool/call` 事件在 `pipeline.prepare` **之前**用模型原始 block.arguments 落库，所以投影 lane.model 记录的是「主会话请求的模型」；围栏改写不体现在投影里（正常路径 compileSpec 已要求主会话自己带对参数，可接受）。
4. **计划外硬约束（阻断性）→ 已拍板方案 A**：`@deepseek-ai/dsh-tool-subagent` 的 `assertAllowedModelSelection` 规定——会话若没有记录 `subagent/model-selection-policy` 事件（DSH 设置「Model selection」未开启时即为如此，本机全部会话抽查均为 null），subagent 显式传 provider/model 只允许等于父会话当前路由，否则派发直接报错。
   **决定（用户 2026-11-09 确认）**：画布「启动」绑定时，宿主给该会话 append 官方 `subagent/model-selection-policy` 事件（`agent.session.append`，与官方设置服务同一写法），allowedModels = 本画布全部生效路由的并集（去重、非空才写）。
   - 会话策略「先到先 recorded」：投影 apply 只认第一条。绑定前用插件自己注册的同事件投影 reader（key=agentWorkflowBoardModelPolicy）检查：已有策略且覆盖画布路由 → 不写、直接用；已有策略但不覆盖 → checkModels 报 issue（policy 类），提示换新会话启动；无策略 → append。
   - 子会话自动继承父策略（官方 agent/created 逻辑），无需额外处理。
   - 画布无模型节点时不 append（无路由可授权，事件 schema 要求 min(1)）。
5. 会话绑定后画布本来就被 bound-lock 禁改，运行中改模型的场景 = 先停再改再启动，新路由若超出已 recorded 策略即落入上面「policy 不覆盖」分支，行为明确。

## 实施记录（2026-11-09）

- 阶段 1 host.js：完成（commit 26e47be）。listModels 目录缓存 30s + resolveModelInfo 精确兜底（verifiedRoutes 常驻集合供 compileSpec 同步路径复用）；resolveNodeModel 四态；checkCanvasModels（model/policy 两类 issue）；RPC 新增 listModels/checkModels，agents/agentGet/agentPut 带角色 provider/model；compileSpec 三态措辞；围栏 pre-execute 改写 provider/model（换路由时一并删 reasoning_effort，官方语义：省略力度回落模型默认）、失效删参放行；bind 时 ensureModelPolicy append 授权事件；lane.model 记录 tool/call 原始参数里的模型。
- 阶段 2 client.js：完成（commit 1b92a90）。节点面板「模型」下拉（首项默认，角色带默认模型时注明角色路由）+「模型不可用时」二选一；选模型锁派发；角色编辑器默认模型下拉写 frontmatter；节点卡片失效红 ⚠ + 悬停提示（无常驻文字）；toggleRun 启动前 checkModels：fallback=照跑+toast，stop/policy=弹窗逐节点改选后「保存并启动」（重查重绑，仍有问题会再弹回）；normalizeDoc 保留 model/onModelMissing 且无模型节点不写字段（旧画布形状不变）；中英文案齐。
- 阶段 3 测试：四门禁全绿——host-spec-sim（原钩子用例 + 模型语义 21 项）、model-fence-sim（新增，改写/删参/异常放行/frozen 替换 12 项）、render-harness（真实画布 + 新增 model 合成画布 + normalizeDoc 保留断言）、link-drag-sim 回归。
- 阶段 4：版本 2.19.0、AGENTS.md 插件表、index.json 登记完成（commit 0f5d339 / f9bfd8c）；plugin_manager remove+install 成功（application=applied），宿主新代码已在跑（投影缓存出现 agentWorkflowBoardModelPolicy key）。客户端新 UI 需页面重新加载后生效 → 需重启 DSH 应用；真实冒烟（两节点两模型派发、手工改死 model.id 验 fallback/stop、旧画布回归）待重启后进行。push 前的敏感信息扫描已做（干净），push 等用户验收后执行。

# 流程画布插件 — 交接文档（M1+M2 代码完成待验收 / v2.2.0 围栏+钩子生效）

> 写给下一个会话：本文件是 `@local/agent-workflow-board`（流程画布）插件的状态与计划。
> M1、M2 代码全部完成（M2 待端到端验收）；v2.1.0 缩放/整理布局/beforeunload；
> v2.2.0 硬约束围栏 + 钩子节点按时机注入。
> 动手前先读完「铁律」「M1 现状」「2.5 v2.1.0」「2.6 v2.2.0」。

---

## 0. 插件基本信息

- **唯一地址（canonical）**：`/Users/czm/githubProject/my-dsharness-plugin/agent-workflow-board/`
  - default-workspace 里的旧副本已删除，不要在别处新建副本再改（曾因两份副本不同步浪费一轮排查）
- **安装方式**：`plugin_manager` → `remove_bundle: @local/agent-workflow-board` → `install_bundle, target=上面的目录`（profile 里是 link 安装，remove+install 强制重新组合）
- **文件结构**：`host.js`（Host 半：存储路由 + agent 名册 + 规范编译 + 投影 + canvas_report + 围栏）、`client.js`（Client 半：全部 UI）、`cordis.patch.yml`（insert 一行）、`locale/zh.json`+`en.json`（展示元数据）、`icon.svg`
- **画布存储位置（用户选定：内部存储）**：`~/.dsh/storages/agent-workflow-board/canvas-<id>.json`（另有 `bindings.json`、`status.json`）
- **Client 入口**：`conversation.view` 槽位，id=`agent-canvas`，order=15（会话顶部标签「流程画布」，在「工作流」之前）

---

## 1. 铁律（本会话踩过的坑，违反必炸）

1. **Host 条目模块级 `inject` 只留 `[]`**。把 `connection` 写进模块级 inject 会让整个 fiber 卡在 pending，路由永远不注册（→ 前端 404）。connection 必须走 `ctx.inject(['connection'], connectionCtx => {...})` 子上下文注册（workflow-lite 作者注释里明确写过这个坑）。
2. **Client↔Host 通信只用单一 POST 路由**：`POST /api/agent-canvas/rpc`，body=`{action:...}`，`requestBody:'buffered'`。GET/查询串/多方法组合在 /api 桥上会 400（404=路由没注册，400=桥拒绝了请求形状，500=handler 内部抛错——前端错误提示会带状态码）。
3. **ctx 上取服务用 `ctx.get('xxx')`**，裸属性访问（`ctx.agentPresets`）在服务缺失时可能抛异常 → 500。
4. **client.js 的 `inject` 只写 Client 真实存在的服务**：当前 `['slots','locale']`。
5. **composer 隐藏靠两条腿**：CSS `[data-conversation-content]:has([data-agent-canvas-view]) [data-conversation-region=composer]{display:none!important}` + JS 挂载时 querySelectorAll 隐藏/卸载还原（`.awbc-node` 的 useEffect）。
6. **一切 UI 挂载点要适配「父容器高度不定」**：根节点 `.awbc` 必须 `flex:1 1 0 + overflow:hidden + height:100%`，否则平面撑到原始尺寸、整体溢出。
7. **会话顶标签需要刷新页面才出现/更新**（Client 模块表只在页面加载时注入；`pnpm run dev:web` 没跑就没有热更新）。
8. **框选矩形、节点、连线必须渲染在 `.awbc-plane` 内**（平面带 translate(pan)）；放在视口层会导致平移后坐标错位（曾经"框选出现在左上角"就是这个）。
9. **端口圆心钉在 `top:26px`**（26 + 半径 5 + 节点边框 1 = 32px = NODE_H/2 = 连线终点），不要改回 `top:50%`（节点实际高度可变，会偏上/偏下）。
10. **插件只有一个副本**，改代码就改 my-dsharness-plugin 这份。
11. `cordis_inspect_query` 的 `input` 参数当前有 bug（传了就报 "must be an object"），只能无参调用；调试前端行为用「DEBUG 角标」模式（window 捕获阶段 pointerdown 计数 + 画布上实时读数，本会话用它一步定位过 bug）。
12. **waterfall 事件（如 `tools/pre-execute`）放行必须 `return next()`**，直接返回默认决定会短路链上后续监听（审批 ask 等）；只有要拦截时才返回自己的决定不调 next。

## 2. M1 现状（全部已验收）

- **会话顶部标签页**（对话/轨迹/工作流/流程画布）打开编辑器
- 无限画布（transform 平移无边界）+ 点阵背景跟随平移
- 五种节点：主会话（唯一入口）/ 工作（可绑定 agent、可主会话自己做）/ 判断（条件说明+分支标签）/ 结束（终点）/ 钩子（M1 仅展示，M2 生效）
- **端口方向语法**：左空心（入）、右实心（出）；主会话无左端口、结束无右端口；端口命中区 26×26（伪元素扩边）
- 端口拖线：拖到空白 → 弹「创建节点」选择框（虚线保留，选中后线无缝接到新节点入线端口，零跳变）；双击端口 = 同款弹框（左端口反向连）
- 右键节点菜单：复制节点 / 删除节点（编辑、从此连线已按需求删除）
- 右键空白：同款创建选择框（无主会话时含「主会话」项）
- Figma 式交互：默认箭头=空白拖拽框选多选（虚线选框、组拖动、Delete 批量删）；按住 Space=手形平移（输入框内打空格不受影响）
- 强制规则：主会话唯一、结束无出线、主会话无入线（交互层阻断 + 「检查」报错）、判断必须有出线、工作节点建议写提示词
- **节点名称必填校验**（M1 收尾追加）：名称为空/纯空白 = error 级问题，保存被拦截并 toast 提示；问题列表随编辑实时刷新；编辑面板名称输入框为空时红框；名称 label 带 `*` 标记（`.awbc-req`）。报错文案用节点类型名（`type*` locale），不用内部 id
- **名称为空时锁定选中**：当前选中节点名称为空时，禁止点击/右键其他节点、禁止点空白取消选中（`tryChangeSelection` 拦截 + toast 提示），补上名称或删掉该节点即可解锁；删除节点不受拦截
- 存储路由：`POST /api/agent-canvas/rpc`，action=`list/get/put/delete/agents`；agents 实时来自 `agentPresets.list()`（系统级 standard/ptc/minimal/cordis + 用户级）
- 工作台缓存：切标签不丢未保存内容（模块级 WORKBENCH 镜像 doc/savedSnap/pan）
- 画布配色：`#0e1116` 底 + `#333b47` 点阵（workflow-lite 同款近黑）

## 2.5 v2.1.0 新增（2026-10-27 本轮，待页面验收）

- **画布缩放**：`transform = translate(pan) scale(zoom)`，铁律「screen = pan + world * zoom」——所有屏幕→平面换算（面板拖放落点、节点拖动位移、连线橡皮筋、框选、右键菜单落点、新建节点默认落点）都除以 zoom（`zoomRef.current`）。点阵背景 `backgroundSize` 随 zoom 缩放，`backgroundPosition` 仍是 pan
  - Ctrl/Cmd+滚轮 = 以光标为锚缩放（0.25×–2.5×）；Shift+滚轮 = 横向平移；普通滚轮 = 平移
  - **滚轮必须挂原生非 passive 监听**（viewportRef + addEventListener passive:false），React 的 onWheel 是 passive 的 preventDefault 无效
  - 右下角缩放控件：− / 百分比(点按回100%) / + / ⛶适应内容（fit 上限 1.5，框住全部节点）
  - zoom 进 WORKBENCH 镜像（切标签保留）；滚轮事件在 `.awbc-issues` / `.awbc-menu` 上不劫持
- **一键整理布局**（工具栏「⊞ 整理布局」）：从主会话 BFS 分层（最长层），层内按 BFS 序竖排；孤岛种子层号 = maxLayer+2（与主流隔离），成环孤岛从任意未访问节点强行起步；无主会话时第一块孤岛从层 0 开始。单次 setDoc = 一步撤销历史
- **beforeunload 防丢兜底**：dirty 时挂原生确认（自动保存把窗口缩到 1.8s 防抖内，只挡意外退出）
- **顺手修 bug**：connect 模式点空白时 `tryChangeSelection('')` 条件写反（`if (tryChangeSelection('')) return`），名称锁定会被绕过 → 改为 `if (!tryChangeSelection('')) return`

## 2.6 v2.2.0 新增（2026-10-27 本轮，待端到端验收）

- **硬约束围栏**（`tools/pre-execute`，waterfall）：已绑定画布的会话派发 subagent 时，从 `status.json` 取该画布**最近上报的 running 节点**当「当前节点」——工作节点(exec=subagent)放行；主会话/判断/结束/主会话自己做(exec=lead)的工作节点一律 `{kind:'deny', reason}`，reason 会变成工具结果 `Error: <reason>`，模型能看到并自我纠正
  - **waterfall 铁律：放行必须 `return next()`**，绝不能直接 `return {kind:'allow'}`（会短路后面的审批 ask 链）；只有 deny 才短路
  - 围栏自身任何异常都 `return next()` 放行（宁漏勿误伤）；未绑定/无 running 上报/节点 label 对不上 → 放行
  - API 出处（app.asar `@deepseek-ai/dsh-tools/lib/index.js` 的 `prepareExecution`）：`ctx.waterfall(carrier,'tools/pre-execute',exec,()=>({kind:'allow'}))`；决定形状 `{kind:'allow'|'deny'(reason,info?)|'cancel'|'ask'}`；`exec.name/.arguments/.agent/.parent`，`exec.agent.id` = sessionId
  - 已知局限：若核心审批监听在链上位于我们之前且不调 next（先 ask 后短路），围栏会被绕过——未观察到此情况，真遇到再考虑 `tools/execute` 兜底
- **钩子节点生效**（提示注入，不做副作用）：compileSpec 里钩子不占流程步骤号，末尾单独「时机动作」段按 hookKind 注入：session-start=进入第一个节点前先完成 / before-dispatch=每次派发子 agent 前先核对 / session-end=最终收尾汇报前先完成
  - **钩子取自全量节点**：不接线（孤岛）也生效——它是时机动作不是流程步骤（单测覆盖）
  - client 徽章 `hookPreviewBadge` 改为「按时机注入提示词」，descHook 同步
- 单测：compileSpec 钩子段（步骤号不重复、孤岛钩子在内、未设时机兜底文案）、pickRunningLabel（取最新 running）、fenceReasonFor 文案

## 2.7 v2.3.0 新增（2026-10-28 本轮，待页面验收）

- **钩子时机 3 种 → 8 种**，每种对应 DSH 真实执行事件（client 的 HOOK_KINDS 改为 `{value,labelKey}` 对象数组，编辑下拉/节点副标题/normalizeDoc 校验全部改查表）：
  | value | 时机 | DSH 事件 |
  |---|---|---|
  | session-start | 会话开始时 | agent/created |
  | user-message | 收到用户消息后 | agent/inbox/claimed |
  | before-dispatch | 每次派发前 | tools/pre-execute |
  | after-dispatch | 每次派发完成后 | tools/post-execute |
  | subagent-start | 子 agent 启动时 | subagent/start |
  | subagent-end | 子 agent 结束时 | subagent/end |
  | turn-stop | 每轮结束时 | agent/turn-stopping |
  | session-end | 会话结束时 | agent/disposed |
- host.js 侧 HOOK_TIMING_TEXT 映射表（8 项 + 未设兜底），单测覆盖 8+1 全部注入
- 语义仍是「提示词注入」：8 种时机都以规范文本生效（规范常驻系统提示词，模型按措辞在对应时机执行）；真正逐事件注入（如 subagent/start 往子 agent 提示词交代要点、user-message 往消息流插提醒）是后续增强方向
- 旧画布的三种老时机值完全兼容，无需迁移

## 2.8 v2.4.0 新增（2026-10-28 本轮，待页面验收）

- **规范预览**（用户需求：「画布里应该能看到它最终会编译成什么文本」）：
  - rpc 新增 `specPreview {canvas}`：直接编译客户端传来的**当前画布**（含未保存修改），和注入走同一个 `compileSpec`——所见即模型所得，永不吃字（2.3.0 的 8 种钩子时机自动带出，单一事实源）
  - 工具栏「≣ 规范预览」按钮 → 对话框：标题/说明（注入时机+实时重编语义）/ 等宽 `<pre>` 全文 / 复制按钮 / 空规范时显示「没有主会话入口，不会注入」
  - 打开对话框时才请求编译一次；2.3.1 的下拉样式改动已单独成 commit（0954a89），本轮无冲突

## 2.9 v2.4.1 改版（2026-10-28 本轮，待页面验收）

- **规范预览从弹窗改右栏常驻**（用户反馈「预览到侧边栏更直观」）：右栏面板改「属性 / 规范」双标签（`.awbc-rtabs` 分段圆点按钮）
  - 「规范」页：等宽 `<pre>` 撑满剩余高度（`.awbc-spec{flex:1 1 0}` + `.awbc-specpre{flex:1 1 auto;min-height:0}` 内部滚动），右上角复制按钮，底部一行注入说明
  - **实时重编**：标签页激活时 `useEffect([rightTab, doc])` 防抖 500ms 调 `specPreview`——边改边看，切回属性页即停轮询
  - 删除了 v2.4.0 的工具栏「≣ 规范预览」按钮和弹窗（单一入口）；`specBtn` locale 键退役，新增 `tabProps`/`tabSpec`

## 2.10 v2.5.0 新增（2026-10-28 本轮，待页面验收）

- **自绘下拉组件 `Dropdown`**（模块作用域，替代全部 4 处原生 `<select>`：编辑面板执行方式/执行 agent/触发时机 + 工具栏会话绑定）
  - 动机：用户反馈「弹开的列表还是原生的」——原生 select 的弹层在 macOS 上是系统级菜单，CSS 管不到；2.3.1 只能改收起态。根治 = 零原生 select（workflow-lite 同款思路）
  - 结构：触发按钮 `.awbc-dd-trigger` + fixed 定位浮层 `.awbc-dd-pop`（逃出右栏 editor 的 overflow:auto 裁剪）
  - **定位用 `useLayoutEffect`**（绘制前定位，不闪跳）；下方放不下自动向上弹；浮层外任何 scroll/wheel/resize/Esc/点击直接收起（fixed 锚点跟随不了滚动，wheel 监听捕获态但豁免浮层内部滚动）
  - props 契约：`{ value, options:[{value,label}], onChange, className, title }`；选中项高亮（`.awbc-dd-item.selected`），选项超宽省略号
  - 2.3.1 的 `.awbc-select` 系列样式已整体移除；`.awbc-bind` 保留（挂在 Dropdown 包装层上）
- **协调记录**：2.4.0/2.4.1 由另一个并行会话开发（规范预览），期间撞过一次车（本会话恢复 `specBtn` 的编辑被对方 2.4.1 提交扫入，留了一个死键，本版顺手清掉）。**教训：同一插件不要两个会话同时写；开工前先 `git log --format="%h %ci"` 看最近提交时间**

## 3. M2 计划（下一阶段主体：让画布"指挥"agent）

**目标**：用户把画布绑定到会话后，agent 按图执行，画布实时显示进度。

### M2.1 会话绑定（已完成，待页面验收）
- Host：`~/.dsh/storages/agent-workflow-board/bindings.json`（sessionId → {canvasId,boundAt}）；rpc 新增 `bind`/`unbind`/`getBinding`；delete 画布时顺手清理指向它的绑定
- Client：工具栏「在此会话使用：…」下拉（未绑定 + 我的画布列表）；绑定成功自动打开该画布；解绑即选「未绑定」；无 sessionId（非会话上下文）时不渲染控件
- 绑定关系按会话隔离；换会话加载各自绑定

### M2.2 执行规范编译 + 注入（已完成，待端到端验收）
- **注入机制**（读 app.asar 里 `@deepseek-ai/dsh-system-prompt` 源码确认）：不要用全局 `system-prompt/assemble` 监听（事件是 scoped 派发，全局监听收不到）；正确姿势 = `ctx.on('agent/created')` 里查绑定，已绑定则 `agent.ctx.systemPrompt.section({ name:'agent-workflow-board:spec', order:500, interpolate:false, text:动态函数 })`
- **interpolate:false 必须**：节点提示词里可能出现 `{{...}}`，开着会被当 prompt variable 解析并在组装时抛错
- **只对创建时已绑定的会话生效**：agent/created 时查 bindings，未绑定不注册（进行中的会话不追认，与 preset 修订语义一致）
- **动态 text**：每次 prompt 组装时同步读最新画布 → 执行中改图只影响后续节点；画布不可读返回 ''（空 section 渲染时被丢弃）
- `compileSpec`：从主会话 BFS 拓扑排序（孤岛节点不进规范），按类型渲染节点指令 + 判断分支标签 + 执行约束；无主会话返回 ''；已冒烟测试
- 节点语义（用户已拍板）：判断=主会话自己读说明选分支；工作 exec=派子 agent（可带 agent preset）/ 主会话自己做

### M2.3 节点实时亮灯（已完成，待端到端验收）
- 投影定义（读 app.asar 里 `dsh-session-projection` + `dsh-experimental-agent-team` 源码确认形状）：`{ key:'agentWorkflowBoard', stateVersion:1, init, apply(fold), wire:{ viewSchema, view } }`，注册在 `ctx.root.sessionProjections.register`，包 try/catch
- **viewSchema 只需要 .parse 接口**：用极简 shim（结构不对抛错）即可，不用引 zod
- fold `tool/call`（name==='subagent'）→ lanes 里按 `arguments.description` 精确匹配节点 label，status=running；fold `tool/result`（message.callId 关联）→ done / error
- Client 已有 `useProjection('agentWorkflowBoard')` + lanes 消费逻辑，无需改

### M2.4 主会话上报（已完成，待端到端验收）
- 新工具 **`canvas_report`**（ctx.root.tools.register，JSON-schema 直写，不经过 defineTool，包 try/catch）：execute 里 `exec.agent.id` = sessionId → 查 bindings → 写 `status.json`（{canvasId: {label: {status,note,updatedAt}}}）；未绑定返回 recorded:false
- rpc 新增 `getStatus {id}`；Client 每 3s 轮询，canvas_report 上报状态优先于投影 lane（主会话自己执行/判断/结束节点也能亮灯），error 带 note 提示
- compileSpec 约束段已写入上报要求（进入=running、完成=done、失败=error+note，label 必须与节点名完全一致）

### M2.6 自动保存（已完成，待页面验收）
- `persistDoc(base, {silent})` 共用落盘核心；自动保存=文档变更后防抖 1800ms 静默 put；手动保存按钮保留
- 有 error 级校验问题时自动保存暂缓（徽章显示「未保存」而非「保存中…」）；保存失败徽章红色「保存失败」
- 首次挂载 savedSnapRef 初始化为当前 doc 快照，避免空画布被误自动保存成垃圾记录
- 保存期间用户继续编辑时，只在 doc 未变时才回写规范化结果

### M2.7 撤销/重做（已完成，待页面验收）
- histRef 快照栈 + 指针；doc 变更 700ms 内合并为一步（拖动/输入不刷栈），栈上限 100；换画布（id 变化）历史重置
- Ctrl/Cmd+Z / Ctrl+Shift+Z / Ctrl+Y；输入框聚焦时不拦截；工具栏 ↶/↷ 按钮带禁用态
- undo/redo 后选中节点不存在则清空选择；undo 结果走自动保存
- suppress 标记防止 undo/redo 自身的 doc 变更再次进栈

### M2.8 验收路径
建图（主会话→工作A→工作B→判断→结束，绑 agent）→ 绑定会话 → 发需求 → 观察：主会话按图派发、节点依次亮灯、判断走对分支、结束回主会话汇报。

### M2.6 自动保存（用户已拍板，提前自 M3）
- 编辑防抖自动落盘：任何 setDoc 变更（拖动节点、改属性、连线、改名）后 debounce（约 1.5–2s）自动走现有 `put` action，替代「手动点保存」为主的流程
- 工具栏保留「保存」按钮作为立即落盘入口；dirty 徽章语义改为「保存中…/已保存」（自动保存后 dirty 窗口很短）
- 注意与 WORKBENCH 缓存的配合：自动保存成功后同步 `savedSnapRef`，切标签回来不走恢复未保存旧逻辑
- 绑定中的画布（M2.1 之后）自动保存时要考虑执行中快照的一致性：执行期间改图只影响后续派发（规范文本按派发时编译），不过度设计

### M2.7 撤销/重做（用户已拍板，提前自 M3）
- 历史栈：doc 快照栈（结构化 clone 即 JSON stringify/parse，画布体量小）+ 指针；push 时机=setDoc 的语义变更（属性输入按防抖/失焦合并，拖动按 onUp 合并为一步，避免逐帧进栈）
- 快捷键 Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）重做；输入框聚焦时不拦截
- 工具栏加撤销/重做按钮（禁用态跟随指针位置）
- 撤销/重做产生的新 doc 同样走 M2.6 自动保存
- 与选中状态解耦：undo 后 selectedId 若指向已不存在的节点则清空

## 4. M3 及以后（池子，按需捞）

- ~~硬约束围栏~~（v2.2.0 已落地，见 2.6；可选增强：拦截时校验派发的 agent preset 与节点绑定一致、`tools/execute` 兜底）
- ~~钩子节点生效~~（v2.2.0 已落地：session-start/before-dispatch/session-end 提示注入）
- **小地图**（简单分层布局已在 2.5 落地，elkjs 精排/小地图可再议）
- **撤销/重做**（已提前进 M2.7）
- **版本管理与 .wflite 式导出**（参考 workflow-lite：版本对比、打包导出、导出成 Skill）
- **agent 来源分级标注**（`agentPresets.compositionInventory()` 区分系统/用户）
- **多选批量操作增强**：框选后右键组菜单、对齐分布
- **判断分支可视化状态**（选中哪条分支亮哪条）

## 5. 关键参考（新会话直接看）

- **workflow-lite（最重要的参考实现，已安装）**：`~/.dsh/profiles/desktop/node_modules/@xiaoso/dsh-workflow-lite/`
  - `lib/index.mjs`：Host 半——`ctx.inject(['connection'])` 注册路由的正确姿势、`POST + clientRequestSchema 信封`、agentPresets 的 `ctx.get` 安全访问、存储仓储模式
  - `lib/client.js`：Client 半——`conversation.view` 注册（label 函数 + `inject: sessionId => ({...})` props 注入）、`connection.rpc.call` 通道、React Flow 交互
  - 附带技能：`workflow-authoring` / `workflow-run-state`
- **composer-usage-plus**（default-workspace `plugins/` 下，注意它的 connection.fetch 路由其实也是坏的，别照抄它的 inject）
- **本插件 client.js 里的成熟模式**：WORKBENCH 缓存、端口/框选/平移三种 pointer 手势互不干扰、composer 隐藏、`useProjection` 兜底
- 深层 API 探索：`read` 工具可读 app.asar 内文件（glob/grep 不行）；`cordis_inspect_query`（client Slots/Service/Event + host Service/Event/Config）无参可用

## 6. 给新会话的开场白模板

> 插件在 `/Users/czm/githubProject/my-dsharness-plugin/agent-workflow-board/`，
> 先读目录里的 `HANDOFF.md`（交接文档），按 M2 计划开工。改完用 plugin_manager remove+install 该目录重装，刷新页面验证。

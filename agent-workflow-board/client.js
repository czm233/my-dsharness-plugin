/**
 * Client half of the Agent Workflow Board — 流程画布.
 *
 * Registers a session-top tab (the `conversation.view` slot, the same seat as
 * 对话 / 轨迹). Visual language follows the workflow-lite board: a collapsible
 * element library on the left, a dot-grid canvas with typed node cards, a
 * toolbar with name + save-state badge + issue chip, and a bottom legend.
 *
 * Canvas model: start (主会话, exactly one) → work / router / hook → end.
 * Agents (system- and user-level presets) come live from the Host half's
 * /api/agent-canvas routes and can be dragged onto the canvas as work
 * nodes. Canvases persist through /api/agent-canvas routes into DSH internal
 * storage. M2: session binding, spec injection, live node progress, autosave,
 * undo/redo. Now also: zoom (Ctrl+wheel anchor zoom + corner widget + fit),
 * one-click layered auto-layout, beforeunload dirty guard.
 */

window.__ModuleLoader__.load({
  id: '@local/agent-workflow-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agent-workflow-board'
    const PANEL_ID = 'agent-canvas'
    const API = '/api/agent-canvas'
    const PLANE_W = 2600
    const PLANE_H = 1700
    const NODE_W = 232
    const NODE_H = 64

    const NODE_TYPES = {
      start: { glyph: '▶' },
      work: { glyph: '⚙' },
      router: { glyph: '⑂' },
      end: { glyph: '⏹' },
      hook: { glyph: '⚡' },
    }
    // 八种钩子时机，各自对应 DSH 的真实执行事件：
    // session-start→agent/created · user-message→agent/inbox/claimed ·
    // before-dispatch→tools/pre-execute · after-dispatch→tools/post-execute ·
    // subagent-start→subagent/start · subagent-end→subagent/end ·
    // turn-stop→agent/turn-stopping · session-end→agent/disposed
    const HOOK_KINDS = [
      { value: 'session-start', labelKey: 'hookSessionStart' },
      { value: 'user-message', labelKey: 'hookUserMessage' },
      { value: 'before-dispatch', labelKey: 'hookBeforeDispatch' },
      { value: 'after-dispatch', labelKey: 'hookAfterDispatch' },
      { value: 'subagent-start', labelKey: 'hookSubagentStart' },
      { value: 'subagent-end', labelKey: 'hookSubagentEnd' },
      { value: 'turn-stop', labelKey: 'hookTurnStop' },
      { value: 'session-end', labelKey: 'hookSessionEnd' },
    ]

    const zh = {
      title: '流程画布',
      palTitle: '元素库',
      palSub: '拖到画布上，或点击放置',
      secElements: '元素',
      secAgents: 'Agent（系统级 / 用户级）',
      secAgentsMine: 'Agent（我的）',
      scopeProject: '项目 · ',
      scopeProjectShort: '（P·项目）',
      fieldProjectDir: '项目目录（可选，项目级角色叠加）',
      projectDirPh: '/绝对路径/到/你的项目',
      projectDirHint: '填后名册 = 用户级 + <项目>/agents/*.md（同名项目级覆盖用户级）；留空只有用户级。改完点「刷新」。',
      secDocs: '我的画布',
      agentsLoading: '加载中…',
      agentsEmpty: '暂无可用 agent preset',
      agentsFailed: 'agent 列表获取失败',
      refresh: '刷新',
      docsEmpty: '还没有已保存的画布',
      docUnnamed: '未命名画布',
      newCanvas: '新建',
      save: '保存',
      saveBlocked: '有未通过的检查项，无法保存',
      labelRequiredLock: '当前节点的名称还没填（必填项），请先补上再操作其他节点',
      savingBadge: '保存中…',
      saveFailed: '保存失败',
      undo: '撤销',
      redo: '重做',
      switchOnLabel: '运行中',
      switchOffLabel: '启动',
      switchTitle: '开启后本会话按此画布流程执行（自动保存并激活围栏）；再点一次停止',
      unbound: '未绑定',
      bindSaved: '已绑定到当前会话',
      unbindSaved: '已解除绑定',
      del: '删除',
      confirmDelete: '确定删除这张画布？',
      importBtn: '导入',
      exportBtn: '导出',
      validateBtn: '检查',
      savedBadge: '已保存',
      unsavedBadge: '未保存',
      saved: '已保存到内部存储',
      loadFailed: '操作失败',
      deleted: '已删除',
      exported: 'JSON 已复制到剪贴板',
      exportFailed: '复制失败',
      issuesChip: n => `${n} 个问题`,
      validationOk: '结构没有问题。',
      errNoStart: '缺少主会话节点（入口，必须有且只有一个）。',
      errMultiStart: '主会话节点最多一个。',
      errNoEnd: '缺少结束节点。',
      errStartNoPath: '主会话没有任何路径能到达结束节点。',
      errRouterNoOut: '判断节点「{a}」没有连出的线。',
      errEndOut: '结束节点「{a}」是终点，后面不能再连接其他节点。',
      errStartIn: '主会话是入口，不能被连入。',
      errNodeNoLabel: '节点「{a}」的名称不能为空。',
      warnRouterNoLabel: '判断节点「{a}」有一条出线没写分支标签。',
      warnWorkNoPrompt: '工作节点「{a}」还没写提示词。',
      warnHookNoKind: '钩子节点「{a}」没选触发时机。',
      descStart: '流程入口，唯一',
      descWork: '干活：派 agent 或主会话自己做',
      descRouter: '写判断条件，选择分支',
      descEnd: '在主会话回复用户，收尾',
      descHook: '会话关键时机动作（按时机注入提示词）',
      typeStart: '主会话',
      typeWork: '工作',
      typeRouter: '判断',
      typeEnd: '结束',
      typeHook: '钩子',
      fieldLabel: '名称',
      fieldDesc: '注释',
      fieldPrompt: '提示词（派发时交给执行者的任务说明）',
      fieldExec: '执行方式',
      execSubagent: '派子 agent',
      execLead: '主会话自己做',
      fieldAgent: '执行 agent',
      agentLead: '主会话（默认）',
      fieldRouterDesc: '判断说明（怎么选分支，写给主会话看）',
      fieldHookKind: '触发时机',
      hookSessionStart: '会话开始时',
      hookUserMessage: '收到用户消息后',
      hookBeforeDispatch: '每次派发前',
      hookAfterDispatch: '每次派发完成后',
      hookSubagentStart: '子 agent 启动时',
      hookSubagentEnd: '子 agent 结束时',
      hookTurnStop: '每轮结束时',
      hookSessionEnd: '会话结束时',
      fieldHookNote: '动作说明',
      hookPreviewBadge: '按时机注入提示词',
      routerHint: '判断节点每条出线选「是/否」即可；特殊情况选「自定义」再填文字，主会话按判断说明选分支。',
      edgesLabel: '连出的线',
      edgeLabelField: '分支标签',
      branchYes: '是',
      branchNo: '否',
      branchCustom: '自定义',
      deleteNode: '删除节点',
      selectNodeHint: '点击画布上的节点编辑属性',
      legendNormal: '连线',
      statusRunning: '运行中',
      statusDone: '完成',
      statusError: '失败',
      importTitle: '导入画布 JSON',
      importPlaceholder: '在此粘贴画布 JSON…',
      importConfirm: '导入',
      importError: '导入失败：JSON 无效或缺少 nodes/edges',
      close: '关闭',
      newNode: '新节点',
      connect: '连线',
      connecting: '连线中',
      connectFinish: '完成连线',
      menuDuplicate: '复制节点',
      menuDelete: '删除节点',
      pickerTitle: '创建节点',
      zoomIn: '放大（Ctrl+滚轮）',
      zoomOut: '缩小（Ctrl+滚轮）',
      zoomReset: '重置缩放到 100%',
      zoomFit: '适应内容',
      zoomFitShort: '适应',
      layoutBtn: '整理布局',
      specBtn: '规范预览',
      specTitle: '执行规范预览（发给模型的原文）',
      specHint: '绑定会话后，这段文字在每次模型请求组装时由 Host 动态注入系统提示词（实时重编，执行中改图只影响后续节点）。随编辑自动刷新。',
      specEmpty: '当前画布没有主会话入口，编译结果为空——绑定后也不会注入任何内容。',
      specCopy: '复制',
      specCopied: '已复制',
      specLoadFailed: '预览生成失败',
      agentDialogTitleNew: '新建 Agent（角色）',
      agentDialogTitleEdit: '编辑 Agent（角色）',
      agentIdLabel: '标识（id，唯一，作为文件名；字母/数字/-/_）',
      agentNameLabel: '显示名',
      agentDescLabel: '描述（名册卡片与下拉里的一句话说明）',
      agentPromptLabel: '人设（派发时注入的角色提示词）',
      agentScopeLabel: '存储位置',
      agentScopeUser: '用户级（所有画布可用）',
      agentScopeProject: '项目级（存到项目目录，需已填项目目录）',
      agentSave: '保存角色',
      agentSavedToast: '角色已保存',
      agentDelToast: '角色已删除',
      agentDeleteConfirm: '确定删除这个角色文件？',
      agentInvalid: '标识（字母开头，仅字母/数字/-/_）和人设不能为空',
      agentLoadFailed: '角色内容读取失败',
      agentEditBtn: '编辑角色',
      agentNew: '＋ 新建 Agent',
    }

    const en = {
      title: 'Flow canvas',
      palTitle: 'Library',
      palSub: 'Drag onto the canvas, or click to place',
      secElements: 'Elements',
      secAgents: 'Agents (system / user)',
      secAgentsMine: 'Agents (mine)',
      scopeProject: 'Project · ',
      scopeProjectShort: ' (P·project)',
      fieldProjectDir: 'Project directory (optional, project roles)',
      projectDirPh: '/absolute/path/to/your/project',
      projectDirHint: 'Roster = user-level + <project>/agents/*.md (project overrides user with same id); empty = user-level only. Click Refresh after editing.',
      secDocs: 'My canvases',
      agentsLoading: 'Loading…',
      agentsEmpty: 'No agent presets available',
      agentsFailed: 'Failed to load agent list',
      refresh: 'Refresh',
      docsEmpty: 'No saved canvases yet',
      docUnnamed: 'Untitled canvas',
      newCanvas: 'New',
      save: 'Save',
      saveBlocked: 'Fix validation errors before saving',
      labelRequiredLock: 'The current node needs a name (required) before you can work on other nodes',
      savingBadge: 'Saving…',
      saveFailed: 'Save failed',
      undo: 'Undo',
      redo: 'Redo',
      switchOnLabel: 'RUNNING',
      switchOffLabel: 'Start',
      switchTitle: 'This session follows this canvas; click again to stop (auto-saves, fence armed)',
      unbound: 'Not bound',
      bindSaved: 'Bound to this session',
      unbindSaved: 'Binding removed',
      del: 'Delete',
      confirmDelete: 'Delete this canvas?',
      importBtn: 'Import',
      exportBtn: 'Export',
      validateBtn: 'Check',
      savedBadge: 'Saved',
      unsavedBadge: 'Unsaved',
      saved: 'Saved to internal storage',
      loadFailed: 'Operation failed',
      deleted: 'Deleted',
      exported: 'JSON copied to clipboard',
      exportFailed: 'Copy failed',
      issuesChip: n => `${n} issue${n === 1 ? '' : 's'}`,
      validationOk: 'Structure looks good.',
      errNoStart: 'Missing a Main node (the entry; exactly one required).',
      errMultiStart: 'At most one Main node.',
      errNoEnd: 'Missing an End node.',
      errStartNoPath: 'No path from Main reaches an End node.',
      errRouterNoOut: 'Router "{a}" has no outgoing edge.',
      errEndOut: 'End node "{a}" is terminal; nothing may follow it.',
      errStartIn: 'The Main node is the entry and cannot be linked into.',
      errNodeNoLabel: 'Node "{a}" needs a name.',
      warnRouterNoLabel: 'Router "{a}" has an edge without a branch label.',
      warnWorkNoPrompt: 'Work node "{a}" has no prompt yet.',
      warnHookNoKind: 'Hook node "{a}" has no trigger selected.',
      descStart: 'The entry; exactly one',
      descWork: 'The job: dispatch an agent or let Main do it',
      descRouter: 'Write the condition, pick a branch',
      descEnd: 'Reply to the user in Main, then stop',
      descHook: 'Actions at key moments (injected into the spec)',
      typeStart: 'Main',
      typeWork: 'Work',
      typeRouter: 'Router',
      typeEnd: 'End',
      typeHook: 'Hook',
      fieldLabel: 'Name',
      fieldDesc: 'Notes',
      fieldPrompt: 'Prompt (task instructions for the executor)',
      fieldExec: 'Execution',
      execSubagent: 'Dispatch subagent',
      execLead: 'Main session itself',
      fieldAgent: 'Executor agent',
      agentLead: 'Main session (default)',
      fieldRouterDesc: 'Decision notes (how to pick a branch)',
      fieldHookKind: 'Trigger',
      hookSessionStart: 'Session start',
      hookUserMessage: 'After user message',
      hookBeforeDispatch: 'Before each dispatch',
      hookAfterDispatch: 'After each dispatch',
      hookSubagentStart: 'Subagent start',
      hookSubagentEnd: 'Subagent end',
      hookTurnStop: 'Turn end',
      hookSessionEnd: 'Session end',
      fieldHookNote: 'Action notes',
      hookPreviewBadge: 'Injected at its trigger',
      routerHint: 'Pick Yes/No for each router edge; use Custom only for special cases, the main session picks by decision notes.',
      edgesLabel: 'Outgoing edges',
      edgeLabelField: 'Branch label',
      branchYes: 'Yes',
      branchNo: 'No',
      branchCustom: 'Custom',
      deleteNode: 'Delete node',
      selectNodeHint: 'Click a node on the canvas to edit',
      legendNormal: 'flow',
      statusRunning: 'running',
      statusDone: 'done',
      statusError: 'error',
      importTitle: 'Import canvas JSON',
      importPlaceholder: 'Paste canvas JSON here…',
      importConfirm: 'Import',
      importError: 'Import failed: invalid JSON or missing nodes/edges',
      close: 'Close',
      newNode: 'New node',
      connect: 'Connect',
      connecting: 'Connecting',
      connectFinish: 'Done',
      menuDuplicate: 'Duplicate node',
      menuDelete: 'Delete node',
      pickerTitle: 'Create node',
      zoomIn: 'Zoom in (Ctrl+wheel)',
      zoomOut: 'Zoom out (Ctrl+wheel)',
      zoomReset: 'Reset zoom to 100%',
      zoomFit: 'Fit content',
      zoomFitShort: 'Fit',
      layoutBtn: 'Tidy layout',
      specBtn: 'Spec preview',
      specTitle: 'Execution spec preview (verbatim text sent to the model)',
      specHint: 'When bound to a session, the Host injects this text into the system prompt on every model-request assembly (recompiled live; mid-run edits only affect later nodes). Refreshes as you edit.',
      specEmpty: 'This canvas has no Main entry, so the compiled spec is empty — nothing would be injected.',
      specCopy: 'Copy',
      specCopied: 'Copied',
      specLoadFailed: 'Failed to build preview',
      agentDialogTitleNew: 'New agent (role)',
      agentDialogTitleEdit: 'Edit agent (role)',
      agentIdLabel: 'ID (unique, used as the file name; letters/digits/-/_)',
      agentNameLabel: 'Display name',
      agentDescLabel: 'Description (one line for the roster card and dropdown)',
      agentPromptLabel: 'Persona (role prompt injected on dispatch)',
      agentScopeLabel: 'Storage',
      agentScopeUser: 'User level (all canvases)',
      agentScopeProject: 'Project level (needs a project directory)',
      agentSave: 'Save agent',
      agentSavedToast: 'Agent saved',
      agentDelToast: 'Agent deleted',
      agentDeleteConfirm: 'Delete this agent file?',
      agentInvalid: 'ID (letter first, letters/digits/-/_) and persona are required',
      agentLoadFailed: 'Failed to load agent content',
      agentEditBtn: 'Edit agent',
      agentNew: '＋ New agent',
    }

    const CSS = [
      // While this view is mounted, hide the resident composer and the
      // width drag handles so the canvas owns the full conversation body —
      // the same contract workflow-lite uses with its data attribute.
      '[data-conversation-content]:has([data-agent-canvas-view]) [data-conversation-region=composer],[data-conversation-content]:has([data-agent-canvas-view]) [data-width-handle]{display:none !important}',
      '.awbc{position:relative;isolation:isolate;display:flex;flex-direction:column;height:100%;min-height:0;flex:1 1 0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}',
      // --- toolbar ---
      '.awbc-toolbar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.awbc-brand{flex:0 0 auto;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);font-size:12px;font-weight:700}',
      '.awbc-name{flex:0 1 auto;min-width:60px;max-width:220px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;padding:2px 4px;border-radius:6px}',
      '.awbc-name:focus{outline:none;background:var(--dsw-alias-bg-layer-2)}',
      '.awbc-badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.awbc-badge-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.awbc-badge.ok .awbc-badge-dot{background:var(--dsw-alias-state-success-primary)}',
      '.awbc-badge.error{color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.awbc-badge.error .awbc-badge-dot{background:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.awbc-spacer{flex:1 1 auto}',
      '.awbc-btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;padding:2px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.awbc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
      '.awbc-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.awbc-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.awbc-btn.primary.active{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1)}',
      '.awbc-btn.danger{border-color:transparent;color:var(--dsw-alias-state-error-primary)}',
      '.awbc-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid transparent}',
      '.awbc-chip.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.awbc-chip.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      // --- body layout ---
      '.awbc-body{flex:1 1 auto;display:flex;min-height:0}',
      // --- palette ---
      '.awbc-palette{flex:0 0 292px;min-width:0;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.awbc-palette.collapsed{flex-basis:34px}',
      '.awbc-pal-head{display:flex;align-items:baseline;gap:6px;padding:10px 12px 6px}',
      '.awbc-pal-title{font-weight:600;font-size:12px}',
      '.awbc-pal-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.awbc-pal-collapse{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:0 4px;border-radius:4px}',
      '.awbc-pal-collapse:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.awbc-pal-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:4px}',
      '.awbc-palette.collapsed .awbc-pal-scroll{display:none}',
      // --- 面板拖拽调宽 ---
      '.awbc-resizer{flex:0 0 8px;cursor:col-resize;background:transparent;position:relative;z-index:5}',
      '.awbc-resizer:hover{background:var(--dsw-alias-border-l1)}',
      '.awbc-resizer.active{background:var(--dsw-alias-brand-primary)}',
      '.awbc-palette.collapsed + .awbc-resizer{display:none}',
      '.awbc-sec{margin:8px 4px 0;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.awbc-card{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;cursor:grab;user-select:none;touch-action:none}',
      '.awbc-card:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.awbc-tile{flex:0 0 auto;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;color:#fff;font-size:12px}',
      '.awbc-tile.start{background:var(--dsw-alias-brand-primary)}',
      '.awbc-tile.work{background:var(--dsw-alias-state-info-primary,#4d6bfe)}',
      '.awbc-tile.router{background:var(--dsw-alias-state-warning-primary,#c78a1d)}',
      '.awbc-tile.end{background:var(--dsw-alias-state-success-primary)}',
      '.awbc-tile.hook{background:var(--dsw-alias-state-error-primary)}',
      '.awbc-card-main{flex:1 1 auto;min-width:0}',
      '.awbc-card-title{font-weight:500;font-size:12px;line-height:16px}',
      '.awbc-card-desc{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.awbc-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:2px 4px;line-height:15px}',
      // --- canvas ---
      '.awbc-stage{flex:1 1 auto;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}',
      '.awbc-viewport{flex:1 1 auto;min-height:0;overflow:hidden;position:relative;background-color:#0e1116;background-image:radial-gradient(#333b47 1px,transparent 1.2px);background-size:22px 22px;cursor:default}',
      '.awbc-viewport.space{cursor:grab}',
      '.awbc-viewport.space .awbc-node{cursor:grab}',
      '.awbc-viewport.panning,.awbc-viewport.panning .awbc-plane,.awbc-viewport.panning .awbc-node{cursor:grabbing}',
      '.awbc-marquee{position:absolute;border:1px dashed var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent);pointer-events:none;z-index:4}',
      // transform-origin 0 0：scale 以平面左上角为基准，pan 仍是屏幕像素位移，
      // 「screen = pan + world * zoom」这条换算式全文件依赖它，别动。
      '.awbc-plane{position:relative;user-select:none;transform-origin:0 0}',
      '.awbc-edge-layer{position:absolute;top:0;left:0;width:4000px;height:4000px;pointer-events:none;overflow:visible}',
      '.awbc-edge{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1.6}',
      '.awbc-edge.hot{stroke:var(--dsw-alias-brand-primary);stroke-width:2}',
      '.awbc-edge-arrow{fill:var(--dsw-alias-label-tertiary)}',
      '.awbc-edge-arrow.hot{fill:var(--dsw-alias-brand-primary)}',
      '.awbc-edge-arrow.yes{fill:#34c77b}',
      '.awbc-edge-arrow.no{fill:#e5534b}',
      '.awbc-edge.yes{stroke:#34c77b}',
      '.awbc-edge.no{stroke:#e5534b}',
      '.awbc-edge-label.yes{fill:#34c77b}',
      '.awbc-edge-label.no{fill:#e5534b}',
      '.awbc-edge-label{font-size:10px;fill:var(--dsw-alias-label-secondary);paint-order:stroke;stroke:var(--dsw-alias-bg-layer-2);stroke-width:3}',
      // --- node cards ---
      '.awbc-node{position:absolute;width:232px;min-height:60px;display:flex;gap:9px;align-items:flex-start;padding:9px 10px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:grab;user-select:none;touch-action:none}',
      '.awbc-node.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary),0 2px 8px rgba(0,0,0,.12)}',
      '.awbc-node.connect-src{border-color:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-success-primary)}',
      '.awbc-node-main{flex:1 1 auto;min-width:0}',
      '.awbc-node-titlerow{display:flex;align-items:center;gap:6px}',
      '.awbc-node-title{flex:1 1 auto;min-width:0;font-weight:600;font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.awbc-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:transparent}',
      '.awbc-dot.running{background:var(--dsw-alias-brand-primary)}',
      '.awbc-dot.done{background:var(--dsw-alias-state-success-primary)}',
      '.awbc-dot.error{background:var(--dsw-alias-state-error-primary)}',
      '.awbc-node-sub{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;max-height:30px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}',
      '.awbc-node-badge{margin-top:3px;color:var(--dsw-alias-state-warning-primary,#c78a1d);font-size:10px;line-height:13px}',
      // --- connection ports (workflow-lite style side dots) ---
      // Port center pinned at 32px from the node's OUTER top (= NODE_H / 2,
      // where edges terminate). top:26px + 5px half-height + 1px border = 32.
      '.awbc-port{position:absolute;top:26px;width:10px;height:10px;border-radius:50%;box-sizing:border-box;background:#0e1116;border:2px solid var(--dsw-alias-label-tertiary);cursor:crosshair;z-index:2;transition:border-color .12s linear, transform .12s linear}',
      // Generous invisible hit area around the small visible dot.
      '.awbc-port::after{content:"";position:absolute;inset:-8px}',
      '.awbc-port.in{left:-6px}',
      // 方向语法：左空心（入，等待被连入）· 右实心（出，从这里发出）。
      '.awbc-port.out{right:-6px;background:var(--dsw-alias-label-tertiary)}',
      // Hovering a node highlights the NODE border; hovering a port scales
      // the port itself (grab affordance).
      '.awbc-node:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.awbc-port:hover{border-color:var(--dsw-alias-brand-primary);transform:scale(1.25)}',
      '.awbc-node.start .awbc-port{border-color:var(--dsw-alias-brand-primary)}',
      '.awbc-node.work .awbc-port{border-color:var(--dsw-alias-state-info-primary,#4d6bfe)}',
      '.awbc-node.router .awbc-port{border-color:var(--dsw-alias-state-warning-primary,#c78a1d)}',
      '.awbc-node.end .awbc-port{border-color:var(--dsw-alias-state-success-primary)}',
      '.awbc-node.hook .awbc-port{border-color:var(--dsw-alias-state-error-primary)}',
      '.awbc-node.start .awbc-port.out{background:var(--dsw-alias-brand-primary)}',
      '.awbc-node.work .awbc-port.out{background:var(--dsw-alias-state-info-primary,#4d6bfe)}',
      '.awbc-node.router .awbc-port.out{background:var(--dsw-alias-state-warning-primary,#c78a1d)}',
      '.awbc-node.hook .awbc-port.out{background:var(--dsw-alias-state-error-primary)}',
      // 强制：结束节点是终点 — no outgoing port at all, so it never reads
      // as "you can keep going from here".
      '.awbc-node.end .awbc-port.out{display:none}',
      '.awbc-link-live{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-dasharray:5 4}',
      // --- editor panel ---
      '.awbc-editor{flex:0 0 292px;display:flex;flex-direction:column;gap:9px;padding:12px;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:auto}',
      '.awbc-field{display:flex;flex-direction:column;gap:3px}',
      '.awbc-label{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.awbc-req{color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.awbc-input.invalid{border-color:var(--dsw-alias-state-danger-primary,#e5484d)}',
      '.awbc-input{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;padding:4px 8px;border-radius:6px;width:100%;box-sizing:border-box}',
      '.awbc-textarea{min-height:80px;resize:vertical}',
      // --- 自绘下拉（Dropdown 组件，替代原生 select：弹层是系统菜单管不到）---
      '.awbc-dd{position:relative;display:inline-flex;min-width:0;max-width:100%}',
      '.awbc-editor .awbc-dd{width:100%}',
      '.awbc-dd-trigger{display:flex;align-items:center;gap:6px;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;padding:3px 8px;border-radius:6px;cursor:pointer;text-align:left}',
      '.awbc-dd-trigger:hover{border-color:var(--dsw-alias-border-l2)}',
      '.awbc-dd-trigger.open,.awbc-dd-trigger:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.awbc-dd-value{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.awbc-dd-arrow{flex:0 0 auto;width:10px;height:6px;background:center/contain no-repeat url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' fill=\'none\' stroke=\'%23888f9b\' stroke-width=\'1.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");transition:transform .12s linear}',
      '.awbc-dd-trigger.open .awbc-dd-arrow{transform:rotate(180deg)}',
      '.awbc-dd-pop{position:fixed;z-index:130;display:flex;flex-direction:column;gap:1px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgba(0,0,0,.3);max-height:260px;overflow:auto}',
      '.awbc-dd-item{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;padding:5px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.awbc-dd-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.awbc-dd-item.selected{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}',
      '.awbc-bind{width:auto;flex:0 1 auto;max-width:220px;font-size:11px}',
      '.awbc-runswitch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.awbc-runswitch-track{width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#333b47);border:1px solid var(--dsw-alias-border-l1);position:relative;transition:background .15s,border-color .15s}',
      '.awbc-runswitch-knob{position:absolute;top:1px;left:1px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .15s}',
      '.awbc-runswitch.on{color:var(--dsw-alias-state-success-primary)}',
      '.awbc-runswitch.on .awbc-runswitch-track{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.awbc-runswitch.on .awbc-runswitch-knob{transform:translateX(12px);background:var(--dsw-alias-bg-layer-1)}',
      '.awbc-warnbadge{align-self:flex-start;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-state-warning-primary,#c78a1d);color:var(--dsw-alias-state-warning-primary,#c78a1d);font-size:10px}',
      '.awbc-edge-row{display:flex;flex-direction:column;gap:3px;padding:6px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.awbc-edge-line{display:flex;align-items:center;gap:6px}',
      '.awbc-edge-text{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.awbc-mini{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:0 4px;border-radius:4px}',
      '.awbc-mini:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}',
      // --- issues panel ---
      '.awbc-issues{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:30;max-width:70%;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 16px rgba(0,0,0,.18);max-height:150px;overflow:auto}',
      '.awbc-issue{display:block;font-size:11px;line-height:17px}',
      '.awbc-issue.error{color:var(--dsw-alias-state-error-primary)}',
      '.awbc-issue.warn{color:var(--dsw-alias-state-warning-primary,#c78a1d)}',
      // --- status bar ---
      '.awbc-status{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:3px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap;overflow:hidden}',
      '.awbc-legend{display:inline-flex;align-items:center;gap:5px}',
      '.awbc-swatch{display:inline-block;width:16px;height:0;border-top:2px solid var(--dsw-alias-label-tertiary)}',
      // --- zoom widget（视口右下角悬浮控件）---
      '.awbc-zoom{position:absolute;right:12px;bottom:12px;z-index:6;display:flex;align-items:center;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 2px 8px rgba(0,0,0,.15)}',
      '.awbc-zoom button{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.awbc-zoom button:hover{background:var(--dsw-alias-bg-layer-2)}',
      // --- spec preview（右栏「规范」标签页，常驻实时） ---
      '.awbc-spec{flex:1 1 0;display:flex;flex-direction:column;gap:6px;min-height:0}',
      '.awbc-spec-head{display:flex;align-items:center;gap:6px;min-height:24px}',
      '.awbc-specpre{flex:1 1 auto;min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.awbc-speclabel{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      // --- overlays ---
      '.awbc-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}',
      '.awbc-empty-inner{max-width:420px;padding:14px 18px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);text-align:center}',
      '.awbc-toast{position:absolute;bottom:40px;left:50%;transform:translateX(-50%);z-index:60;max-width:70%;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 16px rgba(0,0,0,.18);white-space:pre-wrap;word-break:break-all}',
      '.awbc-overlay{position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}',
      '.awbc-dialog{width:460px;max-width:92%;display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.awbc-dialog-title{font-weight:600}',
      '.awbc-dialog textarea{min-height:160px;font-family:monospace;resize:vertical}',
      '.awbc-error{color:var(--dsw-alias-state-error-primary)}',
      '.awbc-ghost{position:fixed;z-index:100;pointer-events:none;display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:12px}',
      // --- node context menu ---
      '.awbc-menu{position:fixed;z-index:120;min-width:150px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 28px rgba(0,0,0,.3)}',
      '.awbc-menu-item{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;padding:6px 10px;border-radius:6px;cursor:pointer}',
      '.awbc-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.awbc-menu-item.danger{color:var(--dsw-alias-state-error-primary)}',
      '.awbc-menu-item.danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}',
      '.awbc-menu-item[disabled]{opacity:.4;cursor:not-allowed}',
      // --- 角色档位徽标（v2.8.1）：U=用户级(绿底) / P=项目级(蓝底)，白字，写在名册卡片的图标方块上 ---
      '.awbc-scope-badge{display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:inherit;font-size:12px;font-weight:700;line-height:1;color:#fff}',
      '.awbc-scope-badge.user{background:#2f9e44}',
      '.awbc-scope-badge.project{background:#2f6fe0}',
      // --- agent editor（v2.8.0 名册角色新建/编辑弹窗）---
      '.awbc-agent-dialog{width:560px;max-width:92%;max-height:82vh;overflow:auto}',
      '.awbc-agent-dialog textarea{min-height:200px}',
      '.awbc-field{display:flex;flex-direction:column;gap:3px}',
      '.awbc-field > label{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.awbc-card-edit{position:absolute;top:4px;right:4px;z-index:2;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;padding:3px 5px;border-radius:5px;cursor:pointer;opacity:0;transition:opacity .12s}',
      '.awbc-card:hover .awbc-card-edit{opacity:1}',
      '.awbc-card-edit:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
    ].join('')

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    function uid(prefix) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }

    function typeLabel(t, type) {
      if (type === 'start') return t('typeStart')
      if (type === 'router') return t('typeRouter')
      if (type === 'end') return t('typeEnd')
      if (type === 'hook') return t('typeHook')
      return t('typeWork')
    }

    function typeDesc(t, type) {
      if (type === 'start') return t('descStart')
      if (type === 'router') return t('descRouter')
      if (type === 'end') return t('descEnd')
      if (type === 'hook') return t('descHook')
      return t('descWork')
    }

    function emptyDoc() {
      // A canvas always starts with its Main-session entry node.
      return {
        version: 1,
        id: '',
        name: '',
        updatedAt: 0,
        nodes: [
          { id: uid('n'), type: 'start', label: '主会话', description: '', prompt: '', agent: '', exec: 'lead', hookKind: '', note: '', x: 280, y: 200 },
        ],
        edges: [],
      }
    }

    function normalizeDoc(raw) {
      if (!raw || typeof raw !== 'object') return null
      const nodesRaw = Array.isArray(raw.nodes) ? raw.nodes : null
      if (!nodesRaw) return null
      const nodes = []
      for (const node of nodesRaw) {
        if (!node || typeof node !== 'object') continue
        const type = NODE_TYPES[node.type] ? node.type : 'work'
        nodes.push({
          id: String(node.id || uid('n')),
          type,
          label: String(node.label || '').slice(0, 80),
          description: typeof node.description === 'string' ? node.description.slice(0, 400) : '',
          prompt: typeof node.prompt === 'string' ? node.prompt.slice(0, 4000) : '',
          agent: typeof node.agent === 'string' ? node.agent.slice(0, 120) : '',
          exec: node.exec === 'lead' ? 'lead' : 'subagent',
          hookKind: HOOK_KINDS.some(kind => kind.value === node.hookKind) ? node.hookKind : '',
          note: typeof node.note === 'string' ? node.note.slice(0, 1000) : '',
          x: clamp(Number(node.x) || 0, -100000, 100000),
          y: clamp(Number(node.y) || 0, -100000, 100000),
        })
      }
      const ids = new Set(nodes.map(node => node.id))
      const seen = new Set()
      const edges = []
      for (const edge of Array.isArray(raw.edges) ? raw.edges : []) {
        if (!edge || typeof edge !== 'object') continue
        const from = String(edge.from || '')
        const to = String(edge.to || '')
        if (!ids.has(from) || !ids.has(to) || from === to) continue
        const key = from + '->' + to
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ id: String(edge.id || uid('e')), from, to, label: typeof edge.label === 'string' ? edge.label.slice(0, 120) : '' })
      }
      return {
        version: 1,
        id: typeof raw.id === 'string' ? raw.id : '',
        name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '',
        projectDir: typeof raw.projectDir === 'string' ? raw.projectDir.slice(0, 4096) : '',
        updatedAt: Number(raw.updatedAt) || 0,
        nodes,
        edges,
      }
    }

    function validateDoc(doc, t) {
      const issues = []
      const starts = doc.nodes.filter(node => node.type === 'start')
      const ends = doc.nodes.filter(node => node.type === 'end')
      if (starts.length === 0) issues.push({ level: 'error', text: t('errNoStart') })
      if (starts.length > 1) issues.push({ level: 'error', text: t('errMultiStart') })
      if (ends.length === 0) issues.push({ level: 'error', text: t('errNoEnd') })
      if (starts.length === 1 && ends.length > 0) {
        const out = new Map()
        for (const edge of doc.edges) {
          if (!out.has(edge.from)) out.set(edge.from, [])
          out.get(edge.from).push(edge.to)
        }
        const seen = new Set([starts[0].id])
        const queue = [starts[0].id]
        while (queue.length > 0) {
          const current = queue.shift()
          for (const next of out.get(current) || []) {
            if (!seen.has(next)) {
              seen.add(next)
              queue.push(next)
            }
          }
        }
        if (!ends.some(end => seen.has(end.id))) issues.push({ level: 'error', text: t('errStartNoPath') })
      }
      for (const node of doc.nodes) {
        const outs = doc.edges.filter(edge => edge.from === node.id)
        // 名称是必填项：为空或纯空白都算错误，阻止保存。
        if (!String(node.label || '').trim()) {
          issues.push({ level: 'error', text: t('errNodeNoLabel').replace('{a}', t('type' + node.type.charAt(0).toUpperCase() + node.type.slice(1)) || node.id) })
        }
        if (node.type === 'router' && outs.length === 0) {
          issues.push({ level: 'error', text: t('errRouterNoOut').replace('{a}', node.label || node.id) })
        }
        if (node.type === 'router') {
          for (const edge of outs) {
            if (!edge.label) issues.push({ level: 'warn', text: t('warnRouterNoLabel').replace('{a}', node.label || node.id) })
          }
        }
        if (node.type === 'work' && !node.prompt) {
          issues.push({ level: 'warn', text: t('warnWorkNoPrompt').replace('{a}', node.label || node.id) })
        }
        if (node.type === 'hook' && !node.hookKind) {
          issues.push({ level: 'warn', text: t('warnHookNoKind').replace('{a}', node.label || node.id) })
        }
        // 强制：结束节点是终点（不允许连出），主会话是入口（不允许被连入）。
        if (node.type === 'end' && outs.length > 0) {
          issues.push({ level: 'error', text: t('errEndOut').replace('{a}', node.label || node.id) })
        }
        if (node.type === 'start' && doc.edges.some(edge => edge.to === node.id)) {
          issues.push({ level: 'error', text: t('errStartIn') })
        }
      }
      return issues
    }

    /** Single POST endpoint on the Host half (workflow-lite's proven shape). */
    async function apiCall(payload) {
      const response = await fetch(API + '/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json()
          if (body && body.error) detail = ' ' + String(body.error)
        } catch {
          /* keep status only */
        }
        throw new Error('HTTP ' + response.status + detail)
      }
      return response.json()
    }

    function nodeSubText(node, t) {
      if (node.type === 'work') {
        const parts = []
        parts.push(node.exec === 'lead' ? t('execLead') : t('execSubagent'))
        if (node.agent) parts.push(node.agent)
        if (node.prompt) parts.push(node.prompt)
        return parts.join(' · ')
      }
      if (node.type === 'router') return node.description || t('routerHint')
      if (node.type === 'hook') {
        const kindDef = HOOK_KINDS.find(kind => kind.value === node.hookKind)
        const kind = kindDef ? t(kindDef.labelKey) : ''
        return [kind, node.note].filter(Boolean).join(' · ')
      }
      return node.description || typeDesc(t, node.type)
    }

    function edgeGeometry(from, to) {
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const dx = Math.max(40, Math.abs(x2 - x1) / 2)
      return { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
    }

    function pickLane(lanes, label) {
      let best = null
      for (const lane of lanes || []) {
        if (!lane || lane.label !== label) continue
        const started = Number(lane.startedAt) || 0
        if (!best || started > (Number(best.startedAt) || 0)) best = lane
      }
      return best
    }

    function shortTime(value) {
      const ms = Number(value) || 0
      if (!ms) return ''
      const date = new Date(ms)
      const sameDay = new Date().toDateString() === date.toDateString()
      const clock = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
      return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`
    }

    // 自绘下拉（替代原生 <select>）：原生 select 弹开的列表在 macOS 上是系统
    // 菜单，CSS 管不到（用户反馈「弹开还是原生的」）。触发按钮 + fixed 定位
    // 浮层；fixed 是为了逃出右栏 editor 的 overflow:auto 裁剪，代价是锚点
    // 跟随不了滚动/缩放——列表外任何滚动直接收起。
    // props: { value, options: [{value,label}], onChange, className, title }
    function Dropdown(props) {
      const options = Array.isArray(props.options) ? props.options : []
      const value = props.value
      const onChange = typeof props.onChange === 'function' ? props.onChange : () => {}
      const [open, setOpen] = React.useState(false)
      const [popStyle, setPopStyle] = React.useState(null)
      const btnRef = React.useRef(null)
      const popRef = React.useRef(null)
      const current = options.find(option => option.value === value)

      const place = React.useCallback(() => {
        const btn = btnRef.current
        if (!btn) return
        const rect = btn.getBoundingClientRect()
        const width = Math.max(rect.width, 150)
        const style = { left: clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8)), width }
        const estimated = Math.min(options.length * 27 + 8, 260) + 12
        // 下方放不下且上方放得下 → 向上弹。
        if (rect.bottom + estimated > window.innerHeight - 8 && rect.top - estimated > 8) {
          style.bottom = window.innerHeight - rect.top + 4
        } else {
          style.top = rect.bottom + 4
        }
        setPopStyle(style)
      }, [options.length])

      // useLayoutEffect：绘制前完成定位，避免浮层先闪现在默认位置再跳正。
      React.useLayoutEffect(() => {
        if (!open) return undefined
        place()
        const onDown = event => {
          const target = event.target
          if (popRef.current && target instanceof Node && popRef.current.contains(target)) return
          if (btnRef.current && target instanceof Node && btnRef.current.contains(target)) return
          setOpen(false)
        }
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onMoveAway = event => {
          const target = event.target
          if (popRef.current && target instanceof Node && popRef.current.contains(target)) return
          setOpen(false)
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('scroll', onMoveAway, true)
        window.addEventListener('wheel', onMoveAway, { capture: true, passive: true })
        window.addEventListener('resize', onMoveAway)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('scroll', onMoveAway, true)
          window.removeEventListener('wheel', onMoveAway, { capture: true })
          window.removeEventListener('resize', onMoveAway)
        }
      }, [open, place])

      return h('div', { className: 'awbc-dd' + (props.className ? ' ' + props.className : '') },
        h('button', {
          type: 'button',
          ref: btnRef,
          className: 'awbc-dd-trigger' + (open ? ' open' : ''),
          title: props.title || (current ? current.label : ''),
          onClick: () => setOpen(state => !state),
        },
          h('span', { className: 'awbc-dd-value' }, current ? current.label : '\u00a0'),
          h('span', { className: 'awbc-dd-arrow', 'aria-hidden': true }),
        ),
        open
          ? h('div', { className: 'awbc-dd-pop', ref: popRef, style: popStyle, role: 'listbox' },
              options.map(option =>
                h('button', {
                  key: option.value,
                  type: 'button',
                  className: 'awbc-dd-item' + (option.value === value ? ' selected' : ''),
                  onClick: () => {
                    setOpen(false)
                    if (option.value !== value) onChange(option.value)
                  },
                }, option.label),
              ),
            )
          : null,
      )
    }

    // Workbench cache: the view unmounts when the user switches tabs, so the
    // working document (including unsaved edits), its save snapshot, and the
    // pan offset live here at module scope — switching 对话 ⇄ 流程画布 keeps
    // the workbench exactly as it was left.
    const WORKBENCH = { doc: null, savedSnap: '', pan: null, zoom: null }

    function CanvasPage(props) {
      const safeProps = props && typeof props === 'object' ? props : {}
      const t = typeof safeProps.t === 'function' ? safeProps.t : key => zh[key] || key
      const useProjection = typeof safeProps.useProjection === 'function' ? safeProps.useProjection : null

      const initialDoc = WORKBENCH.doc ? WORKBENCH.doc : emptyDoc()
      const sessionId = safeProps.sessionId || ''
      const [doc, setDoc] = React.useState(initialDoc)
      const [docsList, setDocsList] = React.useState([])
      // M2.1 会话绑定：当前会话绑定的 canvasId（空串 = 未绑定）。
      const [binding, setBinding] = React.useState('')
      const [selectedId, setSelectedId] = React.useState('')
      const [connectMode, setConnectMode] = React.useState(false)
      const [connectSource, setConnectSource] = React.useState('')
      const [agents, setAgents] = React.useState([])
      const [agentsState, setAgentsState] = React.useState('loading')
      // v2.8.0 角色编辑：名册不再只读——null=关闭，否则是编辑草稿 {isNew,id,name,description,prompt,scope,busy}
      const [agentEditor, setAgentEditor] = React.useState(null)
      // v2.5.2 面板宽度：左右两栏都可拖拽调宽；初始同宽 292px，拖完的选择记 localStorage
      const [paletteW, setPaletteW] = React.useState(() => {
        try {
          const value = Number(window.localStorage.getItem('awbc.paletteW'))
          return value >= 200 && value <= 460 ? value : 292
        } catch {
          return 292
        }
      })
      const [editorW, setEditorW] = React.useState(() => {
        try {
          const value = Number(window.localStorage.getItem('awbc.editorW'))
          return value >= 200 && value <= 460 ? value : 292
        } catch {
          return 292
        }
      })
      const [resizing, setResizing] = React.useState('')
      const startPanelResize = (side, startWidth) => event => {
        event.preventDefault()
        setResizing(side)
        const startX = event.clientX
        let latest = startWidth
        const applyWidth = side === 'palette' ? setPaletteW : setEditorW
        const onMove = moveEvent => {
          const delta = moveEvent.clientX - startX
          latest = Math.max(200, Math.min(460, side === 'palette' ? startWidth + delta : startWidth - delta))
          applyWidth(latest)
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          setResizing('')
          try {
            window.localStorage.setItem(side === 'palette' ? 'awbc.paletteW' : 'awbc.editorW', String(latest))
          } catch {
            /* 只影响本次会话 */
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }
      const [issues, setIssues] = React.useState(null)
      // 问题列表已展示时随文档编辑实时刷新，修正名称后错误立即消失。
      React.useEffect(() => {
        if (issues !== null) setIssues(validateDoc(doc, t))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc])
      const [importOpen, setImportOpen] = React.useState(false)
      const [importText, setImportText] = React.useState('')
      const [importError, setImportError] = React.useState('')
      // 规范预览：点工具栏「≣ 规范预览」临时切到右栏规范视图（非常驻）；
      // 激活时随 doc 变更防抖 500ms 实时重编；选中节点或再点一次按钮即回到属性。
      const [specMode, setSpecMode] = React.useState(false)
      const [specText, setSpecText] = React.useState('')
      const [specState, setSpecState] = React.useState('loading')
      const [specCopied, setSpecCopied] = React.useState(false)
      React.useEffect(() => {
        if (!specMode) return undefined
        let alive = true
        setSpecState('loading')
        const timer = setTimeout(() => {
          apiCall({ action: 'specPreview', canvas: doc })
            .then(data => {
              if (!alive) return
              setSpecText(String((data && data.spec) || ''))
              setSpecState('ready')
              setSpecCopied(false)
            })
            .catch(() => {
              if (alive) setSpecState('error')
            })
        }, 500)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [specMode, doc])
      const copySpec = React.useCallback(() => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(specText)
            setSpecCopied(true)
          }
        } catch {
          /* clipboard unavailable */
        }
      }, [specText])
      const [toast, setToast] = React.useState('')
      const [ghost, setGhost] = React.useState(null)
      const [palOpen, setPalOpen] = React.useState(true)
      // Infinite canvas: the stage is translated by (pan.x, pan.y) with no
      // bounds; the dot grid on the viewport shifts by the same offset, so
      // panning reads as moving the canvas itself. Panning happens while
      // SPACE is held; without it, blank-canvas drag is a selection marquee.
      const [pan, setPan] = React.useState(() => (WORKBENCH.pan ? WORKBENCH.pan : { x: 0, y: 0 }))
      // 画布缩放：transform = translate(pan) scale(zoom)，pan 保持屏幕像素。
      // 「screen = pan + world * zoom」，所有屏幕→平面换算都要除以 zoom。
      const [zoom, setZoom] = React.useState(() => (WORKBENCH.zoom ? WORKBENCH.zoom : 1))
      const [spaceHeld, setSpaceHeld] = React.useState(false)
      const [multiIds, setMultiIds] = React.useState([])
      const [marquee, setMarquee] = React.useState(null)
      // Port-to-port linking: set while dragging from a node's port; cx/cy
      // track the cursor in PLANE coordinates for the live rubber-band line.
      const [linkDrag, setLinkDrag] = React.useState(null)
      // Blank-drop picker: { screenX, screenY, x, y, fromId } — offer to
      // create a node at the drop point, auto-linked from the source.
      const [linkMenu, setLinkMenu] = React.useState(null)
      const linkMenuRef = React.useRef(null)
      // Node context menu: { x, y, nodeId } in viewport coordinates.
      const [menu, setMenu] = React.useState(null)
      const menuRef = React.useRef(null)
      const viewportRef = React.useRef(null)
      const dragRef = React.useRef(null)
      const savedSnapRef = React.useRef(WORKBENCH.savedSnap || JSON.stringify(initialDoc))
      // 自动保存状态：idle | pending（防抖等待） | saving | error
      const [saveState, setSaveState] = React.useState('idle')
      // 撤销/重做历史：doc 快照栈 + 指针。suppress 标记 undo/redo 自身的 doc 变更，不进栈。
      const histRef = React.useRef({ canvasId: initialDoc.id, stack: [JSON.stringify(initialDoc)], index: 0, last: JSON.stringify(initialDoc), lastAt: 0, suppress: false })

      // Mirror the workbench into module scope so a tab switch (unmount) and
      // return (remount) restores the exact working state.
      React.useEffect(() => {
        WORKBENCH.doc = doc
        WORKBENCH.savedSnap = savedSnapRef.current
        WORKBENCH.pan = pan
        WORKBENCH.zoom = zoom
      }, [doc, pan, zoom])

      // --- 画布缩放 ---------------------------------------------------------
      const ZOOM_MIN = 0.25
      const ZOOM_MAX = 2.5
      const zoomRef = React.useRef(zoom)
      // 判断出线「自定义」模式的记忆：选中自定义但文字还没填时，下拉要保持停在自定义项并露出输入框
      const branchCustomRef = React.useRef({})
      zoomRef.current = zoom

      // 以（屏幕坐标）锚点为中心缩放：锚点的世界坐标在缩放前后保持不动。
      const zoomAt = React.useCallback((anchorX, anchorY, factor) => {
        const viewport = viewportRef.current
        const rect = viewport ? viewport.getBoundingClientRect() : null
        const screenX = rect ? anchorX - rect.left : anchorX
        const screenY = rect ? anchorY - rect.top : anchorY
        const prev = zoomRef.current
        const next = clamp(prev * factor, ZOOM_MIN, ZOOM_MAX)
        if (next === prev) return
        zoomRef.current = next
        setZoom(next)
        setPan(p => ({ x: screenX - ((screenX - p.x) / prev) * next, y: screenY - ((screenY - p.y) / prev) * next }))
      }, [])

      const zoomStep = React.useCallback(
        factor => {
          const viewport = viewportRef.current
          const rect = viewport ? viewport.getBoundingClientRect() : null
          zoomAt(rect ? rect.left + rect.width / 2 : 0, rect ? rect.top + rect.height / 2 : 0, factor)
        },
        [zoomAt],
      )

      const zoomReset = React.useCallback(() => zoomStep(1 / zoomRef.current), [zoomStep])

      // 适应内容：框住全部节点，缩放上限 1.5（单节点不放大到满屏）。
      const fitView = React.useCallback(() => {
        const viewport = viewportRef.current
        const rect = viewport ? viewport.getBoundingClientRect() : null
        if (!rect) return
        if (doc.nodes.length === 0) {
          zoomRef.current = 1
          setZoom(1)
          setPan({ x: 0, y: 0 })
          return
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const n of doc.nodes) {
          minX = Math.min(minX, n.x)
          minY = Math.min(minY, n.y)
          maxX = Math.max(maxX, n.x + NODE_W)
          maxY = Math.max(maxY, n.y + NODE_H)
        }
        const pad = 56
        const next = clamp(Math.min(rect.width / (maxX - minX + pad * 2), rect.height / (maxY - minY + pad * 2)), ZOOM_MIN, 1.5)
        zoomRef.current = next
        setZoom(next)
        setPan({ x: rect.width / 2 - ((minX + maxX) / 2) * next, y: rect.height / 2 - ((minY + maxY) / 2) * next })
      }, [doc.nodes])

      // Ctrl/Cmd+滚轮 = 以光标为锚缩放；Shift+滚轮 = 横向平移；普通滚轮 = 平移。
      // React 的 onWheel 是 passive 的，preventDefault 无效，必须挂原生非 passive 监听。
      React.useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport) return undefined
        const onWheel = event => {
          const target = event.target
          if (target && target.closest && (target.closest('.awbc-issues') || target.closest('.awbc-menu'))) return
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0016))
            return
          }
          event.preventDefault()
          const dx = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX
          const dy = event.shiftKey ? 0 : event.deltaY
          setPan(p => ({ x: p.x - dx, y: p.y - dy }))
        }
        viewport.addEventListener('wheel', onWheel, { passive: false })
        return () => viewport.removeEventListener('wheel', onWheel)
      }, [zoomAt])

      // M2.3/M2.4：节点状态 = 投影亮灯（subagent 派发）+ canvas_report 上报（主会话自己走节点）。
      const board = useProjection ? useProjection('agentWorkflowBoard') : undefined
      const lanes = board && Array.isArray(board.lanes) ? board.lanes : []
      const [runtimeStatus, setRuntimeStatus] = React.useState({})
      React.useEffect(() => {
        let alive = true
        const poll = () => {
          const canvasId = doc.id
          if (!canvasId) return
          apiCall({ action: 'getStatus', id: canvasId })
            .then(data => {
              if (alive) setRuntimeStatus((data && data.status) || {})
            })
            .catch(() => {})
        }
        poll()
        const timer = setInterval(poll, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [doc.id])

      const dirty = JSON.stringify(doc) !== savedSnapRef.current
      // error 级问题数（很小的图，直接算不贵）：>0 时自动保存被挡，徽章显示「未保存」而非「保存中…」。
      const errorCount = React.useMemo(() => validateDoc(doc, t).filter(issue => issue.level === 'error').length, [doc, t])

      const showToast = React.useCallback(text => {
        setToast(text || '')
      }, [])

      React.useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(''), 3200)
        return () => clearTimeout(timer)
      }, [toast])

      const refreshDocs = React.useCallback(() => {
        apiCall({ action: 'list' })
          .then(data => setDocsList(Array.isArray(data && data.canvases) ? data.canvases : []))
          .catch(() => setDocsList([]))
      }, [])

      const refreshAgents = React.useCallback((projectDir) => {
        setAgentsState('loading')
        apiCall({ action: 'agents', projectDir: typeof projectDir === 'string' ? projectDir : '' })
          .then(data => {
            setAgents(Array.isArray(data && data.agents) ? data.agents : [])
            setAgentsState('ready')
          })
          .catch(error => setAgentsState('failed:' + String((error && error.message) || 'unknown')))
      }, [])

      React.useEffect(() => {
        refreshDocs()
        refreshAgents()
      }, [refreshDocs, refreshAgents])

      // v2.6.1：项目目录变化 → 名册按「用户级 + 该项目」重取
      React.useEffect(() => {
        if (doc && typeof doc.projectDir === 'string') refreshAgents(doc.projectDir)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc && doc.projectDir])

      // SPACE pans the canvas; typing a space into a field must still work.
      React.useEffect(() => {
        const isTextField = target => {
          if (!target) return false
          const tag = target.tagName
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
        }
        const onKeyDown = event => {
          if (event.code !== 'Space' || event.repeat) return
          if (isTextField(event.target)) return
          event.preventDefault()
          setSpaceHeld(true)
        }
        const onKeyUp = event => {
          if (event.code !== 'Space') return
          setSpaceHeld(false)
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
          setSpaceHeld(false)
        }
      }, [])

      // Live marquee selection: nodes intersecting the box are highlighted.
      React.useEffect(() => {
        if (!marquee || !marquee.box) return
        const box = marquee.box
        const ids = doc.nodes
          .filter(node => node.x + NODE_W >= box.x0 && node.x <= box.x1 && node.y + 32 >= box.y0 && node.y <= box.y1)
          .map(node => node.id)
        setMultiIds(ids)
      }, [marquee])

      // While this view is open, hide the resident composer and width drag
      // handles directly (CSS :has() alone can lose to shell show/hide logic),
      // restoring whatever was there when the view unmounts.
      React.useEffect(() => {
        const hidden = []
        const hide = selector => {
          let nodes = []
          try {
            nodes = Array.from(document.querySelectorAll(selector))
          } catch {
            nodes = []
          }
          for (const el of nodes) {
            if (!el || el.getAttribute('data-agent-canvas-hidden') === 'true') continue
            el.setAttribute('data-agent-canvas-hidden', 'true')
            el.dataset.agentCanvasPrevDisplay = el.style.display || ''
            el.style.display = 'none'
            hidden.push(el)
          }
        }
        hide('[data-conversation-region="composer"]')
        hide('[data-width-handle]')
        return () => {
          for (const el of hidden) {
            el.style.display = el.dataset && el.dataset.agentCanvasPrevDisplay ? el.dataset.agentCanvasPrevDisplay : ''
            el.removeAttribute('data-agent-canvas-hidden')
          }
        }
      }, [])

      const openDoc = React.useCallback(
        id => {
          apiCall({ action: 'get', id })
            .then(data => {
              const parsed = normalizeDoc(data && data.canvas)
              if (!parsed) throw new Error('bad doc')
              setDoc(parsed)
              savedSnapRef.current = JSON.stringify(parsed)
              setSelectedId('')
              setConnectSource('')
              setIssues(null)
            })
            .catch(() => showToast(t('loadFailed')))
        },
        [showToast, t],
      )

      // 落盘核心：手动保存与自动保存共用。返回 Promise<boolean>。
      const persistDoc = React.useCallback(
        (base, opts) => {
          const options = opts || {}
          setSaveState('saving')
          const next = { ...base, name: base.name || t('docUnnamed'), updatedAt: Date.now() }
          if (!next.id) next.id = uid('c')
          return apiCall({ action: 'put', canvas: next })
            .then(data => {
              const saved = normalizeDoc(data && data.canvas)
              const finalDoc = saved || next
              savedSnapRef.current = JSON.stringify(finalDoc)
              // 保存期间用户可能又改了图：只在文档没被继续编辑时回写规范化的结果。
              setDoc(prev => (JSON.stringify(prev) === JSON.stringify(base) ? finalDoc : prev))
              setSaveState('idle')
              if (!options.silent) showToast(t('saved'))
              refreshDocs()
              return true
            })
            .catch(() => {
              setSaveState('error')
              if (!options.silent) showToast(t('loadFailed'))
              return false
            })
        },
        [refreshDocs, showToast, t],
      )

      // --- M2.1 会话绑定 ---------------------------------------------------
      React.useEffect(() => {
        if (!sessionId) {
          setBinding('')
          return undefined
        }
        let alive = true
        apiCall({ action: 'getBinding', sessionId })
          .then(data => {
            if (alive) setBinding((data && data.binding && data.binding.canvasId) || '')
          })
          .catch(() => {
            if (alive) setBinding('')
          })
        return () => {
          alive = false
        }
      }, [sessionId])

      const setSessionBinding = React.useCallback(
        canvasId => {
          if (!sessionId) return
          if (!canvasId) {
            apiCall({ action: 'unbind', sessionId })
              .then(() => {
                setBinding('')
                showToast(t('unbindSaved'))
              })
              .catch(() => showToast(t('loadFailed')))
            return
          }
          apiCall({ action: 'bind', sessionId, canvasId })
            .then(() => {
              setBinding(canvasId)
              showToast(t('bindSaved'))
              openDoc(canvasId)
            })
            .catch(() => showToast(t('loadFailed')))
        },
        [sessionId, showToast, t, openDoc],
      )

      const saveDoc = React.useCallback(() => {
        // 保存前强制校验：存在 error 级问题时不允许保存，并展示问题列表。
        const found = validateDoc(doc, t)
        setIssues(found)
        if (found.some(issue => issue.level === 'error')) {
          showToast(t('saveBlocked'))
          return
        }
        persistDoc(doc)
      }, [doc, persistDoc, t])

      // 自动保存：文档变更后防抖落盘；有 error 级校验问题时暂不自动保存（等修正后下一笔编辑触发）。
      React.useEffect(() => {
        if (!dirty) return undefined
        setSaveState(state => (state === 'saving' ? state : 'pending'))
        const timer = setTimeout(() => {
          const found = validateDoc(doc, t)
          if (found.some(issue => issue.level === 'error')) return
          if (JSON.stringify(doc) === savedSnapRef.current) return
          persistDoc(doc, { silent: true })
        }, 1800)
        return () => clearTimeout(timer)
      }, [doc, dirty, persistDoc, t])

      // 未保存内容防丢兜底：还有未落盘变更时，关闭/重载窗口前挂原生确认。
      // 自动保存把窗口缩到 1.8s 防抖内，这里只挡真正的意外退出。
      React.useEffect(() => {
        if (!dirty) return undefined
        const handler = event => {
          event.preventDefault()
          event.returnValue = ''
          return ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
      }, [dirty])

      // --- 撤销/重做 -------------------------------------------------------
      // doc 变更进栈：连续变更 700ms 内合并为一步（拖动逐帧、输入逐键不会刷爆栈）。
      const HISTORY_COALESCE_MS = 700
      const HISTORY_MAX = 100
      React.useEffect(() => {
        const snap = JSON.stringify(doc)
        const hist = histRef.current
        if (hist.suppress) {
          hist.suppress = false
          hist.last = snap
          hist.lastAt = Date.now()
          return
        }
        if (hist.last === snap) return
        if (hist.canvasId !== doc.id) {
          // 换了一张画布（新建/打开/保存后拿到 id）：历史重置。
          hist.canvasId = doc.id
          hist.stack = [snap]
          hist.index = 0
        } else if (hist.index >= 0 && Date.now() - hist.lastAt < HISTORY_COALESCE_MS) {
          hist.stack[hist.index] = snap
        } else {
          hist.stack = hist.stack.slice(0, hist.index + 1)
          hist.stack.push(snap)
          if (hist.stack.length > HISTORY_MAX) hist.stack.shift()
          hist.index = hist.stack.length - 1
        }
        hist.last = snap
        hist.lastAt = Date.now()
      }, [doc])

      const applyHistory = React.useCallback(snap => {
        const parsed = normalizeDoc(JSON.parse(snap))
        if (!parsed) return
        histRef.current.suppress = true
        setDoc(parsed)
      }, [])

      const canUndo = histRef.current.index > 0
      const canRedo = histRef.current.index < histRef.current.stack.length - 1

      const undo = React.useCallback(() => {
        const hist = histRef.current
        if (hist.index <= 0) return
        hist.index -= 1
        applyHistory(hist.stack[hist.index])
      }, [applyHistory])

      const redo = React.useCallback(() => {
        const hist = histRef.current
        if (hist.index >= hist.stack.length - 1) return
        hist.index += 1
        applyHistory(hist.stack[hist.index])
      }, [applyHistory])

      // Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做；输入框内不拦截。
      React.useEffect(() => {
        const onKeyDown = event => {
          const key = String(event.key || '').toLowerCase()
          if (key !== 'z' && key !== 'y') return
          const target = event.target
          const tag = target && target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
          const mod = event.metaKey || event.ctrlKey
          if (!mod) return
          if (key === 'z' && !event.shiftKey) {
            event.preventDefault()
            undo()
          } else if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
            event.preventDefault()
            redo()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [undo, redo])

      // undo/redo 后选中的节点可能已不存在：清空选择。
      React.useEffect(() => {
        if (selectedId && !doc.nodes.some(node => node.id === selectedId)) {
          setSelectedId('')
          setMultiIds([])
        }
        if (multiIds.length > 0) {
          const alive = multiIds.filter(id => doc.nodes.some(node => node.id === id))
          if (alive.length !== multiIds.length) setMultiIds(alive)
        }
      }, [doc, selectedId, multiIds])

      const deleteDoc = React.useCallback(() => {
        if (!doc.id) return
        if (!window.confirm(t('confirmDelete'))) return
        apiCall({ action: 'delete', id: doc.id })
          .then(() => {
            const empty = emptyDoc()
            setDoc(empty)
            savedSnapRef.current = JSON.stringify(empty)
            setSelectedId('')
            showToast(t('deleted'))
            refreshDocs()
          })
          .catch(() => showToast(t('loadFailed')))
      }, [doc.id, refreshDocs, showToast, t])

      const addNode = React.useCallback(
        (type, extra, planeX, planeY) => {
          setDoc(prev => {
            if (type === 'start' && prev.nodes.some(node => node.type === 'start')) {
              showToast(t('errMultiStart'))
              return prev
            }
            const count = prev.nodes.length + 1
            // Default: near the middle of the currently visible area (zoom-aware).
            const viewport = viewportRef.current
            const rect = viewport ? viewport.getBoundingClientRect() : null
            const centerX = rect ? (rect.width / 2 - pan.x) / zoomRef.current : 380
            const centerY = rect ? (rect.height / 2 - pan.y) / zoomRef.current : 260
            const node = {
              id: uid('n'),
              type,
              label: `${typeLabel(t, type)}${count}`,
              description: '',
              prompt: '',
              agent: '',
              exec: 'subagent',
              hookKind: '',
              note: '',
              x: planeX != null ? planeX : Math.round(centerX + (Math.random() - 0.5) * 160),
              y: planeY != null ? planeY : Math.round(centerY + (Math.random() - 0.5) * 160),
              ...extra,
            }
            return { ...prev, nodes: prev.nodes.concat([node]) }
          })
        },
        [pan.x, pan.y, showToast, t],
      )

      const startPaletteDrag = (event, payload) => {
        if (!event || event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const startY = event.clientY
        setGhost({ ...payload, x: startX, y: startY })
        const onMove = moveEvent => {
          setGhost(state => (state ? { ...state, x: moveEvent.clientX, y: moveEvent.clientY } : state))
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setGhost(null)
          const viewport = viewportRef.current
          if (!viewport) return
          const rect = viewport.getBoundingClientRect()
          if (upEvent.clientX < rect.left || upEvent.clientX > rect.right || upEvent.clientY < rect.top || upEvent.clientY > rect.bottom) return
          const planeX = (upEvent.clientX - rect.left - pan.x) / zoomRef.current - NODE_W / 2
          const planeY = (upEvent.clientY - rect.top - pan.y) / zoomRef.current - NODE_H / 2
          addNode(payload.type, payload.extra, planeX, planeY)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const startNodeDrag = (event, node) => {
        if (!event || event.button !== 0) return
        // SPACE pans the canvas — even when pressing on a node.
        if (spaceHeld) return
        if (connectMode) return
        event.stopPropagation()
        // Multi-selection: dragging one node of the group moves the group.
        if (!multiIds.includes(node.id) && !tryChangeSelection(node.id)) return
        const dragIds = multiIds.includes(node.id) ? multiIds.slice() : [node.id]
        if (!multiIds.includes(node.id)) {
          setMultiIds([node.id])
          setSelectedId(node.id)
        }
        const origins = new Map(
          doc.nodes.filter(item => dragIds.includes(item.id)).map(item => [item.id, { x: item.x, y: item.y }]),
        )
        dragRef.current = { startX: event.clientX, startY: event.clientY, moved: false }
        const onMove = moveEvent => {
          const drag = dragRef.current
          if (!drag) return
          const dx = moveEvent.clientX - drag.startX
          const dy = moveEvent.clientY - drag.startY
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
          // 屏幕位移 ÷ zoom = 平面位移（缩放后拖动不漂移）。
          const wx = dx / zoomRef.current
          const wy = dy / zoomRef.current
          setDoc(prev => ({
            ...prev,
            nodes: prev.nodes.map(item => {
              const origin = origins.get(item.id)
              return origin ? { ...item, x: origin.x + wx, y: origin.y + wy } : item
            }),
          }))
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          const drag = dragRef.current
          dragRef.current = null
          if (drag && !drag.moved) onNodeClick(node.id)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      // Port-to-port linking: press a side port, drag a rubber band, release
      // on another node — the edge is created on drop (release on blank
      // canvas cancels).
      const startLinkDrag = (event, fromNode) => {
        if (!event || event.button !== 0) return
        // 强制：结束节点是终点，不能向外连线。
        if (fromNode.type === 'end') return
        event.stopPropagation()
        const viewport = viewportRef.current
        const rect = viewport ? viewport.getBoundingClientRect() : null
        const toPlane = (clientX, clientY) => ({
          cx: rect ? (clientX - rect.left - pan.x) / zoomRef.current : clientX,
          cy: rect ? (clientY - rect.top - pan.y) / zoomRef.current : clientY,
        })
        const start = toPlane(event.clientX, event.clientY)
        setLinkDrag({ fromId: fromNode.id, cx: start.cx, cy: start.cy })
        const onMove = moveEvent => {
          const point = toPlane(moveEvent.clientX, moveEvent.clientY)
          setLinkDrag(state => (state ? { ...state, cx: point.cx, cy: point.cy } : state))
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          let targetEl = null
          try {
            targetEl = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
          } catch {
            targetEl = null
          }
          const nodeEl = targetEl && targetEl.closest ? targetEl.closest('[data-node-id]') : null
          const toId = nodeEl ? nodeEl.getAttribute('data-node-id') : ''
          // Drop on another node: link directly — but never INTO the start
          // node (主会话是入口，不允许被连入)。
          if (toId && toId !== fromNode.id) {
            const target = doc.nodes.find(node => node.id === toId)
            if (target && target.type === 'start') return
            setLinkDrag(null)
            setDoc(prev => {
              if (prev.edges.some(edge => edge.from === fromNode.id && edge.to === toId)) return prev
              return { ...prev, edges: prev.edges.concat([{ id: uid('e'), from: fromNode.id, to: toId, label: '' }]) }
            })
            return
          }
          // Drop on the source node (or nowhere decidable): plain cancel.
          if (toId) {
            setLinkDrag(null)
            return
          }
          // Drop on blank space: offer to create a node right there,
          // auto-linked from the source. linkDrag is intentionally KEPT so
          // the rubber band stays anchored while the picker is open; it is
          // cleared when the picker closes (select, dismiss, or Esc).
          const point = toPlane(upEvent.clientX, upEvent.clientY)
          setLinkMenu({ screenX: upEvent.clientX, screenY: upEvent.clientY, x: point.cx, y: point.cy, fromId: fromNode.id })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      // Create a node at (planeX, planeY) — optionally auto-linked from a
      // source node (used by the blank-drop picker after a port drag).
      const createLinkedNode = (type, extra, anchorX, anchorY, fromId, reverse) => {
        const linked = Boolean(fromId)
        const node = {
          id: uid('n'),
          type,
          label: `${typeLabel(t, type)}${doc.nodes.length + 1}`,
          description: '',
          prompt: '',
          agent: '',
          exec: 'subagent',
          hookKind: '',
          note: '',
          // Anchor semantics: the LINKING PORT lands exactly on the anchor
          // (the rubber-band end), so the line meets the new node without a
          // jump. No link (right-click create): center the node on it.
          x: linked ? (reverse ? anchorX - NODE_W : anchorX) : anchorX - NODE_W / 2,
          y: anchorY - 32,
          ...extra,
        }
        setDoc(prev => {
          if (type === 'start' && prev.nodes.some(n => n.type === 'start')) return prev
          // reverse: the NEW node flows into the existing one (created from
          // an in-port double-click).
          const edges = fromId
            ? prev.edges.concat([
                {
                  id: uid('e'),
                  from: reverse ? node.id : fromId,
                  to: reverse ? fromId : node.id,
                  label: '',
                },
              ])
            : prev.edges
          return { ...prev, nodes: prev.nodes.concat([node]), edges }
        })
      }

      // Double-click a port: open the create-node picker at the cursor.
      const openPortPicker = (event, node, side) => {
        event.stopPropagation()
        setLinkMenu({
          screenX: event.clientX,
          screenY: event.clientY,
          x: side === 'out' ? node.x + NODE_W + 60 : node.x - NODE_W - 60,
          y: node.y,
          fromId: node.id,
          reverse: side === 'in',
        })
      }

      const onNodeClick = nodeId => {
        if (connectMode) {
          if (!connectSource) {
            // 强制：结束节点不能向外连线。
            const source = doc.nodes.find(node => node.id === nodeId)
            if (source && source.type === 'end') return
            setConnectSource(nodeId)
            return
          }
          if (connectSource === nodeId) {
            setConnectSource('')
            return
          }
          // 强制：主会话不能被连入。
          const target = doc.nodes.find(node => node.id === nodeId)
          if (target && target.type === 'start') {
            setConnectSource('')
            return
          }
          setDoc(prev => {
            const key = connectSource + '->' + nodeId
            if (prev.edges.some(edge => edge.from + '->' + edge.to === key)) return prev
            return { ...prev, edges: prev.edges.concat([{ id: uid('e'), from: connectSource, to: nodeId, label: '' }]) }
          })
          setConnectSource('')
          return
        }
        if (!tryChangeSelection(nodeId)) return
        setSpecMode(false)
        setMultiIds([nodeId])
        setSelectedId(nodeId)
      }

      const updateSelected = (field, value) => {
        setDoc(prev => ({
          ...prev,
          nodes: prev.nodes.map(node => (node.id === selectedId ? { ...node, [field]: value } : node)),
        }))
      }

      const deleteSelected = () => {
        const ids = multiIds.length > 0 ? multiIds.slice() : selectedId ? [selectedId] : []
        if (ids.length === 0) return
        setDoc(prev => ({
          ...prev,
          nodes: prev.nodes.filter(node => !ids.includes(node.id)),
          edges: prev.edges.filter(edge => !ids.includes(edge.from) && !ids.includes(edge.to)),
        }))
        setMultiIds([])
        setSelectedId('')
      }

      // Delete/Backspace removes the selected node(s) — but never while
      // typing in a field (name, prompt, edge labels…).
      React.useEffect(() => {
        if (multiIds.length === 0 && !selectedId) return undefined
        const onKeyDown = event => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') return
          const target = event.target
          const tag = target && target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          if (target && target.isContentEditable) return
          if (event.metaKey || event.ctrlKey || event.altKey) return
          event.preventDefault()
          deleteSelected()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [selectedId, multiIds])

      const deleteEdge = edgeId => {
        setDoc(prev => ({ ...prev, edges: prev.edges.filter(edge => edge.id !== edgeId) }))
      }

      // --- node context menu ----------------------------------------------
      const openNodeMenu = (event, nodeId) => {
        event.preventDefault()
        event.stopPropagation()
        if (!tryChangeSelection(nodeId)) return
        setSelectedId(nodeId)
        setMenu({ x: event.clientX, y: event.clientY, nodeId })
      }

      const closeMenu = React.useCallback(() => setMenu(null), [])

      React.useEffect(() => {
        if (!menu) return undefined
        const onDown = event => {
          const menuEl = menuRef.current
          if (menuEl && event.target instanceof Node && menuEl.contains(event.target)) return
          setMenu(null)
        }
        const onKey = event => {
          if (event.key === 'Escape') setMenu(null)
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [menu])

      React.useEffect(() => {
        if (!linkMenu) return undefined
        const dismiss = () => {
          setLinkMenu(null)
          // The rubber band stays while the picker is open; it disappears
          // together with the picker when nothing was created.
          setLinkDrag(null)
        }
        const onDown = event => {
          const el = linkMenuRef.current
          if (el && event.target instanceof Node && el.contains(event.target)) return
          dismiss()
        }
        const onKey = event => {
          if (event.key === 'Escape') dismiss()
        }
        window.addEventListener('pointerdown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
          window.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('keydown', onKey, true)
        }
      }, [linkMenu])

      const duplicateNode = nodeId => {
        setDoc(prev => {
          const source = prev.nodes.find(node => node.id === nodeId)
          if (!source || source.type === 'start') return prev
          const copy = { ...source, id: uid('n'), label: `${source.label} 副本`, x: source.x + 36, y: source.y + 36 }
          return { ...prev, nodes: prev.nodes.concat([copy]) }
        })
        setMenu(null)
      }

      const deleteNodeById = nodeId => {
        setDoc(prev => ({
          ...prev,
          nodes: prev.nodes.filter(node => node.id !== nodeId),
          edges: prev.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId),
        }))
        if (selectedId === nodeId) setSelectedId('')
        setMenu(null)
      }

      const updateEdge = (edgeId, field, value) => {
        setDoc(prev => ({
          ...prev,
          edges: prev.edges.map(edge => (edge.id === edgeId ? { ...edge, [field]: value } : edge)),
        }))
      }

      // --- 一键整理布局：从主会话分层（BFS 最长层），孤岛接在末尾，层内竖排 ----
      const autoLayout = () => {
        setDoc(prev => {
          if (prev.nodes.length === 0) return prev
          const ids = new Set(prev.nodes.map(node => node.id))
          const outs = new Map()
          const ins = new Map()
          for (const edge of prev.edges) {
            if (!ids.has(edge.from) || !ids.has(edge.to)) continue
            if (!outs.has(edge.from)) outs.set(edge.from, [])
            outs.get(edge.from).push(edge.to)
            if (!ins.has(edge.to)) ins.set(edge.to, [])
            ins.get(edge.to).push(edge.from)
          }
          const layer = new Map()
          const order = []
          let maxLayer = 0
          const visit = (rootId, baseLayer) => {
            if (layer.has(rootId)) return
            layer.set(rootId, baseLayer)
            maxLayer = Math.max(maxLayer, baseLayer)
            const queue = [rootId]
            while (queue.length > 0) {
              const id = queue.shift()
              order.push(id)
              for (const to of outs.get(id) || []) {
                if (layer.has(to)) continue
                layer.set(to, layer.get(id) + 1)
                maxLayer = Math.max(maxLayer, layer.get(to))
                queue.push(to)
              }
            }
          }
          const start = prev.nodes.find(node => node.type === 'start')
          if (start) visit(start.id, 0)
          // 孤岛：先把「没有未访问父节点」的节点当种子（层号顺延到最后层之后，
          // 避免和主流图重叠），剩下成环的从任意未访问节点强行起步。
          const hasUnvisitedParent = node => (ins.get(node.id) || []).some(id => !layer.has(id))
          for (;;) {
            const seed = prev.nodes.find(node => !layer.has(node.id) && !hasUnvisitedParent(node))
            if (seed) {
              visit(seed.id, start ? maxLayer + 2 : 0)
              continue
            }
            const rest = prev.nodes.find(node => !layer.has(node.id))
            if (rest) {
              visit(rest.id, start ? maxLayer + 2 : 0)
              continue
            }
            break
          }
          const GAP_X = NODE_W + 140
          const GAP_Y = NODE_H + 96
          const byLayer = new Map()
          for (const id of order) {
            const l = layer.get(id) || 0
            if (!byLayer.has(l)) byLayer.set(l, [])
            byLayer.get(l).push(id)
          }
          const pos = new Map()
          for (const [l, layerIds] of byLayer) {
            layerIds.forEach((id, i) => {
              pos.set(id, { x: 160 + l * GAP_X, y: 200 + i * GAP_Y })
            })
          }
          return { ...prev, nodes: prev.nodes.map(node => (pos.has(node.id) ? { ...node, ...pos.get(node.id) } : node)) }
        })
      }

      const doImport = () => {
        try {
          const parsed = normalizeDoc(JSON.parse(importText))
          if (!parsed) {
            setImportError(t('importError'))
            return
          }
          setDoc(parsed)
          savedSnapRef.current = JSON.stringify(parsed)
          setSelectedId('')
          setConnectSource('')
          setImportOpen(false)
        } catch {
          setImportError(t('importError'))
        }
      }

      const doExport = () => {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(JSON.stringify(doc, null, 2))
            showToast(t('exported'))
            return
          }
          showToast(t('exportFailed'))
        } catch {
          showToast(t('exportFailed'))
        }
      }

      const nodeById = id => doc.nodes.find(node => node.id === id)

      // 名称是必填项：当前选中节点名称为空时，禁止切换/取消选中——先补名称，或删掉这个节点。
      // 返回 false 表示选择被拦下，调用方应直接 return。
      const tryChangeSelection = nodeId => {
        const current = selectedId ? nodeById(selectedId) : null
        if (current && !String(current.label || '').trim() && nodeId !== selectedId) {
          showToast(t('labelRequiredLock'))
          return false
        }
        return true
      }
      const selected = doc.nodes.find(node => node.id === selectedId) || null

      // v2.5.2 B 方案名册：只列用户级 agent（出厂模式是会话模式，不进名册；用户拍板完全去掉）
      const userAgents = agents.filter(agent => agent.source !== 'system')
      const agentLabel = agent => (agent.name && agent.name !== agent.id ? `${agent.name} (${agent.id})` : agent.id)
      const agentOptions = userAgents.map(agent => ({
        value: agent.id,
        label: agent.scope === 'project' ? `${agentLabel(agent)}${t('scopeProjectShort')}` : agentLabel(agent),
      }))
      // 守卫：旧画布绑定了被过滤掉的 agent 时，下拉里仍要能看到当前值（selected 可能为 null，先判空）
      if (selected && selected.agent && !agentOptions.some(option => option.value === selected.agent)) {
        const hidden = agents.find(agent => agent.id === selected.agent)
        agentOptions.push({ value: selected.agent, label: hidden ? agentLabel(hidden) : selected.agent })
      }

      const paletteCards = ['start', 'work', 'router', 'end', 'hook'].map(type => ({
        key: 'type-' + type,
        type,
        title: typeLabel(t, type),
        desc: typeDesc(t, type),
        extra: {},
      }))

      const agentCard = agent => ({
        key: 'agent-' + agent.id,
        type: 'work',
        title: agent.name && agent.name !== agent.id ? agent.name : agent.id,
        desc: (agent.scope === 'project' ? t('scopeProject') : '') + (agent.description || agent.id),
        extra: { agent: agent.id, label: agent.name && agent.name !== agent.id ? agent.name : agent.id },
      })
      const userAgentCards = userAgents.map(agentCard)
      const renderAgentCard = card => {
        const rosterAgent = userAgents.find(entry => entry.id === card.extra.agent)
        return h(
          'div',
          {
            key: card.key,
            className: 'awbc-card',
            title: card.desc,
            style: { position: 'relative' },
            onPointerDown: event => startPaletteDrag(event, { type: card.type, extra: card.extra, title: card.title }),
            onClick: () => addNode(card.type, card.extra),
          },
          rosterAgent
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'awbc-card-edit',
                  title: t('agentEditBtn'),
                  onPointerDown: event => event.stopPropagation(),
                  onClick: event => {
                    event.stopPropagation()
                    openAgentEditor(rosterAgent)
                  },
                },
                '✎',
              )
            : null,
          rosterAgent
            ? h(
                'span',
                {
                  key: 'scope',
                  className: 'awbc-tile work',
                  title: rosterAgent.scope === 'project' ? t('agentScopeProject') : t('agentScopeUser'),
                  'aria-hidden': true,
                },
                h('span', { className: `awbc-scope-badge ${rosterAgent.scope === 'project' ? 'project' : 'user'}` }, rosterAgent.scope === 'project' ? 'P' : 'U'),
              )
            : h('span', { className: 'awbc-tile work', 'aria-hidden': true }, NODE_TYPES.work.glyph),
          h(
            'div',
            { className: 'awbc-card-main' },
            h('div', { className: 'awbc-card-title' }, card.title),
            h('div', { className: 'awbc-card-desc' }, card.desc),
          ),
        )
      }

      const edgesLayer = h(
        'svg',
        { className: 'awbc-edge-layer', width: PLANE_W, height: PLANE_H },
        h(
          'defs',
          { key: 'defs' },
          ['awbc-arrow', 'awbc-arrow-hot', 'awbc-arrow-yes', 'awbc-arrow-no'].map(id =>
            h(
              'marker',
              { key: id, id, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'strokeWidth' },
              h('path', { className: 'awbc-edge-arrow' + (id === 'awbc-arrow-hot' ? ' hot' : id === 'awbc-arrow-yes' ? ' yes' : id === 'awbc-arrow-no' ? ' no' : ''), d: 'M0,0 L8,4 L0,8 Z' }),
            ),
          ),
        ),
        doc.edges.map(edge => {
          const from = nodeById(edge.from)
          const to = nodeById(edge.to)
          if (!from || !to) return null
          const geo = edgeGeometry(from, to)
          const hot = selectedId === edge.from || selectedId === edge.to
          const kind = edge.label === '是' ? ' yes' : edge.label === '否' ? ' no' : ''
          return h('g', { key: edge.id },
            h('path', {
              className: 'awbc-edge' + kind + (hot ? ' hot' : ''),
              d: geo.d,
              markerEnd: 'url(#' + (kind ? 'awbc-arrow-' + kind.trim() : hot ? 'awbc-arrow-hot' : 'awbc-arrow') + ')',
            }),
            edge.label
              ? h('text', { className: 'awbc-edge-label' + kind, x: geo.mx, y: geo.my - 5, textAnchor: 'middle' }, edge.label)
              : null,
          )
        }),
        linkDrag
          ? (() => {
              const from = nodeById(linkDrag.fromId)
              if (!from) return null
              const x1 = from.x + NODE_W
              const y1 = from.y + NODE_H / 2
              const dx = Math.max(40, Math.abs(linkDrag.cx - x1) / 2)
              return h('path', {
                key: 'link-live',
                className: 'awbc-link-live',
                d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${linkDrag.cx - dx} ${linkDrag.cy}, ${linkDrag.cx} ${linkDrag.cy}`,
              })
            })()
          : null,
      )

      const nodesLayer = doc.nodes.map(node => {
        const lane = node.type === 'work' ? pickLane(lanes, node.label) : null
        // canvas_report 上报的状态优先（覆盖主会话自己执行与判断/结束节点），投影 lane 兜底。
        const reported = runtimeStatus[node.label]
        const status = reported
          ? reported.status === 'done'
            ? 'done'
            : reported.status === 'error'
              ? 'error'
              : 'running'
          : !lane
            ? ''
            : lane.status === 'done'
              ? 'done'
              : lane.status === 'error'
                ? 'error'
                : 'running'
        const statusText = !status
          ? ''
          : status === 'done'
            ? t('statusDone')
            : status === 'error'
              ? t('statusError') + (reported && reported.note ? `（${reported.note}）` : '')
              : t('statusRunning')
        return h(
          'div',
          {
            key: node.id,
            'data-node-id': node.id,
            className: `awbc-node${multiIds.includes(node.id) ? ' selected' : ''}${connectSource === node.id ? ' connect-src' : ''}`,
            style: { left: node.x, top: node.y },
            title: nodeSubText(node, t),
            onPointerDown: event => startNodeDrag(event, node),
            onContextMenu: event => openNodeMenu(event, node.id),
          },
          // 强制：主会话是入口 — no incoming port rendered at all.
          node.type === 'start'
            ? null
            : h('span', {
                className: 'awbc-port in',
                title: '←',
                onPointerDown: event => startLinkDrag(event, node),
                onDoubleClick: event => openPortPicker(event, node, 'in'),
              }),
          h('div', { className: `awbc-tile ${node.type}`, 'aria-hidden': true }, NODE_TYPES[node.type].glyph),
          h(
            'div',
            { className: 'awbc-node-main' },
            h(
              'div',
              { className: 'awbc-node-titlerow' },
              h('span', { className: 'awbc-node-title' }, node.label || node.id),
              statusText ? h('span', { className: 'awbc-dot ' + status, title: statusText }) : null,
            ),
            nodeSubText(node, t) ? h('div', { className: 'awbc-node-sub' }, nodeSubText(node, t)) : null,
            node.type === 'hook' ? h('div', { className: 'awbc-node-badge' }, t('hookPreviewBadge')) : null,
          ),
          // 强制：结束节点是终点 — no outgoing port rendered at all.
          node.type === 'end'
            ? null
            : h('span', {
                className: 'awbc-port out',
                title: '→',
                onPointerDown: event => startLinkDrag(event, node),
                onDoubleClick: event => openPortPicker(event, node, 'out'),
              }),
        )
      })

      const edgeRows = selected
        ? doc.edges
            .filter(edge => edge.from === selected.id)
            .map(edge => {
              const to = nodeById(edge.to)
              const toName = to ? to.label : edge.to
              const kind = edge.label === '是' ? 'yes' : edge.label === '否' ? 'no' : branchCustomRef.current[edge.id] || edge.label ? 'custom' : ''
              const kindColor = kind === 'yes' ? '#34c77b' : kind === 'no' ? '#e5534b' : undefined
              const setBranch = value => {
                if (value === 'custom') branchCustomRef.current[edge.id] = true
                else delete branchCustomRef.current[edge.id]
                updateEdge(edge.id, 'label', value === 'yes' ? '是' : value === 'no' ? '否' : '')
              }
              return h(
                'div',
                { className: 'awbc-edge-row', key: edge.id },
                h(
                  'div',
                  { className: 'awbc-edge-line' },
                  h('span', { className: 'awbc-edge-text', title: toName, style: kindColor ? { color: kindColor } : undefined }, `→ ${toName}`),
                  h('button', { type: 'button', className: 'awbc-mini', title: '✕', onClick: () => deleteEdge(edge.id) }, '✕'),
                ),
                selected.type === 'router'
                  ? h(
                      'select',
                      { className: 'awbc-input', value: kind, onChange: event => setBranch(event.target.value) },
                      h('option', { value: '' }, t('edgeLabelField')),
                      h('option', { value: 'yes' }, t('branchYes')),
                      h('option', { value: 'no' }, t('branchNo')),
                      h('option', { value: 'custom' }, t('branchCustom')),
                    )
                  : h('input', {
                      className: 'awbc-input',
                      value: edge.label,
                      placeholder: t('edgeLabelField'),
                      onChange: event => updateEdge(edge.id, 'label', event.target.value),
                    }),
                selected.type === 'router' && kind === 'custom'
                  ? h('input', {
                      className: 'awbc-input',
                      value: edge.label,
                      placeholder: t('edgeLabelField'),
                      autoFocus: true,
                      onChange: event => updateEdge(edge.id, 'label', event.target.value),
                    })
                  : null,
              )
            })
        : []

      const editorBody = !selected
        ? h(
            'div',
            { key: 'body-hint' },
            multiIds.length > 1
              ? h('span', { className: 'awbc-hint' }, `已选 ${multiIds.length} 个节点 · Delete 批量删除`)
              : h('span', { className: 'awbc-hint' }, t('selectNodeHint')),
            h(
              'div',
              { className: 'awbc-field', style: { marginTop: 14 }, onPointerDown: event => event.stopPropagation() },
              h('label', { className: 'awbc-label' }, t('fieldProjectDir')),
              h('input', {
                className: 'awbc-input',
                placeholder: t('projectDirPh'),
                value: doc.projectDir || '',
                onChange: event => setDoc(prev => ({ ...prev, projectDir: event.target.value.slice(0, 4096) })),
              }),
            ),
            h('div', { className: 'awbc-hint', style: { marginTop: 4 } }, t('projectDirHint')),
          )
        : h(
            'div',
            { key: 'body-props', style: { display: 'flex', flexDirection: 'column', gap: 9 }, onPointerDown: event => event.stopPropagation() },
            h(
              'div',
              { className: 'awbc-field' },
              h('label', { className: 'awbc-label' }, t('fieldLabel'), h('span', { className: 'awbc-req', 'aria-hidden': 'true' }, ' *')),
              h('input', { className: 'awbc-input' + (String(selected.label || '').trim() ? '' : ' invalid'), value: selected.label, onChange: event => updateSelected('label', event.target.value) }),
            ),
            selected.type === 'start' || selected.type === 'end'
              ? h(
                  'div',
                  { className: 'awbc-field', key: 'desc' },
                  h('label', { className: 'awbc-label' }, t('fieldDesc')),
                  h('textarea', { className: 'awbc-input awbc-textarea', value: selected.description, onChange: event => updateSelected('description', event.target.value) }),
                )
              : null,
            selected.type === 'work'
              ? [
                  h(
                    'div',
                    { className: 'awbc-field', key: 'exec' },
                    h('label', { className: 'awbc-label' }, t('fieldExec')),
                    h(Dropdown, {
                      value: selected.exec,
                      options: [
                        { value: 'subagent', label: t('execSubagent') },
                        { value: 'lead', label: t('execLead') },
                      ],
                      onChange: next => updateSelected('exec', next),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'awbc-field', key: 'agent' },
                    h('label', { className: 'awbc-label' }, t('fieldAgent')),
                    h(Dropdown, {
                      value: selected.agent,
                      options: [{ value: '', label: t('agentLead') }].concat(agentOptions),
                      onChange: next => updateSelected('agent', next),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'awbc-field', key: 'prompt' },
                    h('label', { className: 'awbc-label' }, t('fieldPrompt')),
                    h('textarea', { className: 'awbc-input awbc-textarea', value: selected.prompt, onChange: event => updateSelected('prompt', event.target.value) }),
                  ),
                ]
              : null,
            selected.type === 'router'
              ? [
                  h(
                    'div',
                    { className: 'awbc-field', key: 'desc' },
                    h('label', { className: 'awbc-label' }, t('fieldRouterDesc')),
                    h('textarea', { className: 'awbc-input awbc-textarea', value: selected.description, onChange: event => updateSelected('description', event.target.value) }),
                  ),
                  h('div', { className: 'awbc-hint', key: 'hint' }, t('routerHint')),
                ]
              : null,
            selected.type === 'hook'
              ? [
                  h(
                    'div',
                    { className: 'awbc-field', key: 'kind' },
                    h('label', { className: 'awbc-label' }, t('fieldHookKind')),
                    h(Dropdown, {
                      value: selected.hookKind,
                      options: [{ value: '', label: '—' }].concat(HOOK_KINDS.map(kind => ({ value: kind.value, label: t(kind.labelKey) }))),
                      onChange: next => updateSelected('hookKind', next),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'awbc-field', key: 'note' },
                    h('label', { className: 'awbc-label' }, t('fieldHookNote')),
                    h('textarea', { className: 'awbc-input awbc-textarea', value: selected.note, onChange: event => updateSelected('note', event.target.value) }),
                  ),
                  h('div', { className: 'awbc-warnbadge', key: 'badge' }, t('hookPreviewBadge')),
                ]
              : null,
            h(
              'div',
              { className: 'awbc-field', key: 'edges' },
              h('label', { className: 'awbc-label' }, `${t('edgesLabel')} (${edgeRows.length})`),
              edgeRows.length > 0 ? edgeRows : h('span', { className: 'awbc-hint' }, t('selectNodeHint')),
            ),
            h('button', { type: 'button', className: 'awbc-btn danger', onClick: deleteSelected }, t('deleteNode')),
          )

      // 规范视图（specMode 时顶替右栏属性面板，不常驻）：标题行 + 复制 + 编译原文。
      const specPanel = h(
        'div',
        { className: 'awbc-spec', key: 'spec-panel' },
        h(
          'div',
          { className: 'awbc-spec-head' },
          h('span', { className: 'awbc-speclabel' }, t('specTitle')),
          h('button', {
            type: 'button',
            className: 'awbc-btn',
            style: { marginLeft: 'auto' },
            title: t('specCopy'),
            disabled: specState !== 'ready' || !specText,
            onClick: copySpec,
          }, specCopied ? '✓ ' + t('specCopied') : '⧉ ' + t('specCopy')),
        ),
        specState === 'error'
          ? h('div', { className: 'awbc-error' }, t('specLoadFailed'))
          : specState === 'ready' && !specText
            ? h('div', { className: 'awbc-hint' }, t('specEmpty'))
            : h('pre', { className: 'awbc-specpre' }, specState === 'loading' ? '…' : specText),
        h('div', { className: 'awbc-speclabel' }, t('specHint')),
      )
      const editorPanel = h(
        'div',
        { className: 'awbc-editor', style: { flexBasis: editorW + 'px' } },
        specMode ? specPanel : editorBody,
      )

      // v2.7.0 启动开关：看哪张图开哪张图。开启前三步串行——补 id（新画布）→ 落盘 → 绑定（宿主对活会话即时挂规范）。
      const toggleRun = () => {
        if (!sessionId) return
        if (binding === doc.id && doc.id) {
          setSessionBinding('')
          return
        }
        const targetId = doc.id || uid('c')
        const base = targetId === doc.id ? doc : { ...doc, id: targetId }
        Promise.resolve(persistDoc(base, { silent: true }))
          .then(ok => {
            if (ok === false) {
              showToast(t('loadFailed'))
              return
            }
            setDoc(prev => ({ ...prev, id: targetId }))
            setSessionBinding(targetId)
          })
          .catch(() => showToast(t('loadFailed')))
      }

      // v2.8.0 角色编辑：画布内直接新建/编辑/删除角色 .md（宿主 agentGet/agentPut/agentDelete）。
      const currentProjectDir = () => (doc && typeof doc.projectDir === 'string' ? doc.projectDir : '')
      const openAgentEditor = agent => {
        if (!agent) {
          setAgentEditor({ isNew: true, id: '', name: '', description: '', prompt: '', scope: 'user', busy: false })
          return
        }
        setAgentEditor({
          isNew: false,
          id: agent.id,
          name: agent.name && agent.name !== agent.id ? agent.name : '',
          description: agent.description || '',
          prompt: '',
          scope: agent.scope === 'project' ? 'project' : 'user',
          busy: true,
        })
        apiCall({ action: 'agentGet', id: agent.id, projectDir: currentProjectDir() })
          .then(data => {
            const full = data && data.agent
            setAgentEditor(prev =>
              prev && prev.id === agent.id
                ? { ...prev, name: (full && full.name && full.name !== full.id) || prev.name, description: (full && full.description) || prev.description, prompt: (full && full.prompt) || '', busy: false }
                : prev,
            )
          })
          .catch(() => {
            setAgentEditor(prev => (prev ? { ...prev, busy: false } : prev))
            showToast(t('agentLoadFailed'))
          })
      }
      const saveAgentEditor = () => {
        const draft = agentEditor
        if (!draft || draft.busy) return
        const id = draft.id.trim()
        const prompt = draft.prompt.trim()
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || !prompt) {
          showToast(t('agentInvalid'))
          return
        }
        apiCall({
          action: 'agentPut',
          id,
          name: draft.name.trim() || id,
          description: draft.description.trim(),
          prompt,
          scope: draft.scope,
          projectDir: currentProjectDir(),
        })
          .then(() => {
            setAgentEditor(null)
            refreshAgents(currentProjectDir())
            showToast(t('agentSavedToast'))
          })
          .catch(() => showToast(t('loadFailed')))
      }
      const deleteAgentEditor = () => {
        const draft = agentEditor
        if (!draft || draft.isNew || draft.busy) return
        if (!window.confirm(t('agentDeleteConfirm'))) return
        apiCall({ action: 'agentDelete', id: draft.id, scope: draft.scope, projectDir: currentProjectDir() })
          .then(() => {
            setAgentEditor(null)
            refreshAgents(currentProjectDir())
            showToast(t('agentDelToast'))
          })
          .catch(() => showToast(t('loadFailed')))
      }

      const palette = h(
        'div',
        { className: 'awbc-palette' + (palOpen ? '' : ' collapsed'), style: palOpen ? { flexBasis: paletteW + 'px' } : undefined },
        h(
          'div',
          { className: 'awbc-pal-head' },
          h('span', { className: 'awbc-pal-title' }, t('palTitle')),
          palOpen ? h('span', { className: 'awbc-pal-sub' }, t('palSub')) : null,
          h('button', { type: 'button', className: 'awbc-pal-collapse', title: palOpen ? '«' : '»', onClick: () => setPalOpen(value => !value) }, palOpen ? '«' : '»'),
        ),
        h(
          'div',
          { className: 'awbc-pal-scroll' },
          h('div', { className: 'awbc-sec' }, t('secElements')),
          paletteCards.map(card =>
            h(
              'div',
              {
                key: card.key,
                className: 'awbc-card',
                title: card.desc,
                onPointerDown: event => startPaletteDrag(event, { type: card.type, extra: card.extra, title: card.title }),
                onClick: () => addNode(card.type, card.extra),
              },
              h('span', { className: `awbc-tile ${card.type}`, 'aria-hidden': true }, NODE_TYPES[card.type].glyph),
              h(
                'div',
                { className: 'awbc-card-main' },
                h('div', { className: 'awbc-card-title' }, card.title),
                h('div', { className: 'awbc-card-desc' }, card.desc),
              ),
            ),
          ),
          h('div', { className: 'awbc-sec' }, t('secAgentsMine')),
          agentsState === 'loading' ? h('div', { className: 'awbc-hint' }, t('agentsLoading')) : null,
          agentsState.indexOf('failed') === 0
            ? h('div', { className: 'awbc-hint' }, t('agentsFailed') + (agentsState.length > 7 ? `（${agentsState.slice(8)}）` : ''))
            : null,
          agentsState === 'ready' && agents.length === 0 ? h('div', { className: 'awbc-hint' }, t('agentsEmpty')) : null,
          userAgentCards.map(renderAgentCard),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignSelf: 'flex-start' } },
            h('button', { type: 'button', className: 'awbc-btn primary', onClick: () => openAgentEditor(null) }, t('agentNew')),
            h('button', { type: 'button', className: 'awbc-btn', onClick: () => refreshAgents(currentProjectDir()) }, t('refresh')),
          ),
          h('div', { className: 'awbc-sec' }, t('secDocs')),
          docsList.length === 0 ? h('div', { className: 'awbc-hint' }, t('docsEmpty')) : null,
          docsList.map(entry =>
            h(
              'div',
              {
                key: entry.id,
                className: 'awbc-card',
                title: entry.name || t('docUnnamed'),
                onClick: () => openDoc(entry.id),
                style: entry.id === doc.id ? { background: 'var(--dsw-alias-bg-layer-2)' } : undefined,
              },
              h('span', { className: 'awbc-tile', 'aria-hidden': true, style: { background: 'var(--dsw-alias-label-tertiary)' } }, '▤'),
              h(
                'div',
                { className: 'awbc-card-main' },
                h('div', { className: 'awbc-card-title' }, entry.name || t('docUnnamed')),
                h('div', { className: 'awbc-card-desc' }, shortTime(entry.updatedAt)),
              ),
            ),
          ),
        ),
      )

      const issueCount = issues ? issues.length : 0
      const toolbar = [
        h('span', { className: 'awbc-brand', key: 'brand', 'aria-hidden': true }, '⌗'),
        h('input', {
          key: 'name',
          className: 'awbc-name',
          value: doc.name,
          placeholder: t('docUnnamed'),
          onChange: event => setDoc(prev => ({ ...prev, name: event.target.value })),
        }),
        h('span', { key: 'badge', className: 'awbc-badge' + (dirty ? (saveState === 'error' ? ' error' : '') : ' ok') },
          h('span', { className: 'awbc-badge-dot' }),
          dirty ? (saveState === 'error' ? t('saveFailed') : errorCount > 0 ? t('unsavedBadge') : t('savingBadge')) : t('savedBadge'),
        ),
        h('span', { key: 'spacer', className: 'awbc-spacer' }),
        h('button', { type: 'button', key: 'undo', className: 'awbc-btn', title: 'Ctrl/Cmd+Z', disabled: !canUndo, onClick: undo }, '↶ ' + t('undo')),
        h('button', { type: 'button', key: 'redo', className: 'awbc-btn', title: 'Ctrl/Cmd+Shift+Z', disabled: !canRedo, onClick: redo }, '↷ ' + t('redo')),
        h('button', { type: 'button', key: 'layout', className: 'awbc-btn', title: t('layoutBtn'), disabled: doc.nodes.length === 0, onClick: autoLayout }, '⊞ ' + t('layoutBtn')),
        sessionId
          ? [
              h(
                'div',
                {
                  key: 'runswitch',
                  className: 'awbc-runswitch' + (binding === doc.id && doc.id ? ' on' : ''),
                  title: t('switchTitle'),
                  onClick: toggleRun,
                },
                h('span', { className: 'awbc-runswitch-track', 'aria-hidden': true }, h('span', { className: 'awbc-runswitch-knob' })),
                h('span', { className: 'awbc-runswitch-label' },
                  `${binding === doc.id && doc.id ? t('switchOnLabel') : t('switchOffLabel')}：${doc.name || t('docUnnamed')}`),
              ),
            ]
          : null,
        issues
          ? h('span', { key: 'chip', className: 'awbc-chip ' + (issueCount > 0 ? 'error' : 'ok') },
              issueCount > 0 ? '⚠ ' + t('issuesChip')(issueCount) : '✓ ' + t('validationOk'))
          : null,
        h('button', { type: 'button', key: 'validate', className: 'awbc-btn', onClick: () => setIssues(validateDoc(doc, t)) }, t('validateBtn')),
        h('button', {
          type: 'button',
          key: 'spec',
          className: 'awbc-btn primary' + (specMode ? ' active' : ''),
          title: t('specTitle'),
          onClick: () => setSpecMode(value => !value),
        }, '≣ ' + t('specBtn')),
        h('button', { type: 'button', key: 'import', className: 'awbc-btn', onClick: () => { setImportText(''); setImportError(''); setImportOpen(true) } }, t('importBtn')),
        h('button', { type: 'button', key: 'export', className: 'awbc-btn', onClick: doExport }, t('exportBtn')),
        h('button', {
          type: 'button',
          key: 'new',
          className: 'awbc-btn',
          onClick: () => {
            const empty = emptyDoc()
            setDoc(empty)
            savedSnapRef.current = JSON.stringify(empty)
            setSelectedId('')
            setIssues(null)
          },
        }, t('newCanvas')),
        h('button', { type: 'button', key: 'del', className: 'awbc-btn danger', disabled: !doc.id, onClick: deleteDoc }, t('del')),
        h('button', { type: 'button', key: 'save', className: 'awbc-btn primary', disabled: !dirty, onClick: saveDoc }, t('save')),
        h('button', {
          type: 'button',
          key: 'connect',
          className: 'awbc-btn primary' + (connectMode ? ' active' : ''),
          onClick: () => {
            setConnectMode(value => !value)
            setConnectSource('')
          },
        }, connectMode ? `✓ ${t('connectFinish')}` : `${t('connect')} ⤳`),
      ]

      return h(
        'div',
        { className: 'awbc', 'data-agent-canvas-view': 'true' },
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'awbc-toolbar' }, toolbar),
        h(
          'div',
          { className: 'awbc-body' },
          palette,
          palOpen ? h('div', { className: 'awbc-resizer' + (resizing === 'palette' ? ' active' : ''), key: 'pal-resizer', title: '拖动调整宽度', onPointerDown: startPanelResize('palette', paletteW) }) : null,
          h(
            'div',
            { className: 'awbc-stage' },
            h(
              'div',
              {
                className: 'awbc-viewport' + (spaceHeld ? ' space' : ''),
                ref: viewportRef,
                style: { backgroundPosition: pan.x + 'px ' + pan.y + 'px', backgroundSize: 22 * zoom + 'px ' + 22 * zoom + 'px' },
                // Right-click on blank canvas: the create-node picker at the
                // cursor (no auto-link). Node right-clicks stop propagation,
                // so their own menu wins.
                onContextMenu: event => {
                  event.preventDefault()
                  const viewport = viewportRef.current
                  const rect = viewport ? viewport.getBoundingClientRect() : null
                  setLinkMenu({
                    screenX: event.clientX,
                    screenY: event.clientY,
                    x: rect ? (event.clientX - rect.left - pan.x) / zoomRef.current : event.clientX,
                    y: rect ? (event.clientY - rect.top - pan.y) / zoomRef.current : event.clientY,
                    fromId: null,
                  })
                },
                // The viewport is the full-size hit area:
                //   SPACE held  → drag pans the stage (grab anywhere).
                //   no SPACE    → drag on blank space draws a selection
                //                  marquee; a plain click clears selection.
                // Nodes stop propagation on their own pointerdown, so node
                // drags neither pan nor marquee.
                onPointerDown: event => {
                  if (event.button !== 0) return
                  if (spaceHeld) {
                    const el = event.currentTarget
                    const startX = event.clientX
                    const startY = event.clientY
                    const startPan = { ...pan }
                    el.classList.add('panning')
                    const onMove = moveEvent => {
                      setPan({ x: startPan.x + (moveEvent.clientX - startX), y: startPan.y + (moveEvent.clientY - startY) })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                      el.classList.remove('panning')
                    }
                    window.addEventListener('pointermove', onMove)
                    window.addEventListener('pointerup', onUp)
                    return
                  }
                  if (connectMode) {
                    if (!tryChangeSelection('')) return
                    setSelectedId('')
                    setMultiIds([])
                    return
                  }
                  // Marquee selection.
                  if (!tryChangeSelection('')) return
                  const viewport = viewportRef.current
                  const rect = viewport ? viewport.getBoundingClientRect() : null
                  const toPlane = (clientX, clientY) => ({
                    x: rect ? (clientX - rect.left - pan.x) / zoomRef.current : clientX,
                    y: rect ? (clientY - rect.top - pan.y) / zoomRef.current : clientY,
                  })
                  const start = toPlane(event.clientX, event.clientY)
                  setSelectedId('')
                  setMultiIds([])
                  setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y, box: { x0: start.x, y0: start.y, x1: start.x, y1: start.y } })
                  const onMove = moveEvent => {
                    const point = toPlane(moveEvent.clientX, moveEvent.clientY)
                    setMarquee(state => {
                      if (!state) return state
                      return {
                        ...state,
                        x1: point.x,
                        y1: point.y,
                        box: {
                          x0: Math.min(state.x0, point.x),
                          y0: Math.min(state.y0, point.y),
                          x1: Math.max(state.x0, point.x),
                          y1: Math.max(state.y0, point.y),
                        },
                      }
                    })
                  }
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                    setMarquee(null)
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                },
              },
              h('div', {
                className: 'awbc-plane',
                style: { transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')' },
              },
                edgesLayer,
                nodesLayer,
                // 框选矩形用平面坐标 — 必须渲染在平面内，跟随画布位移。
                marquee && marquee.box
                  ? h('div', {
                      key: 'marquee',
                      className: 'awbc-marquee',
                      style: {
                        left: marquee.box.x0,
                        top: marquee.box.y0,
                        width: marquee.box.x1 - marquee.box.x0,
                        height: marquee.box.y1 - marquee.box.y0,
                      },
                    })
                  : null,
              ),
              h(
                'div',
                { className: 'awbc-zoom', key: 'zoomctl' },
                h('button', { type: 'button', title: t('zoomOut'), onClick: () => zoomStep(1 / 1.2) }, '−'),
                h('button', { type: 'button', title: t('zoomReset'), onClick: zoomReset, style: { minWidth: 40 } }, Math.round(zoom * 100) + '%'),
                h('button', { type: 'button', title: t('zoomIn'), onClick: () => zoomStep(1.2) }, '+'),
                h('button', { type: 'button', title: t('zoomFit'), onClick: fitView }, `⛶ ${t('zoomFitShort')}`),
              ),
              doc.nodes.length === 0 ? h('div', { className: 'awbc-empty', key: 'empty' }, h('div', { className: 'awbc-empty-inner' }, t('palSub'))) : null,
              connectMode && connectSource ? h('div', { className: 'awbc-empty', key: 'connect-hint' }, h('div', { className: 'awbc-empty-inner' }, `${t('connecting')}: ${t('connectFinish')} → ${(nodeById(connectSource) || {}).label || ''}`)) : null,
              issues && issueCount > 0
                ? h(
                    'div',
                    { className: 'awbc-issues', key: 'issues' },
                    issues.map((issue, index) => h('span', { key: index, className: 'awbc-issue ' + issue.level }, (issue.level === 'error' ? '✕ ' : '⚠ ') + issue.text)),
                  )
                : null,
              toast ? h('div', { className: 'awbc-toast', key: 'toast' }, toast) : null,
            ),
            h(
              'div',
              { className: 'awbc-status' },
              h('span', { key: 'count' }, `${doc.nodes.length} ${t('typeWork')} · ${agents.length} agent`),
              h('span', { key: 'spacer', className: 'awbc-spacer' }),
              h('span', { key: 'legend-normal', className: 'awbc-legend' }, h('span', { className: 'awbc-swatch' }), t('legendNormal')),
            ),
          ),
          h('div', { className: 'awbc-resizer' + (resizing === 'editor' ? ' active' : ''), key: 'editor-resizer', title: '拖动调整宽度', onPointerDown: startPanelResize('editor', editorW) }),
          editorPanel,
        ),
        ghost
          ? h(
              'div',
              { className: 'awbc-ghost', key: 'ghost', style: { left: ghost.x + 10, top: ghost.y + 10 } },
              h('span', { className: `awbc-tile ${ghost.type}`, 'aria-hidden': true }, NODE_TYPES[ghost.type].glyph),
              ghost.title,
            )
          : null,
        menu
          ? (() => {
              const menuNode = nodeById(menu.nodeId)
              if (!menuNode) return null
              const menuWidth = 160
              const left = Math.min(menu.x, window.innerWidth - menuWidth - 8)
              const top = Math.min(menu.y, window.innerHeight - 190)
              return h(
                'div',
                {
                  className: 'awbc-menu',
                  ref: menuRef,
                  key: 'menu',
                  style: { left, top },
                  onContextMenu: event => event.preventDefault(),
                  onPointerDown: event => event.stopPropagation(),
                },
                menuNode.type === 'start'
                  ? null
                  : h('button', { type: 'button', className: 'awbc-menu-item', onClick: () => duplicateNode(menu.nodeId) }, '⧉ ' + t('menuDuplicate')),
                h('button', { type: 'button', className: 'awbc-menu-item danger', onClick: () => deleteNodeById(menu.nodeId) }, '✕ ' + t('menuDelete')),
              )
            })()
          : null,
        linkMenu
          ? (() => {
              const pickerWidth = 150
              const left = Math.min(linkMenu.screenX, window.innerWidth - pickerWidth - 8)
              const top = Math.min(linkMenu.screenY, window.innerHeight - 200)
              return h(
                'div',
                {
                  className: 'awbc-menu',
                  ref: linkMenuRef,
                  key: 'link-menu',
                  style: { left, top },
                  onContextMenu: event => event.preventDefault(),
                  onPointerDown: event => event.stopPropagation(),
                },
                h('div', { className: 'awbc-sec', style: { margin: '2px 6px 6px' } }, t('pickerTitle')),
                (doc.nodes.some(node => node.type === 'start') ? [] : ['start'])
                  .concat(['work', 'router', 'end', 'hook'])
                  .map(type =>
                  h(
                    'button',
                    {
                      type: 'button',
                      key: type,
                      className: 'awbc-menu-item',
                      onClick: () => {
                        createLinkedNode(type, {}, linkMenu.x, linkMenu.y, linkMenu.fromId, linkMenu.reverse)
                        setLinkMenu(null)
                        setLinkDrag(null)
                      },
                    },
                    h('span', { className: `awbc-tile ${type}`, 'aria-hidden': true, style: { width: 18, height: 18, fontSize: 9 } }, NODE_TYPES[type].glyph),
                    typeLabel(t, type),
                  ),
                ),
              )
            })()
          : null,
        importOpen
          ? h(
              'div',
              { className: 'awbc-overlay', key: 'import', onPointerDown: event => event.stopPropagation() },
              h(
                'div',
                { className: 'awbc-dialog' },
                h('div', { className: 'awbc-dialog-title' }, t('importTitle')),
                h('textarea', {
                  className: 'awbc-input awbc-textarea',
                  placeholder: t('importPlaceholder'),
                  value: importText,
                  onChange: event => setImportText(event.target.value),
                }),
                importError ? h('div', { className: 'awbc-error' }, importError) : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  h('button', { type: 'button', className: 'awbc-btn', onClick: () => setImportOpen(false) }, t('close')),
                  h('button', { type: 'button', className: 'awbc-btn primary', onClick: doImport }, t('importConfirm')),
                ),
              ),
            )
          : null,
        agentEditor
          ? h(
              'div',
              { className: 'awbc-overlay', key: 'agent-editor', onPointerDown: event => event.stopPropagation() },
              h(
                'div',
                { className: 'awbc-dialog awbc-agent-dialog' },
                h('div', { className: 'awbc-dialog-title' }, agentEditor.isNew ? t('agentDialogTitleNew') : t('agentDialogTitleEdit')),
                agentEditor.busy ? h('div', { className: 'awbc-hint' }, t('agentsLoading')) : null,
                h(
                  'div',
                  { className: 'awbc-field' },
                  h('label', null, t('agentIdLabel')),
                  h('input', {
                    className: 'awbc-input',
                    value: agentEditor.id,
                    disabled: !agentEditor.isNew,
                    placeholder: 'project-manager',
                    onChange: event => setAgentEditor(prev => ({ ...prev, id: event.target.value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'awbc-field' },
                  h('label', null, t('agentNameLabel')),
                  h('input', {
                    className: 'awbc-input',
                    value: agentEditor.name,
                    placeholder: '项目经理',
                    onChange: event => setAgentEditor(prev => ({ ...prev, name: event.target.value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'awbc-field' },
                  h('label', null, t('agentDescLabel')),
                  h('input', {
                    className: 'awbc-input',
                    value: agentEditor.description,
                    onChange: event => setAgentEditor(prev => ({ ...prev, description: event.target.value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'awbc-field' },
                  h('label', null, t('agentScopeLabel')),
                  h(Dropdown, {
                    value: agentEditor.scope,
                    options: [
                      { value: 'user', label: t('agentScopeUser') },
                      ...(currentProjectDir() ? [{ value: 'project', label: t('agentScopeProject') }] : []),
                    ],
                    onChange: value => setAgentEditor(prev => ({ ...prev, scope: value })),
                  }),
                ),
                h(
                  'div',
                  { className: 'awbc-field' },
                  h('label', null, t('agentPromptLabel')),
                  h('textarea', {
                    className: 'awbc-input awbc-textarea',
                    value: agentEditor.prompt,
                    onChange: event => setAgentEditor(prev => ({ ...prev, prompt: event.target.value })),
                  }),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
                  agentEditor.isNew
                    ? null
                    : h('button', { type: 'button', className: 'awbc-btn danger', onClick: deleteAgentEditor }, '✕ ' + t('del')),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, marginLeft: 'auto' } },
                    h('button', { type: 'button', className: 'awbc-btn', onClick: () => setAgentEditor(null) }, t('close')),
                    h('button', { type: 'button', className: 'awbc-btn primary', disabled: agentEditor.busy, onClick: saveAgentEditor }, t('agentSave')),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-workflow-board: dictionaries')
        const tabLabel = () => (ctx.locale.getLocale().active.startsWith('zh') ? zh['title'] : en['title'])
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: PANEL_ID,
              order: 15,
              label: tabLabel,
              locale: NS,
              inject: sessionId => ({ sessionId: sessionId === undefined ? undefined : String(sessionId) }),
            },
            CanvasPage,
          ),
        )
      },
    }
  },
})

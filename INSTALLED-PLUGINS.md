# INSTALLED-PLUGINS.md — 本机已装插件总表

本表是 MacBook 主开发机（`desktop` profile）已安装插件的对照总表。另一台电脑按本表逐项补装；**每次新增/升级/卸载插件，在同一改动单元里更新本表**（规则见 AGENTS.md §4）。版本以 `~/.dsh/profiles/desktop/package.json` 的 bundles 登记为准。

## 自研插件（本仓库，商店可装）

商店索引为本仓库根目录 `index.json`，安装时 target 填目录名即可。

| 插件 | 中文名 | 本机版本 | index.json 登记 |
|---|---|---|---|
| agent-workflow-board | 流程画布 | 2.19.0 | ✓ 2.19.0 |
| auto-expand-thinking | 思考自动展开 | 1.5.0 | ✓ 1.5.0 |
| business-flows | 业务流程 | 0.4.4 | ✓ 0.4.4 |
| composer-effort-chips | 快捷挂档 | 1.4.1 | ✓ 1.4.1 |
| composer-usage-plus | 输入框用量明细 | 1.5.1 | ✓ 1.5.1 |
| dsh-bark-notifications | Bark 通知 | 0.4.6 | ✓ 0.4.6 |
| dsh-full-access-default | 新会话默认完全权限 | 1.0.2 | ✓ 1.0.2 |
| edit-restart | 修改重发 | 0.21.3 | ✓ 0.21.3 |
| side-chat | 侧边对话 | 0.5.0 | ✓ 0.5.0 |
| turn-cost | 本轮费用 | 1.18.0 | ✓ 1.18.0 |
| turn-queue | 完成队列 | 0.4.9 | ✓ 0.4.9 |

## 第三方插件（npm 包）

| 包名 | 本机版本 | 说明 | 安装 target |
|---|---|---|---|
| @linxin666/dsh-client-ui-skill-explorer | 0.4.8 | DSH skill center：按来源浏览/启停已加载技能 | `@linxin666/dsh-client-ui-skill-explorer` |
| @xiaoso/dsh-workflow-lite | 0.6.0 | 轻量工作流：画布上把步骤连成图，编译成派发计划交给模型执行 | `@xiaoso/dsh-workflow-lite` |
| dsh-mermaid | 0.4.2 | Mermaid 图渲染 | `dsh-mermaid` |

## DSH 内置核心（随应用自带，无需安装）

`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-plugin-market-bundle`、`@deepseek-ai/dsh-experimental-cot-translation-bundle`、`@deepseek-ai/dsh-experimental-inspector-profile`、`@deepseek-ai/dsh-experimental-forge-bundle` —— 由 DSH 桌面客户端自带，不出现在插件市场，也不需要手动安装。

## 已移除

- **quote-selection（划词引用）**：2026-11-19 删除，DSH 官方已内置划词引用；另一台机器上已装的 0.5.7 可继续用，也可卸载腾位置。

## 另一台电脑补装步骤

1. 本仓库 `git pull`，确认 `cordis.patch.yml` 的 `plugin-market.indexes` 已登记本仓库 raw 地址（详见 [WINDOWS-SETUP.md](WINDOWS-SETUP.md)）；
2. 商店里逐个安装上表 11 个自研插件（target = 目录名）；
3. 按 npm 包名安装 3 个第三方插件；
4. 安装即自动写入 profile 的 bundles 登记表，重载界面生效。

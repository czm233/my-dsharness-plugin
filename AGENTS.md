# AGENTS.md — 本仓库开发规则

本仓库是 DeepSeek Harness(DSH)自定义插件的**唯一正式存放地**。
任何 AI 会话或开发者在本仓库工作时,必须遵守以下规则。

## 1. 路径唯一

- 本地开发路径**只有一个**:`/Users/czm/githubProject/my-dsharness-plugin/`
- 远程仓库**只有一个**:`https://github.com/czm233/my-dsharness-plugin`(私有)
- 任何其他位置(default-workspace、czm-personal-website 等)出现的插件副本都是过期残留:发现即删除,**绝不**在副本上改代码。
- DSH 的插件软链接在 `~/.dsh/profiles/desktop/node_modules/@local/<插件名>`,必须指向本仓库内的对应子目录。

## 2. 版本优先级

以内容新旧和归属判断,从高到低:

1. **项目/工作区文件夹内的插件**(临时覆盖版)——仅在明确处于某项目的临时测试期时存在,测试结束必须清理或转正;
2. **本仓库本地文件夹**(`/Users/czm/githubProject/my-dsharness-plugin/`)——日常开发与生效来源;
3. **云端**(GitHub 上的 main 分支)——正式版本的最终依据。

云端可随时 `git pull` 同步到本地;本地与云端冲突时,先确认哪边是要保留的结果,再决定合并方向,**不允许**两份长期分叉。

## 3. 临时改动的生命周期

1. **临时测试**:可以直接在本仓库的插件目录里改文件覆盖生效(link 安装,刷新页面即生效),快速验证想法;
2. **转正**:测试结果要保留时,必须走正规渠道——升 `package.json` 版本号 → `git commit` → `git push` 到云端;
3. **不允许**把临时改动长期留在本地不提交,也不允许绕过 git 直接"以后再说"。

## 4. 插件市场(index.json)

- 本仓库根目录的 `index.json` 是 DSH 插件市场的索引文件(format 1)。
- **新增或更新插件后必须同步更新 `index.json`**:新插件加一个条目;版本更新要在 `versions` 里追加一项,并填当时的 commit hash。
- 本地 profile 的插件市场配置(`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `plugin-market.indexes`)已包含本仓库的 raw 地址;新机器配置时记得加上。

## 5. 新插件上手清单

1. 在本仓库建子目录,包含 `package.json`、`cordis.patch.yml`、`client.js`/`index.js`、`locale/`、`icon.svg`;
2. 更新根目录 `index.json`;
3. `git commit + push`;
4. plugin_manager install,目录填本仓库内路径;
5. 刷新页面,用版本号确认生效。

## 现有插件

| 插件 | 版本 | 说明 |
|---|---|---|
| agent-workflow-board | 2.0.0 | 流程画布(详见其目录内 HANDOFF.md) |
| composer-usage-plus | 1.0.1 | 用量明细;1.0.1 修复额度进度条显示"剩余"而非"已用" |
| composer-effort-chips | 1.0.0 | 推理力度切换 |
| turn-cost | 1.0.0 | 单轮成本 |

---
*规则制定于 2026-10-26,由用户口述、AI 整理。修改本文件本身也要 commit + push。*

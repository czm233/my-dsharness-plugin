# WINDOWS-SETUP.md — Mac ↔ Windows 插件同步

> 原 skill `dsh-plugin-sync` 已删除（2026-11-19）。同步改为手动，语义不变：**push 即同步意图**——推上公开仓的插件，就是要另一台接上的；没推的改动属于本机。
> 只同步插件代码与安装登记。用户级配置（cordis.patch、API keys）、画布、角色库、workflow-lite 图、会话、登录态**一律不跨机器**。

## 手动同步（任一台）

1. `git pull --rebase --autostash`（脏工作区先处理干净，不代提交）。
2. 新增插件时按 AGENTS.md §2.5 补 profile `package.json` 的 `@local/*` link 条目 + `dsh.profile.bundles` 登记。
3. `pnpm install`（DSH 内置 runtime，命令见 AGENTS.md §2.5），验证 `node_modules/@local/*` 链接目标存在。
4. 按热更新规则生效：只动 client.js/locale/icon 重载界面即可；动了 index.js/host.js/cordis.patch.yml/package.json 走 remove+install 重装（AGENTS.md §3.5）。

技能同步：技能仓 `~/githubProject/my-codex-skills` `git pull` 后重跑 `./install.sh`（Windows `.\install.ps1`），安装清单见该仓 `skills.sync.tsv`。

## Windows 首次接上（一次性）

前置：装 Git（`winget install --id Git.Git -e`）、DSH 已安装且**启动过一次**（profile 已生成）。

```powershell
git clone https://github.com/czm233/my-dsharness-plugin $env:USERPROFILE\githubProject\my-dsharness-plugin
git clone https://github.com/czm233/my-codex-skills $env:USERPROFILE\githubProject\my-codex-skills
cd $env:USERPROFILE\githubProject\my-codex-skills; .\install.ps1
```

然后按上面「手动同步」补全 profile 登记表并 `pnpm install`；**征得用户同意后**在 profile 的 `plugin-market.indexes` 补上本仓库 raw 地址（这是插件市场能看到这批插件的唯一途径），随后重启 DSH。

纯使用场景（不在 Windows 上改插件）也可以不走 link：市场源配好后直接在 DSH 插件市场点安装即可。

## 硬规矩（跨平台不变项）

1. **软链接的源头是 profile `package.json` 登记表 + pnpm install**（AGENTS.md §2.5），永远不要手 `ln -sfn`。
2. **行尾**：`.gitattributes`（`* -text`）+ 仓库内 `core.autocrlf=false`，两台字节一致。
3. **Windows 无扩展名命令**（npx 等）必须经 `cmd /c` 启动。
4. 插件增改后同步更新根 `index.json`（版本 + commit hash），否则另一台市场里看不到新版本（AGENTS.md §4）。

## 兜底（仅在想把配置也整体搬过去时）

`bash scripts/export-config.sh`（Mac，生成含密钥的私有 zip）+ `powershell scripts\setup-windows.ps1 -MigrationZip <zip>`（Windows）。这会连用户级配置一起搬——默认不需要，日常手动 git pull 即可。

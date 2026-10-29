# WINDOWS-SETUP.md — Mac ↔ Windows 插件同步

> 主通道是 **skill：`dsh-plugin-sync`**（规程在 `my-codex-skills/skills/dsh-plugin-sync/`，两台机器都装在 `~/.agents/skills/`）。
> 语义：**push 即同步意图**——推上公开仓的插件，就是要另一台接上的；没推的改动属于本机。
> 只同步插件代码与安装登记。用户级配置（cordis.patch、API keys）、画布、角色库、workflow-lite 图、会话、登录态**一律不跨机器**。

## 日常（两台各一句话）

- Mac 做好插件要带走：对 AI 说「**插件上线**」→ pull、检查脏工作区（**脏即停止，交你手动处理**）、提醒版本号与 index.json 一致性、push。
- Windows 到家要接上：说「**插件接上**」→ pull、按本机路径补全 profile 登记表、`pnpm install`（DSH 内置 runtime）、按热更新规则告诉你哪些插件要重装/重载。
- 插件仓唯一真相是 GitHub main（该仓库 AGENTS.md §2）。

## Windows 首次接上（一次性）

前置：装 Git（`winget install --id Git.Git -e`）、DSH 已安装且**启动过一次**（profile 已生成）。

```powershell
git clone https://github.com/czm233/my-dsharness-plugin $env:USERPROFILE\githubProject\my-dsharness-plugin
# skill 本体（从 my-codex-skills 取一份装进 ~/.agents/skills/）
git clone https://github.com/czm233/my-codex-skills $env:USERPROFILE\githubProject\my-codex-skills
```

然后在 DSH 会话里说「**插件接上**」——skill 会全量登记 `@local/*` + `pnpm install`，并**征得你同意后**在 profile 的 `plugin-market.indexes` 补上本仓库 raw 地址（这是插件市场能看到这批插件的唯一途径），随后重启 DSH。验收：插件列表里五个插件都在、画布可用、版本号与 Mac 一致。

纯使用场景（不在 Windows 上改插件）也可以不走 link：市场源配好后直接在 DSH 插件市场点安装即可。

## 硬规矩（跨平台不变项）

1. **软链接的源头是 profile `package.json` 登记表 + pnpm install**（AGENTS.md §2.5），永远不要手 `ln -sfn`。
2. **行尾**：`.gitattributes`（`* -text`）+ 仓库内 `core.autocrlf=false`，两台字节一致。
3. **Windows 无扩展名命令**（npx 等）必须经 `cmd /c` 启动；本 skill 不碰配置，故一般用不到。
4. 插件增改后同步更新根 `index.json`（版本 + commit hash），否则另一台市场里看不到新版本（AGENTS.md §4）。

## 兜底（仅在想把配置也整体搬过去时）

`bash scripts/export-config.sh`（Mac，生成含密钥的私有 zip）+ `powershell scripts\setup-windows.ps1 -MigrationZip <zip>`（Windows）。这会连用户级配置一起搬——默认不需要，日常走 skill。

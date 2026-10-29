# WINDOWS-SETUP.md — Mac ↔ Windows 双机同步（DSH 开发环境）

> 主通道是 **skill：`dsh-env-sync`**（规程在 `my-codex-skills/skills/dsh-env-sync/`，两台机器都装在 `~/.agents/skills/`）。
> 对 AI 说「**下班同步**」/「**到家接上**」即可执行。本文件只讲一次性首装、通道架构和兜底方案。

## 通道架构

| 仓库 | 内容 | 访问 |
|---|---|---|
| `my-dsharness-plugin`（公开） | 插件代码、本指南、兜底脚本 | git 双向 |
| `dsh-profile-sync`（**私有**，含 API key，禁止转公开） | `cordis.patch.mac.yml` / `cordis.patch.windows.yml`、`credentials-refs.yaml`、`profile-package.deps.json`、rules / 画布+角色库 / workflow-lite 图 / agent-team / 微信集成 | git 双向，由 skill 维护 |

- 同步范围：**只有工具环境**——插件代码、应用配置、API keys、角色库、画布、workflow-lite 图、规则。
- 永不搬：项目文件（公司项目留 Mac、个人项目留 Windows）、会话历史、DSH 登录态（`records` 段）。
- 合并语义：按 mtime 新者胜、不传播删除；插件仓有未提交改动时 skill 直接停止，交用户手动处理（用户选择）。
- 画布绑定记录的是会话 id，跨机无效——到另一台后对画布重新点一次「启动流程」。

## 日常（两台各一句话）

- Mac 收工：会话里说「**下班同步**」→ 跑 `dsh-env-sync`。
- Windows 到家：说「**续上环境**」→ 同一个 skill，接上 Mac 白天的状态；收工离开前再跑一次把自己的改动推上去。
- Windows 特有改写（MCP 命令移植成 `cmd /c`、link 路径本机重生成、行尾锁死）都写在 skill 规程里，由 AI 现场执行与判断。

## Windows 首次安装（一次性）

前置：装 Git（`winget install --id Git.Git -e`）、DSH 已安装且**启动过一次**、`gh auth login`（或对私库的 HTTPS 凭据）。

```powershell
git clone https://github.com/czm233/my-dsharness-plugin $env:USERPROFILE\githubProject\my-dsharness-plugin
gh repo clone czm233/dsh-profile-sync $env:USERPROFILE\githubProject\dsh-profile-sync
git -C $env:USERPROFILE\githubProject\my-codex-skills clone https://github.com/czm233/my-codex-skills $env:USERPROFILE\githubProject\my-codex-skills
```

然后把 `my-codex-skills\skills\dsh-env-sync` 拷到 `%USERPROFILE%\.agents\skills\`，在 DSH 会话里说「续上环境」——skill 会完成 profile 定位、登记表重生成、pnpm install、配置与密钥导入、用户数据落位，并报告需要重启的事项。重启 DSH 后验收：画布版本号与 Mac 一致、对话正常出字（= keys 生效）、画布和角色库在、插件市场能刷出本仓库源。

## 兜底：一次性迁移 zip（私库不便时）

Mac 上 `bash scripts/export-config.sh` 生成含密钥的私有 zip（含 UTF-8 文件名修正），Windows 上 `powershell -File scripts\setup-windows.ps1 -MigrationZip <zip>` 导入。用完仍建议转到 skill 日常流程。

## 硬规矩（跨平台不变项）

1. **软链接的源头是 profile `package.json` 登记表 + pnpm install**（AGENTS.md §2.5），永远不要手 `ln -sfn`。
2. **行尾**：`.gitattributes`（`* -text`）+ 仓库内 `core.autocrlf=false`，两台字节一致。
3. **密钥**：`apiKeyEnv` 变量由 DSH 从 `~/.dsh/.credentials.yaml` 的 `refs` 段注入；同步只合并 refs 段，不碰登录态。
4. **Windows 无扩展名命令**（npx 等）必须经 `cmd /c` 启动，spawn 不认 `.cmd` shim。

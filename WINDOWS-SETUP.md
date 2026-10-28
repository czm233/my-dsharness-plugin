# WINDOWS-SETUP.md — 把 Mac 上的全部 DSH 配置同步到 Windows

> 适用场景：Windows 那台已安装 DeepSeek Harness 且**启动过至少一次**（profile 已生成）。
> 全套配置分两层走：**公开的走 git，含密钥/个人数据的走私有 zip**。本指南两步都覆盖。

## 同步了什么

| 内容 | 去向 | 说明 |
|---|---|---|
| 5 个插件（流程画布 / 单轮成本 / 推理力度 / 用量明细 / 划词引用） | git 公开仓库 | `git clone` 即得 |
| profile 的 link 登记表（`package.json` + bundles） | Windows 脚本按本机路径重新生成 | Mac 上的 `/Users/czm/...` 绝对路径**不能**照抄，脚本会写成 `C:/Users/<你>/...` |
| 应用级配置（模型、市场源、MCP、界面偏好） | 私有 zip → 导入 | Windows 特有改动已做好：MCP 的 `npx` 改 `cmd /c npx`；市场源含本仓库 raw 地址 |
| API keys（ZAI / RIGHTCODE 等） | 私有 zip → 合并进 `.credentials.yaml` 的 `refs` 段 | **永不进 git**；账号登录态（`records` 段）不搬，Windows 首次启动自己登录 |
| 规则（`~/.dsh/rules`）、画布 + 用户级角色库、workflow-lite 图、agent-team 成员、微信集成配置 | 私有 zip → 导入 | 画布绑定记录的是 Mac 会话 id，Windows 上需重新绑定 |
| 不搬的：会话历史、缓存、用量统计、DSH 桌面端登录态 | — | 换机器无意义或应重新生成 |

## Windows 侧操作（共三步）

### 第 0 步（Mac 上做，一次性）：生成迁移 zip

在 Mac 仓库根目录执行：

```bash
bash scripts/export-config.sh
```

产物：`~/Desktop/dsh-windows-migration-<时间戳>.zip`（含密钥，只走你自己的传输渠道）。

### 1. Windows 装 Git（已有可跳过）

```powershell
winget install --id Git.Git -e
```

### 2. 克隆仓库并跑导入脚本

把 zip 拷到 Windows（AirDrop/网盘/U盘均可），然后在 PowerShell 里：

```powershell
git clone https://github.com/czm233/my-dsharness-plugin $env:USERPROFILE\githubProject\my-dsharness-plugin
cd $env:USERPROFILE\githubProject\my-dsharness-plugin
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -MigrationZip <zip的完整路径>
```

脚本自动完成：定位 profile → 按本机路径登记全部 `@local/*` 插件和 bundles → 替换 Windows 适配版 `cordis.patch.yml`（原文件自动备份）→ 合并 API keys → 导入画布/角色库/规则/图 → 用 DSH 内置 runtime 跑 `pnpm install` 重建软链接 → 逐个验证链接有效。

没带 zip 也能跑（只做插件侧同步），但市场源/模型/密钥/画布都不会有——强烈建议带上。

### 3. 重启 DSH，按脚本末尾的清单验收

画布版本号 2.7.0、四个插件在运行、对话正常出字、画布和 uiux 角色在、市场源可刷新。

## Windows 特有差异（为什么不能直接拷文件）

1. **路径**：`link:/Users/czm/...` 在 Windows 无效。登记表按本机路径重新生成，这是 AGENTS.md §2.5 的规矩——**软链接的源头是 package.json 登记表 + pnpm install，永远不要手 ln**。
2. **MCP 的 npx**：Windows 无法直接 spawn 无扩展名的 `npx`，模板已改为 `command: cmd` + `args: ["/c", "npx", ...]`。
3. **行尾**：仓库有 `.gitattributes`（`* -text`，全库不做行尾转换），脚本再把仓库内 `core.autocrlf` 设为 false，保证两台机器字节一致、diff 干净。
4. **pnpm 软链接**：Windows 上 pnpm 用 junction 实现 `link:` 依赖，不需要管理员或开发者模式。
5. **凭据**：`apiKeyEnv` 指定的环境变量由 DSH 从 `~/.dsh/.credentials.yaml` 的 `refs` 段注入，zip 里的 `credentials-refs.yaml` 就是这一段，脚本做合并而不是整文件覆盖（保住 Windows 自己的登录态）。

## 之后的日常双机同步

- **Mac 改了插件** → commit + push；Windows 上 `git -C $env:USERPROFILE\githubProject\my-dsharness-plugin pull`，然后在 profile 目录跑一次 `pnpm install`，重启 DSH。
- **Windows 改了插件** → 同理反向。两边都改过的文件，push 前先 pull --rebase，别让两台长期分叉（AGENTS.md §2）。
- 画布 / 角色库这类用户数据**不走 git**：改动后想带去另一台，重跑 `export-config.sh` 生成新 zip（或单独拷那几个 json/md）。
- 迁移包、密钥文件永远不进仓库：zip 只存本机和你自己的网盘。

# DSH Windows 配置导入脚本（配套 Mac 侧 scripts/export-config.sh 生成的迁移 zip）
# 用法（PowerShell）：
#   cd $env:USERPROFILE\githubProject\my-dsharness-plugin
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -MigrationZip <zip完整路径>
# 兼容 Windows 自带的 PowerShell 5.1；JSON 合并由 node 执行，避免 PS5.1 的数组压平坑。
param(
  [string]$MigrationZip = "",
  [string]$RepoPath = "$env:USERPROFILE\githubProject\my-dsharness-plugin"
)

$ErrorActionPreference = "Stop"
function OK($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function WARN($m) { Write-Host "！ $m" -ForegroundColor Yellow }
function STEP($m) { Write-Host "`n== $m ==" -ForegroundColor Cyan }

# ---------- 1. 前置检查 ----------
STEP "1/8 前置检查"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  WARN "未检测到 git。请先安装 Git for Windows 再重跑："
  Write-Host "    winget install --id Git.Git -e"
  exit 1
}
OK "git 可用"
if ($MigrationZip -ne "" -and -not (Test-Path $MigrationZip)) { WARN "迁移 zip 不存在：$MigrationZip（将只做插件侧同步，跳过用户数据导入）"; $MigrationZip = "" }

# ---------- 2. 克隆 / 更新仓库 ----------
STEP "2/8 插件仓库（$RepoPath）"
if (Test-Path "$RepoPath\.git") {
  git -C $RepoPath pull --ff-only | Out-Null
  OK "已有仓库，已拉取最新"
} else {
  git clone https://github.com/czm233/my-dsharness-plugin $RepoPath | Out-Null
  OK "已克隆"
}
git -C $RepoPath config core.autocrlf false
OK "仓库内 autocrlf=false（配合 .gitattributes，行尾跨平台字节一致）"

# ---------- 3. 定位 DSH profile ----------
STEP "3/8 定位 DSH profile"
$profileDir = $null
$profilesRoot = "$env:USERPROFILE\.dsh\profiles"
if (Test-Path $profilesRoot) {
  $cands = Get-ChildItem $profilesRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName "package.json") }
  $profileDir = ($cands | Where-Object Name -eq "desktop" | Select-Object -First 1).FullName
  if (-not $profileDir) { $profileDir = ($cands | Select-Object -First 1).FullName }
}
if (-not $profileDir) {
  WARN "未找到 profile（$profilesRoot 下没有带 package.json 的目录）。"
  Write-Host "    请先启动一次 DeepSeek Harness 并完成账号登录，然后重跑本脚本。"
  exit 1
}
OK "profile：$profileDir"

# ---------- 4. 合并 profile package.json（node 执行；此时必须已有 node） ----------
STEP "4/8 登记插件（profile package.json 的 link 登记表 + bundles）"
$node = $null
$runtimeNode = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $runtimeNode) { $runtimeNode = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 }
if ($runtimeNode) { $node = $runtimeNode.FullName } elseif (Get-Command node -ErrorAction SilentlyContinue) { $node = "node" }
if (-not $node) {
  WARN "既找不到 DSH 内置 node，也找不到系统 node，无法继续（pnpm install 也依赖它）。"
  Write-Host "    请安装 Node.js LTS 后重跑：winget install OpenJS.NodeJS.LTS"
  exit 1
}
$mergeJs = @'
const fs = require("fs"), path = require("path");
const [profilePkgPath, repoPath] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(profilePkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
const plugins = fs.readdirSync(repoPath).filter(d => {
  try { return fs.statSync(path.join(repoPath, d)).isDirectory() && fs.existsSync(path.join(repoPath, d, "package.json")); }
  catch (e) { return false; }
});
const repoNorm = repoPath.replace(/\\/g, "/");
for (const d of plugins) pkg.dependencies["@local/" + d] = "link:" + repoNorm + "/" + d;
pkg.dsh = pkg.dsh || {}; pkg.dsh.profile = pkg.dsh.profile || {}; pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
const added = [];
for (const d of plugins) {
  const b = "@local/" + d;
  if (!pkg.dsh.profile.bundles.includes(b)) { pkg.dsh.profile.bundles.push(b); added.push(b); }
}
fs.writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("registered: " + plugins.join(", "));
if (added.length) console.log("bundles added: " + added.join(", ")); else console.log("bundles: no change");
'@
$mergeJsPath = Join-Path $env:TEMP "dsh-merge-profile.js"
[IO.File]::WriteAllText($mergeJsPath, $mergeJs, (New-Object System.Text.UTF8Encoding($false)))
& $node $mergeJsPath (Join-Path $profileDir "package.json") $RepoPath
OK "link 登记表与 bundles 已按本机路径写好"

# ---------- 5. 导入迁移包 ----------
STEP "5/8 导入迁移包内容"
if ($MigrationZip -eq "") {
  WARN "未提供 -MigrationZip，跳过 cordis.patch / 用户数据 / 密钥导入。"
  WARN "没有它，Windows 上不会有市场源、模型、API key、画布、角色库。强烈建议补跑。"
} else {
  $tmp = Join-Path $env:TEMP ("dsh-migration-" + [guid]::NewGuid().ToString("N"))
  Expand-Archive -Path $MigrationZip -DestinationPath $tmp
  OK "已解压到临时目录"

  # 5a. cordis.patch.yml（先备份现有）
  $patchDst = Join-Path $profileDir "cordis.patch.yml"
  if (Test-Path $patchDst) {
    $bak = "$patchDst.bak-win-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $patchDst $bak
    OK "已备份原 cordis.patch.yml → $(Split-Path $bak -Leaf)"
  }
  Copy-Item (Join-Path $tmp "cordis.patch.windows.yml") $patchDst -Force
  OK "cordis.patch.yml 已替换为 Windows 适配版（npx→cmd /c；市场源已含本仓库 raw 地址）"

  # 5b. credentials：只合并 refs（API keys）；账号登录态在 Windows 重新登录生成
  $credDst = "$env:USERPROFILE\.dsh\.credentials.yaml"
  $refsText = [IO.File]::ReadAllText((Join-Path $tmp "credentials-refs.yaml"))
  if (Test-Path $credDst) {
    Copy-Item $credDst "$credDst.bak-win" -Force
    # 结构保证 refs: 是最后一个段：截掉 refs: 及其后内容，再接上 zip 里的 refs 段
    $all = [IO.File]::ReadAllLines($credDst)
    $idx = -1
    for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i] -match "^refs:") { $idx = $i; break } }
    if ($idx -ge 0) { $kept = $all[0..($idx - 1)] } else { $kept = $all }
    [IO.File]::WriteAllLines($credDst, ($kept + ($refsText -split "`r?`n")))
    OK "已合并 API keys 到 .credentials.yaml（原文件备份为 .credentials.yaml.bak-win）"
  } else {
    [IO.File]::WriteAllText($credDst, "version: 1`nrecords: {}`n" + $refsText, (New-Object System.Text.UTF8Encoding($false)))
    OK ".credentials.yaml 不存在，已生成（含 API keys；账号登录态请启动 DSH 后重新登录）"
  }

  # 5c. 用户数据
  $map = [ordered]@{
    "rules"                          = "$env:USERPROFILE\.dsh\rules"
    "storages-agent-workflow-board"  = "$env:USERPROFILE\.dsh\storages\agent-workflow-board"
    "workflow-lite"                  = "$env:USERPROFILE\.dsh\workflow-lite"
    "agent-team"                     = "$env:USERPROFILE\.dsh\agent-team"
    "integrations-dsh-weixin"        = "$env:USERPROFILE\.dsh\integrations\dsh-weixin"
  }
  foreach ($k in $map.Keys) {
    $src = Join-Path $tmp $k
    if (Test-Path $src) {
      New-Item -ItemType Directory -Force -Path $map[$k] | Out-Null
      Copy-Item (Join-Path $src "*") $map[$k] -Recurse -Force
      OK "$k → $($map[$k])"
    }
  }
  Remove-Item $tmp -Recurse -Force
  WARN "注意：画布绑定（bindings.json）记录的是 Mac 的会话 id，Windows 上需对画布重新「启动流程」绑定一次。"
}

# ---------- 6. pnpm install（按登记表重建全部软链接） ----------
STEP "6/8 pnpm install（软链接的唯一权威来源是 package.json 登记表，不要手 ln）"
$runtimeRoot = Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
$pnpmCjs = @()
foreach ($rt in (Get-ChildItem "$env:USERPROFILE\.dsh\dsh-runtimes\*" -Directory -ErrorAction SilentlyContinue)) {
  $pnpmCjs += @(Get-ChildItem (Join-Path $rt.FullName "dependencies\pnpm\bin\pnpm.cjs") -ErrorAction SilentlyContinue)
  $pnpmCjs += @(Get-ChildItem (Join-Path $rt.FullName "dependencies\pnpm\pnpm.cjs") -ErrorAction SilentlyContinue)
}
$pnpmCjs = $pnpmCjs | Select-Object -Unique | Select-Object -First 1
if ($pnpmCjs) {
  Push-Location $profileDir
  & $node $pnpmCjs install
  $exit = $LASTEXITCODE
  Pop-Location
  if ($exit -ne 0) { WARN "pnpm install 退出码 $exit，请把上面的报错发回会话排查。"; exit 1 }
  OK "pnpm install 完成（使用 DSH 内置 runtime）"
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Push-Location $profileDir; pnpm install; $exit = $LASTEXITCODE; Pop-Location
  if ($exit -ne 0) { WARN "pnpm install 失败。"; exit 1 }
  OK "pnpm install 完成（系统 pnpm）"
} else {
  WARN "找不到 pnpm（DSH 内置 runtime 目录结构与预期不同，且系统也没有 pnpm）。"
  Write-Host "    手动执行：cd $profileDir 然后 npm i -g pnpm && pnpm install，或把 DSH 版本号发回会话。"
  exit 1
}

# ---------- 7. 验证 ----------
STEP "7/8 验证 @local 软链接"
$bad = 0
Get-ChildItem (Join-Path $profileDir "node_modules\@local") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $t = $_.Target
  $exists = $t -and (Test-Path $t)
  if ($exists) { OK ("{0} → {1}" -f $_.Name, $t) } else { WARN "$_ 目标无效：$t"; $bad++ }
}
if ($bad -gt 0) { WARN "$bad 个链接无效！"; exit 1 }

# ---------- 8. 收尾 ----------
STEP "8/8 完成"
Write-Host ""
OK "全部就绪。最后一步必须由你做：完全退出并重启 DeepSeek Harness。"
Write-Host ""
Write-Host "重启后的验收清单：" -ForegroundColor Cyan
Write-Host "  1. 流程画布版本号为 2.7.0（设置→插件，或画布面板角标）"
Write-Host "  2. turn-cost / composer-effort-chips / composer-usage-plus / quote-selection 都在运行"
Write-Host "  3. 对话正常出字（zai-coding-cn 模型连通，即 credentials 导入成功）"
Write-Host "  4. 流程画布里能看到 Mac 上的画布与 uiux 角色"
Write-Host "  5. 插件市场里能看到本仓库的插件更新源"

#!/usr/bin/env bash
# Mac 侧导出脚本：把所有【不进 git】的配置打进一个私有 zip，拷去 Windows 后由
# scripts/setup-windows.ps1 导入。含密钥，zip 只留在本机/自己的网盘，绝不提交。
# 用法：bash scripts/export-config.sh   （在仓库根目录执行）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="$HOME/.dsh"
PROFILE="$DSH/profiles/desktop"
STAMP="$(date +%Y%m%d-%H%M)"
# 默认落桌面；需要换落点时 DSH_MIGRATION_DEST=/path/to/dir 覆盖（给目录，不带 .zip 后缀）
DEST="${DSH_MIGRATION_DEST:-$HOME/Desktop/dsh-windows-migration-$STAMP}"
OUT="$DEST"
ZIP="$DEST.zip"

fail() { echo "✗ $*" >&2; exit 1; }
[ -f "$PROFILE/cordis.patch.yml" ] || fail "找不到 $PROFILE/cordis.patch.yml"
[ -f "$DSH/.credentials.yaml" ] || fail "找不到 $DSH/.credentials.yaml"

rm -rf "$OUT"; mkdir -p "$OUT"

# 1) cordis.patch.yml Windows 版：仓库模板 + 注入真实 Z_AI_API_KEY
ZKEY="$(sed -n 's/^ *Z_AI_API_KEY: "\(.*\)"$/\1/p' "$PROFILE/cordis.patch.yml")"
[ -n "$ZKEY" ] || fail "没能从 Mac 的 cordis.patch.yml 提取 Z_AI_API_KEY"
sed "s/__Z_AI_API_KEY__/$ZKEY/" "$REPO/scripts/windows-templates/cordis.patch.windows.yml" > "$OUT/cordis.patch.windows.yml"
echo "✓ cordis.patch.windows.yml（Windows 适配 + 真实 Z_AI key）"

# 2) credentials 只导 refs 段（API keys）；records 是 Mac 登录态/设备身份，不导，
#    Windows 首次启动自己登录生成，避免两台机器共用设备身份。
awk '/^refs:/{f=1} f' "$DSH/.credentials.yaml" > "$OUT/credentials-refs.yaml"
grep -q "^refs:" "$OUT/credentials-refs.yaml" || fail "credentials-refs.yaml 段提取失败"
echo "✓ credentials-refs.yaml（仅 refs 密钥段）"

# 3) profile package.json —— 仅作参考（Windows 侧由 setup 脚本按本机路径重新生成）
cp "$PROFILE/package.json" "$OUT/profile-package.mac-reference.json"
echo "✓ profile-package.mac-reference.json（参考用）"

# 4) 用户数据：规则 / 画布+角色库+绑定 / workflow-lite 图 / agent-team 成员 / 微信集成
cp -R "$DSH/rules" "$OUT/rules"
cp -R "$DSH/storages/agent-workflow-board" "$OUT/storages-agent-workflow-board"
cp -R "$DSH/workflow-lite" "$OUT/workflow-lite"
cp -R "$DSH/agent-team" "$OUT/agent-team"
mkdir -p "$OUT/integrations-dsh-weixin"
cp "$DSH/integrations/dsh-weixin/config.json" "$OUT/integrations-dsh-weixin/" 2>/dev/null || true
cp "$DSH/integrations/dsh-weixin/workspaces.json" "$OUT/integrations-dsh-weixin/" 2>/dev/null || true
echo "✓ rules / 画布与角色库 / workflow-lite / agent-team / 微信集成配置"

cat > "$OUT/MANIFEST.txt" <<EOF
DSH Mac → Windows 迁移包（${STAMP}，由 scripts/export-config.sh 生成）
导入方式：把 zip 拷到 Windows 后交给仓库内 scripts/setup-windows.ps1，不要手工散拷。
内容：
  cordis.patch.windows.yml        Windows 适配版应用级配置（含 Z_AI key）
  credentials-refs.yaml           API keys（仅 refs 段；账号登录态请在 Windows 重新登录）
  profile-package.mac-reference.json  Mac 的 link 登记表，仅供参考
  rules/                          ~/.dsh/rules
  storages-agent-workflow-board/  画布 JSON + 用户级角色库 + 绑定（绑定到 Windows 后会话不同，需重新绑定画布）
  workflow-lite/                  workflow-lite 图 / 模板 / 实例记录
  agent-team/                     agent-team 成员
  integrations-dsh-weixin/        微信集成配置（登录态异常就在 Windows 重连）
EOF

# 打包必须用 python3 的 zipfile：macOS zip CLI 不给非 ASCII 文件名打 UTF-8 标志位（bit 11），
# Windows 的 Expand-Archive 会把中文文件名按 IBM437 解成乱码。
if command -v python3 >/dev/null 2>&1; then
  python3 - "$OUT" "$ZIP" <<'PYEOF'
import sys, os, zipfile
out, zippath = sys.argv[1], sys.argv[2]
if os.path.exists(zippath):
    os.remove(zippath)
with zipfile.ZipFile(zippath, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(out):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, out))
print("✓ 打包完成：" + zippath)
PYEOF
else
  (cd "$OUT" && zip -qr "$ZIP" .)
  echo "⚠ 未找到 python3：zip 内若有中文文件名（workflow 图），Windows 解压可能乱码"
fi
echo "  （明文目录 $OUT 已保留供检查，确认无误后可自行删除）"

#!/usr/bin/env bash
# =============================================================
# deploy.sh — 一键同步本地代码到服务器站点目录
# 用法：
#   bash deploy.sh            （在项目根目录或任意位置均可）
#   或 Windows 下直接双击 deploy.bat
# =============================================================
set -euo pipefail

SERVER="${DEPLOY_SERVER:-ubuntu@140.143.247.55}"
PAGE="http://140.143.247.55"

cd "$(dirname "$0")"

echo "== [1/3] 确保远端目录存在 =="
ssh "$SERVER" "mkdir -p ~/site"

echo "== [2/3] 打包并上传（排除 git/部署工具/开发预览文件）=="
tar \
  --exclude='./.git' \
  --exclude='./.workbuddy' \
  --exclude='./deployment' \
  --exclude='./HANDOFF.md' \
  --exclude='./preview*.html' \
  --exclude='./theme-preview.html' \
  --exclude='./module-grid-preview.html' \
  --exclude='./_t_summary_compact.js' \
  -cf - . | ssh "$SERVER" "tar -xf - -C ~/site"

echo "== [3/3] 发布到站点目录（需要输一次 sudo 密码）=="
ssh -t "$SERVER" "sudo cp -r ~/site/. /var/www/project-reporting/"

echo ""
echo "✅ 同步完成，刷新浏览器查看：$PAGE"
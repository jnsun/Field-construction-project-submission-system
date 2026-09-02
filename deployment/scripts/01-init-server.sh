#!/usr/bin/env bash
# =============================================================
# 01-init-server.sh — 腾讯云 Ubuntu 22.04 初始化
#   · 系统更新 + 基础工具
#   · 创建 4GB swap（4GB 内存跑自托管 Supabase 必需）
#   · 安装 Docker + 国内镜像加速
#   · ufw 防火墙仅开放 SSH(22) / HTTP(80) / HTTPS(443)
# 用法: sudo ./01-init-server.sh
# =============================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0"; exit 1
fi

echo "== [1/5] 系统更新与基础工具 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw unzip ca-certificates gnupg lsb-release

echo "== [2/5] 创建 4GB swap =="
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "swap 已存在，跳过"
fi
echo "内核 swappiness 调优"
sed -i '/vm.swappiness/d' /etc/sysctl.conf || true
echo 'vm.swappiness=10' >> /etc/sysctl.conf
sysctl -p >/dev/null

echo "== [3/5] 安装 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  # 官方脚本失败时改用阿里云镜像源安装（国内服务器更稳）
  curl -fsSL https://get.docker.com | sh \
    || curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun
fi
systemctl enable --now docker

echo "== [4/5] 配置 Docker 镜像加速 =="
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.m.daocloud.io"
  ]
}
EOF
systemctl restart docker

echo "== [5/5] 防火墙：仅开放 22 / 80 / 443 =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

cat <<DONE

=====================================================
 初始化完成！请立即检查：
 1) 不要关闭当前会话，先开一个新终端确认能重新 SSH 登录；
 2) free -h  确认 Swap 一行为 ~4.0Gi；
 3) docker --version && docker compose version 正常。
 
 下一步执行: ./02-install-supabase.sh <公网IP>
=====================================================
DONE

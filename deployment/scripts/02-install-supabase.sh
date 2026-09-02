#!/usr/bin/env bash
# =============================================================
# 02-install-supabase.sh — 自托管 Supabase 一键安装
#   · 克隆官方仓库（含 GitHub 加速回退）
#   · 本地生成全新 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY
#   · 所有对外端口(8000/3000/4000)绑定 127.0.0.1，仅由 HTTPS Nginx 反向代理
#   · 镜像预拉取失败自动切换 daocloud 源
# 用法: sudo ./02-install-supabase.sh <公网IP>
# =============================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0"; exit 1
fi

SERVER_IP="${1:?用法: ./02-install-supabase.sh <公网IP>}"
SUPABASE_DIR=/opt/supabase

echo "== [1/6] 克隆 Supabase 官方仓库 =="
if [ ! -d "$SUPABASE_DIR" ]; then
  git clone --depth 1 https://github.com/supabase/supabase "$SUPABASE_DIR" \
    || git clone --depth 1 https://ghfast.top/https://github.com/supabase/supabase "$SUPABASE_DIR"
else
  echo "$SUPABASE_DIR 已存在，跳过克隆"
fi
cd "$SUPABASE_DIR/docker"

echo "== [2/6] 生成全新密钥 =="
JWT_SECRET=$(openssl rand -hex 32)
ANON_KEY=$(python3 - "$JWT_SECRET" <<'PY'
import base64, hmac, hashlib, json, sys, time
secret = bytes.fromhex(sys.argv[1])
def b64(d): return base64.urlsafe_b64encode(d).rstrip(b"=").decode()
now = int(time.time())
payload = {"role": "anon", "iss": "supabase", "iat": now, "exp": now + 10 * 365 * 86400}
sign = ".".join([b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()),
                 b64(json.dumps(payload).encode())])
sig = hmac.new(secret, sign.encode(), hashlib.sha256).digest()
print(sign + "." + b64(sig))
PY
)
SERVICE_ROLE_KEY=$(python3 - "$JWT_SECRET" <<'PY'
import base64, hmac, hashlib, json, sys, time
secret = bytes.fromhex(sys.argv[1])
def b64(d): return base64.urlsafe_b64encode(d).rstrip(b"=").decode()
now = int(time.time())
payload = {"role": "service_role", "iss": "supabase", "iat": now, "exp": now + 10 * 365 * 86400}
sign = ".".join([b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()),
                 b64(json.dumps(payload).encode())])
sig = hmac.new(secret, sign.encode(), hashlib.sha256).digest()
print(sign + "." + b64(sig))
PY
)
DB_PASSWORD=$(openssl rand -hex 16)
DASH_USER="admin"
DASH_PASS=$(openssl rand -base64 12 | tr '/+' '_-' | tr -d '=' )

echo "== [3/6] 写入 .env 配置 =="
cp -n .env.example .env   # 已有 .env 不覆盖
python3 - "$JWT_SECRET" "$ANON_KEY" "$SERVICE_ROLE_KEY" "$DB_PASSWORD" \
          "$DASH_USER" "$DASH_PASS" "$SERVER_IP" <<'PY'
import sys, re, pathlib
jwt, anon, service, dbpass, user, passwd, ip = sys.argv[1:8]
vals = {
    "JWT_SECRET": jwt,
    "ANON_KEY": anon,
    "SERVICE_ROLE_KEY": service,
    "SUPABASE_URL": f"http://{ip}:8000",       # 容器间通信地址，保持默认即可
    "SITE_URL": f"http://{ip}",                # 浏览器最终访问地址
    "API_EXTERNAL_URL": f"http://{ip}",
    "POSTGRES_PASSWORD": dbpass,
    "DASHBOARD_USERNAME": user,
    "DASHBOARD_PASSWORD": passwd,
    "MAILER_AUTOCONFIRM": "false",
    "ENABLE_EMAIL_SIGNUP": "false",
    "KONG_HTTP_PORT": "8000",
    "STUDIO_PORT": "3000",
    "POOLER_POOL_SIZE": "5",                   # 小内存机器收敛连接池
}
p = pathlib.Path(".env")
lines = p.read_text().splitlines()
seen = set()
out = []
for ln in lines:
    m = re.match(r"^([A-Z][A-Z0-9_]+)=", ln)
    if m and m.group(1) in vals:
        out.append(f"{m.group(1)}={vals[m.group(1)]}")
        seen.add(m.group(1))
    else:
        out.append(ln)
for k, v in vals.items():
    if k not in seen:
        out.append(f"{k}={v}")
p.write_text("\n".join(out) + "\n")
print("已写入", p.resolve())
PY

echo "== [4/6] 将所有对外端口绑定到 127.0.0.1（只能经 Nginx 访问）=="
python3 - <<'PY'
import re, pathlib
p = pathlib.Path("docker-compose.yml")
s = p.read_text()
new = re.sub(r"(- ?')(\d{4}:\d{3,4}(/tcp)?)", r"\g<1>127.0.0.1:\g<2>", s)
if new != s:
    p.write_text(new)
    print("已完成端口绑定修改")
else:
    print("未匹配到公网端口映射（可能已是回环绑定），继续")
PY

echo "== [5/6] 预拉取 Docker 镜像（Hub 失败自动换 daocloud 源）=="
IMAGES=$(grep -E '^\s*image:' docker-compose.yml | awk '{print $2}')
FAILED=""
for img in $IMAGES; do
  if docker pull -q "$img" >/dev/null 2>&1; then
    echo "OK  $img"
  elif docker pull -q "docker.m.daocloud.io/$img" >/dev/null 2>&1; then
    docker tag "docker.m.daocloud.io/$img" "$img"
    echo "OK(mirror) $img"
  else
    FAILED="$FAILED $img"
    echo "FAIL $img"
  fi
done
if [ -n "$FAILED" ]; then
  echo ""
  echo "!! 以下镜像拉取失败，请稍后重跑本脚本或手动处理:$FAILED"
fi

echo "== [6/6] 启动全部服务 =="
docker compose pull --ignore-pull-failures >/dev/null 2>&1 || true
docker compose up -d
sleep 10
docker compose ps

cat <<DONE

=====================================================
 ✅ 自托管 Supabase 已启动
 
 ┌──────────── 密钥卡（务必保存！）────────────┐
 │ 公网 IP         : $SERVER_IP
 │ SUPABASE_URL    : http://$SERVER_IP        （经 Nginx 反代后前端用这个）
 │ ANON_KEY:
 │   $ANON_KEY
 │ SERVICE_ROLE_KEY:
 │   $SERVICE_ROLE_KEY
 │ 数据库密码(DB_PASSWORD):
 │   $DB_PASSWORD
 │ Studio 控制台账号: $DASH_USER
 │ Studio 控制台密码: $DASH_PASS
 └────────────────────────────────────────────┘
 
 验证:  curl http://127.0.0.1:8000/auth/v1/health
 Studio: 本机执行 ssh -L 3000:127.0.0.1:3000 root@$SERVER_IP
         然后浏览器打开 http://localhost:3000
 
 下一步: 按 README-DEPLOYMENT.md 第五节部署 Nginx 并发布站点
=====================================================
DONE

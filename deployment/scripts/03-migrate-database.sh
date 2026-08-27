#!/usr/bin/env bash
# =============================================================
# 03-migrate-database.sh — 云上 Supabase 数据库 → 自托管库 迁移 (v2)
#   在【新服务器】上运行。利用 supabase-db 容器内自带 pg_dump，
#   与云端 Postgres 版本一致，直接对拷。
#
#   v2 修正：先迁 auth 用户表，再还原 public 业务表，
#   避免业务表外键(auth.users)在用户未迁入时创建失败；
#   末尾追加 post-data 重放作为兜底。
#
# 用法:
#   CLOUD_DB_URI='postgresql://postgres.<项目ID>:<密码>@aws-0-x-x.pooler.supabase.com:5432/postgres' \
#     ./03-migrate-database.sh
#
# 内容:
#   1. auth.users/identities/sessions/refresh_tokens 用户数据迁移(账号密码保留)
#   2. public schema 全量(结构+数据+RLS+函数) 覆盖式还原到新库
#   3. 序列值校正, 重启 auth 服务, post-data 兜底补约束
#   4. 新库重跑 certificate-management.sql 补 Storage RLS 策略
#      （需先把 sql 文件放到 /tmp/certificate-management.sql）
# =============================================================
set -euo pipefail

CLOUD_DB_URI="${CLOUD_DB_URI:?请设置 CLOUD_DB_URI 环境变量（云 Supabase Session pooler 连接串）}"
DB_CONTAINER=supabase-db
PG_USER=supabase_admin

if [ ! "$(id -u)" -eq 0 ]; then echo "请用 root 运行"; exit 1; fi

echo "== [0/4] 连通性检查 =="
docker exec "$DB_CONTAINER" pg_isready -h localhost >/dev/null || {
  echo "supabase-db 未就绪，先确认 docker compose ps"; exit 1;
}

echo "== [1/4] 先迁移 auth 核心用户表（外键依赖，必须先于业务表）=="
docker exec "$DB_CONTAINER" pg_dump -Fc "$CLOUD_DB_URI" \
  --data-only \
  -t 'auth.users' -t 'auth.identities' \
  -t 'auth.sessions' -t 'auth.refresh_tokens' \
  -f /tmp/pr_auth.dump

docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c 'TRUNCATE auth.refresh_tokens, auth.sessions, auth.identities, auth.users CASCADE;'
docker exec "$DB_CONTAINER" pg_restore -U "$PG_USER" -d postgres \
  --data-only --disable-triggers \
  /tmp/pr_auth.dump

echo "-- 校正序列值 --"
docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d postgres <<'SQL'
SELECT setval(pg_get_serial_sequence('auth.identities','id'),
              COALESCE((SELECT MAX(id) FROM auth.identities),1), false);
SELECT setval(pg_get_serial_sequence('auth.refresh_tokens','id'),
              COALESCE((SELECT MAX(id) FROM auth.refresh_tokens),1), false);
SQL

echo "== [2/4] 导出云上 public schema 并覆盖式还原 =="
docker exec "$DB_CONTAINER" pg_dump -Fc "$CLOUD_DB_URI" \
  --schema=public \
  --no-owner --no-privileges \
  -f /tmp/pr_public.dump
echo "-- 还原 public --"
docker exec "$DB_CONTAINER" pg_restore -U "$PG_USER" -d postgres \
  --clean --if-exists --no-owner --no-privileges \
  /tmp/pr_public.dump || true
# ↑ grant/extension 相关告警可忽略，只要下方表计数正常即可
echo "-- post-data 兜底：重放索引/外键/触发器定义 --"
docker exec "$DB_CONTAINER" pg_restore -U "$PG_USER" -d postgres \
  --no-owner --no-privileges \
  --section=post-data \
  /tmp/pr_public.dump || true

echo "-- 重启 auth 使其重新加载用户表 --"
docker restart supabase-auth

echo "== [3/4] 业务表数量核对 =="
docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d postgres -c "
SELECT schemaname, relname AS table_name, n_live_tup AS rows
FROM pg_stat_user_tables
WHERE schemaname='public'
ORDER BY n_live_tup DESC
LIMIT 30;"

echo "== [4/4] 重跑 certificate-management.sql（补 Storage 桶与 RLS 策略）=="
CERT_SQL="/tmp/certificate-management.sql"
if [ ! -f "$CERT_SQL" ]; then
  echo "!! 未找到 $CERT_SQL"
  echo "   请先上传: 本地执行 scp sql/certificate-management.sql ubuntu@本机:/tmp/"
  echo "   或手动补跑: docker exec -i $DB_CONTAINER psql -U $PG_USER -d postgres < $CERT_SQL"
else
  docker exec -i "$DB_CONTAINER" psql -U "$PG_USER" -d postgres < "$CERT_SQL" || true
fi

cat <<DONE

=====================================================
 ✅ 数据库迁移完成
 
 请逐项核对：
 □ 上方表数量与你业务预期一致
 □ Studio(http://localhost:3000 SSH隧道)里能看到 auth.users 中的老账号
 □ 部署好 Nginx 后用原账号登录测试
 □ 接着按 README 执行 migrate-storage.mjs 搬运附件
=====================================================
DONE
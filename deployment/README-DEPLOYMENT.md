# 安全生产管理系统 — 腾讯云服务器自托管部署指南

> 目标：在腾讯云服务器（Ubuntu 22.04 / 2核4GB）上自建 Supabase，迁移云上全部数据，
> 系统改为从本机访问，之后云上 Supabase 可停用。
> 编写日期：2026-08-27

---

## 一、部署后架构

```
浏览器
  │  http://<服务器公网IP>
  ▼
Nginx (端口 80)
  ├── /                    → 静态站点文件 (/var/www/project-reporting)
  └── /rest/v1/*           → 反代到 Docker 内 Kong (127.0.0.1:8000)
      /auth/v1/*
      /storage/v1/*
      /realtime/v1/*
  ▼
自托管 Supabase (Docker Compose, 目录 /opt/supabase/docker)
  ├── supabase-db        PostgreSQL（数据保存在本机磁盘）
  ├── supabase-auth      登录认证 (GoTrue)
  ├── supabase-storage   附件存储
  └── ...其余组件
```

关键点：
- **8000/3000 端口只绑定本机回环**，外部只能走 Nginx 的 80 端口，更安全。
- 前端 `config.js` 切换后，页面与 API 同源（都在 http://IP 下），无跨域问题。
- 迁移完成并验证前，**云上 Supabase 完全不动**，随时可回滚。

---

## 二、准备材料清单

| 材料 | 用途 | 从哪里获取 |
|---|---|---|
| 服务器公网 IP | 配置各处 | 腾讯云控制台实例页 |
| 服务器 SSH root 密码/密钥 | 登录执行脚本 | 你买服务器时设置的 |
| 云 Supabase **service_role key** | 数据/附件导出 | 云 Supabase 控制台 → Settings → API |
| 云 Supabase **数据库连接串** | pg_dump 导出 | 云控制台 → Connect → Session pooler URI（形如 `postgresql://postgres.<项目ID>:<密码>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`）。注意把密码中的特殊字符 URL 编码。 |
| 本项目代码目录 | 发布前端 | `project-reporting/` |

---

## 三、阶段 A：服务器初始化

把 `deployment/scripts/` 整个目录上传到服务器（例如 scp）：

```bash
scp -r deployment user@<服务器IP>:~/deploy
ssh root@<服务器IP>
cd ~/deploy/scripts
chmod +x *.sh
./01-init-server.sh
```

脚本做了：系统更新、创建 4GB swap（**4GB 内存跑 Supabase 的必需项**）、安装 Docker
并配置腾讯云内网镜像加速、防火墙仅开放 22 和 80。

⚠️ 脚本会启用 ufw 防火墙，执行后请先确认能重新 SSH 登录，再继续下一步。

---

## 四、阶段 B：安装自托管 Supabase

```bash
./02-install-supabase.sh <你的公网IP>
```

脚本自动完成：
1. 克隆 supabase 官方仓库到 `/opt/supabase`（GitHub 拉不动时自动切换 ghfast 加速代理）；
2. `openssl` + `python3` 生成全新的 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY（无需联网去官网工具生成）；
3. 写入 `.env`：随机数据库密码、Studio 控制台账号密码、`SITE_URL=http://<IP>`；
4. 把 Kong(8000)/Studio(3000)/Analytics(4000) 等**所有对外端口绑定改到 127.0.0.1**（防止绕过 Nginx 直接暴露）；
5. 设置 `MAILER_AUTOCONFIRM=true`（本系统用户由 SQL 函数直接建档，不走邮件确认；新用户开箱即登录）；
6. 预拉取全部 Docker 镜像（Hub 失败自动尝试 daocloud 镜像源），然后 `docker compose up -d`。

结束时脚本会打印一份「密钥卡」，**务必复制保存 ANON_KEY / SERVICE_ROLE_KEY**
（后面 config.js 切换和附件迁移都要用）。

验证：

```bash
docker compose ps          # 所有容器 Up / healthy
curl http://127.0.0.1:8000/auth/v1/health
```

### 如何进入管理后台（Studio）

默认不对外网开放，通过 SSH 隧道访问。在你的 Windows 本机终端执行：

```bash
ssh -L 3000:127.0.0.1:3000 root@<服务器IP>
```

保持窗口开着，浏览器打开 `http://localhost:3000`，用 02 脚本生成的
DASHBOARD_USERNAME / DASHBOARD_PASSWORD 登录。

---

## 五、阶段 C：部署 Nginx 托管前端 + 反向代理 API

```bash
apt-get install -y nginx
cp ~/deploy/nginx-site.conf /etc/nginx/sites-available/project-reporting
ln -sf /etc/nginx/sites-available/project-reporting /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

此时发布站点文件：

```bash
mkdir -p /var/www/project-reporting
# 在本地 Windows（Git Bash）执行，排除 git 与开发预览文件：
rsync -av --delete --exclude '.git' \
  /c/Users/sjn/WorkBuddy/workbuddynewweb/project-reporting/ \
  root@<服务器IP>:/var/www/project-reporting/
```

（Windows 无 rsync 时可用 WinSCP 图形化上传整个目录代替。）

浏览器打开 `http://<服务器IP>` 应能看到登录页。

---

## 六、阶段 D：数据迁移

### 6.1 数据库（月报数据 + 用户账号）

```bash
CLOUD_DB_URI='postgresql://postgres.exwsuwhqqpsqekzkmdol:<数据库密码>@aws-0-xxxx.pooler.supabase.com:5432/postgres' \
  ./03-migrate-database.sh
```

脚本在你自己的新库容器里调用同版本 `pg_dump` 直接拉取云上数据（两库对拷，不用中转文件到本机）：

1. `public` schema 全量结构+数据+RLS（业务表/策略一应俱全）→ `--clean` 覆盖式还原到新库；
2. `auth` 核心四表（users / identities / sessions / refresh_tokens）数据导入（保留所有账号和密码）；
3. 重置序列值；重启 auth 容器使其重新加载用户表。

> ⚠️ 迁移前置检查：如果 `sql/certificate-management.sql` 还没在云端执行过，请先去
> 云 Supabase 控制台 SQL Editor 里执行一遍，再回来做迁移，否则证照相关表不在 dump 里。

由于 `certificate-management.sql` 幂等且 storage 策略属于新库需要补的部分，
脚本最后一步会在**新库**重跑一次该文件（补齐 buckets 记录与 storage.objects 上的 RLS 策略）。

### 6.2 附件存储（certificates 桶内的 PDF/图片）

附件文件本体不在数据库里，要用脚本单独搬运。在**你的本地电脑**（有 Node 22 即可）执行：

```bash
cd project-reporting/deployment/scripts

OLD_PROJECT_URL=https://exwsuwhqqpsqekzkmdol.supabase.co \
OLD_SERVICE_ROLE_KEY=<云端service_role> \
NEW_PROJECT_URL=http://<服务器IP> \
NEW_SERVICE_ROLE_KEY=<新机service_role> \
node migrate-storage.mjs
```

脚本行为：列出旧项目全部桶 → 新端建同名桶 → 递归下载旧桶所有对象 → upsert 上传到新桶，
逐个校验跳过已存在文件，可中断后重跑续传。

---

## 七、阶段 E：切换前端配置并正式上线

编辑本地 `js/config.js` 两行常量：

```js
const SUPABASE_URL = 'http://<服务器IP>';
const SUPABASE_ANON_KEY = '<02脚本输出的新ANON_KEY>';
```

然后：

```bash
node --check js/config.js     # 语法校验
git add . && git commit -m "切换后端至自托管 Supabase (<服务器IP>)" && git push origin main
# 再用第五节的 rsync / WinSCP 把更新后的文件同步到 /var/www/project-reporting
```

## 八、验收清单

- [ ] `http://<IP>` 能打开登录页
- [ ] 用原有账号能正常登录（证明 auth 迁移成功）
- [ ] 仪表盘 / 月报列表历史数据显示正常
- [ ] 资质证照模块：台账打开、统计卡片数字与云上一致
- [ ] 上传一个新的证照附件成功，点开可预览（证明 storage 迁移成功）
- [ ] 新建一条测试数据→在云 Supabase 控制台确认该条**不出现**在云上（确认流量真的走了新库）
- [ ] 观察 3 天无问题后，云 Supabase 项目可以在云端暂停（Pause），随时再等一周彻底删除

## 九、常见问题

| 现象 | 处理 |
|---|---|
| docker pull 卡住/失败 | 重跑 02 脚本的镜像预拉段落，或手动加国内代理前缀拉取后 retag |
| `docker compose ps` 有容器 restarting | `docker logs <容器名>` 查看；通常是内存不足 → 确认 swap 已生效（`free -h`）|
| 登录报 401 | 确认 config.js 用的 ANON_KEY 是**新实例**的 key，不是云端的 |
| 数据库 restore 冒出 grant/extension 报错 | 一般是角色/扩展权限类提示，只要末尾表格数据 count 对得上即可忽略 |
| 上传附件 403 | 检查 03 脚本是否重跑了 certificate-management.sql（storage RLS） |
| 手机号验证码注册 | 自托管需自行配置短信 provider，目前系统以管理员建号为主，不受影响 |

## 十、回滚方案

整个切换期云端库原样未动：
1. 把 `config.js` 改回原两行 → `git commit/push` → 重新同步到服务器即回到云 Supabase；
2. 已上传到新机的附件仅在切换期内产生的少量增量，按人肉补录云上即可。

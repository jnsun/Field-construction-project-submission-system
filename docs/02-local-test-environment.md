# D02：本地测试环境、备份与匿名测试数据

## 环境边界

| 环境 | 用途 | 配置 |
| --- | --- | --- |
| development | 本机静态页面 | `.env` 中 `SAFETY_ENV=development`，不得指向生产库 |
| test | 自动化、夹具、权限测试 | 独立 Supabase 项目，`SAFETY_ENV=test` |
| staging | 发布前人工验收 | 独立项目和域名，禁止真实员工资料 |
| production | 正式业务 | 禁止运行 D02 夹具和清理脚本 |

复制 `.env.example` 为本机 `.env` 后只填写变量值。变量名包括 `SAFETY_TEST_DB_URL`、`SAFETY_SUPABASE_URL`、`SAFETY_SUPABASE_ANON_KEY`、测试账号变量和 `SAFETY_QR_TEST_SIGNING_KEY`；不在仓库保存真实值。现有前端静态配置的内联配置治理仍归 T19，D02 不改生产连接。

## 启动、迁移与夹具

1. `powershell -ExecutionPolicy Bypass -File tools/start-local.ps1` 启动静态站点。
2. 在独立测试数据库按 D00 的迁移清单执行 SQL，先做完整备份。
3. 在同一 SQL 会话先执行 `SET app.safety_test_confirmation = 'D02_TEST_ONLY';`，再执行 `sql/test-environment-v1.sql`。
4. 夹具创建 10 个匿名人员：安全管理员、两实体管理场景、项目经理、安全员、普通员工、外协、高危钻探/电工、领导访客、无权限和证照过期场景。登录账号必须在测试项目中使用现有账号管理流程单独创建和绑定，不能复制生产账号。
5. 普通和高危项目、暂停/复工/关闭/重开状态必须通过现有 `site_project_*` RPC 由测试管理员建立，避免直接绕过 RLS。

## 备份、恢复与清理

```powershell
tools/backup-test-db.ps1 -DatabaseUrl $env:SAFETY_TEST_DB_URL
tools/restore-test-db.ps1 -DatabaseUrl $env:SAFETY_TEST_DB_URL -BackupFile backups/safety-<timestamp>-full.dump
```

两个 PowerShell 脚本拒绝不含 `test`、`staging` 或 `dev` 标识的地址。清理时先备份，在 SQL 会话设置同一确认变量后执行 `tools/clear-test-fixtures.sql`。清理仅依据 `safety_test_fixture_registry` 中的 UUID 删除，绝不按姓名、手机号或模糊前缀删除生产记录。

## 消息、文件与二维码替身

- 测试阶段只启用站内提醒；不配置真实短信、微信订阅或邮件投递。
- 文件使用独立测试 Supabase 项目的 `certificates` 和 `training-courses` 桶，上传路径须含 `d02-test/`。
- 二维码测试只使用 `SAFETY_QR_TEST_SIGNING_KEY` 本地变量；生产核验密钥不得复制到测试环境。

## 验收与限制

运行 `node tests/audit-handlers.js` 前，将 Node 加入 PATH。浏览器 E2E 还需启动 Chrome 调试端口 `127.0.0.1:9333`。当前机器未发现 PostgreSQL 客户端工具，故未执行真实备份、恢复、迁移或清理；安装后可按上方命令完成演练。

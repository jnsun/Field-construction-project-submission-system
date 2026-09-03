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
5. 执行 `sql/test-environment-v2-projects-storage.sql` 建立普通、高危、暂停和关闭后重开项目、外协单位、特种证照与私有文件桶；所有数据均登记为 `D02-TEST`。
6. 项目经理、安全员和员工账号必须在测试项目中通过既有账号管理流程创建并绑定对应 D02 员工档案；账号密码只保存于本机 `.env`，不进入仓库。

## 执行记录

- 2026-09-03：项目负责人确认当前 Supabase 项目尚未承载生产环境，指定为本项目测试库；已执行 D02 匿名人员和部门夹具并核验成功：10 名人员、3 个部门、13 条夹具登记记录。
- 控制台显示 `main Production` 为 Supabase 分支标签，不代表本项目已上线生产。后续测试账号、项目状态、文件桶和消息替身夹具均在该指定测试库建立，并继续使用匿名测试数据。
- 本次数据均带 `D02-TEST` 或 `[D02-TEST]` 标记，可用 `tools/clear-test-fixtures.sql` 清理。不得将其与真实员工、项目、合同或证照关联。
- D02 第二阶段夹具会创建 `D02-NORMAL`、`D02-HIGH-RISK`、`D02-PAUSED`、`D02-REOPENED` 四个项目，以及 `training-courses`、`certificates` 两个私有桶；不创建或上传真实文件。
- 2026-09-03：隔离 `safety-d03-migration-test` 项目已执行 D02 第一、二阶段夹具，并核验 3 个匿名账号绑定、4 个项目状态夹具和 2 个私有桶。账号密码不进入仓库、文档或对话；后续实时自动化前由测试管理员在本机 `.env` 配置后运行。
- 2026-09-03：本机 PostgreSQL 17 客户端已可用；首次 `pg_dump` 连接到测试项目的 Session pooler 时被数据库密码认证拒绝，未生成有效备份。须在 Supabase Dashboard 的 Connect 面板重新复制包含正确数据库密码的测试连接串后重试。
- 2026-09-03：已成功生成并用 `pg_restore --list` 验证测试库完整备份与结构 SQL 备份。D02 清理、重建验证完成：清理仅删除 4 个项目、1 个外协单位、10 名人员、3 个部门及 18 条登记；重建后恢复 10 名人员、3 个部门、4 个项目状态、2 个私有桶和 3 个匿名登录账号绑定。
- 2026-09-03：清理验证发现项目删除审计触发器使用 `AFTER DELETE` 时会违反审计表外键；已在测试库应用 `training-admission-v48-project-audit-delete-fix.sql`，改为新增/更新后审计、删除前审计。后续环境须按迁移顺序包含该修复。

## 备份、恢复与清理

```powershell
tools/backup-test-db.ps1 -DatabaseUrl $env:SAFETY_TEST_DB_URL -ExpectedProjectRef '<TEST_PROJECT_REF>'
tools/restore-test-db.ps1 -DatabaseUrl $env:SAFETY_TEST_DB_URL -BackupFile backups/safety-<timestamp>-full.dump
```

备份脚本拒绝不含 `test`、`staging` 或 `dev` 标识的地址；若项目引用不含环境关键词，必须显式提供测试项目引用并与连接串匹配。清理时先备份，在 SQL 会话设置同一确认变量后执行 `tools/clear-test-fixtures.sql`。清理仅依据 `safety_test_fixture_registry` 中的 UUID 删除，绝不按姓名、手机号或模糊前缀删除生产记录。

## 消息、文件与二维码替身

- 测试阶段只启用站内提醒；不配置真实短信、微信订阅或邮件投递。
- 文件使用独立测试 Supabase 项目的 `certificates` 和 `training-courses` 桶，上传路径须含 `d02-test/`。
- 二维码测试只使用 `SAFETY_QR_TEST_SIGNING_KEY` 本地变量；生产核验密钥不得复制到测试环境。

## 验收与限制

运行 `node tests/audit-handlers.js` 前，将 Node 加入 PATH。浏览器 E2E 还需启动 Chrome 调试端口 `127.0.0.1:9333`。当前机器已安装 PostgreSQL 客户端工具；测试库完整/结构备份已生成并通过 `pg_restore --list` 校验，夹具清理和重建已完成。D03 仍须单独完成匿名历史副本迁移和恢复演练，不把该后续验证写为 D02 已通过。

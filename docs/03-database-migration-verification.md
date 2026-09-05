# D03：数据库迁移与恢复完整性验证

## Scope and current status

本任务盘点并验证 `training-admission-v1.sql` 至 `training-admission-v50-notification-settings-rls.sql`。其中 v1-v16 依赖既有月报、组织、账号、培训、在线学习、考试和人员基础，不能脱离 bootstrap 文件直接重放到字面空库。

当前指定测试库在本轮开始时是带匿名 `D02-TEST` 夹具的 v17 前副本。它不是生产库；运行器要求 `SAFETY_ENV=test`、`D03_TEST_ONLY` 和夹具登记，缺任一条件即拒绝执行。

## Controlled migration chain

[training-admission-v1-v16.manifest.json](../sql/training-admission-v1-v16.manifest.json) is the single D03 source of truth. It records:

- The required empty-database bootstrap order.
- Versions 1 through 16 in numeric order and their SHA-256 digests.
- The post-v16 security hardening migration.

[training-admission-v17-v49.manifest.json](../sql/training-admission-v17-v49.manifest.json) 保持历史文件名，但其内容已固化 v17-v50 共 34 个迁移的顺序与归一化 LF 换行 SHA-256。`tests/verify-d03-migration-files.js` 现同时验证两份清单，共 50 个版本、18 个 bootstrap 文件、文件存在性、顺序、哈希、破坏性表操作和 `SECURITY DEFINER` 静态写法。

For a fresh test database, run the bootstrap files only through [run-d03-migration-verification.ps1](../tools/run-d03-migration-verification.ps1); do not execute deprecated `department-management.sql`.

`login-account.sql` is intentionally before `phone-login.sql`: the latter reuses `change_own_email()` and fails on a clean database if that dependency is skipped.

`d03-department-bootstrap-compat.sql` is intentionally before `department-tree.sql`: it creates the two reporting-view columns that the active department scripts require but no longer create from `schema.sql`.

`d03-training-signatures-bootstrap-compat.sql` resolves an online-learning and exam-module cycle by creating the exact assignment and signature tables before online-learning Storage policies reference them.

`d03-project-reports-bootstrap-compat.sql` restores the legacy `project_reports.project_status` column expected by v1 and v16. It is an idempotent empty-database bridge and leaves the original `schema.sql` baseline unchanged.

## Test procedure

Install PostgreSQL client tools (`psql`, `pg_dump`, and `pg_restore`) locally. Keep the target database URL only in the terminal or local environment; do not place it in the repository.

```powershell
node tests/verify-d03-migration-files.js
powershell -ExecutionPolicy Bypass -File tools/run-d03-migration-verification.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -Scenario Empty -IncludeBootstrap -TestConfirmation D03_TEST_ONLY
```

For an anonymized historical copy, restore the backup into a separate pre-v17 test database, then run the same script without `-IncludeBootstrap`:

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-d03-migration-verification.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -Scenario Historical -TestConfirmation D03_TEST_ONLY
```

对于本项目当前的匿名 v17 前测试副本，执行后续链使用：

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-d03-current-chain-verification.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -TestConfirmation D03_TEST_ONLY
```

该工具先创建完整/结构备份与数据指纹，按账本执行或跳过 v17-v50，随后导出对象清单和迁移后备份。账本哈希不匹配会拒绝重放；缺失 D02 匿名夹具或非 `test` 环境会拒绝执行。

The runner creates local full and schema backup artifacts, captures exact row-count fingerprints before and after migration, writes a CSV schema inventory, and records each verified migration in `public.safety_schema_migrations`. A digest mismatch fails closed; a matching ledger entry is skipped, making the runner repeat-safe.

## Restore drill

Restore only into a disposable test database:

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-d03-restore-drill.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -BackupFile test-results/d03/<run>/before-full.dump `
  -TestConfirmation D03_TEST_ONLY
```

恢复工具只恢复应用拥有的 `public` 对象。随后它运行 `sql/d03-storage-application-config.sql`，以受版本控制、来源可追溯的 SQL 重建应用 Storage 的私有桶和对象策略；不会从归档 TOC 恢复 `storage.objects`。Supabase 托管事件触发器、Storage 内部表、约束和索引不属于应用恢复范围。任何行数、`public` 结构、RLS、策略或函数签名差异都属于失败。

## Storage recovery boundary

D03 的应用归档固定为 `pg_dump --schema=public`，由共享 `tools/d03-archive.ps1` 执行。`config/d03-storage-application-boundary.json` 列出每个应用桶、策略及其原始 SQL 来源；`sql/d03-storage-application-config.sql` 是仅重建 Storage 配置的幂等初始化器。`tests/verify-d03-storage-boundary.js` 同时验证来源、初始化器和归档范围。

- D03 负责：`public` schema 的数据和结构；`training-courses`、`certificates`、`avatars` 三个私有桶配置；来源已核对的 `storage.objects` 应用策略。
- D03 不负责：`storage.objects` 行、Storage 平台对象/索引/约束、Supabase `auth` schema、以及任何真实文件字节。
- INF02 负责：文件字节与对象元数据的一致性备份、保留、加密、异地副本和真实恢复演练。D03 不得宣称完整 Storage 灾备已经通过。

## Security checks

[training-admission-v16-d03-hardening.sql](../sql/training-admission-v16-d03-hardening.sql) verifies that all v1-v16 `SECURITY DEFINER` functions have a fixed `search_path` beginning with `public` (the approved `public, vault` variant is allowed for encrypted identity functions), revokes default `PUBLIC` and `anon` execution, and grants only intended RPCs to `authenticated`. Trigger and policy helper functions remain non-callable.

The schema inventory records tables, columns, constraints, indexes, functions, triggers, RLS, policies, and the relevant Storage bucket/policy metadata. It contains no credentials or personal data.

## Acceptance evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Manifest covers v1-v50 in order | 通过 | `node tests/verify-d03-migration-files.js`，50 个版本、18 个 bootstrap 文件 |
| Hash and static safety checks | 通过 | v1-v50 清单、静态危险 SQL 与 `SECURITY DEFINER` 写法检查 |
| v0 至 v16 匿名历史重放 | 通过 | `DisposableReplay-20260904234033-c16fc959/v1-v16`：19 个匿名历史数据指纹 |
| v17 至 v50 与幂等账本 | 通过 | 同一运行：50 条账本记录，重复运行已验证，不重复写入 |
| 应用范围归档边界 | 通过 | `after-full.dump` 597,338 字节，SHA-256 `8266AE1D8AA8B60729764098FAAF4BB66E9AF9FAAED8913FEEE911803E6BE5A7`；878 条目录项，`auth`/`storage` 及其他 Supabase 平台对象均为 0 |
| 无人干预恢复与重复恢复 | 通过 | 同一运行：534 个结构对象、19 个数据指纹、22 个 RLS 表、53 条策略、12 个函数、13 个触发器、51 个索引、133 条约束；两次恢复均一致 |
| v50 通知设置 RLS/RPC | 通过 | `notification-settings-rpc-20260904185422/result.json`：RLS 启用、无 anon/authenticated 直表读写、公司级 RPC 允许、普通员工拒绝 |

## 2026-09-05 v50 TARGETED 与 FINAL 证据

- TARGETED：`targeted-20260904231643/short-path-20260904231655-c575b8ed` 在全新可丢弃数据库完成；v1-v50 迁移账本恰好 50 条，归档边界、RLS、通知设置 RPC、注册触发器首次/重复恢复和 Storage 应用配置均通过，临时数据库已删除。
- FINAL：`DisposableReplay-20260904234033-c16fc959` 在一个新源库和一个新恢复库中一次完成，总时长 1,987.883 秒。源库与恢复库均已自动删除，临时数据库残留为 0。
- FINAL 的 19 项历史业务数据指纹在迁移和两次恢复后均一致；迁移账本技术表已从业务数据指纹比对中排除。
- `training_admission_notification_settings` 的 v50 迁移仅启用 RLS，不增加直表策略或直表授权。应用继续经既有 `training_get_notification_settings()` 与 `training_update_notification_settings(...)` 公司级 `SECURITY DEFINER` RPC 访问；两者固定 `search_path=public`，仅 `authenticated` 有 `EXECUTE`，且不接受公司、人员或 UUID 范围参数。
- D03 日志秘密模式扫描结果为 0；所有命令只访问指定测试项目，未连接生产环境。

## D03 结论

D03 为 `PASS`：v0-v50 完整链、v50 RLS、应用范围归档、无人干预首次/重复恢复、结构与数据指纹、Storage 应用配置、诊断 JSON 和临时库清理均有真实测试证据；受限 R01 复查已通过，R03 交接已完成。T24 数据库门已通过，D04 前置已满足。INF02 Storage 文件字节灾备仍为独立后续任务，不阻塞 D04。

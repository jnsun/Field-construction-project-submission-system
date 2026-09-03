# D03：数据库迁移与恢复完整性验证

## Scope and current status

本任务盘点并验证 `training-admission-v1.sql` 至 `training-admission-v49-security-baseline.sql`。其中 v1-v16 依赖既有月报、组织、账号、培训、在线学习、考试和人员基础，不能脱离 bootstrap 文件直接重放到字面空库。

当前指定测试库在本轮开始时是带匿名 `D02-TEST` 夹具的 v17 前副本。它不是生产库；运行器要求 `SAFETY_ENV=test`、`D03_TEST_ONLY` 和夹具登记，缺任一条件即拒绝执行。

## Controlled migration chain

[training-admission-v1-v16.manifest.json](../sql/training-admission-v1-v16.manifest.json) is the single D03 source of truth. It records:

- The required empty-database bootstrap order.
- Versions 1 through 16 in numeric order and their SHA-256 digests.
- The post-v16 security hardening migration.

[training-admission-v17-v49.manifest.json](../sql/training-admission-v17-v49.manifest.json) 固化后续 33 个迁移的顺序与归一化 LF 换行 SHA-256。`tests/verify-d03-migration-files.js` 现同时验证两份清单，共 49 个版本、18 个 bootstrap 文件、文件存在性、顺序、哈希、破坏性表操作和 `SECURITY DEFINER` 静态写法。

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

该工具先创建完整/结构备份与数据指纹，按账本执行或跳过 v17-v49，随后导出对象清单和迁移后备份。账本哈希不匹配会拒绝重放；缺失 D02 匿名夹具或非 `test` 环境会拒绝执行。

The runner creates local full and schema backup artifacts, captures exact row-count fingerprints before and after migration, writes a CSV schema inventory, and records each verified migration in `public.safety_schema_migrations`. A digest mismatch fails closed; a matching ledger entry is skipped, making the runner repeat-safe.

## Restore drill

Restore only into a disposable test database:

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-d03-restore-drill.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -BackupFile test-results/d03/<run>/before-full.dump `
  -TestConfirmation D03_TEST_ONLY
```

恢复工具只恢复应用拥有的 `public` 对象；Supabase 托管事件触发器、Storage 内部表、约束和索引不属于应用恢复范围。恢复后会按需从归档 TOC 仅恢复缺失的 `storage.objects` 应用策略，再将清单与 `after-schema.csv` 比对。任何行数、结构、RLS、策略或函数签名差异都属于失败。

## Security checks

[training-admission-v16-d03-hardening.sql](../sql/training-admission-v16-d03-hardening.sql) verifies that all v1-v16 `SECURITY DEFINER` functions have a fixed `search_path` beginning with `public` (the approved `public, vault` variant is allowed for encrypted identity functions), revokes default `PUBLIC` and `anon` execution, and grants only intended RPCs to `authenticated`. Trigger and policy helper functions remain non-callable.

The schema inventory records tables, columns, constraints, indexes, functions, triggers, RLS, policies, and the relevant Storage bucket/policy metadata. It contains no credentials or personal data.

## Acceptance evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Manifest covers v1-v49 in order | 通过 | `node tests/verify-d03-migration-files.js`，49 个版本、18 个 bootstrap 文件 |
| Hash and static safety checks | 通过 | v1-v49 清单、静态危险 SQL 与 `SECURITY DEFINER` 写法检查 |
| Empty database migration | Passed on 2026-09-03 in isolated `safety-d03-migration-test` Supabase project; bootstrap bridges, v1-v16 and post-v16 hardening all completed | Dashboard SQL execution log and object-existence query; no production data used |
| 匿名历史数据副本：v17-v49 | 通过 | `CurrentChain-20260903-213923`：33 条账本记录、17 个历史指纹表迁移前后相同 |
| 匿名历史数据副本：v1-v16 重放 | 未完成 | 当前仅有空库执行证据；未取得可单独恢复的 v1 前匿名历史副本 |
| 备份与恢复演练 | 部分通过 | 应用范围恢复后 527 个对象与 17 个数据指纹相同；Supabase 全量恢复被托管对象权限阻断 |
| 当前测试数据库结构检查 | 通过 | D03 选择范围共 527 项：22 表、247 列、133 约束、51 索引、12 函数、13 触发器、31 策略、2 桶、16 Storage 策略；测试库的全部 50 个 `public` 表均启用 RLS |

## Current test database read-only findings

- D03 清单中的 22 个目标应用表，以及当前测试库中全部 50 个 `public` 表，均启用 RLS；当前 Storage 策略为 16 条，两个测试桶均在清单内。
- 当前 137 个 `SECURITY DEFINER` 函数均有固定 `search_path`，且 `PUBLIC`/`anon` 执行授权为 0。完整角色穿透、导出、二维码和签字安全验收仍由 D05 负责。
- 失败的 Supabase 全量恢复尝试会因平台事件触发器及 `storage` 内部对象所有权返回错误；最终应用范围恢复后，函数授权、RLS、策略和 Storage 应用策略均与迁移后源清单一致。

## 2026-09-03 isolated empty-database evidence

- 在隔离 Supabase 测试项目执行 bootstrap、v1-v16 和 v16 hardening 成功；bootstrap bridge 覆盖 `change_own_email()`、部门报送列、在线学习签字循环和 `project_reports.project_status` 依赖。
- 2026-09-03：在带 18 条 `D02-TEST` 夹具登记的 v17 前匿名副本实际执行 v17-v49，生成 33 条迁移账本记录；第二次运行逐项校验哈希并跳过全部 33 条。
- `CurrentChain-20260903-213923` 保存了迁移前后完整/结构备份、数据指纹与对象清单。17 个历史相关表及 `storage.objects` 的计数/哈希在迁移前后相同。
- 首次全量 `pg_restore --clean` 被 Supabase 平台事件触发器与 Storage 内部对象权限阻断；应用范围恢复后，最终 527 项结构清单和 17 个数据指纹均与迁移后备份源一致。全托管 Supabase 级恢复仍不能标为通过。

## D03 结论

D03 为 `PARTIAL`：迁移清单、空库 v1-v16、匿名 v17-v49、幂等账本、对象清单、历史数据指纹和应用范围恢复均已有真实证据；但 v1-v16 在独立匿名历史副本上的重放，以及不涉及 Supabase 托管对象的全自动恢复流程仍未闭环。不得据此宣称 T24 已通过或 G0 已放行。

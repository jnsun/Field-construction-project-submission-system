# D03: Database v1-v16 migration verification

## Scope and current status

This task controls `training-admission-v1.sql` through `training-admission-v16.sql` only. These scripts require the existing monthly-reporting, organization, account, training, online-learning, exam, and personnel foundations; they cannot be safely applied to a literally empty database by themselves.

The current designated test database already contains v17+ objects. It is suitable for read-only structure inspection and later feature tests, but the D03 runner deliberately refuses to replay v1-v16 there because doing so could replace newer RPC definitions with older ones.

## Controlled migration chain

[training-admission-v1-v16.manifest.json](../sql/training-admission-v1-v16.manifest.json) is the single D03 source of truth. It records:

- The required empty-database bootstrap order.
- Versions 1 through 16 in numeric order and their SHA-256 digests.
- The post-v16 security hardening migration.

For a fresh test database, run the bootstrap files only through [run-d03-migration-verification.ps1](../tools/run-d03-migration-verification.ps1); do not execute deprecated `department-management.sql`.

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

The runner creates local full and schema backup artifacts, captures exact row-count fingerprints before and after migration, writes a CSV schema inventory, and records each verified migration in `public.safety_schema_migrations`. A digest mismatch fails closed; a matching ledger entry is skipped, making the runner repeat-safe.

## Restore drill

Restore only into a disposable test database:

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-d03-restore-drill.ps1 `
  -DatabaseUrl $env:SAFETY_TEST_DB_URL `
  -BackupFile test-results/d03/<run>/before-full.dump `
  -TestConfirmation D03_TEST_ONLY
```

The output inventory must be compared with the source-run `after-schema.csv`. A restore that changes historical row counts, key constraints, RLS settings, policies, or function signatures is a failed drill.

## Security checks

[training-admission-v16-d03-hardening.sql](../sql/training-admission-v16-d03-hardening.sql) verifies that all v1-v16 `SECURITY DEFINER` functions have a fixed `search_path` beginning with `public` (the approved `public, vault` variant is allowed for encrypted identity functions), revokes default `PUBLIC` and `anon` execution, and grants only intended RPCs to `authenticated`. Trigger and policy helper functions remain non-callable.

The schema inventory records tables, columns, constraints, indexes, functions, triggers, RLS, policies, and the relevant Storage bucket/policy metadata. It contains no credentials or personal data.

## Acceptance evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Manifest covers v1-v16 in order | Ready for automated validation | `tests/verify-d03-migration-files.js` |
| Hash and static safety checks | Ready for automated validation | `tests/verify-d03-migration-files.js` |
| Empty database migration | Blocked pending disposable Supabase project or local PostgreSQL | Runner output under `test-results/d03/` |
| Anonymized historical-copy migration | Blocked pending sanitized backup and restore target | Runner output under `test-results/d03/` |
| Backup and restore drill | Blocked pending PostgreSQL client tools and disposable target | `tools/run-d03-restore-drill.ps1` |
| Current test database structure inspection | Ready; read-only | `sql/d03-schema-inventory.sql` |

## Current test database read-only findings

- All 8 sampled v1-v16 core tables exist and have RLS enabled.
- A v17 sentinel function exists, so the D03 runner correctly blocks an in-place v1-v16 replay.
- The v1-v16 function-name set currently contains 49 `SECURITY DEFINER` overloads. All have a fixed search path when the approved `public, vault` variant is included, but all 49 are still executable by `PUBLIC` and `anon` until the D03 hardening SQL is applied.
- Five Storage object policies reference the `training-courses` bucket. Full policy-definition comparison remains part of the isolated migration run.

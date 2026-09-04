# D03 Storage Recovery Boundary

## Decision

D03 uses `pg_dump --schema=public` only. `pg_dump` and `pg_restore` are PostgreSQL tools; using them to carry the full Supabase `storage` schema also carries platform-managed tables, constraints and indexes that the application does not own. The local CLI is Supabase `2.116.0`; its `db dump` interface supports selecting schemas but does not turn PostgreSQL dump output into a backup of Storage object bytes.

Option B is adopted: archive application `public` data and reconstruct Storage configuration from source-controlled SQL. This keeps the existing native `pg_dump` diagnostics while removing unmanaged Storage platform DDL from D03 artifacts.

## D03-owned recovery scope

| Item | D03 treatment | Evidence source |
| --- | --- | --- |
| `public` schema data and structure | archived and restored | `tools/d03-archive.ps1` |
| private bucket configuration | rebuilt | `config/d03-storage-application-boundary.json` |
| application `storage.objects` policies | rebuilt | `sql/d03-storage-application-config.sql` |
| application-defined Storage indexes | none currently evidenced | manifest `application_storage_indexes` |
| application-defined Storage grants | none currently evidenced | manifest `application_storage_grants` |
| `storage.objects` rows and real object bytes | excluded | INF02 |
| Storage platform tables, indexes, constraints, triggers | excluded | Supabase platform responsibility |
| `auth` schema and platform roles | excluded | Supabase platform responsibility |

The initializer is intentionally limited to bucket privacy and `storage.objects` policies. It does not update public business tables, create object rows or write files. Its statements are source-faithful copies of the listed migration/baseline SQL and are idempotent through explicit policy replacement and bucket upsert.

## Short-path acceptance

The disposable short path must: create a fresh test database; run v1-v49; seed anonymous fixtures; run the Storage initializer; verify every manifest bucket is private and every manifest policy exists; create a public-only archive; verify the archive list contains no `auth` or `storage` objects; and remove the database. A successful short path is necessary evidence for later D03 recovery work, but does not mark D03 complete.

## INF02 trial blocker

INF02 must implement and rehearse a separate object-store backup/recovery procedure before pilot release. It must cover file-byte backup, object metadata consistency with `storage.objects`, retention, encryption and access control, offsite copy, file hashes/counts, restore-to-disposable-environment verification, and a documented recovery point/time objective. D03 cannot substitute for that work.

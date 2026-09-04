# INF02 Storage Object Backup and Recovery

## Status

Not started. This is a pilot-release blocker for any workflow that relies on uploaded training material, signatures, evidence photos, certificates or contractor documents.

## Scope

- Back up actual private Storage object bytes independently of PostgreSQL dumps.
- Preserve a consistent inventory of object bucket, path, size, hash and metadata.
- Protect backups with encryption, restricted access, retention and an offsite copy.
- Restore into a disposable environment, then verify object count, hashes, metadata consistency and signed-download access rules.
- Define RPO/RTO, monitoring, failures, operator ownership and evidence retention.

## Explicit boundary

D03 backs up `public` only and reconstructs source-backed Storage configuration. It does not back up `storage.objects` rows or any object bytes. A successful D03 test must not be cited as an INF02 storage-object recovery test.

## Acceptance evidence

1. Automated backup produces an encrypted, access-controlled object inventory and byte archive.
2. A disposable restore verifies count/hash/metadata consistency without using production data.
3. Restore logs identify duration, source/target, failures and operator without recording secrets.
4. The recovery procedure is exercised before pilot release and on the agreed schedule thereafter.

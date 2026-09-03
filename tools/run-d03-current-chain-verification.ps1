param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [string]$OutputDir = 'test-results/d03'
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing D03 run without TestConfirmation D03_TEST_ONLY.' }
if ($EnvironmentName -ne 'test') { throw 'D03 current-chain verification requires SAFETY_ENV=test.' }
if ($DatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'DatabaseUrl still contains a placeholder.' }

$psql = Get-Command psql -ErrorAction SilentlyContinue
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $psql -or -not $pgDump) { throw 'D03 requires PostgreSQL client tools: psql and pg_dump.' }

$repo = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $repo 'sql'
$manifest = Get-Content -Raw (Join-Path $sqlDir 'training-admission-v17-v49.manifest.json') | ConvertFrom-Json
$fixtureCount = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key = 'D02-TEST-20260903';"
if ([int]$fixtureCount.Trim() -lt 1) { throw 'Target lacks the D02 anonymous-test fixture marker; refusing current-chain verification.' }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutputDir "CurrentChain-$stamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

& $pgDump.Source --format=custom --file (Join-Path $runDir 'before-full.dump') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration full backup.' }
& $pgDump.Source --schema-only --format=plain --file (Join-Path $runDir 'before-schema.sql') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration schema backup.' }
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'before-data.csv')

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c @'
CREATE TABLE IF NOT EXISTS public.safety_schema_migrations (
  migration_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
'@

foreach ($migration in $manifest.migrations) {
  $key = "training-admission-v$($migration.version)"
  $applied = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = '$key';"
  if ($applied) {
    if ($applied.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Checksum mismatch for $key; refusing replay." }
    Write-Output "Skip ${key}: matching ledger entry."
    continue
  }
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $migration.file)
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $key. Restore from $runDir\before-full.dump before retrying." }
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c "INSERT INTO public.safety_schema_migrations(migration_key, sha256) VALUES ('$key', '$($migration.sha256)');"
}

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-data.csv')
& node (Join-Path $repo 'tests\compare-d03-fingerprints.js') (Join-Path $runDir 'before-data.csv') (Join-Path $runDir 'after-data.csv')
if ($LASTEXITCODE -ne 0) { throw 'Historical fingerprint verification failed.' }
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-schema-inventory.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-schema.csv')
& $pgDump.Source --format=custom --file (Join-Path $runDir 'after-full.dump') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the post-migration full backup.' }
& $pgDump.Source --schema-only --format=plain --file (Join-Path $runDir 'after-schema.sql') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the post-migration schema backup.' }
Write-Output "D03 current-chain verification complete: $runDir"

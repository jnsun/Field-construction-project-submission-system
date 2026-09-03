param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [ValidateSet('Empty', 'Historical')][string]$Scenario = 'Historical',
  [string]$OutputDir = 'test-results/d03',
  [switch]$IncludeBootstrap,
  [Parameter(Mandatory = $true)][string]$TestConfirmation
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing D03 run without TestConfirmation D03_TEST_ONLY.' }
if ($DatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'DatabaseUrl still contains a placeholder.' }
$psql = Get-Command psql -ErrorAction SilentlyContinue
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $psql -or -not $pgDump) { throw 'D03 requires PostgreSQL client tools: psql and pg_dump.' }

$repo = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $repo 'sql'
$manifest = Get-Content -Raw (Join-Path $sqlDir 'training-admission-v1-v16.manifest.json') | ConvertFrom-Json
if ($Scenario -eq 'Empty' -and -not $IncludeBootstrap) { throw 'Empty scenario requires -IncludeBootstrap.' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutputDir "$Scenario-$stamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

# Never replay v1-v16 over a database that already contains a later migration.
$later = & $psql.Source $DatabaseUrl -Atq -c "SELECT to_regprocedure('public.training_study_quiz_for_course(uuid)') IS NOT NULL;"
if ($later.Trim() -eq 't') { throw 'Database already contains v17+ objects; create or restore an isolated pre-v17 copy before running D03.' }

& $pgDump.Source --format=custom --file (Join-Path $runDir 'before-full.dump') $DatabaseUrl
& $pgDump.Source --schema-only --format=plain --file (Join-Path $runDir 'before-schema.sql') $DatabaseUrl
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'before-data.csv')

if ($IncludeBootstrap) {
  foreach ($file in $manifest.bootstrapFilesForEmptyDatabase) {
    & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $file)
  }
}

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c @'
CREATE TABLE IF NOT EXISTS public.safety_schema_migrations (
  migration_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
'@

foreach ($migration in $manifest.migrations) {
  $applied = & $psql.Source $DatabaseUrl -Atq -c "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = 'training-admission-v$($migration.version)';"
  if ($applied) {
    if ($applied.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Checksum mismatch for v$($migration.version); refuse replay." }
    Write-Output "Skip v$($migration.version): already recorded."
    continue
  }
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $migration.file)
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c "INSERT INTO public.safety_schema_migrations(migration_key, sha256) VALUES ('training-admission-v$($migration.version)', '$($migration.sha256)');"
}

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $manifest.postMigrationHardening)
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-data.csv')
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-schema-inventory.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-schema.csv')

$before = Import-Csv (Join-Path $runDir 'before-data.csv')
$after = Import-Csv (Join-Path $runDir 'after-data.csv')
foreach ($row in $before) {
  $afterRow = $after | Where-Object { $_.table_name -eq $row.table_name } | Select-Object -First 1
  if ($afterRow -and $afterRow.row_count -ne $row.row_count) { throw "Historical row count changed for $($row.table_name): $($row.row_count) -> $($afterRow.row_count)." }
}
Write-Output "D03 $Scenario verification complete: $runDir"

param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [ValidateSet('Empty', 'Historical')][string]$Scenario = 'Historical',
  [string]$OutputDir = 'test-results/d03',
  [switch]$IncludeBootstrap,
  [string]$HistoricalSeedFile,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [Parameter(Mandatory = $true)][string]$TestConfirmation
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing D03 run without TestConfirmation D03_TEST_ONLY.' }
if ($EnvironmentName -ne 'test') { throw 'D03 migration verification requires SAFETY_ENV=test.' }
if ($DatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'DatabaseUrl still contains a placeholder.' }
$psql = Get-Command psql -ErrorAction SilentlyContinue
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $psql -or -not $pgDump) { throw 'D03 requires PostgreSQL client tools: psql and pg_dump.' }

$repo = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $repo 'sql'
. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')
$manifest = Get-Content -Raw (Join-Path $sqlDir 'training-admission-v1-v16.manifest.json') | ConvertFrom-Json
if ($Scenario -eq 'Empty' -and -not $IncludeBootstrap) { throw 'Empty scenario requires -IncludeBootstrap.' }
if ($HistoricalSeedFile -and -not $IncludeBootstrap) { throw 'HistoricalSeedFile requires -IncludeBootstrap because it targets the v0 bootstrap schema.' }
if ($HistoricalSeedFile -and -not (Test-Path -LiteralPath $HistoricalSeedFile)) { throw 'HistoricalSeedFile does not exist.' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutputDir "$Scenario-$stamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$failureDiagnostic = Join-Path $runDir 'migration-failure.diagnostic.json'

function Write-HistoricalFingerprintSql {
  param([string]$ColumnManifestFile, [string]$OutputFile)

  $lines = [System.Collections.Generic.List[string]]::new()
  [void]$lines.Add('CREATE TEMP TABLE d03_historical_fingerprint_tmp (table_schema TEXT NOT NULL, table_name TEXT NOT NULL, row_count BIGINT NOT NULL, row_hash TEXT NOT NULL, PRIMARY KEY (table_schema, table_name));')
  foreach ($row in (Import-Csv -LiteralPath $ColumnManifestFile)) {
    $columns = @($row.column_names -split '\|' | Where-Object { $_ })
    if ($columns.Count -eq 0) { throw "Historical column manifest is empty for $($row.table_schema).$($row.table_name)." }
    $pairs = @($columns | ForEach-Object {
      $literal = $_.Replace("'", "''")
      $identifier = $_.Replace('"', '""')
      "'$literal', t.`"$identifier`""
    }) -join ', '
    $schemaLiteral = $row.table_schema.Replace("'", "''")
    $tableLiteral = $row.table_name.Replace("'", "''")
    $schemaIdentifier = $row.table_schema.Replace('"', '""')
    $tableIdentifier = $row.table_name.Replace('"', '""')
    $json = "jsonb_build_object($pairs)"
    [void]$lines.Add(@"
INSERT INTO d03_historical_fingerprint_tmp(table_schema, table_name, row_count, row_hash)
SELECT '$schemaLiteral', '$tableLiteral', count(*),
       md5(COALESCE(string_agg(($json)::text, '' ORDER BY ($json)::text), ''))
FROM `"$schemaIdentifier`".`"$tableIdentifier`" t;
"@)
  }
  [void]$lines.Add('SELECT table_schema, table_name, row_count, row_hash FROM d03_historical_fingerprint_tmp ORDER BY table_schema, table_name;')
  $lines | Set-Content -LiteralPath $OutputFile -Encoding utf8
}

try {
# Never replay v1-v16 over a database that already contains a later migration.
$later = & $psql.Source $DatabaseUrl -Atq -c "SELECT to_regprocedure('public.training_study_quiz_for_course(uuid)') IS NOT NULL;"
if ($later.Trim() -eq 't') { throw 'Database already contains v17+ objects; create or restore an isolated pre-v17 copy before running D03.' }

if ($IncludeBootstrap) {
  foreach ($file in $manifest.bootstrapFilesForEmptyDatabase) {
    & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $file)
    if ($LASTEXITCODE -ne 0) { throw "Bootstrap failed: $file" }
  }
}

if ($HistoricalSeedFile) {
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c "SET app.safety_test_confirmation = 'D03_TEST_ONLY';" -f $HistoricalSeedFile
  if ($LASTEXITCODE -ne 0) { throw 'Historical seed failed.' }
}

$historicalFingerprintSql = $null
if ($Scenario -eq 'Historical') {
  $columnManifest = Join-Path $runDir 'historical-column-manifest.csv'
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -c @'
WITH target_tables AS (
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
    AND (table_schema = 'public' OR (table_schema = 'storage' AND table_name = 'objects'))
)
SELECT c.table_schema, c.table_name,
       string_agg(c.column_name, '|' ORDER BY c.ordinal_position) AS column_names
FROM information_schema.columns c
JOIN target_tables t USING (table_schema, table_name)
GROUP BY c.table_schema, c.table_name
ORDER BY c.table_schema, c.table_name;
'@ | Set-Content -Encoding utf8 $columnManifest
  if ($LASTEXITCODE -ne 0) { throw 'Historical column manifest export failed.' }
  $historicalFingerprintSql = Join-Path $runDir 'historical-data-fingerprint.sql'
  Write-HistoricalFingerprintSql -ColumnManifestFile $columnManifest -OutputFile $historicalFingerprintSql
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f $historicalFingerprintSql | Set-Content -Encoding utf8 (Join-Path $runDir 'before-historical-data.csv')
  if ($LASTEXITCODE -ne 0) { throw 'Pre-migration historical fingerprint export failed.' }
}

# D03 proves application recovery, not Supabase-managed platform internals.
& $pgDump.Source --format=custom --schema=public --file (Join-Path $runDir 'before-full.dump') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration application backup.' }
& $pgDump.Source --schema-only --format=plain --schema=public --file (Join-Path $runDir 'before-schema.sql') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration application schema backup.' }
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
  $applied = & $psql.Source $DatabaseUrl -Atq -c "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = 'training-admission-v$($migration.version)';"
  if ($applied) {
    if ($applied.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Checksum mismatch for v$($migration.version); refuse replay." }
    Write-Output "Skip v$($migration.version): already recorded."
    continue
  }
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $migration.file)
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: v$($migration.version)" }
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c "INSERT INTO public.safety_schema_migrations(migration_key, sha256) VALUES ('training-admission-v$($migration.version)', '$($migration.sha256)');"
  if ($LASTEXITCODE -ne 0) { throw "Migration ledger write failed: v$($migration.version)" }
  $recorded = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = 'training-admission-v$($migration.version)';"
  if ($LASTEXITCODE -ne 0 -or ([string]$recorded).Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Migration ledger verification failed: v$($migration.version)" }
}

$ledgerRows = @(& $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT migration_key FROM public.safety_schema_migrations WHERE migration_key ~ '^training-admission-v([1-9]|[1-4][0-9])$' ORDER BY migration_key;")
if ($LASTEXITCODE -ne 0 -or $ledgerRows.Count -ne $manifest.migrations.Count) { throw "Migration ledger is incomplete: expected $($manifest.migrations.Count), found $($ledgerRows.Count)." }

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -f (Join-Path $sqlDir $manifest.postMigrationHardening)
if ($LASTEXITCODE -ne 0) { throw 'D03 hardening migration failed.' }
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-data.csv')
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-schema-inventory.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-schema.csv')

if ($Scenario -eq 'Historical') {
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f $historicalFingerprintSql | Set-Content -Encoding utf8 (Join-Path $runDir 'after-historical-data.csv')
  if ($LASTEXITCODE -ne 0) { throw 'Post-migration historical fingerprint export failed.' }
  & node (Join-Path $repo 'tests\compare-d03-fingerprints.js') (Join-Path $runDir 'before-historical-data.csv') (Join-Path $runDir 'after-historical-data.csv')
}
else {
  & node (Join-Path $repo 'tests\compare-d03-fingerprints.js') (Join-Path $runDir 'before-data.csv') (Join-Path $runDir 'after-data.csv')
}
if ($LASTEXITCODE -ne 0) { throw 'Historical fingerprint verification failed.' }
Write-Output "D03 $Scenario verification complete: $runDir"
}
catch {
  $diagnostic = New-D03ErrorDiagnostic -ErrorRecord $_
  $diagnostic.scenario = $Scenario
  $diagnostic.run_directory = $runDir
  Write-D03DiagnosticJson -Diagnostic $diagnostic -Path $failureDiagnostic
  throw
}

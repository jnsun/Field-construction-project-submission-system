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
$psqlCommand = Get-Command psql -ErrorAction SilentlyContinue
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $psqlCommand -or -not $pgDump) { throw 'D03 requires PostgreSQL client tools: psql and pg_dump.' }

$repo = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $repo 'sql'
. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')
. (Join-Path $PSScriptRoot "d03-psql.ps1")
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
$laterResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-Atq', '-c', "SELECT to_regprocedure('public.training_study_quiz_for_course(uuid)') IS NOT NULL;") -OutputDirectory $runDir -Label 'later-migration-check'
$later = [string]$laterResult.stdout
if ($later.Trim() -eq 't') { throw 'Database already contains v17+ objects; create or restore an isolated pre-v17 copy before running D03.' }

if ($IncludeBootstrap) {
  foreach ($file in $manifest.bootstrapFilesForEmptyDatabase) {
    Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-f', (Join-Path $sqlDir $file)) -OutputDirectory $runDir -Label "bootstrap-$([System.IO.Path]::GetFileNameWithoutExtension($file))" | Out-Null
  }
}

if ($HistoricalSeedFile) {
  Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-c', "SET app.safety_test_confirmation = 'D03_TEST_ONLY';", '-f', $HistoricalSeedFile) -OutputDirectory $runDir -Label 'historical-seed' | Out-Null
}

$historicalFingerprintSql = $null
if ($Scenario -eq 'Historical') {
  $columnManifest = Join-Path $runDir 'historical-column-manifest.csv'
  $columnManifestResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-c', @'
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
'@) -OutputDirectory $runDir -Label 'historical-column-manifest'
  Set-Content -LiteralPath $columnManifest -Encoding utf8 -Value $columnManifestResult.stdout
  $historicalFingerprintSql = Join-Path $runDir 'historical-data-fingerprint.sql'
  Write-HistoricalFingerprintSql -ColumnManifestFile $columnManifest -OutputFile $historicalFingerprintSql
  $beforeHistoricalData = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', $historicalFingerprintSql) -OutputDirectory $runDir -Label 'before-historical-data'
  Set-Content -LiteralPath (Join-Path $runDir 'before-historical-data.csv') -Encoding utf8 -Value $beforeHistoricalData.stdout
}

# D03 proves application recovery, not Supabase-managed platform internals.
& $pgDump.Source --format=custom --schema=public --file (Join-Path $runDir 'before-full.dump') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration application backup.' }
& $pgDump.Source --schema-only --format=plain --schema=public --file (Join-Path $runDir 'before-schema.sql') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the pre-migration application schema backup.' }
$beforeData = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', (Join-Path $sqlDir 'd03-data-fingerprint.sql')) -OutputDirectory $runDir -Label 'before-data'
Set-Content -LiteralPath (Join-Path $runDir 'before-data.csv') -Encoding utf8 -Value $beforeData.stdout

Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-c', @'
CREATE TABLE IF NOT EXISTS public.safety_schema_migrations (
  migration_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
'@) -OutputDirectory $runDir -Label 'create-migration-ledger' | Out-Null

foreach ($migration in $manifest.migrations) {
  $migrationKey = "training-admission-v$($migration.version)"
  $appliedResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-Atq', '-c', "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = '$migrationKey';") -OutputDirectory $runDir -Label "ledger-read-v$($migration.version)"
  $applied = [string]$appliedResult.stdout
  if ($applied) {
    if ($applied.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Checksum mismatch for v$($migration.version); refuse replay." }
    Write-Output "Skip v$($migration.version): already recorded."
    continue
  }
  Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-f', (Join-Path $sqlDir $migration.file)) -OutputDirectory $runDir -Label "migration-v$($migration.version)" | Out-Null
  Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-c', "INSERT INTO public.safety_schema_migrations(migration_key, sha256) VALUES ('$migrationKey', '$($migration.sha256)');") -OutputDirectory $runDir -Label "ledger-write-v$($migration.version)" | Out-Null
  $recordedResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-Atq', '-c', "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = '$migrationKey';") -OutputDirectory $runDir -Label "ledger-verify-v$($migration.version)"
  $recorded = [string]$recordedResult.stdout
  if ($recorded.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Migration ledger verification failed: v$($migration.version)" }
}

$ledgerResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-Atq', '-c', "SELECT migration_key FROM public.safety_schema_migrations WHERE migration_key ~ '^training-admission-v([1-9]|[1-4][0-9])$' ORDER BY migration_key;") -OutputDirectory $runDir -Label 'ledger-count'
$ledgerRows = @(([string]$ledgerResult.stdout -split "`r?`n" | Where-Object { $_ }))
if ($ledgerRows.Count -ne $manifest.migrations.Count) { throw "Migration ledger is incomplete: expected $($manifest.migrations.Count), found $($ledgerRows.Count)." }

Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-f', (Join-Path $sqlDir $manifest.postMigrationHardening)) -OutputDirectory $runDir -Label 'post-migration-hardening' | Out-Null
$afterData = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', (Join-Path $sqlDir 'd03-data-fingerprint.sql')) -OutputDirectory $runDir -Label 'after-data'
Set-Content -LiteralPath (Join-Path $runDir 'after-data.csv') -Encoding utf8 -Value $afterData.stdout
$afterSchema = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', (Join-Path $sqlDir 'd03-schema-inventory.sql')) -OutputDirectory $runDir -Label 'after-schema'
Set-Content -LiteralPath (Join-Path $runDir 'after-schema.csv') -Encoding utf8 -Value $afterSchema.stdout

if ($Scenario -eq 'Historical') {
  $afterHistoricalData = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', $historicalFingerprintSql) -OutputDirectory $runDir -Label 'after-historical-data'
  Set-Content -LiteralPath (Join-Path $runDir 'after-historical-data.csv') -Encoding utf8 -Value $afterHistoricalData.stdout
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

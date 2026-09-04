param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$FixtureRunKey = 'D02-TEST-20260903',
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
. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')
. (Join-Path $PSScriptRoot 'd03-archive.ps1')
$manifest = Get-Content -Raw (Join-Path $sqlDir 'training-admission-v17-v49.manifest.json') | ConvertFrom-Json
$fixtureCount = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key = '$FixtureRunKey';"
if ([int]$fixtureCount.Trim() -lt 1) { throw "Target lacks fixture marker $FixtureRunKey; refusing current-chain verification." }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $OutputDir "CurrentChain-$stamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$failureDiagnostic = Join-Path $runDir 'current-chain-failure.diagnostic.json'

try {
function Invoke-D03MigrationFile {
  param([object]$Migration)

  $key = "training-admission-v$($Migration.version)"
  $sourceFile = Join-Path $sqlDir $Migration.file
  $stdoutFile = Join-Path $runDir "$key.stdout.log"
  $stderrFile = Join-Path $runDir "$key.stderr.log"
  $diagnosticFile = Join-Path $runDir "$key.diagnostic.json"
  $started = Get-Date
  $process = Start-Process -FilePath $psql.Source -ArgumentList @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', $sourceFile) -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -NoNewWindow -Wait -PassThru
  $finished = Get-Date
  $stdout = if (Test-Path -LiteralPath $stdoutFile -PathType Leaf) { Get-Content -LiteralPath $stdoutFile -Raw } else { $null }
  $stderr = if (Test-Path -LiteralPath $stderrFile -PathType Leaf) { Get-Content -LiteralPath $stderrFile -Raw } else { $null }
  $diagnostic = New-D03CommandDiagnostic -ExitCode $process.ExitCode -Stdout $stdout -Stderr $stderr -CommandResult $process -OutputFile $sourceFile -StartedAt $started -FinishedAt $finished
  $diagnostic.label = $key
  $diagnostic.executable = 'psql'
  $diagnostic.executable_path = $psql.Source
  $diagnostic.command = @('psql', '-v', 'ON_ERROR_STOP=1', '-f', $Migration.file)
  $diagnostic.stdout_file = $stdoutFile
  $diagnostic.stderr_file = $stderrFile
  Write-D03DiagnosticJson -Diagnostic $diagnostic -Path $diagnosticFile
  if ($process.ExitCode -ne 0) { throw "Migration failed: $key. See $diagnosticFile." }
}

function Write-PreMigrationFingerprintSql {
  param([string]$ColumnManifestFile, [string]$OutputFile)

  $lines = [System.Collections.Generic.List[string]]::new()
  [void]$lines.Add('CREATE TEMP TABLE d03_pre_migration_fingerprint_tmp (table_schema TEXT NOT NULL, table_name TEXT NOT NULL, row_count BIGINT NOT NULL, row_hash TEXT NOT NULL, PRIMARY KEY (table_schema, table_name));')
  foreach ($row in (Import-Csv -LiteralPath $ColumnManifestFile)) {
    $columns = @($row.column_names -split '\|' | Where-Object { $_ })
    if ($columns.Count -eq 0) { throw "Pre-migration column manifest is empty for $($row.table_schema).$($row.table_name)." }
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
INSERT INTO d03_pre_migration_fingerprint_tmp(table_schema, table_name, row_count, row_hash)
SELECT '$schemaLiteral', '$tableLiteral', count(*),
       md5(COALESCE(string_agg(($json)::text, '' ORDER BY ($json)::text), ''))
FROM `"$schemaIdentifier`".`"$tableIdentifier`" t;
"@)
  }
  [void]$lines.Add('SELECT table_schema, table_name, row_count, row_hash FROM d03_pre_migration_fingerprint_tmp ORDER BY table_schema, table_name;')
  $lines | Set-Content -LiteralPath $OutputFile -Encoding utf8
}

$columnManifest = Join-Path $runDir 'pre-migration-column-manifest.csv'
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -c @'
WITH target_tables AS (
  SELECT table_schema, table_name
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
    AND NOT (table_schema = 'public' AND table_name = 'safety_schema_migrations')
    AND (table_schema = 'public' OR (table_schema = 'storage' AND table_name = 'objects'))
)
SELECT c.table_schema, c.table_name,
       string_agg(c.column_name, '|' ORDER BY c.ordinal_position) AS column_names
FROM information_schema.columns c
JOIN target_tables t USING (table_schema, table_name)
GROUP BY c.table_schema, c.table_name
ORDER BY c.table_schema, c.table_name;
'@ | Set-Content -Encoding utf8 $columnManifest
if ($LASTEXITCODE -ne 0) { throw 'Pre-migration column manifest export failed.' }
$preMigrationFingerprintSql = Join-Path $runDir 'pre-migration-data-fingerprint.sql'
Write-PreMigrationFingerprintSql -ColumnManifestFile $columnManifest -OutputFile $preMigrationFingerprintSql
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f $preMigrationFingerprintSql | Set-Content -Encoding utf8 (Join-Path $runDir 'before-pre-migration-data.csv')
if ($LASTEXITCODE -ne 0) { throw 'Pre-migration historical fingerprint export failed.' }

# The D03 recovery boundary is application-owned public data. Source-backed
# Storage configuration is rebuilt separately; platform Storage internals are excluded.
$beforeBackup = Join-Path $runDir 'before-full.dump'
Invoke-D03ArchiveDump -DatabaseUrl $DatabaseUrl -RunDirectory $runDir -Label 'before-application-archive' -ArchiveFile $beforeBackup
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
  $key = "training-admission-v$($migration.version)"
  $applied = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT sha256 FROM public.safety_schema_migrations WHERE migration_key = '$key';"
  if ($applied) {
    if ($applied.Trim().ToUpperInvariant() -ne $migration.sha256) { throw "Checksum mismatch for $key; refusing replay." }
    Write-Output "Skip ${key}: matching ledger entry."
    continue
  }
  Invoke-D03MigrationFile -Migration $migration
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 -c "INSERT INTO public.safety_schema_migrations(migration_key, sha256) VALUES ('$key', '$($migration.sha256)');"
}

& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-data.csv')
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f $preMigrationFingerprintSql | Set-Content -Encoding utf8 (Join-Path $runDir 'after-pre-migration-data.csv')
if ($LASTEXITCODE -ne 0) { throw 'Post-migration historical fingerprint export failed.' }
& node (Join-Path $repo 'tests\compare-d03-fingerprints.js') (Join-Path $runDir 'before-pre-migration-data.csv') (Join-Path $runDir 'after-pre-migration-data.csv')
if ($LASTEXITCODE -ne 0) { throw 'Historical fingerprint verification failed.' }
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-schema-inventory.sql') | Set-Content -Encoding utf8 (Join-Path $runDir 'after-schema.csv')
$afterBackup = Join-Path $runDir 'after-full.dump'
Invoke-D03ArchiveDump -DatabaseUrl $DatabaseUrl -RunDirectory $runDir -Label 'after-application-archive' -ArchiveFile $afterBackup
& $pgDump.Source --schema-only --format=plain --schema=public --file (Join-Path $runDir 'after-schema.sql') $DatabaseUrl
if ($LASTEXITCODE -ne 0) { throw 'Failed to create the post-migration application schema backup.' }
Write-Output "D03 current-chain verification complete: $runDir"
}
catch {
  $diagnostic = New-D03ErrorDiagnostic -ErrorRecord $_
  $diagnostic.run_directory = $runDir
  Write-D03DiagnosticJson -Diagnostic $diagnostic -Path $failureDiagnostic
  throw
}

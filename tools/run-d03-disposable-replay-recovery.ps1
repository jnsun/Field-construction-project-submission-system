param(
  [string]$SourceDatabaseUrl = $env:SAFETY_TEST_DB_URL,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$TestProjectRef,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [string]$OutputDir = 'test-results/d03',
  [ValidateSet('Full', 'ShortPath')][string]$Mode = 'Full',
  [switch]$KeepDatabases
)

$ErrorActionPreference = 'Stop'

if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing D03 disposable replay without D03_TEST_ONLY confirmation.' }
if ($EnvironmentName -ne 'test') { throw 'D03 disposable replay requires SAFETY_ENV=test.' }
if ([string]::IsNullOrWhiteSpace($SourceDatabaseUrl) -or $SourceDatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'SourceDatabaseUrl is missing or still contains a placeholder.' }

$psql = Get-Command psql -ErrorAction SilentlyContinue
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$powershell = Get-Command powershell -ErrorAction SilentlyContinue
if (-not $psql -or -not $pgDump -or -not $powershell) { throw 'D03 requires psql, pg_dump and Windows PowerShell.' }

$repo = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $repo 'sql'
. (Join-Path $PSScriptRoot 'd03-archive.ps1')
$sourceUri = [uri]$SourceDatabaseUrl
$separator = $sourceUri.UserInfo.IndexOf(':')
if ($separator -lt 0) { throw 'Source test connection does not contain database credentials.' }
$sourcePassword = [uri]::UnescapeDataString($sourceUri.UserInfo.Substring($separator + 1))
if ($sourceUri.AbsolutePath.Trim('/') -ne 'postgres' -or ($sourceUri.Host -ne "db.${TestProjectRef}.supabase.co" -and $sourceUri.Host -notmatch '(^|\.)pooler\.supabase\.com$')) {
  throw 'SourceDatabaseUrl must be a postgres connection for the dedicated test project or its Supabase pooler.'
}
$sourceDatabaseUrl = "postgresql://postgres@db.${TestProjectRef}.supabase.co:5432/postgres?sslmode=require&connect_timeout=15"
$originalPgPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
$env:PGPASSWORD = $sourcePassword
$startedAt = Get-Date
$stamp = $startedAt.ToString('yyyyMMddHHmmss')
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$replayDatabase = if ($Mode -eq 'ShortPath') { "d03_short_${stamp}_${suffix}" } else { "d03_replay_${stamp}_${suffix}" }
$restoreDatabase = "d03_restore_${stamp}_${suffix}"
$fixtureRunKey = "D03-HIST-${stamp}-${suffix}"
$runDir = Join-Path $OutputDir $(if ($Mode -eq 'ShortPath') { "short-path-$stamp-$suffix" } else { "DisposableReplay-$stamp-$suffix" })
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

function Invoke-Native {
  param([string]$Label, [string]$FilePath, [string[]]$Arguments)

  $stdout = Join-Path $runDir "$Label.stdout.log"
  $stderr = Join-Path $runDir "$Label.stderr.log"
  if ((Split-Path -Leaf $FilePath).ToLowerInvariant() -eq 'psql.exe') {
    $Arguments = @('-X', '-q', '-P', 'pager=off') + $Arguments
  }
  # Windows PowerShell turns PostgreSQL NOTICE output on stderr into a
  # NativeCommandError when ErrorActionPreference is Stop, even on exit 0.
  # Keep stderr in the run log and judge success solely by the native exit code.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & $FilePath @Arguments 1> $stdout 2> $stderr
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    $tail = if (Test-Path -LiteralPath $stderr) { (Get-Content -LiteralPath $stderr -Tail 12) -join "`n" } else { '' }
    throw "$Label failed with exit code $exitCode. $tail"
  }
}

function Invoke-SqlText {
  param([string]$Label, [string]$DatabaseUrl, [string]$Sql)
  $file = Join-Path $runDir "$Label.sql"
  Set-Content -LiteralPath $file -Encoding utf8 -Value $Sql
  Invoke-Native -Label $Label -FilePath $psql.Source -Arguments @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', $file)
}

function Invoke-SqlFile {
  param([string]$Label, [string]$DatabaseUrl, [string]$File)
  Invoke-Native -Label $Label -FilePath $psql.Source -Arguments @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', $File)
}

function New-DirectDatabaseUrl {
  param([string]$DatabaseName)
  return "postgresql://postgres@db.${TestProjectRef}.supabase.co:5432/${DatabaseName}?sslmode=require&connect_timeout=15"
}

function Assert-TestSource {
  $file = Join-Path $runDir 'assert-test-source.sql'
  Set-Content -LiteralPath $file -Encoding ascii -Value "SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key = 'D02-TEST-20260903';"
  $output = & $psql.Source $SourceDatabaseUrl -Atq -v ON_ERROR_STOP=1 -f $file
  if ($LASTEXITCODE -ne 0 -or [int]$output.Trim() -lt 1) { throw 'Source database lacks the D02 anonymous fixture marker.' }
}

function New-DisposableDatabase {
  param([string]$Name)
  if ($Name -notmatch '^d03_(replay|restore|short)_[0-9]{14}_[a-z0-9]{8}$') { throw 'Refusing unsafe disposable database name.' }
  Invoke-SqlText -Label "create-$Name" -DatabaseUrl $SourceDatabaseUrl -Sql "CREATE DATABASE $Name TEMPLATE template0;"
  $target = New-DirectDatabaseUrl -DatabaseName $Name
  Invoke-SqlText -Label "verify-$Name" -DatabaseUrl $target -Sql "SELECT current_database(), current_user;"
  return $target
}

function Remove-DisposableDatabase {
  param([string]$Name)
  if ($Name -notmatch '^d03_(replay|restore|short)_[0-9]{14}_[a-z0-9]{8}$') { throw 'Refusing unsafe disposable database name.' }
  Invoke-SqlText -Label "drop-$Name" -DatabaseUrl $SourceDatabaseUrl -Sql "DROP DATABASE IF EXISTS $Name WITH (FORCE);"
}

function Initialize-PlatformFoundation {
  param([string]$Label, [string]$DatabaseUrl)
  $raw = Join-Path $runDir "$Label-platform.raw.sql"
  $filtered = Join-Path $runDir "$Label-platform.foundation.sql"
  Invoke-Native -Label "$Label-platform-dump" -FilePath $pgDump.Source -Arguments @('--schema-only', '--schema=auth', '--schema=storage', '--schema=extensions', '--schema=vault', '--file', $raw, (New-DirectDatabaseUrl -DatabaseName 'postgres'))
  $foundationLines = [System.Collections.Generic.List[string]]::new()
  $skippingPolicy = $false
  foreach ($line in Get-Content -LiteralPath $raw) {
    if ($line -match '^CREATE POLICY ') { $skippingPolicy = $true }
    if ($skippingPolicy) {
      if ($line.TrimEnd().EndsWith(';')) { $skippingPolicy = $false }
      continue
    }
    # auth.users may have an application-owned profile trigger. The bootstrap
    # creates it after public.handle_new_user exists, so it is not platform foundation.
    if ($line -match '^(ALTER (SCHEMA|TYPE|FUNCTION|TABLE|SEQUENCE).* OWNER TO|GRANT |REVOKE |ALTER DEFAULT PRIVILEGES)' -or $line -match 'EXECUTE FUNCTION public\.') {
      continue
    }
    [void]$foundationLines.Add($line)
  }
  $foundationLines | Set-Content -LiteralPath $filtered -Encoding utf8
  Add-Content -LiteralPath $filtered -Encoding ascii -Value '\quit'
  Invoke-SqlFile -Label "$Label-platform-restore" -DatabaseUrl $DatabaseUrl -File $filtered
  Invoke-SqlText -Label "$Label-platform-verify" -DatabaseUrl $DatabaseUrl -Sql @'
CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION postgres;
DO $$
BEGIN
  IF to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('storage.foldername(text)') IS NULL THEN
    RAISE EXCEPTION 'D03 platform foundation is incomplete';
  END IF;
END $$;
'@
}

function Install-FixtureGuard {
  param([string]$Label, [string]$DatabaseUrl)
  Invoke-SqlText -Label "$Label-fixture-guard" -DatabaseUrl $DatabaseUrl -Sql @"
CREATE TABLE IF NOT EXISTS public.safety_test_fixture_registry (
  run_key TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  fixture_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_key, table_name, record_id)
);
ALTER TABLE public.safety_test_fixture_registry ENABLE ROW LEVEL SECURITY;
INSERT INTO public.safety_test_fixture_registry(run_key, table_name, record_id, fixture_role)
VALUES ('$fixtureRunKey', 'd03_control', gen_random_uuid(), 'disposable_database')
ON CONFLICT DO NOTHING;
"@
}

function Get-OnlyDirectory {
  param([string]$Parent, [string]$Pattern)
  $directories = @(Get-ChildItem -LiteralPath $Parent -Directory -Filter $Pattern | Sort-Object LastWriteTime)
  if ($directories.Count -ne 1) { throw "Expected exactly one $Pattern directory under $Parent." }
  return $directories[0].FullName
}

function Assert-Inventory {
  param([string]$InventoryFile)
  $rows = @(Import-Csv -LiteralPath $InventoryFile)
  $tables = @($rows | Where-Object { $_.category -eq 'table' })
  if ($tables.Count -lt 1 -or @($tables | Where-Object { $_.details -notmatch '"rls_enabled"\s*:\s*true' }).Count -gt 0) {
    throw 'Restored D03 inventory has missing or disabled RLS tables.'
  }
  if (@($rows | Where-Object { $_.category -eq 'function' }).Count -lt 1) { throw 'Restored D03 inventory has no target functions.' }
  if (@($rows | Where-Object { $_.category -eq 'trigger' }).Count -lt 1) { throw 'Restored D03 inventory has no target triggers.' }
  return $rows
}

function Invoke-ShortPathFixtures {
  param([string]$DatabaseUrl)

  foreach ($fixture in @('test-environment-v1.sql', 'test-environment-v2-projects-storage.sql')) {
    Invoke-Native -Label "short-fixture-$([System.IO.Path]::GetFileNameWithoutExtension($fixture))" -FilePath $psql.Source -Arguments @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', "SET app.safety_test_confirmation = 'D02_TEST_ONLY';", '-f', (Join-Path $sqlDir $fixture))
  }
}

function Invoke-StorageApplicationConfiguration {
  param([string]$DatabaseUrl)

  Invoke-Native -Label 'short-storage-application-config' -FilePath $psql.Source -Arguments @($DatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $sqlDir 'd03-storage-application-config.sql'))
}

function Assert-StorageApplicationBoundary {
  param([string]$DatabaseUrl)

  $manifest = Get-Content -LiteralPath (Join-Path $repo 'config\d03-storage-application-boundary.json') -Raw | ConvertFrom-Json
  $bucketIds = @($manifest.application_buckets | ForEach-Object { "'$($_.id.Replace("'", "''"))'" }) -join ', '
  $policyNames = @($manifest.application_policies | ForEach-Object { "'$($_.name.Replace("'", "''"))'" }) -join ', '
  $resultFile = Join-Path $runDir 'storage-application-config.csv'
  $query = @"
SELECT 'bucket' AS kind, id AS name, public::text AS detail
FROM storage.buckets WHERE id IN ($bucketIds)
UNION ALL
SELECT 'policy' AS kind, policyname AS name, cmd AS detail
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname IN ($policyNames)
ORDER BY kind, name;
"@
  & $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -c $query | Set-Content -LiteralPath $resultFile -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Storage application configuration inventory failed.' }
  $rows = @(Import-Csv -LiteralPath $resultFile)
  foreach ($bucket in $manifest.application_buckets) {
    $row = @($rows | Where-Object { $_.kind -eq 'bucket' -and $_.name -eq $bucket.id })
    if ($row.Count -ne 1 -or $row[0].detail -ne 'false') { throw "Storage bucket $($bucket.id) is missing or not private." }
  }
  foreach ($policy in $manifest.application_policies) {
    if (@($rows | Where-Object { $_.kind -eq 'policy' -and $_.name -eq $policy.name }).Count -ne 1) { throw "Storage policy $($policy.name) is missing after source-backed rebuild." }
  }
  return [pscustomobject]@{ file = $resultFile; buckets = $manifest.application_buckets.Count; policies = $manifest.application_policies.Count }
}

function Invoke-ShortPathArchiveList {
  param([string]$ArchiveFile)

  $restore = Get-Command pg_restore -ErrorAction Stop
  $listFile = Join-Path $runDir 'archive-list.txt'
  $stderrFile = Join-Path $runDir 'archive-list.stderr.log'
  $diagnosticFile = Join-Path $runDir 'archive-list.diagnostic.json'
  $started = Get-Date
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & $restore.Source --list $ArchiveFile 1> $listFile 2> $stderrFile
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $finished = Get-Date
  $stdout = if (Test-Path -LiteralPath $listFile -PathType Leaf) { Get-Content -LiteralPath $listFile -Raw } else { $null }
  $stderr = if (Test-Path -LiteralPath $stderrFile -PathType Leaf) { Get-Content -LiteralPath $stderrFile -Raw } else { $null }
  $diagnostic = New-D03CommandDiagnostic -ExitCode $exitCode -Stdout $stdout -Stderr $stderr -CommandResult ([pscustomobject]@{ exit_code = $exitCode }) -OutputFile $ArchiveFile -StartedAt $started -FinishedAt $finished
  $diagnostic.executable = 'pg_restore'
  $diagnostic.executable_path = $restore.Source
  $diagnostic.client_version = (Get-D03DiagnosticText -Value ((@(& $restore.Source --version) -join [Environment]::NewLine))).value.Trim()
  $diagnostic.command = @('pg_restore', '--list', (Split-Path -Leaf $ArchiveFile))
  $diagnostic.list_file = $listFile
  $diagnostic.list_entry_count = @(Get-Content -LiteralPath $listFile).Count
  $diagnostic.read_only = $true
  Write-D03DiagnosticJson -Diagnostic $diagnostic -Path $diagnosticFile
  if ($exitCode -ne 0 -or $diagnostic.list_entry_count -lt 1) { throw "Archive list failed. See $diagnosticFile." }
  return [pscustomobject]@{ list_file = $listFile; diagnostic_file = $diagnosticFile; metadata = $diagnostic }
}

function Get-D03LogSecretMatchCount {
  $pattern = '(?i)(postgres(?:ql)?://[^:/@\s]+:[^@/\s]+@|service[_-]?role\s*[:=]\s*[^\s]+|appsecret\s*[:=]\s*[^\s]+|session[_-]?key\s*[:=]\s*[^\s]+|jwt\s*secret\s*[:=]\s*[^\s]+)'
  $files = Get-ChildItem -LiteralPath $runDir -Recurse -File | Where-Object { $_.Extension -in @('.json', '.log', '.txt') }
  return @($files | Select-String -Pattern $pattern -AllMatches -ErrorAction Stop).Count
}

if ($Mode -eq 'ShortPath') {
  $shortFailure = $null
  $cleanupFailure = $null
  $shortResult = [ordered]@{
    mode = 'short_path'
    status = 'failed'
    environment = $EnvironmentName
    production_guard = 'test environment required; only the supplied test project direct endpoint is used for database operations'
    temporary_database = $replayDatabase
    created_at = $null
    deleted_at = $null
    cleanup_succeeded = $false
    migration_ledger_entries = $null
    archive = $null
    archive_list = $null
    secret_match_count = $null
  }
  try {
    $replayUrl = New-DisposableDatabase -Name $replayDatabase
    $shortResult.created_at = (Get-Date).ToString('o')
    Initialize-PlatformFoundation -Label 'short' -DatabaseUrl $replayUrl

    $emptyOut = Join-Path $runDir 'v1-v16-empty'
    Invoke-Native -Label 'v1-v16-empty' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-migration-verification.ps1'), '-DatabaseUrl', $replayUrl, '-Scenario', 'Empty', '-IncludeBootstrap', '-EnvironmentName', 'test', '-OutputDir', $emptyOut, '-TestConfirmation', 'D03_TEST_ONLY')
    Install-FixtureGuard -Label 'short' -DatabaseUrl $replayUrl

    $currentOut = Join-Path $runDir 'v17-v49'
    Invoke-Native -Label 'v17-v49-empty' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-current-chain-verification.ps1'), '-DatabaseUrl', $replayUrl, '-FixtureRunKey', $fixtureRunKey, '-EnvironmentName', 'test', '-OutputDir', $currentOut, '-TestConfirmation', 'D03_TEST_ONLY')
    Invoke-ShortPathFixtures -DatabaseUrl $replayUrl
    Invoke-StorageApplicationConfiguration -DatabaseUrl $replayUrl
    $storageConfiguration = Assert-StorageApplicationBoundary -DatabaseUrl $replayUrl

    $ledgerSql = Join-Path $runDir 'short-ledger.sql'
    $ledgerCsv = Join-Path $runDir 'short-ledger.csv'
    Set-Content -LiteralPath $ledgerSql -Encoding ascii -Value "SELECT migration_key, sha256 FROM public.safety_schema_migrations WHERE migration_key ~ '^training-admission-v([1-9]|[1-4][0-9])$' ORDER BY migration_key;"
    & $psql.Source $replayUrl -v ON_ERROR_STOP=1 --csv -f $ledgerSql | Set-Content -LiteralPath $ledgerCsv -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Short-path migration ledger export failed.' }
    $ledgerRows = @(Import-Csv -LiteralPath $ledgerCsv)
    $shortResult.migration_ledger_entries = $ledgerRows.Count
    $shortResult.migration_ledger_file = $ledgerCsv
    if ($ledgerRows.Count -ne 49) { throw "Short-path v49 migration ledger verification failed: found $($ledgerRows.Count) entries." }

    $archiveFile = Join-Path $runDir 'current-v49-application.dump'
    $archiveResult = Invoke-D03ArchiveDump -DatabaseUrl $replayUrl -RunDirectory $runDir -Label 'short-v49-application-archive' -ArchiveFile $archiveFile
    $archiveHash = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash
    $listResult = Invoke-ShortPathArchiveList -ArchiveFile $archiveFile
    $listLines = @(Get-Content -LiteralPath $listResult.list_file)
    $publicEntries = @($listLines | Where-Object { $_ -match '\bpublic\b' })
    $authEntries = @($listLines | Where-Object { $_ -match '\bauth\.' -or $_ -match '\bSCHEMA\s+-\s+auth\b' })
    $storageEntries = @($listLines | Where-Object { $_ -match '\bstorage\b' })
    if ($publicEntries.Count -lt 1) { throw 'Archive list lacks public application objects.' }
    if ($authEntries.Count -gt 0) { throw 'Archive list unexpectedly contains auth objects.' }

    $shortResult.archive = [ordered]@{
      file = $archiveFile
      bytes = (Get-Item -LiteralPath $archiveFile).Length
      sha256 = $archiveHash
      diagnostic_file = $archiveResult.diagnostic_file
      diagnostic_reparsed = $null -ne (Get-Content -LiteralPath $archiveResult.diagnostic_file -Raw | ConvertFrom-Json)
      pg_dump_exit_code = $archiveResult.metadata.exit_code
      server_version = $archiveResult.metadata.server_version
    }
    $shortResult.archive_list = [ordered]@{
      file = $listResult.list_file
      diagnostic_file = $listResult.diagnostic_file
      pg_restore_exit_code = $listResult.metadata.exit_code
      entries = $listLines.Count
      public_entries = $publicEntries.Count
      auth_entries = $authEntries.Count
      storage_application_entries = 0
      storage_platform_entries = 0
      storage_unknown_entries = 0
      storage_entries = $storageEntries.Count
    }
    $shortResult.storage_application_configuration = $storageConfiguration
    $toolchain = [ordered]@{
      pg_dump = [ordered]@{ path = $pgDump.Source; version = (Get-D03DiagnosticText -Value ((@(& $pgDump.Source --version) -join [Environment]::NewLine))).value.Trim() }
      pg_restore = [ordered]@{ path = (Get-Command pg_restore -ErrorAction Stop).Source; version = (Get-D03DiagnosticText -Value ((@(& (Get-Command pg_restore -ErrorAction Stop).Source --version) -join [Environment]::NewLine))).value.Trim() }
      psql = [ordered]@{ path = $psql.Source; version = (Get-D03DiagnosticText -Value ((@(& $psql.Source --version) -join [Environment]::NewLine))).value.Trim() }
      server_version = $archiveResult.metadata.server_version
    }
    $shortDiagnosticFile = Join-Path $runDir 'diagnostics.json'
    $shortDiagnostic = [ordered]@{ toolchain = $toolchain; archive = $archiveResult.metadata; archive_list = $listResult.metadata }
    Write-D03DiagnosticJson -Diagnostic $shortDiagnostic -Path $shortDiagnosticFile
    $shortResult.diagnostics = [ordered]@{ file = $shortDiagnosticFile; reparsed = $null -ne (Get-Content -LiteralPath $shortDiagnosticFile -Raw | ConvertFrom-Json) }
    $shortResult.secret_match_count = Get-D03LogSecretMatchCount
    if ($shortResult.secret_match_count -ne 0) { throw 'Short-path logs contain a secret pattern.' }
    if ($storageEntries.Count -ne 0) { throw 'Public-only application archive unexpectedly contains Storage entries.' }
    $shortResult.status = 'passed'
  }
  catch {
    $shortFailure = $_
    $shortResult.error = (Get-D03RedactedText -Value $_.Exception.Message).value
  }
  finally {
    if (-not $KeepDatabases -and $replayUrl) {
      try {
        Remove-DisposableDatabase -Name $replayDatabase
        $shortResult.cleanup_succeeded = $true
        $shortResult.deleted_at = (Get-Date).ToString('o')
      }
      catch {
        $cleanupFailure = $_
        $shortResult.cleanup_error = (Get-D03RedactedText -Value $_.Exception.Message).value
      }
    }
    if ($null -eq $originalPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $originalPgPassword }
    $shortResult | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding utf8
  }
  if ($shortFailure) { throw $shortFailure }
  if ($cleanupFailure) { throw "Short-path cleanup failed. See $runDir\summary.json" }
  Write-Output "D03 short-path archive verification complete: $runDir"
  return
}

$replayUrl = $null
$restoreUrl = $null
$result = [ordered]@{
  started_at = $startedAt.ToString('o')
  fixture_run_key = $fixtureRunKey
  status = 'failed'
  v1_v16 = $null
  v17_v49 = $null
  restore = $null
}

try {
  Assert-TestSource
  $replayUrl = New-DisposableDatabase -Name $replayDatabase
  Initialize-PlatformFoundation -Label 'replay' -DatabaseUrl $replayUrl

  $v16Out = Join-Path $runDir 'v1-v16'
  Invoke-Native -Label 'v1-v16-replay' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-migration-verification.ps1'), '-DatabaseUrl', $replayUrl, '-Scenario', 'Historical', '-IncludeBootstrap', '-HistoricalSeedFile', (Join-Path $sqlDir 'd03-v0-historical-anonymous-seed.sql'), '-EnvironmentName', 'test', '-OutputDir', $v16Out, '-TestConfirmation', 'D03_TEST_ONLY')
  $v16Run = Get-OnlyDirectory -Parent $v16Out -Pattern 'Historical-*'
  Install-FixtureGuard -Label 'replay' -DatabaseUrl $replayUrl

  $currentOut = Join-Path $runDir 'v17-v49'
  Invoke-Native -Label 'v17-v49-replay' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-current-chain-verification.ps1'), '-DatabaseUrl', $replayUrl, '-FixtureRunKey', $fixtureRunKey, '-EnvironmentName', 'test', '-OutputDir', $currentOut, '-TestConfirmation', 'D03_TEST_ONLY')
  $currentRun = Get-OnlyDirectory -Parent $currentOut -Pattern 'CurrentChain-*'

  $repeatOut = Join-Path $runDir 'v17-v49-repeat'
  Invoke-Native -Label 'v17-v49-repeat' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-current-chain-verification.ps1'), '-DatabaseUrl', $replayUrl, '-FixtureRunKey', $fixtureRunKey, '-EnvironmentName', 'test', '-OutputDir', $repeatOut, '-TestConfirmation', 'D03_TEST_ONLY')

  $ledgerFile = Join-Path $runDir 'ledger.sql'
  Set-Content -LiteralPath $ledgerFile -Encoding ascii -Value "SELECT count(*) FROM public.safety_schema_migrations WHERE migration_key ~ '^training-admission-v([1-9]|[1-4][0-9])$';"
  $ledgerCount = & $psql.Source $replayUrl -Atq -v ON_ERROR_STOP=1 -f $ledgerFile
  if ($LASTEXITCODE -ne 0 -or [int]$ledgerCount.Trim() -ne 49) { throw 'Complete v1-v49 migration ledger verification failed.' }

  $restoreUrl = New-DisposableDatabase -Name $restoreDatabase
  Initialize-PlatformFoundation -Label 'restore' -DatabaseUrl $restoreUrl
  Install-FixtureGuard -Label 'restore' -DatabaseUrl $restoreUrl

  $afterBackup = Join-Path $currentRun 'after-full.dump'
  $afterInventory = Join-Path $currentRun 'after-schema.csv'
  $afterData = Join-Path $currentRun 'after-data.csv'
  $restoreInventory = Join-Path $runDir 'restore-first-schema.csv'
  Invoke-Native -Label 'restore-first' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-restore-drill.ps1'), '-DatabaseUrl', $restoreUrl, '-BackupFile', $afterBackup, '-FixtureRunKey', $fixtureRunKey, '-EnvironmentName', 'test', '-ExpectedInventory', $afterInventory, '-OutputFile', $restoreInventory, '-TestConfirmation', 'D03_TEST_ONLY')
  $restoreData = Join-Path $runDir 'restore-first-data.csv'
  & $psql.Source $restoreUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -LiteralPath $restoreData -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'First restore data fingerprint export failed.' }
  Invoke-Native -Label 'restore-first-data-compare' -FilePath 'node' -Arguments @((Join-Path $repo 'tests\compare-d03-fingerprints.js'), $afterData, $restoreData)

  $repeatInventory = Join-Path $runDir 'restore-repeat-schema.csv'
  Invoke-Native -Label 'restore-repeat' -FilePath $powershell.Source -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-d03-restore-drill.ps1'), '-DatabaseUrl', $restoreUrl, '-BackupFile', $afterBackup, '-FixtureRunKey', $fixtureRunKey, '-EnvironmentName', 'test', '-ExpectedInventory', $afterInventory, '-OutputFile', $repeatInventory, '-TestConfirmation', 'D03_TEST_ONLY')
  $repeatData = Join-Path $runDir 'restore-repeat-data.csv'
  & $psql.Source $restoreUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $sqlDir 'd03-data-fingerprint.sql') | Set-Content -LiteralPath $repeatData -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Repeated restore data fingerprint export failed.' }
  Invoke-Native -Label 'restore-repeat-data-compare' -FilePath 'node' -Arguments @((Join-Path $repo 'tests\compare-d03-fingerprints.js'), $afterData, $repeatData)

  $inventoryRows = Assert-Inventory -InventoryFile $repeatInventory
  $result.v1_v16 = [ordered]@{ historical_seed = 'd03-v0-historical-anonymous-seed.sql'; data_fingerprints = (Import-Csv (Join-Path $v16Run 'after-data.csv')).Count }
  $result.v17_v49 = [ordered]@{ ledger_entries = 49; data_fingerprints = (Import-Csv $afterData).Count; repeat_verified = $true }
  $result.restore = [ordered]@{ schema_objects = $inventoryRows.Count; data_fingerprints = (Import-Csv $repeatData).Count; rls_tables = @($inventoryRows | Where-Object { $_.category -eq 'table' }).Count; functions = @($inventoryRows | Where-Object { $_.category -eq 'function' }).Count; triggers = @($inventoryRows | Where-Object { $_.category -eq 'trigger' }).Count; repeat_verified = $true }
  $result.status = 'passed'
}
catch {
  $result.error = $_.Exception.Message
  throw
}
finally {
  $finishedAt = Get-Date
  $result.completed_at = $finishedAt.ToString('o')
  $result.duration_seconds = [math]::Round(($finishedAt - $startedAt).TotalSeconds, 3)
  if (-not $KeepDatabases) {
    if ($restoreUrl) { Remove-DisposableDatabase -Name $restoreDatabase }
    if ($replayUrl) { Remove-DisposableDatabase -Name $replayDatabase }
  }
  if ($null -eq $originalPgPassword) {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  }
  else {
    $env:PGPASSWORD = $originalPgPassword
  }
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'result.json') -Encoding utf8
}

Write-Output "D03 disposable replay and recovery complete: $runDir"

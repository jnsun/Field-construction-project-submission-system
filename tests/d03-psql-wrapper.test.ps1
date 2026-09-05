param(
  [string]$SourceDatabaseUrl = $env:SAFETY_TEST_DB_URL,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$TestProjectRef,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing psql wrapper test without D03_TEST_ONLY confirmation.' }
if ($EnvironmentName -ne 'test') { throw 'D03 psql wrapper test requires SAFETY_ENV=test.' }
if ([string]::IsNullOrWhiteSpace($SourceDatabaseUrl) -or $SourceDatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'SourceDatabaseUrl is missing or still contains a placeholder.' }

$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'tools\d03-psql.ps1')
. (Join-Path $repo 'tools\d03-cross-schema-application-objects.ps1')

$sourceUri = [uri]$SourceDatabaseUrl
$separator = $sourceUri.UserInfo.IndexOf(':')
if ($separator -lt 0) { throw 'Source test connection does not contain database credentials.' }
if ($sourceUri.AbsolutePath.Trim('/') -ne 'postgres' -or ($sourceUri.Host -ne "db.${TestProjectRef}.supabase.co" -and $sourceUri.Host -notmatch '(^|\.)pooler\.supabase\.com$')) {
  throw 'SourceDatabaseUrl must target the dedicated test project or its Supabase pooler.'
}

$sourcePassword = [uri]::UnescapeDataString($sourceUri.UserInfo.Substring($separator + 1))
$originalPgPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
$env:PGPASSWORD = $sourcePassword
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
$databaseName = "d03_psql_${stamp}_${suffix}"
$runDir = Join-Path $repo "test-results\d03\psql-wrapper-$stamp-$suffix"
$sourceDatabase = "postgresql://postgres@db.${TestProjectRef}.supabase.co:5432/postgres?sslmode=require&connect_timeout=15"
$testDatabase = "postgresql://postgres@db.${TestProjectRef}.supabase.co:5432/${databaseName}?sslmode=require&connect_timeout=15"
$databaseCreated = $false
$cleanupFailure = $null

function Assert-D03PsqlTest {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

try {
  $createResult = Invoke-D03PsqlChecked -DatabaseUrl $sourceDatabase -Arguments @('-c', "CREATE DATABASE $databaseName TEMPLATE template0;") -OutputDirectory $runDir -Label 'create-disposable-database' -AllowFailure
  if ($createResult.exit_code -ne 0) {
    throw "Disposable database creation failed with exit code $($createResult.exit_code): $($createResult.stderr)"
  }
  $databaseCreated = $true

  $uriWithQueryArguments = Get-D03PsqlProcessArguments -DatabaseUrl 'postgresql://postgres@example.invalid:5432/d03?sslmode=require&connect_timeout=15' -Arguments @('-Atq', '-c', 'SELECT 1;')
  Assert-D03PsqlTest -Condition ($uriWithQueryArguments[0] -eq '--dbname' -and $uriWithQueryArguments[1] -eq 'postgresql://postgres@example.invalid:5432/d03?sslmode=require&connect_timeout=15') -Message 'URI with query parameters was not preserved as one --dbname argument.'
  $uriArguments = Get-D03PsqlProcessArguments -DatabaseUrl 'postgresql://postgres@example.invalid:5432/d03' -Arguments @('-Atq', '-c', 'SELECT 1;')
  Assert-D03PsqlTest -Condition ($uriArguments[0] -eq '--dbname' -and $uriArguments[1] -eq 'postgresql://postgres@example.invalid:5432/d03') -Message 'URI connection was not preserved as one --dbname argument.'
  $conninfoArguments = Get-D03PsqlProcessArguments -DatabaseUrl 'host=example.invalid port=5432 dbname=d03 user=postgres sslmode=require' -Arguments @('-Atq', '-c', 'SELECT 1;')
  Assert-D03PsqlTest -Condition ($conninfoArguments[0] -eq '--dbname' -and $conninfoArguments[1] -eq 'host=example.invalid port=5432 dbname=d03 user=postgres sslmode=require') -Message 'libpq conninfo was not preserved as one --dbname argument.'

  $selectResult = Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-Atq', '-c', 'SELECT 1;') -OutputDirectory $runDir -Label 'select-one'
  Assert-D03PsqlTest -Condition ($selectResult.exit_code -eq 0 -and ([string]$selectResult.stdout).Trim() -eq '1') -Message 'SELECT 1 did not return exit code 0 and output 1.'

  $queryResult = Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-Atq', '-c', "SELECT 'd03-query-result-readable';") -OutputDirectory $runDir -Label 'query-result-readable'
  Assert-D03PsqlTest -Condition ($queryResult.exit_code -eq 0 -and ([string]$queryResult.stdout).Trim() -eq 'd03-query-result-readable') -Message 'Calling script could not read psql query stdout.'

  $fileQuery = Join-Path $runDir 'short-platform-restore-connection.sql'
  Set-Content -LiteralPath $fileQuery -Encoding utf8 -Value 'SELECT 1;'
  $fileQueryResult = Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-Atq', '-f', $fileQuery) -OutputDirectory $runDir -Label 'short-platform-restore-connection'
  Assert-D03PsqlTest -Condition ($fileQueryResult.exit_code -eq 0 -and ([string]$fileQueryResult.stdout).Trim() -eq '1') -Message 'Short-platform-restore connection form could not execute SELECT 1.'

  $errorResult = Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-Atq', '-c', 'SELECT missing_d03_wrapper_column;') -OutputDirectory $runDir -Label 'intentional-sql-error' -AllowFailure
  Assert-D03PsqlTest -Condition ($errorResult.exit_code -ne 0) -Message 'Intentional invalid SQL did not return a non-zero exit code.'

  $crossSchemaDependency = Assert-D03ApplicationCrossSchemaDependencies -DatabaseUrl $sourceDatabase -OutputDirectory $runDir -Label 'cross-schema-wrapper'
  Assert-D03PsqlTest -Condition ($crossSchemaDependency.relation_schema -eq 'auth' -and $crossSchemaDependency.relation_name -eq 'users' -and $crossSchemaDependency.trigger_name -eq 'on_auth_user_created' -and $crossSchemaDependency.function_identity -eq 'handle_new_user()' -and $crossSchemaDependency.enabled -eq 'O') -Message 'Cross-schema application-object query did not return the expected enabled profile trigger.'

  $artificialPassword = 'D03-ARTIFICIAL-PASSWORD-ONLY'
  $artificialPasswordUrl = "postgresql://postgres:$artificialPassword@db.${TestProjectRef}.supabase.co:5432/postgres?sslmode=require&connect_timeout=5"
  $artificialPasswordResult = Invoke-D03PsqlChecked -DatabaseUrl $artificialPasswordUrl -Arguments @('-Atq', '-c', 'SELECT 1;') -OutputDirectory $runDir -Label 'artificial-password-error' -AllowFailure
  Assert-D03PsqlTest -Condition ($artificialPasswordResult.exit_code -ne 0) -Message 'Artificial-password connection unexpectedly succeeded.'
  $artificialPasswordLogs = @(Get-ChildItem -LiteralPath $runDir -File | Where-Object { $_.Name -like 'artificial-password-error.*.log' })
  $artificialPasswordMatches = @($artificialPasswordLogs | Select-String -SimpleMatch -Pattern $artificialPassword, $artificialPasswordUrl -ErrorAction Stop)
  Assert-D03PsqlTest -Condition ($artificialPasswordMatches.Count -eq 0) -Message 'Artificial password or complete connection string was written to D03 logs.'

  Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-c', @'
CREATE TABLE public.safety_schema_migrations (
  migration_key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL
);
INSERT INTO public.safety_schema_migrations(migration_key, sha256)
VALUES ('d03-psql-wrapper-test', 'TEST-SHA256');
'@) -OutputDirectory $runDir -Label 'ledger-insert' | Out-Null
  $ledgerResult = Invoke-D03PsqlChecked -DatabaseUrl $testDatabase -Arguments @('-Atq', '-c', "SELECT count(*) || '|' || count(DISTINCT migration_key) FROM public.safety_schema_migrations WHERE migration_key = 'd03-psql-wrapper-test';") -OutputDirectory $runDir -Label 'ledger-count'
  Assert-D03PsqlTest -Condition ($ledgerResult.exit_code -eq 0 -and ([string]$ledgerResult.stdout).Trim() -eq '1|1') -Message 'Migration ledger insert was not recorded exactly once.'

  $callers = @(
    (Join-Path $repo 'tools\run-d03-migration-verification.ps1'),
    (Join-Path $repo 'tools\run-d03-current-chain-verification.ps1'),
    (Join-Path $repo 'tools\run-d03-restore-drill.ps1'),
    (Join-Path $repo 'tools\run-d03-disposable-replay-recovery.ps1'),
    (Join-Path $repo 'tools\d03-archive.ps1'),
    (Join-Path $repo 'tools\d03-cross-schema-application-objects.ps1')
  )
  $directPsqlPatterns = @(
    '\$psql\.Source',
    '&\s*\$psql(?:Command)?(?:\.Source)?\b',
    'Start-Process\s+-FilePath\s+\$psql(?:Command)?(?:\.Source)?\b',
    '&\s+psql(?:\.exe)?\b',
    'Start-Process\s+-FilePath\s+[\x27\x22]?psql(?:\.exe)?'
  )
  foreach ($caller in $callers) {
    $content = Get-Content -LiteralPath $caller -Raw
    Assert-D03PsqlTest -Condition ($content.Contains('. (Join-Path $PSScriptRoot "d03-psql.ps1")')) -Message "D03 psql helper is not loaded by $caller."
    foreach ($pattern in $directPsqlPatterns) {
      if ([regex]::IsMatch($content, $pattern)) { throw "Direct psql invocation remains in $caller for pattern $pattern." }
    }
  }
  $d03Tools = @(Get-ChildItem -LiteralPath (Join-Path $repo 'tools') -File | Where-Object { ($_.Name -like 'd03-*.ps1' -or $_.Name -like 'run-d03-*.ps1') -and $_.Name -ne 'd03-psql.ps1' })
  foreach ($tool in $d03Tools) {
    $content = Get-Content -LiteralPath $tool.FullName -Raw
    foreach ($pattern in $directPsqlPatterns) {
      if ([regex]::IsMatch($content, $pattern)) { throw "Direct psql invocation remains in $($tool.FullName) for pattern $pattern." }
    }
  }
  $secretPattern = '(?i)(postgres(?:ql)?://[^:/@\s]+:[^@/\s]+@|service[_-]?role\s*[:=]\s*[^\s]+|appsecret\s*[:=]\s*[^\s]+|session[_-]?key\s*[:=]\s*[^\s]+|jwt\s*secret\s*[:=]\s*[^\s]+)'
  $logMatches = @(Get-ChildItem -LiteralPath $runDir -File | Select-String -Pattern $secretPattern -AllMatches -ErrorAction Stop)
  Assert-D03PsqlTest -Condition ($logMatches.Count -eq 0) -Message 'D03 psql wrapper logs contain a secret pattern.'
  $shortResidue = Invoke-D03PsqlChecked -DatabaseUrl $sourceDatabase -Arguments @('-Atq', '-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'd03_short_%';") -OutputDirectory $runDir -Label 'check-short-database-residue'
  Assert-D03PsqlTest -Condition (([string]$shortResidue.stdout).Trim() -eq '0') -Message 'A d03_short temporary database remains.'

  Write-Output 'PASS: SELECT 1 exit code 0.'
  Write-Output 'PASS: calling script can read query stdout.'
  Write-Output 'PASS: URI and conninfo connection arguments are preserved behind --dbname.'
  Write-Output 'PASS: short-platform-restore connection form can execute SELECT 1.'
  Write-Output 'PASS: intentional SQL error exit code non-zero.'
  Write-Output 'PASS: cross-schema application-object query uses the shared psql wrapper.'
  Write-Output 'PASS: artificial password and complete connection string are absent from logs.'
  Write-Output 'PASS: migration ledger insert recorded exactly once.'
  Write-Output 'PASS: all D03 tools contain no direct psql invocation outside the shared wrapper.'
}
finally {
  if ($databaseCreated) {
    try {
      $dropResult = Invoke-D03PsqlChecked -DatabaseUrl $sourceDatabase -Arguments @('-c', "DROP DATABASE IF EXISTS $databaseName WITH (FORCE);") -OutputDirectory $runDir -Label 'drop-disposable-database' -AllowFailure
      if ($dropResult.exit_code -ne 0) { $cleanupFailure = 'Disposable database cleanup failed.' }
      if (-not $cleanupFailure) {
        $cleanupCheck = Invoke-D03PsqlChecked -DatabaseUrl $sourceDatabase -Arguments @('-Atq', '-c', "SELECT count(*) FROM pg_database WHERE datname = '$databaseName';") -OutputDirectory $runDir -Label 'verify-disposable-database-cleanup' -AllowFailure
        if ($cleanupCheck.exit_code -ne 0 -or ([string]$cleanupCheck.stdout).Trim() -ne '0') { $cleanupFailure = 'Disposable database cleanup verification failed.' }
      }
    }
    catch {
      $cleanupFailure = 'Disposable database cleanup failed.'
    }
  }
  if (Test-Path -LiteralPath $runDir) { Remove-Item -LiteralPath $runDir -Recurse -Force }
  $env:PGPASSWORD = $originalPgPassword
}

if ($cleanupFailure) { throw $cleanupFailure }

param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$FixtureRunKey = 'D02-TEST-20260903',
  [string]$ExpectedInventory,
  [string]$OutputFile = 'test-results/d03/restore-schema.csv',
  [string]$CrossSchemaOutputFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')
. (Join-Path $PSScriptRoot 'd03-cross-schema-application-objects.ps1')
. (Join-Path $PSScriptRoot "d03-psql.ps1")
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing restore drill without TestConfirmation D03_TEST_ONLY.' }
if ($EnvironmentName -ne 'test') { throw 'D03 restore drill requires SAFETY_ENV=test.' }
if (-not (Test-Path -LiteralPath $BackupFile)) { throw 'BackupFile does not exist.' }
$restore = Get-Command pg_restore -ErrorAction SilentlyContinue
$psqlCommand = Get-Command psql -ErrorAction SilentlyContinue
if (-not $restore -or -not $psqlCommand) { throw 'D03 restore drill requires pg_restore and psql.' }

$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputFile) | Out-Null
$restoreOutputDirectory = Split-Path -Parent $OutputFile
$restoreOutputBase = Join-Path $restoreOutputDirectory ([System.IO.Path]::GetFileNameWithoutExtension($OutputFile) + '.pg_restore')
$restoreStdout = "$restoreOutputBase.stdout.log"
$restoreStderr = "$restoreOutputBase.stderr.log"
$restoreDiagnostic = "$restoreOutputBase.diagnostic.json"
$fixtureCountResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-Atq', '-c', "SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key = '$FixtureRunKey';") -OutputDirectory $restoreOutputDirectory -Label 'restore-fixture-marker-check'
$fixtureCount = [string]$fixtureCountResult.stdout
if ([int]$fixtureCount.Trim() -lt 1) { throw "Target lacks fixture marker $FixtureRunKey; refusing restore drill." }
& $restore.Source --list $BackupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup archive is unreadable; refusing restore drill.' }
# Supabase owns platform event triggers and internal Storage constraints. Restore
# only the application schema. Storage configuration is rebuilt from the D03
# source-backed initializer and object bytes remain outside this drill.
# The target is a disposable D03 database. Recreate public before every restore
# rather than using pg_restore --clean: DROP POLICY ... IF EXISTS still errors
# when its relation does not exist in an otherwise empty schema.
Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-c', 'DROP SCHEMA public CASCADE;') -OutputDirectory $restoreOutputDirectory -Label 'restore-reset-public-schema' | Out-Null
Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-c', 'CREATE SCHEMA public;') -OutputDirectory $restoreOutputDirectory -Label 'restore-create-public-schema' | Out-Null
$restoreStarted = Get-Date
$restoreProcess = $null
$restoreCommandError = $null
try {
  $restoreProcess = Start-Process -FilePath $restore.Source -ArgumentList @('--no-owner', '--schema=public', '--dbname', $DatabaseUrl, $BackupFile) -RedirectStandardOutput $restoreStdout -RedirectStandardError $restoreStderr -NoNewWindow -Wait -PassThru
}
catch {
  $restoreCommandError = $_
}
finally {
  $restoreFinished = Get-Date
  $restoreStdoutRaw = if (Test-Path -LiteralPath $restoreStdout -PathType Leaf) { Get-Content -LiteralPath $restoreStdout -Raw } else { $null }
  $restoreStderrRaw = if (Test-Path -LiteralPath $restoreStderr -PathType Leaf) { Get-Content -LiteralPath $restoreStderr -Raw } else { $null }
  $restoreExitCode = if ($null -ne $restoreProcess) { $restoreProcess.ExitCode } else { $null }
  $restoreMetadata = New-D03CommandDiagnostic -ExitCode $restoreExitCode -Stdout $restoreStdoutRaw -Stderr $restoreStderrRaw -CommandResult $restoreProcess -OutputFile $BackupFile -StartedAt $restoreStarted -FinishedAt $restoreFinished
  $restoreMetadata.label = 'application-schema-restore'
  $restoreMetadata.executable = 'pg_restore'
  $restoreMetadata.executable_path = $restore.Source
  $restoreMetadata.command = @($restore.Source, '--no-owner', '--schema=public', '--dbname', (Get-D03RedactedText -Value $DatabaseUrl).value, (Split-Path -Leaf $BackupFile))
  $restoreMetadata.stdout_file = $restoreStdout
  $restoreMetadata.stderr_file = $restoreStderr
  $restoreMetadata.archive_file = $BackupFile
  $restoreMetadata.command_error = if ($null -ne $restoreCommandError) { New-D03ErrorDiagnostic -ErrorRecord $restoreCommandError } else { $null }
  Write-D03DiagnosticJson -Diagnostic $restoreMetadata -Path $restoreDiagnostic
}
if ($null -ne $restoreCommandError -or $restoreMetadata.exit_code -ne 0) { throw "Application-schema restore failed; inspect $restoreDiagnostic before retrying." }

# public is recreated during the application-only restore, so PostgreSQL drops
# the application-owned trigger on auth.users by CASCADE. Reapply the exact
# repository definition after public.handle_new_user() has been restored.
$crossSchemaDependency = Restore-D03ApplicationCrossSchemaObjects -DatabaseUrl $DatabaseUrl -OutputDirectory $restoreOutputDirectory -Label ([System.IO.Path]::GetFileNameWithoutExtension($OutputFile)) -RepositoryRoot $repo
$crossSchemaProbe = Test-D03ApplicationCrossSchemaObjects -DatabaseUrl $DatabaseUrl -OutputDirectory $restoreOutputDirectory -Label ([System.IO.Path]::GetFileNameWithoutExtension($OutputFile))
if (-not [string]::IsNullOrWhiteSpace($CrossSchemaOutputFile)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $CrossSchemaOutputFile) | Out-Null
  [ordered]@{
    status = 'passed'
    dependency = $crossSchemaDependency
    anonymous_profile_probe = $crossSchemaProbe
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $CrossSchemaOutputFile -Encoding utf8
}

Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-f', (Join-Path $repo 'sql\d03-storage-application-config.sql')) -OutputDirectory $restoreOutputDirectory -Label 'restore-storage-application-config' | Out-Null
$inventoryResult = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('--csv', '-f', (Join-Path $repo 'sql\d03-schema-inventory.sql')) -OutputDirectory $restoreOutputDirectory -Label 'restore-schema-inventory'
Set-Content -LiteralPath $OutputFile -Encoding utf8 -Value $inventoryResult.stdout
if ($ExpectedInventory) {
  & node (Join-Path $repo 'tests\compare-d03-schema-inventory.js') $ExpectedInventory $OutputFile
  if ($LASTEXITCODE -ne 0) { throw 'Post-restore schema inventory differs from the backup source.' }
}
Write-Output "D03 restore drill complete: $OutputFile"

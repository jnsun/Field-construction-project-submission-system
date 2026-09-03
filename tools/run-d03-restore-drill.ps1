param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [string]$ExpectedInventory,
  [string]$OutputFile = 'test-results/d03/restore-schema.csv'
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing restore drill without TestConfirmation D03_TEST_ONLY.' }
if ($EnvironmentName -ne 'test') { throw 'D03 restore drill requires SAFETY_ENV=test.' }
if (-not (Test-Path -LiteralPath $BackupFile)) { throw 'BackupFile does not exist.' }
$restore = Get-Command pg_restore -ErrorAction SilentlyContinue
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $restore -or -not $psql) { throw 'D03 restore drill requires pg_restore and psql.' }

$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputFile) | Out-Null
$fixtureCount = & $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key = 'D02-TEST-20260903';"
if ($LASTEXITCODE -ne 0 -or [int]$fixtureCount.Trim() -lt 1) { throw 'Target lacks the D02 anonymous-test fixture marker; refusing restore drill.' }
& $restore.Source --list $BackupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup archive is unreadable; refusing restore drill.' }
# Supabase owns platform event triggers and internal Storage constraints. Restore
# only the application schema, then select only missing application Storage policies.
& $restore.Source --clean --if-exists --no-owner --schema=public --dbname $DatabaseUrl $BackupFile
if ($LASTEXITCODE -ne 0) { throw 'Application-schema restore failed; inspect the protected test target before retrying.' }
$existingPolicies = @(& $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';")
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing Storage policies.' }
$policyList = Join-Path (Split-Path -Parent $OutputFile) 'storage-policy-only.list'
$selectedPolicyCount = 0
& $restore.Source --list $BackupFile | ForEach-Object {
  if ($_ -match ' POLICY storage objects ([^ ]+) ') {
    if ($existingPolicies -contains $Matches[1]) { ';' + $_ } else { $selectedPolicyCount += 1; $_ }
  } else { ';' + $_ }
} | Set-Content -Encoding ascii $policyList
if ($selectedPolicyCount -gt 0) {
  & $restore.Source --no-owner --use-list $policyList --dbname $DatabaseUrl $BackupFile
  if ($LASTEXITCODE -ne 0) { throw 'Missing Storage policy restore failed; inspect the protected test target before retrying.' }
}
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $repo 'sql\d03-schema-inventory.sql') | Set-Content -Encoding utf8 $OutputFile
if ($LASTEXITCODE -ne 0) { throw 'Post-restore schema inventory failed.' }
if ($ExpectedInventory) {
  & node (Join-Path $repo 'tests\compare-d03-schema-inventory.js') $ExpectedInventory $OutputFile
  if ($LASTEXITCODE -ne 0) { throw 'Post-restore schema inventory differs from the backup source.' }
}
Write-Output "D03 restore drill complete: $OutputFile"

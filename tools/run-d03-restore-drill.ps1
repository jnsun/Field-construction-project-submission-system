param(
  [Parameter(Mandatory = $true)][string]$DatabaseUrl,
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$OutputFile = 'test-results/d03/restore-schema.csv'
)

$ErrorActionPreference = 'Stop'
if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing restore drill without TestConfirmation D03_TEST_ONLY.' }
if (-not (Test-Path -LiteralPath $BackupFile)) { throw 'BackupFile does not exist.' }
$restore = Get-Command pg_restore -ErrorAction SilentlyContinue
$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $restore -or -not $psql) { throw 'D03 restore drill requires pg_restore and psql.' }

$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputFile) | Out-Null
& $restore.Source --clean --if-exists --no-owner --dbname $DatabaseUrl $BackupFile
& $psql.Source $DatabaseUrl -v ON_ERROR_STOP=1 --csv -f (Join-Path $repo 'sql\d03-schema-inventory.sql') | Set-Content -Encoding utf8 $OutputFile
Write-Output "D03 restore drill complete: $OutputFile"

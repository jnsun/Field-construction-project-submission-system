param(
  [Parameter(Mandatory = $true)][string]$ArchiveFile,
  [string]$OutputDir = 'test-results/d03'
)

$ErrorActionPreference = 'Stop'
$restore = Get-Command pg_restore -ErrorAction Stop
if (-not (Test-Path -LiteralPath $ArchiveFile -PathType Leaf)) { throw 'ArchiveFile does not exist.' }

$runDir = Join-Path $OutputDir ('archive-boundary-' + (Get-Date).ToString('yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$listFile = Join-Path $runDir 'archive-list.txt'
$stderrFile = Join-Path $runDir 'archive-list.stderr.log'

& $restore.Source --list $ArchiveFile 1> $listFile 2> $stderrFile
if ($LASTEXITCODE -ne 0) { throw 'pg_restore --list failed; see test-result log.' }

$entries = @(Get-Content -LiteralPath $listFile)
$publicEntries = @($entries | Where-Object { $_ -match '\bpublic\b' })
$platformEntries = @($entries | Where-Object { $_ -match '\b(auth|storage|extensions|vault|realtime|graphql|supabase_functions)\b' })
if ($publicEntries.Count -lt 1) { throw 'Archive contains no public application objects.' }
if ($platformEntries.Count -ne 0) { throw 'Archive contains excluded Supabase platform objects.' }

[pscustomobject]@{
  status = 'passed'
  archive_file = (Split-Path -Leaf $ArchiveFile)
  bytes = (Get-Item -LiteralPath $ArchiveFile).Length
  sha256 = (Get-FileHash -LiteralPath $ArchiveFile -Algorithm SHA256).Hash
  total_entries = $entries.Count
  public_entries = $publicEntries.Count
  excluded_platform_entries = $platformEntries.Count
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDir 'result.json') -Encoding utf8

Write-Output "D03 archive boundary verification passed: $runDir"

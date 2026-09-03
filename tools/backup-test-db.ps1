param(
  [Parameter(Mandatory=$true)][string]$DatabaseUrl,
  [string]$OutputDir = 'backups',
  [string]$ExpectedProjectRef
)
$ErrorActionPreference = 'Stop'
$hasEnvironmentMarker = $DatabaseUrl -match '(?i)(test|staging|dev)'
$matchesExpectedProject = $ExpectedProjectRef -and $DatabaseUrl -match [regex]::Escape($ExpectedProjectRef)
if (-not $hasEnvironmentMarker -and -not $matchesExpectedProject) {
  throw '数据库地址未包含 test、staging 或 dev 标识，且未匹配显式测试项目引用，拒绝备份。'
}
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) { throw '未找到 pg_dump。请安装 PostgreSQL 客户端工具。' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$fullBackup = "$OutputDir/safety-$stamp-full.dump"
$schemaBackup = "$OutputDir/safety-$stamp-schema.sql"

& $pgDump.Source --format=custom --file $fullBackup $DatabaseUrl
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $fullBackup -Force -ErrorAction SilentlyContinue
  throw '完整结构备份失败，未保留不完整文件。'
}

& $pgDump.Source --schema-only --format=plain --file $schemaBackup $DatabaseUrl
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $schemaBackup -Force -ErrorAction SilentlyContinue
  throw '结构 SQL 备份失败，未保留不完整文件。'
}

Write-Output "备份完成：$OutputDir"

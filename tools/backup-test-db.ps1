param([Parameter(Mandatory=$true)][string]$DatabaseUrl, [string]$OutputDir = 'backups')
$ErrorActionPreference = 'Stop'
if ($DatabaseUrl -notmatch '(?i)(test|staging|dev)') { throw '数据库地址未包含 test、staging 或 dev 标识，拒绝备份，避免误操作生产环境。' }
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) { throw '未找到 pg_dump。请安装 PostgreSQL 客户端工具。' }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
& $pgDump.Source --format=custom --file "$OutputDir/safety-$stamp-full.dump" $DatabaseUrl
& $pgDump.Source --schema-only --format=plain --file "$OutputDir/safety-$stamp-schema.sql" $DatabaseUrl
Write-Output "备份完成：$OutputDir"

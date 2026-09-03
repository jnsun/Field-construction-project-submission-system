param([Parameter(Mandatory=$true)][string]$DatabaseUrl, [Parameter(Mandatory=$true)][string]$BackupFile)
$ErrorActionPreference = 'Stop'
if ($DatabaseUrl -notmatch '(?i)(test|staging|dev)') { throw '数据库地址未包含 test、staging 或 dev 标识，拒绝恢复。' }
$restore = Get-Command pg_restore -ErrorAction SilentlyContinue
if (-not $restore) { throw '未找到 pg_restore。请安装 PostgreSQL 客户端工具。' }
if (-not (Test-Path $BackupFile)) { throw '备份文件不存在。' }
& $restore.Source --clean --if-exists --no-owner --dbname $DatabaseUrl $BackupFile

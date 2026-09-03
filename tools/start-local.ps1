param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path '.env')) { Write-Warning '未发现 .env：仅可打开静态页面，远程测试需先按 .env.example 配置测试项目。' }
if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m http.server $Port }
elseif (Get-Command python -ErrorAction SilentlyContinue) { python -m http.server $Port }
else { throw '未找到 Python。请安装 Python 3 后重试。' }

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'tools\d03-connection.ps1')

function Assert-D03ConnectionTest {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$uriNoQuery = New-D03DatabaseConnectionString -BaseConnectionString 'postgresql://tester@example.invalid:5432/postgres' -DatabaseName 'd03_test'
Assert-D03ConnectionTest ($uriNoQuery -eq 'postgresql://tester@example.invalid:5432/d03_test?sslmode=require') 'URI without query was not constructed correctly.'

$uriWithSsl = New-D03DatabaseConnectionString -BaseConnectionString 'postgresql://tester@example.invalid:5432/postgres?sslmode=verify-full' -DatabaseName 'd03_test'
Assert-D03ConnectionTest ($uriWithSsl -eq 'postgresql://tester@example.invalid:5432/d03_test?sslmode=verify-full') 'Existing sslmode was not preserved.'

$uriWithQuery = New-D03DatabaseConnectionString -BaseConnectionString 'postgresql://tester@example.invalid:5432/postgres?connect_timeout=15' -DatabaseName 'd03_test'
Assert-D03ConnectionTest ($uriWithQuery -eq 'postgresql://tester@example.invalid:5432/d03_test?connect_timeout=15&sslmode=require') 'URI query separator was not constructed correctly.'

$conninfo = New-D03DatabaseConnectionString -BaseConnectionString 'host=example.invalid port=6543 user=tester dbname=postgres connect_timeout=15' -DatabaseName 'd03_test'
Assert-D03ConnectionTest ($conninfo -eq "host=example.invalid port=6543 user=tester dbname='d03_test' connect_timeout=15 sslmode='require'") 'key=value connection string was not constructed correctly.'

$specialBase = 'postgresql://user:p%40ss%2Fword@example.invalid:6543/postgres?application_name=d03%20test&sslmode=verify-full'
$special = New-D03DatabaseConnectionString -BaseConnectionString $specialBase -DatabaseName 'db name+case'
$specialUri = [uri]$special
Assert-D03ConnectionTest ($specialUri.Host -eq 'example.invalid' -and $specialUri.Port -eq 6543) 'Special-character URI host or port changed.'
Assert-D03ConnectionTest ($specialUri.UserInfo -eq 'user:p%40ss%2Fword') 'Special-character URI user info changed.'
Assert-D03ConnectionTest ($specialUri.AbsolutePath -eq '/db%20name%2Bcase') 'Special-character database name was not encoded.'
Assert-D03ConnectionTest ($specialUri.Query -eq '?application_name=d03%20test&sslmode=verify-full') 'Special-character URI query changed.'

$diagnostic = Get-D03ConnectionDiagnostic -ConnectionString $special
Assert-D03ConnectionTest ($diagnostic.connection_type -eq 'uri' -and $diagnostic.starts_with_postgres_scheme) 'URI diagnostic type is incorrect.'
Assert-D03ConnectionTest (-not $diagnostic.has_leading_quote -and -not $diagnostic.has_trailing_quote) 'URI diagnostic found unexpected quotes.'
Assert-D03ConnectionTest ($diagnostic.question_mark_count -eq 1 -and $diagnostic.has_sslmode) 'URI diagnostic query state is incorrect.'
Assert-D03ConnectionTest ($diagnostic.database -eq 'db name+case') 'URI diagnostic database name is incorrect.'
$diagnosticJson = $diagnostic | ConvertTo-Json -Compress
Assert-D03ConnectionTest ($diagnosticJson -notmatch 'p%40ss|word@|postgresql://') 'Connection diagnostic leaked connection details.'

Write-Output 'PASS: D03 connection-string construction and redacted diagnostics.'

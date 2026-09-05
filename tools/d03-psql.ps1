. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')

function ConvertTo-D03PsqlArgument {
  param([string]$Value)

  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Get-D03PsqlProcessArguments {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$NoDatabaseConnection
  )

  if ($NoDatabaseConnection) { return @($Arguments) }
  # Pass the entire URI or libpq conninfo string as one explicit dbname value.
  # This preserves existing query parameters such as sslmode and connect_timeout.
  return @('--dbname', $DatabaseUrl, '-v', 'ON_ERROR_STOP=1') + $Arguments
}

function Invoke-D03PsqlChecked {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$Label,
    [switch]$AllowFailure,
    [switch]$NoDatabaseConnection
  )

  $psql = Get-Command psql -ErrorAction Stop
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $stdout = Join-Path $OutputDirectory "$Label.stdout.log"
  $stderr = Join-Path $OutputDirectory "$Label.stderr.log"
  $allArguments = Get-D03PsqlProcessArguments -DatabaseUrl $DatabaseUrl -Arguments $Arguments -NoDatabaseConnection:$NoDatabaseConnection
  $argumentLine = (@($allArguments | ForEach-Object { ConvertTo-D03PsqlArgument -Value ([string]$_) }) -join ' ')
  $process = Start-Process -FilePath $psql.Source -ArgumentList $argumentLine -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -Wait -PassThru
  $stdoutRaw = if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout -Raw } else { '' }
  $stderrRaw = if (Test-Path -LiteralPath $stderr -PathType Leaf) { Get-Content -LiteralPath $stderr -Raw } else { '' }
  $safeStdout = (Get-D03RedactedText -Value $stdoutRaw).value
  $safeStderr = (Get-D03RedactedText -Value $stderrRaw).value
  Set-Content -LiteralPath $stdout -Encoding utf8 -Value $safeStdout
  Set-Content -LiteralPath $stderr -Encoding utf8 -Value $safeStderr
  $result = [pscustomobject]@{
    exit_code = [int]$process.ExitCode
    stdout = $safeStdout
    stderr = $safeStderr
    stdout_file = $stdout
    stderr_file = $stderr
  }
  if (-not $AllowFailure -and $result.exit_code -ne 0) { throw "$Label failed; inspect D03 result logs." }
  return $result
}

function Get-D03ConnectionStringKind {
  param([AllowNull()][string]$ConnectionString)

  $value = if ($null -eq $ConnectionString) { '' } else { $ConnectionString.Trim() }
  if ($value -match '^(?i:postgres(?:ql)?://)') { return 'uri' }
  if ($value -match '^(?i:[a-z_][a-z0-9_]*\s*=)') { return 'key_value' }
  return 'other'
}

function ConvertTo-D03ConninfoValue {
  param([Parameter(Mandatory = $true)][string]$Value)

  return "'" + $Value.Replace('\', '\\').Replace("'", "\'") + "'"
}

function New-D03DatabaseConnectionString {
  param(
    [Parameter(Mandatory = $true)][string]$BaseConnectionString,
    [Parameter(Mandatory = $true)][string]$DatabaseName,
    [string]$SslMode = 'require'
  )

  if ([string]::IsNullOrWhiteSpace($BaseConnectionString)) { throw 'Base database connection string is empty.' }
  if ([string]::IsNullOrWhiteSpace($DatabaseName)) { throw 'Target database name is empty.' }

  $connection = $BaseConnectionString.Trim()
  if ($connection[0] -in @('"', "'") -or $connection[$connection.Length - 1] -in @('"', "'")) {
    throw 'Database connection string must not contain surrounding quotes.'
  }

  $kind = Get-D03ConnectionStringKind -ConnectionString $connection
  if ($kind -eq 'uri') {
    $match = [regex]::Match($connection, '^(?<scheme>postgres(?:ql)?://)(?<authority>[^/?#]+)(?<path>/[^?#]*)?(?<query>\?[^#]*)?(?<fragment>#.*)?$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { throw 'PostgreSQL URI connection string could not be parsed.' }

    $query = $match.Groups['query'].Value
    if ($query -notmatch '(?i)(?:^\?|&)sslmode=') {
      $query += $(if ([string]::IsNullOrEmpty($query)) { '?sslmode=' } else { '&sslmode=' }) + [uri]::EscapeDataString($SslMode)
    }
    $path = '/' + [uri]::EscapeDataString($DatabaseName)
    return $match.Groups['scheme'].Value + $match.Groups['authority'].Value + $path + $query + $match.Groups['fragment'].Value
  }

  if ($kind -eq 'key_value') {
    $databaseValue = ConvertTo-D03ConninfoValue -Value $DatabaseName
    $databasePattern = '(?i)(^|\s)dbname=(?:''(?:\\.|[^''])*''|"(?:\\.|[^"])*"|[^\s]+)'
    if ($connection -match $databasePattern) {
      $connection = [regex]::Replace($connection, $databasePattern, { param($item) $item.Groups[1].Value + 'dbname=' + $databaseValue }, 1)
    }
    else {
      $connection += ' dbname=' + $databaseValue
    }
    if ($connection -notmatch '(?i)(^|\s)sslmode=') {
      $connection += ' sslmode=' + (ConvertTo-D03ConninfoValue -Value $SslMode)
    }
    return $connection
  }

  throw 'Unsupported PostgreSQL connection string format.'
}

function Get-D03ConnectionDiagnostic {
  param([AllowNull()][string]$ConnectionString)

  $raw = if ($null -eq $ConnectionString) { '' } else { [string]$ConnectionString }
  $trimmed = $raw.Trim()
  $kind = Get-D03ConnectionStringKind -ConnectionString $raw
  $databaseName = $null
  if ($kind -eq 'uri') {
    $uri = [uri]$trimmed
    $databaseName = [uri]::UnescapeDataString($uri.AbsolutePath.Trim('/'))
  }
  elseif ($kind -eq 'key_value') {
    $match = [regex]::Match($trimmed, '(?i)(?:^|\s)dbname=(?:''(?<single>(?:\\.|[^''])*)''|"(?<double>(?:\\.|[^"])*)"|(?<plain>[^\s]+))')
    if ($match.Success) {
      $databaseName = @($match.Groups['single'].Value, $match.Groups['double'].Value, $match.Groups['plain'].Value) | Where-Object { $_ -ne '' } | Select-Object -First 1
    }
  }

  return [ordered]@{
    connection_type = $kind
    starts_with_postgres_scheme = $trimmed -match '^(?i:postgres(?:ql)?://)'
    has_leading_whitespace = $raw.Length -gt 0 -and [char]::IsWhiteSpace($raw[0])
    has_trailing_whitespace = $raw.Length -gt 0 -and [char]::IsWhiteSpace($raw[$raw.Length - 1])
    has_leading_quote = $trimmed.Length -gt 0 -and $trimmed[0] -in @('"', "'")
    has_trailing_quote = $trimmed.Length -gt 0 -and $trimmed[$trimmed.Length - 1] -in @('"', "'")
    question_mark_count = ([regex]::Matches($raw, '\?')).Count
    has_sslmode = $raw -match '(?i)(?:[?&]|^|\s)sslmode='
    database = $databaseName
  }
}

function Write-D03ConnectionDiagnostic {
  param(
    [AllowNull()][string]$ConnectionString,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $diagnostic = Get-D03ConnectionDiagnostic -ConnectionString $ConnectionString
  $diagnostic | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding utf8
  return $diagnostic
}

. (Join-Path $PSScriptRoot 'd03-native-diagnostics.ps1')

function Invoke-D03ArchiveDump {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseUrl,
    [Parameter(Mandatory = $true)][string]$RunDirectory,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$ArchiveFile
  )

  $psql = Get-Command psql -ErrorAction Stop
  $pgDump = Get-Command pg_dump -ErrorAction Stop
  $stdout = Join-Path $RunDirectory "$Label.stdout.log"
  $stderr = Join-Path $RunDirectory "$Label.stderr.log"
  $diagnostic = Join-Path $RunDirectory "$Label.diagnostic.json"
  $started = Get-Date
  $target = [uri]$DatabaseUrl
  $directory = Split-Path -Parent $ArchiveFile
  # D03 archives only application-owned public data. Supabase-managed Storage
  # internals are rebuilt from source-backed configuration, not dumped here.
  $command = @($pgDump.Source, '--format=custom', '--schema=public', '--file', $ArchiveFile, (Get-D03RedactedText -Value $DatabaseUrl).value)
  $clientVersionOutput = @(& $pgDump.Source --version)
  $metadata = [ordered]@{
    label = $Label
    executable = 'pg_dump'
    executable_path = $pgDump.Source
    client_version = (Get-D03DiagnosticText -Value ($clientVersionOutput -join [Environment]::NewLine)).value.Trim()
    server_version = $null
    connection = [ordered]@{
      host = (Get-D03DiagnosticText -Value $target.Host).value
      port = $target.Port
      database = (Get-D03DiagnosticText -Value $target.AbsolutePath).value.Trim('/')
      user = (Get-D03DiagnosticText -Value $target.UserInfo).value
    }
    command = $command
    started_at = $started.ToString('o')
    target_directory = $directory
    target_directory_exists = Test-Path -LiteralPath $directory -PathType Container
    target_directory_writable = $false
  }
  try {
    $probe = Join-Path $directory ('.d03-write-probe-' + [guid]::NewGuid().ToString('N'))
    [System.IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force
    $metadata.target_directory_writable = $true
  }
  catch { $metadata.target_directory_writable = $false }

  $process = $null
  $commandError = $null
  try {
    $serverVersionOutput = @(& $psql.Source $DatabaseUrl -Atq -v ON_ERROR_STOP=1 -c 'SHOW server_version;')
    if ($LASTEXITCODE -eq 0) {
      $metadata.server_version = (Get-D03DiagnosticText -Value ($serverVersionOutput -join [Environment]::NewLine)).value.Trim()
    }
    $process = Start-Process -FilePath $pgDump.Source -ArgumentList @('--format=custom', '--schema=public', '--file', $ArchiveFile, $DatabaseUrl) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -Wait -PassThru
    if ($null -ne $process) { $metadata.exit_code = $process.ExitCode }
  }
  catch {
    $commandError = $_
    $metadata.command_error = New-D03ErrorDiagnostic -ErrorRecord $_
    throw
  }
  finally {
    $finished = Get-Date
    $stdoutRaw = if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout -Raw } else { $null }
    $stderrRaw = if (Test-Path -LiteralPath $stderr -PathType Leaf) { Get-Content -LiteralPath $stderr -Raw } else { $null }
    $commandDiagnostic = New-D03CommandDiagnostic -ExitCode $metadata.exit_code -Stdout $stdoutRaw -Stderr $stderrRaw -CommandResult $process -OutputFile $ArchiveFile -StartedAt $started -FinishedAt $finished
    $metadata.finished_at = $finished.ToString('o')
    $metadata.duration_seconds = $commandDiagnostic.duration_seconds
    $metadata.exit_code = $commandDiagnostic.exit_code
    $metadata.stdout = $commandDiagnostic.stdout
    $metadata.stderr = $commandDiagnostic.stderr
    $metadata.command_result_present = $commandDiagnostic.command_result_present
    $metadata.archive_exists = $commandDiagnostic.output_file.exists
    $metadata.archive_bytes = $commandDiagnostic.output_file.bytes
    $metadata.archive_path = $commandDiagnostic.output_file.path
    $metadata.archive_validation_passed = Test-D03ArchiveDiagnostic -Diagnostic $commandDiagnostic
    $metadata.stdout_file = $stdout
    $metadata.stderr_file = $stderr
    if ($null -eq $commandError) { $metadata.command_error = $null }
    Write-D03DiagnosticJson -Diagnostic $metadata -Path $diagnostic
  }

  if (-not $metadata.archive_validation_passed) {
    throw "Application archive $Label failed. See $diagnostic."
  }
  return [pscustomobject]@{ archive_file = $ArchiveFile; diagnostic_file = $diagnostic; metadata = $metadata }
}

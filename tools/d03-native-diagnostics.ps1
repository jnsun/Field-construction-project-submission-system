function Get-D03DiagnosticText {
  param([object]$Value)

  # Return an object so an empty string cannot disappear from PowerShell's pipeline.
  $text = [string]::Empty
  if ($null -ne $Value) { $text = [string]$Value }
  return [pscustomobject]@{ value = $text }
}

function Get-D03RedactedText {
  param([object]$Value)

  $text = (Get-D03DiagnosticText -Value $Value).value
  $redacted = $text -replace '(?i)(postgres(?:ql)?://[^:/@\s]+):[^@/\s]+@', '$1:***@'
  return [pscustomobject]@{ value = $redacted }
}

function Get-D03DiagnosticFileState {
  param([object]$OutputFile)
  $path = (Get-D03DiagnosticText -Value $OutputFile).value
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return [ordered]@{ exists = $false; bytes = 0; path = $path }
  }
  return [ordered]@{ exists = $true; bytes = [int64](Get-Item -LiteralPath $path).Length; path = $path }
}

function New-D03CommandDiagnostic {
  param(
    [object]$ExitCode,
    [object]$Stdout,
    [object]$Stderr,
    [object]$CommandResult,
    [object]$OutputFile,
    [object]$StartedAt,
    [object]$FinishedAt
  )
  $output = Get-D03DiagnosticFileState $OutputFile
  $duration = $null
  if ($StartedAt -is [datetime] -and $FinishedAt -is [datetime]) {
    $duration = [math]::Round(($FinishedAt - $StartedAt).TotalSeconds, 3)
  }
  $normalizedExitCode = $null
  if ($null -ne $ExitCode) { $normalizedExitCode = [int]$ExitCode }
  return [ordered]@{
    exit_code = $normalizedExitCode
    stdout = (Get-D03RedactedText -Value $Stdout).value
    stderr = (Get-D03RedactedText -Value $Stderr).value
    command_result_present = ($null -ne $CommandResult)
    output_file = $output
    duration_seconds = $duration
    status = if ($normalizedExitCode -eq 0) { 'completed' } else { 'failed' }
  }
}

function Test-D03ArchiveDiagnostic {
  param([hashtable]$Diagnostic)

  return ($Diagnostic.exit_code -eq 0 -and $Diagnostic.output_file.exists -and $Diagnostic.output_file.bytes -gt 0)
}

function New-D03ErrorDiagnostic {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)

  if ($null -eq $ErrorRecord) {
    return [ordered]@{ error_record = $null; script_stack_trace = $null; invocation = $null }
  }

  $invocation = $ErrorRecord.InvocationInfo
  return [ordered]@{
    error_record = (Get-D03RedactedText -Value $ErrorRecord.ToString()).value
    script_stack_trace = (Get-D03RedactedText -Value $ErrorRecord.ScriptStackTrace).value
    invocation = [ordered]@{
      script_name = (Get-D03RedactedText -Value $invocation.ScriptName).value
      line_number = if ($null -eq $invocation) { $null } else { $invocation.ScriptLineNumber }
      function_name = (Get-D03RedactedText -Value $invocation.MyCommand).value
      position_message = (Get-D03RedactedText -Value $invocation.PositionMessage).value
      line = (Get-D03RedactedText -Value $invocation.Line).value
    }
  }
}

function Write-D03DiagnosticJson {
  param([hashtable]$Diagnostic, [string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'D03 diagnostic JSON path is required.' }
  $Diagnostic | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Path -Encoding utf8
}

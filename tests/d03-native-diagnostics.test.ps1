$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\tools\d03-native-diagnostics.ps1')

function Assert-D03Diagnostic {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$root = Join-Path $env:TEMP ('d03-diagnostic-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $archive = Join-Path $root 'archive.dump'
  [System.IO.File]::WriteAllBytes($archive, @(1,2,3))
  $cases = @(
    @{ name='CASE 1'; exit=0; out=$null; err=$null; result=[pscustomobject]@{}; file=$null; archiveValid=$false },
    @{ name='CASE 2'; exit=0; out=''; err=''; result=[pscustomobject]@{}; file=$null; archiveValid=$false },
    @{ name='CASE 3'; exit=0; out='ok'; err=$null; result=[pscustomobject]@{}; file=$null; archiveValid=$false },
    @{ name='CASE 4'; exit=1; out=$null; err='test error'; result=[pscustomobject]@{}; file=$null; archiveValid=$false },
    @{ name='CASE 5'; exit=1; out=$null; err=$null; result=[pscustomobject]@{}; file=$null; archiveValid=$false },
    @{ name='CASE 6'; exit=0; out=$null; err=$null; result=$null; file=$null; archiveValid=$false },
    @{ name='CASE 7'; exit=0; out=$null; err=$null; result=[pscustomobject]@{}; file=$archive; archiveValid=$true },
    @{ name='CASE 8'; exit=0; out=$null; err=$null; result=[pscustomobject]@{}; file=(Join-Path $root 'missing.dump'); archiveValid=$false }
  )
  foreach ($case in $cases) {
    $value = New-D03CommandDiagnostic -ExitCode $case.exit -Stdout $case.out -Stderr $case.err -CommandResult $case.result -OutputFile $case.file -StartedAt (Get-Date) -FinishedAt (Get-Date)
    Assert-D03Diagnostic -Condition ($value.status -eq $(if ($case.exit -eq 0) { 'completed' } else { 'failed' })) -Message "$($case.name) status mismatch"
    Assert-D03Diagnostic -Condition ($null -ne $value.stdout -and $null -ne $value.stderr) -Message "$($case.name) null text field"
    Assert-D03Diagnostic -Condition ((Test-D03ArchiveDiagnostic -Diagnostic $value) -eq $case.archiveValid) -Message "$($case.name) archive validation mismatch"
    if ($case.name -eq 'CASE 6') { Assert-D03Diagnostic -Condition (-not $value.command_result_present) -Message 'CASE 6 did not record null command result' }
    if ($case.name -eq 'CASE 8') { Assert-D03Diagnostic -Condition (-not $value.output_file.exists) -Message 'CASE 8 did not record missing output file' }
    $json = Join-Path $root ($case.name.Replace(' ','-') + '.json')
    Write-D03DiagnosticJson -Diagnostic $value -Path $json
    $parsed = Get-Content -Raw $json | ConvertFrom-Json
    Assert-D03Diagnostic -Condition ($null -ne $parsed) -Message "$($case.name) JSON did not parse"
  }
  try { throw 'synthetic diagnostic failure' } catch {
    $failure = New-D03ErrorDiagnostic -ErrorRecord $_
    $failurePath = Join-Path $root 'failure.json'
    Write-D03DiagnosticJson -Diagnostic $failure -Path $failurePath
    $parsedFailure = Get-Content -Raw $failurePath | ConvertFrom-Json
    Assert-D03Diagnostic -Condition (-not [string]::IsNullOrWhiteSpace($parsedFailure.error_record)) -Message 'Failure diagnostic lacks error record'
    Assert-D03Diagnostic -Condition ($null -ne $parsedFailure.invocation.line_number) -Message 'Failure diagnostic lacks line number'
  }
  'D03 native diagnostic tests passed: 8 cases plus error-context capture.'
}
finally { Remove-Item -LiteralPath $root -Recurse -Force }

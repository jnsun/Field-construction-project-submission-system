$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\tools\d03-cleanup-state.ps1')

if (-not (Test-D03DisposableCleanup -SourceCreated $true -SourceCleaned $true -RestoreCreated $false -RestoreCleaned $false)) {
  throw 'An uncreated restore database must not make cleanup fail.'
}
if (Test-D03DisposableCleanup -SourceCreated $true -SourceCleaned $false -RestoreCreated $false -RestoreCleaned $false) {
  throw 'A created source database that was not cleaned must fail cleanup.'
}

'D03 disposable cleanup-state tests passed.'

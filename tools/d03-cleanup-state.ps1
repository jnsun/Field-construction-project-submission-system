function Test-D03DisposableCleanup {
  param(
    [bool]$SourceCreated,
    [bool]$SourceCleaned,
    [bool]$RestoreCreated,
    [bool]$RestoreCleaned
  )

  return ((-not $SourceCreated -or $SourceCleaned) -and (-not $RestoreCreated -or $RestoreCleaned))
}

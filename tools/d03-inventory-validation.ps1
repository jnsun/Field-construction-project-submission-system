function Assert-D03Inventory {
  param([object[]]$Rows)

  $tables = @($Rows | Where-Object { $_.category -eq 'table' })
  if ($tables.Count -lt 1) { throw 'Restored D03 inventory has no target tables.' }

  $disabledTables = @(
    foreach ($table in $tables) {
      try { $details = $table.details | ConvertFrom-Json -ErrorAction Stop }
      catch { throw "D03 table inventory has invalid JSON details for $($table.object_name)." }
      if ($details.rls_enabled -ne $true) { $table.object_name }
    }
  )
  if ($disabledTables.Count -gt 0) {
    throw "Restored D03 inventory has missing or disabled RLS tables: $($disabledTables -join ', ')."
  }

  if (@($Rows | Where-Object { $_.category -eq 'function' }).Count -lt 1) { throw 'Restored D03 inventory has no target functions.' }
  if (@($Rows | Where-Object { $_.category -eq 'trigger' }).Count -lt 1) { throw 'Restored D03 inventory has no target triggers.' }
  return $Rows
}

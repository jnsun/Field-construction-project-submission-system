$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\tools\d03-inventory-validation.ps1')

function Assert-D03Test([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function New-D03Rows([object[]]$Tables) {
  return @($Tables + @(
    [pscustomobject]@{ category = 'function'; object_name = 'training_test()'; details = '{}' },
    [pscustomobject]@{ category = 'trigger'; object_name = 'training_test.trigger'; details = '{}' }
  ))
}

Assert-D03Inventory -Rows (New-D03Rows @(
  [pscustomobject]@{ category = 'table'; object_name = 'enabled_table'; details = '{"rls_enabled":true,"rls_forced":false}' }
)) | Out-Null

try {
  Assert-D03Inventory -Rows (New-D03Rows @(
    [pscustomobject]@{ category = 'table'; object_name = 'disabled_table'; details = '{"rls_enabled":false,"rls_forced":false}' }
  )) | Out-Null
  throw 'Disabled table did not fail.'
}
catch {
  Assert-D03Test ($_.Exception.Message -match 'disabled_table') 'Disabled table name was not reported.'
}

Assert-D03Inventory -Rows (New-D03Rows @(
  [pscustomobject]@{ category = 'table'; object_name = 'reordered_table'; details = '{
  "rls_forced": false,
  "rls_enabled": true
}' }
)) | Out-Null

'D03 inventory validation tests passed: enabled, disabled-name, and formatting-independent JSON cases.'

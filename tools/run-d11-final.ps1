param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$started = Get-Date

function Run-Step([string]$Name, [string]$Program, [string[]]$CommandArgs) {
  Write-Host "D11 FINAL PHASE: $Name"
  & $Program @CommandArgs
  $processExitCode = $LASTEXITCODE
  if ($processExitCode -ne 0) { throw "D11 FINAL failed at $Name (exit $processExitCode)" }
  Write-Host "D11 FINAL PASS: $Name"
}

if ($SelfTest) {
  Run-Step 'argument-forwarding-self-test' 'node' @('-e', "if (process.argv[1] !== 'D11_ARG_OK') process.exit(9)", 'D11_ARG_OK')
  $failureWasCaught = $false
  try { Run-Step 'exit-propagation-self-test' 'node' @('-e', 'process.exit(7)') }
  catch {
    if ($_.Exception.Message -notmatch 'exit 7') { throw }
    $failureWasCaught = $true
  }
  if (-not $failureWasCaught) { throw 'D11 runner did not propagate a child-process failure' }
  Write-Host 'D11_RUNNER_SELF_TEST PASS arguments=forwarded failure_exit=7'
  exit 0
}

Run-Step 'migration-manifest' 'node' @('tests/verify-d03-migration-files.js')
Run-Step 'operations-js-syntax' 'node' @('--check', 'js/modules/training/admission-operations.js')
Run-Step 'mine-js-syntax' 'node' @('--check', 'js/modules/training/admission-mine.js')
Run-Step 'plans-js-syntax' 'node' @('--check', 'js/modules/training/plans.js')
Run-Step 'legacy-d11-test-syntax' 'node' @('--check', 'tests/e2e/d11-three-level-training-reuse.js')
Run-Step 'r02-test-syntax' 'node' @('--check', 'tests/e2e/d11-r02-p1-closure.js')
Run-Step 'v83-test-syntax' 'node' @('--check', 'tests/e2e/d11-employee-three-level-foundation.js')
Run-Step 'contract-json' 'node' @('-e', "JSON.parse(require('fs').readFileSync('docs/contracts/D11-three-level-training-v1.json','utf8')); console.log('D11 contract JSON PASS')")
Run-Step 'employee-three-level-final-rules' 'node' @('tests/e2e/d11-employee-three-level-foundation.js')
Run-Step 'd09-scope-hours-regression' 'node' @('tests/e2e/d09-plan-scope-hours-targets.js')
Run-Step 'd09-lifecycle-history-regression' 'node' @('tests/e2e/d09-plan-lifecycle-audit.js')
Run-Step 'diff-check' 'git' @('diff', '--check')

$seconds = ((Get-Date) - $started).TotalSeconds
Write-Host ("D11_FINAL PASS duration={0:N2}s" -f $seconds)

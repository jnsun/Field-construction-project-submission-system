param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$started = Get-Date

function Run-Step([string]$Name, [string]$Program, [string[]]$CommandArgs) {
  Write-Host "D15 FINAL PHASE: $Name"
  & $Program @CommandArgs
  $processExitCode = $LASTEXITCODE
  if ($processExitCode -ne 0) { throw "D15 FINAL failed at $Name (exit $processExitCode)" }
  Write-Host "D15 FINAL PASS: $Name"
}

if ($SelfTest) {
  Run-Step 'argument-forwarding-self-test' 'node' @('-e', "if (process.argv[1] !== 'D15_ARG_OK') process.exit(9)", 'D15_ARG_OK')
  $caught = $false
  try { Run-Step 'exit-propagation-self-test' 'node' @('-e', 'process.exit(7)') } catch { $caught = $_.Exception.Message -match 'exit 7' }
  if (-not $caught) { throw 'D15 runner did not propagate child failure' }
  Write-Host 'D15_RUNNER_SELF_TEST PASS'
  exit 0
}

Run-Step 'migration-manifest' 'node' @('tests/verify-d03-migration-files.js')
Run-Step 'signature-module-syntax' 'node' @('--check', 'js/modules/training/signature-evidence.js')
Run-Step 'training-module-syntax' 'node' @('--check', 'js/modules/training/training.js')
Run-Step 'mine-module-syntax' 'node' @('--check', 'js/modules/training/mine.js')
Run-Step 'd15-test-syntax' 'node' @('--check', 'tests/e2e/d15-electronic-signature-evidence.js')
Run-Step 'd15-r02-1-test-syntax' 'node' @('--check', 'tests/e2e/d15-r02-authority-prerequisites.js')
Run-Step 'd15-r02-2a-test-syntax' 'node' @('--check', 'tests/e2e/d15-r02-organization-cycle.js')
Run-Step 'd15-edge-function-type-check' 'npx.cmd' @('--yes', 'deno', 'check', 'supabase/functions/d15-validate-signature/index.ts')
Run-Step 'd15-actual-image-decode' 'npx.cmd' @('--yes', 'deno', 'test', '--allow-read', 'tests/e2e/d15-r02-file-bytes_test.ts')
Run-Step 'machine-contract' 'node' @('tests/d15-signature-contract.js')
Run-Step 'web-smoke' 'node' @('tests/d15-signature-web.js')
Run-Step 'storage-static-boundary' 'node' @('tests/verify-d03-storage-boundary.js')
Run-Step 'd15-electronic-signature-evidence' 'node' @('tests/e2e/d15-electronic-signature-evidence.js')
Run-Step 'd15-r02-authority-prerequisites' 'node' @('tests/e2e/d15-r02-authority-prerequisites.js')
Run-Step 'd15-r02-organization-authority' 'node' @('tests/e2e/d15-r02-organization-cycle.js', '--segment', 'organization')
Run-Step 'd15-r02-supersede-cycle' 'node' @('tests/e2e/d15-r02-organization-cycle.js', '--segment', 'supersede')
Run-Step 'd09-package-version-regression' 'node' @('tests/e2e/d09-history-content-boundary.js')
Run-Step 'd09-storage-binding-regression' 'node' @('tests/e2e/d09-storage-binding-boundary.js')
Run-Step 'd11-requirement-snapshot-regression' 'node' @('tests/e2e/s3d-config-driven-cutover.js')
Run-Step 'd13-authoritative-result-regression' 'node' @('tests/e2e/d13-authoritative-exams.js')
Run-Step 'd07-project-permission-regression' 'node' @('tests/e2e/d07-role-permission-matrix.js')
Run-Step 'diff-check' 'git' @('diff', '--check')

$seconds = ((Get-Date) - $started).TotalSeconds
Write-Host ("D15_FINAL PASS duration={0:N2}s" -f $seconds)

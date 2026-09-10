param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$started = Get-Date

function Run-Step([string]$Name, [string]$Program, [string[]]$CommandArgs) {
  Write-Host "D16 FINAL PHASE: $Name"
  & $Program @CommandArgs
  $processExitCode = $LASTEXITCODE
  if ($processExitCode -ne 0) { throw "D16 FINAL failed at $Name (exit $processExitCode)" }
  Write-Host "D16 FINAL PASS: $Name"
}

if ($SelfTest) {
  Run-Step 'argument-forwarding-self-test' 'node' @('-e', "if (process.argv[1] !== 'D16_ARG_OK') process.exit(9)", 'D16_ARG_OK')
  $caught = $false
  try { Run-Step 'exit-propagation-self-test' 'node' @('-e', 'process.exit(7)') } catch { $caught = $_.Exception.Message -match 'exit 7' }
  if (-not $caught) { throw 'D16 runner did not propagate child failure' }
  Write-Host 'D16_RUNNER_SELF_TEST PASS'
  exit 0
}

Run-Step 'migration-manifest' 'node' @('tests/verify-d03-migration-files.js')
Run-Step 'd16-web-syntax' 'node' @('--check', 'js/modules/training/site-confirmation.js')
Run-Step 'training-entry-syntax' 'node' @('--check', 'js/modules/training/training.js')
Run-Step 'd16-test-syntax' 'node' @('--check', 'tests/e2e/d16-site-confirmation.js')
Run-Step 'd16-edge-type-check' 'npx.cmd' @('--yes', 'deno', 'check', 'supabase/functions/d16-validate-site-photo/index.ts')
Run-Step 'd16-actual-photo-decode' 'npx.cmd' @('--yes', 'deno', 'test', '--allow-read', 'tests/e2e/d16-site-photo-bytes_test.ts')
Run-Step 'd16-machine-contract' 'node' @('tests/d16-site-confirmation-contract.js')
Run-Step 'd16-web-smoke' 'node' @('tests/d16-site-confirmation-web.js')
Run-Step 'storage-static-boundary' 'node' @('tests/verify-d03-storage-boundary.js')
Run-Step 'd16-r02-focused-and-d15-prerequisite' 'node' @('tests/e2e/d16-r02-prerequisite-old-path.js')
Run-Step 'd16-authoritative-site-confirmation' 'node' @('tests/e2e/d16-site-confirmation.js')
Run-Step 'd08-personnel-and-certificate-regression' 'node' @('tests/e2e/d08-contractor-archive-certificate-compliance.js')
Run-Step 'd07-project-role-regression' 'node' @('tests/e2e/d07-role-permission-matrix.js')
Run-Step 'd11-foundation-regression' 'node' @('tests/e2e/d11-employee-three-level-foundation.js')
Run-Step 'd11-reuse-regression' 'node' @('tests/e2e/d11-three-level-training-reuse.js')
Run-Step 'd12-special-requirement-regression' 'node' @('tests/e2e/d12-special-work-requirements.js')
Run-Step 'd13-authoritative-exam-regression' 'node' @('tests/e2e/d13-authoritative-exams.js')
Run-Step 'diff-check' 'git' @('diff', '--check')

$seconds = ((Get-Date) - $started).TotalSeconds
Write-Host ("D16_FINAL PASS duration={0:N2}s" -f $seconds)

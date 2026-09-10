param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$started = Get-Date

function Run-Step([string]$Name, [string]$Program, [string[]]$CommandArgs) {
  Write-Host "D13 FINAL PHASE: $Name"
  & $Program @CommandArgs
  $processExitCode = $LASTEXITCODE
  if ($processExitCode -ne 0) { throw "D13 FINAL failed at $Name (exit $processExitCode)" }
  Write-Host "D13 FINAL PASS: $Name"
}

if ($SelfTest) {
  Run-Step 'argument-forwarding-self-test' 'node' @('-e', "if (process.argv[1] !== 'D13_ARG_OK') process.exit(9)", 'D13_ARG_OK')
  $caught = $false
  try { Run-Step 'exit-propagation-self-test' 'node' @('-e', 'process.exit(7)') } catch { $caught = $_.Exception.Message -match 'exit 7' }
  if (-not $caught) { throw 'D13 runner did not propagate child failure' }
  Write-Host 'D13_RUNNER_SELF_TEST PASS'
  exit 0
}

Run-Step 'migration-manifest' 'node' @('tests/verify-d03-migration-files.js')
Run-Step 'mine-js-syntax' 'node' @('--check', 'js/modules/training/mine.js')
Run-Step 'admission-mine-js-syntax' 'node' @('--check', 'js/modules/training/admission-mine.js')
Run-Step 'papers-js-syntax' 'node' @('--check', 'js/modules/training/papers.js')
Run-Step 'three-level-config-js-syntax' 'node' @('--check', 'js/modules/training/three-level-config.js')
Run-Step 'training-employees-js-syntax' 'node' @('--check', 'js/modules/training/employees.js')
Run-Step 'people-js-syntax' 'node' @('--check', 'js/modules/people/people.js')
Run-Step 'd13-test-syntax' 'node' @('--check', 'tests/e2e/d13-authoritative-exams.js')
Run-Step 'r02-authorization-test-syntax' 'node' @('--check', 'tests/e2e/d13-r02-authorization-boundaries.js')
Run-Step 'r02-integrity-test-syntax' 'node' @('--check', 'tests/e2e/d13-r02-integrity-boundaries.js')
Run-Step 'contract-json' 'node' @('-e', "for (const f of ['V11-d00-d13-compatibility-v1.json','D11-three-level-training-v1.json','D12-special-work-requirements-v1.json','D13-authoritative-exams-v1.json','three-level-training-schemes-v1.json','three-level-training-resolution-v1.json']) JSON.parse(require('fs').readFileSync('docs/contracts/'+f,'utf8')); console.log('D13 contract JSON PASS 6/6')")
Run-Step 'v11-compatibility' 'node' @('tests/e2e/d13-v11-compatibility.js')
Run-Step 'r02-authorization-boundaries' 'node' @('tests/e2e/d13-r02-authorization-boundaries.js')
Run-Step 'r02-integrity-boundaries' 'node' @('tests/e2e/d13-r02-integrity-boundaries.js')
Run-Step 'd11-prerequisite-regression' 'node' @('tests/e2e/d11-employee-three-level-foundation.js')
Run-Step 'd11-reuse-regression' 'node' @('tests/e2e/d11-three-level-training-reuse.js')
Run-Step 's3a-training-scheme-foundation' 'node' @('tests/e2e/s3a-training-scheme-foundation.js')
Run-Step 's3b-training-requirement-resolver' 'node' @('tests/e2e/s3b-training-requirement-resolver.js')
Run-Step 's3c-training-scheme-console' 'node' @('tests/e2e/s3c-training-scheme-console.js')
Run-Step 's3c-web-smoke' 'node' @('tests/s3c-three-level-config-web.js')
Run-Step 's3d-config-driven-cutover' 'node' @('tests/e2e/s3d-config-driven-cutover.js')
Run-Step 'd12-special-requirement-regression' 'node' @('tests/e2e/d12-special-work-requirements.js')
Run-Step 'd13-authoritative-exams' 'node' @('tests/e2e/d13-authoritative-exams.js')
Run-Step 'diff-check' 'git' @('diff', '--check')

$seconds = ((Get-Date) - $started).TotalSeconds
Write-Host ("D13_FINAL PASS duration={0:N2}s" -f $seconds)

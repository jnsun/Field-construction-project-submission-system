/** Single entrypoint for the one-time D05 final acceptance run. */
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertD02FixtureMarker,
  validateTestBoundary,
} = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const suites = [
  ['D05 assertion self-test', 'tests/e2e/d05-security-baseline.test.js'],
  ['D05 role/RLS negative API', 'tests/e2e/d05-security-baseline.js'],
  ['D05 statistics function permissions', 'tests/e2e/d05-stats-function-permissions.js'],
  ['D05 final blocker regressions', 'tests/e2e/d05-final-blockers.js'],
  ['D05 final security areas', 'tests/e2e/d05-final-security-areas.js'],
  ['D05 secret scan', 'tests/verify-d05-secret-scan.js'],
];

function main() {
  const totalStarted = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const fixtureMarkers = assertD02FixtureMarker(boundary);
  console.log(`PASS D05-FINAL-GATE isolated_test fixture_markers=${fixtureMarkers}`);

  const results = [];
  for (const [name, relativeFile] of suites) {
    const started = process.hrtime.bigint();
    const child = spawnSync(process.execPath, [path.join(root, relativeFile)], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    const status = child.error ? 2 : child.status;
    results.push({ name, status, elapsed_ms: Number(elapsedMs.toFixed(0)) });
    console.log(`${status === 0 ? 'PASS' : 'FAIL'} D05-FINAL-SUITE name=${name} exit=${status} elapsed_ms=${elapsedMs.toFixed(0)}`);
  }

  const failed = results.filter(result => result.status !== 0);
  const totalMs = Number(process.hrtime.bigint() - totalStarted) / 1e6;
  console.log(JSON.stringify({
    suite: 'D05-FINAL',
    passed: results.length - failed.length,
    failed: failed.length,
    elapsed_ms: Number(totalMs.toFixed(0)),
    results,
  }));
  process.exitCode = failed.length ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`FAIL D05-FINAL-RUNNER ${error.message}`);
  process.exitCode = 2;
}

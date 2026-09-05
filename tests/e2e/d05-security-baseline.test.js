const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  classifyClosedDirectTable,
  classifyExpectedDenial,
  classifyLegalAccess,
} = require('./d05-security-baseline');

const startedAt = process.hrtime.bigint();
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.error(`FAIL ${name} ${error.message}`);
  }
}

check('legal access succeeds with valid business result', () => {
  const result = classifyLegalAccess(
    { status: 200, json: [{ id: 'entity-user' }] },
    rows => Array.isArray(rows) && rows.length === 1 && rows[0].id === 'entity-user',
    true,
  );
  assert.deepEqual(result, { ok: true, kind: 'legal_access_succeeded' });
});

check('normal permission denial is accepted', () => {
  const result = classifyExpectedDenial(
    { status: 403, json: { code: '42501', message: 'denied' } },
    true,
  );
  assert.deepEqual(result, { ok: true, kind: 'permission_rule_denied' });
});

check('missing table privilege is not accepted as a denial pass', () => {
  const result = classifyExpectedDenial(
    { status: 403, json: { code: '42501', message: 'permission denied for table' } },
    false,
  );
  assert.deepEqual(result, { ok: false, kind: 'table_privilege_missing' });
});

check('intentionally closed direct-table path is identified separately', () => {
  const result = classifyClosedDirectTable(
    { status: 403, json: { code: '42501', message: 'permission denied for table' } },
    false,
  );
  assert.deepEqual(result, { ok: true, kind: 'direct_table_access_closed' });
});

check('404 and parameter errors cannot impersonate permission denial', () => {
  assert.equal(classifyExpectedDenial({ status: 401, json: { code: 'PGRST301' } }, true).ok, false);
  assert.equal(classifyExpectedDenial({ status: 404, json: { code: 'PGRST202' } }, true).ok, false);
  assert.equal(classifyExpectedDenial({ status: 400, json: { code: '22P02' } }, true).ok, false);
  assert.equal(classifyExpectedDenial({ status: 500, json: { code: 'XX000' } }, true).ok, false);
});

check('non-test environment is rejected by the shared D04 gate', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'd05-security-baseline.js')], {
    env: { ...process.env, SAFETY_ENV: 'inspection' },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /SAFETY_ENV 不是 test/);
  assert.doesNotMatch(result.stdout, /D05-AC\d+/);
});

const failed = checks.filter(item => !item.ok);
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
console.log(JSON.stringify({ suite: 'D05-SELF', passed: checks.length - failed.length, failed: failed.length, elapsed_ms: Number(elapsedMs.toFixed(3)) }));
process.exitCode = failed.length ? 1 : 0;

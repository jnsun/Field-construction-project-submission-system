/**
 * Repeatable D04 statistics baseline runner.
 * Creates only isolated synthetic data and always cleans it in finally.
 */
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
} = require('./d04-test-environment');

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} 不是有效 UUID。`);
  }
  return value;
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('D04 统计测试数据库操作失败；事务已回滚。');
  }
}

function readJson(databaseUrl, sql) {
  const output = runPsqlScalar(databaseUrl, sql);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('无法解析 D04 统计测试库只读结果。');
  }
}

function selectFixtureScope(databaseUrl) {
  const entityEmail = sqlLiteral(required('SAFETY_TEST_ENTITY_EMAIL'));
  const sql = `
WITH entity_person AS (
  SELECT p.department_id, COALESCE(p.employee_id, e.id) AS employee_id
  FROM auth.users u
  JOIN public.profiles p ON p.id = u.id
  LEFT JOIN LATERAL (
    SELECT te.id FROM public.training_employees te
    JOIN public.safety_test_fixture_registry r
      ON r.run_key='D02-TEST-20260903'
     AND r.table_name='training_employees'
     AND r.record_id=te.id
    WHERE te.department_id=p.department_id
    ORDER BY te.id LIMIT 1
  ) e ON true
  WHERE u.email=${entityEmail}
), outside_person AS (
  SELECT te.department_id, te.id AS employee_id
  FROM public.training_employees te
  JOIN public.safety_test_fixture_registry er
    ON er.run_key='D02-TEST-20260903'
   AND er.table_name='training_employees'
   AND er.record_id=te.id
  JOIN public.safety_test_fixture_registry dr
    ON dr.run_key='D02-TEST-20260903'
   AND dr.table_name='departments'
   AND dr.record_id=te.department_id
  WHERE te.department_id IS NOT NULL
    AND te.department_id<>(SELECT department_id FROM entity_person)
  ORDER BY te.department_id,te.id LIMIT 1
)
SELECT json_build_object(
  'entityDept',(SELECT department_id FROM entity_person),
  'entityEmployee',(SELECT employee_id FROM entity_person),
  'outsideDept',(SELECT department_id FROM outside_person),
  'outsideEmployee',(SELECT employee_id FROM outside_person),
  'completionThreshold',(SELECT completion_threshold FROM public.stats_settings WHERE id=1),
  'overdueGraceDays',(SELECT overdue_grace_days FROM public.stats_settings WHERE id=1)
)::text;
`;
  const scope = readJson(databaseUrl, sql);
  for (const [key, value] of Object.entries(scope)) {
    if (key === 'completionThreshold' || key === 'overdueGraceDays') continue;
    assertUuid(value, key);
  }
  if (!Number.isFinite(Number(scope.completionThreshold)) || !Number.isInteger(Number(scope.overdueGraceDays))) {
    throw new Error('统计设置基线无效。');
  }
  return scope;
}

function assertCleanBaseline(databaseUrl, runKey) {
  const sql = `
SELECT concat_ws('|',
  (SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key=${sqlLiteral(runKey)}),
  (SELECT count(*) FROM public.training_assignments),
  (SELECT count(*) FROM public.stats_alerts),
  (SELECT count(*) FROM public.stats_alert_reads),
  (SELECT count(*) FROM public.stats_cert_targets),
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'stats_%')
);
`;
  const state = runPsqlScalar(databaseUrl, sql);
  if (state !== '0|0|0|0|0|10') {
    throw new Error(`统计测试基线不干净或 Schema 不完整（${state}），拒绝覆盖未知数据。`);
  }
}

function seedSql(ids, scope, runKey) {
  return `
INSERT INTO public.training_plans(
  id,title,category,level,department_id,plan_year,plan_month,hours,
  target_desc,content,status,remark,require_exam,exam_mode
) VALUES (
  '${ids.plan}'::uuid,'[D04-TEST] Statistics baseline','D04-TEST','company',
  '${scope.outsideDept}'::uuid,2026,9,1,'D04 isolated synthetic fixture',
  'D04 TEST data only','ongoing',${sqlLiteral(runKey)},false,'none'
);
INSERT INTO public.training_assignments(id,plan_id,employee_id,department_id,status,progress,exam_status)
VALUES
  ('${ids.entityAssignment}'::uuid,'${ids.plan}'::uuid,'${scope.entityEmployee}'::uuid,'${scope.entityDept}'::uuid,'pending',0,'none'),
  ('${ids.outsideAssignment}'::uuid,'${ids.plan}'::uuid,'${scope.outsideEmployee}'::uuid,'${scope.outsideDept}'::uuid,'pending',0,'none');
INSERT INTO public.safety_test_fixture_registry(run_key,table_name,record_id,fixture_role)
VALUES
  (${sqlLiteral(runKey)},'training_plans','${ids.plan}'::uuid,'D04-TEST statistics plan'),
  (${sqlLiteral(runKey)},'training_assignments','${ids.entityAssignment}'::uuid,'D04-TEST statistics assignment'),
  (${sqlLiteral(runKey)},'training_assignments','${ids.outsideAssignment}'::uuid,'D04-TEST statistics assignment');
`;
}

function cleanupSql(ids, scope, runKey) {
  const threshold = Number(scope.completionThreshold);
  const graceDays = Number(scope.overdueGraceDays);
  return `
DELETE FROM public.stats_alerts
WHERE plan_id='${ids.plan}'::uuid
   OR dedup_key LIKE 'unit_completion:${scope.entityDept}:all:%'
   OR dedup_key LIKE 'unit_completion:${scope.outsideDept}:all:%';
DELETE FROM public.stats_cert_targets
WHERE department_id IN ('${scope.entityDept}'::uuid,'${scope.outsideDept}'::uuid);
UPDATE public.stats_settings
SET completion_threshold=${threshold},overdue_grace_days=${graceDays},updated_at=now()
WHERE id=1;
DELETE FROM public.training_assignments
WHERE id IN ('${ids.entityAssignment}'::uuid,'${ids.outsideAssignment}'::uuid);
DELETE FROM public.training_plans WHERE id='${ids.plan}'::uuid;
DELETE FROM public.safety_test_fixture_registry WHERE run_key=${sqlLiteral(runKey)};
`;
}

function assertZeroResidue(databaseUrl, ids, runKey) {
  const sql = `
SELECT concat_ws('|',
  (SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key=${sqlLiteral(runKey)}),
  (SELECT count(*) FROM public.training_plans WHERE id='${ids.plan}'::uuid),
  (SELECT count(*) FROM public.training_assignments
    WHERE id IN ('${ids.entityAssignment}'::uuid,'${ids.outsideAssignment}'::uuid)),
  (SELECT count(*) FROM public.stats_alerts),
  (SELECT count(*) FROM public.stats_alert_reads),
  (SELECT count(*) FROM public.stats_cert_targets)
);
`;
  const state = runPsqlScalar(databaseUrl, sql);
  if (state !== '0|0|0|0|0|0') throw new Error(`D04 统计测试残留不为 0（${state}）。`);
  console.log('D04_STATS_CLEANUP=PASS; registry|plan|assignments|alerts|reads|targets=0|0|0|0|0|0');
}

function main() {
  const boundary = validateTestBoundary();
  const markerCount = assertD02FixtureMarker(boundary);
  const runKey = `D04-STATS-TEST-${Date.now()}-${process.pid}`;
  const ids = {
    plan: randomUUID(),
    entityAssignment: randomUUID(),
    outsideAssignment: randomUUID(),
  };
  let scope;
  let seeded = false;
  let testStatus = 2;
  let cleanupError;

  console.log(`D04_TEST_GATE=PASS; d02_fixture_markers=${markerCount}`);
  assertCleanBaseline(boundary.databaseUrl, runKey);
  scope = selectFixtureScope(boundary.databaseUrl);

  try {
    runPsql(boundary.databaseUrl, seedSql(ids, scope, runKey));
    seeded = true;
    const fixtureState = runPsqlScalar(boundary.databaseUrl,
      `SELECT concat(count(*),'|',count(DISTINCT a.department_id)) FROM public.training_assignments a WHERE a.id IN ('${ids.entityAssignment}'::uuid,'${ids.outsideAssignment}'::uuid);`);
    if (fixtureState !== '2|2') throw new Error(`统计测试夹具不完整（${fixtureState}）。`);
    console.log('D04_STATS_FIXTURE=READY; plans=1; assignments=2; departments=2');

    const startedAt = process.hrtime.bigint();
    const test = spawnSync(process.execPath, [require.resolve('./verify-stats')], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    process.stdout.write(test.stdout || '');
    process.stderr.write(test.stderr || '');
    testStatus = test.error ? 2 : test.status;
    console.log(`D04_STATS_TEST_EXIT=${testStatus}; elapsed_ms=${elapsedMs.toFixed(0)}`);
  } finally {
    if (seeded) {
      try {
        runPsql(boundary.databaseUrl, cleanupSql(ids, scope, runKey));
        assertZeroResidue(boundary.databaseUrl, ids, runKey);
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError) throw cleanupError;
  process.exitCode = testStatus;
}

try {
  main();
} catch (error) {
  console.error(`D04 statistics runner stopped: ${error.message}`);
  process.exitCode = 2;
}

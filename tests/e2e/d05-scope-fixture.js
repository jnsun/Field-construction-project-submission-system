const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { runPsqlScalar } = require('./d04-test-environment');

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPsql(databaseUrl, sql, action) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${action}失败`);
  }
}

function readD02Scope(boundary) {
  const sql = `
SELECT json_build_object(
  'legal_project_id', (SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'),
  'legal_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
  'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
  'entity_user_id', (
    SELECT p.id
    FROM public.profiles p
    JOIN public.training_employees e ON e.id=p.employee_id
    WHERE e.employee_no='D02-002'
  ),
  'entity_user_count', (
    SELECT count(*)
    FROM public.profiles p
    JOIN public.training_employees e ON e.id=p.employee_id
    JOIN public.departments d ON d.id=p.department_id
    WHERE e.employee_no='D02-002' AND d.code='D02-ENT-A' AND p.role='admin'
  ),
  'fixture_marker_count', (
    SELECT count(*)
    FROM public.safety_test_fixture_registry r
    WHERE r.run_key='D02-TEST-20260903'
      AND (
        (r.table_name='site_projects' AND r.record_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'))
        OR (r.table_name='departments' AND r.record_id IN (
          SELECT id FROM public.departments WHERE code IN ('D02-ENT-A','D02-ENT-B')
        ))
      )
  )
)::text;
`;
  const scope = JSON.parse(runPsqlScalar(boundary.databaseUrl, sql));
  if (!scope.legal_project_id || !scope.legal_entity_id || !scope.outside_entity_id
      || !scope.entity_user_id || scope.entity_user_count !== 1 || scope.fixture_marker_count !== 3) {
    throw new Error('D02 项目/经营实体/测试账号夹具不完整，拒绝补充 D05 临时夹具');
  }
  return scope;
}

function createScopeFixture(boundary) {
  const scope = readD02Scope(boundary);
  const fixture = {
    ...scope,
    runKey: `D05-SCOPE-${crypto.randomUUID()}`,
    outsideProjectId: crypto.randomUUID(),
    projectRoleId: crypto.randomUUID(),
  };
  const projectCode = `D05-SCOPE-${fixture.outsideProjectId.slice(0, 12).toUpperCase()}`;
  const sql = `
BEGIN;
SET LOCAL app.safety_test_confirmation='D02_TEST_ONLY';
DO $$ BEGIN
  IF current_setting('app.safety_test_confirmation', true) <> 'D02_TEST_ONLY' THEN
    RAISE EXCEPTION 'D05 test fixture boundary rejected';
  END IF;
END $$;
INSERT INTO public.site_projects(
  id, project_code, name, project_type, location, status,
  start_date, expected_end_date, lead_entity_id, report_notes
) VALUES (
  ${sqlLiteral(fixture.outsideProjectId)}::uuid,
  ${sqlLiteral(projectCode)},
  '[D05-TEST] 跨实体最小项目',
  '安全验收',
  'D05 隔离测试区',
  'active', CURRENT_DATE, CURRENT_DATE + 1,
  ${sqlLiteral(fixture.outside_entity_id)}::uuid,
  ${sqlLiteral(fixture.runKey)}
);
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES (${sqlLiteral(fixture.outsideProjectId)}::uuid, ${sqlLiteral(fixture.outside_entity_id)}::uuid, true);
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active)
VALUES (
  ${sqlLiteral(fixture.projectRoleId)}::uuid,
  ${sqlLiteral(fixture.legal_project_id)}::uuid,
  ${sqlLiteral(fixture.entity_user_id)}::uuid,
  'project_manager', true
);
INSERT INTO public.safety_test_fixture_registry(run_key, table_name, record_id, fixture_role)
VALUES
  (${sqlLiteral(fixture.runKey)}, 'site_projects', ${sqlLiteral(fixture.outsideProjectId)}::uuid, 'outside_entity_project'),
  (${sqlLiteral(fixture.runKey)}, 'site_project_roles', ${sqlLiteral(fixture.projectRoleId)}::uuid, 'legal_project_manager');
COMMIT;
`;
  runPsql(boundary.databaseUrl, sql, '创建 D05 临时范围夹具');
  return fixture;
}

function cleanupScopeFixture(boundary, fixture) {
  const sql = `
BEGIN;
DELETE FROM public.site_project_roles WHERE id=${sqlLiteral(fixture.projectRoleId)}::uuid;
DELETE FROM public.site_project_audit_logs
 WHERE project_id=${sqlLiteral(fixture.outsideProjectId)}::uuid
    OR entity_id=${sqlLiteral(fixture.outsideProjectId)}::uuid;
DELETE FROM public.site_projects WHERE id=${sqlLiteral(fixture.outsideProjectId)}::uuid;
DELETE FROM public.site_project_audit_logs
 WHERE project_id=${sqlLiteral(fixture.outsideProjectId)}::uuid
    OR entity_id=${sqlLiteral(fixture.outsideProjectId)}::uuid;
DELETE FROM public.safety_test_fixture_registry WHERE run_key=${sqlLiteral(fixture.runKey)};
COMMIT;
`;
  runPsql(boundary.databaseUrl, sql, '清理 D05 临时范围夹具');
}

function countScopeFixtureResidue(boundary, fixture) {
  const sql = `
SELECT
  (SELECT count(*) FROM public.site_projects WHERE id=${sqlLiteral(fixture.outsideProjectId)}::uuid)
  + (SELECT count(*) FROM public.site_project_entities WHERE project_id=${sqlLiteral(fixture.outsideProjectId)}::uuid)
  + (SELECT count(*) FROM public.site_project_roles WHERE id=${sqlLiteral(fixture.projectRoleId)}::uuid)
  + (SELECT count(*) FROM public.site_project_audit_logs
      WHERE project_id=${sqlLiteral(fixture.outsideProjectId)}::uuid
         OR entity_id=${sqlLiteral(fixture.outsideProjectId)}::uuid)
  + (SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key=${sqlLiteral(fixture.runKey)});
`;
  return Number.parseInt(runPsqlScalar(boundary.databaseUrl, sql), 10);
}

module.exports = {
  cleanupScopeFixture,
  countScopeFixtureResidue,
  createScopeFixture,
};

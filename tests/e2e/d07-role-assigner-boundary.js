/** D07 targeted regression: only the lead entity manager may assign project roles. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v59-project-role-assigner-boundary.sql');
const denialMessage = '仅项目主责经营实体管理员可以任命项目角色';
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 任命权限隔离测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v59 测试迁移应用失败');
}

async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D07 任命权限测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

async function setRoles(boundary, anonKey, token, projectId, roles) {
  return request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_set_roles', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_project_id: projectId, p_roles: roles }),
  });
}

function isSuccess(response) {
  return response.status === 200 || response.status === 204;
}

function isExplicitDenial(response) {
  return [400, 403].includes(response.status)
    && String(response.json?.code || '') === 'P0001'
    && String(response.json?.message || '') === denialMessage;
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 59);
  return /IF NOT public\.is_entity_manager\(\)[\s\S]*p\.lead_entity_id = public\.training_my_dept_id\(\)/i.test(source)
    && source.includes(denialMessage)
    && !/IF NOT public\.site_project_can_admin\(p_project_id\)/i.test(source)
    && /SECURITY DEFINER SET search_path = public/i.test(source)
    && /REVOKE ALL ON FUNCTION public\.site_project_set_roles\(UUID, JSONB\) FROM PUBLIC, anon/i.test(source)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

function verifyWebButtonBoundary() {
  const trainingSource = fs.readFileSync(
    path.join(root, 'js', 'modules', 'training', 'training.js'), 'utf8');
  const reviewSource = fs.readFileSync(
    path.join(root, 'js', 'modules', 'training', 'admission-review.js'), 'utf8');
  const flags = { admin: true, superAdmin: false };
  const sandbox = {
    Auth: {
      isAdmin: () => flags.admin,
      isSuperAdmin: () => flags.superAdmin,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${trainingSource}\nglobalThis.__training = TrainingModule;`, sandbox);
  const module = sandbox.__training;
  module.state.depts = [
    { id: 'entity-a', dept_type: 'entity' },
    { id: 'entity-b', dept_type: 'entity' },
  ];
  const project = { id: 'project-a', lead_entity_id: 'entity-a' };

  module.state.profile = { role: 'admin', admin_level: 'dept', department_id: 'entity-a' };
  const leadEntity = module.canAssignProjectRoles(project);
  module.state.profile = { role: 'admin', admin_level: 'company', department_id: 'entity-a' };
  const company = module.canAssignProjectRoles(project);
  module.state.profile = { role: 'admin', admin_level: 'dept', department_id: 'entity-b' };
  const outside = module.canAssignProjectRoles(project);
  flags.admin = false;
  module.state.profile = { role: 'employee', department_id: 'entity-a' };
  const employee = module.canAssignProjectRoles(project);
  const guardedUsages = (reviewSource.match(/TrainingModule\.canAssignProjectRoles\(/g) || []).length;

  return leadEntity === true && company === false && outside === false && employee === false
    && guardedUsages >= 3
    && !/TrainingModule\.canEdit\(\) \? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionReview\.openRoles/i.test(reviewSource);
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'company_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'),
    'entity_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'entity_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-002'),
    'employee_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-004'),
    'employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-004'),
    'contractor_id', (SELECT id FROM public.contractor_companies WHERE name='[D02-TEST] 外协单位' AND unified_code='D02TEST000000000001'),
    'external_memberships', (SELECT count(*) FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id WHERE e.employee_no='D02-007' AND m.membership_type='external')
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.lead_entity_id || !scope.outside_entity_id || !scope.company_user_id
      || !scope.entity_user_id || !scope.entity_employee_id || !scope.employee_user_id
      || !scope.employee_id || !scope.contractor_id || scope.external_memberships < 1) {
    throw new Error('D02 任命权限测试夹具不完整');
  }
  return scope;
}

function createFixture(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.projectCode)}, ${sqlLiteral(fixture.projectName)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true);
COMMIT;`);
}

function roleFingerprint(databaseUrl, projectId) {
  return runPsql(databaseUrl, `SELECT COALESCE(string_agg(
    user_id::text || ':' || role || ':' || active::text, ',' ORDER BY user_id::text, role
  ), '') FROM public.site_project_roles WHERE project_id=${sqlLiteral(projectId)}::uuid;`);
}

function verifyDeniedAs(databaseUrl, fixture, actorId, setupSql = '') {
  const payload = JSON.stringify([{ user_id: fixture.targetUserId, role: 'safety_officer' }]);
  const sql = `
BEGIN;
${setupSql}
CREATE TEMP TABLE d07_role_before(value TEXT) ON COMMIT DROP;
INSERT INTO d07_role_before
SELECT COALESCE(string_agg(user_id::text || ':' || role || ':' || active::text, ',' ORDER BY user_id::text, role), '')
FROM public.site_project_roles WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid;
SET LOCAL ROLE authenticated;
DO $d07_claim$ BEGIN
  PERFORM set_config('request.jwt.claim.sub', ${sqlLiteral(actorId)}, true);
END $d07_claim$;
DO $d07_call$
BEGIN
  BEGIN
    PERFORM public.site_project_set_roles(${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(payload)}::jsonb);
    RAISE EXCEPTION '预期拒绝未发生' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM <> ${sqlLiteral(denialMessage)} THEN RAISE; END IF;
  END;
END $d07_call$;
RESET ROLE;
DO $d07_unchanged$
DECLARE v_after TEXT;
BEGIN
  SELECT COALESCE(string_agg(user_id::text || ':' || role || ':' || active::text, ',' ORDER BY user_id::text, role), '')
  INTO v_after FROM public.site_project_roles WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid;
  IF v_after IS DISTINCT FROM (SELECT value FROM d07_role_before) THEN
    RAISE EXCEPTION '拒绝后项目角色关系发生变化';
  END IF;
END $d07_unchanged$;
ROLLBACK;
SELECT 'ok';`;
  return runPsql(databaseUrl, sql).endsWith('ok');
}

function cleanupFixture(databaseUrl, fixture) {
  const sql = `
BEGIN;
DELETE FROM public.site_project_roles WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid OR entity_id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.site_projects WHERE id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid OR entity_id=${sqlLiteral(fixture.projectId)}::uuid;
COMMIT;
SELECT (
  (SELECT count(*) FROM public.site_projects WHERE id=${sqlLiteral(fixture.projectId)}::uuid)
  + (SELECT count(*) FROM public.site_project_roles WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid)
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid OR entity_id=${sqlLiteral(fixture.projectId)}::uuid)
);`;
  return Number.parseInt(runPsql(databaseUrl, sql), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D07-ASSIGNER-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-ASSIGNER-00 v59 任命边界和迁移登记完整', verifySourceBoundary());
  check('D07-ASSIGNER-01 Web 按钮与主责经营实体权限同步', verifyWebButtonBoundary());

  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    projectId: crypto.randomUUID(),
    projectCode: `D07-A-${suffix}`,
    projectName: `[D07-TEST] 任命权限 ${suffix}`,
    leadEntityId: scope.lead_entity_id,
    targetUserId: scope.employee_user_id,
  };
  let residue = -1;

  try {
    createFixture(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    check('D07-ASSIGNER-02 测试账号身份与夹具一致',
      company.userId === scope.company_user_id && entity.userId === scope.entity_user_id);

    const originalRoles = [{ user_id: fixture.targetUserId, role: 'project_manager' }];
    const assigned = await setRoles(boundary, anonKey, entity.token, fixture.projectId, originalRoles);
    const baseline = roleFingerprint(boundary.databaseUrl, fixture.projectId);
    check('D07-ASSIGNER-03 主责经营实体管理员任命成功',
      isSuccess(assigned) && baseline.includes(`${fixture.targetUserId}:project_manager:true`),
      `status=${assigned.status}`);

    const companyDenied = await setRoles(boundary, anonKey, company.token, fixture.projectId, []);
    check('D07-ASSIGNER-04 公司级管理员直接任命被拒绝且原关系不变',
      isExplicitDenial(companyDenied) && roleFingerprint(boundary.databaseUrl, fixture.projectId) === baseline,
      `status=${companyDenied.status} code=${companyDenied.json?.code || 'none'}`);

    const crossSetup = `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`;
    check('D07-ASSIGNER-05 跨经营实体管理员被拒绝且原关系不变',
      verifyDeniedAs(boundary.databaseUrl, fixture, scope.entity_user_id, crossSetup));

    const managerSetup = `
UPDATE public.profiles SET department_id=${sqlLiteral(scope.lead_entity_id)}::uuid, role='employee', admin_level=NULL WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;
INSERT INTO public.site_project_roles(project_id, user_id, role, active) VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(scope.entity_user_id)}::uuid, 'project_manager', true);`;
    check('D07-ASSIGNER-06 项目经理被拒绝且原关系不变',
      verifyDeniedAs(boundary.databaseUrl, fixture, scope.entity_user_id, managerSetup));

    const safetySetup = `
UPDATE public.profiles SET department_id=${sqlLiteral(scope.lead_entity_id)}::uuid, role='employee', admin_level=NULL WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;
INSERT INTO public.site_project_roles(project_id, user_id, role, active) VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(scope.entity_user_id)}::uuid, 'safety_officer', true);`;
    check('D07-ASSIGNER-07 安全员被拒绝且原关系不变',
      verifyDeniedAs(boundary.databaseUrl, fixture, scope.entity_user_id, safetySetup));

    check('D07-ASSIGNER-08 普通员工被拒绝且原关系不变',
      verifyDeniedAs(boundary.databaseUrl, fixture, scope.employee_user_id));

    const externalSetup = `INSERT INTO public.site_project_members(project_id, employee_id, contractor_id, membership_type, status)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(scope.employee_id)}::uuid, ${sqlLiteral(scope.contractor_id)}::uuid, 'external', 'active');`;
    check('D07-ASSIGNER-09 外协人员被拒绝且原关系不变',
      verifyDeniedAs(boundary.databaseUrl, fixture, scope.employee_user_id, externalSetup));
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture);
  }

  check('D07-ASSIGNER-10 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_ROLE_ASSIGNER_BOUNDARY_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 role assigner boundary failed: ${error.message}`);
  process.exit(1);
});

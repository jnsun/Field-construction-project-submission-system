/** D07 targeted regression: reject cross-entity and inactive project-role assignees. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v58-project-role-assignee-boundary.sql');
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
  if (result.error || result.status !== 0) throw new Error('D07 隔离测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v58 测试迁移应用失败');
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
    throw new Error('D07 经营实体测试账号登录失败');
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

function isExplicitDenial(response, message) {
  return [400, 403].includes(response.status)
    && String(response.json?.code || '') === 'P0001'
    && String(response.json?.message || '').includes(message);
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 58);
  return /JOIN public\.training_employees e ON e\.id = pr\.employee_id[\s\S]*e\.status <> 'active'/i.test(source)
    && /WITH RECURSIVE allowed_departments[\s\S]*p\.lead_entity_id/i.test(source)
    && /不能跨经营实体分配项目角色/i.test(source)
    && /项目角色只能分配给已绑定档案的在职人员/i.test(source)
    && /SECURITY DEFINER SET search_path = public/i.test(source)
    && /REVOKE ALL ON FUNCTION public\.site_project_set_roles\(UUID, JSONB\) FROM PUBLIC, anon/i.test(source)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'entity_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'valid_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-004'),
    'valid_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-004'),
    'valid_status', (SELECT status FROM public.training_employees WHERE employee_no='D02-004'),
    'cross_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001')
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.entity_id || !scope.entity_user_id || !scope.valid_user_id
      || !scope.valid_employee_id || !scope.valid_status || !scope.cross_user_id) {
    throw new Error('D02 项目角色测试夹具不完整');
  }
  return scope;
}

function createFixture(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.projectCode)}, ${sqlLiteral(fixture.projectName)}, 'active', ${sqlLiteral(fixture.entityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.entityId)}::uuid, true);
COMMIT;`);
}

function roleCount(databaseUrl, projectId) {
  return Number.parseInt(runPsql(databaseUrl,
    `SELECT count(*) FROM public.site_project_roles WHERE project_id=${sqlLiteral(projectId)}::uuid;`), 10);
}

function setEmployeeStatus(databaseUrl, employeeId, status) {
  runPsql(databaseUrl,
    `UPDATE public.training_employees SET status=${sqlLiteral(status)} WHERE id=${sqlLiteral(employeeId)}::uuid;`);
}

function cleanupFixture(databaseUrl, fixture, scope) {
  const sql = `
BEGIN;
UPDATE public.training_employees SET status=${sqlLiteral(scope.valid_status)} WHERE id=${sqlLiteral(scope.valid_employee_id)}::uuid;
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
  check('D07-ROLE-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-ROLE-00 v58 服务端校验和迁移登记完整', verifySourceBoundary());

  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    projectId: crypto.randomUUID(),
    projectCode: `D07-R-${suffix}`,
    projectName: `[D07-TEST] 角色边界 ${suffix}`,
    entityId: scope.entity_id,
  };
  let residue = -1;

  try {
    createFixture(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entity = await login(boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
    check('D07-ROLE-01 使用经营实体管理员测试账号', entity.userId === scope.entity_user_id);

    const validRoles = [{ user_id: scope.valid_user_id, role: 'project_manager' }];
    const valid = await setRoles(boundary, anonKey, entity.token, fixture.projectId, validRoles);
    check('D07-ROLE-02 同实体在职人员可被任命', isSuccess(valid) && roleCount(boundary.databaseUrl, fixture.projectId) === 1,
      `status=${valid.status}`);

    const cross = await setRoles(boundary, anonKey, entity.token, fixture.projectId,
      [{ user_id: scope.cross_user_id, role: 'safety_officer' }]);
    check('D07-ROLE-03 跨经营实体分配被明确拒绝',
      isExplicitDenial(cross, '不能跨经营实体分配项目角色')
        && roleCount(boundary.databaseUrl, fixture.projectId) === 1,
      `status=${cross.status} code=${cross.json?.code || 'none'}`);

    setEmployeeStatus(boundary.databaseUrl, scope.valid_employee_id, 'left');
    const inactive = await setRoles(boundary, anonKey, entity.token, fixture.projectId,
      [{ user_id: scope.valid_user_id, role: 'safety_officer' }]);
    check('D07-ROLE-04 已失效人员分配被明确拒绝',
      isExplicitDenial(inactive, '项目角色只能分配给已绑定档案的在职人员')
        && roleCount(boundary.databaseUrl, fixture.projectId) === 1,
      `status=${inactive.status} code=${inactive.json?.code || 'none'}`);
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture, scope);
  }

  check('D07-ROLE-05 测试数据清理完成', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_ROLE_ASSIGNEE_BOUNDARY_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 role assignee boundary failed: ${error.message}`);
  process.exit(1);
});

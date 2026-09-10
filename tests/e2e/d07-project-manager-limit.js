/** D07 targeted regression: database-enforced two-active-project-manager limit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v60-project-manager-limit.sql');
const managerLimitMessage = '每个项目最多指定 2 名有效项目经理';
const duplicateMessage = '同一人员不能重复分配同一项目角色';
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
  if (result.error || result.status !== 0) throw new Error('D07 项目经理人数限制测试库操作失败');
  return String(result.stdout || '').trim();
}

function runPsqlAsync(databaseUrl, sql) {
  return new Promise((resolve) => {
    const child = spawn('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ status: -1, stdout, stderr, error }));
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v60 测试迁移应用失败');
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
    throw new Error('D07 项目经理人数限制测试账号登录失败');
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

function isDatabaseError(response, code, message) {
  return [400, 409].includes(response.status)
    && String(response.json?.code || '') === code
    && String(response.json?.message || '') === message;
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 60);
  return /BEFORE INSERT OR UPDATE OR DELETE ON public\.site_project_roles/i.test(source)
    && /FROM public\.site_projects p[\s\S]*FOR UPDATE/i.test(source)
    && source.includes(managerLimitMessage)
    && source.includes(duplicateMessage)
    && /NEW\.role = 'project_manager' AND NEW\.active/i.test(source)
    && !/NEW\.role = 'safety_officer'[\s\S]*count\(\*\)/i.test(source)
    && /SECURITY DEFINER SET search_path = public/i.test(source)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'entity_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002')
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.lead_entity_id || !scope.entity_user_id) throw new Error('D02 项目经理人数限制测试夹具不完整');
  return scope;
}

function createFixture(databaseUrl, fixture) {
  const employeeValues = fixture.users.map((item, index) => `(
    ${sqlLiteral(item.employeeId)}::uuid, ${sqlLiteral(`[D07-TEST] 角色人员 ${index + 1}`)},
    ${sqlLiteral(`D07-L-${fixture.suffix}-${index + 1}`)}, ${sqlLiteral(fixture.leadEntityId)}::uuid,
    'D07 项目角色', 'employee', 'active', 'D07-TEST'
  )`).join(',');
  const authValues = fixture.users.map((item, index) => `(
    '00000000-0000-0000-0000-000000000000', ${sqlLiteral(item.userId)}::uuid,
    'authenticated', 'authenticated', ${sqlLiteral(`d07-limit-${fixture.suffix.toLowerCase()}-${index + 1}@example.invalid`)},
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    now(), '', '', '', '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  )`).join(',');
  const profileValues = fixture.users.map((item, index) => `(
    ${sqlLiteral(item.userId)}::uuid, ${sqlLiteral(item.employeeId)}::uuid,
    ${sqlLiteral(fixture.leadEntityId)}::uuid, ${sqlLiteral(`[D07-TEST] 角色人员 ${index + 1}`)}
  )`).join(',');

  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(`D07-L-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 经理上限 ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST'),
  (${sqlLiteral(fixture.concurrentProjectId)}::uuid, ${sqlLiteral(`D07-C-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 并发上限 ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true),
  (${sqlLiteral(fixture.concurrentProjectId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark)
VALUES ${employeeValues};
INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES ${authValues};
UPDATE public.profiles p
SET employee_id = v.employee_id,
    department_id = v.department_id,
    role = 'employee',
    full_name = v.full_name,
    is_super_admin = false,
    admin_level = NULL,
    updated_at = now()
FROM (VALUES ${profileValues}) AS v(user_id, employee_id, department_id, full_name)
WHERE p.id = v.user_id;
COMMIT;`);
}

function roleFingerprint(databaseUrl, projectId) {
  return runPsql(databaseUrl, `SELECT COALESCE(string_agg(
    user_id::text || ':' || role || ':' || active::text, ',' ORDER BY user_id::text, role
  ), '') FROM public.site_project_roles WHERE project_id=${sqlLiteral(projectId)}::uuid;`);
}

function roleCount(databaseUrl, projectId, role) {
  return Number.parseInt(runPsql(databaseUrl, `SELECT count(*) FROM public.site_project_roles
    WHERE project_id=${sqlLiteral(projectId)}::uuid AND role=${sqlLiteral(role)} AND active;`), 10);
}

function verifyDirectRejection(databaseUrl, projectId, userId, code, message) {
  return runPsql(databaseUrl, `
DO $d07_limit$
BEGIN
  BEGIN
    INSERT INTO public.site_project_roles(project_id, user_id, role, active)
    VALUES (${sqlLiteral(projectId)}::uuid, ${sqlLiteral(userId)}::uuid, 'project_manager', true);
    RAISE EXCEPTION '预期数据库拒绝未发生' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> ${sqlLiteral(code)} OR SQLERRM <> ${sqlLiteral(message)} THEN RAISE; END IF;
  END;
END;
$d07_limit$;
SELECT 'ok';`).endsWith('ok');
}

async function verifyConcurrentLimit(databaseUrl, fixture) {
  const insertSql = (userId, holdSeconds) => `
BEGIN;
INSERT INTO public.site_project_roles(project_id, user_id, role, active)
VALUES (${sqlLiteral(fixture.concurrentProjectId)}::uuid, ${sqlLiteral(userId)}::uuid, 'project_manager', true);
SELECT pg_sleep(${holdSeconds});
COMMIT;`;
  const firstPromise = runPsqlAsync(databaseUrl, insertSql(fixture.users[1].userId, 1));
  await new Promise(resolve => setTimeout(resolve, 150));
  const secondPromise = runPsqlAsync(databaseUrl, insertSql(fixture.users[2].userId, 0));
  const attempts = await Promise.all([firstPromise, secondPromise]);
  const succeeded = attempts.filter(item => item.status === 0).length;
  const rejected = attempts.filter(item => item.status !== 0
    && item.stderr.includes(managerLimitMessage)).length;
  return succeeded === 1 && rejected === 1
    && roleCount(databaseUrl, fixture.concurrentProjectId, 'project_manager') === 2;
}

function cleanupFixture(databaseUrl, fixture) {
  const projectIds = [fixture.projectId, fixture.concurrentProjectId].map(id => `${sqlLiteral(id)}::uuid`).join(',');
  const userIds = fixture.users.map(item => `${sqlLiteral(item.userId)}::uuid`).join(',');
  const employeeIds = fixture.users.map(item => `${sqlLiteral(item.employeeId)}::uuid`).join(',');
  return Number.parseInt(runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.site_project_roles WHERE project_id IN (${projectIds});
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.site_projects WHERE id IN (${projectIds});
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.training_employee_versions WHERE employee_id IN (${employeeIds});
DELETE FROM public.account_high_privilege_approvals
WHERE target_subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}))
   OR requested_by_subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}))
   OR reviewed_by_subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}));
DELETE FROM public.account_lifecycle_history
WHERE subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}))
   OR operator_subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}));
DELETE FROM public.account_lifecycle WHERE subject_id IN (SELECT id FROM public.account_subjects WHERE auth_user_id IN (${userIds}));
DELETE FROM public.account_subjects WHERE auth_user_id IN (${userIds});
DELETE FROM public.profiles WHERE id IN (${userIds});
DELETE FROM auth.users WHERE id IN (${userIds});
DELETE FROM public.training_employees WHERE id IN (${employeeIds});
COMMIT;
SELECT
  (SELECT count(*) FROM public.site_projects WHERE id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_roles WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds}))
  + (SELECT count(*) FROM auth.users WHERE id IN (${userIds}))
  + (SELECT count(*) FROM public.profiles WHERE id IN (${userIds}))
  + (SELECT count(*) FROM public.training_employees WHERE id IN (${employeeIds}))
  + (SELECT count(*) FROM public.training_employee_versions WHERE employee_id IN (${employeeIds}))
  + (SELECT count(*) FROM public.account_subjects WHERE auth_user_id IN (${userIds}));`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D07-LIMIT-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-LIMIT-00 v60 数据库限制和迁移登记完整', verifySourceBoundary());

  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const fixture = {
    suffix,
    projectId: crypto.randomUUID(),
    concurrentProjectId: crypto.randomUUID(),
    leadEntityId: scope.lead_entity_id,
    users: Array.from({ length: 6 }, () => ({
      userId: crypto.randomUUID(),
      employeeId: crypto.randomUUID(),
    })),
  };
  let residue = -1;

  try {
    createFixture(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entity = await login(boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
    check('D07-LIMIT-01 主责经营实体测试账号匹配', entity.userId === scope.entity_user_id);

    const managers1 = [{ user_id: fixture.users[0].userId, role: 'project_manager' }];
    const first = await setRoles(boundary, anonKey, entity.token, fixture.projectId, managers1);
    check('D07-LIMIT-02 第 1 名项目经理成功',
      isSuccess(first) && roleCount(boundary.databaseUrl, fixture.projectId, 'project_manager') === 1,
      `status=${first.status}`);

    const managers2 = [...managers1, { user_id: fixture.users[1].userId, role: 'project_manager' }];
    const second = await setRoles(boundary, anonKey, entity.token, fixture.projectId, managers2);
    check('D07-LIMIT-03 第 2 名项目经理成功',
      isSuccess(second) && roleCount(boundary.databaseUrl, fixture.projectId, 'project_manager') === 2,
      `status=${second.status}`);

    const beforeThird = roleFingerprint(boundary.databaseUrl, fixture.projectId);
    const managers3 = [...managers2, { user_id: fixture.users[2].userId, role: 'project_manager' }];
    const third = await setRoles(boundary, anonKey, entity.token, fixture.projectId, managers3);
    const directThirdRejected = verifyDirectRejection(boundary.databaseUrl, fixture.projectId,
      fixture.users[2].userId, '23514', managerLimitMessage);
    check('D07-LIMIT-04 第 3 名经理由 RPC 和表触发器拒绝且原角色不变',
      isDatabaseError(third, '23514', managerLimitMessage)
        && directThirdRejected
        && roleFingerprint(boundary.databaseUrl, fixture.projectId) === beforeThird,
      `status=${third.status} code=${third.json?.code || 'none'}`);

    const concurrentBase = await setRoles(boundary, anonKey, entity.token,
      fixture.concurrentProjectId, managers1);
    check('D07-LIMIT-05 两个并发数据库请求不能突破 2 人',
      isSuccess(concurrentBase) && await verifyConcurrentLimit(boundary.databaseUrl, fixture));

    const revoked = await setRoles(boundary, anonKey, entity.token, fixture.projectId, managers1);
    const replacementRoles = [...managers1, { user_id: fixture.users[2].userId, role: 'project_manager' }];
    const replaced = await setRoles(boundary, anonKey, entity.token, fixture.projectId, replacementRoles);
    check('D07-LIMIT-06 撤销 1 名经理后允许补入新经理',
      isSuccess(revoked) && isSuccess(replaced)
        && roleCount(boundary.databaseUrl, fixture.projectId, 'project_manager') === 2);

    const safetyRoles = fixture.users.slice(3).map(item => ({
      user_id: item.userId,
      role: 'safety_officer',
    }));
    const withSafety = await setRoles(boundary, anonKey, entity.token,
      fixture.projectId, [...replacementRoles, ...safetyRoles]);
    check('D07-LIMIT-07 至少 3 名安全员可以同时存在',
      isSuccess(withSafety) && roleCount(boundary.databaseUrl, fixture.projectId, 'safety_officer') === 3,
      `status=${withSafety.status}`);

    const beforeDuplicate = roleFingerprint(boundary.databaseUrl, fixture.projectId);
    const duplicate = await setRoles(boundary, anonKey, entity.token, fixture.projectId,
      [...replacementRoles, ...safetyRoles, safetyRoles[0]]);
    check('D07-LIMIT-08 重复分配返回稳定错误且不产生重复记录',
      isDatabaseError(duplicate, '23505', duplicateMessage)
        && roleFingerprint(boundary.databaseUrl, fixture.projectId) === beforeDuplicate,
      `status=${duplicate.status} code=${duplicate.json?.code || 'none'}`);
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture);
  }

  check('D07-LIMIT-09 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_PROJECT_MANAGER_LIMIT_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 project manager limit failed: ${error.message}`);
  process.exit(1);
});

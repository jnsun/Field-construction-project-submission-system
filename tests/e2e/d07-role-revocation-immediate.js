/** D07 targeted regression: revoked project roles lose new-request access immediately. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v61-project-role-revocation-audit.sql');
const results = [];
const managerOnly = process.argv.includes('--manager-only');

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlNullable(value, cast = '') {
  return value == null ? `NULL${cast ? `::${cast}` : ''}` : `${sqlLiteral(value)}${cast ? `::${cast}` : ''}`;
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 撤权即时失效测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v61 测试迁移应用失败');
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
    throw new Error('D07 撤权即时失效测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

async function rpc(boundary, anonKey, token, name, body) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isSuccess(response) {
  return response.status >= 200 && response.status < 300;
}

function isDenied(response, message) {
  return [400, 403].includes(response.status)
    && String(response.json?.code || '') === 'P0001'
    && String(response.json?.message || '') === message;
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 61);
  return source.includes("'actor_role_snapshot'")
    && /AFTER INSERT ON public\.training_admission_reminders/i.test(source)
    && /AFTER INSERT ON public\.training_site_confirmations/i.test(source)
    && /AFTER INSERT ON public\.training_verification_logs/i.test(source)
    && !/UPDATE public\.site_project_audit_logs|DELETE FROM public\.site_project_audit_logs/i.test(source)
    && /SECURITY DEFINER SET search_path = public/i.test(source)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

async function verifyWebRefreshBoundary() {
  const source = fs.readFileSync(
    path.join(root, 'js', 'modules', 'training', 'training.js'), 'utf8');
  let response = { data: [{ project_id: 'project-a', role: 'project_manager', active: true }], error: null };
  const query = {
    select() { return this; },
    eq() { return this; },
    then(resolve) { resolve(response); },
  };
  const sandbox = {
    Auth: { currentUser: { id: 'actor-a' }, isAdmin: () => false },
    sb: { from: () => query },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.__training = TrainingModule;`, sandbox);
  const module = sandbox.__training;
  module.state.profile = { role: 'employee' };
  await module.loadFieldRoles();
  const before = module.isFieldManager();
  response = { data: [], error: null };
  await module.loadFieldRoles();
  const after = module.isFieldManager();
  return before === true && after === false
    && /await this\.loadFieldRoles\(\)[\s\S]*const fieldManager = this\.isFieldManager\(\)/.test(source)
    && /staff && !fieldManager \? '' : this\.buildTabs\(\)/.test(source);
}

function readActors(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'manager', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id
      WHERE e.employee_no='D02-002'
    ) x),
    'safety', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id
      WHERE e.employee_no='D02-001'
    ) x)
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.lead_entity_id || !scope.manager?.id || !scope.safety?.id) {
    throw new Error('D02 撤权即时失效测试账号夹具不完整');
  }
  return scope;
}

function createFixture(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(`D07-R-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 撤权即时失效 ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST'),
  (${sqlLiteral(fixture.otherProjectId)}::uuid, ${sqlLiteral(`D07-O-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 其他项目 ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true),
  (${sqlLiteral(fixture.otherProjectId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark)
VALUES (${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(`[D07-TEST] 撤权操作对象 ${fixture.suffix}`)},
  ${sqlLiteral(`D07-R-${fixture.suffix}`)}, ${sqlLiteral(fixture.leadEntityId)}::uuid,
  '测试人员', 'employee', 'active', 'D07-TEST');
INSERT INTO public.site_project_members(id, project_id, employee_id, membership_type, status)
VALUES (${sqlLiteral(fixture.memberId)}::uuid, ${sqlLiteral(fixture.projectId)}::uuid,
  ${sqlLiteral(fixture.employeeId)}::uuid, 'internal', 'active');
INSERT INTO public.training_admission_packages(id, project_id, title, status)
VALUES (${sqlLiteral(fixture.packageId)}::uuid, ${sqlLiteral(fixture.projectId)}::uuid,
  ${sqlLiteral(`[D07-TEST] 撤权培训包 ${fixture.suffix}`)}, 'published');
INSERT INTO public.training_admissions(id, project_id, member_id, employee_id, package_id, status)
VALUES (${sqlLiteral(fixture.admissionId)}::uuid, ${sqlLiteral(fixture.projectId)}::uuid,
  ${sqlLiteral(fixture.memberId)}::uuid, ${sqlLiteral(fixture.employeeId)}::uuid,
  ${sqlLiteral(fixture.packageId)}::uuid, 'pending');
INSERT INTO public.site_project_roles(project_id, user_id, role, active, assigned_by)
VALUES
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.managerId)}::uuid, 'project_manager', true, ${sqlLiteral(fixture.managerId)}::uuid),
  (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.safetyId)}::uuid, 'safety_officer', true, ${sqlLiteral(fixture.managerId)}::uuid),
  (${sqlLiteral(fixture.otherProjectId)}::uuid, ${sqlLiteral(fixture.managerId)}::uuid, 'project_manager', true, ${sqlLiteral(fixture.managerId)}::uuid);
COMMIT;`);
}

function setActorsAsEmployees(databaseUrl, fixture) {
  runPsql(databaseUrl, `UPDATE public.profiles
    SET role='employee', admin_level=NULL, is_super_admin=false, updated_at=now()
    WHERE id IN (${sqlLiteral(fixture.managerId)}::uuid, ${sqlLiteral(fixture.safetyId)}::uuid);`);
}

function restoreActors(databaseUrl, fixture) {
  const rows = [fixture.managerOriginal, fixture.safetyOriginal].map(item => `(
    ${sqlLiteral(item.id)}::uuid, ${sqlLiteral(item.role)}, ${sqlNullable(item.admin_level)},
    ${item.is_super_admin ? 'true' : 'false'}, ${sqlNullable(item.department_id, 'uuid')}, ${sqlNullable(item.employee_id, 'uuid')}
  )`).join(',');
  runPsql(databaseUrl, `UPDATE public.profiles p
    SET role=v.role, admin_level=v.admin_level, is_super_admin=v.is_super_admin,
        department_id=v.department_id, employee_id=v.employee_id, updated_at=now()
    FROM (VALUES ${rows}) AS v(id, role, admin_level, is_super_admin, department_id, employee_id)
    WHERE p.id=v.id;`);
}

function revokeRole(databaseUrl, projectId, userId, role) {
  runPsql(databaseUrl, `DELETE FROM public.site_project_roles
    WHERE project_id=${sqlLiteral(projectId)}::uuid AND user_id=${sqlLiteral(userId)}::uuid AND role=${sqlLiteral(role)};`);
}

async function executeAuthorizedActions(boundary, anonKey, token, fixture, label) {
  const reminder = await rpc(boundary, anonKey, token, 'training_batch_remind', {
    p_project_id: fixture.projectId,
    p_admission_ids: [fixture.admissionId],
    p_message: `${label} 撤权前催办`,
  });
  const confirmation = await rpc(boundary, anonKey, token, 'training_confirm_site', {
    p_admission_id: fixture.admissionId,
    p_photo_path: `training-admission/site-confirmations/${fixture.projectId}/${label}-${fixture.suffix}.jpg`,
    p_latitude: null,
    p_longitude: null,
    p_note: `${label} 撤权前现场确认`,
    p_record_hash: null,
  });
  const invite = await rpc(boundary, anonKey, token, 'site_project_refresh_invite', {
    p_project_id: fixture.projectId,
  });
  const verification = await rpc(boundary, anonKey, token, 'training_log_verification', {
    p_project_id: fixture.projectId,
    p_employee_id: fixture.employeeId,
    p_credential_type: 'certificate',
    p_result_status: 'pending',
    p_reason: `${label} 撤权前核验`,
    p_code: `D07-${fixture.suffix}`,
  });
  return [reminder, confirmation, invite, verification];
}

async function executeDeniedActions(boundary, anonKey, token, fixture, label) {
  const reminder = await rpc(boundary, anonKey, token, 'training_batch_remind', {
    p_project_id: fixture.projectId,
    p_admission_ids: [fixture.admissionId],
    p_message: `${label} 撤权后催办`,
  });
  const confirmation = await rpc(boundary, anonKey, token, 'training_confirm_site', {
    p_admission_id: fixture.admissionId,
    p_photo_path: `training-admission/site-confirmations/${fixture.projectId}/${label}-revoked-${fixture.suffix}.jpg`,
    p_latitude: null,
    p_longitude: null,
    p_note: `${label} 撤权后现场确认`,
    p_record_hash: null,
  });
  const invite = await rpc(boundary, anonKey, token, 'site_project_refresh_invite', {
    p_project_id: fixture.projectId,
  });
  const verification = await rpc(boundary, anonKey, token, 'training_log_verification', {
    p_project_id: fixture.projectId,
    p_employee_id: fixture.employeeId,
    p_credential_type: 'certificate',
    p_result_status: 'pending',
    p_reason: `${label} 撤权后核验`,
    p_code: `D07-REVOKED-${fixture.suffix}`,
  });
  return isDenied(reminder, '您无权催办该项目人员')
    && isDenied(confirmation, '您无权进行现场确认')
    && isDenied(invite, '您无权刷新项目邀请码')
    && isDenied(verification, '您无权记录该项目的现场核验');
}

async function ownRoleRowsVisible(boundary, anonKey, token, projectId, userId) {
  const response = await request(boundary.apiOrigin, anonKey,
    `/rest/v1/site_project_roles?select=project_id,user_id,role,active&project_id=eq.${projectId}&user_id=eq.${userId}&active=eq.true`,
    { headers: { Authorization: `Bearer ${token}` } });
  return response.status === 200 ? response.json : null;
}

function historyFingerprint(databaseUrl, fixture) {
  return runPsql(databaseUrl, `SELECT json_build_object(
    'reminders', (SELECT COALESCE(string_agg(id::text, ',' ORDER BY id), '') FROM public.training_admission_reminders WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid),
    'confirmations', (SELECT COALESCE(string_agg(c.id::text, ',' ORDER BY c.id), '') FROM public.training_site_confirmations c JOIN public.training_admissions a ON a.id=c.admission_id WHERE a.project_id=${sqlLiteral(fixture.projectId)}::uuid),
    'verifications', (SELECT COALESCE(string_agg(id::text, ',' ORDER BY id), '') FROM public.training_verification_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid),
    'audits', (SELECT COALESCE(string_agg(id::text || ':' || (detail->>'actor_role_snapshot'), ',' ORDER BY id), '') FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid AND action IN ('project_reminder_created','site_confirmation_created','site_verification_logged'))
  )::text;`);
}

function auditSnapshotCounts(databaseUrl, fixture) {
  return JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'manager', count(*) FILTER (WHERE actor_id=${sqlLiteral(fixture.managerId)}::uuid AND detail->>'actor_role_snapshot'='project_manager'),
    'safety', count(*) FILTER (WHERE actor_id=${sqlLiteral(fixture.safetyId)}::uuid AND detail->>'actor_role_snapshot'='safety_officer')
  )::text FROM public.site_project_audit_logs
  WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid
    AND action IN ('project_reminder_created','site_confirmation_created','site_verification_logged');`));
}

function cleanupFixture(databaseUrl, fixture) {
  restoreActors(databaseUrl, fixture);
  const projectIds = `${sqlLiteral(fixture.projectId)}::uuid,${sqlLiteral(fixture.otherProjectId)}::uuid`;
  return Number.parseInt(runPsql(databaseUrl, `
BEGIN;
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.training_verification_logs WHERE project_id IN (${projectIds});
DELETE FROM public.training_site_confirmations WHERE admission_id=${sqlLiteral(fixture.admissionId)}::uuid;
DELETE FROM public.training_admission_reminders WHERE project_id IN (${projectIds});
DELETE FROM public.site_project_invites WHERE project_id IN (${projectIds});
DELETE FROM public.site_project_roles WHERE project_id IN (${projectIds});
DELETE FROM public.training_admissions WHERE id=${sqlLiteral(fixture.admissionId)}::uuid;
DELETE FROM public.training_admission_packages WHERE id=${sqlLiteral(fixture.packageId)}::uuid;
DELETE FROM public.site_project_members WHERE id=${sqlLiteral(fixture.memberId)}::uuid;
DELETE FROM public.site_projects WHERE id IN (${projectIds});
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.training_employees WHERE id=${sqlLiteral(fixture.employeeId)}::uuid;
COMMIT;
SELECT
  (SELECT count(*) FROM public.site_projects WHERE id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_roles WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_invites WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.training_verification_logs WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.training_site_confirmations WHERE admission_id=${sqlLiteral(fixture.admissionId)}::uuid)
  + (SELECT count(*) FROM public.training_admission_reminders WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds}))
  + (SELECT count(*) FROM public.training_admissions WHERE id=${sqlLiteral(fixture.admissionId)}::uuid)
  + (SELECT count(*) FROM public.training_admission_packages WHERE id=${sqlLiteral(fixture.packageId)}::uuid)
  + (SELECT count(*) FROM public.site_project_members WHERE id=${sqlLiteral(fixture.memberId)}::uuid)
  + (SELECT count(*) FROM public.training_employees WHERE id=${sqlLiteral(fixture.employeeId)}::uuid);`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D07-REVOKE-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-REVOKE-00 v61 历史角色快照迁移登记完整', verifySourceBoundary());
  check('D07-REVOKE-01 Web 刷新重新读取有效角色并隐藏管理入口', await verifyWebRefreshBoundary());

  applyMigration(boundary.databaseUrl);
  const scope = readActors(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const fixture = {
    suffix,
    projectId: crypto.randomUUID(),
    otherProjectId: crypto.randomUUID(),
    employeeId: crypto.randomUUID(),
    memberId: crypto.randomUUID(),
    packageId: crypto.randomUUID(),
    admissionId: crypto.randomUUID(),
    leadEntityId: scope.lead_entity_id,
    managerId: scope.manager.id,
    safetyId: scope.safety.id,
    managerOriginal: scope.manager,
    safetyOriginal: scope.safety,
  };
  let residue = -1;

  try {
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [manager, safety] = await Promise.all([
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
    ]);
    check('D07-REVOKE-02 测试账号身份匹配',
      manager.userId === fixture.managerId && safety.userId === fixture.safetyId);

    createFixture(boundary.databaseUrl, fixture);
    setActorsAsEmployees(boundary.databaseUrl, fixture);

    const managerBefore = await executeAuthorizedActions(
      boundary, anonKey, manager.token, fixture, 'manager');
    check('D07-REVOKE-03 项目经理撤权前催办、现场确认、二维码管理和核验成功',
      managerBefore.every(isSuccess), managerBefore.map(item => item.status).join(','));

    if (!managerOnly) {
      const safetyBefore = await executeAuthorizedActions(
        boundary, anonKey, safety.token, fixture, 'safety');
      check('D07-REVOKE-04 安全员撤权前催办、现场确认、二维码管理和核验成功',
        safetyBefore.every(isSuccess), safetyBefore.map(item => item.status).join(','));
    }

    const beforeManagerDenied = historyFingerprint(boundary.databaseUrl, fixture);
    revokeRole(boundary.databaseUrl, fixture.projectId, fixture.managerId, 'project_manager');
    const managerDenied = await executeDeniedActions(
      boundary, anonKey, manager.token, fixture, 'manager');
    const managerRows = await ownRoleRowsVisible(
      boundary, anonKey, manager.token, fixture.projectId, fixture.managerId);
    check('D07-REVOKE-05 项目经理同一会话撤权后新请求和角色读取立即失效',
      managerDenied && Array.isArray(managerRows) && managerRows.length === 0
        && historyFingerprint(boundary.databaseUrl, fixture) === beforeManagerDenied);

    if (!managerOnly) {
      const otherProject = await rpc(boundary, anonKey, manager.token,
        'site_project_refresh_invite', { p_project_id: fixture.otherProjectId });
      const safetyUnaffected = await rpc(boundary, anonKey, safety.token,
        'training_batch_remind', {
          p_project_id: fixture.projectId,
          p_admission_ids: [fixture.admissionId],
          p_message: '其他有效项目角色不受经理撤权影响',
        });
      check('D07-REVOKE-06 其他项目和其他有效角色不受影响',
        isSuccess(otherProject) && isSuccess(safetyUnaffected),
        `other_project=${otherProject.status} safety=${safetyUnaffected.status}`);

      const beforeSafetyDenied = historyFingerprint(boundary.databaseUrl, fixture);
      revokeRole(boundary.databaseUrl, fixture.projectId, fixture.safetyId, 'safety_officer');
      const safetyDenied = await executeDeniedActions(
        boundary, anonKey, safety.token, fixture, 'safety');
      const safetyRows = await ownRoleRowsVisible(
        boundary, anonKey, safety.token, fixture.projectId, fixture.safetyId);
      check('D07-REVOKE-07 安全员同一会话撤权后新请求和角色读取立即失效',
        safetyDenied && Array.isArray(safetyRows) && safetyRows.length === 0
          && historyFingerprint(boundary.databaseUrl, fixture) === beforeSafetyDenied);

      const snapshots = auditSnapshotCounts(boundary.databaseUrl, fixture);
      restoreActors(boundary.databaseUrl, fixture);
      const auditRead = await request(boundary.apiOrigin, anonKey,
        `/rest/v1/site_project_audit_logs?select=id,actor_id,action,detail&project_id=eq.${fixture.projectId}`,
        { headers: { Authorization: `Bearer ${manager.token}` } });
      check('D07-REVOKE-08 历史记录和操作者角色快照完整保留并可查询',
        snapshots.manager >= 3 && snapshots.safety >= 3
          && auditRead.status === 200 && Array.isArray(auditRead.json)
          && auditRead.json.filter(item => item.detail?.actor_role_snapshot).length >= 6,
        `manager_snapshots=${snapshots.manager} safety_snapshots=${snapshots.safety}`);
    }
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture);
  }

  check('D07-REVOKE-09 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_ROLE_REVOCATION_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 role revocation failed: ${error.message}`);
  process.exit(1);
});

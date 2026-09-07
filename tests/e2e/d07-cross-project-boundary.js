/** D07 targeted regression: project managers and safety officers cannot cross project boundaries. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v62-project-read-scope.sql');
const results = [];

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
  if (result.error || result.status !== 0) throw new Error('D07 跨项目权限测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v62 测试迁移应用失败');
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
    throw new Error('D07 跨项目权限测试账号登录失败');
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
  const entry = manifest.migrations.find(item => item.version === 62);
  return /CREATE OR REPLACE FUNCTION public\.site_project_can_read/i.test(source)
    && (source.match(/public\.is_admin\(\)[\s\S]*?public\.training_can_read/g) || []).length === 2
    && /r\.project_id = p_project_id[\s\S]*r\.user_id = auth\.uid\(\)[\s\S]*r\.active/i.test(source)
    && /m\.project_id = p_project_id[\s\S]*m\.status = 'active'[\s\S]*pr\.id = auth\.uid\(\)/i.test(source)
    && /SECURITY DEFINER SET search_path = public/i.test(source)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

function readFixture(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'project_a_id', (SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'),
    'project_b_id', (SELECT id FROM public.site_projects WHERE project_code='D02-HIGH-RISK'),
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'target_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-004'),
    'project_a_member_id', (SELECT m.id FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id JOIN public.site_projects p ON p.id=m.project_id WHERE p.project_code='D02-NORMAL' AND e.employee_no='D02-004'),
    'actor_a', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id, e.department_id AS employee_department_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'
    ) x),
    'actor_b', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id, e.department_id AS employee_department_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'
    ) x),
    'existing_invites', (SELECT count(*) FROM public.site_project_invites i JOIN public.site_projects p ON p.id=i.project_id WHERE p.project_code IN ('D02-NORMAL','D02-HIGH-RISK')),
    'existing_admissions', (SELECT count(*) FROM public.training_admissions a JOIN public.site_projects p ON p.id=a.project_id WHERE p.project_code IN ('D02-NORMAL','D02-HIGH-RISK'))
  )::text;`);
  const fixture = JSON.parse(raw);
  if (!fixture.project_a_id || !fixture.project_b_id || !fixture.lead_entity_id
      || !fixture.outside_entity_id || !fixture.target_employee_id || !fixture.project_a_member_id
      || !fixture.actor_a?.id || !fixture.actor_b?.id
      || fixture.existing_invites !== 0 || fixture.existing_admissions !== 0) {
    throw new Error('D02 跨项目测试夹具状态不符合安全复用条件');
  }
  return fixture;
}

function createFixture(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES (${sqlLiteral(fixture.crossEntityProjectId)}::uuid, ${sqlLiteral(`D07-X-${fixture.suffix}`)},
  ${sqlLiteral(`[D07-TEST] 跨经营实体 ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.outsideEntityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES (${sqlLiteral(fixture.crossEntityProjectId)}::uuid, ${sqlLiteral(fixture.outsideEntityId)}::uuid, true);
INSERT INTO public.site_project_members(id, project_id, employee_id, membership_type, status)
VALUES (${sqlLiteral(fixture.projectBMemberId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid,
  ${sqlLiteral(fixture.targetEmployeeId)}::uuid, 'internal', 'active');
INSERT INTO public.training_admission_packages(id, project_id, title, status)
VALUES
  (${sqlLiteral(fixture.packageAId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(`[D07-TEST] A ${fixture.suffix}`)}, 'published'),
  (${sqlLiteral(fixture.packageBId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid, ${sqlLiteral(`[D07-TEST] B ${fixture.suffix}`)}, 'published');
INSERT INTO public.training_admissions(id, project_id, member_id, employee_id, package_id, status)
VALUES
  (${sqlLiteral(fixture.admissionAId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectAMemberId)}::uuid, ${sqlLiteral(fixture.targetEmployeeId)}::uuid, ${sqlLiteral(fixture.packageAId)}::uuid, 'pending'),
  (${sqlLiteral(fixture.admissionBId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid, ${sqlLiteral(fixture.projectBMemberId)}::uuid, ${sqlLiteral(fixture.targetEmployeeId)}::uuid, ${sqlLiteral(fixture.packageBId)}::uuid, 'pending');
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active, assigned_by)
VALUES
  (${sqlLiteral(fixture.roleAId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.actorAId)}::uuid, 'project_manager', true, ${sqlLiteral(fixture.actorBId)}::uuid),
  (${sqlLiteral(fixture.roleBId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid, ${sqlLiteral(fixture.actorBId)}::uuid, 'project_manager', true, ${sqlLiteral(fixture.actorBId)}::uuid);
UPDATE public.profiles SET role='employee', admin_level=NULL, is_super_admin=false, department_id=${sqlLiteral(fixture.leadEntityId)}::uuid, updated_at=now()
WHERE id IN (${sqlLiteral(fixture.actorAId)}::uuid, ${sqlLiteral(fixture.actorBId)}::uuid);
UPDATE public.training_employees SET department_id=${sqlLiteral(fixture.leadEntityId)}::uuid, updated_at=now()
WHERE id=${sqlLiteral(fixture.actorAOriginal.employee_id)}::uuid;
COMMIT;`);
}

function switchActorAToSafety(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
DELETE FROM public.site_project_roles WHERE id=${sqlLiteral(fixture.roleAId)}::uuid;
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active, assigned_by)
VALUES (${sqlLiteral(fixture.roleASafetyId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid,
  ${sqlLiteral(fixture.actorAId)}::uuid, 'safety_officer', true, ${sqlLiteral(fixture.actorBId)}::uuid);
COMMIT;`);
}

async function restRows(boundary, anonKey, token, table, query) {
  const response = await request(boundary.apiOrigin, anonKey,
    `/rest/v1/${table}?select=*&${query}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return response.status === 200 && Array.isArray(response.json) ? response.json : null;
}

async function executeAllowed(boundary, anonKey, token, fixture, projectId, admissionId, label) {
  const members = await restRows(boundary, anonKey, token, 'site_project_members', `project_id=eq.${projectId}`);
  const reminder = await rpc(boundary, anonKey, token, 'training_batch_remind', {
    p_project_id: projectId,
    p_admission_ids: [admissionId],
    p_message: `${label}-${fixture.suffix}`,
  });
  const confirmation = await rpc(boundary, anonKey, token, 'training_confirm_site', {
    p_admission_id: admissionId,
    p_photo_path: `training-admission/site-confirmations/${projectId}/${label}-${fixture.suffix}.jpg`,
    p_latitude: null,
    p_longitude: null,
    p_note: `${label}-${fixture.suffix}`,
    p_record_hash: null,
  });
  const invite = await rpc(boundary, anonKey, token, 'site_project_refresh_invite', { p_project_id: projectId });
  const verification = await rpc(boundary, anonKey, token, 'training_log_verification', {
    p_project_id: projectId,
    p_employee_id: fixture.targetEmployeeId,
    p_credential_type: 'certificate',
    p_result_status: 'pending',
    p_reason: `${label}-${fixture.suffix}`,
    p_code: `D07-${fixture.suffix}`,
  });
  return Array.isArray(members) && members.length > 0
    && [reminder, confirmation, invite, verification].every(isSuccess);
}

async function executeCrossDenied(boundary, anonKey, token, fixture, projectId, admissionId, label) {
  const projects = await restRows(boundary, anonKey, token, 'site_projects', `id=eq.${projectId}`);
  const members = await restRows(boundary, anonKey, token, 'site_project_members', `project_id=eq.${projectId}`);
  const roles = await restRows(boundary, anonKey, token, 'site_project_roles', `project_id=eq.${projectId}`);
  const reminder = await rpc(boundary, anonKey, token, 'training_batch_remind', {
    p_project_id: projectId,
    p_admission_ids: [admissionId],
    p_message: `${label}-${fixture.suffix}`,
  });
  const confirmation = await rpc(boundary, anonKey, token, 'training_confirm_site', {
    p_admission_id: admissionId,
    p_photo_path: `training-admission/site-confirmations/${projectId}/${label}-${fixture.suffix}.jpg`,
    p_latitude: null,
    p_longitude: null,
    p_note: `${label}-${fixture.suffix}`,
    p_record_hash: null,
  });
  const invite = await rpc(boundary, anonKey, token, 'site_project_refresh_invite', { p_project_id: projectId });
  const verification = await rpc(boundary, anonKey, token, 'training_log_verification', {
    p_project_id: projectId,
    p_employee_id: fixture.targetEmployeeId,
    p_credential_type: 'certificate',
    p_result_status: 'pending',
    p_reason: `${label}-${fixture.suffix}`,
    p_code: `D07-X-${fixture.suffix}`,
  });
  return [projects, members, roles].every(rows => Array.isArray(rows) && rows.length === 0)
    && isDenied(reminder, '您无权催办该项目人员')
    && isDenied(confirmation, '您无权进行现场确认')
    && isDenied(invite, '您无权刷新项目邀请码')
    && isDenied(verification, '您无权记录该项目的现场核验');
}

async function crossEntityDenied(boundary, anonKey, token, fixture) {
  const projects = await restRows(boundary, anonKey, token, 'site_projects', `id=eq.${fixture.crossEntityProjectId}`);
  const invite = await rpc(boundary, anonKey, token, 'site_project_refresh_invite', {
    p_project_id: fixture.crossEntityProjectId,
  });
  return Array.isArray(projects) && projects.length === 0
    && isDenied(invite, '您无权刷新项目邀请码');
}

function restoreActors(databaseUrl, fixture) {
  const rows = [fixture.actorAOriginal, fixture.actorBOriginal].map(item => `(
    ${sqlLiteral(item.id)}::uuid, ${sqlLiteral(item.role)}, ${sqlNullable(item.admin_level)},
    ${item.is_super_admin ? 'true' : 'false'}, ${sqlNullable(item.department_id, 'uuid')},
    ${sqlNullable(item.employee_id, 'uuid')}, ${sqlNullable(item.employee_department_id, 'uuid')}
  )`).join(',');
  runPsql(databaseUrl, `
UPDATE public.profiles p
SET role=v.role, admin_level=v.admin_level, is_super_admin=v.is_super_admin,
    department_id=v.department_id, employee_id=v.employee_id, updated_at=now()
FROM (VALUES ${rows}) AS v(id, role, admin_level, is_super_admin, department_id, employee_id, employee_department_id)
WHERE p.id=v.id;
UPDATE public.training_employees e SET department_id=v.employee_department_id, updated_at=now()
FROM (VALUES ${rows}) AS v(id, role, admin_level, is_super_admin, department_id, employee_id, employee_department_id)
WHERE e.id=v.employee_id;`);
}

function cleanupFixture(databaseUrl, fixture) {
  restoreActors(databaseUrl, fixture);
  const roleIds = `${sqlLiteral(fixture.roleAId)}::uuid,${sqlLiteral(fixture.roleASafetyId)}::uuid,${sqlLiteral(fixture.roleBId)}::uuid`;
  const admissionIds = `${sqlLiteral(fixture.admissionAId)}::uuid,${sqlLiteral(fixture.admissionBId)}::uuid`;
  const packageIds = `${sqlLiteral(fixture.packageAId)}::uuid,${sqlLiteral(fixture.packageBId)}::uuid`;
  runPsql(databaseUrl, `
BEGIN;
DELETE FROM public.site_project_audit_logs l
WHERE l.detail->>'source_record_id' IN (
  SELECT id::text FROM public.training_admission_reminders WHERE message LIKE ${sqlLiteral(`%${fixture.suffix}%`)}
  UNION SELECT id::text FROM public.training_site_confirmations WHERE note LIKE ${sqlLiteral(`%${fixture.suffix}%`)}
  UNION SELECT id::text FROM public.training_verification_logs WHERE reason LIKE ${sqlLiteral(`%${fixture.suffix}%`)}
);
DELETE FROM public.training_verification_logs WHERE reason LIKE ${sqlLiteral(`%${fixture.suffix}%`)};
DELETE FROM public.training_site_confirmations WHERE note LIKE ${sqlLiteral(`%${fixture.suffix}%`)};
DELETE FROM public.training_admission_reminders WHERE message LIKE ${sqlLiteral(`%${fixture.suffix}%`)};
DELETE FROM public.site_project_invites WHERE project_id IN (${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid, ${sqlLiteral(fixture.crossEntityProjectId)}::uuid);
DELETE FROM public.site_project_roles WHERE id IN (${roleIds});
DELETE FROM public.training_admissions WHERE id IN (${admissionIds});
DELETE FROM public.training_admission_packages WHERE id IN (${packageIds});
DELETE FROM public.site_project_members WHERE id=${sqlLiteral(fixture.projectBMemberId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid OR entity_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid;
DELETE FROM public.site_projects WHERE id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid OR entity_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid;
COMMIT;`);
  return Number.parseInt(runPsql(databaseUrl, `SELECT
    (SELECT count(*) FROM public.site_project_roles WHERE id IN (${roleIds}))
    + (SELECT count(*) FROM public.training_admissions WHERE id IN (${admissionIds}))
    + (SELECT count(*) FROM public.training_admission_packages WHERE id IN (${packageIds}))
    + (SELECT count(*) FROM public.site_project_members WHERE id=${sqlLiteral(fixture.projectBMemberId)}::uuid)
    + (SELECT count(*) FROM public.training_admission_reminders WHERE message LIKE ${sqlLiteral(`%${fixture.suffix}%`)})
    + (SELECT count(*) FROM public.training_site_confirmations WHERE note LIKE ${sqlLiteral(`%${fixture.suffix}%`)})
    + (SELECT count(*) FROM public.training_verification_logs WHERE reason LIKE ${sqlLiteral(`%${fixture.suffix}%`)})
    + (SELECT count(*) FROM public.site_projects WHERE id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid)
    + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid OR entity_id=${sqlLiteral(fixture.crossEntityProjectId)}::uuid);`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D07-CROSS-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-CROSS-00 v62 项目读取范围和迁移登记完整', verifySourceBoundary());

  applyMigration(boundary.databaseUrl);
  const base = readFixture(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const fixture = {
    suffix,
    projectAId: base.project_a_id,
    projectBId: base.project_b_id,
    leadEntityId: base.lead_entity_id,
    outsideEntityId: base.outside_entity_id,
    targetEmployeeId: base.target_employee_id,
    projectAMemberId: base.project_a_member_id,
    actorAId: base.actor_a.id,
    actorBId: base.actor_b.id,
    actorAOriginal: base.actor_a,
    actorBOriginal: base.actor_b,
    crossEntityProjectId: crypto.randomUUID(),
    projectBMemberId: crypto.randomUUID(),
    packageAId: crypto.randomUUID(),
    packageBId: crypto.randomUUID(),
    admissionAId: crypto.randomUUID(),
    admissionBId: crypto.randomUUID(),
    roleAId: crypto.randomUUID(),
    roleASafetyId: crypto.randomUUID(),
    roleBId: crypto.randomUUID(),
  };
  let residue = -1;

  try {
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [actorA, actorB] = await Promise.all([
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    check('D07-CROSS-01 复用 D02 测试账号和 A/B 项目',
      actorA.userId === fixture.actorAId && actorB.userId === fixture.actorBId);

    createFixture(boundary.databaseUrl, fixture);

    check('D07-CROSS-02 A 项目经理可读并可执行本项目管理操作',
      await executeAllowed(boundary, anonKey, actorA.token, fixture,
        fixture.projectAId, fixture.admissionAId, 'manager-a'));
    check('D07-CROSS-03 A 项目经理无法通过 REST/RPC/构造 project_id 操作 B',
      await executeCrossDenied(boundary, anonKey, actorA.token, fixture,
        fixture.projectBId, fixture.admissionBId, 'manager-cross-b'));
    const managerAStillWorks = await rpc(boundary, anonKey, actorA.token,
      'site_project_refresh_invite', { p_project_id: fixture.projectAId });
    check('D07-CROSS-04 B 项目穿透测试不影响 A 项目经理权限', isSuccess(managerAStillWorks));

    switchActorAToSafety(boundary.databaseUrl, fixture);
    check('D07-CROSS-05 A 安全员可读并可执行本项目管理操作',
      await executeAllowed(boundary, anonKey, actorA.token, fixture,
        fixture.projectAId, fixture.admissionAId, 'safety-a'));
    check('D07-CROSS-06 A 安全员无法通过 REST/RPC/构造 project_id 操作 B',
      await executeCrossDenied(boundary, anonKey, actorA.token, fixture,
        fixture.projectBId, fixture.admissionBId, 'safety-cross-b'));
    const safetyAStillWorks = await rpc(boundary, anonKey, actorA.token,
      'site_project_refresh_invite', { p_project_id: fixture.projectAId });
    check('D07-CROSS-07 B 项目穿透测试不影响 A 安全员权限', isSuccess(safetyAStillWorks));

    check('D07-CROSS-08 B 项目合法管理角色仍可正常工作',
      await executeAllowed(boundary, anonKey, actorB.token, fixture,
        fixture.projectBId, fixture.admissionBId, 'manager-b'));
    check('D07-CROSS-09 跨经营实体 REST 和 RPC 继续拒绝',
      await crossEntityDenied(boundary, anonKey, actorA.token, fixture));
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture);
  }

  check('D07-CROSS-10 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_CROSS_PROJECT_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 cross-project boundary failed: ${error.message}`);
  process.exit(1);
});

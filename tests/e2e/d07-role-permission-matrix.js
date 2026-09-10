/** D07 targeted regression: seven-role project permission matrix. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v63-role-permission-matrix.sql');
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
  if (result.error || result.status !== 0) throw new Error(`D07 角色权限矩阵测试库操作失败：${String(result.stderr || result.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D07 v63 测试迁移应用失败');
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
    throw new Error('D07 角色权限矩阵测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

async function rpc(boundary, anonKey, token, name, body = {}) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function restRows(boundary, anonKey, token, table, query, select = '*') {
  const response = await request(boundary.apiOrigin, anonKey,
    `/rest/v1/${table}?select=${encodeURIComponent(select)}&${query}`,
    { headers: { Authorization: `Bearer ${token}` } });
  return response.status === 200 && Array.isArray(response.json) ? response.json : null;
}

async function restInsert(boundary, anonKey, token, table, body) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
}

function isSuccess(response) {
  return response.status >= 200 && response.status < 300;
}

function isDenied(response, message = '') {
  return [400, 401, 403].includes(response.status)
    && (!message || String(response.json?.message || '') === message);
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 63);
  const v60 = fs.readFileSync(path.join(root, 'sql', 'training-admission-v60-project-manager-limit.sql'), 'utf8');
  return /CREATE OR REPLACE FUNCTION public\.site_project_can_manage/i.test(source)
    && !/SELECT public\.training_is_company_admin\(\)/i.test(source)
    && /public\.is_entity_manager\(\)[\s\S]*p\.lead_entity_id = public\.training_my_dept_id\(\)/i.test(source)
    && /r\.project_id = p_project_id[\s\S]*r\.user_id = auth\.uid\(\)[\s\S]*r\.active/i.test(source)
    && /CREATE OR REPLACE FUNCTION public\.training_employee_can_read/i.test(source)
    && /p_employee_id = public\.training_my_employee_id\(\)/i.test(source)
    && /public\.is_admin\(\)[\s\S]*public\.training_can_read\(p_department_id\)/i.test(source)
    && /JOIN public\.site_project_roles r[\s\S]*m\.employee_id = p_employee_id/i.test(source)
    && /USING \(public\.training_employee_can_read\(id, department_id\)\)/i.test(source)
    && !/UNIQUE\s*\(\s*user_id\s*\)/i.test(v60)
    && /WHERE r\.project_id = NEW\.project_id/i.test(v60)
    && entry?.file === path.basename(migrationPath)
    && entry.sha256 === digest;
}

function readFixture(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'project_a_id', (SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'),
    'project_b_id', (SELECT id FROM public.site_projects WHERE project_code='D02-HIGH-RISK'),
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'company_actor', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'
    ) x),
    'entity_actor_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'assignable_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-004'),
    'ordinary_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-009'),
    'external_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-007'),
    'member_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-004'),
    'other_project_employee_id', (SELECT id FROM public.training_employees WHERE employee_no='D02-005'),
    'roles', (SELECT count(*) FROM public.site_project_roles r JOIN public.site_projects p ON p.id=r.project_id WHERE p.project_code IN ('D02-NORMAL','D02-HIGH-RISK')),
    'invites', (SELECT count(*) FROM public.site_project_invites i JOIN public.site_projects p ON p.id=i.project_id WHERE p.project_code IN ('D02-NORMAL','D02-HIGH-RISK')),
    'ordinary_membership', (SELECT count(*) FROM public.site_project_members m JOIN public.site_projects p ON p.id=m.project_id WHERE p.project_code='D02-NORMAL' AND m.employee_id=(SELECT id FROM public.training_employees WHERE employee_no='D02-009'))
  )::text;`);
  const fixture = JSON.parse(raw);
  if (!fixture.project_a_id || !fixture.project_b_id || !fixture.lead_entity_id
      || !fixture.outside_entity_id || !fixture.company_actor?.id || !fixture.entity_actor_id
      || !fixture.assignable_user_id || !fixture.ordinary_employee_id || !fixture.external_employee_id
      || !fixture.member_employee_id || !fixture.other_project_employee_id
      || fixture.roles !== 0 || fixture.invites !== 0 || fixture.ordinary_membership !== 0) {
    throw new Error('D02 角色矩阵夹具状态不符合安全复用条件');
  }
  return fixture;
}

function createFixture(databaseUrl, fixture) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(`D07-C-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 多项目 C ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D07-TEST'),
  (${sqlLiteral(fixture.projectXId)}::uuid, ${sqlLiteral(`D07-X-${fixture.suffix}`)}, ${sqlLiteral(`[D07-TEST] 跨实体 X ${fixture.suffix}`)}, 'active', ${sqlLiteral(fixture.outsideEntityId)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES
  (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.leadEntityId)}::uuid, true),
  (${sqlLiteral(fixture.projectXId)}::uuid, ${sqlLiteral(fixture.outsideEntityId)}::uuid, true);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark)
VALUES (${sqlLiteral(fixture.visitorEmployeeId)}::uuid, ${sqlLiteral(`[D07-TEST] 访客 ${fixture.suffix}`)},
  ${sqlLiteral(`D07-V-${fixture.suffix}`)}, ${sqlLiteral(fixture.outsideEntityId)}::uuid, '访客', 'employee', 'active', 'D07-TEST');
INSERT INTO public.site_project_members(id, project_id, employee_id, membership_type, status)
VALUES
  (${sqlLiteral(fixture.memberCId)}::uuid, ${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.memberEmployeeId)}::uuid, 'internal', 'active'),
  (${sqlLiteral(fixture.memberOrdinaryAId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.ordinaryEmployeeId)}::uuid, 'internal', 'active');
INSERT INTO public.project_join_applications(id, project_id, applicant_user_id, employee_id, name, phone, position, status, target_entity_id)
VALUES
  (${sqlLiteral(fixture.externalOwnApplicationId)}::uuid, ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.companyActor.id)}::uuid,
    ${sqlLiteral(fixture.externalEmployeeId)}::uuid, ${sqlLiteral(`[D07-TEST] 外协本人 ${fixture.suffix}`)}, ${sqlLiteral(`139${fixture.numericSuffix}`)}, '外协', 'pending_project_review', ${sqlLiteral(fixture.leadEntityId)}::uuid),
  (${sqlLiteral(fixture.otherApplicationId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid, ${sqlLiteral(fixture.entityActorId)}::uuid,
    ${sqlLiteral(fixture.otherProjectEmployeeId)}::uuid, ${sqlLiteral(`[D07-TEST] 其他申请 ${fixture.suffix}`)}, ${sqlLiteral(`138${fixture.numericSuffix}`)}, '外协', 'pending_project_review', ${sqlLiteral(fixture.leadEntityId)}::uuid);
COMMIT;`);
}

function switchActor(databaseUrl, fixture, employeeId, departmentId) {
  runPsql(databaseUrl, `UPDATE public.profiles
SET role='employee', admin_level=NULL, is_super_admin=false,
    department_id=${sqlLiteral(departmentId)}::uuid,
    employee_id=${sqlLiteral(employeeId)}::uuid,
    updated_at=now()
WHERE id=${sqlLiteral(fixture.companyActor.id)}::uuid;`);
}

function restoreActor(databaseUrl, fixture) {
  const actor = fixture.companyActor;
  runPsql(databaseUrl, `UPDATE public.profiles
SET role=${sqlLiteral(actor.role)}, admin_level=${sqlNullable(actor.admin_level)},
    is_super_admin=${actor.is_super_admin ? 'true' : 'false'},
    department_id=${sqlNullable(actor.department_id, 'uuid')},
    employee_id=${sqlNullable(actor.employee_id, 'uuid')}, updated_at=now()
WHERE id=${sqlLiteral(actor.id)}::uuid;`);
}

async function setRoles(boundary, anonKey, token, projectId, roles) {
  return rpc(boundary, anonKey, token, 'site_project_set_roles', {
    p_project_id: projectId,
    p_roles: roles,
  });
}

async function canManage(boundary, anonKey, token, projectId) {
  const response = await rpc(boundary, anonKey, token, 'site_project_can_manage', { p_project_id: projectId });
  return isSuccess(response) ? response.json === true : null;
}

async function canRefresh(boundary, anonKey, token, projectId) {
  return rpc(boundary, anonKey, token, 'site_project_refresh_invite', { p_project_id: projectId });
}

function recordRoleAudit(databaseUrl, fixture, projectId) {
  const id = runPsql(databaseUrl, `SELECT id FROM public.site_project_audit_logs
    WHERE project_id=${sqlLiteral(projectId)}::uuid
      AND actor_id=${sqlLiteral(fixture.entityActorId)}::uuid
      AND action='set_roles'
    ORDER BY created_at DESC LIMIT 1;`);
  if (id) fixture.auditIds.add(id);
}

async function entitySetRoles(boundary, databaseUrl, anonKey, token, fixture, projectId, roles) {
  const response = await setRoles(boundary, anonKey, token, projectId, roles);
  if (isSuccess(response)) recordRoleAudit(databaseUrl, fixture, projectId);
  return response;
}

function roleCount(databaseUrl, projectId, userId = null) {
  return Number.parseInt(runPsql(databaseUrl, `SELECT count(*) FROM public.site_project_roles
    WHERE project_id=${sqlLiteral(projectId)}::uuid
    ${userId ? `AND user_id=${sqlLiteral(userId)}::uuid` : ''};`), 10);
}

function cleanupFixture(databaseUrl, fixture) {
  restoreActor(databaseUrl, fixture);
  const auditIds = [...fixture.auditIds];
  const auditWhere = auditIds.length
    ? `id IN (${auditIds.map(id => `${sqlLiteral(id)}::uuid`).join(',')}) OR `
    : '';
  runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.training_visitor_safety_notices WHERE id=${sqlLiteral(fixture.visitorNoticeId)}::uuid;
DELETE FROM public.site_project_invites WHERE project_id IN (
  ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid,
  ${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid
);
DELETE FROM public.site_project_roles WHERE project_id IN (
  ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid,
  ${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid
);
DELETE FROM public.project_join_applications WHERE id IN (
  ${sqlLiteral(fixture.externalOwnApplicationId)}::uuid, ${sqlLiteral(fixture.otherApplicationId)}::uuid
);
DELETE FROM public.project_person_admission_path_history WHERE project_id IN (
  ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid,
  ${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid
);
DELETE FROM public.project_person_admission_paths WHERE project_id IN (
  ${sqlLiteral(fixture.projectAId)}::uuid, ${sqlLiteral(fixture.projectBId)}::uuid,
  ${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid
);
DELETE FROM public.site_project_members WHERE id IN (
  ${sqlLiteral(fixture.memberCId)}::uuid, ${sqlLiteral(fixture.memberOrdinaryAId)}::uuid
);
DELETE FROM public.site_project_audit_logs WHERE ${auditWhere}
  project_id IN (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid)
  OR entity_id IN (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid);
DELETE FROM public.site_projects WHERE id IN (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid);
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid)
  OR entity_id IN (${sqlLiteral(fixture.projectCId)}::uuid, ${sqlLiteral(fixture.projectXId)}::uuid);
DELETE FROM public.training_employees WHERE id=${sqlLiteral(fixture.visitorEmployeeId)}::uuid;
COMMIT;`);
  return Number.parseInt(runPsql(databaseUrl, `SELECT
    (SELECT count(*) FROM public.site_projects WHERE id IN (${sqlLiteral(fixture.projectCId)}::uuid,${sqlLiteral(fixture.projectXId)}::uuid))
    + (SELECT count(*) FROM public.site_project_roles WHERE project_id IN (${sqlLiteral(fixture.projectAId)}::uuid,${sqlLiteral(fixture.projectBId)}::uuid,${sqlLiteral(fixture.projectCId)}::uuid,${sqlLiteral(fixture.projectXId)}::uuid))
    + (SELECT count(*) FROM public.site_project_invites WHERE project_id IN (${sqlLiteral(fixture.projectAId)}::uuid,${sqlLiteral(fixture.projectBId)}::uuid,${sqlLiteral(fixture.projectCId)}::uuid,${sqlLiteral(fixture.projectXId)}::uuid))
    + (SELECT count(*) FROM public.project_join_applications WHERE id IN (${sqlLiteral(fixture.externalOwnApplicationId)}::uuid,${sqlLiteral(fixture.otherApplicationId)}::uuid))
    + (SELECT count(*) FROM public.site_project_members WHERE id IN (${sqlLiteral(fixture.memberCId)}::uuid,${sqlLiteral(fixture.memberOrdinaryAId)}::uuid))
    + (SELECT count(*) FROM public.training_visitor_safety_notices WHERE id=${sqlLiteral(fixture.visitorNoticeId)}::uuid)
    + (SELECT count(*) FROM public.training_employees WHERE id=${sqlLiteral(fixture.visitorEmployeeId)}::uuid)
    + (SELECT count(*) FROM public.site_project_audit_logs WHERE ${auditIds.length ? `id IN (${auditIds.map(id => `${sqlLiteral(id)}::uuid`).join(',')}) OR ` : ''}project_id IN (${sqlLiteral(fixture.projectCId)}::uuid,${sqlLiteral(fixture.projectXId)}::uuid));`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D07-MATRIX-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D07-MATRIX-00 v63 权限边界、迁移登记和单项目经理限制完整', verifySourceBoundary());

  applyMigration(boundary.databaseUrl);
  const base = readFixture(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const fixture = {
    suffix,
    numericSuffix: String(Number.parseInt(suffix.slice(0, 7), 16)).padStart(8, '0').slice(0, 8),
    projectAId: base.project_a_id,
    projectBId: base.project_b_id,
    leadEntityId: base.lead_entity_id,
    outsideEntityId: base.outside_entity_id,
    companyActor: base.company_actor,
    entityActorId: base.entity_actor_id,
    assignableUserId: base.assignable_user_id,
    ordinaryEmployeeId: base.ordinary_employee_id,
    externalEmployeeId: base.external_employee_id,
    memberEmployeeId: base.member_employee_id,
    otherProjectEmployeeId: base.other_project_employee_id,
    projectCId: crypto.randomUUID(),
    projectXId: crypto.randomUUID(),
    visitorEmployeeId: crypto.randomUUID(),
    memberCId: crypto.randomUUID(),
    memberOrdinaryAId: crypto.randomUUID(),
    externalOwnApplicationId: crypto.randomUUID(),
    otherApplicationId: crypto.randomUUID(),
    visitorNoticeId: crypto.randomUUID(),
    illegalRoleId: crypto.randomUUID(),
    auditIds: new Set(),
  };
  let residue = -1;

  try {
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey,
        required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    check('D07-MATRIX-01 测试账号身份与 D02 夹具一致',
      company.userId === fixture.companyActor.id && entity.userId === fixture.entityActorId);

    createFixture(boundary.databaseUrl, fixture);

    const companyProjects = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=in.(${fixture.projectAId},${fixture.projectBId},${fixture.projectXId})`, 'id');
    const companyEmployees = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=in.(${fixture.memberEmployeeId},${fixture.visitorEmployeeId})`, 'id');
    const companyAssignBefore = roleCount(boundary.databaseUrl, fixture.projectAId);
    const companyAssign = await setRoles(boundary, anonKey, company.token, fixture.projectAId,
      [{ user_id: fixture.assignableUserId, role: 'project_manager' }]);
    const companyRefresh = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    check('D07-MATRIX-02 公司级管理员', companyProjects?.length === 3 && companyEmployees?.length === 2
      && await canManage(boundary, anonKey, company.token, fixture.projectAId) === false
      && isDenied(companyAssign, '仅项目主责经营实体管理员可以任命项目角色')
      && isDenied(companyRefresh, '您无权刷新项目邀请码')
      && roleCount(boundary.databaseUrl, fixture.projectAId) === companyAssignBefore);

    const entityProjects = await restRows(boundary, anonKey, entity.token, 'site_projects',
      `id=in.(${fixture.projectAId},${fixture.projectBId})`, 'id');
    const entityCrossProject = await restRows(boundary, anonKey, entity.token, 'site_projects',
      `id=eq.${fixture.projectXId}`, 'id');
    const entityOwnEmployee = await restRows(boundary, anonKey, entity.token, 'training_employees',
      `id=eq.${fixture.memberEmployeeId}`, 'id');
    const entityCrossEmployee = await restRows(boundary, anonKey, entity.token, 'training_employees',
      `id=eq.${fixture.visitorEmployeeId}`, 'id');
    const entityAssign = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectAId, [{ user_id: fixture.assignableUserId, role: 'project_manager' }]);
    const entityRefresh = await canRefresh(boundary, anonKey, entity.token, fixture.projectAId);
    const entityCrossAssign = await setRoles(boundary, anonKey, entity.token, fixture.projectXId,
      [{ user_id: fixture.assignableUserId, role: 'safety_officer' }]);
    const entityCrossRefresh = await canRefresh(boundary, anonKey, entity.token, fixture.projectXId);
    check('D07-MATRIX-03 主责经营实体管理员', entityProjects?.length === 2
      && entityCrossProject?.length === 0 && entityOwnEmployee?.length === 1 && entityCrossEmployee?.length === 0
      && isSuccess(entityAssign) && isSuccess(entityRefresh)
      && isDenied(entityCrossAssign, '仅项目主责经营实体管理员可以任命项目角色')
      && isDenied(entityCrossRefresh, '您无权刷新项目邀请码'));
    await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token, fixture, fixture.projectAId, []);

    switchActor(boundary.databaseUrl, fixture, fixture.ordinaryEmployeeId, fixture.leadEntityId);
    const managerASet = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectAId, [{ user_id: fixture.companyActor.id, role: 'project_manager' }]);
    const managerCSet = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectCId, [{ user_id: fixture.companyActor.id, role: 'project_manager' }]);
    const managerA = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    const managerC = await canRefresh(boundary, anonKey, company.token, fixture.projectCId);
    const managerB = await canRefresh(boundary, anonKey, company.token, fixture.projectBId);
    const managerX = await canRefresh(boundary, anonKey, company.token, fixture.projectXId);
    const managerCrossRows = await restRows(boundary, anonKey, company.token, 'site_project_members',
      `project_id=eq.${fixture.projectBId}`, 'id');
    const managerOwnRows = await restRows(boundary, anonKey, company.token, 'site_project_members',
      `project_id=eq.${fixture.projectAId}`, 'id');
    const managerBEmployee = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.otherProjectEmployeeId}`, 'id');
    const managerAssign = await setRoles(boundary, anonKey, company.token, fixture.projectAId, []);
    check('D07-MATRIX-04 项目经理', isSuccess(managerASet) && isSuccess(managerCSet)
      && isSuccess(managerA) && isSuccess(managerC)
      && isDenied(managerB, '您无权刷新项目邀请码') && isDenied(managerX, '您无权刷新项目邀请码')
      && managerOwnRows?.length > 0 && managerCrossRows?.length === 0 && managerBEmployee?.length === 0
      && isDenied(managerAssign, '仅项目主责经营实体管理员可以任命项目角色'));
    check('D07-MATRIX-05 同一人员可同时管理项目 A 和项目 C',
      roleCount(boundary.databaseUrl, fixture.projectAId, fixture.companyActor.id) === 1
      && roleCount(boundary.databaseUrl, fixture.projectCId, fixture.companyActor.id) === 1);

    const revokeA = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectAId, []);
    const revokedA = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    const retainedC = await canRefresh(boundary, anonKey, company.token, fixture.projectCId);
    check('D07-MATRIX-06 撤销项目 A 后项目 C 权限保持有效', isSuccess(revokeA)
      && isDenied(revokedA, '您无权刷新项目邀请码') && isSuccess(retainedC)
      && roleCount(boundary.databaseUrl, fixture.projectAId, fixture.companyActor.id) === 0
      && roleCount(boundary.databaseUrl, fixture.projectCId, fixture.companyActor.id) === 1);

    await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token, fixture, fixture.projectCId, []);
    const safetyASet = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectAId, [{ user_id: fixture.companyActor.id, role: 'safety_officer' }]);
    const safetyCSet = await entitySetRoles(boundary, boundary.databaseUrl, anonKey, entity.token,
      fixture, fixture.projectCId, [{ user_id: fixture.companyActor.id, role: 'safety_officer' }]);
    const safetyA = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    const safetyC = await canRefresh(boundary, anonKey, company.token, fixture.projectCId);
    const safetyB = await canRefresh(boundary, anonKey, company.token, fixture.projectBId);
    const safetyX = await canRefresh(boundary, anonKey, company.token, fixture.projectXId);
    const safetyAssign = await setRoles(boundary, anonKey, company.token, fixture.projectAId, []);
    check('D07-MATRIX-07 安全员', isSuccess(safetyASet) && isSuccess(safetyCSet)
      && isSuccess(safetyA) && isSuccess(safetyC)
      && isDenied(safetyB, '您无权刷新项目邀请码') && isDenied(safetyX, '您无权刷新项目邀请码')
      && isDenied(safetyAssign, '仅项目主责经营实体管理员可以任命项目角色')
      && roleCount(boundary.databaseUrl, fixture.projectAId, fixture.companyActor.id) === 1
      && roleCount(boundary.databaseUrl, fixture.projectCId, fixture.companyActor.id) === 1);

    runPsql(boundary.databaseUrl, `DELETE FROM public.site_project_roles WHERE user_id=${sqlLiteral(fixture.companyActor.id)}::uuid;`);
    const ordinaryOwn = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.ordinaryEmployeeId}`, 'id');
    const ordinaryOther = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.otherProjectEmployeeId}`, 'id');
    const ordinaryA = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=eq.${fixture.projectAId}`, 'id');
    const ordinaryB = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=eq.${fixture.projectBId}`, 'id');
    const ordinaryRefresh = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    const illegalRest = await restInsert(boundary, anonKey, company.token, 'site_project_roles', {
      id: fixture.illegalRoleId,
      project_id: fixture.projectAId,
      user_id: fixture.companyActor.id,
      role: 'project_manager',
      active: true,
      assigned_by: fixture.companyActor.id,
    });
    const illegalRpc = await setRoles(boundary, anonKey, company.token, fixture.projectAId,
      [{ user_id: fixture.companyActor.id, role: 'project_manager' }]);
    check('D07-MATRIX-08 普通员工', ordinaryOwn?.length === 1 && ordinaryOther?.length === 0
      && ordinaryA?.length === 1 && ordinaryB?.length === 0
      && isDenied(ordinaryRefresh, '您无权刷新项目邀请码')
      && isDenied(illegalRest) && isDenied(illegalRpc, '仅项目主责经营实体管理员可以任命项目角色')
      && roleCount(boundary.databaseUrl, fixture.projectAId, fixture.companyActor.id) === 0);

    switchActor(boundary.databaseUrl, fixture, fixture.externalEmployeeId, fixture.leadEntityId);
    const externalOwnEmployee = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.externalEmployeeId}`, 'id');
    const externalOtherEmployee = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.memberEmployeeId}`, 'id');
    const externalOwnApp = await restRows(boundary, anonKey, company.token, 'project_join_applications',
      `id=eq.${fixture.externalOwnApplicationId}`, 'id');
    const externalOtherApp = await restRows(boundary, anonKey, company.token, 'project_join_applications',
      `id=eq.${fixture.otherApplicationId}`, 'id');
    const externalA = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=eq.${fixture.projectAId}`, 'id');
    const externalB = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=eq.${fixture.projectBId}`, 'id');
    const externalX = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=eq.${fixture.projectXId}`, 'id');
    const externalRefresh = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    check('D07-MATRIX-09 外协人员', externalOwnEmployee?.length === 1 && externalOtherEmployee?.length === 0
      && externalOwnApp?.length === 1 && externalOtherApp?.length === 0
      && externalA?.length === 1 && externalB?.length === 0 && externalX?.length === 0
      && isDenied(externalRefresh, '您无权刷新项目邀请码'));

    switchActor(boundary.databaseUrl, fixture, fixture.visitorEmployeeId, fixture.outsideEntityId);
    const issueNotice = await rpc(boundary, anonKey, entity.token, 'training_issue_visitor_notice', {
      p_project_id: fixture.projectAId,
      p_employee_id: fixture.visitorEmployeeId,
      p_content: `[D07-TEST] 访客告知 ${fixture.suffix}`,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    if (isSuccess(issueNotice) && issueNotice.json?.id) fixture.visitorNoticeId = issueNotice.json.id;
    const visitorNotices = await rpc(boundary, anonKey, company.token, 'training_my_visitor_notices');
    const acknowledge = await rpc(boundary, anonKey, company.token, 'training_acknowledge_visitor_notice', {
      p_notice_id: fixture.visitorNoticeId,
    });
    const visitorOwnEmployee = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.visitorEmployeeId}`, 'id');
    const visitorOtherEmployee = await restRows(boundary, anonKey, company.token, 'training_employees',
      `id=eq.${fixture.memberEmployeeId}`, 'id');
    const visitorProjects = await restRows(boundary, anonKey, company.token, 'site_projects',
      `id=in.(${fixture.projectAId},${fixture.projectBId})`, 'id');
    const visitorAdmissions = await restRows(boundary, anonKey, company.token, 'training_admissions',
      `project_id=in.(${fixture.projectAId},${fixture.projectBId})`, 'id');
    const visitorRefresh = await canRefresh(boundary, anonKey, company.token, fixture.projectAId);
    const visitorAdmissionManage = await rpc(boundary, anonKey, company.token,
      'training_admission_readiness_checklist', {
        p_project_id: fixture.projectAId,
        p_employee_id: fixture.memberEmployeeId,
      });
    check('D07-MATRIX-10 访客', isSuccess(issueNotice)
      && Array.isArray(visitorNotices.json) && visitorNotices.json.some(item => item.id === fixture.visitorNoticeId)
      && isSuccess(acknowledge) && visitorOwnEmployee?.length === 1 && visitorOtherEmployee?.length === 0
      && visitorProjects?.length === 0 && visitorAdmissions?.length === 0
      && isDenied(visitorRefresh, '您无权刷新项目邀请码')
      && isDenied(visitorAdmissionManage, '您无权查看该项目准入清单'));

    check('D07-MATRIX-11 REST、受控 RPC、跨 project_id、跨经营实体和非法提权均已覆盖',
      isDenied(illegalRest) && isDenied(illegalRpc)
      && ordinaryB?.length === 0 && externalB?.length === 0 && entityCrossProject?.length === 0
      && isDenied(managerB) && isDenied(managerX) && isDenied(safetyB) && isDenied(safetyX)
      && externalX?.length === 0 && isDenied(entityCrossRefresh));
  } finally {
    residue = cleanupFixture(boundary.databaseUrl, fixture);
  }

  check('D07-MATRIX-12 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_ROLE_PERMISSION_MATRIX_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(`D07 role permission matrix failed: ${error.message}`);
  process.exit(1);
});

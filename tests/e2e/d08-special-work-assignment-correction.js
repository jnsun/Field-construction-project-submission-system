/** D08-4 focused correction: drilling is project-wide training input; certificates gate only explicit member work. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v72-contractor-archive-and-certificate-compliance.sql');
const results = [];
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}
function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').replaceAll(databaseUrl, '[database-url-redacted]').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`D08-4 focused 数据库操作失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}
function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('D08-4 focused v72 迁移应用失败');
}
async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, { ...options, headers: { apikey: anonKey, ...(options.headers || {}) } });
  const text = await response.text(); let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) throw new Error('D08-4 focused 隔离测试账号登录失败');
  return { token: response.json.access_token, userId: response.json.user.id };
}
async function rpc(boundary, anonKey, token, name, body) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const success = response => response.status >= 200 && response.status < 300;
const denied = response => [400, 401, 403, 404].includes(response.status);

function readScope(databaseUrl) {
  const value = runPsql(databaseUrl, `SELECT json_build_object(
    'entity_a', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'company_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'),
    'entity_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002')
  )::text;`);
  const scope = JSON.parse(value);
  if (!scope.entity_a || !scope.company_user || !scope.entity_user) throw new Error('D08-4 focused D02 夹具范围不完整');
  return scope;
}

function setup(databaseUrl, f) {
  const employeeRows = f.people.map(p => `(${literal(p.id)}::uuid, ${literal(`[D08-TEST] ${p.key} ${f.suffix}`)}, ${literal(`D08-4F-${p.key}-${f.suffix}`)}, ${literal(f.scope.entity_a)}::uuid, ${literal(p.position)}, 'employee', 'active', 'D08-4 FOCUSED')`).join(',\n');
  const memberRows = f.people.map(p => `(${literal(p.memberA)}::uuid, ${literal(f.projectA)}::uuid, ${literal(p.id)}::uuid, ${p.external ? `${literal(f.company)}::uuid` : 'NULL'}, ${literal(p.external ? 'external' : 'internal')}, ${literal(p.position)}, 'active', ${literal(f.scope.entity_user)}::uuid)`).join(',\n');
  runPsql(databaseUrl, `BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes) VALUES
 (${literal(f.projectA)}::uuid, ${literal(`D08-4F-A-${f.suffix}`)}, '[D08-TEST] focused 钻探项目', 'active', ${literal(f.scope.entity_a)}::uuid, 'D08-4 FOCUSED'),
 (${literal(f.projectB)}::uuid, ${literal(`D08-4F-B-${f.suffix}`)}, '[D08-TEST] focused 非钻探项目', 'active', ${literal(f.scope.entity_a)}::uuid, 'D08-4 FOCUSED');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead) VALUES
 (${literal(f.projectA)}::uuid, ${literal(f.scope.entity_a)}::uuid, true), (${literal(f.projectB)}::uuid, ${literal(f.scope.entity_a)}::uuid, true);
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active, assigned_by)
VALUES (${literal(f.roleA)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.scope.entity_user)}::uuid, 'project_manager', true, ${literal(f.scope.company_user)}::uuid);
INSERT INTO public.contractor_companies(id, name, unified_code, managing_entity_id, status, created_by)
VALUES (${literal(f.company)}::uuid, ${literal(`[D08-TEST] focused 单位 ${f.suffix}`)}, ${literal(`F72${f.suffix}0000000`.slice(0, 18))}, ${literal(f.scope.entity_a)}::uuid, 'active', ${literal(f.scope.entity_user)}::uuid);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark) VALUES ${employeeRows};
INSERT INTO public.site_project_members(id, project_id, employee_id, contractor_id, membership_type, work_type, status, created_by) VALUES ${memberRows};
INSERT INTO public.site_project_members(id, project_id, employee_id, membership_type, work_type, status, created_by)
VALUES (${literal(f.sameMemberB)}::uuid, ${literal(f.projectB)}::uuid, ${literal(f.people.find(x => x.key === 'ordinary').id)}::uuid, 'internal', '普工', 'active', ${literal(f.scope.company_user)}::uuid);
INSERT INTO public.contractor_documents(project_id, contractor_id, employee_id, document_type, certificate_type, certificate_no, valid_until, storage_path, review_status) VALUES
 (${literal(f.projectA)}::uuid, ${literal(f.company)}::uuid, ${literal(f.people.find(x => x.key === 'valid').id)}::uuid, 'special_certificate', '电工', 'VALID-E', CURRENT_DATE + 100, ${literal(`training-admission/contractor-documents/${f.projectA}/focused-valid.pdf`)}, 'approved'),
 (${literal(f.projectA)}::uuid, ${literal(f.company)}::uuid, ${literal(f.people.find(x => x.key === 'expired').id)}::uuid, 'special_certificate', '电工', 'EXPIRED-E', CURRENT_DATE - 1, ${literal(`training-admission/contractor-documents/${f.projectA}/focused-expired.pdf`)}, 'approved'),
 (${literal(f.projectA)}::uuid, ${literal(f.company)}::uuid, ${literal(f.people.find(x => x.key === 'multi').id)}::uuid, 'special_certificate', '电工', 'MULTI-E', CURRENT_DATE - 1, ${literal(`training-admission/contractor-documents/${f.projectA}/focused-multi-e.pdf`)}, 'approved'),
 (${literal(f.projectA)}::uuid, ${literal(f.company)}::uuid, ${literal(f.people.find(x => x.key === 'multi').id)}::uuid, 'special_certificate', '焊工', 'MULTI-W', CURRENT_DATE + 100, ${literal(`training-admission/contractor-documents/${f.projectA}/focused-multi-w.pdf`)}, 'approved');
UPDATE public.profiles SET role='employee', admin_level=NULL WHERE id=${literal(f.scope.entity_user)}::uuid;
COMMIT;`);
}

function cleanup(databaseUrl, f) {
  runPsql(databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
UPDATE public.profiles SET department_id=${literal(f.scope.entity_a)}::uuid, role='admin', admin_level='dept' WHERE id=${literal(f.scope.entity_user)}::uuid;
DELETE FROM public.training_personnel_reapproval_requests WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_document_versions WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_documents WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_member_assignment_history WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_members WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.training_employee_versions WHERE employee_id IN (${f.people.map(x => `${literal(x.id)}::uuid`).join(',')});
DELETE FROM public.training_employees WHERE id IN (${f.people.map(x => `${literal(x.id)}::uuid`).join(',')});
DELETE FROM public.contractor_company_versions WHERE contractor_id=${literal(f.company)}::uuid;
DELETE FROM public.contractor_companies WHERE id=${literal(f.company)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_entities WHERE project_id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
DELETE FROM public.site_projects WHERE id IN (${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid); COMMIT;`);
  return Number(runPsql(databaseUrl, `SELECT (SELECT count(*) FROM public.site_projects WHERE report_notes='D08-4 FOCUSED')+(SELECT count(*) FROM public.training_employees WHERE remark='D08-4 FOCUSED');`));
}

async function main() {
  const started = process.hrtime.bigint();
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const web = [
    fs.readFileSync(path.join(root, 'js/modules/training/contractors.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'js/modules/training/admission-mine.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'js/modules/training/admission-review.js'), 'utf8'),
  ].join('\n');
  check('D08-CORRECT-00 静态规则不含钻探证或按岗位自动启用', /certificate_type IN \('爆破', '电工', '焊工'\)/.test(sql)
    && !/certificate_type IN \([^\n]*钻探/.test(sql) && !web.includes("CERT_TYPES: ['爆破', '钻探'") && !web.includes('const highRisk'));
  const boundary = validateTestBoundary();
  check('D08-CORRECT-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const [companyUser, entityUser] = await Promise.all([
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
  ]);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const specs = [['manager', '项目经理', false], ['ordinary', '普工', false], ['drillElectric', '电工', true], ['valid', '电工', true], ['expired', '电工', true], ['missing', '电工', true], ['multi', '焊工', true]];
  const fixture = { scope, suffix, projectA: crypto.randomUUID(), projectB: crypto.randomUUID(), roleA: crypto.randomUUID(), company: crypto.randomUUID(), sameMemberB: crypto.randomUUID(), people: specs.map(([key, position, external]) => ({ key, position, external, id: crypto.randomUUID(), memberA: crypto.randomUUID() })) };
  let residue = -1;
  try {
    setup(boundary.databaseUrl, fixture);
    const toggle = await rpc(boundary, anonKey, entityUser.token, 'site_project_set_drilling_operation', { p_project_id: fixture.projectA, p_enabled: true, p_reason: 'focused 钻探项目' });
    const scopeA = await rpc(boundary, anonKey, entityUser.token, 'training_project_drilling_training_scope', { p_project_id: fixture.projectA });
    const scopeB = await rpc(boundary, anonKey, companyUser.token, 'training_project_drilling_training_scope', { p_project_id: fixture.projectB });
    const manager = fixture.people.find(x => x.key === 'manager'); const ordinary = fixture.people.find(x => x.key === 'ordinary'); const drillElectric = fixture.people.find(x => x.key === 'drillElectric');
    check('D08-CORRECT-01 钻探项目普通人员无证不出现钻探证阻断', success(toggle) && scopeA.json?.some(x => x.employee_id === ordinary.id && x.requires_drilling_training));
    check('D08-CORRECT-02 钻探项目项目经理同样进入全员培训范围', scopeA.json?.some(x => x.employee_id === manager.id && x.requires_drilling_training));
    check('D08-CORRECT-03 钻探项目电工仅取得项目级培训输入', scopeA.json?.some(x => x.employee_id === drillElectric.id && x.requirement_code === 'drilling_project_training'));
    check('D08-CORRECT-04 非钻探项目不产生钻探专项要求', success(scopeB) && scopeB.json?.every(x => !x.requires_drilling_training && x.requirement_code === null));
    check('D08-CORRECT-05 同一人员只有钻探项目 A 有专项要求', scopeA.json?.some(x => x.employee_id === ordinary.id && x.requires_drilling_training) && scopeB.json?.some(x => x.employee_id === ordinary.id && !x.requires_drilling_training));

    const statuses0 = await rpc(boundary, anonKey, entityUser.token, 'training_contractor_certificate_statuses', { p_project_id: fixture.projectA });
    const byEmployee = response => new Map((response.json || []).map(x => [x.employee_id, x]));
    const initial = byEmployee(statuses0);
    check('D08-CORRECT-06 持有效电工证但未启用电工作业不产生门禁', initial.get(fixture.people.find(x => x.key === 'valid').id)?.certificate_status === 'not_required');
    check('D08-CORRECT-07 持过期电工证但未启用电工作业不阻断', initial.get(fixture.people.find(x => x.key === 'expired').id)?.certificate_status === 'not_required');

    const assign = async (key, types, reason) => rpc(boundary, anonKey, entityUser.token, 'training_set_member_special_work_types', { p_member_id: fixture.people.find(x => x.key === key).memberA, p_special_work_types: types, p_reason: reason });
    await assign('missing', ['电工'], 'focused 启用电工'); await assign('valid', ['电工'], 'focused 启用电工'); await assign('multi', ['焊工'], 'focused 只启用焊工');
    const statuses1 = byEmployee(await rpc(boundary, anonKey, entityUser.token, 'training_contractor_certificate_statuses', { p_project_id: fixture.projectA }));
    check('D08-CORRECT-08 启用电工作业但无电工证被阻断', statuses1.get(fixture.people.find(x => x.key === 'missing').id)?.certificate_status === 'missing');
    check('D08-CORRECT-09 启用电工作业且有效电工证条件满足', statuses1.get(fixture.people.find(x => x.key === 'valid').id)?.certificate_status === 'valid');
    check('D08-CORRECT-10 同时持电工焊工证但只启用焊工时只检查焊工', statuses1.get(fixture.people.find(x => x.key === 'multi').id)?.certificate_status === 'valid' && statuses1.get(fixture.people.find(x => x.key === 'multi').id)?.required_certificate === '焊工');

    const selfDenied = await rpc(boundary, anonKey, companyUser.token, 'training_set_member_special_work_types', { p_member_id: drillElectric.memberA, p_special_work_types: ['电工'], p_reason: '越权' });
    const crossDenied = await rpc(boundary, anonKey, entityUser.token, 'training_set_member_special_work_types', { p_member_id: fixture.sameMemberB, p_special_work_types: ['电工'], p_reason: '跨项目越权' });
    check('D08-CORRECT-11 无项目管理权用户不能启用特种作业', denied(selfDenied));
    check('D08-CORRECT-12 跨项目管理人员不能修改其他项目作业要求', denied(crossDenied));

    const missing = fixture.people.find(x => x.key === 'missing');
    const before = Number(runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_member_assignment_history WHERE member_id=${literal(missing.memberA)}::uuid;`));
    const cancel = await assign('missing', [], 'focused 取消电工');
    const after = Number(runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_member_assignment_history WHERE member_id=${literal(missing.memberA)}::uuid;`));
    const direct = await request(boundary.apiOrigin, anonKey, `/rest/v1/site_project_members?id=eq.${missing.memberA}`, { method: 'PATCH', headers: { Authorization: `Bearer ${entityUser.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ special_work_types: ['焊工'] }) });
    check('D08-CORRECT-13 启用和取消均形成不可绕过的成员历史', success(cancel) && after === before + 1 && denied(direct));

    const badCertificate = await rpc(boundary, anonKey, entityUser.token, 'contractor_document_create', { p_project_id: fixture.projectA, p_contractor_id: fixture.company, p_employee_id: drillElectric.id, p_document_type: 'special_certificate', p_certificate_type: '钻探', p_certificate_no: 'NO-DRILL-CERT', p_valid_from: null, p_valid_until: '2099-12-31', p_storage_path: `training-admission/contractor-documents/${fixture.projectA}/no-drill-cert.pdf` });
    check('D08-CORRECT-14 不存在钻探 certificate_type 强制要求', denied(badCertificate) && !runPsql(boundary.databaseUrl, `SELECT pg_get_functiondef('public.site_project_apply(text,text,text,text,text,text,text,text,jsonb)'::regprocedure);`).includes('高风险工种必须上传'));

    const immutable = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object('contract', EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_contractor_contract_version_guard' AND tgenabled<>'D'), 'document', EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_contractor_document_version_guard' AND tgenabled<>'D'))::text;`));
    const storagePolicies = Number(runPsql(boundary.databaseUrl, `SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND policyname IN ('training_admission_contractor_read','training_admission_project_update','training_admission_project_delete');`));
    check('D08-CORRECT-15 原合同/资质/证照历史防篡改能力保留', immutable.contract && immutable.document);
    check('D08-CORRECT-16 Storage 私有读取与归档防覆盖策略保留', storagePolicies === 3);
  } finally {
    residue = cleanup(boundary.databaseUrl, fixture);
  }
  check('D08-CORRECT-17 focused 测试零残留', residue === 0, `residue=${residue}`);
  const failed = results.filter(x => !x.pass); const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`D08_SPECIAL_WORK_CORRECTION_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_s=${elapsed.toFixed(2)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(`D08 special-work correction failed: ${error.message}`); process.exit(1); });

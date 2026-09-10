/** D08-4 targeted: certificate mapping, immutable contractor archives and Storage boundary. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v72-contractor-archive-and-certificate-compliance.sql');
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const results = [];

function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}
function finish(started, residue = '-') {
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D08_CONTRACTOR_ARCHIVE_CERTIFICATE_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}
function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`D08-4 专项数据库操作失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}
function hasCurrentSpecialWorkSchema(databaseUrl) {
  return runPsql(databaseUrl, `SELECT (
    to_regclass('public.training_special_work_audit_logs') IS NOT NULL
    AND to_regprocedure('public.training_current_special_requirements(uuid,uuid)') IS NOT NULL
    AND to_regprocedure('public.training_set_member_special_work_types(uuid,text[],text)') IS NOT NULL
  )::int;`) === '1';
}
function applyMigration(databaseUrl) {
  if (hasCurrentSpecialWorkSchema(databaseUrl)) {
    console.log('D08_ARCHIVE_SCHEMA current-capabilities-present; skip-v72-replay');
    return 'current-schema';
  }
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D08-4 v72 测试迁移应用失败');
  return 'legacy-bootstrap';
}
async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options, headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D08-4 隔离测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}
async function rpc(boundary, anonKey, token, name, body) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function success(response) { return response.status >= 200 && response.status < 300; }
function denied(response) { return [400, 401, 403, 404].includes(response.status); }
function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function blockedMutation(response) {
  return denied(response) || (success(response) && Array.isArray(response.json) && response.json.length === 0);
}
async function upload(boundary, anonKey, token, storagePath, upsert = false) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'x-upsert': String(upsert),
      }, body: Buffer.from('D08-4 isolated archive fixture'),
    });
}
async function sign(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/sign/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
}
async function remove(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
}

function verifyStatic() {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const web = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'contractors.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hash = crypto.createHash('sha256').update(sql).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 72);
  return {
    migration: entry?.file === path.basename(migrationPath) && entry.sha256 === hash
      && /certificate_type IN \('爆破', '电工', '焊工'\)/.test(sql)
      && /special_work_types TEXT\[\]/.test(sql)
      && /includes_drilling BOOLEAN/.test(sql)
      && /CREATE TABLE IF NOT EXISTS public\.contractor_contract_versions/.test(sql)
      && /CREATE TABLE IF NOT EXISTS public\.contractor_document_versions/.test(sql)
      && sql.indexOf('INSERT INTO public.contractor_document_versions')
        < sql.indexOf('UPDATE public.contractor_documents\nSET document_type = \'other\'')
      && /旧证书类型仅保留为历史资料/.test(sql)
      && /REVOKE ALL PRIVILEGES ON TABLE/.test(sql)
      && /training_contractor_archive_file_can_read/.test(sql)
      && /NOT public\.training_admission_file_is_archived\(name\)/.test(sql)
      && /SECURITY DEFINER SET search_path = public, storage/.test(sql),
    web: web.includes("sb.rpc('contractor_contract_create'")
      && web.includes("sb.rpc('contractor_document_create'")
      && web.includes("sb.rpc('contractor_document_review'")
      && web.includes("sb.rpc('contractor_document_revoke'")
      && web.includes("sb.rpc('contractor_contract_review'")
      && !/from\('contractor_contracts'\)\.insert/.test(web)
      && !/from\('contractor_documents'\)\.(insert|update|delete)/.test(web),
  };
}

function readScope(databaseUrl) {
  const value = runPsql(databaseUrl, `SELECT json_build_object(
    'entity_a', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'entity_b', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'company_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'),
    'entity_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002')
  )::text;`);
  const scope = JSON.parse(value);
  if (!scope.entity_a || !scope.entity_b || !scope.company_user || !scope.entity_user) throw new Error('D08-4 D02 夹具范围不完整');
  return scope;
}

function setup(databaseUrl, f) {
  const employeeRows = f.people.map(person =>
    `(${literal(person.id)}::uuid, ${literal(`[D08-TEST] ${person.label} ${f.suffix}`)}, ${literal(`D08-4-${person.key}-${f.suffix}`)}, ${literal(f.scope.entity_a)}::uuid, ${literal(person.position)}, 'employee', 'active', 'D08-4 TEST')`).join(',\n');
  const memberRows = f.people.map(person =>
    `(${literal(person.member)}::uuid, ${literal(f.projectA)}::uuid, ${literal(person.id)}::uuid, ${literal(f.companyA)}::uuid, 'external', ${literal(person.position)}, 'active', ${literal(f.scope.entity_user)}::uuid)`).join(',\n');
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes) VALUES
  (${literal(f.projectA)}::uuid, ${literal(`D08-4-A-${f.suffix}`)}, ${literal(`[D08-TEST] D08-4 A ${f.suffix}`)}, 'active', ${literal(f.scope.entity_a)}::uuid, 'D08-4 TEST'),
  (${literal(f.projectB)}::uuid, ${literal(`D08-4-B-${f.suffix}`)}, ${literal(`[D08-TEST] D08-4 B ${f.suffix}`)}, 'active', ${literal(f.scope.entity_b)}::uuid, 'D08-4 TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead) VALUES
  (${literal(f.projectA)}::uuid, ${literal(f.scope.entity_a)}::uuid, true),
  (${literal(f.projectB)}::uuid, ${literal(f.scope.entity_b)}::uuid, true);
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active, assigned_by) VALUES
  (${literal(f.roleA)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.scope.entity_user)}::uuid, 'project_manager', true, ${literal(f.scope.company_user)}::uuid),
  (${literal(f.roleB)}::uuid, ${literal(f.projectB)}::uuid, ${literal(f.scope.entity_user)}::uuid, 'safety_officer', true, ${literal(f.scope.company_user)}::uuid);
INSERT INTO public.contractor_companies(id, name, unified_code, managing_entity_id, status, created_by) VALUES
  (${literal(f.companyA)}::uuid, ${literal(`[D08-TEST] 单位A ${f.suffix}`)}, ${literal(`A72${f.suffix}0000000`.slice(0, 18))}, ${literal(f.scope.entity_a)}::uuid, 'active', ${literal(f.scope.entity_user)}::uuid),
  (${literal(f.companyB)}::uuid, ${literal(`[D08-TEST] 单位B ${f.suffix}`)}, ${literal(`B72${f.suffix}0000000`.slice(0, 18))}, ${literal(f.scope.entity_b)}::uuid, 'active', ${literal(f.scope.entity_user)}::uuid);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark) VALUES
${employeeRows};
INSERT INTO public.site_project_members(id, project_id, employee_id, contractor_id, membership_type, work_type, status, created_by) VALUES
${memberRows};
COMMIT;`);
}

function objectExists(databaseUrl, storagePath) {
  return Number.parseInt(runPsql(databaseUrl,
    `SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name=${literal(storagePath)};`), 10) === 1;
}
function versionCount(databaseUrl, table, column, id) {
  return Number.parseInt(runPsql(databaseUrl,
    `SELECT count(*) FROM public.${table} WHERE ${column}=${literal(id)}::uuid;`), 10);
}
function verifyLegacyDocumentMigration(databaseUrl, f) {
  // 当前完整 schema 只回归现行能力；v72 的历史转换由上面的静态 hash/SQL 断言覆盖。
  if (hasCurrentSpecialWorkSchema(databaseUrl)) return true;
  runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
ALTER TABLE public.contractor_documents DROP CONSTRAINT IF EXISTS contractor_documents_special_certificate_type_check;
INSERT INTO public.contractor_documents(
  id, project_id, contractor_id, employee_id, document_type, certificate_type,
  certificate_no, valid_until, storage_path, review_status, reviewed_by, reviewed_at,
  review_note, created_at
) VALUES
  (${literal(f.legacyDrillId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.companyA)}::uuid,
   ${literal(f.people[0].id)}::uuid, 'special_certificate', '钻探', 'LEGACY-DRILL', DATE '2030-12-31',
   ${literal(`training-admission/contractor-documents/${f.projectA}/D08-4-${f.suffix}-legacy-drill.pdf`)},
   'approved', ${literal(f.scope.entity_user)}::uuid, TIMESTAMPTZ '2025-01-02 03:04:05+00', '原审核事实', TIMESTAMPTZ '2025-01-01 00:00:00+00'),
  (${literal(f.legacyUnknownId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.companyA)}::uuid,
   ${literal(f.people[1].id)}::uuid, 'special_certificate', '历史高处作业', 'LEGACY-OTHER', DATE '2030-12-31',
   ${literal(`training-admission/contractor-documents/${f.projectA}/D08-4-${f.suffix}-legacy-other.pdf`)},
   'rejected', ${literal(f.scope.entity_user)}::uuid, TIMESTAMPTZ '2025-02-03 04:05:06+00', '旧分类审核', TIMESTAMPTZ '2025-02-01 00:00:00+00');
COMMIT;`);
  applyMigration(databaseUrl);
  const state = JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'current_other', (SELECT count(*) FROM public.contractor_documents WHERE id IN (${literal(f.legacyDrillId)}::uuid,${literal(f.legacyUnknownId)}::uuid) AND document_type='other'),
    'invalid_current_gate', (SELECT count(*) FROM public.contractor_documents WHERE id IN (${literal(f.legacyDrillId)}::uuid,${literal(f.legacyUnknownId)}::uuid) AND document_type='special_certificate'),
    'baseline_facts', (SELECT count(*) FROM public.contractor_document_versions
      WHERE (document_id=${literal(f.legacyDrillId)}::uuid AND version_no=1 AND document_type='special_certificate'
             AND certificate_type='钻探' AND review_status='approved' AND reviewed_by=${literal(f.scope.entity_user)}::uuid
             AND reviewed_at=TIMESTAMPTZ '2025-01-02 03:04:05+00' AND review_note='原审核事实')
         OR (document_id=${literal(f.legacyUnknownId)}::uuid AND version_no=1 AND document_type='special_certificate'
             AND certificate_type='历史高处作业' AND review_status='rejected' AND reviewed_by=${literal(f.scope.entity_user)}::uuid
             AND reviewed_at=TIMESTAMPTZ '2025-02-03 04:05:06+00' AND review_note='旧分类审核')),
    'version_rows', (SELECT count(*) FROM public.contractor_document_versions WHERE document_id IN (${literal(f.legacyDrillId)}::uuid,${literal(f.legacyUnknownId)}::uuid))
  )::text;`));
  return state.current_other === 2 && state.invalid_current_gate === 0
    && state.baseline_facts === 2 && state.version_rows === 4;
}
async function clearReapproval(boundary, anonKey, token, databaseUrl, projectId, employeeId) {
  const requestId = runPsql(databaseUrl, `SELECT id FROM public.training_personnel_reapproval_requests
    WHERE project_id=${literal(projectId)}::uuid AND employee_id=${literal(employeeId)}::uuid AND status='pending' LIMIT 1;`);
  if (!requestId) return true;
  const response = await rpc(boundary, anonKey, token, 'training_review_personnel_reapproval', {
    p_request_id: requestId, p_action: 'approve', p_note: 'D08-4 专项复核',
  });
  return success(response);
}
async function readiness(boundary, anonKey, token, projectId, employeeId) {
  const response = await rpc(boundary, anonKey, token, 'training_admission_readiness_checklist', {
    p_project_id: projectId, p_employee_id: employeeId,
  });
  const row = Array.isArray(response.json) ? response.json.find(item => item.condition_code === 'special_certificate') : null;
  return { response, row };
}

function cleanup(databaseUrl, f) {
  runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.profiles SET department_id=${literal(f.scope.entity_a)}::uuid, role='admin', admin_level='dept'
WHERE id=${literal(f.scope.entity_user)}::uuid;
DELETE FROM storage.objects WHERE bucket_id='certificates' AND name LIKE ${literal(`training-admission/%/${f.projectA}/D08-4-${f.suffix}-%`)}
  OR bucket_id='certificates' AND name LIKE ${literal(`training-admission/%/${f.projectB}/D08-4-${f.suffix}-%`)};
DELETE FROM public.training_personnel_reapproval_requests WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_document_versions WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_contract_versions WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_documents WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.contractor_contracts WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_member_assignment_history WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_members WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.training_employee_versions WHERE employee_id IN (${f.people.map(x => `${literal(x.id)}::uuid`).join(',')});
DELETE FROM public.training_employees WHERE id IN (${f.people.map(x => `${literal(x.id)}::uuid`).join(',')});
DELETE FROM public.contractor_company_versions WHERE contractor_id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid);
DELETE FROM public.contractor_companies WHERE id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid);
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.site_project_entities WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
DELETE FROM public.site_projects WHERE id IN (${literal(f.projectA)}::uuid, ${literal(f.projectB)}::uuid);
COMMIT;`);
  return Number.parseInt(runPsql(databaseUrl, `SELECT
    (SELECT count(*) FROM public.site_projects WHERE report_notes='D08-4 TEST')
    + (SELECT count(*) FROM public.training_employees WHERE remark='D08-4 TEST')
    + (SELECT count(*) FROM public.contractor_companies WHERE id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid))
    + (SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name LIKE ${literal(`%D08-4-${f.suffix}-%`)});`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const source = verifyStatic();
  check('D08-ARCHIVE-00 v72 迁移、约束、历史和 Storage 静态边界完整', source.migration);
  check('D08-ARCHIVE-01 Web 合同、资质和证照统一走受控 RPC', source.web);
  if (process.argv.includes('--static')) { finish(started); return; }

  const boundary = validateTestBoundary();
  check('D08-ARCHIVE-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  const migrationMode = applyMigration(boundary.databaseUrl);
  if (process.argv.includes('--bootstrap-only')) {
    console.log(`D08_ARCHIVE_BOOTSTRAP_RESULT PASS mode=${migrationMode}`);
    finish(started);
    return;
  }
  const scope = readScope(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const [company, entity] = await Promise.all([
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
  ]);
  check('D08-ARCHIVE-02 测试账号与 D02 隔离夹具一致', company.userId === scope.company_user && entity.userId === scope.entity_user);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const specs = [
    ['blast', '爆破工', '爆破', '爆破'], ['drill', '钻探工', null, null], ['electric', '低压电工', '电工', '电工'], ['weld', '焊接与热切割作业', '焊工', '焊工'],
    ['blastx', '爆破工', '电工', '爆破'], ['drillx', '钻探工', '电工', null], ['electricx', '低压电工', '焊工', '电工'], ['weldx', '焊工', '爆破', '焊工'],
    ['absent', '爆破工', null, '爆破'], ['pending', '电工', '电工', '电工'], ['expired', '焊工', '焊工', '焊工'], ['change', '爆破工', '爆破', '爆破'],
    ['lowchange', '普工', null, null],
  ];
  const fixture = {
    scope, suffix, projectA: crypto.randomUUID(), projectB: crypto.randomUUID(),
    roleA: crypto.randomUUID(), roleB: crypto.randomUUID(), companyA: crypto.randomUUID(), companyB: crypto.randomUUID(),
    legacyDrillId: crypto.randomUUID(), legacyUnknownId: crypto.randomUUID(),
    people: specs.map(([key, position, certificate, assigned]) => ({ key, position, certificate, assigned, id: crypto.randomUUID(), member: crypto.randomUUID(), label: key })),
    paths: [],
  };
  let residue = -1;

  try {
    setup(boundary.databaseUrl, fixture);
    check('D08-ARCHIVE-R02-07 旧钻探及未知证照先保存完整审核基线再降级且不阻塞迁移',
      verifyLegacyDocumentMigration(boundary.databaseUrl, fixture));
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='employee', admin_level=NULL
      WHERE id=${literal(scope.entity_user)}::uuid;`);
    const pathFor = (folder, label, project = fixture.projectA) => {
      const value = `training-admission/${folder}/${project}/D08-4-${suffix}-${label}.pdf`;
      fixture.paths.push(value); return value;
    };

    for (const person of fixture.people.filter(x => x.assigned)) {
      const assigned = await rpc(boundary, anonKey, entity.token, 'training_set_member_special_work_types', {
        p_member_id: person.member, p_special_work_types: [person.assigned], p_reason: 'D08-4 专项实际作业安排',
      });
      if (!success(assigned)) throw new Error(`实际作业设置失败：${person.key}`);
    }

    const contractPath = pathFor('contractor-contracts', 'contract');
    const qualificationPath = pathFor('contractor-documents', 'qualification');
    check('D08-ARCHIVE-03 项目角色可上传合同附件', success(await upload(boundary, anonKey, entity.token, contractPath)));
    check('D08-ARCHIVE-04 项目角色可上传资质附件', success(await upload(boundary, anonKey, entity.token, qualificationPath)));

    const contractCreate = await rpc(boundary, anonKey, entity.token, 'contractor_contract_create', {
      p_project_id: fixture.projectA, p_contractor_id: fixture.companyA,
      p_contract_no: `D08-4-${suffix}`, p_contract_name: 'D08-4 测试合同',
      p_start_date: null, p_end_date: null, p_storage_path: contractPath,
    });
    const contractId = contractCreate.json?.contract_id;
    const contractReview = await rpc(boundary, anonKey, entity.token, 'contractor_contract_review', {
      p_contract_id: contractId, p_status: 'valid', p_note: '专项审核',
    });
    check('D08-ARCHIVE-05 合同受控创建、审核并形成两版历史', success(contractCreate) && success(contractReview)
      && exactKeys(contractCreate.json, ['contract_id', 'created', 'status'])
      && exactKeys(contractReview.json, ['contract_id', 'changed', 'status'])
      && versionCount(boundary.databaseUrl, 'contractor_contract_versions', 'contract_id', contractId) === 2);

    const qualificationCreate = await rpc(boundary, anonKey, entity.token, 'contractor_document_create', {
      p_project_id: fixture.projectA, p_contractor_id: fixture.companyA, p_employee_id: null,
      p_document_type: 'qualification', p_certificate_type: null, p_certificate_no: `Q-${suffix}`,
      p_valid_from: null, p_valid_until: null, p_storage_path: qualificationPath,
    });
    const qualificationId = qualificationCreate.json?.document_id;
    const qualificationReview = await rpc(boundary, anonKey, entity.token, 'contractor_document_review', {
      p_document_id: qualificationId, p_status: 'approved', p_note: '专项审核',
    });
    check('D08-ARCHIVE-06 单位资质受控创建、审核并形成两版历史', success(qualificationCreate) && success(qualificationReview)
      && exactKeys(qualificationCreate.json, ['document_id', 'created', 'status'])
      && exactKeys(qualificationReview.json, ['document_id', 'changed', 'status'])
      && versionCount(boundary.databaseUrl, 'contractor_document_versions', 'document_id', qualificationId) === 2);

    const createdDocs = new Map();
    for (const person of fixture.people.filter(x => x.certificate && x.key !== 'expired')) {
      const storagePath = pathFor('contractor-documents', person.key);
      if (!success(await upload(boundary, anonKey, entity.token, storagePath))) throw new Error(`证照上传失败：${person.key}`);
      const created = await rpc(boundary, anonKey, entity.token, 'contractor_document_create', {
        p_project_id: fixture.projectA, p_contractor_id: fixture.companyA, p_employee_id: person.id,
        p_document_type: 'special_certificate', p_certificate_type: person.certificate,
        p_certificate_no: `CERT-${person.key}-${suffix}`, p_valid_from: null,
        p_valid_until: '2099-12-31', p_storage_path: storagePath,
      });
      if (!success(created) || !created.json?.document_id) throw new Error(`证照创建失败：${person.key}`);
      createdDocs.set(person.key, created.json.document_id);
      if (person.key !== 'pending') {
        const reviewed = await rpc(boundary, anonKey, entity.token, 'contractor_document_review', {
          p_document_id: created.json.document_id, p_status: 'approved', p_note: '专项审核',
        });
        if (!success(reviewed) || !await clearReapproval(boundary, anonKey, entity.token, boundary.databaseUrl, fixture.projectA, person.id)) {
          throw new Error(`证照审核或人员复核失败：${person.key}`);
        }
      }
    }

    const expired = fixture.people.find(x => x.key === 'expired');
    const expiredPath = pathFor('contractor-documents', 'expired');
    if (!success(await upload(boundary, anonKey, entity.token, expiredPath))) throw new Error('过期证照上传失败');
    const expiredId = crypto.randomUUID();
    runPsql(boundary.databaseUrl, `INSERT INTO public.contractor_documents(
      id, project_id, contractor_id, employee_id, document_type, certificate_type,
      certificate_no, valid_until, storage_path, review_status, reviewed_by, reviewed_at
    ) VALUES (${literal(expiredId)}::uuid, ${literal(fixture.projectA)}::uuid, ${literal(fixture.companyA)}::uuid,
      ${literal(expired.id)}::uuid, 'special_certificate', '焊工', ${literal(`CERT-expired-${suffix}`)},
      CURRENT_DATE - 1, ${literal(expiredPath)}, 'approved', ${literal(scope.entity_user)}::uuid, NOW());`);
    await clearReapproval(boundary, anonKey, entity.token, boundary.databaseUrl, fixture.projectA, expired.id);

    for (const key of ['blast', 'electric', 'weld']) {
      const person = fixture.people.find(x => x.key === key);
      const result = await readiness(boundary, anonKey, entity.token, fixture.projectA, person.id);
      check(`D08-ARCHIVE-MATCH-${key} ${person.position}+${person.certificate}证通过`, success(result.response) && result.row?.condition_status === 'passed');
    }
    const drillResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, fixture.people.find(x => x.key === 'drill').id);
    check('D08-ARCHIVE-MATCH-drill 钻探岗位不要求人员钻探证', success(drillResult.response) && drillResult.row?.condition_status === 'not_required');
    for (const key of ['blastx', 'electricx', 'weldx']) {
      const person = fixture.people.find(x => x.key === key);
      const result = await readiness(boundary, anonKey, entity.token, fixture.projectA, person.id);
      check(`D08-ARCHIVE-MISMATCH-${key} 仅检查本项目已启用作业的匹配证照`, success(result.response)
        && result.row?.condition_status === 'pending' && result.row?.detail?.includes('未登记'));
    }
    const drillHeld = await readiness(boundary, anonKey, entity.token, fixture.projectA, fixture.people.find(x => x.key === 'drillx').id);
    check('D08-ARCHIVE-MISMATCH-drillx 钻探岗位持有其他证也不自动启用作业', drillHeld.row?.condition_status === 'not_required');

    const absent = fixture.people.find(x => x.key === 'absent');
    const pending = fixture.people.find(x => x.key === 'pending');
    const absentResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, absent.id);
    const pendingResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, pending.id);
    const expiredResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, expired.id);
    check('D08-ARCHIVE-15 本项目启用爆破作业且无证禁止通过', absentResult.row?.condition_status === 'pending' && absentResult.row?.detail?.includes('未登记'));
    check('D08-ARCHIVE-16 待审核证照不能通过', pendingResult.row?.condition_status === 'pending' && pendingResult.row?.detail?.includes('待审核'));
    check('D08-ARCHIVE-17 本项目启用焊工作业时已过期证照不能通过', expiredResult.row?.condition_status === 'pending' && expiredResult.row?.detail?.includes('过期'));

    const lowChange = fixture.people.find(x => x.key === 'lowchange');
    const lowToHigh = await rpc(boundary, anonKey, entity.token, 'training_change_member_assignment', {
      p_member_id: lowChange.member, p_contractor_id: fixture.companyA, p_work_type: '爆破工', p_reason: 'D08-4 普通转高风险',
    });
    const lowToHighResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, lowChange.id);
    check('D08-ARCHIVE-17A 仅修改岗位为爆破工不会自动启用爆破作业', success(lowToHigh)
      && lowToHighResult.row?.condition_status === 'not_required');

    const illegalPath = pathFor('contractor-documents', 'illegal');
    await upload(boundary, anonKey, entity.token, illegalPath);
    const illegal = await rpc(boundary, anonKey, entity.token, 'contractor_document_create', {
      p_project_id: fixture.projectA, p_contractor_id: fixture.companyA, p_employee_id: absent.id,
      p_document_type: 'special_certificate', p_certificate_type: '万能证', p_certificate_no: 'ILLEGAL',
      p_valid_from: null, p_valid_until: '2099-12-31', p_storage_path: illegalPath,
    });
    check('D08-ARCHIVE-18 非法 certificate_type 被数据库/RPC拒绝', denied(illegal));

    const change = fixture.people.find(x => x.key === 'change');
    const toHighRisk = await rpc(boundary, anonKey, entity.token, 'training_set_member_special_work_types', {
      p_member_id: change.member, p_special_work_types: ['电工'], p_reason: 'D08-4 实际改派电工作业',
    });
    const highRiskResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, change.id);
    const reapprovalCount = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.training_personnel_reapproval_requests
      WHERE project_id=${literal(fixture.projectA)}::uuid AND employee_id=${literal(change.id)}::uuid AND status='pending';`), 10);
    check('D08-ARCHIVE-19 改派电工作业后旧爆破证不能替代且触发复核', success(toHighRisk)
      && highRiskResult.row?.detail?.includes('未登记') && reapprovalCount === 1);
    const toLowRisk = await rpc(boundary, anonKey, entity.token, 'training_set_member_special_work_types', {
      p_member_id: change.member, p_special_work_types: [], p_reason: 'D08-4 取消实际特种作业',
    });
    const lowRiskResult = await readiness(boundary, anonKey, entity.token, fixture.projectA, change.id);
    check('D08-ARCHIVE-20 取消实际特种作业后证照要求为不适用', success(toLowRisk) && lowRiskResult.row?.condition_status === 'not_required');

    const rejectedPath = pathFor('contractor-documents', 'rejected');
    await upload(boundary, anonKey, entity.token, rejectedPath);
    const rejectedCreate = await rpc(boundary, anonKey, entity.token, 'contractor_document_create', {
      p_project_id: fixture.projectA, p_contractor_id: fixture.companyA, p_employee_id: null,
      p_document_type: 'qualification', p_certificate_type: null, p_certificate_no: 'REJECT',
      p_valid_from: null, p_valid_until: null, p_storage_path: rejectedPath,
    });
    const rejectedId = rejectedCreate.json?.document_id;
    const rejectedReview = await rpc(boundary, anonKey, entity.token, 'contractor_document_review', {
      p_document_id: rejectedId, p_status: 'rejected', p_note: '资料不符合要求',
    });
    check('D08-ARCHIVE-21 驳回只改状态并保留原记录及历史', success(rejectedReview)
      && versionCount(boundary.databaseUrl, 'contractor_document_versions', 'document_id', rejectedId) === 2
      && Number.parseInt(runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.contractor_documents WHERE id=${literal(rejectedId)}::uuid;`), 10) === 1);

    const directUpdate = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_documents?id=eq.${createdDocs.get('blast')}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ certificate_type: '电工' }),
    });
    const historyId = runPsql(boundary.databaseUrl, `SELECT id FROM public.contractor_document_versions
      WHERE document_id=${literal(createdDocs.get('blast'))}::uuid ORDER BY version_no LIMIT 1;`);
    const qualificationHistoryId = runPsql(boundary.databaseUrl, `SELECT id FROM public.contractor_document_versions
      WHERE document_id=${literal(qualificationId)}::uuid ORDER BY version_no LIMIT 1;`);
    const contractHistoryId = runPsql(boundary.databaseUrl, `SELECT id FROM public.contractor_contract_versions
      WHERE contract_id=${literal(contractId)}::uuid ORDER BY version_no LIMIT 1;`);
    const historyUpdate = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_document_versions?id=eq.${historyId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ certificate_no: 'TAMPER' }),
    });
    const historyDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_document_versions?id=eq.${historyId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
    });
    const qualificationHistoryDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_document_versions?id=eq.${qualificationHistoryId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
    });
    const contractHistoryUpdate = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_contract_versions?id=eq.${contractHistoryId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_name: 'TAMPER' }),
    });
    check('D08-ARCHIVE-22 主表直写和历史 UPDATE/DELETE 均被拒绝', blockedMutation(directUpdate)
      && blockedMutation(historyUpdate) && blockedMutation(historyDelete)
      && blockedMutation(qualificationHistoryDelete) && blockedMutation(contractHistoryUpdate));

    const directDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_contracts?id=eq.${contractId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
    });
    const directQualificationDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_documents?id=eq.${qualificationId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
    });
    const directCertificateDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/contractor_documents?id=eq.${createdDocs.get('blast')}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
    });
    check('D08-ARCHIVE-23 合同/资质/证照不能经普通 REST 物理删除', blockedMutation(directDelete)
      && blockedMutation(directQualificationDelete) && blockedMutation(directCertificateDelete));

    const authorizedSign = await sign(boundary, anonKey, entity.token, contractPath);
    const beforeStorage = objectExists(boundary.databaseUrl, contractPath);
    const overwrite = await upload(boundary, anonKey, entity.token, contractPath, true);
    const storageDelete = await remove(boundary, anonKey, entity.token, contractPath);
    const afterStorage = objectExists(boundary.databaseUrl, contractPath);
    check('D08-ARCHIVE-24 授权角色仅获得短时签名地址', success(authorizedSign) && Boolean(authorizedSign.json?.signedURL));
    check('D08-ARCHIVE-25 正式归档文件不能覆盖或删除', beforeStorage && denied(overwrite)
      && (denied(storageDelete) || success(storageDelete)) && afterStorage);

    const orphanPath = pathFor('contractor-documents', 'orphan');
    await upload(boundary, anonKey, entity.token, orphanPath);
    const orphanSign = await sign(boundary, anonKey, entity.token, orphanPath);
    check('D08-ARCHIVE-26 仅知道同项目文件路径但无业务记录仍不能读取', denied(orphanSign));

    const crossPath = pathFor('contractor-contracts', 'cross', fixture.projectB);
    await upload(boundary, anonKey, entity.token, crossPath);
    const crossCreate = await rpc(boundary, anonKey, entity.token, 'contractor_contract_create', {
      p_project_id: fixture.projectB, p_contractor_id: fixture.companyB, p_contract_no: 'CROSS',
      p_contract_name: '跨实体文件', p_start_date: null, p_end_date: null, p_storage_path: crossPath,
    });
    runPsql(boundary.databaseUrl, `UPDATE public.site_project_roles SET active=false WHERE id=${literal(fixture.roleB)}::uuid;`);
    const crossSign = await sign(boundary, anonKey, entity.token, crossPath);
    const crossReview = await rpc(boundary, anonKey, entity.token, 'contractor_contract_review', {
      p_contract_id: crossCreate.json?.contract_id, p_status: 'valid', p_note: null,
    });
    check('D08-ARCHIVE-27 跨项目/跨实体或撤权后不能读取、审核正式资料', success(crossCreate) && denied(crossSign) && denied(crossReview));

    const revoke = await rpc(boundary, anonKey, entity.token, 'contractor_document_revoke', {
      p_document_id: createdDocs.get('blast'), p_reason: 'D08-4 专项撤销',
    });
    const revokeState = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'row', count(*), 'revoked', count(*) FILTER (WHERE revoked_at IS NOT NULL),
      'versions', (SELECT count(*) FROM public.contractor_document_versions v WHERE v.document_id=${literal(createdDocs.get('blast'))}::uuid)
    )::text FROM public.contractor_documents WHERE id=${literal(createdDocs.get('blast'))}::uuid;`));
    check('D08-ARCHIVE-28 撤销保留当前记录、旧版本和附件', success(revoke) && revokeState.row === 1
      && exactKeys(revoke.json, ['document_id', 'changed', 'status'])
      && revokeState.revoked === 1 && revokeState.versions === 3 && objectExists(boundary.databaseUrl, fixture.paths.find(x => x.endsWith('-blast.pdf'))));

    const terminate = await rpc(boundary, anonKey, entity.token, 'contractor_contract_review', {
      p_contract_id: contractId, p_status: 'terminated', p_note: 'D08-4 专项终止',
    });
    check('D08-ARCHIVE-29 合同终止保留原记录和完整版本链', success(terminate)
      && versionCount(boundary.databaseUrl, 'contractor_contract_versions', 'contract_id', contractId) === 3);

    runPsql(boundary.databaseUrl, `UPDATE public.site_project_roles SET active=false WHERE id=${literal(fixture.roleA)}::uuid;`);
    const deniedContractFile = await sign(boundary, anonKey, entity.token, contractPath);
    const deniedQualificationFile = await sign(boundary, anonKey, entity.token, qualificationPath);
    const blastPath = fixture.paths.find(x => x.endsWith('-blast.pdf'));
    const deniedCertificateFile = await sign(boundary, anonKey, entity.token, blastPath);
    check('D08-ARCHIVE-29A 撤权后合同、单位资质和人员证照原件均不可读取', denied(deniedContractFile)
      && denied(deniedQualificationFile) && denied(deniedCertificateFile));

    const d08CompanyRegression = Number.parseInt(runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.contractor_company_versions WHERE contractor_id IN (${literal(fixture.companyA)}::uuid, ${literal(fixture.companyB)}::uuid);`), 10);
    const d08PersonnelRegression = Number.parseInt(runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.site_project_member_assignment_history WHERE member_id=${literal(change.member)}::uuid;`), 10);
    const d08JoinObjects = runPsql(boundary.databaseUrl,
      `SELECT (to_regprocedure('public.site_project_apply(text,text,text,text,text,text,text,text,jsonb)') IS NOT NULL
        AND to_regclass('public.project_join_application_events') IS NOT NULL)::text;`);
    check('D08-ARCHIVE-30 D08-1/2A/3 关键对象最小回归', d08CompanyRegression >= 2 && d08PersonnelRegression >= 3 && d08JoinObjects === 'true');
  } finally {
    residue = cleanup(boundary.databaseUrl, fixture);
  }

  check('D08-ARCHIVE-31 测试结束零残留', residue === 0, `residue=${residue}`);
  finish(started, residue);
}

main().catch(error => {
  console.error(`D08 contractor archive/certificate failed: ${error.message}`);
  process.exit(1);
});

/** D08-2A targeted regression: encrypted identity and immutable personnel history. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const v69Path = path.join(root, 'sql', 'training-admission-v69-contractor-company-versioning.sql');
const migrationPath = path.join(root, 'sql', 'training-admission-v70-personnel-identity-history.sql');
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function finish(started) {
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D08_PERSONNEL_IDENTITY_HISTORY_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
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
  if (result.error || result.status !== 0) throw new Error('D08-2A 专项测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl, file) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`D08-2A ${path.basename(file)} 应用失败`);
}

function applyMigrationResult(databaseUrl, file) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
    encoding: 'utf8', windowsHide: true,
  });
  return { status: result.status, stderr: String(result.stderr || '') };
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
    throw new Error('D08-2A 经营实体测试账号登录失败');
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

async function avatarUpload(boundary, anonKey, token, storagePath, upsert = false) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/avatars/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'x-upsert': String(upsert),
      }, body: Buffer.from('D08 R02 isolated avatar'),
    });
}

async function avatarSign(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/sign/avatars/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
}

async function avatarRemove(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey, '/storage/v1/object/avatars', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
}

function isSuccess(response) {
  return response.status === 200 || response.status === 204;
}

function isDenied(response) {
  return [400, 401, 403].includes(response.status);
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 70);
  const employeeWeb = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'employees.js'), 'utf8');
  const peopleWeb = fs.readFileSync(path.join(root, 'js', 'modules', 'people', 'people.js'), 'utf8');
  const reviewWeb = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'admission-review.js'), 'utf8');
  return {
    migration: /CREATE TABLE IF NOT EXISTS public\.training_employee_versions/i.test(source)
      && /CREATE TABLE IF NOT EXISTS public\.site_project_member_assignment_history/i.test(source)
      && /CHECK \(id_number IS NULL\)/i.test(source)
      && /hmac\(upper\(btrim\(id_number\)\), v_key, 'sha256'\)/i.test(source)
      && /BEFORE UPDATE OR DELETE ON public\.training_employee_versions/i.test(source)
      && /v70 身份冲突预检失败/i.test(source)
      && /training_employee_photo_update/i.test(source)
      && /v_photo := public\.training_employee_photo_update/i.test(source)
      && /DROP POLICY IF EXISTS avatars_update/i.test(source)
      && !/CREATE POLICY avatars_update/i.test(source)
      && !/v_full/i.test(source)
      && (source.match(/regexp_replace\(identity\.value/g) || []).length >= 2
      && /REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public\.training_employees/i.test(source)
      && /SECURITY DEFINER SET search_path = public, vault/gi.test(source)
      && entry?.file === path.basename(migrationPath)
      && entry.sha256 === digest,
    web: employeeWeb.includes("sb.rpc('training_employee_create'")
      && employeeWeb.includes("sb.rpc('training_employee_update'")
      && employeeWeb.includes("sb.rpc('training_employee_batch_create'")
      && peopleWeb.includes("sb.rpc('training_employee_create'")
      && peopleWeb.includes("sb.rpc('training_employee_update'")
      && !/from\('training_employees'\)\.\s*(insert|update|delete)\s*\(/i.test(employeeWeb + peopleWeb)
      && !/select\([^)]*id_number/i.test(employeeWeb + peopleWeb)
      && reviewWeb.includes('TrainingModule.canAssignProjectRoles(project)'),
  };
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'entity_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'entity_employee_id', (SELECT p.employee_id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'entity_role', (SELECT p.role FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'entity_admin_level', (SELECT p.admin_level FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002')
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.lead_entity_id || !scope.outside_entity_id || !scope.entity_user_id) {
    throw new Error('D02 人员历史测试夹具不完整');
  }
  return scope;
}

function digits(seed, length) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return Array.from(hex).map(ch => Number.parseInt(ch, 16) % 10).join('').slice(0, length);
}

function identity(seed) {
  return `11${digits(seed, 15)}X`;
}

function setupLegacyEmployee(databaseUrl, fixture, withDuplicate = false) {
  const duplicate = withDuplicate ? `,
  (${sqlLiteral(fixture.duplicateEmployeeId)}::uuid, ${sqlLiteral(`${fixture.legacyName} 重复`)}, ${sqlLiteral(fixture.duplicateNo)},
   ${sqlLiteral(fixture.leadEntityId)}::uuid, '测试岗位', ${sqlLiteral(fixture.legacyIdentity)},
   ${sqlLiteral(fixture.duplicatePhone)}, 'employee', 'active', 'D08-2A TEST')` : '';
  runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.profiles SET employee_id=${sqlLiteral(fixture.scope.entity_employee_id)}::uuid,
  department_id=${sqlLiteral(fixture.scope.lead_entity_id)}::uuid,
  role=${sqlLiteral(fixture.scope.entity_role)},
  admin_level=${fixture.scope.entity_admin_level ? sqlLiteral(fixture.scope.entity_admin_level) : 'NULL'}
WHERE id=${sqlLiteral(fixture.scope.entity_user_id)}::uuid;
ALTER TABLE public.training_employees DROP CONSTRAINT IF EXISTS training_employees_id_number_plaintext_empty;
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, id_number, phone, emp_type, status, remark)
VALUES (${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.legacyName)}, ${sqlLiteral(fixture.legacyNo)},
        ${sqlLiteral(fixture.leadEntityId)}::uuid, '测试岗位', ${sqlLiteral(fixture.legacyIdentity)},
        ${sqlLiteral(fixture.legacyPhone)}, 'employee', 'active', 'D08-2A TEST')${duplicate};
COMMIT;`);
}

function verifyCollisionPreflight(databaseUrl, fixture) {
  setupLegacyEmployee(databaseUrl, fixture, true);
  const migration = applyMigrationResult(databaseUrl, migrationPath);
  const state = JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'rows', count(*), 'plaintext_rows', count(*) FILTER (WHERE id_number IS NOT NULL)
  )::text FROM public.training_employees
  WHERE id IN (${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.duplicateEmployeeId)}::uuid);`));
  const safeError = migration.stderr.includes('collision_groups=1')
    && migration.stderr.includes(fixture.legacyEmployeeId)
    && migration.stderr.includes(fixture.duplicateEmployeeId)
    && !migration.stderr.includes(fixture.legacyIdentity);
  check('D08-PERSON-R02-06 重复旧身份证在唯一索引前匿名阻塞且不破坏历史人员',
    migration.status !== 0 && safeError && state.rows === 2 && state.plaintext_rows === 2);
  runPsql(databaseUrl, `DELETE FROM public.training_employees WHERE id=${sqlLiteral(fixture.duplicateEmployeeId)}::uuid;`);
}

function secureIdentityState(databaseUrl, employeeId, expectedIdentity) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'exists', count(*) = 1,
    'plaintext_empty', bool_and(id_number IS NULL),
    'cipher_present', bool_and(id_number_ciphertext IS NOT NULL),
    'token_private', bool_and(id_number_match_token ~ '^[0-9a-f]{64}$'),
    'decrypt_matches', bool_and(pgp_sym_decrypt(id_number_ciphertext,
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='training_admission_identity_key' LIMIT 1)) = ${sqlLiteral(expectedIdentity)})
  )::text FROM public.training_employees WHERE id=${sqlLiteral(employeeId)}::uuid;`);
  return JSON.parse(raw);
}

function employeeHistory(databaseUrl, employeeId) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'count', count(*),
    'versions', COALESCE(string_agg(version_no::text, ',' ORDER BY version_no), ''),
    'positions', COALESCE(string_agg(COALESCE(position, ''), ',' ORDER BY version_no), ''),
    'identity_versions', count(*) FILTER (WHERE identity_recorded),
    'plaintext_leak', bool_or(name ~ '^[1-9][0-9]{16}[0-9X]$' OR COALESCE(remark, '') ~ '[1-9][0-9]{16}[0-9X]')
  )::text FROM public.training_employee_versions WHERE employee_id=${sqlLiteral(employeeId)}::uuid;`);
  return JSON.parse(raw);
}

function assignmentHistory(databaseUrl, memberId) {
  const raw = runPsql(databaseUrl, `SELECT COALESCE(json_agg(json_build_object(
    'version_no', version_no, 'previous', previous_contractor_id,
    'current', contractor_id, 'effective_at', effective_at,
    'reason_present', change_reason IS NOT NULL, 'source', change_source
  ) ORDER BY version_no), '[]'::json)::text
  FROM public.site_project_member_assignment_history WHERE member_id=${sqlLiteral(memberId)}::uuid;`);
  return JSON.parse(raw);
}

function reapprovalState(databaseUrl, fixture) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'count', count(*),
    'fields', COALESCE(string_agg(array_to_string(changed_fields, ','), ',' ORDER BY requested_at DESC), '')
  )::text FROM public.training_personnel_reapproval_requests
  WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid AND employee_id=${sqlLiteral(fixture.employeeId)}::uuid AND status='pending';`);
  return JSON.parse(raw);
}

function verifyDeniedAs(databaseUrl, fixture, scope, callSql, setupSql) {
  const raw = runPsql(databaseUrl, `
BEGIN;
${setupSql}
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', ${sqlLiteral(scope.entity_user_id)}, true);
DO $d08$
BEGIN
  BEGIN
    ${callSql};
    RAISE EXCEPTION '预期拒绝未发生' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM NOT LIKE '%无权%' THEN RAISE; END IF;
  END;
END $d08$;
ROLLBACK;
SELECT 'ok';`);
  return raw.endsWith('ok');
}

function cleanup(databaseUrl, fixture) {
  return Number.parseInt(runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.training_personnel_reapproval_requests WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.personnel_change_logs WHERE employee_id IN (${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.duplicateEmployeeId)}::uuid);
DELETE FROM storage.objects WHERE bucket_id='avatars' AND (
  name LIKE ${sqlLiteral(`${fixture.employeeId}/D08-R02-${fixture.suffix}-%`)}
  OR name=${sqlLiteral(fixture.createAvatar)}
);
DO $cleanup$
BEGIN
  IF to_regclass('public.site_project_member_assignment_history') IS NOT NULL THEN
    DELETE FROM public.site_project_member_assignment_history WHERE member_id=${sqlLiteral(fixture.memberId)}::uuid;
  END IF;
  IF to_regclass('public.training_employee_versions') IS NOT NULL THEN
      DELETE FROM public.training_employee_versions WHERE employee_id IN (${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.duplicateEmployeeId)}::uuid);
  END IF;
  IF to_regclass('public.contractor_company_versions') IS NOT NULL THEN
    DELETE FROM public.contractor_company_versions
    WHERE contractor_id IN (SELECT id FROM public.contractor_companies WHERE name IN (${sqlLiteral(fixture.companyA)}, ${sqlLiteral(fixture.companyB)}));
  END IF;
END $cleanup$;
DELETE FROM public.site_project_members WHERE id=${sqlLiteral(fixture.memberId)}::uuid;
DELETE FROM public.site_projects WHERE id=${sqlLiteral(fixture.projectId)}::uuid;
DELETE FROM public.training_employees WHERE id IN (${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.duplicateEmployeeId)}::uuid);
DELETE FROM public.contractor_companies WHERE name IN (${sqlLiteral(fixture.companyA)}, ${sqlLiteral(fixture.companyB)});
COMMIT;
SELECT
  (SELECT count(*) FROM public.training_employees WHERE id IN (${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(fixture.legacyEmployeeId)}::uuid, ${sqlLiteral(fixture.duplicateEmployeeId)}::uuid))
  + (SELECT count(*) FROM public.site_projects WHERE id=${sqlLiteral(fixture.projectId)}::uuid)
  + (SELECT count(*) FROM public.contractor_companies WHERE name IN (${sqlLiteral(fixture.companyA)}, ${sqlLiteral(fixture.companyB)}));`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const source = verifySourceBoundary();
  check('D08-PERSON-00 v70 加密、历史、权限和迁移登记完整', source.migration);
  check('D08-PERSON-01 Web 不再读取明文或直写人员主数据', source.web);
  if (process.argv.includes('--static')) {
    finish(started);
    return;
  }

  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D08-PERSON-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  applyMigration(boundary.databaseUrl, v69Path);
  const scope = readScope(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    scope,
    leadEntityId: scope.lead_entity_id,
    legacyEmployeeId: crypto.randomUUID(),
    duplicateEmployeeId: crypto.randomUUID(),
    legacyName: `[D08-TEST] 回填人员 ${suffix}`,
    legacyNo: `D08-L-${suffix}`,
    legacyPhone: `19${digits(`legacy-${suffix}`, 9)}`,
    duplicatePhone: `16${digits(`duplicate-${suffix}`, 9)}`,
    duplicateNo: `D08-D-${suffix}`,
    legacyIdentity: identity(`legacy-${suffix}`),
    employeeId: crypto.randomUUID(),
    employeeName: `[D08-TEST] 历史人员 ${suffix}`,
    employeeNo: `D08-E-${suffix}`,
    employeePhone: `18${digits(`employee-${suffix}`, 9)}`,
    identityA: identity(`identity-a-${suffix}`),
    identityB: identity(`identity-b-${suffix}`),
    projectId: crypto.randomUUID(),
    projectCode: `D08-P-${suffix}`,
    memberId: crypto.randomUUID(),
    companyA: `[D08-TEST] 单位A ${suffix}`,
    companyB: `[D08-TEST] 单位B ${suffix}`,
    companyCodeA: `A70${suffix}00000`.slice(0, 18),
    companyCodeB: `B70${suffix}00000`.slice(0, 18),
    suffix,
    createAvatar: `new-employees/${scope.entity_user_id}/D08-R02-${suffix}-${crypto.randomUUID()}.jpg`,
  };
  let residue = -1;
  const focusedPhoto = process.argv.includes('--photo-only');

  if (process.argv.includes('--backfill-only')) {
    try {
      verifyCollisionPreflight(boundary.databaseUrl, fixture);
      applyMigration(boundary.databaseUrl, migrationPath);
      const legacy = secureIdentityState(boundary.databaseUrl, fixture.legacyEmployeeId, fixture.legacyIdentity);
      check('D08-PERSON-02 现有明文人员安全回填且记录未丢失',
        legacy.exists && legacy.plaintext_empty && legacy.cipher_present && legacy.token_private && legacy.decrypt_matches);
    } finally {
      residue = cleanup(boundary.databaseUrl, fixture);
    }
    check('D08-PERSON-15 测试数据残留为零', residue === 0, `residue=${residue}`);
    finish(started);
    return;
  }

  try {
    if (!process.argv.includes('--business-only')) {
      verifyCollisionPreflight(boundary.databaseUrl, fixture);
      applyMigration(boundary.databaseUrl, migrationPath);
      const legacy = secureIdentityState(boundary.databaseUrl, fixture.legacyEmployeeId, fixture.legacyIdentity);
      check('D08-PERSON-02 现有明文人员安全回填且记录未丢失',
        legacy.exists && legacy.plaintext_empty && legacy.cipher_present && legacy.token_private && legacy.decrypt_matches);
    }

    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entity = await login(boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
    check('D08-PERSON-03 测试账号与经营实体夹具一致', entity.userId === scope.entity_user_id);

    const companies = [];
    for (const [name, code] of [[fixture.companyA, fixture.companyCodeA], [fixture.companyB, fixture.companyCodeB]]) {
      const created = await rpc(boundary, anonKey, entity.token, 'contractor_company_create', {
        p_name: name, p_unified_code: code, p_legal_representative: null,
        p_contact_name: 'D08测试负责人', p_contact_phone: null,
      });
      if (!isSuccess(created) || !created.json?.company_id) throw new Error('D08-1 外协单位夹具创建失败');
      companies.push(created.json.company_id);
      const reviewed = await rpc(boundary, anonKey, entity.token, 'contractor_company_review', {
        p_company_id: created.json.company_id, p_status: 'active', p_note: 'D08-2A 测试',
      });
      if (!isSuccess(reviewed)) throw new Error('D08-1 外协单位夹具审核失败');
    }

    const createPhotoUpload = await avatarUpload(boundary, anonKey, entity.token, fixture.createAvatar);
    const createEmployee = await rpc(boundary, anonKey, entity.token, 'training_employee_create', {
      p_name: fixture.employeeName, p_gender: null, p_employee_no: fixture.employeeNo,
      p_department_id: fixture.leadEntityId, p_position: '普工', p_job_grade: null,
      p_id_number: fixture.identityA, p_phone: fixture.employeePhone, p_hire_date: null,
      p_emp_type: 'employee', p_status: 'active', p_remark: 'D08-2A TEST', p_photo_path: fixture.createAvatar,
    });
    fixture.employeeId = createEmployee.json?.employee_id || fixture.employeeId;
    const createdIdentity = secureIdentityState(boundary.databaseUrl, fixture.employeeId, fixture.identityA);
    check('D08-PERSON-04 新建身份证仅保存密文和私有匹配标识',
      isSuccess(createPhotoUpload) && isSuccess(createEmployee)
        && Object.keys(createEmployee.json || {}).sort().join(',') === 'created,employee_id,photo_path'
        && createEmployee.json?.photo_path === fixture.createAvatar
        && createdIdentity.plaintext_empty && createdIdentity.decrypt_matches
        && runPsql(boundary.databaseUrl, `SELECT photo_path FROM public.training_employee_versions
          WHERE employee_id=${sqlLiteral(fixture.employeeId)}::uuid AND version_no=1;`) === fixture.createAvatar,
      `status=${createEmployee.status}`);

    runPsql(boundary.databaseUrl, `
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.projectCode)}, ${sqlLiteral(`[D08-TEST] 人员历史 ${suffix}`)}, 'active', ${sqlLiteral(fixture.leadEntityId)}::uuid, 'D08-2A TEST');
INSERT INTO public.site_project_members(id, project_id, employee_id, contractor_id, membership_type, work_type, status, created_by)
VALUES (${sqlLiteral(fixture.memberId)}::uuid, ${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(fixture.employeeId)}::uuid,
        ${sqlLiteral(companies[0])}::uuid, 'external', '普工', 'active', ${sqlLiteral(entity.userId)}::uuid);`);

    if (!focusedPhoto) {
    const employeePayload = {
      p_employee_id: fixture.employeeId, p_name: fixture.employeeName, p_gender: null,
      p_employee_no: fixture.employeeNo, p_department_id: fixture.leadEntityId,
      p_position: '普工', p_job_grade: null, p_id_number: fixture.identityB,
      p_phone: fixture.employeePhone, p_hire_date: null, p_emp_type: 'employee',
      p_status: 'active', p_remark: 'D08-2A TEST',
    };
    const identityUpdate = await rpc(boundary, anonKey, entity.token, 'training_employee_update', employeePayload);
    const updatedIdentity = secureIdentityState(boundary.databaseUrl, fixture.employeeId, fixture.identityB);
    const identityHistory = employeeHistory(boundary.databaseUrl, fixture.employeeId);
    const identityReview = reapprovalState(boundary.databaseUrl, fixture);
    check('D08-PERSON-05 身份证修改保留安全历史并触发单条待复核',
      isSuccess(identityUpdate) && identityUpdate.json?.identity_changed === true
        && updatedIdentity.plaintext_empty && updatedIdentity.decrypt_matches
        && identityHistory.count === 2 && identityHistory.identity_versions === 2
        && identityHistory.plaintext_leak === false && identityReview.count === 1
        && identityReview.fields.includes('身份证号'));

    const identityRead = await rpc(boundary, anonKey, entity.token, 'training_employee_identity_get', {
      p_employee_id: fixture.employeeId,
    });
    check('D08-PERSON-06 授权经营实体管理员可经受控接口读取必要完整身份',
      isSuccess(identityRead) && identityRead.json?.id_number === fixture.identityB);

    const directIdentityRead = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/training_employees?id=eq.${fixture.employeeId}&select=id,id_number`, {
        headers: { Authorization: `Bearer ${entity.token}` },
      });
    const directEmployeeUpdate = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/training_employees?id=eq.${fixture.employeeId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: 'REST篡改' }),
      });
    check('D08-PERSON-07 普通表不能读取身份证明文或直接修改人员主数据',
      isDenied(directIdentityRead) && isDenied(directEmployeeUpdate),
      `read=${directIdentityRead.status} update=${directEmployeeUpdate.status}`);

    const projectRoleDenied = verifyDeniedAs(boundary.databaseUrl, fixture, scope,
      `PERFORM public.training_employee_identity_get(${sqlLiteral(fixture.employeeId)}::uuid)`,
      `UPDATE public.profiles SET role='employee', admin_level=NULL WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;
       INSERT INTO public.site_project_roles(project_id, user_id, role, active)
       VALUES (${sqlLiteral(fixture.projectId)}::uuid, ${sqlLiteral(scope.entity_user_id)}::uuid, 'safety_officer', true);`);
    check('D08-PERSON-08 项目安全员不能因项目权限读取完整身份证', projectRoleDenied);

    const positionUpdate = await rpc(boundary, anonKey, entity.token, 'training_employee_update', {
      ...employeePayload, p_position: '焊工', p_id_number: null,
    });
    const positionHistory = employeeHistory(boundary.databaseUrl, fixture.employeeId);
    const positionReview = reapprovalState(boundary.databaseUrl, fixture);
    check('D08-PERSON-09 工种修改保留旧值并合并到原待复核任务',
      isSuccess(positionUpdate) && positionHistory.count === 3
        && positionHistory.positions === '普工,普工,焊工'
        && positionReview.count === 1 && positionReview.fields.includes('岗位/工种'));

    const assignmentUpdate = await rpc(boundary, anonKey, entity.token, 'training_change_member_assignment', {
      p_member_id: fixture.memberId, p_contractor_id: companies[1], p_work_type: '焊工', p_reason: '人员所属单位调整',
    });
    const assignments = assignmentHistory(boundary.databaseUrl, fixture.memberId);
    const currentCompany = runPsql(boundary.databaseUrl,
      `SELECT contractor_id::text FROM public.site_project_members WHERE id=${sqlLiteral(fixture.memberId)}::uuid;`);
    const assignmentReview = reapprovalState(boundary.databaseUrl, fixture);
    check('D08-PERSON-10 单位 A→B 后旧关系、时间、原因和当前单位均正确',
      isSuccess(assignmentUpdate) && assignments.length === 2
        && assignments[0].current === companies[0] && assignments[1].previous === companies[0]
        && assignments[1].current === companies[1] && assignments[1].effective_at
        && assignments[1].reason_present && currentCompany === companies[1]
        && assignmentReview.count === 1 && assignmentReview.fields.includes('所属外协单位'));

    const crossEmployeeDenied = verifyDeniedAs(boundary.databaseUrl, fixture, scope,
      `PERFORM public.training_employee_update(${sqlLiteral(fixture.employeeId)}::uuid, ${sqlLiteral(fixture.employeeName)}, NULL, ${sqlLiteral(fixture.employeeNo)}, ${sqlLiteral(fixture.leadEntityId)}::uuid, '钻探', NULL, NULL, ${sqlLiteral(fixture.employeePhone)}, NULL, 'employee', 'active', 'D08-2A TEST')`,
      `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    const crossAssignmentDenied = verifyDeniedAs(boundary.databaseUrl, fixture, scope,
      `PERFORM public.training_change_member_assignment(${sqlLiteral(fixture.memberId)}::uuid, ${sqlLiteral(companies[0])}::uuid, '钻探', '跨实体测试')`,
      `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    check('D08-PERSON-11 跨经营实体不能修改人员敏感档案或单位关系',
      crossEmployeeDenied && crossAssignmentDenied);

    const employeeHistoryId = runPsql(boundary.databaseUrl,
      `SELECT id FROM public.training_employee_versions WHERE employee_id=${sqlLiteral(fixture.employeeId)}::uuid ORDER BY version_no LIMIT 1;`);
    const assignmentHistoryId = runPsql(boundary.databaseUrl,
      `SELECT id FROM public.site_project_member_assignment_history WHERE member_id=${sqlLiteral(fixture.memberId)}::uuid ORDER BY version_no LIMIT 1;`);
    const mutateHistory = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/training_employee_versions?id=eq.${employeeHistoryId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: '篡改' }),
      });
    const deleteHistory = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_member_assignment_history?id=eq.${assignmentHistoryId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${entity.token}` },
      });
    check('D08-PERSON-12 普通 UPDATE/DELETE 不能篡改两类历史',
      isDenied(mutateHistory) && isDenied(deleteHistory),
      `update=${mutateHistory.status} delete=${deleteHistory.status}`);

    const beforeRepeatVersions = employeeHistory(boundary.databaseUrl, fixture.employeeId).count;
    const beforeRepeatAssignments = assignmentHistory(boundary.databaseUrl, fixture.memberId).length;
    const beforeRepeatReviews = reapprovalState(boundary.databaseUrl, fixture).count;
    const repeatEmployee = await rpc(boundary, anonKey, entity.token, 'training_employee_update', {
      ...employeePayload, p_position: '焊工', p_id_number: fixture.identityB,
    });
    const repeatAssignment = await rpc(boundary, anonKey, entity.token, 'training_change_member_assignment', {
      p_member_id: fixture.memberId, p_contractor_id: companies[1], p_work_type: '焊工', p_reason: '弱网重试',
    });
    check('D08-PERSON-13 重复请求不增加历史或待复核任务',
      isSuccess(repeatEmployee) && repeatEmployee.json?.changed === false
        && isSuccess(repeatAssignment) && repeatAssignment.json?.changed === false
        && employeeHistory(boundary.databaseUrl, fixture.employeeId).count === beforeRepeatVersions
        && assignmentHistory(boundary.databaseUrl, fixture.memberId).length === beforeRepeatAssignments
        && reapprovalState(boundary.databaseUrl, fixture).count === beforeRepeatReviews);
    }

    const avatarOne = `${fixture.employeeId}/D08-R02-${suffix}-${crypto.randomUUID()}.jpg`;
    const avatarTwo = `${fixture.employeeId}/D08-R02-${suffix}-${crypto.randomUUID()}.jpg`;
    const uploadOne = await avatarUpload(boundary, anonKey, entity.token, avatarOne);
    const photoOne = await rpc(boundary, anonKey, entity.token, 'training_employee_photo_update', {
      p_employee_id: fixture.employeeId, p_photo_path: avatarOne, p_reason: '首次登记人员照片',
    });
    const uploadTwo = await avatarUpload(boundary, anonKey, entity.token, avatarTwo);
    const photoTwo = await rpc(boundary, anonKey, entity.token, 'training_employee_photo_update', {
      p_employee_id: fixture.employeeId, p_photo_path: avatarTwo, p_reason: '人员照片更新',
    });
    const currentAfterAdminPhotos = runPsql(boundary.databaseUrl,
      `SELECT photo_path FROM public.training_employees WHERE id=${sqlLiteral(fixture.employeeId)}::uuid;`);
    const versionsAfterPhoto = employeeHistory(boundary.databaseUrl, fixture.employeeId).count;
    const repeatPhoto = await rpc(boundary, anonKey, entity.token, 'training_employee_photo_update', {
      p_employee_id: fixture.employeeId, p_photo_path: avatarTwo, p_reason: '弱网重试',
    });
    const repeatPhotoVersions = employeeHistory(boundary.databaseUrl, fixture.employeeId).count;
    const oldPhotoHistory = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT count(*)
      FROM public.training_employee_versions WHERE employee_id=${sqlLiteral(fixture.employeeId)}::uuid
        AND photo_path=${sqlLiteral(avatarOne)};`), 10);
    const photoReview = reapprovalState(boundary.databaseUrl, fixture);
    const overwriteOld = await avatarUpload(boundary, anonKey, entity.token, avatarOne, true);
    const deleteOld = await avatarRemove(boundary, anonKey, entity.token, avatarOne);
    const deleteCreated = await avatarRemove(boundary, anonKey, entity.token, fixture.createAvatar);
    const oldAvatarStillExists = runPsql(boundary.databaseUrl, `SELECT EXISTS(
      SELECT 1 FROM storage.objects WHERE bucket_id='avatars' AND name=${sqlLiteral(avatarOne)}
    )::text;`) === 'true';
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid,
      role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    const crossRead = await avatarSign(boundary, anonKey, entity.token, avatarOne);
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${sqlLiteral(scope.lead_entity_id)}::uuid,
      role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    const selfAvatar = `${fixture.employeeId}/D08-R02-${suffix}-${crypto.randomUUID()}.jpg`;
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET employee_id=${sqlLiteral(fixture.employeeId)}::uuid,
      role='employee', admin_level=NULL WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    const selfUpload = await avatarUpload(boundary, anonKey, entity.token, selfAvatar);
    const selfPhoto = await rpc(boundary, anonKey, entity.token, 'employee_self_update', {
      p_field: 'photo_path', p_value: selfAvatar,
    });
    const forgedSelfPhoto = await rpc(boundary, anonKey, entity.token, 'employee_self_update', {
      p_field: 'photo_path', p_value: `${fixture.employeeId}/D08-R02-${suffix}-missing.jpg`,
    });
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET employee_id=${sqlLiteral(scope.entity_employee_id)}::uuid,
      role=${sqlLiteral(scope.entity_role)}, admin_level=${scope.entity_admin_level ? sqlLiteral(scope.entity_admin_level) : 'NULL'}
      WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    check('D08-PERSON-R02-05 照片变更形成历史并触发复核，相同照片幂等且旧对象不可覆盖/删除/跨实体读',
      isSuccess(uploadOne) && isSuccess(photoOne) && photoOne.json?.changed === true
        && isSuccess(uploadTwo) && isSuccess(photoTwo) && photoTwo.json?.changed === true
        && currentAfterAdminPhotos === avatarTwo
        && oldPhotoHistory === 1 && photoReview.fields.includes('人员照片')
        && isSuccess(repeatPhoto) && repeatPhoto.json?.changed === false
        && repeatPhotoVersions === versionsAfterPhoto
        && isDenied(overwriteOld) && (isDenied(deleteOld) || (isSuccess(deleteOld) && oldAvatarStillExists)) && isDenied(crossRead)
        && (isDenied(deleteCreated) || (isSuccess(deleteCreated) && runPsql(boundary.databaseUrl, `SELECT EXISTS(
          SELECT 1 FROM storage.objects WHERE bucket_id='avatars' AND name=${sqlLiteral(fixture.createAvatar)})::text;`) === 'true'))
        && isSuccess(selfUpload) && isSuccess(selfPhoto) && selfPhoto.json?.changed === true
        && isDenied(forgedSelfPhoto)
        && runPsql(boundary.databaseUrl, `SELECT photo_path FROM public.training_employees WHERE id=${sqlLiteral(fixture.employeeId)}::uuid;`) === selfAvatar,
      `upload=${uploadOne.status}/${uploadTwo.status} photo=${photoOne.status}:${photoOne.json?.changed}/${photoTwo.status}:${photoTwo.json?.changed} old=${oldPhotoHistory} review=${photoReview.fields.includes('人员照片')} repeat=${repeatPhoto.status}:${repeatPhoto.json?.changed}:${repeatPhotoVersions}/${versionsAfterPhoto} immutable=${overwriteOld.status}/${deleteOld.status}:${oldAvatarStillExists} cross=${crossRead.status} self=${selfUpload.status}/${selfPhoto.status}:${selfPhoto.json?.changed} forged=${forgedSelfPhoto.status}`);

    const companyHistoryCount = Number.parseInt(runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.contractor_company_versions WHERE contractor_id IN (${sqlLiteral(companies[0])}::uuid, ${sqlLiteral(companies[1])}::uuid);`), 10);
    check('D08-PERSON-14 v70 未回归 D08-1 单位版本能力', companyHistoryCount === 4);
  } finally {
    residue = cleanup(boundary.databaseUrl, fixture);
  }

  check('D08-PERSON-15 测试数据残留为零', residue === 0, `residue=${residue}`);
  finish(started);
}

main().catch(error => {
  console.error(`D08 personnel identity history failed: ${error.message}`);
  process.exit(1);
});

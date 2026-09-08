/** D08-3 targeted regression: authoritative join state machine and DB idempotency. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v71-project-join-state-machine.sql');
const archiveMigrationPath = path.join(root, 'sql', 'training-admission-v72-contractor-archive-and-certificate-compliance.sql');
const memberBoundaryMigrationPath = path.join(root, 'sql', 'training-admission-v73-project-member-insert-boundary.sql');
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function finish(started) {
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D08_JOIN_STATE_MACHINE_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function digits(seed, length) {
  return Array.from(crypto.createHash('sha256').update(seed).digest('hex'))
    .map(ch => Number.parseInt(ch, 16) % 10).join('').slice(0, length);
}
function identity(seed) { return `11${digits(seed, 15)}X`; }

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]')
      .replace(/[1-9][0-9]{16}[0-9X]/g, '[identity-redacted]')
      .trim().split(/\r?\n/).slice(-2).join(' ');
    throw new Error(`D08-3 专项测试库操作失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function runPsqlAsync(databaseUrl, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', () => reject(new Error('D08-3 并发数据库会话启动失败')));
    child.on('close', code => code === 0
      ? resolve(stdout.trim())
      : reject(new Error('D08-3 并发数据库操作失败')));
    child.stdin.end(sql);
  });
}

function applyMigration(databaseUrl) {
  for (const file of [migrationPath, archiveMigrationPath, memberBoundaryMigrationPath]) {
    const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`D08-3 ${path.basename(file)} 测试迁移应用失败`);
  }
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
    throw new Error('D08-3 隔离测试账号登录失败');
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

async function insertProjectMember(boundary, anonKey, token, body) {
  return request(boundary.apiOrigin, anonKey, '/rest/v1/site_project_members', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
}

async function uploadJoinPhoto(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'false',
      }, body: Buffer.from('D08 R02 isolated join photo'),
    });
}

async function signJoinPhoto(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/sign/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
}

function success(response) { return response.status >= 200 && response.status < 300; }
function denied(response) { return [400, 401, 403, 404].includes(response.status); }
function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function verifyStatic() {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const archiveSql = fs.readFileSync(archiveMigrationPath, 'utf8').replace(/\r\n/g, '\n');
  const memberBoundarySql = fs.readFileSync(memberBoundaryMigrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hash = crypto.createHash('sha256').update(sql).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 71);
  const mine = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'admission-mine.js'), 'utf8');
  const review = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'admission-review.js'), 'utf8');
  const contractors = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'contractors.js'), 'utf8');
  const reports = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'admission-reports.js'), 'utf8');
  return {
    migration: entry?.file === path.basename(migrationPath) && entry.sha256 === hash
      && /uq_project_join_active_identity/i.test(sql)
      && /uq_project_join_active_applicant/i.test(sql)
      && /CREATE TABLE IF NOT EXISTS public\.project_join_application_events/i.test(sql)
      && /BEFORE UPDATE OR DELETE ON public\.project_join_application_events/i.test(sql)
      && /WHERE e\.id_number_match_token = v_token/i.test(sql)
      && !/WHERE name = v_app\.name AND phone = v_app\.phone/i.test(sql)
      && /FOR UPDATE/i.test(sql)
      && /pg_advisory_xact_lock/i.test(sql)
      && /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.project_join_applications/i.test(sql)
      && /SECURITY DEFINER SET search_path = public, vault, extensions/i.test(sql)
      && /REVOKE ALL ON FUNCTION public\.training_batch_add_contractor_members\(UUID, UUID, JSONB\)[\s\S]*FROM PUBLIC, anon, authenticated/i.test(sql)
      && /site_project_join_file_can_bind/i.test(archiveSql)
      && /o\.owner_id = auth\.uid\(\)::TEXT/i.test(archiveSql)
      && /REVOKE INSERT ON TABLE public\.site_project_members FROM anon, authenticated/i.test(memberBoundarySql),
    web: mine.includes('review_path') && mine.includes('this.state.submitting')
      && review.includes('review_path') && review.includes('target_entity_id')
      && review.includes('审核路径由服务端')
      && !contractors.includes("training_batch_add_contractor_members")
      && reports.includes("{ key: 'id_number', label: '身份证号' }")
      && !reports.includes('training_employee_identity_get'),
  };
}

function readScope(databaseUrl) {
  const value = runPsql(databaseUrl, `SELECT json_build_object(
    'entity_a', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'entity_b', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'company_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'),
    'company_employee', (SELECT p.employee_id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'),
    'entity_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'ordinary_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-004')
    ,'company_role', (SELECT role FROM public.profiles WHERE id=(SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'))
    ,'company_admin_level', (SELECT admin_level FROM public.profiles WHERE id=(SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'))
  )::text;`);
  const scope = JSON.parse(value);
  if (!scope.entity_a || !scope.entity_b || !scope.company_user || !scope.company_employee || !scope.entity_user || !scope.ordinary_user) {
    throw new Error('D08-3 D02 夹具范围不完整');
  }
  return scope;
}

function clearBypassMember(databaseUrl, f) {
  runPsql(databaseUrl, `BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.site_project_member_assignment_history WHERE project_id=${literal(f.projects.bypass.id)}::uuid;
DELETE FROM public.site_project_members WHERE project_id=${literal(f.projects.bypass.id)}::uuid;
COMMIT;`);
}

function setup(databaseUrl, f) {
  const projectRows = Object.values(f.projects).map(p =>
    `(${literal(p.id)}::uuid, ${literal(p.code)}, ${literal(`[D08-TEST] ${p.code}`)}, ${literal(p.status)}, ${literal(p.entity)}::uuid, 'D08-3 TEST')`).join(',\n');
  const inviteRows = Object.values(f.projects).map(p =>
    `(${literal(crypto.randomUUID())}::uuid, ${literal(p.id)}::uuid, ${literal(digest(p.token))}, ${p.expired ? "NOW() - INTERVAL '1 hour'" : "NOW() + INTERVAL '1 day'"}, ${p.revoked ? 'NOW()' : 'NULL'}, ${literal(f.scope.entity_user)}::uuid)`).join(',\n');
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes) VALUES ${projectRows};
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
SELECT id, lead_entity_id, true FROM public.site_projects WHERE report_notes='D08-3 TEST';
INSERT INTO public.site_project_invites(id, project_id, token_hash, expires_at, revoked_at, created_by) VALUES ${inviteRows};
INSERT INTO public.contractor_companies(id, name, unified_code, managing_entity_id, status, created_by)
VALUES
  (${literal(f.companyA)}::uuid, ${literal(`[D08-TEST] 单位A ${f.suffix}`)}, ${literal(f.codeA)}, ${literal(f.scope.entity_a)}::uuid, 'active', ${literal(f.scope.entity_user)}::uuid),
  (${literal(f.companyB)}::uuid, ${literal(`[D08-TEST] 单位B ${f.suffix}`)}, ${literal(f.codeB)}, ${literal(f.scope.entity_b)}::uuid, 'active', ${literal(f.scope.entity_user)}::uuid);
COMMIT;`);
}

function photoPath(project, f, userId, identityValue, label = 'photo') {
  return `training-admission/join-applications/${project.id}/${userId}/${digest(project.token)}/${label}-${digest(identityValue).slice(0, 12)}-${f.suffix}.jpg`;
}

function applyPayload(project, f, identityValue, companyId, userId = f.applicantUserId, label = 'photo') {
  const companyA = companyId === f.companyA;
  return {
    p_token: project.token,
    p_name: companyA ? `[D08-TEST] 申请人A ${f.suffix}` : `[D08-TEST] 申请人B ${f.suffix}`,
    p_phone: `18${digits(`phone-${identityValue}-${project.id}-${f.suffix}`, 9)}`,
    p_id_number: identityValue,
    p_position: '普工',
    p_contractor_name: companyA ? `[D08-TEST] 单位A ${f.suffix}` : `[D08-TEST] 单位B ${f.suffix}`,
    p_contractor_code: companyA ? f.codeA : f.codeB,
    p_photo_path: photoPath(project, f, userId, identityValue, label),
    p_attachments: [],
  };
}

function sqlApply(userId, project, f, identityValue, companyId) {
  const p = applyPayload(project, f, identityValue, companyId, userId);
  return `BEGIN;
DO $claim$ BEGIN PERFORM set_config('request.jwt.claim.sub', ${literal(userId)}, true); END $claim$;
SELECT public.site_project_apply(${literal(p.p_token)}, ${literal(p.p_name)}, ${literal(p.p_phone)}, ${literal(p.p_id_number)}, ${literal(p.p_position)}, ${literal(p.p_contractor_name)}, ${literal(p.p_contractor_code)}, ${literal(p.p_photo_path)}, '[]'::jsonb);
COMMIT;`;
}

function appState(databaseUrl, appId) {
  return JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'id', a.id, 'employee_id', a.employee_id, 'status', a.status,
    'path', a.review_path, 'source', a.source_entity_id, 'target', a.target_entity_id,
    'events', (SELECT count(*) FROM public.project_join_application_events e WHERE e.application_id=a.id)
  )::text FROM public.project_join_applications a WHERE a.id=${literal(appId)}::uuid;`));
}

function count(databaseUrl, sql) { return Number.parseInt(runPsql(databaseUrl, sql), 10); }

function cleanup(databaseUrl, f) {
  runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
UPDATE public.profiles SET department_id=${literal(f.scope.entity_a)}::uuid, role='admin', admin_level='dept'
WHERE id=${literal(f.scope.entity_user)}::uuid;
DELETE FROM public.project_join_application_events WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_project_member_assignment_history WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_project_members WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.project_join_application_attachments WHERE application_id IN (SELECT id FROM public.project_join_applications WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')}));
DELETE FROM public.project_join_applications WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM storage.objects WHERE bucket_id='certificates' AND name LIKE ${literal(`training-admission/join-applications/%/%/%/%-${f.suffix}.jpg`)};
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_project_roles WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_project_invites WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_project_entities WHERE project_id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.site_projects WHERE id IN (${Object.values(f.projects).map(p => `${literal(p.id)}::uuid`).join(',')});
DELETE FROM public.training_employee_versions WHERE employee_id IN (SELECT id FROM public.training_employees WHERE remark='D08-3 TEST' OR remark='外协人员（项目邀请码申请）' AND name LIKE ${literal(`[D08-TEST]%${f.suffix}`)});
DELETE FROM public.training_employees WHERE remark='D08-3 TEST' OR remark='外协人员（项目邀请码申请）' AND name LIKE ${literal(`[D08-TEST]%${f.suffix}`)};
DELETE FROM public.contractor_company_versions WHERE contractor_id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid);
DELETE FROM public.contractor_companies WHERE id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid);
UPDATE public.profiles SET role=${literal(f.scope.company_role)}, admin_level=${f.scope.company_admin_level ? literal(f.scope.company_admin_level) : 'NULL'}, department_id=${literal(f.scope.entity_a)}::uuid
WHERE id=${literal(f.scope.company_user)}::uuid;
COMMIT;`);
  return count(databaseUrl, `SELECT
    (SELECT count(*) FROM public.site_projects WHERE report_notes='D08-3 TEST') +
    (SELECT count(*) FROM public.project_join_applications WHERE name LIKE ${literal(`[D08-TEST]%${f.suffix}`)}) +
    (SELECT count(*) FROM public.contractor_companies WHERE id IN (${literal(f.companyA)}::uuid, ${literal(f.companyB)}::uuid)) +
    (SELECT count(*) FROM public.training_employees WHERE name LIKE ${literal(`[D08-TEST]%${f.suffix}`)});`);
}

async function main() {
  const started = process.hrtime.bigint();
  const source = verifyStatic();
  check('D08-JOIN-00 v71 迁移、私有身份幂等与权限静态边界完整', source.migration);
  check('D08-JOIN-01 Web 展示服务端审核路径并阻止重复点击', source.web);
  if (process.argv.includes('--static')) { finish(started); return; }

  const boundary = validateTestBoundary();
  check('D08-JOIN-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const applicant = await login(boundary.apiOrigin, anonKey,
    required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD'));
  const reviewer = await login(boundary.apiOrigin, anonKey,
    required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
  check('D08-JOIN-02 测试账号与 D02 夹具一致', applicant.userId === scope.company_user && reviewer.userId === scope.entity_user);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const makeProject = (label, entity, status = 'active', flags = {}) => ({
    id: crypto.randomUUID(), code: `D08-${label}-${suffix}`, token: `D08-${label}-${crypto.randomUUID()}`,
    entity, status, ...flags,
  });
  const fixture = {
    scope, suffix, applicantUserId: applicant.userId, companyA: crypto.randomUUID(), companyB: crypto.randomUUID(),
    codeA: `A71${suffix}00000`.slice(0, 18), codeB: `B71${suffix}00000`.slice(0, 18),
    identityA: identity(`a-${suffix}`), identityB: identity(`b-${suffix}`),
    projects: {
      first: makeProject('FIRST', scope.entity_a), same: makeProject('SAME', scope.entity_a),
      cross: makeProject('CROSS', scope.entity_b), crossNull: makeProject('CROSSNULL', scope.entity_b),
      paused: makeProject('PAUSE', scope.entity_a, 'paused'),
      closed: makeProject('CLOSE', scope.entity_a, 'closed'), expired: makeProject('EXPIRE', scope.entity_a, 'active', { expired: true }),
      revoked: makeProject('REVOKE', scope.entity_a, 'active', { revoked: true }),
      concurrent: makeProject('CONCUR', scope.entity_a),
      bypass: makeProject('BYPASS', scope.entity_a),
    },
  };
  let residue = -1;
  const focusedConcurrency = process.argv.includes('--focused-concurrency');
  const throughConcurrency = process.argv.includes('--through-concurrency');
  const focusedMemberInsert = process.argv.includes('--focused-member-insert');
  let firstId;
  let employeeA;
  let firstEvents = 0;

  try {
    setup(boundary.databaseUrl, fixture);
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='employee', admin_level=NULL
      WHERE id=${literal(scope.company_user)}::uuid;`);

    const bypassPayload = {
      project_id: fixture.projects.bypass.id,
      employee_id: scope.company_employee,
      contractor_id: fixture.companyA,
      application_id: null,
      membership_type: 'external',
      work_type: '普工',
      status: 'active',
      created_by: applicant.userId,
    };
    const ordinaryInsert = await insertProjectMember(boundary, anonKey, applicant.token, bypassPayload);
    clearBypassMember(boundary.databaseUrl, fixture);
    const entityManagerInsert = await insertProjectMember(boundary, anonKey, reviewer.token, bypassPayload);
    clearBypassMember(boundary.databaseUrl, fixture);
    runPsql(boundary.databaseUrl, `INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by)
      VALUES (${literal(fixture.projects.bypass.id)}::uuid,${literal(scope.company_user)}::uuid,'project_manager',true,${literal(scope.entity_user)}::uuid);`);
    const projectManagerInsert = await insertProjectMember(boundary, anonKey, applicant.token, bypassPayload);
    clearBypassMember(boundary.databaseUrl, fixture);
    runPsql(boundary.databaseUrl, `UPDATE public.site_project_roles SET active=false
      WHERE project_id=${literal(fixture.projects.bypass.id)}::uuid AND user_id=${literal(scope.company_user)}::uuid;
      INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by)
      VALUES (${literal(fixture.projects.bypass.id)}::uuid,${literal(scope.company_user)}::uuid,'safety_officer',true,${literal(scope.entity_user)}::uuid);`);
    const safetyOfficerInsert = await insertProjectMember(boundary, anonKey, applicant.token, bypassPayload);
    clearBypassMember(boundary.databaseUrl, fixture);
    check('D08-JOIN-R02-01B authenticated 各业务角色均不能直接 INSERT 外协有效成员',
      [ordinaryInsert, entityManagerInsert, projectManagerInsert, safetyOfficerInsert].every(denied)
        && count(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_members WHERE project_id=${literal(fixture.projects.bypass.id)}::uuid;`) === 0,
      `statuses=${[ordinaryInsert, entityManagerInsert, projectManagerInsert, safetyOfficerInsert].map(x => x.status).join(',')}`);

    if (!focusedMemberInsert) {
    if (!focusedConcurrency) {
    const firstPayload = applyPayload(fixture.projects.first, fixture, fixture.identityA, fixture.companyA);
    const firstUpload = await uploadJoinPhoto(boundary, anonKey, applicant.token, firstPayload.p_photo_path);
    check('D08-JOIN-R02-02A 当前申请人合法上传可作为本次申请照片', success(firstUpload));
    const first = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', firstPayload);
    firstId = first.json;
    const firstState = success(first) && firstId ? appState(boundary.databaseUrl, firstId) : {};
    const ownPhotoRead = await signJoinPhoto(boundary, anonKey, applicant.token, firstPayload.p_photo_path);
    check('D08-JOIN-03 首次人员合法照片绑定后进入项目审核且本人可读', success(first)
      && typeof first.json === 'string' && /^[0-9a-f-]{36}$/i.test(first.json)
      && firstState.path === 'first_project' && firstState.status === 'pending_project_review'
      && success(ownPhotoRead));

    const repeats = await Promise.all([
      rpc(boundary, anonKey, applicant.token, 'site_project_apply', firstPayload),
      rpc(boundary, anonKey, applicant.token, 'site_project_apply', firstPayload),
    ]);
    check('D08-JOIN-04 重复扫码和弱网重试稳定返回同一活动申请', repeats.every(x => success(x) && x.json === firstId)
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.project_join_applications WHERE project_id=${literal(fixture.projects.first.id)}::uuid;`) === 1);

    const selfReview = await rpc(boundary, anonKey, applicant.token, 'site_project_review_application', {
      p_application_id: firstId, p_action: 'approve', p_note: null,
    });
    check('D08-JOIN-05 普通申请人不能自行审核', denied(selfReview));

    const firstReview = await rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', {
      p_application_id: firstId, p_action: 'approve', p_note: '首次项目审核',
    });
    const approvedFirst = appState(boundary.databaseUrl, firstId);
    employeeA = approvedFirst.employee_id;
    firstEvents = approvedFirst.events;
    check('D08-JOIN-06 首次审核只创建一个人员档案和一个项目关系', success(firstReview)
      && exactKeys(firstReview.json, ['status', 'review_path', 'changed', 'employee_id', 'member_id'])
      && approvedFirst.status === 'approved'
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.training_employees WHERE id_number_match_token=(SELECT id_number_digest FROM public.project_join_applications WHERE id=${literal(firstId)}::uuid);`) === 1
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_members WHERE project_id=${literal(fixture.projects.first.id)}::uuid AND employee_id=${literal(employeeA)}::uuid;`) === 1
      && runPsql(boundary.databaseUrl, `SELECT photo_path FROM public.training_employees WHERE id=${literal(employeeA)}::uuid;`) === firstPayload.p_photo_path);

    runPsql(boundary.databaseUrl, `INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by) VALUES
      (${literal(fixture.projects.first.id)}::uuid,${literal(scope.company_user)}::uuid,'project_manager',true,${literal(scope.entity_user)}::uuid),
      (${literal(fixture.projects.first.id)}::uuid,${literal(scope.company_user)}::uuid,'safety_officer',true,${literal(scope.entity_user)}::uuid);`);
    const managerLedger = await rpc(boundary, anonKey, applicant.token, 'training_contractor_personnel_ledger', {
      p_project_id: fixture.projects.first.id,
    });
    const entityLedger = await rpc(boundary, anonKey, reviewer.token, 'training_contractor_personnel_ledger', {
      p_project_id: fixture.projects.first.id,
    });
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role=${literal(scope.company_role)},
      admin_level=${scope.company_admin_level ? literal(scope.company_admin_level) : 'NULL'} WHERE id=${literal(scope.company_user)}::uuid;`);
    const companyLedger = await rpc(boundary, anonKey, applicant.token, 'training_contractor_personnel_ledger', {
      p_project_id: fixture.projects.first.id,
    });
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='employee', admin_level=NULL WHERE id=${literal(scope.company_user)}::uuid;`);
    const masked = response => success(response) && Array.isArray(response.json) && response.json.length === 1
      && /^.{3}\*{11}.{4}$/.test(response.json[0].id_number || '')
      && response.json[0].id_number !== fixture.identityA;
    check('D08-JOIN-R02-03 项目角色、经营实体和公司管理员普通台账均只返回脱敏身份证',
      masked(managerLedger) && masked(entityLedger) && masked(companyLedger));

    const legacyPayload = { p_project_id: fixture.projects.first.id, p_contractor_id: fixture.companyA,
      p_people: [{ name: '旁路测试', phone: '13900000000', id_number: fixture.identityB }] };
    const legacyBypass = await Promise.all([
      rpc(boundary, anonKey, applicant.token, 'training_batch_add_contractor_members', legacyPayload),
      rpc(boundary, anonKey, applicant.token, 'training_batch_add_contractor_members', legacyPayload),
    ]);
    check('D08-JOIN-R02-01 旧批量建档 RPC（含并发调用）已撤权且 Web 不再调用', legacyBypass.every(denied)
      && !fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'contractors.js'), 'utf8').includes('training_batch_add_contractor_members'));

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${literal(scope.entity_b)}::uuid
      WHERE id=${literal(scope.entity_user)}::uuid;`);
    const rebound = await rpc(boundary, anonKey, reviewer.token, 'site_project_apply', {
      ...firstPayload, p_id_number: fixture.identityB, p_phone: `17${digits(`rebind-${suffix}`, 9)}`,
    });
    const reboundRead = await signJoinPhoto(boundary, anonKey, reviewer.token, firstPayload.p_photo_path);
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${literal(scope.entity_a)}::uuid
      WHERE id=${literal(scope.entity_user)}::uuid;`);
    const nonexistent = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', {
      ...applyPayload(fixture.projects.same, fixture, fixture.identityA, fixture.companyA),
      p_photo_path: photoPath(fixture.projects.same, fixture, applicant.userId, fixture.identityA, 'missing'),
    });
    const crossPath = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', {
      ...applyPayload(fixture.projects.same, fixture, fixture.identityA, fixture.companyA),
      p_photo_path: firstPayload.p_photo_path,
    });
    const forgedPath = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', {
      ...applyPayload(fixture.projects.same, fixture, fixture.identityA, fixture.companyA),
      p_photo_path: photoPath(fixture.projects.same, fixture, reviewer.userId, fixture.identityA, 'forged'),
    });
    check('D08-JOIN-R02-02B 他人重绑定/读取、不存在、跨项目及伪造 UID 路径均失败',
      denied(rebound) && denied(reboundRead) && denied(nonexistent) && denied(crossPath) && denied(forgedPath));

    const samePayload = applyPayload(fixture.projects.same, fixture, fixture.identityA, fixture.companyA);
    if (!success(await uploadJoinPhoto(boundary, anonKey, applicant.token, samePayload.p_photo_path))) throw new Error('同实体申请照片上传失败');
    const same = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', samePayload);
    const sameState = appState(boundary.databaseUrl, same.json);
    check('D08-JOIN-07 已有人员同实体跨项目进入经营实体审核且复用人员', success(same)
      && sameState.path === 'same_entity_cross_project' && sameState.status === 'pending_entity_review'
      && sameState.employee_id === employeeA);

    runPsql(boundary.databaseUrl, `INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by)
      VALUES (${literal(fixture.projects.same.id)}::uuid,${literal(scope.company_user)}::uuid,'project_manager',true,${literal(scope.entity_user)}::uuid);`);
    const projectRoleEntityDenied = await rpc(boundary, anonKey, applicant.token, 'site_project_review_application', {
      p_application_id: same.json, p_action: 'approve', p_note: null,
    });
    check('D08-JOIN-08 项目角色不能越权执行经营实体审核', denied(projectRoleEntityDenied));
    const sameReview = await rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', {
      p_application_id: same.json, p_action: 'approve', p_note: '同实体审核',
    });
    check('D08-JOIN-09 同实体审核通过后新增项目关系且原关系保留', success(sameReview)
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_members WHERE employee_id=${literal(employeeA)}::uuid AND project_id IN (${literal(fixture.projects.first.id)}::uuid,${literal(fixture.projects.same.id)}::uuid);`) === 2);

    const crossNullPayload = applyPayload(fixture.projects.crossNull, fixture, fixture.identityA, fixture.companyA);
    if (!success(await uploadJoinPhoto(boundary, anonKey, applicant.token, crossNullPayload.p_photo_path))) throw new Error('NULL 归属负向照片上传失败');
    runPsql(boundary.databaseUrl, `UPDATE public.contractor_companies SET managing_entity_id=NULL WHERE id=${literal(fixture.companyA)}::uuid;`);
    const crossNull = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', crossNullPayload);
    runPsql(boundary.databaseUrl, `UPDATE public.contractor_companies SET managing_entity_id=${literal(scope.entity_a)}::uuid WHERE id=${literal(fixture.companyA)}::uuid;`);
    check('D08-JOIN-R02-04 NULL 单位归属可解析为 A 时不能被目标实体 B 复用', denied(crossNull));

    const crossPayload = applyPayload(fixture.projects.cross, fixture, fixture.identityA, fixture.companyB);
    if (!success(await uploadJoinPhoto(boundary, anonKey, applicant.token, crossPayload.p_photo_path))) throw new Error('跨实体申请照片上传失败');
    const cross = await rpc(boundary, anonKey, applicant.token, 'site_project_apply', crossPayload);
    const crossState = appState(boundary.databaseUrl, cross.json);
    const outsideReview = await rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', {
      p_application_id: cross.json, p_action: 'approve', p_note: null,
    });
    check('D08-JOIN-10 跨实体申请不能复用旧审核且原实体无权审核', success(cross)
      && crossState.path === 'cross_entity' && crossState.status === 'pending_entity_review'
      && crossState.employee_id === employeeA && denied(outsideReview));

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${literal(scope.entity_b)}::uuid WHERE id=${literal(scope.entity_user)}::uuid;`);
    const crossReview = await rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', {
      p_application_id: cross.json, p_action: 'approve', p_note: '目标实体审核',
    });
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET department_id=${literal(scope.entity_a)}::uuid WHERE id=${literal(scope.entity_user)}::uuid;`);
    check('D08-JOIN-11 目标实体审核后建立新关系且旧项目和旧单位均保留', success(crossReview)
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_members WHERE employee_id=${literal(employeeA)}::uuid;`) === 3
      && runPsql(boundary.databaseUrl, `SELECT string_agg(contractor_id::text,',' ORDER BY project_id) FROM public.site_project_members WHERE employee_id=${literal(employeeA)}::uuid;`).includes(fixture.companyA)
      && runPsql(boundary.databaseUrl, `SELECT string_agg(contractor_id::text,',' ORDER BY project_id) FROM public.site_project_members WHERE employee_id=${literal(employeeA)}::uuid;`).includes(fixture.companyB));

    const blockedResults = [];
    for (const key of ['paused', 'closed', 'expired', 'revoked']) {
      blockedResults.push(await rpc(boundary, anonKey, applicant.token, 'site_project_apply',
        applyPayload(fixture.projects[key], fixture, fixture.identityA, fixture.companyA)));
    }
    check('D08-JOIN-12 暂停、关闭、过期和撤销邀请码均不能申请', blockedResults.every(denied));
    }

    const concurrentPath = photoPath(fixture.projects.concurrent, fixture, scope.ordinary_user, fixture.identityB);
    runPsql(boundary.databaseUrl, `INSERT INTO storage.objects(bucket_id,name,owner_id)
      VALUES ('certificates',${literal(concurrentPath)},${literal(scope.ordinary_user)})
      ON CONFLICT(bucket_id,name) DO NOTHING;`);
    const concurrentSql = sqlApply(scope.ordinary_user, fixture.projects.concurrent, fixture, fixture.identityB, fixture.companyA);
    const concurrentApply = await Promise.all([
      runPsqlAsync(boundary.databaseUrl, concurrentSql), runPsqlAsync(boundary.databaseUrl, concurrentSql),
    ]);
    const concurrentId = concurrentApply[0].split(/\r?\n/).filter(Boolean).find(x => /^[0-9a-f-]{36}$/i.test(x));
    check('D08-JOIN-13 并发首次申请由数据库锁收敛为同一申请', concurrentApply.every(x => x.includes(concurrentId))
      && count(boundary.databaseUrl, `SELECT count(*) FROM public.project_join_applications WHERE project_id=${literal(fixture.projects.concurrent.id)}::uuid;`) === 1);

    runPsql(boundary.databaseUrl, `INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by)
      VALUES (${literal(fixture.projects.concurrent.id)}::uuid,${literal(scope.company_user)}::uuid,'project_manager',true,${literal(scope.entity_user)}::uuid)
      ON CONFLICT(project_id,user_id,role) DO UPDATE SET active=true;`);
    const canBefore = await rpc(boundary, anonKey, applicant.token, 'site_project_can_manage', { p_project_id: fixture.projects.concurrent.id });
    runPsql(boundary.databaseUrl, `UPDATE public.site_project_roles SET active=false WHERE project_id=${literal(fixture.projects.concurrent.id)}::uuid AND user_id=${literal(scope.company_user)}::uuid;`);
    const revokedReview = await rpc(boundary, anonKey, applicant.token, 'site_project_review_application', {
      p_application_id: concurrentId, p_action: 'approve', p_note: null,
    });
    check('D08-JOIN-14 撤权后新的项目审核立即失败', canBefore.json === true && denied(revokedReview));

    const concurrentReviews = await Promise.all([
      rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', { p_application_id: concurrentId, p_action: 'approve', p_note: '并发审核' }),
      rpc(boundary, anonKey, reviewer.token, 'site_project_review_application', { p_application_id: concurrentId, p_action: 'approve', p_note: '并发审核' }),
    ]);
    const concurrentState = appState(boundary.databaseUrl, concurrentId);
    const concurrentEmployees = count(boundary.databaseUrl, `SELECT count(*) FROM public.training_employees WHERE id_number_match_token=(SELECT id_number_digest FROM public.project_join_applications WHERE id=${literal(concurrentId)}::uuid);`);
    const concurrentMembers = concurrentState.employee_id
      ? count(boundary.databaseUrl, `SELECT count(*) FROM public.site_project_members WHERE project_id=${literal(fixture.projects.concurrent.id)}::uuid AND employee_id=${literal(concurrentState.employee_id)}::uuid;`)
      : 0;
    const reviewDetails = concurrentReviews.map(x => String(x.json?.message || x.json?.changed || 'none'))
      .join('|').replace(/[1-9][0-9]{16}[0-9X]/g, '[identity-redacted]');
    check('D08-JOIN-15 并发审核不产生重复人员或重复项目成员', concurrentReviews.every(success)
      && concurrentReviews.some(x => x.json?.changed === false)
      && concurrentEmployees === 1 && concurrentMembers === 1,
    `statuses=${concurrentReviews.map(x => x.status).join(',')} changed=${concurrentReviews.map(x => String(x.json?.changed)).join(',')} employees=${concurrentEmployees} members=${concurrentMembers} details=${reviewDetails}`);

    if (!focusedConcurrency && !throughConcurrency) {
    const restInsert = await request(boundary.apiOrigin, anonKey, '/rest/v1/project_join_applications', {
      method: 'POST', headers: { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: fixture.projects.first.id, name: '绕过', phone: '13900000000' }),
    });
    const restUpdate = await request(boundary.apiOrigin, anonKey, `/rest/v1/project_join_applications?id=eq.${firstId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const restDelete = await request(boundary.apiOrigin, anonKey, `/rest/v1/project_join_applications?id=eq.${firstId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${reviewer.token}` },
    });
    const eventId = runPsql(boundary.databaseUrl, `SELECT id FROM public.project_join_application_events WHERE application_id=${literal(firstId)}::uuid ORDER BY sequence_no LIMIT 1;`);
    const eventUpdate = await request(boundary.apiOrigin, anonKey, `/rest/v1/project_join_application_events?id=eq.${eventId}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${reviewer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'tampered' }),
    });
    check('D08-JOIN-16 REST 不能绕过申请状态机或篡改审核历史', [restInsert, restUpdate, restDelete, eventUpdate].every(denied));

    const auditCount = count(boundary.databaseUrl, `SELECT count(*) FROM public.project_join_application_events
      WHERE project_id IN (${literal(fixture.projects.first.id)}::uuid,${literal(fixture.projects.same.id)}::uuid,${literal(fixture.projects.cross.id)}::uuid)
        AND actor_id IS NOT NULL AND target_entity_id IS NOT NULL;`);
    const plainIdentity = count(boundary.databaseUrl, `SELECT count(*) FROM public.training_employees
      WHERE id IN (${literal(employeeA)}::uuid,${literal(concurrentState.employee_id)}::uuid) AND id_number IS NOT NULL;`);
    check('D08-JOIN-17 状态迁移审计完整且身份复用只依赖私有 HMAC', auditCount >= 6 && plainIdentity === 0
      && firstEvents >= 2 && !fs.readFileSync(migrationPath, 'utf8').includes('name = v_app.name AND phone = v_app.phone'));

    const regress = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'company_history', (SELECT count(*) FROM public.contractor_company_versions WHERE contractor_id IN (${literal(fixture.companyA)}::uuid,${literal(fixture.companyB)}::uuid)),
      'employee_history', (SELECT count(*) FROM public.training_employee_versions WHERE employee_id IN (${literal(employeeA)}::uuid,${literal(concurrentState.employee_id)}::uuid)),
      'assignment_history', (SELECT count(*) FROM public.site_project_member_assignment_history WHERE employee_id IN (${literal(employeeA)}::uuid,${literal(concurrentState.employee_id)}::uuid))
    )::text;`));
    check('D08-JOIN-18 D08-1 单位版本和 D08-2A 人员/单位关系历史最小回归', regress.company_history >= 2 && regress.employee_history >= 2 && regress.assignment_history >= 4);
    }
    }
  } finally {
    residue = cleanup(boundary.databaseUrl, fixture);
  }

  check('D08-JOIN-19 测试结束零残留', residue === 0, `residue=${residue}`);
  finish(started);
}

main().catch(error => {
  console.error(`D08 project join state machine failed: ${error.message}`);
  process.exit(1);
});

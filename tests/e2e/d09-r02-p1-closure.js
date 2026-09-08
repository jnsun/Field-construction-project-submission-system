/** D09 formal R02: P1-01..P1-04 focused regression with real TEST JWT/API calls. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migration = path.join(root, 'sql', 'training-admission-v80-d09-r02-p1-closure.sql');
const results = [];
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const ok = response => response.status >= 200 && response.status < 300;
const denied = response => [400, 401, 403, 404, 409].includes(response.status);
function check(group, name, pass, detail = '') {
  results.push({ group, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${group} ${name}${detail ? ` ${detail}` : ''}`);
}
function psql(databaseUrl, sql) {
  const run = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (run.error || run.status !== 0) {
    throw new Error(String(run.stderr || run.error?.message || '数据库失败')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim());
  }
  return String(run.stdout || '').trim();
}
function apply(databaseUrl) {
  const run = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration], {
    encoding: 'utf8', windowsHide: true,
  });
  if (run.error || run.status !== 0) throw new Error('v80 迁移应用失败：' + String(run.stderr || '').trim().split(/\r?\n/).at(-1));
}
async function request(base, key, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { apikey: key, ...(options.headers || {}) } });
  const text = await response.text(); let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(boundary, key, email, password) {
  const response = await request(boundary.apiOrigin, key, '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!ok(response) || !response.json?.access_token) throw new Error('R02 临时测试账号登录失败');
  return response.json.access_token;
}
function rpc(boundary, key, token, name, body) {
  return request(boundary.apiOrigin, key, `/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function rest(boundary, key, token, table, method, query = '', body = null) {
  return request(boundary.apiOrigin, key, `/rest/v1/${table}${query}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}
function storageUpload(boundary, key, token, storagePath, content, upsert = false) {
  return request(boundary.apiOrigin, key, `/storage/v1/object/training-courses/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'x-upsert': String(upsert) },
    body: Buffer.from(content),
  });
}
function storageSign(boundary, key, token, storagePath) {
  return request(boundary.apiOrigin, key, `/storage/v1/object/sign/training-courses/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 }),
  });
}
function storageDelete(boundary, key, token, storagePath) {
  return request(boundary.apiOrigin, key, '/storage/v1/object/training-courses', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
}
function fingerprint(databaseUrl, storagePath) {
  return psql(databaseUrl, `SELECT COALESCE(id::text||'|'||updated_at::text||'|'||metadata::text,'') FROM storage.objects WHERE bucket_id='training-courses' AND name=${literal(storagePath)};`);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const key = required('SAFETY_SUPABASE_ANON_KEY');
  check('R02-GATE', '隔离 TEST 边界与 D02 标记', assertD02FixtureMarker(boundary) > 0);
  const oldHeartbeat = fs.readFileSync(path.join(root, 'sql', 'training-content-library.sql'), 'utf8');
  const oldLifecycle = fs.readFileSync(path.join(root, 'sql', 'training-admission-v79-plan-lifecycle-audit.sql'), 'utf8');
  check('R02-PRE', 'R01 修复前证据仍可定位', oldHeartbeat.includes('v_new := TRUE')
    && oldLifecycle.includes('id=p_plan_id OR supersedes_plan_id=p_plan_id'));
  apply(boundary.databaseUrl);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const id = () => crypto.randomUUID();
  const actors = Object.fromEntries(['manager', 'safety', 'company', 'participant', 'learner', 'learner2'].map(name => [name, {
    id: id(), employee: id(), email: `d09-r02-${name}-${suffix}@example.invalid`, password: crypto.randomBytes(18).toString('base64url'), token: '',
  }]));
  const f = {
    projectA: id(), projectB: id(), rootPlan: id(), otherPlan: id(), courseA: id(), courseB: id(),
    roleManager: id(), roleSafety: id(), memberLearner: id(), memberLearner2: id(), storagePath: '',
    deptA: psql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-A' LIMIT 1;"),
    deptB: psql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-B' LIMIT 1;"),
  };
  f.storagePath = `${f.rootPlan}/r02-course.txt`;
  let residue = -1;
  try {
    const authRows = Object.values(actors).map(a => `('00000000-0000-0000-0000-000000000000',${literal(a.id)}::uuid,'authenticated','authenticated',${literal(a.email)},crypt(${literal(a.password)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}',now(),now())`).join(',');
    const employeeRows = Object.entries(actors).map(([name, a]) => `(${literal(a.employee)}::uuid,${literal(`R02 ${name}`)},${literal(`R02-${name}-${suffix}`)},${literal(name === 'participant' ? f.deptB : f.deptA)}::uuid,${literal(a.id)}::uuid,'active','D09-R02 TEST')`).join(',');
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL app.safety_test_confirmation='D02_TEST_ONLY';
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES ${authRows};
      SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_employees(id,name,employee_no,department_id,user_id,status,remark) VALUES ${employeeRows};
      UPDATE public.profiles p SET role=CASE WHEN p.id IN(${literal(actors.company.id)}::uuid,${literal(actors.participant.id)}::uuid) THEN 'admin' ELSE 'employee' END,
        admin_level=CASE WHEN p.id=${literal(actors.company.id)}::uuid THEN 'company' WHEN p.id=${literal(actors.participant.id)}::uuid THEN 'dept' ELSE NULL END,
        department_id=CASE WHEN p.id=${literal(actors.participant.id)}::uuid THEN ${literal(f.deptB)}::uuid ELSE ${literal(f.deptA)}::uuid END,
        employee_id=e.id FROM public.training_employees e WHERE e.user_id=p.id AND p.id IN(${Object.values(actors).map(a => `${literal(a.id)}::uuid`).join(',')});
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES
        (${literal(f.projectA)}::uuid,${literal(`R02-A-${suffix}`)},'R02 project A','active',${literal(f.deptA)}::uuid,'D09-R02 TEST'),
        (${literal(f.projectB)}::uuid,${literal(`R02-B-${suffix}`)},'R02 project B','active',${literal(f.deptB)}::uuid,'D09-R02 TEST');
      INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES
        (${literal(f.projectA)}::uuid,${literal(f.deptA)}::uuid,TRUE),(${literal(f.projectA)}::uuid,${literal(f.deptB)}::uuid,FALSE),
        (${literal(f.projectB)}::uuid,${literal(f.deptB)}::uuid,TRUE);
      INSERT INTO public.site_project_roles(id,project_id,user_id,role,active,assigned_by) VALUES
        (${literal(f.roleManager)}::uuid,${literal(f.projectA)}::uuid,${literal(actors.manager.id)}::uuid,'project_manager',TRUE,${literal(actors.participant.id)}::uuid),
        (${literal(f.roleSafety)}::uuid,${literal(f.projectA)}::uuid,${literal(actors.safety.id)}::uuid,'safety_officer',TRUE,${literal(actors.participant.id)}::uuid);
      INSERT INTO public.site_project_members(id,project_id,employee_id,membership_type,status) VALUES
        (${literal(f.memberLearner)}::uuid,${literal(f.projectA)}::uuid,${literal(actors.learner.employee)}::uuid,'internal','active'),
        (${literal(f.memberLearner2)}::uuid,${literal(f.projectA)}::uuid,${literal(actors.learner2.employee)}::uuid,'internal','active'); COMMIT;`);

    await Promise.all(Object.values(actors).map(async a => { a.token = await login(boundary, key, a.email, a.password); }));
    check('P1-01', '六个独立真实 JWT', new Set(Object.values(actors).map(a => a.token)).size === 6);

    const createRoot = await rpc(boundary, key, actors.manager.token, 'training_save_plan_draft', {
      p_plan_id: f.rootPlan, p_plan: { title: `[D09-R02] project A ${suffix}`, level: 'project', site_project_id: f.projectA, plan_year: 2026, hours: 1, required_hours: 0.1 }, p_target_department_ids: [],
    });
    const managerRead = await rest(boundary, key, actors.manager.token, 'training_plans', 'GET', `?id=eq.${f.rootPlan}&select=id,site_project_id`);
    const upload = await storageUpload(boundary, key, actors.manager.token, f.storagePath, 'R02 owner content');
    const courseA = await rest(boundary, key, actors.manager.token, 'training_courses', 'POST', '', { id: f.courseA, plan_id: f.rootPlan, title: 'R02 course A', course_type: 'text', file_path: f.storagePath, content: 'A', required: true });
    const courseB = await rest(boundary, key, actors.safety.token, 'training_courses', 'POST', '', { id: f.courseB, plan_id: f.rootPlan, title: 'R02 course B', course_type: 'text', content: 'B', required: true });
    check('P1-01', 'employee 项目经理可创建/读取计划并维护 draft course', [createRoot, managerRead, upload, courseA].every(ok) && managerRead.json?.length === 1,
      JSON.stringify({ create: createRoot.status, read: managerRead.status, readRows: managerRead.json?.length, upload: upload.status, course: courseA.status, uploadBody: upload.json, courseBody: courseA.json }));
    check('P1-01', 'employee 安全员可读取并维护同项目 draft course', ok(courseB));

    const createOther = await rpc(boundary, key, actors.participant.token, 'training_save_plan_draft', {
      p_plan_id: f.otherPlan, p_plan: { title: `[D09-R02] project B ${suffix}`, level: 'project', site_project_id: f.projectB, plan_year: 2026, hours: 1, required_hours: 0.5 }, p_target_department_ids: [],
    });
    const crossPatch = await rest(boundary, key, actors.manager.token, 'training_plans', 'PATCH', `?id=eq.${f.otherPlan}`, { title: 'FORGED CROSS PROJECT' });
    const crossTitle = psql(boundary.databaseUrl, `SELECT title FROM public.training_plans WHERE id=${literal(f.otherPlan)}::uuid;`);
    check('P1-01', '项目 A 经理不能管理项目 B', ok(createOther) && !crossTitle.includes('FORGED') && (denied(crossPatch) || crossPatch.json?.length === 0));

    const companyRead = await rest(boundary, key, actors.company.token, 'training_plans', 'GET', `?id=eq.${f.rootPlan}&select=id`);
    const participantRead = await rest(boundary, key, actors.participant.token, 'training_plans', 'GET', `?id=eq.${f.rootPlan}&select=id`);
    const companyPlanPatch = await rest(boundary, key, actors.company.token, 'training_plans', 'PATCH', `?id=eq.${f.rootPlan}`, { title: 'FORGED COMPANY' });
    const participantCoursePatch = await rest(boundary, key, actors.participant.token, 'training_courses', 'PATCH', `?id=eq.${f.courseA}`, { title: 'FORGED PARTICIPANT' });
    const beforeStorage = fingerprint(boundary.databaseUrl, f.storagePath);
    const companyStorageRead = await storageSign(boundary, key, actors.company.token, f.storagePath);
    const participantStorageRead = await storageSign(boundary, key, actors.participant.token, f.storagePath);
    const companyOverwrite = await storageUpload(boundary, key, actors.company.token, f.storagePath, 'FORGED', true);
    const participantDelete = await storageDelete(boundary, key, actors.participant.token, f.storagePath);
    const afterStorage = fingerprint(boundary.databaseUrl, f.storagePath);
    const managementFingerprint = psql(boundary.databaseUrl, `SELECT (title NOT LIKE 'FORGED%' AND (SELECT title FROM public.training_courses WHERE id=${literal(f.courseA)}::uuid) NOT LIKE 'FORGED%')::int FROM public.training_plans WHERE id=${literal(f.rootPlan)}::uuid;`);
    check('P1-02', 'company/参与实体 read 保留但不能修改 plan/course', companyRead.json?.length === 1 && participantRead.json?.length === 1
      && managementFingerprint === '1'
      && (denied(companyPlanPatch) || companyPlanPatch.json?.length === 0) && (denied(participantCoursePatch) || participantCoursePatch.json?.length === 0),
      JSON.stringify({ companyRead: companyRead.status, companyRows: companyRead.json?.length, participantRead: participantRead.status, participantRows: participantRead.json?.length,
        companyPatch: companyPlanPatch.status, companyPatchBody: companyPlanPatch.json, participantCoursePatch: participantCoursePatch.status,
        participantCoursePatchBody: participantCoursePatch.json, fingerprint: managementFingerprint }));
    check('P1-02', 'Storage read 与 overwrite/delete 分离', ok(companyStorageRead) && ok(participantStorageRead)
      && denied(companyOverwrite) && (denied(participantDelete) || ok(participantDelete)) && beforeStorage === afterStorage);

    const submit = await rpc(boundary, key, actors.manager.token, 'training_request_plan_approval', { p_plan_id: f.rootPlan });
    const companyApprove = await rpc(boundary, key, actors.company.token, 'training_approve_plan', { p_plan_id: f.rootPlan, p_approved: true, p_note: '不应成功' });
    const participantApprove = await rpc(boundary, key, actors.participant.token, 'training_approve_plan', { p_plan_id: f.rootPlan, p_approved: true, p_note: '不应成功' });
    const safetyApprove = await rpc(boundary, key, actors.safety.token, 'training_approve_plan', { p_plan_id: f.rootPlan, p_approved: true, p_note: '安全员签发' });
    check('P1-01', '项目经理可送审且安全员可合法签发', ok(submit) && ok(safetyApprove));
    check('P1-02', '仅 read 的 company/参与实体管理员不能签发', denied(companyApprove) && denied(participantApprove));
    const publish = await rpc(boundary, key, actors.manager.token, 'training_publish_plan', { p_plan_id: f.rootPlan, p_note: 'R02 发布' });
    check('P1-01', '项目经理可发布且项目 active 人员获 assignment', ok(publish) && publish.json?.assigned === 2);

    if (process.env.D09_R02_PERMISSION_ONLY !== '1') {
    const first = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: null, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    const repeated = [];
    for (let i = 0; i < 4; i += 1) repeated.push(await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: null, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null }));
    check('P1-03', '首次与连续 NULL session 均 credited=0', ok(first) && first.json?.credited_seconds === 0
      && repeated.every(x => ok(x) && x.json?.credited_seconds === 0));

    const timed = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: null, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    psql(boundary.databaseUrl, `UPDATE public.training_study_logs SET last_beat_at=clock_timestamp()-interval '20 seconds' WHERE id=${literal(timed.json.session_id)}::uuid;`);
    const elapsed = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: timed.json.session_id, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    const immediate = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: timed.json.session_id, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    check('P1-03', '只按服务器真实间隔计时且立即重放不增时', ok(elapsed) && elapsed.json?.credited_seconds >= 19 && elapsed.json?.credited_seconds <= 21
      && immediate.json?.credited_seconds === 0);

    const otherOwner = await rpc(boundary, key, actors.learner2.token, 'training_course_heartbeat', { p_session_id: null, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    const stolen = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: otherOwner.json.session_id, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    const wrongCourse = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: timed.json.session_id, p_course_id: f.courseB, p_delta_sec: 60, p_position: null, p_progress: null });
    check('P1-03', '他人 session 与其他 course session 均拒绝', denied(stolen) && denied(wrongCourse));

    const concurrentSession = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: null, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    psql(boundary.databaseUrl, `UPDATE public.training_study_logs SET last_beat_at=clock_timestamp()-interval '20 seconds' WHERE id=${literal(concurrentSession.json.session_id)}::uuid;`);
    const concurrent = await Promise.all([1, 2].map(() => rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: concurrentSession.json.session_id, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null })));
    const concurrentSec = Number(psql(boundary.databaseUrl, `SELECT effective_sec FROM public.training_study_logs WHERE id=${literal(concurrentSession.json.session_id)}::uuid;`));
    check('P1-03', '并发 heartbeat 行锁防止重复计时', concurrent.every(ok) && concurrentSec >= 19 && concurrentSec <= 21);

    await rpc(boundary, key, actors.learner.token, 'training_save_course_progress', { p_course_id: f.courseA, p_progress: 100, p_position: 1 });
    const earnedBefore = psql(boundary.databaseUrl, `SELECT COALESCE(sum(effective_sec),0) FROM public.training_study_logs WHERE employee_id=${literal(actors.learner.employee)}::uuid AND course_id=${literal(f.courseA)}::uuid;`);
    const withdraw = await rpc(boundary, key, actors.manager.token, 'training_withdraw_plan', { p_plan_id: f.rootPlan, p_reason: 'R02 撤回验证' });
    const afterWithdrawHeartbeat = await rpc(boundary, key, actors.learner.token, 'training_course_heartbeat', { p_session_id: timed.json.session_id, p_course_id: f.courseA, p_delta_sec: 60, p_position: null, p_progress: null });
    const afterWithdrawProgress = await rpc(boundary, key, actors.learner.token, 'training_save_course_progress', { p_course_id: f.courseB, p_progress: 100, p_position: 1 });
    const withdrawnState = psql(boundary.databaseUrl, `SELECT status||'|'||COALESCE(hours_earned,0)::text||'|'||(SELECT COALESCE(sum(effective_sec),0) FROM public.training_study_logs WHERE employee_id=${literal(actors.learner.employee)}::uuid AND course_id=${literal(f.courseA)}::uuid) FROM public.training_assignments WHERE plan_id=${literal(f.rootPlan)}::uuid AND employee_id=${literal(actors.learner.employee)}::uuid;`);
    check('P1-03', 'withdraw 后 heartbeat/progress 拒绝且历史学时保留、不能 complete', ok(withdraw) && denied(afterWithdrawHeartbeat) && denied(afterWithdrawProgress)
      && !withdrawnState.startsWith('completed|') && withdrawnState.endsWith(`|${earnedBefore}`), withdrawnState);

    const clone1 = await rpc(boundary, key, actors.manager.token, 'training_clone_plan_version', { p_plan_id: f.rootPlan });
    const clone2 = await rpc(boundary, key, actors.manager.token, 'training_clone_plan_version', { p_plan_id: clone1.json });
    const clone3 = await rpc(boundary, key, actors.manager.token, 'training_clone_plan_version', { p_plan_id: f.rootPlan });
    const clone4 = await rpc(boundary, key, actors.manager.token, 'training_clone_plan_version', { p_plan_id: clone1.json });
    const parallel = await Promise.all([1, 2].map(() => rpc(boundary, key, actors.manager.token, 'training_clone_plan_version', { p_plan_id: f.rootPlan })));
    const lineage = psql(boundary.databaseUrl, `SELECT count(*)||'|'||count(DISTINCT version_no)||'|'||count(DISTINCT version_root_id)||'|'||string_agg(version_no::text,',' ORDER BY version_no) FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid;`);
    check('P1-04', 'v1→v2→v3，再从 v1/v2 得到 v4/v5', [clone1, clone2, clone3, clone4].every(ok) && lineage.startsWith('7|7|1|1,2,3,4,5,'), lineage);
    check('P1-04', '两个并发 clone 由 root 行锁串行且 UNIQUE 兜底', parallel.every(ok) && new Set(parallel.map(x => x.json)).size === 2 && lineage === '7|7|1|1,2,3,4,5,6,7');
    const rootTamper = await rest(boundary, key, actors.manager.token, 'training_plans', 'PATCH', `?id=eq.${f.rootPlan}`, { version_no: 99 });
    const historyRefs = psql(boundary.databaseUrl, `SELECT ((SELECT count(*) FROM public.training_assignments WHERE plan_id=${literal(f.rootPlan)}::uuid)=2 AND (SELECT count(*) FROM public.training_records WHERE plan_id=${literal(f.rootPlan)}::uuid)=1 AND (SELECT version_no FROM public.training_plans WHERE id=${literal(f.rootPlan)}::uuid)=1)::int;`);
    check('P1-04', '旧正式版本不可改且 assignment/record 仍引用原版本', denied(rootTamper) && historyRefs === '1');
    }

    const trainingJs = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'training.js'), 'utf8');
    const plansJs = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'plans.js'), 'utf8');
    check('P1-01', 'Web 为项目角色开放 plans 且不扩大通用 canEdit', trainingJs.includes("['plans', 'contractors'")
      && trainingJs.includes('canManagePlans()') && plansJs.includes('TrainingModule.canManagePlans()'));
  } finally {
    const userIds = Object.values(actors).map(a => `${literal(a.id)}::uuid`).join(',');
    const employeeIds = Object.values(actors).map(a => `${literal(a.employee)}::uuid`).join(',');
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_participants WHERE record_id IN(SELECT id FROM public.training_records WHERE plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid) OR plan_id=${literal(f.otherPlan)}::uuid);
      DELETE FROM public.training_course_progress WHERE employee_id IN(${employeeIds});
      DELETE FROM public.training_study_logs WHERE employee_id IN(${employeeIds});
      DELETE FROM public.training_assignments WHERE employee_id IN(${employeeIds}) OR plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid);
      DELETE FROM public.training_records WHERE plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid) OR plan_id=${literal(f.otherPlan)}::uuid;
      DELETE FROM public.training_plan_events WHERE plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid) OR plan_id=${literal(f.otherPlan)}::uuid;
      DELETE FROM public.training_courses WHERE plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid) OR plan_id=${literal(f.otherPlan)}::uuid;
      DELETE FROM public.training_plan_targets WHERE plan_id IN(SELECT id FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid) OR plan_id=${literal(f.otherPlan)}::uuid;
      DELETE FROM public.training_plans WHERE version_root_id=${literal(f.rootPlan)}::uuid OR id=${literal(f.otherPlan)}::uuid;
      DELETE FROM storage.objects WHERE bucket_id='training-courses' AND name=${literal(f.storagePath)};
      DELETE FROM public.site_project_roles WHERE project_id IN(${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
      DELETE FROM public.site_project_members WHERE project_id IN(${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
      DELETE FROM public.site_project_entities WHERE project_id IN(${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
      DELETE FROM public.site_projects WHERE id IN(${literal(f.projectA)}::uuid,${literal(f.projectB)}::uuid);
      UPDATE public.profiles SET employee_id=NULL WHERE id IN(${userIds});
      DELETE FROM public.training_employees WHERE id IN(${employeeIds});
      DELETE FROM public.profiles WHERE id IN(${userIds});
      DELETE FROM auth.users WHERE id IN(${userIds}); COMMIT;`);
    residue = Number(psql(boundary.databaseUrl, `SELECT
      (SELECT count(*) FROM auth.users WHERE email LIKE ${literal(`d09-r02-%-${suffix}@example.invalid`)})
      +(SELECT count(*) FROM public.training_plans WHERE title LIKE ${literal(`[D09-R02]%${suffix}`)})
      +(SELECT count(*) FROM public.training_employees WHERE remark='D09-R02 TEST')
      +(SELECT count(*) FROM public.site_projects WHERE report_notes='D09-R02 TEST')
      +(SELECT count(*) FROM storage.objects WHERE bucket_id='training-courses' AND name=${literal(f.storagePath)});`));
  }
  check('R02-CLEANUP', '测试残留为 0', residue === 0, `residual=${residue}`);
  for (const group of [...new Set(results.filter(x => x.group.startsWith('P1-')).map(x => x.group))]) {
    const rows = results.filter(x => x.group === group); console.log(`D09_R02_GROUP ${group} total=${rows.length} passed=${rows.filter(x => x.pass).length} failed=${rows.filter(x => !x.pass).length}`);
  }
  const failed = results.filter(x => !x.pass);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D09_R02_P1_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residual=${residue} elapsed_ms=${elapsed.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

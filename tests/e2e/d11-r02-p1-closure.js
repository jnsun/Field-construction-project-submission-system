/** D11 R02: P1-01..03 focused TEST evidence. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { admissionId, cleanup, complete, createFixture, ids, psql, q, readAuthority, scalar, startSql } = require('./d11-three-level-training-reuse');

process.env.PGCONNECT_TIMEOUT ||= '15';
const root = path.resolve(__dirname, '..', '..');
const migration = path.join(root, 'sql', 'training-admission-v82-d11-r02-p1-closure.sql');
const results = [];
const ok = response => response.status >= 200 && response.status < 300;
const hasCode = (response, code) => !ok(response) && String(response.json?.message || response.json || '').includes(`[D11:${code}]`);
function check(group, name, pass, detail = '') {
  results.push({ group, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} D11-R02-${group} ${name}${detail ? ` ${detail}` : ''}`);
}
function apply(databaseUrl) {
  const run = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration], {
    encoding: 'utf8', windowsHide: true,
  });
  if (run.error || run.status !== 0) throw new Error(`v82 migration failed: ${String(run.stderr || run.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
}
async function request(base, key, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, signal: AbortSignal.timeout(15000), headers: { apikey: key, ...(options.headers || {}) } });
  const text = await response.text(); let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(boundary, key, email, password) {
  const response = await request(boundary.apiOrigin, key, '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!ok(response) || !response.json?.access_token) throw new Error('D11 R02 temporary learner login failed');
  return response.json.access_token;
}
const rpc = (boundary, key, token, name, body) => request(boundary.apiOrigin, key, `/rest/v1/rpc/${name}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const rest = (boundary, key, token, table, body) => request(boundary.apiOrigin, key, `/rest/v1/${table}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body),
});

async function statusApi(boundary, key, token, project, employee) {
  const response = await rpc(boundary, key, token, 'training_three_level_status', { p_project_id: project, p_employee_id: employee });
  if (!ok(response)) throw new Error(`D11 R02 status API failed (${response.status})`);
  return response.json;
}

async function main() {
  const started = process.hrtime.bigint(); const boundary = validateTestBoundary(); const key = required('SAFETY_SUPABASE_ANON_KEY');
  const f = ids(); const generalPaper = crypto.randomUUID(); let residual = -1;
  check('GATE', 'isolated TEST boundary', assertD02FixtureMarker(boundary) > 0);
  apply(boundary.databaseUrl); readAuthority(boundary.databaseUrl, f);
  try {
    createFixture(boundary.databaseUrl, f);
    const token = await login(boundary, key, f.auth.internalEmail, f.auth.internalPassword);
    const contractorToken = await login(boundary, key, f.auth.contractorEmail, f.auth.contractorPassword);
    check('A', 'real learner JWTs', !!token && !!contractorToken);

    psql(boundary.databaseUrl, startSql(f, f.projects.a1, f.employees.internal, f.packages.a1));
    const a1 = admissionId(boundary.databaseUrl, f.projects.a1, f.employees.internal);
    const examAssignment = scalar(boundary.databaseUrl, `INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id) VALUES (${q(f.plans.exam)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)}) ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id;`);
    const direct = await rest(boundary, key, token, 'exam_attempts', { paper_id: f.paper, assignment_id: examAssignment, employee_id: f.employees.internal, attempt_no: 1, questions: [], deadline_at: new Date(Date.now() + 600000).toISOString() });
    check('A', 'unbound direct REST attempt is blocked', !ok(direct) && scalar(boundary.databaseUrl, `SELECT count(*) FROM public.exam_attempts WHERE assignment_id=${q(examAssignment)};`) === '0', `status=${direct.status}`);
    const unboundRpc = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'unbound exam_start is blocked', hasCode(unboundRpc, 'admission_exam_not_prepared'));

    psql(boundary.databaseUrl, `UPDATE public.training_admissions SET exam_assignment_id=${q(examAssignment)} WHERE id=${q(a1)};`);
    const missingCompany = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'bound exam still requires company level', hasCode(missingCompany, 'missing_company_training'));
    complete(boundary.databaseUrl, a1, ['company']);
    const missingEntity = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'bound exam still requires entity level', hasCode(missingEntity, 'missing_entity_training'));
    complete(boundary.databaseUrl, a1, ['entity']);
    const missingProject = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'bound exam still requires project level', hasCode(missingProject, 'missing_project_training'));
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_admission_tasks SET status='completed',progress=100,effective_hours=0.25,fulfillment_kind='original',completed_at=NOW() WHERE admission_id=${q(a1)} AND level='project'; COMMIT;`);
    const hours = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'bound exam still requires effective hours', hasCode(hours, 'incomplete_effective_hours'));
    complete(boundary.databaseUrl, a1);
    const prepared = await rpc(boundary, key, token, 'training_prepare_admission_exam', { p_admission_id: a1 });
    const startedExam = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('A', 'normal prepare then exam_start succeeds', ok(prepared) && ok(startedExam) && !!startedExam.json?.attempt_id);

    psql(boundary.databaseUrl, startSql(f, f.projects.a1, f.employees.contractor, f.packages.a1));
    psql(boundary.databaseUrl, `INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,status,created_by) VALUES (${q(generalPaper)},${q(f.plans.projectA1)},'[D11-TEST] normal exam','fixed',30,80,3,'published',${q(f.manager)}); INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order) VALUES (${q(generalPaper)},${q(f.question)},100,1);`);
    const normalExam = await rpc(boundary, key, contractorToken, 'exam_start', { p_plan_id: f.plans.projectA1 });
    check('A', 'non-comprehensive exam keeps existing behavior', ok(normalExam) && !!normalExam.json?.attempt_id);

    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM public.exam_attempts WHERE assignment_id=${q(examAssignment)}; UPDATE public.training_assignments SET exam_status='pending',exam_attempts=0 WHERE id=${q(examAssignment)}; UPDATE public.training_admissions SET exam_assignment_id=NULL WHERE id=${q(a1)}; COMMIT;`);
    psql(boundary.databaseUrl, startSql(f, f.projects.a2, f.employees.internal, f.packages.a2));
    const a2 = admissionId(boundary.databaseUrl, f.projects.a2, f.employees.internal); complete(boundary.databaseUrl, a2, ['project']);
    const sourceTimes = JSON.parse(scalar(boundary.databaseUrl, `SELECT json_agg(json_build_object('id',id,'completed_at',completed_at) ORDER BY id)::text FROM public.training_admission_tasks WHERE admission_id=${q(a1)} AND level IN('company','entity');`));
    const restoreSourceTimes = sourceTimes.map(x => `UPDATE public.training_admission_tasks SET completed_at=${q(x.completed_at)}::timestamptz WHERE id=${q(x.id)};`).join(' ');
    const originalFingerprint = scalar(boundary.databaseUrl, `SELECT md5(string_agg(concat_ws('|',id,status,fulfillment_kind,effective_hours,completed_at),',' ORDER BY id)) FROM public.training_admission_tasks WHERE admission_id=${q(a1)} AND level IN('company','entity');`);
    const initial = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    check('B', 'initial reused source is valid', initial.exam_allowed === true && initial.levels.filter(x => ['company','entity'].includes(x.level)).every(x => x.items.every(i => i.reuse_valid === true && i.reuse_source?.completed_at)));
    psql(boundary.databaseUrl, `UPDATE public.training_admissions SET exam_assignment_id=${q(examAssignment)} WHERE id=${q(a2)}; BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_admission_tasks SET completed_at=NOW()-INTERVAL '2 years' WHERE admission_id=${q(a1)} AND level IN('company','entity'); COMMIT;`);
    const duplicateBinding = psql(boundary.databaseUrl, `UPDATE public.training_admissions SET exam_assignment_id=${q(examAssignment)} WHERE id=${q(a1)};`, true);
    check('A', 'one exam assignment cannot bind two admissions', duplicateBinding.status !== 0);
    const expired = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    const expiredExam = await rpc(boundary, key, token, 'exam_start', { p_plan_id: f.plans.exam });
    check('B', 'expired source invalidates status and bound exam', expired.reason_code === 'reused_source_expired' && hasCode(expiredExam, 'reused_source_expired'));
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; ${restoreSourceTimes} UPDATE public.training_admission_tasks SET fulfillment_kind='required' WHERE admission_id=${q(a1)} AND level='company'; COMMIT;`);
    const invalid = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    check('B', 'source no longer original is rejected', invalid.reason_code === 'reused_source_invalid');
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_admission_tasks SET fulfillment_kind='original' WHERE admission_id=${q(a1)} AND level='company'; UPDATE public.training_employees SET department_id=${q(f.entityB)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityB)} WHERE id=${q(f.users.internal)}; COMMIT;`);
    const moved = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    check('B', 'entity transfer invalidates entity reuse only', moved.reason_code === 'entity_training_reuse_invalid' && moved.levels.find(x => x.level === 'company').items.every(i => i.reuse_valid === true));
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_employees SET department_id=${q(f.entityA)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityA)} WHERE id=${q(f.users.internal)}; UPDATE public.training_plans SET reuse_policy='retrain' WHERE id=${q(f.plans.company)}; COMMIT;`);
    const retrain = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    check('B', 'retrain policy invalidates existing reuse', retrain.reason_code === 'retraining_required');
    const companyTask = scalar(boundary.databaseUrl, `SELECT id FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND level='company';`);
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_plans SET reuse_policy='allow' WHERE id=${q(f.plans.company)}; UPDATE public.training_admission_tasks SET plan_version_root_id=${q(crypto.randomUUID())} WHERE id=${q(companyTask)}; COMMIT;`);
    const lineage = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    check('B', 'lineage mismatch invalidates existing reuse', lineage.reason_code === 'reused_source_invalid');
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_admission_tasks SET plan_version_root_id=${q(f.plans.company)} WHERE id=${q(companyTask)}; ${restoreSourceTimes} COMMIT;`);
    const restored = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    const restoredFingerprint = scalar(boundary.databaseUrl, `SELECT md5(string_agg(concat_ws('|',id,status,fulfillment_kind,effective_hours,completed_at),',' ORDER BY id)) FROM public.training_admission_tasks WHERE admission_id=${q(a1)} AND level IN('company','entity');`);
    check('B', 'valid source can satisfy again', restored.exam_allowed === true && restored.reason_code === 'ready');
    check('B', 'source completion semantics remain original', originalFingerprint === restoredFingerprint);

    psql(boundary.databaseUrl, `INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES (${q(f.packages.a2)},${q(f.plans.company2)},'company',true,4); SELECT public.training_sync_three_level_tasks_internal(${q(a2)});`);
    const multiple = await statusApi(boundary, key, token, f.projects.a2, f.employees.internal);
    const companyItems = multiple.levels.find(x => x.level === 'company')?.items || [];
    check('C', 'status contract returns every same-level item', companyItems.length === 2 && companyItems.every(i => i.plan_title && Object.hasOwn(i, 'reuse_source')));
    const management = fs.readFileSync(path.join(root, 'js/modules/training/admission-operations.js'), 'utf8');
    const learner = fs.readFileSync(path.join(root, 'js/modules/training/admission-mine.js'), 'utf8');
    check('C', 'management Web renders server state and original evidence', !management.includes('items?.[0]') && management.includes('flatMap(level') && management.includes('item.reuse_source') && management.includes('source.completed_at'));
    check('C', 'learner Web renders every item and original evidence', !learner.includes('items?.[0]') && learner.includes('flatMap(level') && learner.includes('item.reuse_source') && learner.includes('source.effective_hours'));
  } finally {
    residual = cleanup(boundary.databaseUrl, f); check('CLEANUP', 'residual = 0', residual === 0, `residual=${residual}`);
  }
  const failed = results.filter(x => !x.pass); const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`D11_R02_RESULT ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if (failed.length) process.exit(1);
}
main().catch(error => { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')); process.exit(1); });

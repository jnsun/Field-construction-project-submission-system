/** D11 v83 final-rule TARGETED: one-time employee three-level foundation. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { admissionId, asUser, cleanup, createFixture, ids, psql, q, readAuthority, scalar, startSql } = require('./d11-three-level-training-reuse');

process.env.PGCONNECT_TIMEOUT ||= '15';
const root = path.resolve(__dirname, '..', '..');
const migration = path.join(root, 'sql', 'training-admission-v83-employee-three-level-foundation.sql');
const results = [];
const ok = r => r.status >= 200 && r.status < 300;
const code = (r, value) => !ok(r) && String(r.json?.message || r.json || '').includes(`[D11:${value}]`);
function check(name, pass, detail = '') { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} D11-V83 ${name}${detail ? ` ${detail}` : ''}`); }
function apply(db) {
  const r = spawnSync('psql', [db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`v83 migration failed: ${String(r.stderr || r.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
}
async function request(base, key, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, signal: AbortSignal.timeout(15000), headers: { apikey: key, ...(options.headers || {}) } });
  const text = await response.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(b, key, email, password) {
  const r = await request(b.apiOrigin, key, '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!ok(r) || !r.json?.access_token) throw new Error('D11 v83 temporary login failed'); return r.json.access_token;
}
const rpc = (b, key, token, name, body) => request(b.apiOrigin, key, `/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const patchRest = (b, key, token, table, query, body) => request(b.apiOrigin, key, `/rest/v1/${table}${query}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body) });
const statusSql = (db, f, project, employee) => JSON.parse(asUser(db, f.manager, `SELECT public.training_three_level_status(${q(project)},${q(employee)})::text;`).out.split(/\r?\n/).filter(x => x.startsWith('{')).at(-1));
async function statusApi(b, key, token, project, employee = null) {
  const r = await rpc(b, key, token, 'training_three_level_status', { p_project_id: project, p_employee_id: employee });
  if (!ok(r)) throw new Error(`status API failed ${r.status}`); return r.json;
}
function classify(db, f, employee, person, category, start = null, allowFailure = false) {
  return asUser(db, f.manager, `SELECT public.training_set_three_level_classification(${q(employee)},${q(person)},${q(category)},${start ? q(start) : 'NULL'}::date,'D11-V83-TEST','controlled test classification');`, allowFailure);
}
function assign(db, f, employee, thirdPlan, mode, project = null) {
  return asUser(db, f.manager, `SELECT public.training_assign_three_level_program(${q(employee)},${q(f.plans.company)},${q(f.plans.entityA)},${q(thirdPlan)},${q(mode)},${project ? q(project) : 'NULL'});`, true);
}
function finish(db, employee) {
  psql(db, `INSERT INTO public.training_study_logs(id,employee_id,course_id,last_beat_at,beats,effective_sec,closed)
    SELECT gen_random_uuid(),${q(employee)},c.id,NOW(),60,3600,true FROM public.training_three_level_records r JOIN public.training_courses c ON c.plan_id=r.plan_id
    JOIN public.training_three_level_profiles p ON p.employment_relation_id=r.employment_relation_id WHERE p.employee_id=${q(employee)} AND r.employment_relation_id=p.employment_relation_id
    ON CONFLICT(id) DO NOTHING;
    UPDATE public.training_assignments a SET status='completed',progress=100,completed_at=NOW()
    WHERE a.id IN (SELECT r.assignment_id FROM public.training_three_level_records r JOIN public.training_three_level_profiles p ON p.employment_relation_id=r.employment_relation_id WHERE p.employee_id=${q(employee)});`);
}

async function main() {
  const started = process.hrtime.bigint(); const b = validateTestBoundary(); const key = required('SAFETY_SUPABASE_ANON_KEY'); const f = ids();
  f.plans.basic = crypto.randomUUID(); f.employees.temp = crypto.randomUUID(); f.employees.incomplete = crypto.randomUUID(); let residual = -1;
  check('01 isolated TEST boundary', assertD02FixtureMarker(b) > 0); apply(b.databaseUrl); readAuthority(b.databaseUrl, f);
  try {
    createFixture(b.databaseUrl, f);
    psql(b.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES
        (${q(f.employees.temp)},'[D11-TEST] temp','D11-${f.suffix}-temp',${q(f.entityA)},'临时个人','employee','active','D11-TEST'),
        (${q(f.employees.incomplete)},'[D11-TEST] incomplete','D11-${f.suffix}-incomplete',${q(f.entityA)},'普通员工','employee','active','D11-TEST');
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,contractor_id,status,created_by) VALUES
        (${q(f.projects.a1)},${q(f.employees.temp)},'internal',NULL,'active',${q(f.manager)}),(${q(f.projects.a1)},${q(f.employees.incomplete)},'internal',NULL,'active',${q(f.manager)});
      INSERT INTO public.training_plans(id,title,level,department_id,site_project_id,third_level_mode,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by)
      VALUES(${q(f.plans.basic)},'[D11-TEST] basic third','project',${q(f.entityA)},NULL,'basic_project',2026,1,0.5,'planned','approved','published',${q(f.plans.basic)},1,'allow',${q(f.manager)});
      INSERT INTO public.training_courses(plan_id,title,course_type,content,required,sort_order) VALUES(${q(f.plans.basic)},'[D11-TEST] basic course','text','safe',true,1); COMMIT;`);
    const token = await login(b, key, f.auth.internalEmail, f.auth.internalPassword);
    const contractorToken = await login(b, key, f.auth.contractorEmail, f.auth.contractorPassword);
    check('02 real learner JWTs', !!token && !!contractorToken);

    classify(b.databaseUrl, f, f.employees.internal, 'formal_internal', 'new_hire', '2026-09-08');
    let state = await statusApi(b, key, token, f.projects.a1);
    check('03 new formal relation is authoritative and required', state.three_level_applicable === true && state.onboarding_category === 'new_hire' && state.overall_satisfied === false);
    const basicAssigned = assign(b.databaseUrl, f, f.employees.internal, f.plans.basic, 'basic_project');
    check('04 basic_project without site project is accepted', basicAssigned.status === 0 && scalar(b.databaseUrl, `SELECT count(*) FROM public.training_three_level_records WHERE employee_id=${q(f.employees.internal)} AND level='third' AND third_level_mode='basic_project' AND source_project_id IS NULL;`) === '1');
    state = await statusApi(b, key, token, f.projects.a1);
    check('05 incomplete company/entity/third remains blocked', state.exam_allowed === false && state.reason_code === 'missing_company_training' && state.levels.length === 3);
    finish(b.databaseUrl, f.employees.internal); state = await statusApi(b, key, token, f.projects.a1);
    check('06 complete basic three-level becomes permanent foundation', state.overall_satisfied === true && state.reason_code === 'three_level_training_completed' && state.levels.find(x => x.level === 'third').items[0].third_level_mode === 'basic_project');
    const fingerprint = scalar(b.databaseUrl, `SELECT md5(string_agg(concat_ws('|',id,completed_at,plan_version_no,source_project_id),',' ORDER BY level)) FROM public.training_three_level_records WHERE employee_id=${q(f.employees.internal)};`);

    psql(b.databaseUrl, startSql(f, f.projects.a2, f.employees.internal, f.packages.a2));
    check('07 project change creates no second three-level tasks', scalar(b.databaseUrl, `SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(admissionId(b.databaseUrl,f.projects.a2,f.employees.internal))} AND level IN('company','entity','project');`) === '0' && (await statusApi(b,key,token,f.projects.a2)).overall_satisfied === true);
    psql(b.databaseUrl, `BEGIN; SET LOCAL app.personnel_change_source='D11_V83_TEST'; UPDATE public.training_employees SET department_id=${q(f.entityB)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityB)} WHERE id=${q(f.users.internal)}; COMMIT;`);
    check('08 entity transfer does not retrigger three-level', (await statusApi(b,key,token,f.projects.a2)).overall_satisfied === true);
    check('09 project/entity/year changes preserve completion history', scalar(b.databaseUrl, `SELECT md5(string_agg(concat_ws('|',id,completed_at,plan_version_no,source_project_id),',' ORDER BY level)) FROM public.training_three_level_records WHERE employee_id=${q(f.employees.internal)};`) === fingerprint);

    classify(b.databaseUrl, f, f.employees.missing, 'formal_internal', 'new_hire', '2026-09-08');
    const actualAssigned = assign(b.databaseUrl, f, f.employees.missing, f.plans.projectA1, 'actual_project', f.projects.a1);
    finish(b.databaseUrl, f.employees.missing);
    const actualA = statusSql(b.databaseUrl, f, f.projects.a1, f.employees.missing), actualB = statusSql(b.databaseUrl, f, f.projects.a2, f.employees.missing);
    check('10 actual_project source A remains satisfied in project B', actualAssigned.status === 0 && actualA.overall_satisfied && actualB.overall_satisfied && actualB.levels.find(x => x.level === 'third').items[0].source_project_id === f.projects.a1);
    classify(b.databaseUrl, f, f.employees.incomplete, 'formal_internal', 'new_hire', '2026-09-08');
    check('11 actual_project without project is rejected', assign(b.databaseUrl,f,f.employees.incomplete,f.plans.projectA1,'actual_project').err.includes('[D11:third_level_project_scope_mismatch]'));
    check('12 illegal actual project is rejected', assign(b.databaseUrl,f,f.employees.incomplete,f.plans.projectA1,'actual_project',crypto.randomUUID()).err.includes('[D11:third_level_project_forbidden]'));

    classify(b.databaseUrl, f, f.employees.unknown, 'formal_internal', 'legacy_evidence_review', null);
    check('13 legacy employee without evidence requires review', statusSql(b.databaseUrl,f,f.projects.a1,f.employees.unknown).reason_code === 'legacy_three_level_evidence_review_required');
    const verified = asUser(b.databaseUrl, f.manager, `SELECT public.training_confirm_legacy_three_level(${q(f.employees.unknown)},'archived signed training card','2020-06-01','ARCHIVE-D11-TEST','verified test evidence');`);
    check('14 controlled legacy evidence becomes verified', verified.status === 0 && statusSql(b.databaseUrl,f,f.projects.a1,f.employees.unknown).reason_code === 'legacy_three_level_verified' && scalar(b.databaseUrl, `SELECT count(*) FROM public.training_three_level_legacy_evidence WHERE employee_id=${q(f.employees.unknown)} AND reviewed_by=${q(f.manager)};`) === '1');
    classify(b.databaseUrl, f, f.employees.concurrent, 'formal_internal', 'legacy_supplement', null);
    check('15 legacy without evidence requires one supplement', statusSql(b.databaseUrl,f,f.projects.a1,f.employees.concurrent).reason_code === 'legacy_three_level_supplement_required');
    assign(b.databaseUrl,f,f.employees.concurrent,f.plans.basic,'basic_project'); finish(b.databaseUrl,f.employees.concurrent);
    check('16 supplement completion is permanent and honest', statusSql(b.databaseUrl,f,f.projects.a2,f.employees.concurrent).reason_code === 'legacy_three_level_supplement_completed');

    classify(b.databaseUrl, f, f.employees.contractor, 'contractor', 'not_applicable', null);
    psql(b.databaseUrl,startSql(f,f.projects.a1,f.employees.contractor,f.packages.a1)); const contractorAdmission=admissionId(b.databaseUrl,f.projects.a1,f.employees.contractor);
    const contractorState = await statusApi(b,key,contractorToken,f.projects.a1);
    const contractorGate = await rpc(b,key,contractorToken,'training_three_level_exam_gate',{p_admission_id:contractorAdmission});
    check('17 contractor is not applicable and receives no employee three-level tasks', contractorState.three_level_applicable===false && contractorState.reason_code==='three_level_not_applicable' && contractorState.levels.length===0 && scalar(b.databaseUrl,`SELECT count(*) FROM public.training_three_level_records WHERE employee_id=${q(f.employees.contractor)};`)==='0');
    check('18 contractor gate routes to later project admission without fake pass', ok(contractorGate) && contractorGate.json.allowed===false && contractorGate.json.reason_code==='three_level_not_applicable_use_project_admission_path');
    classify(b.databaseUrl, f, f.employees.temp, 'temporary_individual', 'not_applicable', null);
    psql(b.databaseUrl,startSql(f,f.projects.a1,f.employees.temp,f.packages.a1)); const tempAdmission=admissionId(b.databaseUrl,f.projects.a1,f.employees.temp);
    const tempGate=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.training_three_level_exam_gate(${q(tempAdmission)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1));
    check('19 temporary individual needs no fake company/contract', statusSql(b.databaseUrl,f,f.projects.a1,f.employees.temp).person_category==='temporary_individual' && tempGate.allowed===false && tempGate.reason_code==='three_level_not_applicable_use_project_admission_path' && scalar(b.databaseUrl,`SELECT count(*) FROM public.site_project_members WHERE employee_id=${q(f.employees.temp)} AND contractor_id IS NOT NULL;`)==='0');
    classify(b.databaseUrl, f, f.employees.leader, 'visitor', 'not_applicable', null);
    const visitorStart=psql(b.databaseUrl,startSql(f,f.projects.a1,f.employees.leader,f.packages.a1),true);
    check('20 visitor stays on briefing path with no employee records', visitorStart.status!==0 && visitorStart.err.includes('[D11:visitor_safety_briefing_required]') && scalar(b.databaseUrl,`SELECT count(*) FROM public.training_three_level_records WHERE employee_id=${q(f.employees.leader)};`)==='0');

    psql(b.databaseUrl, `UPDATE public.training_employees SET department_id=${q(f.entityA)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityA)} WHERE id=${q(f.users.internal)};`);
    const examAssignment=scalar(b.databaseUrl,`INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id) VALUES(${q(f.plans.exam)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)}) ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id;`);
    const unbound=await rpc(b,key,token,'exam_start',{p_plan_id:f.plans.exam});
    const prepared=await rpc(b,key,token,'training_prepare_admission_exam',{p_admission_id:admissionId(b.databaseUrl,f.projects.a2,f.employees.internal)});
    check('21 exam binding remains fail-closed then succeeds for completed employee', code(unbound,'admission_exam_not_prepared') && ok(prepared) && prepared.json.assignment_id===examAssignment);
    const missingExamAdmission=scalar(b.databaseUrl,`INSERT INTO public.training_admissions(project_id,member_id,employee_id,package_id,due_at) SELECT ${q(f.projects.a1)},id,${q(f.employees.incomplete)},${q(f.packages.a1)},NOW()+INTERVAL '1 day' FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.incomplete)} RETURNING id;`);
    const missingGate=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.training_three_level_exam_gate(${q(missingExamAdmission)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1));
    check('22 formal incomplete employee exam prerequisite rejects', missingGate.allowed===false && !['three_level_not_applicable','three_level_not_applicable_use_project_admission_path'].includes(missingGate.reason_code));

    const direct=await patchRest(b,key,token,'training_three_level_profiles',`?employee_id=eq.${f.employees.internal}`,{status:'completed',onboarding_category:'completed'});
    const directRecord=await patchRest(b,key,token,'training_three_level_records',`?employee_id=eq.${f.employees.internal}`,{status:'completed',effective_hours:999});
    check('23 direct REST cannot self-complete or reclassify', [401,403].includes(direct.status) && [401,403].includes(directRecord.status));
    const locked=psql(b.databaseUrl,`UPDATE public.training_three_level_records SET completed_at=NOW()+INTERVAL '1 day' WHERE employee_id=${q(f.employees.internal)};`,true);
    check('24 completion/version/source history is immutable', locked.status!==0 && locked.err.includes('[D11:three_level_history_locked]'));
    const downgrade=classify(b.databaseUrl,f,f.employees.internal,'formal_internal','legacy_supplement',null,true);
    check('25 completed current relation cannot be downgraded', downgrade.status!==0 && downgrade.err.includes('[D11:three_level_history_locked]'));
    const oldRelation=scalar(b.databaseUrl,`SELECT employment_relation_id FROM public.training_three_level_profiles WHERE employee_id=${q(f.employees.internal)};`);
    classify(b.databaseUrl,f,f.employees.internal,'formal_internal','new_hire','2027-01-02'); const rehired=await statusApi(b,key,token,f.projects.a2);
    check('26 rehire creates a new required relation and preserves old records', rehired.onboarding_category==='new_hire' && rehired.overall_satisfied===false && rehired.employment_relation_id!==oldRelation && scalar(b.databaseUrl,`SELECT count(*) FROM public.training_three_level_records WHERE employment_relation_id=${q(oldRelation)} AND status='completed';`)==='3');
    check('27 RLS and grants are fail-closed', scalar(b.databaseUrl,`SELECT (SELECT count(*) FROM pg_class c WHERE c.oid IN('public.training_three_level_profiles'::regclass,'public.training_three_level_records'::regclass,'public.training_three_level_legacy_evidence'::regclass,'public.training_three_level_audit_logs'::regclass) AND c.relrowsecurity)=4 AND NOT has_table_privilege('authenticated','public.training_three_level_profiles','UPDATE') AND NOT has_table_privilege('authenticated','public.training_three_level_records','INSERT');`)==='t');
    const web=fs.readFileSync(path.join(root,'js/modules/training/admission-mine.js'),'utf8')+fs.readFileSync(path.join(root,'js/modules/training/admission-operations.js'),'utf8')+fs.readFileSync(path.join(root,'js/modules/training/plans.js'),'utf8');
    check('28 Web exposes category, not-applicable and explicit third-level modes', ['legacy_evidence_review','three_level_applicable','basic_project','actual_project','不适用员工三级教育'].every(x=>web.includes(x)));
  } finally {
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_three_level_legacy_evidence WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')});
      DELETE FROM public.training_three_level_audit_logs WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')});
      DELETE FROM public.training_three_level_records WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')});
      DELETE FROM public.training_three_level_profiles WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')}); COMMIT;`);
    residual=cleanup(b.databaseUrl,f); check('29 residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`D11_V83_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length) process.exit(1);
}
main().catch(error=>{console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

/** D13 TARGETED: authoritative admission/special exams, snapshots, timing, retries and permissions. */
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { admissionId, asUser, cleanup, complete, createFixture, ids, psql, q, readAuthority, scalar, startSql } = require('./d11-three-level-training-reuse');

process.env.PGCONNECT_TIMEOUT ||= '15';
const root = path.resolve(__dirname, '..', '..');
const migration = path.join(root, 'sql', 'training-admission-v86-authoritative-admission-exams.sql');
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} D13 ${name}${detail ? ` ${detail}` : ''}`); };
const id = () => crypto.randomUUID();
const json = result => {
  const payload = result?.out?.split(/\r?\n/).filter(line => line.startsWith('{')).at(-1);
  if (!payload) throw new Error(`expected JSON result: ${String(result?.err || result?.out || 'empty result').trim()}`);
  return JSON.parse(payload);
};
const call = (db, user, sql, allowFailure = false) => asUser(db, user, `SELECT ${sql}::text;`, allowFailure);
const code = (result, value) => result.status !== 0 && result.err.includes(`[D13:${value}]`);
const start = (db, user, admission, type = 'admission', special = null, key = id()) => call(db, user,
  `public.training_exam_start(${q(admission)},${q(type)},${special ? q(special) : 'NULL'},${key ? q(key) : 'NULL'})`, true);
const submit = (db, user, attempt, answers) => call(db, user, `public.training_exam_submit(${q(attempt)},${q(JSON.stringify(answers))}::jsonb)`, true);

function completeProjectAdmissionTraining(db, f, admission, employee, user) {
  psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,status,progress,hours_earned,completed_at)
    VALUES(${q(f.plans.induction)},${q(employee)},${q(user)},${q(f.entityA)},'completed',100,1,NOW())
    ON CONFLICT(plan_id,employee_id) DO UPDATE SET status='completed',progress=100,hours_earned=1,completed_at=NOW();
    INSERT INTO public.training_admission_tasks(admission_id,plan_id,level,training_category,assignment_id,status,progress,required_hours,effective_hours,
      fulfillment_kind,completed_at,decision_code,evaluated_at,requirement_active)
    SELECT ${q(admission)},${q(f.plans.induction)},'project','project_induction',id,'completed',100,1,1,'original',NOW(),'original_completed',NOW(),TRUE
    FROM public.training_assignments WHERE plan_id=${q(f.plans.induction)} AND employee_id=${q(employee)}
    ON CONFLICT(admission_id,plan_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,status='completed',progress=100,
      effective_hours=1,fulfillment_kind='original',completed_at=NOW(),decision_code='original_completed',evaluated_at=NOW(),requirement_active=TRUE;
    COMMIT;`);
}

function psqlAsync(databaseUrl, sql) {
  return new Promise(resolve => {
    const child = spawn('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', value => { out += value; }); child.stderr.on('data', value => { err += value; });
    child.on('close', status => resolve({ status, out: out.trim(), err: err.trim() })); child.stdin.end(sql);
  });
}

function apply(db) {
  if (scalar(db, "SELECT to_regprocedure('public.site_project_set_risk_tags(uuid,text[],text)') IS NOT NULL;") === 't') return;
  const result = spawnSync('psql', [db, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`v86 failed: ${String(result.stderr || result.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
}

async function main() {
  const started = process.hrtime.bigint(); const boundary = validateTestBoundary(); const db = boundary.databaseUrl; const f = ids(); let residual = -1,drillParameterVersion=null;
  f.users.temp = id(); f.users.visitor = id(); f.employees.temp = id();
  f.plans.induction=id();
  const questionIds = Array.from({ length: 29 }, id); const boundaryPaper = id(); const specialPapers = {};
  const specialTypes = ['blasting','electrical','welding','drilling']; const documents = [];
  for (const type of specialTypes) { f.plans[`training_${type}`] = id(); f.plans[`exam_${type}`] = id(); specialPapers[type] = id(); }
  check('01 isolated TEST boundary', assertD02FixtureMarker(boundary) > 0); apply(db); readAuthority(db, f);
  try {
    createFixture(db, f);
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES
      ('00000000-0000-0000-0000-000000000000',${q(f.users.temp)},'authenticated','authenticated',${q(`d13-${f.suffix}-temp@example.invalid`)},crypt('D13-isolated-temp',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now()),
      ('00000000-0000-0000-0000-000000000000',${q(f.users.visitor)},'authenticated','authenticated',${q(`d13-${f.suffix}-visitor@example.invalid`)},crypt('D13-isolated-visitor',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark)
      VALUES(${q(f.employees.temp)},'[D13-TEST] temporary',${q(`D13-${f.suffix}-TEMP`)},${q(f.entityA)},'临时个人','employee','active','D13-TEST');
      INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,is_super_admin)
      VALUES
      (${q(f.users.temp)},${q(`d13-${f.suffix}-temp@example.invalid`)},${q(f.employees.temp)},${q(f.entityA)},'employee','[D13-TEST] temporary',false),
      (${q(f.users.visitor)},${q(`d13-${f.suffix}-visitor@example.invalid`)},${q(f.employees.leader)},${q(f.entityA)},'employee','[D13-TEST] visitor',false);
      INSERT INTO public.account_subjects(auth_user_id,employee_id) VALUES(${q(f.users.temp)},${q(f.employees.temp)}),(${q(f.users.visitor)},${q(f.employees.leader)});
      INSERT INTO public.account_lifecycle(subject_id) SELECT id FROM public.account_subjects WHERE auth_user_id IN(${q(f.users.temp)},${q(f.users.visitor)});
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by)
      VALUES(${q(f.projects.a1)},${q(f.employees.temp)},'temporary','active',${q(f.manager)});
      INSERT INTO public.training_plans(id,title,level,training_category,site_project_id,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by)
      VALUES(${q(f.plans.induction)},'[D13-TEST] project induction','project','project_induction',${q(f.projects.a1)},2026,1,1,'planned','approved','published',${q(f.plans.induction)},1,'allow',${q(f.manager)}); COMMIT;`);
    asUser(db, f.manager, `SELECT public.training_set_three_level_classification(${q(f.employees.contractor)},'contractor','not_applicable',NULL,'D13 TEST',NULL);`);
    asUser(db, f.manager, `SELECT public.training_set_three_level_classification(${q(f.employees.temp)},'temporary_individual','not_applicable',NULL,'D13 TEST',NULL);`);
    asUser(db, f.manager, `SELECT public.training_set_three_level_classification(${q(f.employees.leader)},'visitor','not_applicable',NULL,'D13 TEST',NULL);`);
    asUser(db, f.manager, `SELECT public.training_set_three_level_classification(${q(f.employees.internal)},'formal_internal','new_hire',CURRENT_DATE,'D13 TEST',NULL);`);
    psql(db,`INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,reason,source)
      SELECT m.project_id,m.employee_id,public.training_member_primary_path(m),m.status='active',m.joined_at,'D13 fixture sync','D13-TEST'
      FROM public.site_project_members m WHERE m.project_id IN(${Object.values(f.projects).map(q).join(',')})
      ON CONFLICT(project_id,employee_id) DO UPDATE SET primary_path=EXCLUDED.primary_path,active=EXCLUDED.active,reason=EXCLUDED.reason,source=EXCLUDED.source,changed_at=NOW();`);

    const baseQuestions = [f.question, ...questionIds.slice(0, 19)];
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE public.exam_papers SET exam_type='admission',exam_semantic_type='legacy_admission',special_type=NULL,question_count=20,duration_min=30,pass_score=80,retry_limit=3,shuffle=true WHERE id=${q(f.paper)};
      UPDATE public.exam_questions SET stem='[D13-TEST] fixed original',options='[{"key":"A","text":"safe"},{"key":"B","text":"wrong"}]',answer='A' WHERE id=${q(f.question)};
      UPDATE public.exam_paper_questions SET score=5 WHERE paper_id=${q(f.paper)} AND question_id=${q(f.question)};
      INSERT INTO public.exam_questions(id,scope,question_type,stem,options,answer,status,created_by)
      SELECT x.id::uuid,'company','single','[D13-TEST] fixed '||x.n,'[{"key":"A","text":"safe"},{"key":"B","text":"wrong"}]','A','published',${q(f.manager)}
      FROM (VALUES ${questionIds.slice(0,19).map((qid,index)=>`(${q(qid)},${index+2})`).join(',')}) x(id,n);
      INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order)
      SELECT ${q(f.paper)},x.id::uuid,5,x.n FROM (VALUES ${questionIds.slice(0,19).map((qid,index)=>`(${q(qid)},${index+2})`).join(',')}) x(id,n); COMMIT;`);

    psql(db, startSql(f, f.projects.a1, f.employees.internal, f.packages.a1)); const internalAdmission = admissionId(db, f.projects.a1, f.employees.internal);
    check('02 formal employee missing D11 prerequisite is rejected', code(start(db, f.users.internal, internalAdmission),'three_level_training_required'));
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_three_level_profiles SET status='completed',onboarding_category='completed',completed_at=NOW() WHERE employee_id=${q(f.employees.internal)}; COMMIT;`);
    complete(db, internalAdmission);
    const first = json(start(db, f.users.internal, internalAdmission, 'admission', null, 'first'));
    check('03 eligible formal employee starts admission exam', first.exam_type === 'admission' && first.status === 'in_progress');
    check('04 default rule is 20 questions / 30 minutes / 80 / 3', first.question_count === 20 && first.pass_line === 80 && first.max_attempts === 3 && Math.round((new Date(first.deadline_at)-new Date(first.started_at))/60000) === 30);
    check('05 client paper contains no correct answers', !JSON.stringify(first.questions).includes('correct_answer') && !JSON.stringify(first.questions).includes('"answer"'));
    const refreshed = json(call(db, f.users.internal, `public.training_exam_get(${q(first.attempt_id)})`));
    check('05 refresh returns the same fixed snapshot', JSON.stringify(refreshed.questions) === JSON.stringify(first.questions));
    psql(db, `UPDATE public.exam_questions SET stem='[D13-TEST] changed later',answer='B' WHERE id=${q(f.question)};`);
    const afterEdit = json(call(db, f.users.internal, `public.training_exam_get(${q(first.attempt_id)})`));
    check('06 later question edits do not rewrite old attempt', JSON.stringify(afterEdit.questions) === JSON.stringify(first.questions));
    const wrongAnswers = Object.fromEntries(baseQuestions.map(qid => [qid, 'B'])); const firstResult = json(submit(db, f.users.internal, first.attempt_id, wrongAnswers));
    check('07 grading uses immutable answer snapshot', firstResult.score === 0 && firstResult.result === 'fail');
    const repeated = json(submit(db, f.users.internal, first.attempt_id, Object.fromEntries(baseQuestions.map(qid => [qid, 'A']))));
    check('08 repeated submit is idempotent and cannot change answers', repeated.idempotent === true && repeated.score === 0 && scalar(db, `SELECT count(*) FROM public.exam_attempt_events WHERE attempt_id=${q(first.attempt_id)} AND event_type='submitted';`) === '1');
    check('09 submitted history cannot be rewritten', asUser(db, f.users.internal, `UPDATE public.exam_attempts SET score=100,result='pass' WHERE id=${q(first.attempt_id)};`, true).status !== 0);
    check('10 another person cannot read or submit attempt', code(call(db, f.users.contractor, `public.training_exam_get(${q(first.attempt_id)})`, true),'forbidden') && code(submit(db, f.users.contractor, first.attempt_id, {}),'forbidden'));
    check('11 ordinary client cannot read correct-answer table', asUser(db, f.users.internal, `SELECT answer FROM public.exam_questions LIMIT 1;`, true).status !== 0);

    const boundaryQuestions = questionIds.slice(19,29); const weights = [79,1,...Array(8).fill(2.5)];
    psql(db, `BEGIN;
      INSERT INTO public.exam_questions(id,scope,question_type,stem,options,answer,status,created_by) VALUES
      ${boundaryQuestions.map((qid,index)=>`(${q(qid)},'company','single',${q(`[D13-TEST] boundary ${weights[index]}`)},'[{"key":"A","text":"safe"},{"key":"B","text":"wrong"}]','A','published',${q(f.manager)})`).join(',')};
      INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,shuffle,status,created_by,exam_type,exam_semantic_type,question_count,updated_at)
      VALUES(${q(boundaryPaper)},${q(f.plans.exam)},'[D13-TEST] boundary','fixed',30,80,3,false,'published',${q(f.manager)},'admission','legacy_admission',10,NOW()+INTERVAL '1 second');
      INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order) VALUES
      ${boundaryQuestions.map((qid,index)=>`(${q(boundaryPaper)},${q(qid)},${weights[index]},${index+1})`).join(',')}; COMMIT;`);
    const second = json(start(db, f.users.internal, internalAdmission, 'admission', null, 'second'));
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.exam_attempts SET deadline_at=clock_timestamp()+INTERVAL '29 minutes 59 seconds' WHERE id=${q(second.attempt_id)}; COMMIT;`);
    const score79 = json(submit(db, f.users.internal, second.attempt_id, { [boundaryQuestions[0]]:'A' }));
    check('12 29:59 submission is accepted and 79 fails', score79.status === 'submitted' && score79.score === 79 && score79.result === 'fail');
    const third = json(start(db, f.users.internal, internalAdmission, 'admission', null, 'third'));
    const score80 = json(submit(db, f.users.internal, third.attempt_id, { [boundaryQuestions[0]]:'A', [boundaryQuestions[1]]:'A' }));
    check('13 score 80 passes on third attempt', score80.score === 80 && score80.result === 'pass' && third.attempt_no === 3);
    check('14 fourth attempt is rejected', code(start(db, f.users.internal, internalAdmission, 'admission', null, 'fourth'),'attempt_limit_reached'));

    psql(db, startSql(f, f.projects.a2, f.employees.internal, f.packages.a2));
    const movedStatus=json(call(db,f.users.internal,`public.training_three_level_status(${q(f.projects.a2)},NULL)`));
    check('15 project change does not retrigger completed D11 foundation',movedStatus.exam_allowed===true);
    const projectA2Attempt=json(start(db,f.users.internal,admissionId(db,f.projects.a2,f.employees.internal),'admission',null,'project-a2'));
    check('16 project A attempts do not consume project B attempt numbers',projectA2Attempt.project_id===f.projects.a2 && projectA2Attempt.attempt_no===1);
    psql(db, startSql(f, f.projects.a1, f.employees.contractor, f.packages.a1)); const contractorAdmission = admissionId(db, f.projects.a1, f.employees.contractor);
    check('17 contractor uses project training and not employee three-level', code(start(db, f.users.contractor, contractorAdmission),'project_admission_training_required'));
    completeProjectAdmissionTraining(db, f, contractorAdmission, f.employees.contractor, f.users.contractor);
    const contractorAttempt = json(start(db, f.users.contractor, contractorAdmission, 'admission', null, 'contractor'));
    check('17 completed contractor project training allows exam', contractorAttempt.exam_type === 'admission');
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.exam_attempts SET deadline_at=clock_timestamp() WHERE id=${q(contractorAttempt.attempt_id)}; COMMIT;`);
    const timedOut = json(submit(db, f.users.contractor, contractorAttempt.attempt_id, {}));
    check('18 30:00 is server-authoritative timeout', timedOut.status === 'timed_out' && timedOut.result === 'fail' && timedOut.reason_code === 'exam_timed_out');
    psql(db, startSql(f, f.projects.a1, f.employees.temp, f.packages.a1)); const tempAdmission = admissionId(db, f.projects.a1, f.employees.temp);
    completeProjectAdmissionTraining(db, f, tempAdmission, f.employees.temp, f.users.temp);
    const concurrentSql = user => `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(user)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); SELECT public.training_exam_start(${q(tempAdmission)},'admission',NULL,NULL)::text; COMMIT;`;
    const concurrent = await Promise.all([psqlAsync(db,concurrentSql(f.users.temp)),psqlAsync(db,concurrentSql(f.users.temp))]);
    const concurrentIds = concurrent.map(run => JSON.parse(run.out.split(/\r?\n/).find(line=>line.startsWith('{'))).attempt_id);
    check('19 temporary individual uses project path and concurrent start is one attempt', concurrent.every(run=>run.status===0) && concurrentIds[0]===concurrentIds[1] && scalar(db,`SELECT count(*) FROM public.exam_attempts WHERE admission_id=${q(tempAdmission)};`)==='1');
    const leaderMember=scalar(db,`SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.leader)};`);
    const visitorAdmission=id(); psql(db,`BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO public.training_admissions(id,project_id,member_id,employee_id,package_id) VALUES(${q(visitorAdmission)},${q(f.projects.a1)},${q(leaderMember)},${q(f.employees.leader)},${q(f.packages.a1)}); COMMIT;`);
    check('20 visitor cannot enter ordinary admission exam', code(start(db, f.users.visitor, visitorAdmission),'prerequisite_not_met'));

    psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_plans(id,title,level,training_category,department_id,special_type,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
      ${specialTypes.flatMap(type=>[
        `(${q(f.plans[`training_${type}`])},${q(`[D13-TEST] ${type} training`)},'special',${q(type==='drilling'?'project_special':'special_operation')},${q(f.entityA)},${q(type)},2026,1,1,'planned','approved','published',${q(f.plans[`training_${type}`])},1,'allow',${q(f.manager)})`,
        `(${q(f.plans[`exam_${type}`])},${q(`[D13-TEST] ${type} exam`)},'company','continuing_or_change',NULL,NULL,2026,1,1,'planned','approved','published',${q(f.plans[`exam_${type}`])},1,'retrain',${q(f.manager)})`
      ]).join(',')};
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES
      ${specialTypes.map((type,index)=>`(${q(f.packages.a1)},${q(f.plans[`training_${type}`])},'special',true,${20+index})`).join(',')};
      INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id) VALUES
      ${specialTypes.map(type=>`(${q(f.packages.a1)},${q({blasting:'爆破',electrical:'电工',welding:'焊工',drilling:'钻探'}[type])},${q(f.plans[`training_${type}`])},${q(type)},${q(f.plans[`exam_${type}`])})`).join(',')};
      INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,shuffle,status,created_by,exam_type,exam_semantic_type,special_type,question_count) VALUES
      ${specialTypes.map(type=>`(${q(specialPapers[type])},${q(f.plans[`exam_${type}`])},${q(`[D13-TEST] ${type} paper`)},'fixed',30,80,3,false,'published',${q(f.manager)},'special','special_exam',${q(type)},10)`).join(',')};
      INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order) VALUES
      ${specialTypes.flatMap(type=>[f.question,...questionIds.slice(0,9)].map((question,index)=>`(${q(specialPapers[type])},${q(question)},${index===0?91:1},${index+1})`)).join(',')};
      INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,status,progress,hours_earned,completed_at) VALUES
      ${specialTypes.map(type=>`(${q(f.plans[`training_${type}`])},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)},'completed',100,1,NOW())`).join(',')}; COMMIT;`);
    const internalMember=scalar(db,`SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.internal)};`);
    asUser(db,f.manager,`SELECT public.training_set_member_special_work_types(${q(internalMember)},ARRAY['爆破','电工','焊工'],'D13 special exams');`);
    asUser(db,f.manager,`SELECT public.site_project_set_drilling_operation(${q(f.projects.a1)},true,'D13 drilling exam');`);
    drillParameterVersion=scalar(db,`WITH v AS (
      INSERT INTO public.system_parameter_versions(parameter_id,scope_id,value,version_no,status,effective_at,change_reason)
      SELECT 'EXAM-DRILL-001',NULL,'true',COALESCE(MAX(version_no),0)+1,'active',NOW(),${q(`D13-${f.suffix}-DRILL-ON`)} FROM public.system_parameter_versions WHERE parameter_id='EXAM-DRILL-001' RETURNING id
    ), a AS (
      INSERT INTO public.system_parameter_version_approvals(version_id,status,submitted_at,approved_at,approval_comment,approval_origin)
      SELECT id,'approved',NOW(),NOW(),'D13 isolated fixture','migration' FROM v
    ) SELECT id FROM v;`);
    for(const type of ['爆破','电工','焊工']) documents.push(scalar(db,`INSERT INTO public.contractor_documents(project_id,employee_id,document_type,certificate_type,certificate_no,valid_from,valid_until,storage_path,review_status,reviewed_by,reviewed_at) VALUES(${q(f.projects.a1)},${q(f.employees.internal)},'special_certificate',${q(type)},${q(`D13-${type}`)},CURRENT_DATE-1,CURRENT_DATE+30,${q(`training-admission/contractor-documents/${f.projects.a1}/d13-${type}.pdf`)},'approved',${q(f.manager)},NOW()) RETURNING id;`));
    const specialAttempts={}; for(const type of specialTypes) specialAttempts[type]=json(start(db,f.users.internal,internalAdmission,'special',type,`special-${type}`));
    check('21 blasting requirement starts exact blasting exam', specialAttempts.blasting.special_type==='blasting' && specialAttempts.blasting.exam_type==='special');
    check('22 electrical requirement starts exact electrical exam', specialAttempts.electrical.special_type==='electrical');
    check('23 welding requirement starts exact welding exam', specialAttempts.welding.special_type==='welding');
    check('24 drilling requirement starts without personal drilling certificate', specialAttempts.drilling.special_type==='drilling');
    const noActual= start(db,f.users.contractor,contractorAdmission,'special','blasting','certificate-only');
    check('25 no actual work means no special exam even for project member', code(noActual,'special_requirement_not_met'));
    const electricPass=json(submit(db,f.users.internal,specialAttempts.electrical.attempt_id,{[f.question]:'B'}));
    const specialState=JSON.parse(asUser(db,f.manager,`SELECT public.training_current_special_requirements(${q(f.projects.a1)},${q(f.employees.internal)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1));
    check('26 one special pass does not satisfy another', electricPass.result==='pass' && specialState.requirements.find(x=>x.special_type==='electrical').exam_requirement==='passed' && specialState.requirements.find(x=>x.special_type==='welding').exam_requirement==='required');
    psql(db,`UPDATE public.exam_papers SET special_type='electrical' WHERE id=${q(specialPapers.welding)};`);
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM public.exam_attempt_events WHERE attempt_id=${q(specialAttempts.welding.attempt_id)}; DELETE FROM public.exam_attempts WHERE id=${q(specialAttempts.welding.attempt_id)}; UPDATE public.training_assignments SET exam_status='pending',exam_attempts=0 WHERE plan_id=${q(f.plans.exam_welding)} AND employee_id=${q(f.employees.internal)}; COMMIT;`);
    check('27 welding cannot use electrical-configured paper', code(start(db,f.users.internal,internalAdmission,'special','welding','wrong-paper'),'special_exam_not_configured'));
    const contractorMember=scalar(db,`SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)};`);
    asUser(db,f.manager,`SELECT public.training_set_member_special_work_types(${q(contractorMember)},ARRAY['爆破'],'D13 missing prerequisite');`);
    check('28 D12 missing certificate/training cannot be bypassed', code(start(db,f.users.contractor,contractorAdmission,'special','blasting','bypass'),'special_requirement_not_met'));
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.site_project_members SET status='left',left_at=NOW(),left_reason='D13 history test' WHERE id=${q(internalMember)}; COMMIT;`);
    const history=json(call(db,f.users.internal,`public.training_exam_get(${q(specialAttempts.drilling.attempt_id)})`));
    check('29 inactive requirement does not delete historical attempt', history.attempt_id===specialAttempts.drilling.attempt_id && code(start(db,f.users.internal,internalAdmission,'special','drilling','inactive'),'project_not_accessible'));
    const summary=asUser(db,f.manager,`SELECT count(*) FROM public.training_exam_project_summary(${q(f.projects.a1)});`);
    check('30 project manager reads summary without answer fields', summary.status===0 && !summary.out.includes('correct_answer'));
    check('31 cross-person project summary is denied', asUser(db,f.users.contractor,`SELECT * FROM public.training_exam_project_summary(${q(f.projects.a2)});`,true).status!==0);
    check('32 legacy exam entry cannot bypass D13 context', asUser(db,f.users.internal,`SELECT public.exam_start(${q(f.plans.exam)});`,true).status!==0);
    const grants=Number(scalar(db,`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN('exam_attempts','exam_attempt_events') AND grantee IN('anon','authenticated');`));
    check('33 attempt tables expose no client write/read grants',grants===0,`grants=${grants}`);
    const eventCount=Number(scalar(db,`SELECT count(*) FROM public.exam_attempt_events WHERE attempt_id=${q(first.attempt_id)} AND actor_subject_id=${q(f.users.internal)} AND event_type IN('started','submitted');`));
    check('34 start and submit transitions are audited',eventCount===2,`events=${eventCount}`);
    check('35 option and question order are fixed per attempt',JSON.stringify(json(call(db,f.users.internal,`public.training_exam_get(${q(first.attempt_id)})`)).questions)==='[]');
    check('36 direct foreign question answer is rejected',code(submit(db,f.users.temp,concurrentIds[0],{[id()]:'A'}),'invalid_answers'));
    const sameStart=json(start(db,f.users.temp,tempAdmission,'admission',null,null));
    check('37 weak-network start retry resumes the same attempt',sameStart.attempt_id===concurrentIds[0] && sameStart.idempotent===true);
    check('38 migration leaves D11/D12 person paths independent',scalar(db,`SELECT count(*) FROM public.training_three_level_profiles WHERE employee_id IN(${q(f.employees.contractor)},${q(f.employees.temp)}) AND person_category IN('contractor','temporary_individual') AND status='not_applicable';`)==='2');
  } finally {
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.exam_attempt_events WHERE attempt_id IN(SELECT id FROM public.exam_attempts WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')}));
      DELETE FROM public.training_special_work_audit_logs WHERE project_id IN(${Object.values(f.projects).map(q).join(',')});
      DELETE FROM public.system_parameter_version_approvals WHERE version_id=${q(drillParameterVersion)};
      DELETE FROM public.system_parameter_versions WHERE id=${q(drillParameterVersion)};
      DELETE FROM public.contractor_documents WHERE id IN(${documents.length?documents.map(q).join(','):'NULL'}); COMMIT;`);
    residual=cleanup(db,f);
    psql(db,`DELETE FROM public.exam_questions WHERE id IN(${questionIds.map(q).join(',')});`);
    residual+=Number(scalar(db,`SELECT count(*) FROM public.exam_questions WHERE id IN(${questionIds.map(q).join(',')});`));
    check('39 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(result=>!result.pass); const seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`D13_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length) process.exit(1);
}

if(require.main===module) main().catch(error=>{console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

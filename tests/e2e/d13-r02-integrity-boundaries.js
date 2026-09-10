/** D13 R02-2 TARGETED: package, parameter, special-exam and scheme integrity. */
const crypto = require('crypto');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { admissionId, asUser, cleanup, createFixture, ids, psql, q, readAuthority, scalar, startSql } = require('./d11-three-level-training-reuse');

const results = [];
const id = () => crypto.randomUUID();
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} R02-2 ${name}${detail ? ` ${detail}` : ''}`); };
const last = run => run.out.split(/\r?\n/).filter(Boolean).at(-1);
const json = run => JSON.parse(last(run));
const denied = (run, code) => run.status !== 0 && run.err.includes(code);
const call = (db, user, sql, allowFailure = false) => asUser(db, user, `SELECT ${sql}::text;`, allowFailure);

async function main() {
  const started = process.hrtime.bigint(); const boundary = validateTestBoundary(); const db = boundary.databaseUrl; const f = ids(); let residual = -1;
  const approver = id(), scope = id(), snapshot = id(), snapshotItem = id(), relation = id(), scheme = id();
  const packageV1 = id(), packageV2 = id(), packagePlan1 = id(), packagePlan2 = id();
  const specialTraining = id(), specialExam = id(), specialPaper = id();
  const specialQuestions = Array.from({ length: 9 }, id); const attempts = [];
  const versions = { v1: null, v2: null, reverse: null }; const parameterVersions = [];
  check('01 isolated TEST boundary', assertD02FixtureMarker(boundary) > 0);
  readAuthority(db, f); createFixture(db, f);
  f.plans.packagePlan1 = packagePlan1; f.plans.packagePlan2 = packagePlan2; f.plans.specialTraining = specialTraining; f.plans.specialExam = specialExam;
  f.packages.integrityV1 = packageV1; f.packages.integrityV2 = packageV2;
  try {
    psql(db, `BEGIN;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000000000',${q(approver)},'authenticated','authenticated',${q(`r02-${f.suffix}-approver@example.invalid`)},crypt('R02-isolated-approver',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW());
      INSERT INTO public.profiles(id,email,role,full_name,is_super_admin,admin_level) VALUES(${q(approver)},${q(`r02-${f.suffix}-approver@example.invalid`)},'admin','[R02-2] approver',false,'company')
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,role='admin',full_name=EXCLUDED.full_name,is_super_admin=false,admin_level='company';
      INSERT INTO public.account_subjects(auth_user_id) VALUES(${q(approver)})
      ON CONFLICT(auth_user_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id;
      INSERT INTO public.account_lifecycle(subject_id) SELECT id FROM public.account_subjects WHERE auth_user_id=${q(approver)}
      ON CONFLICT(subject_id) DO NOTHING;
      INSERT INTO public.training_plans(id,title,level,training_category,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
        (${q(packagePlan1)},'[R02-2] package plan V1','company','basic_three_level',2026,1,1,'planned','approved','published',${q(packagePlan1)},1,'allow',${q(f.manager)}),
        (${q(packagePlan2)},'[R02-2] package plan V2','company','basic_three_level',2026,1,1,'planned','approved','published',${q(packagePlan2)},1,'allow',${q(f.manager)});
      INSERT INTO public.training_admission_packages(id,title,version_no,status,training_category,created_by) VALUES
        (${q(packageV1)},'[R02-2] package',1,'draft','basic_three_level',${q(f.manager)}),
        (${q(packageV2)},'[R02-2] package v2',2,'draft','basic_three_level',${q(f.manager)});
      COMMIT;`);

    check('02 draft package item insert/update allowed', asUser(db, f.manager, `INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES(${q(packageV1)},${q(packagePlan1)},'company',true,1);`).status === 0
      && asUser(db, f.manager, `UPDATE public.training_admission_package_items SET sort_order=2 WHERE package_id=${q(packageV1)};`).status === 0);
    asUser(db, f.manager, `UPDATE public.training_admission_packages SET status='published',approved_by=${q(f.manager)},approved_at=NOW() WHERE id=${q(packageV1)};`);
    check('03 published package item insert denied', denied(asUser(db, f.manager, `INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES(${q(packageV1)},${q(packagePlan2)},'company',true,3);`, true), 'published_package_immutable'));
    check('04 published package item update denied', denied(asUser(db, f.manager, `UPDATE public.training_admission_package_items SET sort_order=4 WHERE package_id=${q(packageV1)};`, true), 'published_package_immutable'));
    check('05 published package item delete denied', denied(asUser(db, f.manager, `DELETE FROM public.training_admission_package_items WHERE package_id=${q(packageV1)};`, true), 'published_package_immutable'));
    psql(db, `BEGIN;
      INSERT INTO public.training_requirement_snapshots(id,employee_id,employment_relation_id,effective_as_of,reason_code,explanation,source,authority_facts)
      VALUES(${q(snapshot)},${q(f.employees.internal)},${q(relation)},CURRENT_DATE,'legacy_d11_compatibility','R02-2 frozen package proof','legacy_d11_compatibility','{}');
      INSERT INTO public.training_requirement_snapshot_items(id,snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,training_package_version_no,required)
      VALUES(${q(snapshotItem)},${q(snapshot)},1,'company','company',${q(packageV1)},${q(packageV1)},1,true);
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES(${q(packageV2)},${q(packagePlan2)},'company',true,1);
      UPDATE public.training_admission_packages SET status='published',approved_by=${q(f.manager)},approved_at=NOW() WHERE id=${q(packageV2)};
      COMMIT;`);
    check('06 V1 snapshot remains pinned after V2', scalar(db, `SELECT training_package_id=${q(packageV1)} AND training_package_version_no=1 FROM public.training_requirement_snapshot_items WHERE id=${q(snapshotItem)};`) === 't'
      && scalar(db, `SELECT count(*) FROM public.training_admission_package_items WHERE package_id=${q(packageV1)} AND plan_id=${q(packagePlan1)};`) === '1'
      && scalar(db, `SELECT count(*) FROM public.training_admission_package_items WHERE package_id=${q(packageV2)} AND plan_id=${q(packagePlan2)};`) === '1');
    const ordinaryPackageWrite = asUser(db, f.users.internal, `UPDATE public.training_admission_package_items SET sort_order=9 WHERE package_id=${q(packageV2)};`, true);
    check('07 ordinary authenticated has no direct package write', ordinaryPackageWrite.status !== 0
      || scalar(db, `SELECT sort_order FROM public.training_admission_package_items WHERE package_id=${q(packageV2)};`) === '1');

    check('08 ordinary user cannot submit parameter', denied(call(db, f.users.internal, `public.system_parameter_set('EXAM-DRILL-001','true',${q(scope)},NOW(),'deny','{}')`, true), 'parameter_forbidden'));
    check('09 client approval spoof rejected', denied(call(db, f.manager, `public.system_parameter_set('EXAM-DRILL-001','true',${q(scope)},NOW(),'spoof','{"approved_by":"fake"}')`, true), 'parameter_approval_spoofed'));
    let submitted = json(call(db, f.manager, `public.system_parameter_set('EXAM-DRILL-001','true',${q(scope)},NOW()+INTERVAL '2 days','future on','{}')`)); parameterVersions.push(submitted.version_id);
    check('10 unapproved future version is ineffective', submitted.status === 'draft' && scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW()+INTERVAL '3 days')->>'value';`) === 'false');
    check('11 submitter cannot self-approve', denied(call(db, f.manager, `public.system_parameter_approve(${q(submitted.version_id)},true,'self','self')`, true), 'parameter_self_approval_forbidden'));
    check('12 independent company admin approval records server actor', call(db, approver, `public.system_parameter_approve(${q(submitted.version_id)},true,'approve future on','approve-on')`).status === 0
      && scalar(db, `SELECT approved_by=(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(approver)}) FROM public.system_parameter_version_approvals WHERE version_id=${q(submitted.version_id)};`) === 't');
    check('13 future ON does not activate early', scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW())->>'value';`) === 'false'
      && scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW()+INTERVAL '2 days 1 second')->>'value';`) === 'true');
    submitted = json(call(db, f.manager, `public.system_parameter_set('EXAM-DRILL-001','true',${q(scope)},NOW(),'current on','{}')`)); parameterVersions.push(submitted.version_id);
    call(db, approver, `public.system_parameter_approve(${q(submitted.version_id)},true,'approve current on','approve-current')`);
    submitted = json(call(db, f.manager, `public.system_parameter_set('EXAM-DRILL-001','false',${q(scope)},NOW()+INTERVAL '4 days','future off','{}')`)); parameterVersions.push(submitted.version_id);
    call(db, approver, `public.system_parameter_approve(${q(submitted.version_id)},true,'approve future off','approve-off')`);
    check('14 future OFF does not retire current early', scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW()+INTERVAL '3 days')->>'value';`) === 'true');
    check('15 effective boundary and history select correct versions', scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW()+INTERVAL '4 days 1 second')->>'value';`) === 'false'
      && scalar(db, `SELECT public.system_parameter_effective('EXAM-DRILL-001',${q(scope)},NOW()-INTERVAL '1 day')->>'value';`) === 'false');
    check('16 approval facts deny direct client mutation', asUser(db, approver, `UPDATE public.system_parameter_version_approvals SET approved_by=NULL WHERE version_id=${q(parameterVersions[0])};`, true).status !== 0);

    psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_plans(id,title,level,training_category,department_id,special_type,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
        (${q(specialTraining)},'[R02-2] electrical training','special','special_operation',${q(f.entityA)},'electrical',2026,1,1,'planned','approved','published',${q(specialTraining)},1,'allow',${q(f.manager)}),
        (${q(specialExam)},'[R02-2] electrical exam','company','continuing_or_change',NULL,NULL,2026,1,1,'planned','approved','published',${q(specialExam)},1,'retrain',${q(f.manager)});
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES
        (${q(f.packages.a1)},${q(specialTraining)},'special',true,20),(${q(f.packages.a2)},${q(specialTraining)},'special',true,20);
      INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id) VALUES
        (${q(f.packages.a1)},'电工',${q(specialTraining)},'electrical',${q(specialExam)}),(${q(f.packages.a2)},'电工',${q(specialTraining)},'electrical',${q(specialExam)});
      INSERT INTO public.exam_questions(id,scope,question_type,stem,options,answer,status,created_by)
      SELECT x,'company','single','[R02-2] electrical','[{"key":"A","text":"safe"}]','A','published',${q(f.manager)} FROM unnest(ARRAY[${specialQuestions.map(q).join(',')}]::uuid[]) x;
      INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,shuffle,status,created_by,exam_type,exam_semantic_type,special_type,question_count)
      VALUES(${q(specialPaper)},${q(specialExam)},'[R02-2] shared electrical paper','fixed',30,80,3,false,'published',${q(f.manager)},'special','special_exam','electrical',10);
      INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order)
      SELECT ${q(specialPaper)},x.id,10,x.n FROM unnest(ARRAY[${q(f.question)},${specialQuestions.map(q).join(',')}]::uuid[]) WITH ORDINALITY x(id,n);
      INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,status,progress,hours_earned,completed_at)
      VALUES(${q(specialTraining)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)},'completed',100,1,NOW()); COMMIT;`);
    psql(db, startSql(f, f.projects.a1, f.employees.internal, f.packages.a1)); psql(db, startSql(f, f.projects.a2, f.employees.internal, f.packages.a2));
    const admissionA = admissionId(db, f.projects.a1, f.employees.internal), admissionB = admissionId(db, f.projects.a2, f.employees.internal);
    const memberA = scalar(db, `SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.internal)};`);
    const memberB = scalar(db, `SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a2)} AND employee_id=${q(f.employees.internal)};`);
    call(db, f.manager, `public.training_set_member_special_work_types(${q(memberA)},ARRAY['electrical'],'R02-2 project A')`);
    call(db, f.manager, `public.training_set_member_special_work_types(${q(memberB)},ARRAY['electrical'],'R02-2 project B')`);
    psql(db, `INSERT INTO public.contractor_documents(project_id,employee_id,document_type,certificate_type,certificate_no,valid_from,valid_until,storage_path,review_status,reviewed_by,reviewed_at)
      VALUES(${q(f.projects.a1)},${q(f.employees.internal)},'special_certificate','电工','R02-A',CURRENT_DATE-1,CURRENT_DATE+30,${q(`training-admission/contractor-documents/${f.projects.a1}/r02-a.pdf`)},'approved',${q(f.manager)},NOW()),
      (${q(f.projects.a2)},${q(f.employees.internal)},'special_certificate','电工','R02-B',CURRENT_DATE-1,CURRENT_DATE+30,${q(`training-admission/contractor-documents/${f.projects.a2}/r02-b.pdf`)},'approved',${q(f.manager)},NOW());`);
    const attemptA = json(call(db, f.users.internal, `public.training_exam_start(${q(admissionA)},'special','electrical','r02-a')`)); attempts.push(attemptA.attempt_id);
    const answers = Object.fromEntries([f.question, ...specialQuestions].map(question => [question, 'A']));
    const passA = json(call(db, f.users.internal, `public.training_exam_submit(${q(attemptA.attempt_id)},${q(JSON.stringify(answers))}::jsonb)`));
    const state = project => JSON.parse(last(asUser(db, f.manager, `SELECT public.training_current_special_requirements(${q(project)},${q(f.employees.internal)})::text;`)));
    check('17 project A pass satisfies only project A', passA.result === 'pass' && state(f.projects.a1).requirements.find(x => x.special_type === 'electrical').exam_requirement === 'passed');
    check('18 same plan does not satisfy project B', state(f.projects.a2).requirements.find(x => x.special_type === 'electrical').exam_requirement === 'required');
    const attemptB = json(call(db, f.users.internal, `public.training_exam_start(${q(admissionB)},'special','electrical','r02-b')`)); attempts.push(attemptB.attempt_id);
    call(db, f.users.internal, `public.training_exam_submit(${q(attemptB.attempt_id)},${q(JSON.stringify(answers))}::jsonb)`);
    check('19 project B requires and records its own pass', state(f.projects.a2).requirements.find(x => x.special_type === 'electrical').exam_requirement === 'passed'
      && scalar(db, `SELECT count(*) FROM public.exam_attempts WHERE id=${q(attemptA.attempt_id)} AND admission_id=${q(admissionA)} AND result='pass';`) === '1');
    check('20 special type remains exact', scalar(db, `SELECT public.training_special_exam_passed(${q(admissionA)},${q(f.projects.a1)},${q(f.employees.internal)},'welding',${q(specialExam)});`) === 'f');

    psql(db, `INSERT INTO public.three_level_training_schemes(id,scheme_code,display_name,created_by,updated_by) VALUES(${q(scheme)},${q(`R02-${f.suffix}`)},'[R02-2] ordered scheme',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(f.manager)}),(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(f.manager)}));`);
    const makeVersion = (date, reason) => json(call(db, f.manager, `public.training_scheme_create_version(${q(scheme)},NULL,${date},${q(reason)},${q(reason)},${q(`${f.suffix}-${reason}`)})`));
    const setStages = version => call(db, f.manager, `public.training_scheme_set_stages(${q(version)},'[${['company','organization','third'].map((level,index) => JSON.stringify({stage_order:index+1,stage_level:level,stage_type:level==='third'?'basic_project':level,training_package_id:packageV1,required:true})).join(',')}]'::jsonb,'stages','stages-${version}')`);
    versions.v1 = makeVersion('CURRENT_DATE', 'V1').id; setStages(versions.v1); call(db, f.manager, `public.training_scheme_publish(${q(versions.v1)},'publish V1','publish-v1')`);
    versions.v2 = makeVersion('CURRENT_DATE+30', 'V2').id; setStages(versions.v2); call(db, f.manager, `public.training_scheme_publish(${q(versions.v2)},'publish V2','publish-v2')`);
    check('21 later V2 publish preserves V1 until boundary', scalar(db, `SELECT effective_to=effective_from+29 FROM public.three_level_training_scheme_versions WHERE id=${q(versions.v1)};`) === 't'
      && scalar(db, `SELECT count(*) FROM public.three_level_training_scheme_versions WHERE scheme_id=${q(scheme)} AND CURRENT_DATE BETWEEN effective_from AND COALESCE(effective_to,'infinity'::date);`) === '1');
    versions.reverse = makeVersion('CURRENT_DATE+10', 'reverse').id; setStages(versions.reverse);
    check('22 reverse effective version rejected', denied(call(db, f.manager, `public.training_scheme_publish(${q(versions.reverse)},'reverse','reverse')`, true), 'scheme_effective_order_invalid'));
    call(db, f.manager, `public.training_scheme_update_draft(${q(versions.reverse)},CURRENT_DATE+30,'same','same','same')`);
    check('23 same effective date rejected', denied(call(db, f.manager, `public.training_scheme_publish(${q(versions.reverse)},'same','same-publish')`, true), 'scheme_effective_order_invalid'));
    check('24 no overlapping effective published versions', scalar(db, `SELECT count(*) FROM public.three_level_training_scheme_versions a JOIN public.three_level_training_scheme_versions b ON b.scheme_id=a.scheme_id AND b.id>a.id AND daterange(a.effective_from,COALESCE(a.effective_to,'infinity'::date),'[]') && daterange(b.effective_from,COALESCE(b.effective_to,'infinity'::date),'[]') WHERE a.scheme_id=${q(scheme)} AND a.status<>'draft' AND b.status<>'draft';`) === '0');
  } finally {
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.exam_attempt_events WHERE attempt_id IN(${attempts.length ? attempts.map(q).join(',') : 'NULL'});
      DELETE FROM public.exam_attempts WHERE id IN(${attempts.length ? attempts.map(q).join(',') : 'NULL'});
      DELETE FROM public.contractor_documents WHERE project_id IN(${q(f.projects.a1)},${q(f.projects.a2)}) AND certificate_no IN('R02-A','R02-B');
      DELETE FROM public.exam_paper_questions WHERE paper_id=${q(specialPaper)}; DELETE FROM public.exam_papers WHERE id=${q(specialPaper)};
      DELETE FROM public.exam_questions WHERE id IN(${specialQuestions.map(q).join(',')});
      DELETE FROM public.training_admission_special_rules WHERE package_id IN(${q(f.packages.a1)},${q(f.packages.a2)});
      DELETE FROM public.training_requirement_snapshot_items WHERE snapshot_id=${q(snapshot)}; DELETE FROM public.training_requirement_snapshots WHERE id=${q(snapshot)};
      DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id IN(SELECT id FROM public.three_level_training_scheme_versions WHERE scheme_id=${q(scheme)});
      DELETE FROM public.three_level_training_scheme_versions WHERE scheme_id=${q(scheme)}; DELETE FROM public.three_level_training_schemes WHERE id=${q(scheme)};
      DELETE FROM public.system_parameter_version_approvals WHERE version_id IN(SELECT id FROM public.system_parameter_versions WHERE scope_id=${q(scope)});
      DELETE FROM public.system_parameter_audit WHERE scope_id=${q(scope)}; DELETE FROM public.system_parameter_versions WHERE scope_id=${q(scope)};
      DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(approver)});
      DELETE FROM public.account_subjects WHERE auth_user_id=${q(approver)}; DELETE FROM public.profiles WHERE id=${q(approver)}; DELETE FROM auth.users WHERE id=${q(approver)};
      COMMIT;`);
    residual = cleanup(db, f);
    residual += Number(scalar(db, `SELECT (SELECT count(*) FROM public.system_parameter_versions WHERE scope_id=${q(scope)})+(SELECT count(*) FROM public.three_level_training_schemes WHERE id=${q(scheme)})+(SELECT count(*) FROM public.training_requirement_snapshots WHERE id=${q(snapshot)})+(SELECT count(*) FROM auth.users WHERE id=${q(approver)});`));
    check('25 cleanup residual = 0', residual === 0, `residual=${residual}`);
  }
  const failed = results.filter(x => !x.pass); const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`R02_2_RESULT ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if (failed.length) process.exit(1);
}

if (require.main === module) main().catch(error => { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')); process.exit(1); });

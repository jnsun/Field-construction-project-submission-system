/** D13 R02-1 TARGETED: lifecycle and object-level authorization boundaries. */
const crypto=require('crypto'); const path=require('path'); const {spawnSync}=require('child_process');
const {validateTestBoundary,assertD02FixtureMarker}=require('./d04-test-environment');
const {asUser,psql,q,scalar,ids,readAuthority,createFixture,cleanup}=require('./d11-three-level-training-reuse');
const {required}=require('./test-config');
const results=[]; const check=(name,pass,detail='')=>{results.push({name,pass:!!pass});console.log(`${pass?'PASS':'FAIL'} R02-1 ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID(); const code=(r,value)=>r.status!==0&&r.err.includes(value);
async function request(base,key,pathname,options={}){const r=await fetch(base+pathname,{...options,signal:AbortSignal.timeout(15000),headers:{apikey:key,...(options.headers||{})}});return{status:r.status,body:await r.text()};}
async function login(b,key,email,password){return request(b.apiOrigin,key,'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});}
function apply(db){if(scalar(db,"SELECT to_regprocedure('public.training_project_person_can_read(uuid,uuid)') IS NOT NULL;")==='t')return;const file=path.join(__dirname,'..','..','sql','training-admission-v95-d13-r02-authorization-boundaries.sql');const r=spawnSync('psql',[db,'-X','-q','-v','ON_ERROR_STOP=1','-f',file],{encoding:'utf8',windowsHide:true});if(r.error||r.status!==0)throw new Error(`v95 failed: ${String(r.stderr||r.error?.message||'').trim().split(/\r?\n/).at(-1)}`);}
async function main(){
  const started=process.hrtime.bigint(),b=validateTestBoundary();assertD02FixtureMarker(b);apply(b.databaseUrl);const key=required('SAFETY_SUPABASE_ANON_KEY');const f=ids();readAuthority(b.databaseUrl,f);
  const users={pm:id(),safety:id(),entityB:id(),targetB:id(),close:id(),ordinary:id()}; const employees={targetB:id(),close:id(),ordinary:id()};
  Object.assign(f.users,users); Object.assign(f.employees,employees);
  const emails=Object.fromEntries(Object.keys(users).map(k=>[k,`r02-${f.suffix}-${k}@example.invalid`]));const password=`R02-${crypto.randomUUID()}!`;const admissions={a:id(),b:id()};let residual=-1;
  try{
    createFixture(b.databaseUrl,f);
    const entityAUser=scalar(b.databaseUrl,`SELECT u.id FROM auth.users u WHERE u.email=${q(required('SAFETY_TEST_ENTITY_EMAIL'))};`);if(!entityAUser)throw new Error('entity A fixture unavailable');
    psql(b.databaseUrl,`BEGIN;
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES
       (${q(employees.targetB)},'[R02] target B',${q(`R02-${f.suffix}-B`)},${q(f.entityB)},'员工','employee','active','R02-TEST'),
       (${q(employees.close)},'[R02] close target',${q(`R02-${f.suffix}-C`)},${q(f.entityA)},'员工','employee','active','R02-TEST'),
       (${q(employees.ordinary)},'[R02] ordinary',${q(`R02-${f.suffix}-O`)},${q(f.entityA)},'员工','employee','active','R02-TEST');
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
       ${Object.keys(users).map(k=>`('00000000-0000-0000-0000-000000000000',${q(users[k])},'authenticated','authenticated',${q(emails[k])},crypt(${q(password)},gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW())`).join(',')};
      INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,admin_level) VALUES
       (${q(users.pm)},${q(emails.pm)},NULL,NULL,'employee','[R02] pm',NULL),
       (${q(users.safety)},${q(emails.safety)},NULL,NULL,'employee','[R02] safety',NULL),
       (${q(users.entityB)},${q(emails.entityB)},NULL,${q(f.entityB)},'admin','[R02] entity B','dept'),
       (${q(users.targetB)},${q(emails.targetB)},${q(employees.targetB)},${q(f.entityB)},'employee','[R02] target B',NULL),
       (${q(users.close)},${q(emails.close)},${q(employees.close)},${q(f.entityA)},'employee','[R02] close target',NULL),
       (${q(users.ordinary)},${q(emails.ordinary)},${q(employees.ordinary)},${q(f.entityA)},'employee','[R02] ordinary',NULL)
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,employee_id=EXCLUDED.employee_id,department_id=EXCLUDED.department_id,
       role=EXCLUDED.role,full_name=EXCLUDED.full_name,admin_level=EXCLUDED.admin_level;
      INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by) VALUES
       (${q(f.projects.a1)},${q(users.pm)},'project_manager',TRUE,${q(f.manager)}),
       (${q(f.projects.a1)},${q(users.safety)},'safety_officer',TRUE,${q(f.manager)});
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES
       (${q(f.projects.b1)},${q(employees.targetB)},'internal','active',${q(f.manager)}),
       (${q(f.projects.a1)},${q(employees.close)},'internal','active',${q(f.manager)}),
       (${q(f.projects.a1)},${q(employees.ordinary)},'internal','active',${q(f.manager)});
      INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,reason,source)
      SELECT m.project_id,m.employee_id,public.training_member_primary_path(m),TRUE,m.joined_at,'R02 fixture sync','R02-TEST'
      FROM public.site_project_members m WHERE m.project_id=${q(f.projects.a1)} AND m.employee_id IN(${q(f.employees.internal)},${q(f.employees.unknown)})
      ON CONFLICT(project_id,employee_id) DO NOTHING;
      INSERT INTO public.project_person_admission_path_history(project_id,employee_id,old_path,new_path,old_active,new_active,effective_at,reason,source,version_no)
      SELECT p.project_id,p.employee_id,NULL,p.primary_path,NULL,p.active,p.effective_at,'R02 fixture sync','R02-TEST',p.version_no
      FROM public.project_person_admission_paths p WHERE p.project_id=${q(f.projects.a1)} AND p.employee_id IN(${q(f.employees.internal)},${q(f.employees.unknown)})
      AND NOT EXISTS(SELECT 1 FROM public.project_person_admission_path_history h WHERE h.project_id=p.project_id AND h.employee_id=p.employee_id);
      INSERT INTO public.training_three_level_profiles(employee_id,person_category,onboarding_category,status,employment_started_on,relation_source,completed_at) VALUES
       (${q(f.employees.internal)},'formal_internal','legacy_verified','verified',CURRENT_DATE,'R02-TEST',NOW()),
       (${q(employees.targetB)},'formal_internal','legacy_verified','verified',CURRENT_DATE,'R02-TEST',NOW());
      COMMIT;`);
    const memberA=scalar(b.databaseUrl,`SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.internal)};`);
    const memberB=scalar(b.databaseUrl,`SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.b1)} AND employee_id=${q(employees.targetB)};`);
    psql(b.databaseUrl,`BEGIN;SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_admissions(id,project_id,member_id,employee_id,package_id) VALUES
       (${q(admissions.a)},${q(f.projects.a1)},${q(memberA)},${q(f.employees.internal)},${q(f.packages.a1)}),
       (${q(admissions.b)},${q(f.projects.b1)},${q(memberB)},${q(employees.targetB)},${q(f.packages.b1)});COMMIT;`);

    const beforeLogin=await login(b,key,emails.close,password);check('01 fixture account logs in before close',beforeLogin.status===200);
    let r=asUser(b.databaseUrl,f.manager,`SELECT public.training_employees_batch_delete(ARRAY[${q(employees.close)}]::uuid[]);`);check('02 batch entry succeeds without physical delete',r.status===0&&scalar(b.databaseUrl,`SELECT count(*) FROM auth.users WHERE id=${q(users.close)};`)==='1'&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_employees WHERE id=${q(employees.close)};`)==='1');
    check('03 lifecycle and employee status are closed',scalar(b.databaseUrl,`SELECT l.status||':'||e.status FROM public.account_lifecycle l JOIN public.account_subjects s ON s.id=l.subject_id JOIN public.training_employees e ON e.id=s.employee_id WHERE s.auth_user_id=${q(users.close)};`)==='closed:left');
    check('04 lifecycle audit preserves operator',Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.account_lifecycle_history h JOIN public.account_subjects s ON s.id=h.subject_id WHERE s.auth_user_id=${q(users.close)} AND h.new_status='closed' AND h.operator_subject_id IS NOT NULL;`))===1);
    const afterLogin=await login(b,key,emails.close,password);check('05 closed account cannot log in',afterLogin.status>=400);
    r=asUser(b.databaseUrl,f.manager,`SELECT public.training_employees_batch_delete(ARRAY[${q(employees.close)}]::uuid[]);`);check('06 duplicate close is idempotent',r.status===0&&Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.account_lifecycle_history h JOIN public.account_subjects s ON s.id=h.subject_id WHERE s.auth_user_id=${q(users.close)} AND h.new_status='closed';`))===1);
    check('07 ordinary user cannot batch deactivate',code(asUser(b.databaseUrl,users.ordinary,`SELECT public.training_employees_batch_delete(ARRAY[${q(employees.targetB)}]::uuid[]);`,true),'account_forbidden'));

    check('08 project manager reads own project member',asUser(b.databaseUrl,users.pm,`SELECT public.training_three_level_status(${q(f.projects.a1)},${q(f.employees.internal)});`).status===0);
    check('09 project manager cannot read nonmember',code(asUser(b.databaseUrl,users.pm,`SELECT public.training_three_level_status(${q(f.projects.a1)},${q(employees.targetB)});`,true),'[D11:forbidden]'));
    check('10 safety officer cannot generate nonmember requirement',code(asUser(b.databaseUrl,users.safety,`SELECT public.training_ensure_three_level_requirement(${q(employees.targetB)},${q(f.projects.a1)},'R02-denied');`,true),'[S3D:forbidden]'));
    check('11 denied generation creates no snapshot',scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshots WHERE employee_id=${q(employees.targetB)};`)==='0');
    check('12 company authority remains',asUser(b.databaseUrl,f.manager,`SELECT public.training_three_level_status(${q(f.projects.b1)},${q(employees.targetB)});`).status===0);

    check('13 entity A reads A primary path',JSON.parse(asUser(b.databaseUrl,entityAUser,`SELECT public.training_primary_admission_path(${q(f.projects.a1)},${q(f.employees.internal)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1)).primary_path==='employee');
    check('14 entity A cannot read B primary path',scalar(b.databaseUrl,`SELECT count(*) FROM public.project_person_admission_paths WHERE project_id=${q(f.projects.b1)} AND employee_id=${q(employees.targetB)};`)==='1'&&asUser(b.databaseUrl,entityAUser,`SELECT public.training_primary_admission_path(${q(f.projects.b1)},${q(employees.targetB)}) IS NULL;`).out.split(/\r?\n/).filter(Boolean).at(-1)==='t');
    check('15 entity A cannot read B history',scalar(b.databaseUrl,`SELECT count(*) FROM public.project_person_admission_path_history WHERE project_id=${q(f.projects.b1)} AND employee_id=${q(employees.targetB)};`)>='1'&&asUser(b.databaseUrl,entityAUser,`SELECT count(*) FROM public.project_person_admission_path_history WHERE project_id=${q(f.projects.b1)} AND employee_id=${q(employees.targetB)};`).out.split(/\r?\n/).filter(Boolean).at(-1)==='0');
    check('16 entity B reads B primary path',asUser(b.databaseUrl,users.entityB,`SELECT public.training_primary_admission_path(${q(f.projects.b1)},${q(employees.targetB)});`).out.includes('employee'));
    check('17 unresolved effective entity fails closed',asUser(b.databaseUrl,entityAUser,`SELECT public.training_primary_admission_path(${q(f.projects.a1)},${q(f.employees.unknown)}) IS NULL;`).out.split(/\r?\n/).filter(Boolean).at(-1)==='t');

    check('18 self reads own exam context',asUser(b.databaseUrl,f.users.internal,`SELECT public.training_exam_requirement_context(${q(admissions.a)},'admission',NULL);`).status===0);
    check('19 self cannot read another admission',code(asUser(b.databaseUrl,f.users.internal,`SELECT public.training_exam_requirement_context(${q(admissions.b)},'admission',NULL);`,true),'[D13:forbidden]'));
    check('20 project manager reads own project context',asUser(b.databaseUrl,users.pm,`SELECT public.training_exam_requirement_context(${q(admissions.a)},'admission',NULL);`).status===0);
    check('21 project manager cannot read other project context',code(asUser(b.databaseUrl,users.pm,`SELECT public.training_exam_requirement_context(${q(admissions.b)},'admission',NULL);`,true),'[D13:forbidden]'));
    check('22 entity A cannot read entity B context',code(asUser(b.databaseUrl,entityAUser,`SELECT public.training_exam_requirement_context(${q(admissions.b)},'admission',NULL);`,true),'[D13:forbidden]'));
    check('23 ordinary authenticated guess is denied',code(asUser(b.databaseUrl,users.ordinary,`SELECT public.training_exam_requirement_context(${q(admissions.b)},'admission',NULL);`,true),'[D13:forbidden]'));
    check('24 nonexistent admission is stable not_found',code(asUser(b.databaseUrl,users.ordinary,`SELECT public.training_exam_requirement_context(${q(id())},'admission',NULL);`,true),'[D13:exam_not_found]'));
    const context=JSON.parse(asUser(b.databaseUrl,users.pm,`SELECT public.training_exam_requirement_context(${q(admissions.a)},'admission',NULL)::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1));check('25 context exposes only contract fields',Object.keys(context).sort().join(',')==='admission_id,employee_id,exam_semantic_type,legacy_exam_type,primary_admission_path,project_id,special_type');
  }finally{
    psql(b.databaseUrl,`BEGIN;SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_admissions WHERE id IN(${q(admissions.a)},${q(admissions.b)});
      DELETE FROM public.training_employee_versions WHERE employee_id IN(${Object.values(f.employees).map(q).join(',')});COMMIT;`,true);
    cleanup(b.databaseUrl,f);
    residual=Number(scalar(b.databaseUrl,`SELECT
      (SELECT count(*) FROM auth.users WHERE id IN(${Object.values(users).map(q).join(',')}))+
      (SELECT count(*) FROM public.training_employees WHERE id IN(${Object.values(employees).map(q).join(',')}))+
      (SELECT count(*) FROM public.site_projects WHERE id IN(${Object.values(f.projects).map(q).join(',')}));`));
    check('26 residual=0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass);console.log(`R02-1 authorization results: ${results.length-failed.length}/${results.length} PASS; residual=${residual}; duration=${(Number(process.hrtime.bigint()-started)/1e9).toFixed(2)}s`);if(failed.length)process.exitCode=1;
}
main().catch(e=>{console.error(String(e.stack||e.message||e));process.exitCode=1;});

/** D16 authoritative site confirmation TARGETED evidence. */
const crypto=require('crypto');
const {spawn}=require('child_process');
const {validateTestBoundary,assertD02FixtureMarker}=require('./d04-test-environment');
const {admissionId,asUser,cleanup:createBaseCleanup,createFixture,ids,psql,q,readAuthority,scalar,startSql}=require('./d11-three-level-training-reuse');
const results=[];let residual=0;
const check=(name,pass,detail='')=>{results.push({name,pass});console.log(`${pass?'PASS':'FAIL'} D16 ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID();
const json=r=>{const line=String(r.out||r).split(/\r?\n/).filter(x=>x.startsWith('{')||x.startsWith('[')).at(-1);if(!line)throw new Error(r.err||'missing JSON result');return JSON.parse(line);};
const call=(db,user,expr,fail=false)=>asUser(db,user,`SELECT ${expr}::text;`,fail);
const code=r=>(String(r.err||'').match(/\[D16:([^\]]+)\]/)||[])[1]||'';
const asyncUser=(db,user,sql)=>new Promise(resolve=>{const child=spawn('psql',[db,'-X','-Atq','-v','ON_ERROR_STOP=1'],{windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',status=>resolve({status,out:out.trim(),err:err.trim()}));child.stdin.end(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(user)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); ${sql} COMMIT;`);});
function upload(db,p,owner,mime='image/png',size=1200){psql(db,`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata) VALUES('certificates',${q(p.storage_path)},${q(owner)},${q(owner)},${q(JSON.stringify({mimetype:mime,size}))}::jsonb,'{}') ON CONFLICT(bucket_id,name) DO UPDATE SET owner=EXCLUDED.owner,owner_id=EXCLUDED.owner_id,metadata=EXCLUDED.metadata,updated_at=clock_timestamp();`);}
function validate(db,p,{mime='image/png',size=1200,width=640,height=480,sha=crypto.createHash('sha256').update(p.storage_path).digest('hex')}={}){return psql(db,`BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',true); SELECT public.training_site_confirmation_record_photo_validation(${q(p.challenge_id)},${q(mime)},${size},${width},${height},${q(sha)},'D16-TEST-DECODED'); COMMIT;`,true);}
function prepare(db,user,req,fail=false){return call(db,user,`public.training_site_confirmation_prepare(${q(req)})`,fail);}
function submit(db,user,p,key,location='NULL',fail=false){return call(db,user,`public.training_site_confirmation_submit(${q(p.challenge_id)},${q(p.nonce)},${q(key)},${location},'${JSON.stringify({platform:'D16-TEST'})}'::jsonb)`,fail);}
function cleanup(db,f,paths){const projects=Object.values(f.projects).map(q).join(','),employees=Object.values(f.employees).map(q).join(',');psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
DELETE FROM public.training_site_confirmation_locations WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}));
DELETE FROM public.training_site_confirmation_results WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}));
DELETE FROM public.training_site_confirmation_photo_validations WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}));
DELETE FROM public.training_site_confirmation_challenges WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}));
DELETE FROM public.training_site_confirmation_events WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}));
DELETE FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects});
DELETE FROM storage.objects WHERE bucket_id='certificates' AND name=ANY(ARRAY[${paths.length?paths.map(q).join(','):"'D16-NONE'"}]); COMMIT;`);
const base=createBaseCleanup(db,f);return base+Number(scalar(db,`SELECT (SELECT count(*) FROM public.training_site_confirmation_requirements WHERE project_id IN(${projects}))+(SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name LIKE 'training-admission/site-confirmation/%' AND owner_id IN(${Object.values(f.users).map(q).join(',')}));`));}
async function main(){const started=process.hrtime.bigint(),boundary=validateTestBoundary();assertD02FixtureMarker(boundary);const db=boundary.databaseUrl,f=ids(),paths=[];f.users.temp=id();f.employees.temp=id();readAuthority(db,f);try{
  createFixture(db,f);
  psql(db,`BEGIN;
    INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark)
      VALUES(${q(f.employees.temp)},'[D16-TEST] temporary',${q(`D16-${f.suffix}-TEMP`)},${q(f.entityA)},'临时个人','employee','active','D16-TEST');
    INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000000000',${q(f.users.temp)},'authenticated','authenticated',${q(`d16-${f.suffix}-temp@example.invalid`)},crypt('D16-isolated-temp',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
    INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,is_super_admin)
      VALUES(${q(f.users.temp)},${q(`d16-${f.suffix}-temp@example.invalid`)},${q(f.employees.temp)},${q(f.entityA)},'employee','[D16-TEST] temporary',false)
      ON CONFLICT(id) DO UPDATE SET employee_id=EXCLUDED.employee_id,department_id=EXCLUDED.department_id,role='employee',full_name=EXCLUDED.full_name,is_super_admin=false;
    INSERT INTO public.account_subjects(auth_user_id,employee_id) VALUES(${q(f.users.temp)},${q(f.employees.temp)})
      ON CONFLICT(auth_user_id) DO UPDATE SET employee_id=EXCLUDED.employee_id;
    INSERT INTO public.account_lifecycle(subject_id) SELECT id FROM public.account_subjects WHERE auth_user_id=${q(f.users.temp)} ON CONFLICT(subject_id) DO NOTHING;
    INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES(${q(f.projects.a1)},${q(f.employees.temp)},'temporary','active',${q(f.manager)});
    COMMIT;`);
  asUser(db,f.manager,`SELECT public.training_set_three_level_classification(${q(f.employees.temp)},'temporary_individual','not_applicable',NULL,'D16 TEST',NULL);`);
  psql(db,`INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,reason,source)
    SELECT m.project_id,m.employee_id,public.training_member_primary_path(m),m.status='active',m.joined_at,'D16 fixture sync','D16-TEST'
    FROM public.site_project_members m WHERE m.project_id IN(${Object.values(f.projects).map(q).join(',')})
    ON CONFLICT(project_id,employee_id) DO UPDATE SET primary_path=EXCLUDED.primary_path,active=EXCLUDED.active,reason=EXCLUDED.reason,source=EXCLUDED.source,changed_at=NOW();`);
  check('01 v107 capability is installed',scalar(db,"SELECT to_regprocedure('public.training_site_confirmation_submit(uuid,text,text,jsonb,jsonb)') IS NOT NULL;")==='t');
  check('02 direct authenticated requirement table privilege is absent',scalar(db,"SELECT has_table_privilege('authenticated','public.training_site_confirmation_requirements','SELECT');")==='f');
  check('03 direct authenticated result write privilege is absent',scalar(db,"SELECT has_table_privilege('authenticated','public.training_site_confirmation_results','INSERT');")==='f');
  check('04 result table has RLS',scalar(db,"SELECT relrowsecurity FROM pg_class WHERE oid='public.training_site_confirmation_results'::regclass;")==='t');
  check('05 confirmer mode is exact current project role',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_authority_internal(uuid)'::regprocedure) LIKE '%project_manager%''safety_officer%';")==='t');
  psql(db,startSql(f,f.projects.a1,f.employees.contractor,f.packages.a1));const admission=admissionId(db,f.projects.a1,f.employees.contractor);
  psql(db,`BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.exam_papers SET exam_type='admission',exam_semantic_type='project_induction_exam' WHERE id=${q(f.paper)};
  INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
    VALUES(${q(f.plans.exam)},${q(f.employees.contractor)},${q(f.users.contractor)},${q(f.entityA)})
    ON CONFLICT(plan_id,employee_id) DO NOTHING;
  UPDATE public.training_admissions SET exam_assignment_id=(SELECT id FROM public.training_assignments WHERE plan_id=${q(f.plans.exam)} AND employee_id=${q(f.employees.contractor)}) WHERE id=${q(admission)};
  INSERT INTO public.exam_attempts(id,paper_id,assignment_id,employee_id,attempt_no,questions,deadline_at,submitted_at,answers,score,result,status,project_id,admission_id,exam_type,rule_snapshot,exam_semantic_type)
  VALUES(${q(id())},${q(f.paper)},(SELECT exam_assignment_id FROM public.training_admissions WHERE id=${q(admission)}),${q(f.employees.contractor)},1,'[]',NOW()+INTERVAL '30 minutes',NOW(),'{}',100,'pass','submitted',${q(f.projects.a1)},${q(admission)},'admission','{"rule_version":"D16-TEST"}','project_induction_exam');
  INSERT INTO public.site_project_roles(project_id,user_id,role,active) VALUES(${q(f.projects.a1)},${q(f.users.internal)},'safety_officer',TRUE); COMMIT;`);
  const ensured=json(call(db,f.manager,`public.training_site_confirmation_ensure(${q(admission)},'D16-initial')`));const req=ensured.id;
  check('06 manager creates exact admission requirement',ensured.admission_id===admission&&ensured.project_id===f.projects.a1&&ensured.employee_id===f.employees.contractor);
  check('07 primary admission path is frozen',ensured.primary_admission_path==='contractor');
  check('08 first cycle is current pending',ensured.cycle_no===1&&ensured.status==='pending'&&ensured.is_current===true);
  check('09 prerequisite consumes current authoritative chain',ensured.prerequisite?.satisfied===true);
  psql(db,startSql(f,f.projects.a1,f.employees.temp,f.packages.a1));const tempAdmission=admissionId(db,f.projects.a1,f.employees.temp);
  psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id) VALUES(${q(f.plans.exam)},${q(f.employees.temp)},${q(f.users.temp)},${q(f.entityA)}) ON CONFLICT(plan_id,employee_id) DO NOTHING;
    UPDATE public.training_admissions SET exam_assignment_id=(SELECT id FROM public.training_assignments WHERE plan_id=${q(f.plans.exam)} AND employee_id=${q(f.employees.temp)}) WHERE id=${q(tempAdmission)};
    INSERT INTO public.exam_attempts(id,paper_id,assignment_id,employee_id,attempt_no,questions,deadline_at,submitted_at,answers,score,result,status,project_id,admission_id,exam_type,rule_snapshot,exam_semantic_type)
    VALUES(${q(id())},${q(f.paper)},(SELECT exam_assignment_id FROM public.training_admissions WHERE id=${q(tempAdmission)}),${q(f.employees.temp)},1,'[]',NOW()+INTERVAL '30 minutes',NOW(),'{}',100,'pass','submitted',${q(f.projects.a1)},${q(tempAdmission)},'admission','{"rule_version":"D16-TEST"}','project_induction_exam'); COMMIT;`);
  const tempReq=json(call(db,f.manager,`public.training_site_confirmation_ensure(${q(tempAdmission)},'D16-temp')`));
  check('09A temporary individual receives the same site gate',tempReq.primary_admission_path==='temporary_individual'&&tempReq.prerequisite.satisfied===true);
  psql(db,startSql(f,f.projects.a2,f.employees.internal,f.packages.a2));const employeeAdmission=admissionId(db,f.projects.a2,f.employees.internal);
  const employeeReq=json(call(db,f.manager,`public.training_site_confirmation_ensure(${q(employeeAdmission)},'D16-employee')`));
  check('09B formal employee receives a site requirement and consumes D11',employeeReq.primary_admission_path==='employee'&&Array.isArray(employeeReq.prerequisite.blocked_reasons)&&employeeReq.prerequisite.blocked_reasons.includes('three_level_training_not_completed'));
  check('10 repeated ensure is idempotent',json(call(db,f.manager,`public.training_site_confirmation_ensure(${q(admission)},'D16-repeat')`)).id===req&&scalar(db,`SELECT count(*) FROM public.training_site_confirmation_requirements WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)};`)==='1');
  check('11 ordinary person cannot self-confirm',code(prepare(db,f.users.contractor,req,true))==='site_confirmation_forbidden');
  check('12 safety officer can prepare own project',json(prepare(db,f.users.internal,req)).status==='prepared');
  check('13 safety officer cannot manage another project',code(call(db,f.users.internal,`public.training_site_confirmation_project_list(${q(f.projects.a2)})`,true))==='site_confirmation_forbidden');
  check('14 project manager can list own project',json(call(db,f.manager,`public.training_site_confirmation_project_list(${q(f.projects.a1)})`)).some(x=>x.requirement_id===req));
  check('15 prepare returns separate private photo path',json(prepare(db,f.manager,req)).storage_path.startsWith(`training-admission/site-confirmation/${req}/`));
  const revoked=json(prepare(db,f.users.internal,req));paths.push(revoked.storage_path);upload(db,revoked,f.users.internal);validate(db,revoked);psql(db,`UPDATE public.site_project_roles SET active=FALSE WHERE project_id=${q(f.projects.a1)} AND user_id=${q(f.users.internal)} AND role='safety_officer';`);
  check('16 role revocation after prepare denies submit',code(submit(db,f.users.internal,revoked,'revoked','NULL',true))==='site_confirmation_forbidden');psql(db,`UPDATE public.site_project_roles SET active=TRUE WHERE project_id=${q(f.projects.a1)} AND user_id=${q(f.users.internal)} AND role='safety_officer';`);
  const bad=json(prepare(db,f.manager,req));paths.push(bad.storage_path);upload(db,bad,f.manager,'image/svg+xml');
  check('17 unsupported decoded MIME is rejected',validate(db,bad,{mime:'image/svg+xml'}).status!==0);
  check('18 invalid decoded dimensions are rejected',validate(db,bad,{width:1,height:1}).status!==0);
  const prepared=json(prepare(db,f.manager,req));paths.push(prepared.storage_path);upload(db,prepared,f.manager);check('19 unvalidated photo cannot submit',code(submit(db,f.manager,prepared,'unvalidated','NULL',true))==='site_confirmation_photo_invalid');
  check('20 controlled service records decoded photo fact',validate(db,prepared).status===0);
  const done=json(submit(db,f.manager,prepared,'manager-confirm','NULL'));
  check('21 valid required photo completes confirmation',done.status==='confirmed'&&!done.idempotent);
  check('22 server chooses confirmed_at',!!done.confirmed_at&&Number.isNaN(Date.parse('1900'))===false&&new Date(done.confirmed_at).getUTCFullYear()>=2026);
  check('23 missing location remains pending without blocking',done.location_status==='pending');
  check('24 repeated submit is idempotent',json(submit(db,f.manager,prepared,'manager-confirm','NULL')).idempotent===true);
  check('25 exactly one immutable result exists',scalar(db,`SELECT count(*) FROM public.training_site_confirmation_results WHERE requirement_id=${q(req)};`)==='1');
  check('26 result uses stable subject identity',scalar(db,`SELECT confirmer_subject_id IS NOT NULL FROM public.training_site_confirmation_results WHERE requirement_id=${q(req)};`)==='t');
  check('27 evidence digest binds actual photo hash',scalar(db,`SELECT evidence_snapshot->'photo_validation'->>'content_sha256'=photo_content_sha256 FROM public.training_site_confirmation_results WHERE requirement_id=${q(req)};`)==='t');
  check('28 direct result rewrite is blocked',psql(db,`UPDATE public.training_site_confirmation_results SET confirmed_at=NOW() WHERE requirement_id=${q(req)};`,true).status!==0);
  const loc=json(call(db,f.manager,`public.training_site_confirmation_supplement_location(${q(req)},'{"latitude":31.2,"longitude":121.5,"accuracy_m":12}'::jsonb,'D16-location-1')`));
  check('29 later location is bound to original result',loc.requirement_id===req&&!!loc.result_id&&loc.status==='present');
  check('30 repeated identical location is idempotent',json(call(db,f.manager,`public.training_site_confirmation_supplement_location(${q(req)},'{"latitude":31.2,"longitude":121.5,"accuracy_m":12}'::jsonb,'D16-location-1')`)).idempotent===true);
  check('31 location cannot be overwritten',code(call(db,f.manager,`public.training_site_confirmation_supplement_location(${q(req)},'{"latitude":0,"longitude":0}'::jsonb,'D16-location-2')`,true))==='site_confirmation_immutable');
  const oldFingerprint=scalar(db,`SELECT confirmed_at::text||'|'||evidence_digest||'|'||photo_content_sha256 FROM public.training_site_confirmation_results WHERE requirement_id=${q(req)};`);
  psql(db,`UPDATE public.site_projects SET status='paused' WHERE id=${q(f.projects.a1)};`);
  check('32 project pause invalidates current confirmation',scalar(db,`SELECT status||'|'||is_current FROM public.training_site_confirmation_requirements WHERE id=${q(req)};`)==='invalidated|false');
  check('33 paused project has no satisfied current result',json(call(db,f.users.contractor,`public.training_site_confirmation_status(${q(f.projects.a1)},NULL)`)).satisfied===false);
  psql(db,`UPDATE public.site_projects SET status='active' WHERE id=${q(f.projects.a1)};`);const req2=scalar(db,`SELECT id FROM public.training_site_confirmation_requirements WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)} AND is_current;`);
  check('34 resume creates a new cycle for active personnel',!!req2&&req2!==req&&scalar(db,`SELECT cycle_no FROM public.training_site_confirmation_requirements WHERE id=${q(req2)};`)==='2');
  check('35 previous/new cycle are linked',scalar(db,`SELECT previous_requirement_id FROM public.training_site_confirmation_requirements WHERE id=${q(req2)};`)===req);
  check('36 old result/photo/digest remain unchanged',scalar(db,`SELECT confirmed_at::text||'|'||evidence_digest||'|'||photo_content_sha256 FROM public.training_site_confirmation_results WHERE requirement_id=${q(req)};`)===oldFingerprint);
  psql(db,`UPDATE public.site_project_members SET status='left',left_at=NOW(),left_reason='D16 test' WHERE id=(SELECT member_id FROM public.training_admissions WHERE id=${q(admission)});`);
  check('37 inactive membership invalidates current cycle',scalar(db,`SELECT status FROM public.training_site_confirmation_requirements WHERE id=${q(req2)};`)==='invalidated');
  psql(db,`UPDATE public.site_project_members SET status='active',left_at=NULL,left_reason=NULL WHERE id=(SELECT member_id FROM public.training_admissions WHERE id=${q(admission)});`);const req3=scalar(db,`SELECT id FROM public.training_site_confirmation_requirements WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)} AND is_current;`);
  check('38 member reactivation requires a new confirmation',!!req3&&req3!==req2&&scalar(db,`SELECT cycle_no FROM public.training_site_confirmation_requirements WHERE id=${q(req3)};`)==='3');
  check('39 only one active state exists per project/person',scalar(db,`SELECT count(*) FROM public.training_site_confirmation_requirements WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)} AND is_current;`)==='1');
  check('40 visitor path is explicitly excluded by contract SQL',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_create_internal(uuid,uuid,text,text,text,uuid)'::regprocedure) LIKE '%v_path=''visitor''%';")==='t');
  check('41 D11 prerequisite applies only to employee path',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)'::regprocedure) LIKE '%v_path=''employee''%training_three_level_status%';")==='t');
  check('42 exact D13 project/person/admission binding is enforced',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)'::regprocedure) LIKE '%a.admission_id=p_requirement.admission_id%a.project_id=p_requirement.project_id%a.employee_id=p_requirement.employee_id%';")==='t');
  check('43 D12 current special requirements are consumed',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)'::regprocedure) LIKE '%training_special_requirements_internal%';")==='t');
  check('44 applicable D15 signatures are ensured and unsigned required nodes fail closed',scalar(db,"SELECT pg_get_functiondef('public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)'::regprocedure) LIKE '%training_signature_ensure_requirements%status<>''signed''%';")==='t');
  check('45 generic supersede rejects ordinary personnel',code(call(db,f.users.contractor,`public.training_site_confirmation_supersede(${q(req3)},'future_event','D16-future-1','controlled future event')`,true))==='site_confirmation_forbidden');
  const next=json(call(db,f.manager,`public.training_site_confirmation_supersede(${q(req3)},'future_event','D16-future-1','controlled future event')`));
  check('46 authorized source event creates successor cycle',next.old_requirement_id===req3&&next.new_requirement_id!==req3&&next.cycle_no===4);
  const repeated=json(call(db,f.manager,`public.training_site_confirmation_supersede(${q(req3)},'future_event','D16-future-1','controlled future event')`));
  check('47 repeated source event is idempotent',repeated.new_requirement_id===next.new_requirement_id&&scalar(db,`SELECT count(*) FROM public.training_site_confirmation_requirements WHERE source_event_type='future_event' AND source_reference='D16-future-1';`)==='1');
  const current=next.new_requirement_id,p1=json(prepare(db,f.manager,current)),p2=json(prepare(db,f.users.internal,current));paths.push(p1.storage_path,p2.storage_path);upload(db,p1,f.manager);upload(db,p2,f.users.internal);validate(db,p1);validate(db,p2);
  const race=await Promise.all([asyncUser(db,f.manager,`SELECT public.training_site_confirmation_submit(${q(p1.challenge_id)},${q(p1.nonce)},'D16-race-manager',NULL,'{}')::text;`),asyncUser(db,f.users.internal,`SELECT public.training_site_confirmation_submit(${q(p2.challenge_id)},${q(p2.nonce)},'D16-race-safety',NULL,'{}')::text;`)]);
  check('48 concurrent ANY_OF submissions converge on one result',race.every(x=>x.status===0)&&scalar(db,`SELECT count(*) FROM public.training_site_confirmation_results WHERE requirement_id=${q(current)};`)==='1');
  check('49 audit retains creation, confirmation and lifecycle events',Number(scalar(db,`SELECT count(*) FROM public.training_site_confirmation_events WHERE requirement_id IN(SELECT id FROM public.training_site_confirmation_requirements WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.contractor)});`))>=10);
  check('50 ordinary response contains no identity-card plaintext',!JSON.stringify(json(call(db,f.users.contractor,`public.training_site_confirmation_status(${q(f.projects.a1)},NULL)`))).toLowerCase().includes('identity_card'));
 }finally{residual=cleanup(db,f,paths);check('51 cleanup residual = 0',residual===0,`residual=${residual}`);}
 const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;console.log(`D16_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);if(failed.length)process.exit(1);
}
if(require.main===module)main().catch(e=>{console.error(String(e.message||e).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

/** D15 TARGETED: policy versions, authoritative signers, immutable digest/files/history and concurrency. */
const crypto=require('crypto'); const path=require('path'); const {spawn,spawnSync}=require('child_process');
const {validateTestBoundary,assertD02FixtureMarker}=require('./d04-test-environment');
const {required}=require('./test-config');
const {admissionId,asUser,cleanup:cleanupBase,createFixture,ids,psql,q,readAuthority,scalar,startSql}=require('./d11-three-level-training-reuse');
const root=path.resolve(__dirname,'..','..'),migration=path.join(root,'sql','training-admission-v98-electronic-signature-evidence.sql'),r02Migration=path.join(root,'sql','training-admission-v103-d15-r02-authority-prerequisites.sql'),r02CycleMigration=path.join(root,'sql','training-admission-v104-d15-organization-signers-and-resign-cycle.sql'),r02FileMigration=path.join(root,'sql','training-admission-v105-d15-file-validation-signed-time.sql'),r02ValidatorMigration=path.join(root,'sql','training-admission-v106-d15-validator-role-correction.sql');
const segment=(process.argv.find(x=>x.startsWith('--segment='))||'').split('=')[1]||'';
const results=[]; const check=(name,pass,detail='')=>{results.push({name,pass:!!pass});console.log(`${pass?'PASS':'FAIL'} D15 ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID(); const json=run=>{const line=run.out.split(/\r?\n/).filter(x=>x.startsWith('{')||x.startsWith('[')).at(-1);if(!line)throw new Error(run.err||'missing JSON');return JSON.parse(line);};
const code=(run,value)=>run.status!==0&&run.err.includes(`[D15:${value}]`);
const call=(db,user,expr,fail=false)=>asUser(db,user,`SELECT ${expr}::text;`,fail);
const jwtSql=(user,sql)=>`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(user)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); ${sql} COMMIT;`;
function asyncUser(db,user,sql){return new Promise(resolve=>{const c=spawn('psql',[db,'-X','-Atq','-v','ON_ERROR_STOP=1'],{windowsHide:true});let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.on('close',status=>resolve({status,out:out.trim(),err:err.trim()}));c.stdin.end(jwtSql(user,sql));});}
function applyFile(db,file,label){const r=spawnSync('psql',[db,'-X','-q','-v','ON_ERROR_STOP=1','-f',file],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(`${label} failed: ${String(r.stderr).trim().split(/\r?\n/).at(-1)}`);}
function apply(db){if(scalar(db,"SELECT to_regclass('public.training_signature_policies') IS NOT NULL;")!=='t')applyFile(db,migration,'v98');applyFile(db,r02Migration,'v103');if(scalar(db,"SELECT to_regclass('public.training_signature_cycles') IS NOT NULL;")!=='t')applyFile(db,r02CycleMigration,'v104');if(scalar(db,"SELECT to_regclass('public.training_signature_file_validations') IS NOT NULL;")!=='t')applyFile(db,r02FileMigration,'v105');applyFile(db,r02ValidatorMigration,'v106');}
function upload(db,prepared,owner,{mime='image/png',size=1200,width=640,height=240}={}){psql(db,`INSERT INTO storage.objects(bucket_id,name,owner,owner_id,metadata,user_metadata)
  VALUES('certificates',${q(prepared.storage_path)},${q(owner)},${q(owner)},${q(JSON.stringify({mimetype:mime,size}))}::jsonb,${q(JSON.stringify({width,height}))}::jsonb)
  ON CONFLICT(bucket_id,name) DO UPDATE SET owner=EXCLUDED.owner,owner_id=EXCLUDED.owner_id,metadata=EXCLUDED.metadata,user_metadata=EXCLUDED.user_metadata;`);}
function validateFixture(db,prepared,{mime='image/png',size=1200,width=640,height=240}={}){const sha=crypto.createHash('sha256').update(prepared.storage_path).digest('hex');psql(db,`BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',true); SELECT public.training_signature_record_file_validation(${q(prepared.challenge_id)},${q(mime)},${size},${width},${height},${q(sha)},'D15-TEST-DECODED'); COMMIT;`);}
function prepare(db,user,requirement,fail=false){return call(db,user,`public.training_signature_prepare(${q(requirement)})`,fail);}
function submit(db,user,p,key=id(),device={platform:'D15-TEST'}){return call(db,user,`public.training_signature_submit(${q(p.challenge_id)},${q(p.nonce)},${q(key)},${q(JSON.stringify(device))}::jsonb)`,true);}
function prepareUploadSubmit(db,user,requirement,key=id()){const p=json(prepare(db,user,requirement));upload(db,p,user);validateFixture(db,p);const run=submit(db,user,p,key);if(run.status!==0){const meta=scalar(db,`SELECT jsonb_build_object('mime',metadata->>'mimetype','size',metadata->>'size','width',user_metadata->>'width','height',user_metadata->>'height','owner_match',COALESCE(owner_id,owner::text)=${q(user)},'png_path',lower(name)~'\\.png$')::text FROM storage.objects WHERE bucket_id='certificates' AND name=${q(p.storage_path)};`);throw new Error(`${run.err}\nD15_FILE_META ${meta}`);}return {prepared:p,result:json(run)};}

async function main(){
  const started=process.hrtime.bigint(),b=validateTestBoundary(),db=b.databaseUrl,f=ids();assertD02FixtureMarker(b);apply(db);readAuthority(db,f);
  const admin=scalar(db,`SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.email=${q(required('SAFETY_TEST_ADMIN_EMAIL'))} AND (p.is_super_admin OR p.admin_level='company');`);
  if(!admin)throw new Error('公司管理员测试账号不可用');
  const extra={orgA:id(),orgB:id(),directOrg:id(),deptSigner:id(),logisticsSigner:id(),otherSigner:id(),pm:id(),safety:id(),otherPm:id(),outsider:id()};
  const testOrg={department:id(),otherDepartment:id(),logistics:id(),other:id()};
  const scheme=id(),schemeVersion=id(),rule=id(),assignment=id(),assignment3=id(),assignment4=id(),snapshot=id(),snapshot2=id(),snapshot3=id(),snapshot4=id(),relation=id(),relation2=id(),relation3=id(),relation4=id(),paperAssignment=id(),examAttempt=id(),wrongSemanticAttempt=id(),wrongAdmissionAttempt=id();
  const snapItems=[id(),id(),id()],snap2Items=[id(),id(),id()],snap3Items=[id(),id(),id()],snap4Items=[id(),id(),id()],recordIds=[id(),id(),id()],snap2RecordIds=[id(),id(),id()],snap4RecordIds=[id(),id(),id()],policy={id:null,v1:null,v2:null};
  let admission,admissionB,requirements=[],residual=-1,paths=[];
  check('01 isolated TEST boundary',true);
  try{
    createFixture(db,f);
    admission=psql(db,startSql(f,f.projects.a1,f.employees.internal,f.packages.a1)).out.split(/\r?\n/).filter(Boolean).at(-1)||admissionId(db,f.projects.a1,f.employees.internal);
    admissionB=psql(db,startSql(f,f.projects.b1,f.employees.internal,f.packages.b1)).out.split(/\r?\n/).filter(Boolean).at(-1)||admissionId(db,f.projects.b1,f.employees.internal);
    const subject=scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(f.users.internal)};`);
    const authRows=Object.entries(extra).map(([k,u])=>`('00000000-0000-0000-0000-000000000000',${q(u)},'authenticated','authenticated',${q(`d15-${f.suffix}-${k}@example.invalid`)},crypt('D15-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW())`).join(',');
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES ${authRows};
      INSERT INTO public.profiles(id,email,department_id,role,admin_level,full_name,is_super_admin) VALUES
      (${q(extra.orgA)},${q(`d15-${f.suffix}-orga@example.invalid`)},${q(f.entityA)},'admin','dept','[D15-TEST] org A',FALSE),
      (${q(extra.orgB)},${q(`d15-${f.suffix}-orgb@example.invalid`)},${q(f.entityB)},'admin','dept','[D15-TEST] org B',FALSE),
      (${q(extra.directOrg)},${q(`d15-${f.suffix}-direct@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] direct org',FALSE),
      (${q(extra.deptSigner)},${q(`d15-${f.suffix}-dept@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] department',FALSE),
      (${q(extra.logisticsSigner)},${q(`d15-${f.suffix}-logistics@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] logistics',FALSE),
      (${q(extra.otherSigner)},${q(`d15-${f.suffix}-other@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] other unit',FALSE),
      (${q(extra.pm)},${q(`d15-${f.suffix}-pm@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] PM',FALSE),
      (${q(extra.safety)},${q(`d15-${f.suffix}-safety@example.invalid`)},${q(f.entityA)},'employee',NULL,'[D15-TEST] safety',FALSE),
      (${q(extra.otherPm)},${q(`d15-${f.suffix}-otherpm@example.invalid`)},${q(f.entityB)},'employee',NULL,'[D15-TEST] other PM',FALSE),
      (${q(extra.outsider)},${q(`d15-${f.suffix}-out@example.invalid`)},${q(f.entityB)},'employee',NULL,'[D15-TEST] outsider',FALSE);
      INSERT INTO public.account_subjects(auth_user_id) VALUES ${Object.values(extra).map(q).map(x=>`(${x})`).join(',')};
      INSERT INTO public.account_lifecycle(subject_id) SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')});
      INSERT INTO public.organization_units(id,organization_code,name,organization_type,effective_from) VALUES
      (${q(testOrg.department)},${q(`D15-DEPT-${f.suffix}`)},'[D15-TEST] finance','internal_department',CURRENT_DATE),
      (${q(testOrg.otherDepartment)},${q(`D15-DEPT2-${f.suffix}`)},'[D15-TEST] party','internal_department',CURRENT_DATE),
      (${q(testOrg.logistics)},${q(`D15-LOG-${f.suffix}`)},'[D15-TEST] logistics','logistics_center',CURRENT_DATE),
      (${q(testOrg.other)},${q(`D15-OTHER-${f.suffix}`)},'[D15-TEST] other','other_internal_unit',CURRENT_DATE);
      INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by) VALUES
      (${q(f.projects.a1)},${q(extra.pm)},'project_manager',TRUE,${q(f.manager)}),(${q(f.projects.a1)},${q(extra.safety)},'safety_officer',TRUE,${q(f.manager)}),
      (${q(f.projects.b1)},${q(extra.otherPm)},'project_manager',TRUE,${q(f.manager)});
      INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,reason,source)
      VALUES(${q(f.projects.a1)},${q(f.employees.internal)},'employee',TRUE,NOW(),'D15-R02 fixture','test'),
            (${q(f.projects.b1)},${q(f.employees.internal)},'employee',TRUE,NOW(),'D15-R02 fixture','test')
      ON CONFLICT(project_id,employee_id) DO UPDATE SET primary_path=EXCLUDED.primary_path,active=TRUE;
      INSERT INTO public.training_three_level_profiles(employee_id,employment_relation_id,person_category,onboarding_category,status,employment_started_on,relation_source)
      VALUES(${q(f.employees.internal)},${q(relation)},'formal_internal','new_hire','required','2026-01-01','D15-TEST'),
            (${q(f.employees.missing)},${q(relation2)},'formal_internal','new_hire','required','2026-01-01','D15-TEST'),
            (${q(f.employees.concurrent)},${q(relation3)},'formal_internal','new_hire','required','2026-01-01','D15-TEST');
      INSERT INTO public.employment_organization_assignments(id,employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason)
      VALUES(${q(assignment)},${q(relation)},${q(f.employees.internal)},${q(f.entityA)},'2026-01-01',TRUE,1,'D15-TEST'),
            (${q(id())},${q(relation2)},${q(f.employees.missing)},${q(f.entityA)},'2026-01-01',TRUE,1,'D15-TEST'),
            (${q(assignment3)},${q(relation3)},${q(f.employees.concurrent)},${q(f.entityA)},'2026-01-01',TRUE,1,'D15-TEST');
      INSERT INTO public.three_level_training_schemes(id,scheme_code,display_name) VALUES(${q(scheme)},${q(`D15-${f.suffix}`)},'[D15-TEST] scheme');
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary,published_by,published_at)
      VALUES(${q(schemeVersion)},${q(scheme)},1,'published',CURRENT_DATE-10,'D15-TEST',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW());
      INSERT INTO public.three_level_training_applicability_rules(id,rule_code,scheme_id,organization_unit_id,effective_from,priority,active)
      VALUES(${q(rule)},${q(`D15-${f.suffix}`)},${q(scheme)},${q(f.entityA)},CURRENT_DATE-10,100,TRUE);
      INSERT INTO public.training_requirement_snapshots(id,employee_id,subject_id,employment_relation_id,organization_assignment_id,organization_unit_id,matched_applicability_rule_id,scheme_id,scheme_version_id,effective_as_of,reason_code,explanation,authority_facts)
      VALUES(${q(snapshot)},${q(f.employees.internal)},${q(subject)},${q(relation)},${q(assignment)},${q(f.entityA)},${q(rule)},${q(scheme)},${q(schemeVersion)},CURRENT_DATE,'resolved','D15-TEST','{}'),
            (${q(snapshot2)},${q(f.employees.missing)},NULL,${q(relation2)},(SELECT id FROM public.employment_organization_assignments WHERE employment_relation_id=${q(relation2)}),${q(f.entityA)},${q(rule)},${q(scheme)},${q(schemeVersion)},CURRENT_DATE+2,'resolved','D15-TEST','{}'),
            (${q(snapshot3)},${q(f.employees.concurrent)},NULL,${q(relation3)},${q(assignment3)},${q(f.entityA)},${q(rule)},${q(scheme)},${q(schemeVersion)},CURRENT_DATE,'resolved','D15-TEST','{}');
      INSERT INTO public.training_requirement_snapshot_items(id,snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,training_package_version_no,required,site_project_id)
      VALUES(${q(snapItems[0])},${q(snapshot)},1,'company','company',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snapItems[1])},${q(snapshot)},2,'organization','organization',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snapItems[2])},${q(snapshot)},3,'third','actual_project',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,${q(f.projects.a1)}),
      (${q(snap2Items[0])},${q(snapshot2)},1,'company','company',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap2Items[1])},${q(snapshot2)},2,'organization','organization',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap2Items[2])},${q(snapshot2)},3,'third','department_position',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap3Items[0])},${q(snapshot3)},1,'company','company',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap3Items[1])},${q(snapshot3)},2,'organization','organization',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap3Items[2])},${q(snapshot3)},3,'third','department_position',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL);
      INSERT INTO public.training_assignments(id,plan_id,employee_id,user_id,department_id,status) VALUES
      (${q(paperAssignment)},${q(f.plans.exam)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)},'completed') ON CONFLICT(plan_id,employee_id) DO UPDATE SET status='completed' RETURNING id;
      INSERT INTO public.training_three_level_records(id,employee_id,employment_relation_id,level,plan_id,assignment_id,third_level_mode,source_project_id,status,planned_hours,required_hours,effective_hours,plan_version_root_id,plan_version_no,requirement_snapshot_id,requirement_snapshot_item_id,stage_type,organization_unit_id,training_package_id,training_package_version_no)
      VALUES(${q(recordIds[0])},${q(f.employees.internal)},${q(relation)},'company',${q(f.plans.company)},NULL,NULL,NULL,'pending',1,0.5,0,${q(f.plans.company)},1,${q(snapshot)},${q(snapItems[0])},'company',${q(f.entityA)},${q(f.packages.a1)},1),
      (${q(recordIds[1])},${q(f.employees.internal)},${q(relation)},'entity',${q(f.plans.entityA)},NULL,NULL,NULL,'completed',1,0.5,1,${q(f.plans.entityA)},1,${q(snapshot)},${q(snapItems[1])},'organization',${q(f.entityA)},${q(f.packages.a1)},1),
      (${q(recordIds[2])},${q(f.employees.internal)},${q(relation)},'third',${q(f.plans.projectA1)},NULL,'actual_project',${q(f.projects.a1)},'completed',1,0.5,1,${q(f.plans.projectA1)},1,${q(snapshot)},${q(snapItems[2])},'actual_project',${q(f.entityA)},${q(f.packages.a1)},1);
      UPDATE public.exam_papers SET exam_type='admission',exam_semantic_type='employee_comprehensive_admission_exam',special_type=NULL WHERE id=${q(f.paper)};
      INSERT INTO public.exam_attempts(id,paper_id,assignment_id,employee_id,attempt_no,questions,deadline_at,submitted_at,answers,score,result,status,project_id,admission_id,exam_type,rule_snapshot,exam_semantic_type)
      VALUES(${q(wrongSemanticAttempt)},${q(f.paper)},(SELECT id FROM public.training_assignments WHERE plan_id=${q(f.plans.exam)} AND employee_id=${q(f.employees.internal)}),${q(f.employees.internal)},1,'[]',NOW()+INTERVAL '30 minutes',NOW(),'{}',100,'pass','submitted',${q(f.projects.a1)},${q(admission)},'admission','{"rule_version":"D15-R02"}','project_induction_exam'),
            (${q(wrongAdmissionAttempt)},${q(f.paper)},(SELECT id FROM public.training_assignments WHERE plan_id=${q(f.plans.exam)} AND employee_id=${q(f.employees.internal)}),${q(f.employees.internal)},2,'[]',NOW()+INTERVAL '30 minutes',NOW()+INTERVAL '1 second','{}',100,'pass','submitted',${q(f.projects.b1)},${q(admissionB)},'admission','{"rule_version":"D15-R02"}','employee_comprehensive_admission_exam');
      COMMIT;`);

    const fullNodes=[
      {node_code:'stage-1',node_type:'employee_stage_acknowledgement',stage_order:1,required:true,sequence_no:1,signer_mode:'SINGLE',signer_roles:['employee']},
      {node_code:'stage-2',node_type:'employee_stage_acknowledgement',stage_order:2,required:true,sequence_no:2,signer_mode:'SINGLE',signer_roles:['employee']},
      {node_code:'stage-3',node_type:'employee_stage_acknowledgement',stage_order:3,required:true,sequence_no:3,signer_mode:'SINGLE',signer_roles:['employee']},
      {node_code:'org-confirm',node_type:'organization_responsible_confirmation',applies_stage_type:'actual_project',required:true,sequence_no:4,signer_mode:'SINGLE',signer_roles:['organization_responsible']},
      {node_code:'project-confirm',node_type:'project_manager_or_safety_confirmation',applies_stage_type:'actual_project',required:true,sequence_no:5,signer_mode:'ANY_OF',signer_roles:['project_manager','safety_officer']},
      {node_code:'employee-final',node_type:'employee_final_acknowledgement',required:true,sequence_no:6,signer_mode:'SINGLE',signer_roles:['employee'],requires_exam:false}
    ];
    const nodes=segment==='organization'
      ? [{node_code:'org-confirm',node_type:'organization_responsible_confirmation',applies_stage_type:'actual_project',required:true,sequence_no:1,signer_mode:'SINGLE',signer_roles:['organization_responsible']}]
      : segment==='supersede'
        ? [{node_code:'stage-1',node_type:'employee_stage_acknowledgement',stage_order:1,required:true,sequence_no:1,signer_mode:'SINGLE',signer_roles:['employee']}]
        : fullNodes;
    const created=json(call(db,admin,`public.training_signature_policy_create(${q(`D15-${f.suffix}`)},'[D15-TEST] policy',${q(scheme)},CURRENT_DATE-1,'D15','create',${q(`${f.suffix}-create`)})`));
    policy.id=created.policy_id;policy.v1=created.policy_version_id;if(!segment)check('02 company admin creates draft policy',created.status==='draft');
    const saved=json(call(db,admin,`public.training_signature_policy_save_draft(${q(policy.v1)},${q(JSON.stringify(nodes))}::jsonb,CURRENT_DATE-1,'V1','save',${q(`${f.suffix}-save`)})`));
    if(!segment)check('03 controlled draft nodes are editable',saved.node_count===6);
    if(!segment)check('04 entity admin cannot manage company policy',code(call(db,extra.orgA,`public.training_signature_policy_create('DENY-${f.suffix}','deny',NULL,CURRENT_DATE,'deny','deny',NULL)`,true),'signature_forbidden'));
    const published=json(call(db,admin,`public.training_signature_policy_publish(${q(policy.v1)},'publish',${q(`${f.suffix}-publish`)})`));if(!segment)check('05 policy V1 publishes',published.status==='published');
    if(!segment)check('06 published policy is immutable',code(call(db,admin,`public.training_signature_policy_save_draft(${q(policy.v1)},${q(JSON.stringify(nodes))}::jsonb,CURRENT_DATE,'rewrite','rewrite',NULL)`,true),'signature_policy_immutable'));
    if(segment==='organization'){
      psql(db,`UPDATE public.training_three_level_records SET status='completed',effective_hours=1,completed_at=NOW() WHERE id=${q(recordIds[0])};`);
      const ensured=json(call(db,f.users.internal,`public.training_signature_ensure_requirements(${q(snapshot)},${q(admission)},${q(`${f.suffix}-org`)})`));requirements=ensured.requirements;
      const orgRequirement=requirements.find(x=>x.node_code==='org-confirm').id;
      const roleTargets=[[extra.directOrg,f.entityA],[extra.deptSigner,testOrg.department],[extra.logisticsSigner,testOrg.logistics],[extra.otherSigner,testOrg.other]];
      const roleSubjects=Object.fromEntries(roleTargets.map(([user])=>[user,scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)};`)]));
      const roleIds=[];
      for(const [user,org] of roleTargets){const granted=json(call(db,admin,`public.training_organization_role_grant(${q(roleSubjects[user])},${q(org)},'organization_responsible',NULL,NULL,'D15 segmented role',${q(`${f.suffix}-${user}`)})`));roleIds.push(granted.id);}
      const authority=(user,org)=>scalar(db,`SELECT public.training_organization_signer_authority(${q(roleSubjects[user]||scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)};`))},${q(org)},clock_timestamp());`)==='t';
      check('R02-2A-ORG operating entity signer is authorized',authority(extra.directOrg,f.entityA));
      check('R02-2A-ORG department, logistics and other-unit signers are authorized',authority(extra.deptSigner,testOrg.department)&&authority(extra.logisticsSigner,testOrg.logistics)&&authority(extra.otherSigner,testOrg.other));
      check('R02-2A-ORG stable subject plus organization and active role define authority',roleTargets.every(([user,org])=>authority(user,org)));
      check('R02-2A-ORG cross-organization authority is denied',!authority(extra.deptSigner,testOrg.otherDepartment)&&!authority(extra.logisticsSigner,testOrg.department));
      check('R02-2A-ORG company admin is not automatically an organization signer',!authority(admin,testOrg.department));
      const legacySubject=scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(extra.orgA)};`);
      check('R02-2A-ORG legacy entity admin bridge is limited to own operating entity',scalar(db,`SELECT public.training_organization_signer_authority(${q(legacySubject)},${q(f.entityA)},clock_timestamp())::text||'|'||public.training_organization_signer_authority(${q(legacySubject)},${q(f.entityB)},clock_timestamp())::text;`)==='true|false');
      check('R02-2A-ORG ordinary client cannot grant organization signer role',code(call(db,f.users.internal,`public.training_organization_role_grant(${q(roleSubjects[extra.deptSigner])},${q(testOrg.department)},'organization_responsible',NULL,NULL,'forged','forged')`,true),'signature_forbidden'));
      const prepared=json(prepare(db,extra.directOrg,orgRequirement));upload(db,prepared,extra.directOrg);paths.push(prepared.storage_path);
      json(call(db,admin,`public.training_organization_role_revoke(${q(roleIds[0])},'segmented revoke after prepare',${q(`${f.suffix}-revoke`)})`));
      check('R02-2A-ORG revoked role after prepare cannot submit',code(submit(db,extra.directOrg,prepared,'revoked'),'signature_forbidden'));
    }else if(segment==='supersede'){
      psql(db,`UPDATE public.training_three_level_records SET status='completed',effective_hours=1,completed_at=NOW() WHERE id=${q(recordIds[0])};`);
      const ensured=json(call(db,f.users.internal,`public.training_signature_ensure_requirements(${q(snapshot)},${q(admission)},${q(`${f.suffix}-old-cycle`)})`));requirements=ensured.requirements;
      const oldRequirement=requirements[0],oldSigned=prepareUploadSubmit(db,f.users.internal,oldRequirement.id,'old-signed');paths.push(oldSigned.prepared.storage_path);
      const oldCycle=oldRequirement.requirement_cycle_id;
      const oldResult=scalar(db,`SELECT id::text||'|'||evidence_digest||'|'||storage_path FROM public.training_signature_results WHERE requirement_id=${q(oldRequirement.id)};`);
      const oldImage=scalar(db,`SELECT id::text||'|'||version||'|'||updated_at::text||'|'||metadata::text FROM storage.objects WHERE bucket_id='certificates' AND name=${q(oldSigned.prepared.storage_path)};`);
      const v2=json(call(db,admin,`public.training_signature_policy_create_version(${q(policy.id)},${q(policy.v1)},CURRENT_DATE+1,'V2 segmented','new cycle',${q(`${f.suffix}-v2`)})`));policy.v2=v2.id;
      const v2Nodes=[
        {node_code:'org-confirm',node_type:'organization_responsible_confirmation',applies_stage_type:'department_position',required:true,sequence_no:1,signer_mode:'SINGLE',signer_roles:['organization_responsible']},
        {node_code:'employee-final',node_type:'employee_final_acknowledgement',required:true,sequence_no:2,signer_mode:'SINGLE',signer_roles:['employee'],requires_exam:false}
      ];
      json(call(db,admin,`public.training_signature_policy_save_draft(${q(policy.v2)},${q(JSON.stringify(v2Nodes))}::jsonb,CURRENT_DATE+1,'V2 segmented','save',${q(`${f.suffix}-v2-save`)})`));
      json(call(db,admin,`public.training_signature_policy_publish(${q(policy.v2)},'publish V2',${q(`${f.suffix}-v2-publish`)})`));
      psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
        INSERT INTO public.employment_organization_assignments(id,employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason) VALUES(${q(assignment4)},${q(relation4)},${q(f.employees.internal)},${q(f.entityA)},CURRENT_DATE+1,TRUE,1,'D15 segmented successor');
        INSERT INTO public.training_requirement_snapshots(id,employee_id,subject_id,employment_relation_id,organization_assignment_id,organization_unit_id,matched_applicability_rule_id,scheme_id,scheme_version_id,effective_as_of,reason_code,explanation,authority_facts) VALUES(${q(snapshot4)},${q(f.employees.internal)},${q(subject)},${q(relation4)},${q(assignment4)},${q(f.entityA)},${q(rule)},${q(scheme)},${q(schemeVersion)},CURRENT_DATE+2,'resolved','D15 segmented successor','{}');
        INSERT INTO public.training_requirement_snapshot_items(id,snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,training_package_version_no,required,site_project_id) VALUES
        (${q(snap4Items[0])},${q(snapshot4)},1,'company','company',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),(${q(snap4Items[1])},${q(snapshot4)},2,'organization','organization',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),(${q(snap4Items[2])},${q(snapshot4)},3,'third','department_position',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL);
        INSERT INTO public.training_three_level_records(id,employee_id,employment_relation_id,level,plan_id,third_level_mode,status,planned_hours,required_hours,effective_hours,plan_version_root_id,plan_version_no,requirement_snapshot_id,requirement_snapshot_item_id,stage_type,organization_unit_id,training_package_id,training_package_version_no,completed_at) VALUES
        (${q(snap4RecordIds[0])},${q(f.employees.internal)},${q(relation4)},'company',${q(f.plans.company)},NULL,'pending',1,0.5,0,${q(f.plans.company)},1,${q(snapshot4)},${q(snap4Items[0])},'company',${q(f.entityA)},${q(f.packages.a1)},1,NULL),(${q(snap4RecordIds[1])},${q(f.employees.internal)},${q(relation4)},'entity',${q(f.plans.entityA)},NULL,'completed',1,0.5,1,${q(f.plans.entityA)},1,${q(snapshot4)},${q(snap4Items[1])},'organization',${q(f.entityA)},${q(f.packages.a1)},1,NOW()),(${q(snap4RecordIds[2])},${q(f.employees.internal)},${q(relation4)},'third',${q(f.plans.projectA1)},NULL,'completed',1,0.5,1,${q(f.plans.projectA1)},1,${q(snapshot4)},${q(snap4Items[2])},'department_position',${q(f.entityA)},${q(f.packages.a1)},1,NOW()); COMMIT;`);
      const directSubject=scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(extra.directOrg)};`);
      json(call(db,admin,`public.training_organization_role_grant(${q(directSubject)},${q(f.entityA)},'organization_responsible',NULL,NULL,'D15 successor signer',${q(`${f.suffix}-successor-role`)})`));
      check('R02-2A-CYCLE employee cannot trigger supersede',code(call(db,f.users.internal,`public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'forged','employee-forged')`,true),'signature_forbidden'));
      const concurrent=await Promise.all([asyncUser(db,admin,`SELECT public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'segmented successor','${f.suffix}-a')::text;`),asyncUser(db,admin,`SELECT public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'segmented successor','${f.suffix}-b')::text;`)]);
      const cycleResults=concurrent.map(json),newCycle=cycleResults[0].new_cycle_id;
      check('R02-2A-CYCLE concurrent source creates one successor',concurrent.every(x=>x.status===0)&&cycleResults.every(x=>x.new_cycle_id===newCycle)&&scalar(db,`SELECT count(*) FROM public.training_signature_cycles WHERE previous_cycle_id=${q(oldCycle)};`)==='1');
      const repeated=json(call(db,admin,`public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'segmented successor','repeat')`));
      check('R02-2A-CYCLE repeated source is idempotent',repeated.idempotent&&repeated.new_cycle_id===newCycle);
      check('R02-2A-CYCLE successor uses authoritative Snapshot and current policy',repeated.requirement_snapshot_id===snapshot4&&repeated.policy_version_id===policy.v2);
      check('R02-2A-CYCLE complete required node set is rebuilt',Number(repeated.requirement_count)===v2Nodes.length&&scalar(db,`SELECT count(*) FROM public.training_signature_requirements WHERE requirement_cycle_id=${q(newCycle)};`)===String(v2Nodes.length));
      check('R02-2A-CYCLE previous and successor are linked',scalar(db,`SELECT status||'|'||(superseded_by_cycle_id=${q(newCycle)})::text FROM public.training_signature_cycles WHERE id=${q(oldCycle)};`)==='superseded|true');
      const retained=scalar(db,`SELECT id::text||'|'||evidence_digest||'|'||storage_path FROM public.training_signature_results WHERE requirement_id=${q(oldRequirement.id)};`);
      check('R02-2A-CYCLE old signed result is unchanged',retained===oldResult);
      check('R02-2A-CYCLE old digest is unchanged',retained.split('|')[1]===oldResult.split('|')[1]);
      check('R02-2A-CYCLE old image is unchanged',scalar(db,`SELECT id::text||'|'||version||'|'||updated_at::text||'|'||metadata::text FROM storage.objects WHERE bucket_id='certificates' AND name=${q(oldSigned.prepared.storage_path)};`)===oldImage);
      const newOrg=scalar(db,`SELECT id FROM public.training_signature_requirements WHERE requirement_cycle_id=${q(newCycle)} AND node_code='org-confirm';`);
      check('R02-2A-CYCLE rebuilt management node keeps hard prerequisite',code(prepare(db,extra.directOrg,newOrg,true),'signature_prerequisite_not_met'));
    }else{
    check('R02-01 cross-project admission is rejected',code(call(db,f.users.internal,`public.training_signature_ensure_requirements(${q(snapshot)},${q(admissionB)},'wrong-project')`,true),'signature_project_mismatch'));
    const ensured=json(call(db,f.users.internal,`public.training_signature_ensure_requirements(${q(snapshot)},${q(admission)},${q(`${f.suffix}-ensure`)})`));requirements=ensured.requirements;
    check('07 server creates only policy-defined requirements',ensured.status==='required'&&requirements.length===6);
    check('R02-02 project scope comes only from Snapshot',requirements.find(x=>x.node_code==='project-confirm').project_id===f.projects.a1&&requirements.filter(x=>x.node_code!=='project-confirm').every(x=>x.project_id===null));
    check('08 policy/version and signer roles freeze on requirements',requirements.every(x=>x.policy_version_id===policy.v1)&&requirements.find(x=>x.node_code==='project-confirm').signer_mode==='ANY_OF');
    check('09 repeated ensure is idempotent',json(call(db,f.users.internal,`public.training_signature_ensure_requirements(${q(snapshot)},${q(admission)},'again')`)).requirements.length===6&&scalar(db,`SELECT count(*) FROM public.training_signature_requirements WHERE requirement_snapshot_id=${q(snapshot)};`)==='6');
    const req=Object.fromEntries(requirements.map(x=>[x.node_code,x.id]));
    check('10 incomplete stage cannot prepare',code(prepare(db,f.users.internal,req['stage-1'],true),'signature_prerequisite_not_met'));
    psql(db,`BEGIN;SET LOCAL session_replication_role=replica;UPDATE public.training_three_level_records SET status='completed',effective_hours=1,completed_at=NOW() WHERE id=${q(recordIds[0])};COMMIT;`);
    const stale=json(prepare(db,f.users.internal,req['stage-1']));check('11 completed stage prepares server digest',stale.evidence_digest.length===64&&stale.summary.requirement_snapshot.id===snapshot);
    check('12 digest binds package versions',stale.summary.training_packages.length===3&&stale.summary.training_packages.every(x=>x.package_version_no===1));
    check('13 employee cannot prepare another signer node',code(prepare(db,f.users.internal,req['org-confirm'],true),'signature_forbidden'));
    psql(db,`BEGIN;SET LOCAL session_replication_role=replica;UPDATE public.training_three_level_records SET effective_hours=1.25 WHERE id=${q(recordIds[0])};COMMIT;`);upload(db,stale,f.users.internal);paths.push(stale.storage_path);
    check('14 changed evidence rejects old challenge',code(submit(db,f.users.internal,stale,'stale'),'signature_evidence_changed'));
    const stage1=prepareUploadSubmit(db,f.users.internal,req['stage-1'],'stage1');paths.push(stage1.prepared.storage_path);check('15 legal employee stage submit succeeds',stage1.result.status==='signed'&&!stage1.result.idempotent);
    const repeat=json(submit(db,f.users.internal,stage1.prepared,'stage1'));check('16 repeated submit is idempotent',repeat.idempotent&&repeat.result_id===stage1.result.result_id&&repeat.signed_at===stage1.result.signed_at&&repeat.evidence_digest===stage1.result.evidence_digest);
    check('17 another person cannot sign employee node',code(prepare(db,f.users.contractor,req['stage-2'],true),'signature_forbidden'));
    const p2=json(prepare(db,f.users.internal,req['stage-2']));upload(db,p2,f.users.internal,{mime:'image/svg+xml'});paths.push(p2.storage_path);check('18 active SVG MIME is rejected',code(submit(db,f.users.internal,p2,'bad-mime'),'signature_file_invalid'));
    upload(db,p2,f.users.internal,{size:2097153});check('19 oversized file is rejected',code(submit(db,f.users.internal,p2,'too-big'),'signature_file_invalid'));
    upload(db,p2,f.users.internal);validateFixture(db,p2);const stage2=json(submit(db,f.users.internal,p2,'stage2'));check('20 valid PNG and dimensions succeed',stage2.status==='signed');
    const p3=json(prepare(db,f.users.internal,req['stage-3']));upload(db,p3,f.users.contractor);paths.push(p3.storage_path);const wrongOwner=psql(db,`BEGIN; SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',true); SELECT public.training_signature_record_file_validation(${q(p3.challenge_id)},'image/png',1200,640,240,${q(crypto.createHash('sha256').update(p3.storage_path).digest('hex'))},'D15-TEST-DECODED'); COMMIT;`,true);check('21 another owner path is rejected',wrongOwner.status!==0&&wrongOwner.err.includes('[D15:signature_file_mismatch]'));
    upload(db,p3,f.users.internal,{mime:'image/jpeg'});validateFixture(db,p3,{mime:'image/jpeg'});const stage3=json(submit(db,f.users.internal,p3,'stage3'));check('22 JPEG signing succeeds',stage3.status==='signed');
    const roleTargets=[[extra.directOrg,f.entityA],[extra.deptSigner,testOrg.department],[extra.logisticsSigner,testOrg.logistics],[extra.otherSigner,testOrg.other]];
    const roleSubjects=Object.fromEntries(roleTargets.map(([user])=>[user,scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)};`)]));
    const roleIds=[];
    for(const [user,org] of roleTargets){const granted=json(call(db,admin,`public.training_organization_role_grant(${q(roleSubjects[user])},${q(org)},'organization_responsible',NULL,NULL,'D15 focused role',${q(`${f.suffix}-${user}`)})`));roleIds.push(granted.id);}
    const authority=(user,org)=>scalar(db,`SELECT public.training_organization_signer_authority(${q(roleSubjects[user]||scalar(db,`SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)};`))},${q(org)},clock_timestamp());`)==='t';
    check('R02-2A internal department, logistics and other-unit roles share one authority model',authority(extra.deptSigner,testOrg.department)&&authority(extra.logisticsSigner,testOrg.logistics)&&authority(extra.otherSigner,testOrg.other));
    check('R02-2A organization scope cannot cross units',!authority(extra.deptSigner,testOrg.otherDepartment)&&!authority(extra.logisticsSigner,testOrg.department));
    check('R02-2A company admin is not automatically an organization signer',!authority(admin,testOrg.department));
    const directPrepared=json(prepare(db,extra.directOrg,req['org-confirm']));check('23 explicit organization responsible can prepare',directPrepared.status==='prepared');
    check('24 other organization manager is rejected',code(prepare(db,extra.orgB,req['org-confirm'],true),'signature_forbidden'));
    upload(db,directPrepared,extra.directOrg);paths.push(directPrepared.storage_path);
    json(call(db,admin,`public.training_organization_role_revoke(${q(roleIds[0])},'D15 revoke after prepare',${q(`${f.suffix}-revoke`)})`));
    check('25 revoked organization role cannot submit',code(submit(db,extra.directOrg,directPrepared,'revoked'),'signature_forbidden'));
    const orgFresh=json(prepare(db,extra.orgA,req['org-confirm']));check('R02-2A legacy entity_admin bridge remains valid',orgFresh.status==='prepared');upload(db,orgFresh,extra.orgA);validateFixture(db,orgFresh);paths.push(orgFresh.storage_path);
    const concurrent=await Promise.all([asyncUser(db,extra.orgA,`SELECT public.training_signature_submit(${q(orgFresh.challenge_id)},${q(orgFresh.nonce)},'org-concurrent','{}')::text;`),asyncUser(db,extra.orgA,`SELECT public.training_signature_submit(${q(orgFresh.challenge_id)},${q(orgFresh.nonce)},'org-concurrent','{}')::text;`)]);
    check('26 concurrent submit returns one authority result',concurrent.every(x=>x.status===0)&&scalar(db,`SELECT count(*)||'|'||count(DISTINCT signed_at)||'|'||count(DISTINCT evidence_digest) FROM public.training_signature_results WHERE requirement_id=${q(req['org-confirm'])};`)==='1|1|1');
    check('27 unrelated project manager is rejected',code(prepare(db,extra.otherPm,req['project-confirm'],true),'signature_forbidden'));
    const projectDone=prepareUploadSubmit(db,extra.pm,req['project-confirm'],'pm-sign');paths.push(projectDone.prepared.storage_path);check('28 project manager signs own project',projectDone.result.status==='signed');
    const secondProject=json(prepare(db,extra.safety,req['project-confirm']));check('29 ANY_OF second signer gets completed result',secondProject.reason_code==='signature_already_completed'&&scalar(db,`SELECT count(*) FROM public.training_signature_results WHERE requirement_id=${q(req['project-confirm'])};`)==='1');
    check('R02-03 wrong D13 semantic and other admission cannot satisfy final',code(prepare(db,f.users.internal,req['employee-final'],true),'signature_prerequisite_not_met'));
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.exam_attempts(id,paper_id,assignment_id,employee_id,attempt_no,questions,deadline_at,submitted_at,answers,score,result,status,project_id,admission_id,exam_type,rule_snapshot,exam_semantic_type)
      VALUES(${q(examAttempt)},${q(f.paper)},(SELECT id FROM public.training_assignments WHERE plan_id=${q(f.plans.exam)} AND employee_id=${q(f.employees.internal)}),${q(f.employees.internal)},3,'[]',NOW()+INTERVAL '30 minutes',NOW()-INTERVAL '1 second','{}',100,'pass','submitted',${q(f.projects.a1)},${q(admission)},'admission','{"rule_version":"D15-R02"}','employee_comprehensive_admission_exam'); COMMIT;`);
    const changedFile=json(prepare(db,f.users.internal,req['employee-final']));check('30 final digest binds D13 passed attempt',changedFile.summary.exam_result.attempt_id===examAttempt&&changedFile.summary.exam_result.exam_semantic_type==='employee_comprehensive_admission_exam');
    upload(db,changedFile,f.users.internal);validateFixture(db,changedFile);paths.push(changedFile.storage_path);psql(db,`UPDATE storage.objects SET updated_at=updated_at+INTERVAL '1 second',version='changed-after-validation' WHERE bucket_id='certificates' AND name=${q(changedFile.storage_path)};`);
    check('R02-2B object changed after validation is rejected',code(submit(db,f.users.internal,changedFile,'changed-file'),'signature_file_mismatch'));
    const finalPrepared=json(prepare(db,f.users.internal,req['employee-final']));upload(db,finalPrepared,f.users.internal,{width:1,height:1});validateFixture(db,finalPrepared);paths.push(finalPrepared.storage_path);const finalResult=json(submit(db,f.users.internal,finalPrepared,'final',{platform:'D15-TEST',signed_at:'1900-01-01T00:00:00Z'}));check('31 decoded facts override fake metadata and valid file signs',finalResult.status==='signed'&&scalar(db,`SELECT image_width||'x'||image_height FROM public.training_signature_results WHERE id=${q(finalResult.result_id)};`)==='640x240');
    check('32 signed_at is server authoritative',Math.abs(Date.now()-Date.parse(finalResult.signed_at))<120000);
    const digestFacts=scalar(db,`SELECT ((evidence_snapshot->>'signature_signed_at')=to_char(signed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text||'|'||(public.training_signature_digest_internal(evidence_snapshot)=evidence_digest)::text||'|'||(public.training_signature_digest_internal(jsonb_set(evidence_snapshot,'{signature_signed_at}','"1900-01-01T00:00:00.000000Z"'::jsonb))<>evidence_digest)::text||'|'||(signed_at>'2000-01-01')::text FROM public.training_signature_results WHERE id=${q(finalResult.result_id)};`);
    check('R02-2B canonical evidence binds the same server signed_at and recomputes',digestFacts==='true|true|true|true');
    check('R02-2B ordinary client cannot write validation facts',asUser(db,f.users.internal,`INSERT INTO public.training_signature_file_validations(requirement_id,challenge_id,uploader_subject_id,storage_object_id,storage_bucket,storage_path,storage_object_updated_at,detected_mime_type,actual_size_bytes,actual_width,actual_height,content_sha256,validation_status,validator_version) VALUES(${q(req['employee-final'])},${q(finalPrepared.challenge_id)},${q(subject)},${q(id())},'certificates','forged',NOW(),'image/png',1,64,32,repeat('0',64),'valid','forged');`,true).status!==0);
    check('33 signature never changes training/exam facts',scalar(db,`SELECT r.status||'|'||a.result FROM public.training_three_level_records r CROSS JOIN public.exam_attempts a WHERE r.id=${q(recordIds[0])} AND a.id=${q(examAttempt)};`)==='completed|pass');
    check('34 signed evidence rejects UPDATE and DELETE',psql(db,`UPDATE public.training_signature_results SET evidence_digest=repeat('0',64) WHERE id=${q(finalResult.result_id)};`,true).status!==0&&psql(db,`DELETE FROM public.training_signature_results WHERE id=${q(finalResult.result_id)};`,true).status!==0);
    const objectBefore=scalar(db,`SELECT metadata::text FROM storage.objects WHERE bucket_id='certificates' AND name=${q(finalPrepared.storage_path)};`);
    asUser(db,f.users.internal,`UPDATE storage.objects SET metadata='{}' WHERE bucket_id='certificates' AND name=${q(finalPrepared.storage_path)} RETURNING name;`,true);
    asUser(db,f.users.internal,`DELETE FROM storage.objects WHERE bucket_id='certificates' AND name=${q(finalPrepared.storage_path)} RETURNING name;`,true);
    check('35 ordinary client cannot UPDATE or DELETE signed object',scalar(db,`SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name=${q(finalPrepared.storage_path)} AND metadata::text=${q(objectBefore)};`)==='1');
    check('36 unauthorized original-image access is denied',code(call(db,extra.outsider,`public.training_signature_result_file(${q(finalResult.result_id)})`,true),'signature_forbidden')&&scalar(db,`SELECT public.training_signature_file_can_read(${q(finalPrepared.storage_path)}) FROM (SELECT set_config('request.jwt.claim.sub',${q(extra.outsider)},false))x;`)==='f');
    const listed=json(call(db,f.users.internal,'public.training_signature_requirement_list(NULL,NULL)'));check('37 ordinary response has no identity plaintext',!JSON.stringify(listed).toLowerCase().includes('identity_card')&&!JSON.stringify(listed).includes('身份证'));
    const v2=json(call(db,admin,`public.training_signature_policy_create_version(${q(policy.id)},${q(policy.v1)},CURRENT_DATE+1,'V2','new version',${q(`${f.suffix}-v2`)})`));policy.v2=v2.id;
    check('38 V2 starts as a separate draft',v2.status==='draft'&&v2.version_no===2);
    const v2Nodes=[
      {node_code:'org-confirm',node_type:'organization_responsible_confirmation',applies_stage_type:'department_position',required:true,sequence_no:1,signer_mode:'SINGLE',signer_roles:['organization_responsible']},
      {node_code:'employee-final',node_type:'employee_final_acknowledgement',required:true,sequence_no:2,signer_mode:'SINGLE',signer_roles:['employee'],requires_exam:false}
    ];
    json(call(db,admin,`public.training_signature_policy_save_draft(${q(policy.v2)},${q(JSON.stringify(v2Nodes))}::jsonb,CURRENT_DATE+1,'V2 focused','save V2',${q(`${f.suffix}-v2-save`)})`));
    json(call(db,admin,`public.training_signature_policy_publish(${q(policy.v2)},'publish V2',${q(`${f.suffix}-v2-pub`)})`));
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.employment_organization_assignments(id,employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason)
      VALUES(${q(assignment4)},${q(relation4)},${q(f.employees.internal)},${q(f.entityA)},CURRENT_DATE+1,TRUE,1,'D15 authoritative new relation');
      INSERT INTO public.training_requirement_snapshots(id,employee_id,subject_id,employment_relation_id,organization_assignment_id,organization_unit_id,matched_applicability_rule_id,scheme_id,scheme_version_id,effective_as_of,reason_code,explanation,authority_facts)
      VALUES(${q(snapshot4)},${q(f.employees.internal)},${q(subject)},${q(relation4)},${q(assignment4)},${q(f.entityA)},${q(rule)},${q(scheme)},${q(schemeVersion)},CURRENT_DATE+2,'resolved','D15 authoritative V2 context','{}');
      INSERT INTO public.training_requirement_snapshot_items(id,snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,training_package_version_no,required,site_project_id)
      VALUES(${q(snap4Items[0])},${q(snapshot4)},1,'company','company',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap4Items[1])},${q(snapshot4)},2,'organization','organization',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL),
      (${q(snap4Items[2])},${q(snapshot4)},3,'third','department_position',${q(f.packages.a1)},${q(f.packages.a1)},1,TRUE,NULL);
      INSERT INTO public.training_three_level_records(id,employee_id,employment_relation_id,level,plan_id,third_level_mode,status,planned_hours,required_hours,effective_hours,plan_version_root_id,plan_version_no,requirement_snapshot_id,requirement_snapshot_item_id,stage_type,organization_unit_id,training_package_id,training_package_version_no,completed_at)
      VALUES(${q(snap4RecordIds[0])},${q(f.employees.internal)},${q(relation4)},'company',${q(f.plans.company)},NULL,'pending',1,0.5,0,${q(f.plans.company)},1,${q(snapshot4)},${q(snap4Items[0])},'company',${q(f.entityA)},${q(f.packages.a1)},1,NULL),
      (${q(snap4RecordIds[1])},${q(f.employees.internal)},${q(relation4)},'entity',${q(f.plans.entityA)},NULL,'completed',1,0.5,1,${q(f.plans.entityA)},1,${q(snapshot4)},${q(snap4Items[1])},'organization',${q(f.entityA)},${q(f.packages.a1)},1,NOW()),
      (${q(snap4RecordIds[2])},${q(f.employees.internal)},${q(relation4)},'third',${q(f.plans.projectA1)},NULL,'completed',1,0.5,1,${q(f.plans.projectA1)},1,${q(snapshot4)},${q(snap4Items[2])},'department_position',${q(f.entityA)},${q(f.packages.a1)},1,NOW()); COMMIT;`);
    const ensuredBefore=json(call(db,admin,`public.training_signature_ensure_requirements(${q(snapshot3)},NULL,'before-v2')`));
    check('R02-04 future V2 keeps V1 active before effective date',ensuredBefore.policy_version_id===policy.v1);
    const ensured2=json(call(db,admin,`public.training_signature_ensure_requirements(${q(snapshot2)},NULL,'v2 employee')`));check('39 new employee uses effective V2',ensured2.policy_version_id===policy.v2);
    check('R02-05 non-project Snapshot cannot gain project scope from admission',ensured2.requirements.every(x=>x.project_id===null));
    const v2Org=ensured2.requirements.find(x=>x.node_code==='org-confirm');
    check('R02-06 management signature enforces training without employee signature nodes',code(prepare(db,extra.orgA,v2Org.id,true),'signature_prerequisite_not_met'));
    psql(db,`INSERT INTO public.training_three_level_records(id,employee_id,employment_relation_id,level,plan_id,third_level_mode,status,planned_hours,required_hours,effective_hours,plan_version_root_id,plan_version_no,requirement_snapshot_id,requirement_snapshot_item_id,stage_type,organization_unit_id,training_package_id,training_package_version_no,completed_at) VALUES
      (${q(snap2RecordIds[0])},${q(f.employees.missing)},${q(relation2)},'company',${q(f.plans.company)},NULL,'completed',1,0.5,1,${q(f.plans.company)},1,${q(snapshot2)},${q(snap2Items[0])},'company',${q(f.entityA)},${q(f.packages.a1)},1,NOW()),
      (${q(snap2RecordIds[1])},${q(f.employees.missing)},${q(relation2)},'entity',${q(f.plans.entityA)},NULL,'completed',1,0.5,1,${q(f.plans.entityA)},1,${q(snapshot2)},${q(snap2Items[1])},'organization',${q(f.entityA)},${q(f.packages.a1)},1,NOW()),
      (${q(snap2RecordIds[2])},${q(f.employees.missing)},${q(relation2)},'third',${q(f.plans.projectA1)},NULL,'completed',1,0.5,1,${q(f.plans.projectA1)},1,${q(snapshot2)},${q(snap2Items[2])},'department_position',${q(f.entityA)},${q(f.packages.a1)},1,NOW());`);
    check('R02-07 completed authoritative training unlocks management prepare',json(prepare(db,extra.orgA,v2Org.id)).status==='prepared');
    check('40 existing employee V1 requirements are not rewritten',scalar(db,`SELECT count(*) FROM public.training_signature_requirements WHERE requirement_snapshot_id=${q(snapshot)} AND policy_version_id=${q(policy.v1)};`)==='6');
    const oldCycle=requirements[0].requirement_cycle_id,oldEvidence=scalar(db,`SELECT id::text||'|'||evidence_digest||'|'||storage_path FROM public.training_signature_results WHERE requirement_id=${q(req['project-confirm'])};`);
    check('R02-2A employee cannot trigger an arbitrary supersede cycle',code(call(db,f.users.internal,`public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'forged','employee-forged')`,true),'signature_forbidden'));
    const concurrentCycle=await Promise.all([
      asyncUser(db,admin,`SELECT public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'authoritative V2 cycle','${f.suffix}-cycle-a')::text;`),
      asyncUser(db,admin,`SELECT public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'authoritative V2 cycle','${f.suffix}-cycle-b')::text;`)
    ]);
    const cycleResults=concurrentCycle.map(json),newCycle=cycleResults[0].new_cycle_id;
    check('41 concurrent authoritative event creates one complete successor cycle',concurrentCycle.every(x=>x.status===0)&&cycleResults.every(x=>x.new_cycle_id===newCycle)&&scalar(db,`SELECT count(*) FROM public.training_signature_cycles WHERE previous_cycle_id=${q(oldCycle)};`)==='1');
    const superseded=json(call(db,admin,`public.training_signature_supersede_cycle(${q(oldCycle)},'requirement_snapshot',${q(snapshot4)},'authoritative V2 cycle','repeat')`));
    check('R02-2A repeated source event is idempotent',superseded.idempotent&&superseded.new_cycle_id===newCycle);
    check('R02-2A new cycle binds V2 context and regenerates the complete policy node set',superseded.requirement_snapshot_id===snapshot4&&superseded.policy_version_id===policy.v2&&Number(superseded.requirement_count)===v2Nodes.length&&scalar(db,`SELECT count(*) FROM public.training_signature_requirements WHERE requirement_cycle_id=${q(newCycle)};`)===String(v2Nodes.length));
    check('R02-2A old/new linkage and immutable signed evidence are retained',scalar(db,`SELECT status||'|'||(superseded_by_cycle_id=${q(newCycle)})::text FROM public.training_signature_cycles WHERE id=${q(oldCycle)};`)==='superseded|true'&&scalar(db,`SELECT id::text||'|'||evidence_digest||'|'||storage_path FROM public.training_signature_results WHERE requirement_id=${q(req['project-confirm'])};`)===oldEvidence);
    const newOrg=scalar(db,`SELECT id FROM public.training_signature_requirements WHERE requirement_cycle_id=${q(newCycle)} AND node_code='org-confirm';`);
    check('R02-2A rebuilt management node still enforces hard prerequisites',code(prepare(db,extra.orgA,newOrg,true),'signature_prerequisite_not_met'));
    psql(db,`UPDATE public.training_three_level_records SET status='completed',effective_hours=1,completed_at=NOW() WHERE id=${q(snap4RecordIds[0])};`);
    const orgV2Done=prepareUploadSubmit(db,extra.orgA,newOrg,'org-v2-sign');paths.push(orgV2Done.prepared.storage_path);check('42 rebuilt cycle signs independently after prerequisites',orgV2Done.result.status==='signed');
    asUser(db,admin,`SELECT public.training_account_set_status(${q(f.users.internal)},'closed','D15 history check','d15-close',NULL);`);
    check('43 closed login keeps stable signer subject/display',scalar(db,`SELECT count(*) FROM public.training_signature_results WHERE id=${q(finalResult.result_id)} AND signer_subject_id=${q(subject)} AND signer_display_snapshot->>'display_name'<>'';`)==='1');
    check('44 audit and requirement events retain operator facts',Number(scalar(db,`SELECT (SELECT count(*) FROM public.training_signature_policy_audit_logs WHERE policy_id=${q(policy.id)} AND operator_subject_id IS NOT NULL)+(SELECT count(*) FROM public.training_signature_requirement_events WHERE requirement_id IN(SELECT id FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)})));`))>=12);
    json(call(db,admin,`public.training_signature_policy_retire(${q(policy.v2)},'retire test','retire')`));check('45 published policy can retire without changing history',scalar(db,`SELECT status FROM public.training_signature_policy_versions WHERE id=${q(policy.v2)};`)==='retired');
    check('46 direct tables have no ordinary write grants',scalar(db,`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='authenticated' AND privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE') AND table_name LIKE 'training_signature_%';`)==='0');
    }
  } finally {
    const pathFilter=`name LIKE ${q(`training-admission/signature-evidence/%`)} AND name IN(${paths.length?paths.map(q).join(','):q(id())})`;
    psql(db,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM storage.objects WHERE bucket_id='certificates' AND ${pathFilter};
      DELETE FROM public.training_signature_results WHERE requirement_id IN(SELECT id FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}));
      DELETE FROM public.training_signature_file_validations WHERE requirement_id IN(SELECT id FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}));
      DELETE FROM public.training_signature_challenges WHERE requirement_id IN(SELECT id FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}));
      DELETE FROM public.training_signature_requirement_events WHERE requirement_id IN(SELECT id FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}));
      DELETE FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)});
      DELETE FROM public.training_signature_cycle_events WHERE cycle_id IN(SELECT id FROM public.training_signature_cycles WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}));
      DELETE FROM public.training_signature_cycles WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)});
      DELETE FROM public.training_signature_policy_audit_logs WHERE policy_id=${policy.id?q(policy.id):q(id())};
      DELETE FROM public.training_signature_policy_nodes WHERE policy_version_id IN(SELECT id FROM public.training_signature_policy_versions WHERE policy_id=${policy.id?q(policy.id):q(id())});
      DELETE FROM public.training_signature_policy_versions WHERE policy_id=${policy.id?q(policy.id):q(id())}; DELETE FROM public.training_signature_policies WHERE id=${policy.id?q(policy.id):q(id())};
      DELETE FROM public.exam_attempts WHERE id IN(${q(examAttempt)},${q(wrongSemanticAttempt)},${q(wrongAdmissionAttempt)});
      DELETE FROM public.training_three_level_records WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)});
      DELETE FROM public.training_requirement_snapshot_events WHERE snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}); DELETE FROM public.training_requirement_snapshot_items WHERE snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}); DELETE FROM public.training_requirement_snapshots WHERE id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)});
      DELETE FROM public.employment_organization_assignment_history WHERE employment_relation_id IN(${q(relation)},${q(relation2)},${q(relation3)},${q(relation4)}); DELETE FROM public.employment_organization_assignments WHERE employment_relation_id IN(${q(relation)},${q(relation2)},${q(relation3)},${q(relation4)});
      DELETE FROM public.training_three_level_profiles WHERE employee_id IN(${q(f.employees.internal)},${q(f.employees.missing)},${q(f.employees.concurrent)});
      DELETE FROM public.three_level_training_applicability_rules WHERE id=${q(rule)}; DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id=${q(schemeVersion)}; DELETE FROM public.three_level_training_scheme_versions WHERE scheme_id=${q(scheme)}; DELETE FROM public.three_level_training_schemes WHERE id=${q(scheme)};
      DELETE FROM public.site_project_roles WHERE user_id IN(${Object.values(extra).map(q).join(',')});
      DELETE FROM public.training_organization_role_audit_logs WHERE organization_role_id IN(SELECT id FROM public.training_organization_roles WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')})));
      DELETE FROM public.training_organization_roles WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')}));
      DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')})) OR operator_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')}));
      DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')})); DELETE FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')});
      DELETE FROM public.profiles WHERE id IN(${Object.values(extra).map(q).join(',')}); DELETE FROM auth.users WHERE id IN(${Object.values(extra).map(q).join(',')});
      DELETE FROM public.organization_units WHERE id IN(${Object.values(testOrg).map(q).join(',')}); COMMIT;`);
    residual=cleanupBase(db,f)+Number(scalar(db,`SELECT
      (SELECT count(*) FROM public.training_signature_policies WHERE id=${policy.id?q(policy.id):q(id())})+
      (SELECT count(*) FROM public.training_signature_requirements WHERE requirement_snapshot_id IN(${q(snapshot)},${q(snapshot2)},${q(snapshot3)},${q(snapshot4)}))+
      (SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name LIKE 'training-admission/signature-evidence/%' AND name IN(${paths.length?paths.map(q).join(','):q(id())}))+
      (SELECT count(*) FROM public.account_subjects WHERE auth_user_id IN(${Object.values(extra).map(q).join(',')}))+
      (SELECT count(*) FROM public.organization_units WHERE id IN(${Object.values(testOrg).map(q).join(',')}));`));
    check('47 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`D15_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);if(failed.length)process.exit(1);
}
if(require.main===module)main().catch(e=>{console.error(String(e.message||e).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

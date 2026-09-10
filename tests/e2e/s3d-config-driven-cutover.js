/** S3-D TARGETED: D11 production snapshot cutover and D13 prerequisite boundary. */
const crypto=require('crypto'); const fs=require('fs'); const path=require('path'); const {spawn}=require('child_process');
const {validateTestBoundary,assertD02FixtureMarker}=require('./d04-test-environment');
const {asUser,psql,q,scalar}=require('./d11-three-level-training-reuse'); const {required}=require('./test-config');
const results=[]; const check=(name,pass,detail='')=>{results.push({name,pass:!!pass});console.log(`${pass?'PASS':'FAIL'} S3D ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID(); const json=run=>JSON.parse(run.out.split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1));
const jwtSql=(user,sql)=>`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(user)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); ${sql} COMMIT;`;
function asyncUser(db,user,sql){return new Promise(resolve=>{const c=spawn('psql',[db,'-X','-Atq','-v','ON_ERROR_STOP=1'],{windowsHide:true});let out='',err='';c.stdout.on('data',x=>out+=x);c.stderr.on('data',x=>err+=x);c.on('close',status=>resolve({status,out:out.trim(),err:err.trim()}));c.stdin.end(jwtSql(user,sql));});}
async function main(){
  const started=process.hrtime.bigint(),b=validateTestBoundary();assertD02FixtureMarker(b);const suffix=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
  const admin=scalar(b.databaseUrl,`SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.email=${q(required('SAFETY_TEST_ADMIN_EMAIL'))} AND (p.is_super_admin OR p.admin_level='company');`);if(!admin)throw new Error('公司管理员测试账号不可用');
  const dept=scalar(b.databaseUrl,"SELECT id FROM public.departments WHERE code='D02-ENT-A';"); const user=id(); const projects={a:id(),b:id()};
  const org=Object.fromEntries(['finance','party','logistics','entity','fallback','ambiguous','draft','none','moved'].map(k=>[k,id()]));
  const scheme=Object.fromEntries(['finance','party','logistics','entity','fallback','draft'].map(k=>[k,id()]));
  const version=Object.fromEntries(['finance1','finance2','party','logistics','entity','fallback','draft'].map(k=>[k,id()]));
  const people=Object.fromEntries(['financeA','financeB','party','logistics','entity','fallback','concurrent','noOrg','noScheme','ambiguous','draft','contractor','temp','visitor','completed','legacyVerified','legacySupplement','ongoing','rehireOld','rehireNew'].map(k=>[k,id()]));
  const relations=Object.fromEntries(Object.keys(people).map(k=>[k,id()])); const rules=Object.fromEntries(['finance','party','logistics','entity','fallback','ambA','ambB','draft'].map(k=>[k,id()]));
  const plan={},pack={}; for(const key of ['company','financeOrg','financeThird','finance2Org','finance2Third','partyOrg','partyThird','logisticsOrg','logisticsThird','entityOrg','entityThird','fallbackOrg','fallbackThird']){plan[key]=id();pack[key]=id();}
  let residual=-1; const call=(employee,project=null)=>json(asUser(b.databaseUrl,admin,`SELECT public.training_three_level_status(${project?q(project):'NULL'},${q(employee)});`));
  const ensure=(employee,project=null,key='')=>json(asUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(employee)},${project?q(project):'NULL'},${q(`${suffix}-${key||employee}`)});`));
  try{
    const planRows=Object.entries(plan).map(([k,v])=>{const level=k==='company'?'company':k.endsWith('Org')?'entity':'project';return `(${q(v)},${q(`[S3D] ${k}`)},'${level}','basic_three_level',${level==='company'?'NULL':q(dept)},NULL,${level==='project'?"'basic_project'":'NULL'},2026,1,0.5,'planned','approved','published',${q(v)},${k.startsWith('finance2')?2:1},'allow',${q(admin)})`;}).join(',');
    const packRows=Object.entries(pack).map(([k,v])=>`(${q(v)},${q(`[S3D] ${k}`)},${k.startsWith('finance2')?2:1},1,'published','basic_three_level',${q(admin)})`).join(',');
    const itemRows=Object.keys(pack).map(k=>`(${q(pack[k])},${q(plan[k])},'${k==='company'?'company':k.endsWith('Org')?'entity':'project'}',TRUE,1)`).join(',');
    const employeeRows=Object.entries(people).map(([k,v])=>`(${q(v)},${q(`[S3D] ${k}`)},${q(`S3D-${suffix}-${k}`)},${q(dept)},${q(k)},'employee','active','S3D-TEST')`).join(',');
    const category=k=>k==='contractor'?'contractor':k==='temp'?'temporary_individual':k==='visitor'?'visitor':'formal_internal';
    const onboarding=k=>k==='contractor'||k==='temp'||k==='visitor'?'not_applicable':k==='legacyVerified'?'legacy_verified':k==='legacySupplement'?'legacy_supplement_completed':k==='completed'?'completed':'new_hire';
    const status=k=>k==='contractor'||k==='temp'||k==='visitor'?'not_applicable':k==='legacyVerified'?'verified':k==='legacySupplement'||k==='completed'?'completed':k==='ongoing'?'in_progress':'required';
    const profileRows=Object.entries(people).map(([k,v])=>`(${q(v)},${q(relations[k])},'${category(k)}','${onboarding(k)}','${status(k)}','2025-01-01','S3D-TEST'${['legacyVerified','legacySupplement','completed'].includes(k)?',NOW()':',NULL'})`).join(',');
    const assignKeys=['financeA','financeB','party','logistics','entity','fallback','concurrent','noScheme','ambiguous','draft','rehireOld','rehireNew'];
    const orgFor={financeA:'finance',financeB:'finance',party:'party',logistics:'logistics',entity:'entity',fallback:'fallback',concurrent:'party',noScheme:'none',ambiguous:'ambiguous',draft:'draft',rehireOld:'finance',rehireNew:'finance'};
    const assignmentRows=assignKeys.map(k=>`(${q(relations[k])},${q(people[k])},${q(org[orgFor[k]])},'2025-01-01',TRUE,1,'S3D fixture')`).join(',');
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES(${q(projects.a)},${q(`S3D-${suffix}-A`)},'[S3D] A','active',${q(dept)},'S3D-TEST'),(${q(projects.b)},${q(`S3D-${suffix}-B`)},'[S3D] B','active',${q(dept)},'S3D-TEST');
      INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES(${q(projects.a)},${q(dept)},TRUE),(${q(projects.b)},${q(dept)},TRUE);
      INSERT INTO public.organization_units(id,organization_code,name,organization_type,effective_from) VALUES
      (${q(org.finance)},${q(`S3D-${suffix}-FIN` )},'财务资产部','internal_department','2025-01-01'),(${q(org.party)},${q(`S3D-${suffix}-PTY`)},'党建工作部','internal_department','2025-01-01'),
      (${q(org.logistics)},${q(`S3D-${suffix}-LOG`)},'后勤中心','logistics_center','2025-01-01'),(${q(org.entity)},${q(`S3D-${suffix}-ENT`)},'某经营实体','operating_entity','2025-01-01'),
      (${q(org.fallback)},${q(`S3D-${suffix}-FB`)},'其他内部组织','other_internal_unit','2025-01-01'),(${q(org.ambiguous)},${q(`S3D-${suffix}-AMB`)},'冲突组织','internal_department','2025-01-01'),
      (${q(org.draft)},${q(`S3D-${suffix}-DRF`)},'草稿组织','internal_department','2025-01-01'),(${q(org.none)},${q(`S3D-${suffix}-NON`)},'无规则组织','company','2025-01-01'),
      (${q(org.moved)},${q(`S3D-${suffix}-MOV`)},'调入组织','other_internal_unit','2025-01-01');
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES ${employeeRows};
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000000000',${q(user)},'authenticated','authenticated',${q(`s3d-${suffix}@example.invalid`)},crypt('S3D-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW());
      INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name) VALUES(${q(user)},${q(`s3d-${suffix}@example.invalid`)},${q(people.financeA)},${q(dept)},'employee','[S3D] financeA');
      INSERT INTO public.account_subjects(auth_user_id,employee_id) VALUES(${q(user)},${q(people.financeA)}); INSERT INTO public.account_lifecycle(subject_id) SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)};
      INSERT INTO public.training_three_level_profiles(employee_id,employment_relation_id,person_category,onboarding_category,status,employment_started_on,relation_source,completed_at) VALUES ${profileRows};
      INSERT INTO public.employment_organization_assignments(employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason) VALUES ${assignmentRows};
      INSERT INTO public.training_plans(id,title,level,training_category,department_id,site_project_id,third_level_mode,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES ${planRows};
      INSERT INTO public.training_courses(plan_id,title,course_type,content,required,sort_order) SELECT id,'[S3D] course','text','safe',TRUE,1 FROM public.training_plans WHERE id IN(${Object.values(plan).map(q).join(',')});
      INSERT INTO public.training_admission_packages(id,title,version_no,validity_years,status,training_category,created_by) VALUES ${packRows};
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES ${itemRows};
      INSERT INTO public.three_level_training_schemes(id,scheme_code,display_name) VALUES
      (${q(scheme.finance)},${q(`S3D-${suffix}-FIN`)},'财务方案'),(${q(scheme.party)},${q(`S3D-${suffix}-PTY`)},'党建方案'),(${q(scheme.logistics)},${q(`S3D-${suffix}-LOG`)},'后勤方案'),
      (${q(scheme.entity)},${q(`S3D-${suffix}-ENT`)},'经营实体方案'),(${q(scheme.fallback)},${q(`S3D-${suffix}-FB`)},'公司兜底方案'),(${q(scheme.draft)},${q(`S3D-${suffix}-DRF`)},'草稿方案');
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary,published_by,published_at) VALUES
      (${q(version.finance1)},${q(scheme.finance)},1,'published','2025-01-01','V1',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW()-INTERVAL '1 day'),
      (${q(version.party)},${q(scheme.party)},1,'published','2025-01-01','V1',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW()-INTERVAL '1 day'),
      (${q(version.logistics)},${q(scheme.logistics)},1,'published','2025-01-01','V1',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW()-INTERVAL '1 day'),
      (${q(version.entity)},${q(scheme.entity)},1,'published','2025-01-01','V1',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW()-INTERVAL '1 day'),
      (${q(version.fallback)},${q(scheme.fallback)},1,'published','2025-01-01','V1',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW()-INTERVAL '1 day'),
      (${q(version.draft)},${q(scheme.draft)},1,'draft','2025-01-01','draft',NULL,NULL);
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id) VALUES
      (${q(version.finance1)},1,'company','company',${q(pack.company)}),(${q(version.finance1)},2,'organization','organization',${q(pack.financeOrg)}),(${q(version.finance1)},3,'third','department_position',${q(pack.financeThird)}),
      (${q(version.party)},1,'company','company',${q(pack.company)}),(${q(version.party)},2,'organization','organization',${q(pack.partyOrg)}),(${q(version.party)},3,'third','department_position',${q(pack.partyThird)}),
      (${q(version.logistics)},1,'company','company',${q(pack.company)}),(${q(version.logistics)},2,'organization','organization',${q(pack.logisticsOrg)}),(${q(version.logistics)},3,'third','logistics_position',${q(pack.logisticsThird)}),
      (${q(version.entity)},1,'company','company',${q(pack.company)}),(${q(version.entity)},2,'organization','organization',${q(pack.entityOrg)}),(${q(version.entity)},3,'third','entity_position',${q(pack.entityThird)}),
      (${q(version.fallback)},1,'company','company',${q(pack.company)}),(${q(version.fallback)},2,'organization','organization',${q(pack.fallbackOrg)}),(${q(version.fallback)},3,'third','basic_project',${q(pack.fallbackThird)}),
      (${q(version.draft)},1,'company','company',${q(pack.company)}),(${q(version.draft)},2,'organization','organization',${q(pack.partyOrg)}),(${q(version.draft)},3,'third','department_position',${q(pack.partyThird)});
      INSERT INTO public.three_level_training_applicability_rules(id,rule_code,scheme_id,organization_unit_id,effective_from,priority,active) VALUES
      (${q(rules.finance)},${q(`S3D-${suffix}-FIN`)},${q(scheme.finance)},${q(org.finance)},'2025-01-01',100,TRUE),(${q(rules.party)},${q(`S3D-${suffix}-PTY`)},${q(scheme.party)},${q(org.party)},'2025-01-01',100,TRUE),
      (${q(rules.logistics)},${q(`S3D-${suffix}-LOG`)},${q(scheme.logistics)},${q(org.logistics)},'2025-01-01',100,TRUE),(${q(rules.entity)},${q(`S3D-${suffix}-ENT`)},${q(scheme.entity)},${q(org.entity)},'2025-01-01',100,TRUE),
      (${q(rules.fallback)},${q(`S3D-${suffix}-FB`)},${q(scheme.fallback)},NULL,'2025-01-01',0,TRUE),(${q(rules.ambA)},${q(`S3D-${suffix}-AMBA`)},${q(scheme.finance)},${q(org.ambiguous)},'2025-01-01',90,TRUE),
      (${q(rules.ambB)},${q(`S3D-${suffix}-AMBB`)},${q(scheme.party)},${q(org.ambiguous)},'2025-01-01',90,TRUE),(${q(rules.draft)},${q(`S3D-${suffix}-DRF`)},${q(scheme.draft)},${q(org.draft)},'2025-01-01',100,TRUE);
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES(${q(projects.a)},${q(people.financeA)},'internal','active',${q(admin)}),(${q(projects.b)},${q(people.financeA)},'internal','active',${q(admin)});
      COMMIT;`);
    let r=ensure(people.financeA,projects.a,'finance-a');check('01 finance employee gets FINANCE scheme',r.scheme_id===scheme.finance);
    r=ensure(people.party,null,'party');check('02 party employee gets PARTY scheme',r.scheme_id===scheme.party);
    r=ensure(people.logistics,null,'logistics');check('03 logistics employee gets LOGISTICS scheme',r.scheme_id===scheme.logistics);
    r=ensure(people.entity,null,'entity');check('04 entity employee gets ENTITY scheme',r.scheme_id===scheme.entity);
    r=ensure(people.fallback,null,'fallback');check('05 company fallback scheme',r.scheme_id===scheme.fallback);
    const financeSnap=ensure(people.financeA,projects.a,'finance-repeat');check('06 exact organization outranks fallback',financeSnap.matched_applicability_rule_id===rules.finance);
    check('07 first need creates authoritative snapshot',financeSnap.source==='authoritative_resolver'&&financeSnap.items.length===3);
    check('08 repeated need reuses one snapshot',ensure(people.financeA,projects.a,'finance-repeat-2').id===financeSnap.id&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshots WHERE employment_relation_id=${q(relations.financeA)};`)==='1');
    const concurrent=await Promise.all([asyncUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(people.concurrent)},NULL,${q(`${suffix}-c1`)});`),asyncUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(people.concurrent)},NULL,${q(`${suffix}-c2`)});`)]);
    check('09 concurrent calls create one snapshot and one task set',concurrent.every(x=>x.status===0)&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshots WHERE employment_relation_id=${q(relations.concurrent)};`)==='1'&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_three_level_records WHERE employment_relation_id=${q(relations.concurrent)};`)==='3');
    check('10 employee A frozen on V1',financeSnap.scheme_version_id===version.finance1&&financeSnap.items.find(x=>x.stage_order===2).training_package_id===pack.financeOrg);
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.three_level_training_scheme_versions SET status='superseded',effective_to=CURRENT_DATE-1 WHERE id=${q(version.finance1)};
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary,published_by,published_at) VALUES(${q(version.finance2)},${q(scheme.finance)},2,'published',CURRENT_DATE,'V2',(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}),NOW());
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id) VALUES(${q(version.finance2)},1,'company','company',${q(pack.company)}),(${q(version.finance2)},2,'organization','organization',${q(pack.finance2Org)}),(${q(version.finance2)},3,'third','department_position',${q(pack.finance2Third)}); COMMIT;`);
    const afterV2=ensure(people.financeA,projects.a,'a-after-v2'),newB=ensure(people.financeB,null,'b-v2');
    check('11 new employee B gets V2 packages',newB.scheme_version_id===version.finance2&&newB.items.find(x=>x.stage_order===2).training_package_id===pack.finance2Org);
    check('12 project change does not rebuild snapshot',ensure(people.financeA,projects.b,'project-change').id===financeSnap.id);
    check('13 year change does not rebuild snapshot',afterV2.id===financeSnap.id&&afterV2.effective_as_of===financeSnap.effective_as_of);
    psql(b.databaseUrl,`UPDATE public.employment_organization_assignments SET active=FALSE,effective_to=CURRENT_DATE-1 WHERE employment_relation_id=${q(relations.financeA)}; INSERT INTO public.employment_organization_assignments(employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason) VALUES(${q(relations.financeA)},${q(people.financeA)},${q(org.moved)},CURRENT_DATE,TRUE,2,'transfer');`);
    check('14 organization transfer does not rebuild existing snapshot',ensure(people.financeA,projects.a,'transfer').id===financeSnap.id);
    const oldRehire=ensure(people.rehireOld,null,'old-relation'),newRehire=ensure(people.rehireNew,null,'new-relation');check('15 new employment relation gets new snapshot',oldRehire.id!==newRehire.id&&oldRehire.employment_relation_id!==newRehire.employment_relation_id);
    r=call(people.completed);check('16 completed history stays satisfied without retraining',r.exam_allowed===true&&r.requirement_snapshot_id===null);
    r=call(people.legacyVerified);check('17 legacy_verified stays satisfied',r.exam_allowed===true&&r.reason_code==='legacy_three_level_verified');
    r=call(people.legacySupplement);check('18 legacy_supplement_completed stays satisfied',r.exam_allowed===true&&r.reason_code==='legacy_three_level_supplement_completed');
    const legacyAssignments={company:id(),org:id(),third:id()};psql(b.databaseUrl,`BEGIN; INSERT INTO public.training_assignments(id,plan_id,employee_id,department_id,status) VALUES(${q(legacyAssignments.company)},${q(plan.company)},${q(people.ongoing)},${q(dept)},'learning'),(${q(legacyAssignments.org)},${q(plan.financeOrg)},${q(people.ongoing)},${q(dept)},'pending'),(${q(legacyAssignments.third)},${q(plan.financeThird)},${q(people.ongoing)},${q(dept)},'pending');
      INSERT INTO public.training_three_level_records(employee_id,employment_relation_id,level,plan_id,assignment_id,third_level_mode,planned_hours,required_hours,plan_version_root_id,plan_version_no,status) VALUES
      (${q(people.ongoing)},${q(relations.ongoing)},'company',${q(plan.company)},${q(legacyAssignments.company)},NULL,1,0.5,${q(plan.company)},1,'learning'),
      (${q(people.ongoing)},${q(relations.ongoing)},'entity',${q(plan.financeOrg)},${q(legacyAssignments.org)},NULL,1,0.5,${q(plan.financeOrg)},1,'pending'),
      (${q(people.ongoing)},${q(relations.ongoing)},'third',${q(plan.financeThird)},${q(legacyAssignments.third)},'basic_project',1,0.5,${q(plan.financeThird)},1,'pending'); COMMIT;`);
    r=call(people.ongoing);check('19 ongoing legacy program gets compatibility snapshot',r.requirement_source==='legacy_d11_compatibility'&&r.levels.length===3);
    check('20 compatibility snapshot freezes original plan/package versions',scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshot_items i JOIN public.training_requirement_snapshots s ON s.id=i.snapshot_id WHERE s.employment_relation_id=${q(relations.ongoing)} AND (i.requirement_metadata->>'legacy_plan_version_no')::int=1;`)==='3');
    check('21 contractor does not enter employee three-level',call(people.contractor).path==='project_admission');check('22 temporary individual does not enter employee three-level',call(people.temp).path==='project_admission');check('23 visitor uses briefing path',call(people.visitor).path==='visitor');
    check('24 missing organization fails closed',call(people.noOrg).reason_code==='organization_assignment_required');
    psql(b.databaseUrl,`UPDATE public.three_level_training_applicability_rules SET active=FALSE WHERE id=${q(rules.fallback)};`);check('25 missing scheme fails closed',call(people.noScheme).reason_code==='training_scheme_not_found');psql(b.databaseUrl,`UPDATE public.three_level_training_applicability_rules SET active=TRUE WHERE id=${q(rules.fallback)};`);
    check('26 ambiguous rules fail closed',call(people.ambiguous).reason_code==='training_scheme_ambiguous');check('27 draft-only scheme fails closed',call(people.draft).reason_code==='training_scheme_version_not_effective');
    r=call(people.financeB);check('28 pending snapshot blocks comprehensive exam',r.exam_allowed===false&&r.reason_code==='missing_company_training');
    const recs=JSON.parse(scalar(b.databaseUrl,`SELECT jsonb_object_agg(level,assignment_id)::text FROM public.training_three_level_records WHERE employment_relation_id=${q(relations.financeB)};`));
    psql(b.databaseUrl,`INSERT INTO public.training_study_logs(id,employee_id,course_id,last_beat_at,beats,effective_sec,closed) SELECT gen_random_uuid(),${q(people.financeB)},c.id,NOW(),60,3600,TRUE FROM public.training_three_level_records r JOIN public.training_courses c ON c.plan_id=r.plan_id WHERE r.employment_relation_id=${q(relations.financeB)};`);
    psql(b.databaseUrl,`UPDATE public.training_assignments SET status='completed',progress=100,completed_at=NOW() WHERE id=${q(recs.company)};`);check('29 company only is insufficient',call(people.financeB).reason_code==='missing_organization_training');
    psql(b.databaseUrl,`UPDATE public.training_assignments SET status='completed',progress=100,completed_at=NOW() WHERE id=${q(recs.entity)};`);check('30 organization stage is required',call(people.financeB).reason_code==='missing_third_level_training');
    psql(b.databaseUrl,`UPDATE public.training_assignments SET status='completed',progress=100,completed_at=NOW() WHERE id=${q(recs.third)};`);check('31 all snapshot stages complete allows exam prerequisite',call(people.financeB).exam_allowed===true);
    const d13UsesD11=scalar(b.databaseUrl,"SELECT pg_get_functiondef('public.training_exam_context_internal(uuid,text,text)'::regprocedure) LIKE '%training_three_level_status%';")==='t';check('32 D13 consumes D11 authority and legacy verified is allowed',d13UsesD11&&call(people.legacyVerified).exam_allowed===true);
    check('33 contractor is not routed to employee comprehensive prerequisite',call(people.contractor).exam_prerequisite_reason_code==='three_level_not_applicable_use_project_admission_path');
    check('34 project_induction remains outside snapshots',scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshot_items i JOIN public.training_admission_packages p ON p.id=i.training_package_id WHERE p.training_category='project_induction' AND i.snapshot_id IN(SELECT id FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(people).map(q).join(',')}));`)==='0');
    check('35 D12 special exam path remains authoritative',scalar(b.databaseUrl,"SELECT pg_get_functiondef('public.training_exam_context_internal(uuid,text,text)'::regprocedure) LIKE '%training_special_requirements_internal%';")==='t');
    check('36 drilling exam parameter path remains present',scalar(b.databaseUrl,"SELECT pg_get_functiondef('public.training_special_requirements_internal(uuid,uuid)'::regprocedure) LIKE '%exam_required%';")==='t');
    const forged=asUser(b.databaseUrl,user,`UPDATE public.training_three_level_profiles SET status='completed' WHERE employee_id=${q(people.financeA)};`,true);check('37 client cannot forge completion',forged.status!==0);
    const web=fs.readFileSync(path.join(__dirname,'../../js/modules/training/admission-mine.js'),'utf8');check('38 Web says belonging-organization level',web.includes('所属组织级教育')&&!web.includes("entity: '经营实体级'"));check('39 Web displays authoritative organization name',web.includes('data.organization_name'));check('40 Web displays server stage type',web.includes('item.stage_type || level.stage_type'));check('41 Web has no department-to-course mapping',!/(财务资产部|党建工作部).*plan|department.*course/i.test(web));
  } finally {
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_three_level_audit_logs WHERE employee_id IN(${Object.values(people).map(q).join(',')});
      DELETE FROM public.training_requirement_snapshot_events WHERE snapshot_id IN(SELECT id FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(people).map(q).join(',')}));
      DELETE FROM public.training_requirement_snapshot_items WHERE snapshot_id IN(SELECT id FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(people).map(q).join(',')}));
      DELETE FROM public.training_three_level_records WHERE employee_id IN(${Object.values(people).map(q).join(',')});
      DELETE FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(people).map(q).join(',')});
      DELETE FROM public.training_study_logs WHERE employee_id IN(${Object.values(people).map(q).join(',')}); DELETE FROM public.training_assignments WHERE employee_id IN(${Object.values(people).map(q).join(',')});
      DELETE FROM public.site_project_members WHERE project_id IN(${q(projects.a)},${q(projects.b)}); DELETE FROM public.site_project_entities WHERE project_id IN(${q(projects.a)},${q(projects.b)}); DELETE FROM public.site_projects WHERE id IN(${q(projects.a)},${q(projects.b)});
      DELETE FROM public.employment_organization_assignment_history WHERE employment_relation_id IN(${Object.values(relations).map(q).join(',')}); DELETE FROM public.employment_organization_assignments WHERE employment_relation_id IN(${Object.values(relations).map(q).join(',')});
      DELETE FROM public.training_three_level_profiles WHERE employee_id IN(${Object.values(people).map(q).join(',')});
      DELETE FROM public.three_level_training_applicability_rules WHERE id IN(${Object.values(rules).map(q).join(',')}); DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id IN(${Object.values(version).map(q).join(',')}); DELETE FROM public.three_level_training_scheme_versions WHERE id IN(${Object.values(version).map(q).join(',')}); DELETE FROM public.three_level_training_schemes WHERE id IN(${Object.values(scheme).map(q).join(',')});
      DELETE FROM public.training_admission_package_items WHERE package_id IN(${Object.values(pack).map(q).join(',')}); DELETE FROM public.training_admission_packages WHERE id IN(${Object.values(pack).map(q).join(',')}); DELETE FROM public.training_courses WHERE plan_id IN(${Object.values(plan).map(q).join(',')}); DELETE FROM public.training_plans WHERE id IN(${Object.values(plan).map(q).join(',')});
      DELETE FROM public.organization_unit_versions WHERE organization_unit_id IN(${Object.values(org).map(q).join(',')}); DELETE FROM public.organization_units WHERE id IN(${Object.values(org).map(q).join(',')});
      DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)}); DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(user)}); DELETE FROM public.account_subjects WHERE auth_user_id=${q(user)}; DELETE FROM public.profiles WHERE id=${q(user)}; DELETE FROM auth.users WHERE id=${q(user)};
      DELETE FROM public.training_employees WHERE id IN(${Object.values(people).map(q).join(',')}); COMMIT;`);
    residual=Number(scalar(b.databaseUrl,`SELECT (SELECT count(*) FROM public.training_employees WHERE id IN(${Object.values(people).map(q).join(',')}))+(SELECT count(*) FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(people).map(q).join(',')}))+(SELECT count(*) FROM public.organization_units WHERE id IN(${Object.values(org).map(q).join(',')}));`));
    check('42 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;console.log(`S3D_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);if(failed.length)process.exit(1);
}
if(require.main===module)main().catch(e=>{console.error(String(e.message||e).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

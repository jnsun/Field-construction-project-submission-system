/** S3-B TARGETED: authoritative resolver, immutable snapshot and D11 shadow comparison. */
const crypto = require('crypto');
const { spawn } = require('child_process');
const { validateTestBoundary, assertD02FixtureMarker } = require('./d04-test-environment');
const { asUser, psql, q, scalar } = require('./d11-three-level-training-reuse');
const { required } = require('./test-config');

const results=[];
const check=(name,pass,detail='')=>{results.push({name,pass});console.log(`${pass?'PASS':'FAIL'} S3B ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID();
const json=run=>JSON.parse(run.out.split(/\r?\n/).filter(Boolean).at(-1));
const jwtSql=(user,sql)=>`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(user)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); ${sql} COMMIT;`;
function asyncUser(db,user,sql){return new Promise(resolve=>{const child=spawn('psql',[db,'-X','-Atq','-v','ON_ERROR_STOP=1'],{windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',status=>resolve({status,out:out.trim(),err:err.trim()}));child.stdin.end(jwtSql(user,sql));});}
function readUser(db,user,sql){let run;for(let attempt=0;attempt<3;attempt+=1){run=asUser(db,user,sql,true);if(run.status===0)return run;if(!/server closed the connection unexpectedly|connection .* failed|could not connect/i.test(run.err))break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500*(attempt+1));}throw new Error(run.err||'只读解析调用失败');}
const snapshotUser=(db,user,sql)=>readUser(db,user,sql); // 仅用于有唯一键/请求号保护的幂等 snapshot RPC。

async function main(){
  const started=process.hrtime.bigint(),b=validateTestBoundary();assertD02FixtureMarker(b);
  const suffix=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
  const admin=scalar(b.databaseUrl,`SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.email=${q(required('SAFETY_TEST_ADMIN_EMAIL'))} AND (p.is_super_admin OR p.admin_level='company');`);
  if(!admin)throw new Error('权威公司管理员测试账号不可用');
  const users={self:id(),attacker:id()};
  const employees=Object.fromEntries(['finance','party','logistics','entity','conflict','draft','basic','actual','contractor','temp','visitor','missingRelation','missingOrg','legacyVerified','legacySupplement'].map(k=>[k,id()]));
  const orgs=Object.fromEntries(['finance','party','logistics','entity','conflict','draft','basic','actual'].map(k=>[k,id()]));
  const schemes=Object.fromEntries(['finance','party','logistics','entity','fallback','conflict','draft','basic','actual'].map(k=>[k,id()]));
  const versions={}; for(const k of Object.keys(schemes))versions[k]=id(); versions.finance2=id();
  const rules=Object.fromEntries(['finance','party','logistics','entityType','internalType','fallback','conflictA','conflictB','draft','basic','actual'].map(k=>[k,id()]));
  const packages={v1:id(),v2:id()}; const projects={a:id(),b:id()}; const plans={company:id(),organization:id(),third:id()}; const assignments={basic:id(),actual:id()};
  let relations={},snapshots=[],residual=-1;
  const resolve=(key,project=null,asOf='CURRENT_DATE')=>json(readUser(b.databaseUrl,admin,`SELECT public.resolve_three_level_training_scheme(${q(employees[key])},${q(relations[key])},${asOf},${project?q(project):'NULL'});`));
  const shadow=(key,project=null)=>json(readUser(b.databaseUrl,admin,`SELECT public.training_three_level_resolution_shadow(${q(employees[key])},${q(relations[key])},${project?q(project):'NULL'},CURRENT_DATE);`));
  try{
    psql(b.databaseUrl,`BEGIN;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${q(users.self)},'authenticated','authenticated',${q(`s3b-${suffix}-self@example.invalid`)},crypt('S3B-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW()),
      ('00000000-0000-0000-0000-000000000000',${q(users.attacker)},'authenticated','authenticated',${q(`s3b-${suffix}-attacker@example.invalid`)},crypt('S3B-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW());
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark,user_id) VALUES
      ${Object.entries(employees).map(([k,v])=>`(${q(v)},${q(`[S3B] ${k}`)},${q(`S3B-${suffix}-${k}`)},(SELECT id FROM public.departments WHERE code='D02-ENT-A'),${q(k)},'employee','active','S3B-TEST',${k==='finance'?q(users.self):'NULL'})`).join(',')};
      INSERT INTO public.profiles(id,email,employee_id,role,full_name) VALUES
      (${q(users.self)},${q(`s3b-${suffix}-self@example.invalid`)},${q(employees.finance)},'employee','[S3B] self'),
      (${q(users.attacker)},${q(`s3b-${suffix}-attacker@example.invalid`)},NULL,'employee','[S3B] attacker')
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,employee_id=EXCLUDED.employee_id,role=EXCLUDED.role,full_name=EXCLUDED.full_name;
      INSERT INTO public.training_three_level_profiles(employee_id,person_category,onboarding_category,status,employment_started_on,relation_source) VALUES
      ${['finance','party','logistics','entity','conflict','draft','basic','actual','missingOrg'].map(k=>`(${q(employees[k])},'formal_internal','new_hire','required','2025-01-01','S3B-TEST')`).join(',')},
      (${q(employees.legacyVerified)},'formal_internal','legacy_verified','verified','2025-01-01','S3B-TEST'),
      (${q(employees.legacySupplement)},'formal_internal','legacy_supplement','required','2025-01-01','S3B-TEST'),
      (${q(employees.contractor)},'contractor','not_applicable','not_applicable',NULL,'S3B-TEST'),
      (${q(employees.temp)},'temporary_individual','not_applicable','not_applicable',NULL,'S3B-TEST'),
      (${q(employees.visitor)},'visitor','not_applicable','not_applicable',NULL,'S3B-TEST');
      INSERT INTO public.organization_units(id,organization_code,name,organization_type,effective_from) VALUES
      (${q(orgs.finance)},${q(`S3B-${suffix}-FIN`)},'财务资产部','internal_department','2025-01-01'),
      (${q(orgs.party)},${q(`S3B-${suffix}-PTY`)},'党建工作部','internal_department','2025-01-01'),
      (${q(orgs.logistics)},${q(`S3B-${suffix}-LOG`)},'后勤中心','logistics_center','2025-01-01'),
      (${q(orgs.entity)},${q(`S3B-${suffix}-ENT`)},'经营实体','operating_entity','2025-01-01'),
      (${q(orgs.conflict)},${q(`S3B-${suffix}-CON`)},'冲突组织','internal_department','2025-01-01'),
      (${q(orgs.draft)},${q(`S3B-${suffix}-DFT`)},'草稿组织','other_internal_unit','2025-01-01'),
      (${q(orgs.basic)},${q(`S3B-${suffix}-BAS`)},'基本项目组织','other_internal_unit','2025-01-01'),
      (${q(orgs.actual)},${q(`S3B-${suffix}-ACT`)},'具体项目组织','other_internal_unit','2025-01-01');
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES
      (${q(projects.a)},${q(`S3B-${suffix}-A`)},'[S3B] A','active',(SELECT id FROM public.departments WHERE code='D02-ENT-A'),'S3B-TEST'),
      (${q(projects.b)},${q(`S3B-${suffix}-B`)},'[S3B] B','active',(SELECT id FROM public.departments WHERE code='D02-ENT-A'),'S3B-TEST');
      INSERT INTO public.employment_organization_assignments(employment_relation_id,employee_id,organization_unit_id,effective_from,active,version_no,reason)
      SELECT p.employment_relation_id,p.employee_id,x.org_id::uuid,'2025-01-01',TRUE,1,'S3B fixture' FROM public.training_three_level_profiles p JOIN (VALUES
      (${q(employees.finance)},${q(orgs.finance)}),(${q(employees.party)},${q(orgs.party)}),(${q(employees.logistics)},${q(orgs.logistics)}),(${q(employees.entity)},${q(orgs.entity)}),
      (${q(employees.conflict)},${q(orgs.conflict)}),(${q(employees.draft)},${q(orgs.draft)}),(${q(employees.basic)},${q(orgs.basic)}),(${q(employees.actual)},${q(orgs.actual)}),
      (${q(employees.legacyVerified)},${q(orgs.finance)}),(${q(employees.legacySupplement)},${q(orgs.finance)})) x(employee_id,org_id) ON x.employee_id::uuid=p.employee_id;
      INSERT INTO public.training_admission_packages(id,title,version_no,status,training_category,approved_by,approved_at) VALUES
      (${q(packages.v1)},'[S3B] package V1',1,'published','basic_three_level',${q(admin)},'2024-12-01'),
      (${q(packages.v2)},'[S3B] package V2',2,'published','basic_three_level',${q(admin)},NOW());
      INSERT INTO public.training_plans(id,title,level,training_category,department_id,site_project_id,third_level_mode,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
      (${q(plans.company)},'[S3B] company','company','basic_three_level',NULL,NULL,NULL,2026,1,0.5,'planned','approved','published',${q(plans.company)},1,'allow',${q(admin)}),
      (${q(plans.organization)},'[S3B] organization','entity','basic_three_level',(SELECT id FROM public.departments WHERE code='D02-ENT-A'),NULL,NULL,2026,1,0.5,'planned','approved','published',${q(plans.organization)},1,'allow',${q(admin)}),
      (${q(plans.third)},'[S3B] third','project','basic_three_level',NULL,${q(projects.a)},'actual_project',2026,1,0.5,'planned','approved','published',${q(plans.third)},1,'allow',${q(admin)});
      SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_courses(plan_id,title,course_type,content,required,sort_order) SELECT id,'[S3B] course','text','safe',TRUE,1 FROM public.training_plans WHERE id IN(${Object.values(plans).map(q).join(',')});
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES
      ${Object.values(packages).flatMap(pkg=>[[plans.company,'company',1],[plans.organization,'entity',2],[plans.third,'project',3]].map(([plan,level,sort])=>`(${q(pkg)},${q(plan)},'${level}',TRUE,${sort})`)).join(',')};
      SET LOCAL session_replication_role=origin;
      INSERT INTO public.three_level_training_schemes(id,scheme_code,display_name) VALUES
      ${Object.entries(schemes).map(([k,v])=>`(${q(v)},${q(`3L-S3B-${suffix}-${k.toUpperCase()}`)},${q(`[S3B] ${k}`)})`).join(',')};
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary,created_at) VALUES
      ${Object.entries(schemes).map(([k,v])=>`(${q(versions[k])},${q(v)},1,'draft','2025-01-01','V1',NOW())`).join(',')};
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id) VALUES
      ${Object.keys(schemes).flatMap(k=>{const third={finance:'department_position',party:'department_position',logistics:'logistics_position',entity:'entity_position',fallback:'basic_project',conflict:'department_position',draft:'department_position',basic:'basic_project',actual:'actual_project'}[k];return [[1,'company','company'],[2,'organization','organization'],[3,'third',third]].map(([o,l,t])=>`(${q(versions[k])},${o},'${l}','${t}',${q(packages.v1)})`)}).join(',')};
      UPDATE public.three_level_training_scheme_versions SET status='published',published_at='2025-01-01',published_by=(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}) WHERE scheme_id<>${q(schemes.draft)};
      INSERT INTO public.three_level_training_applicability_rules(id,rule_code,scheme_id,organization_unit_id,organization_type,effective_from,priority,active) VALUES
      (${q(rules.finance)},${q(`S3B-${suffix}-FIN`)},${q(schemes.finance)},${q(orgs.finance)},NULL,'2025-01-01',20,TRUE),
      (${q(rules.party)},${q(`S3B-${suffix}-PTY`)},${q(schemes.party)},${q(orgs.party)},NULL,'2025-01-01',20,TRUE),
      (${q(rules.logistics)},${q(`S3B-${suffix}-LOG`)},${q(schemes.logistics)},${q(orgs.logistics)},NULL,'2025-01-01',20,TRUE),
      (${q(rules.entityType)},${q(`S3B-${suffix}-ENT-TYPE`)},${q(schemes.entity)},NULL,'operating_entity','2025-01-01',10,TRUE),
      (${q(rules.internalType)},${q(`S3B-${suffix}-INT-TYPE`)},${q(schemes.fallback)},NULL,'internal_department','2025-01-01',10,TRUE),
      (${q(rules.fallback)},${q(`S3B-${suffix}-FALLBACK`)},${q(schemes.fallback)},NULL,NULL,'2025-01-01',0,TRUE),
      (${q(rules.conflictA)},${q(`S3B-${suffix}-CON-A`)},${q(schemes.finance)},${q(orgs.conflict)},NULL,'2025-01-01',99,TRUE),
      (${q(rules.conflictB)},${q(`S3B-${suffix}-CON-B`)},${q(schemes.conflict)},${q(orgs.conflict)},NULL,'2025-01-01',99,TRUE),
      (${q(rules.draft)},${q(`S3B-${suffix}-DRAFT`)},${q(schemes.draft)},${q(orgs.draft)},NULL,'2025-01-01',20,TRUE),
      (${q(rules.basic)},${q(`S3B-${suffix}-BASIC`)},${q(schemes.basic)},${q(orgs.basic)},NULL,'2025-01-01',20,TRUE),
      (${q(rules.actual)},${q(`S3B-${suffix}-ACTUAL`)},${q(schemes.actual)},${q(orgs.actual)},NULL,'2025-01-01',20,TRUE);
      INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES(${q(projects.a)},(SELECT id FROM public.departments WHERE code='D02-ENT-A'),TRUE),(${q(projects.b)},(SELECT id FROM public.departments WHERE code='D02-ENT-A'),TRUE);
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES(${q(projects.a)},${q(employees.actual)},'internal','active',${q(admin)});
      COMMIT;`);
    const relRows=JSON.parse(scalar(b.databaseUrl,`SELECT jsonb_object_agg(substring(e.employee_no from '[^-]+$'),p.employment_relation_id)::text FROM public.training_three_level_profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.remark='S3B-TEST';`));
    for(const [k,eid] of Object.entries(employees)){relations[k]=relRows[k]||null;}

    let r=resolve('finance'); check('01 finance employee exact scheme',r.status==='resolved'&&r.scheme_id===schemes.finance);
    r=resolve('party'); check('02 party employee corresponding scheme',r.scheme_id===schemes.party);
    r=resolve('logistics'); check('03 logistics employee corresponding scheme',r.scheme_id===schemes.logistics&&r.stages[2].stage_type==='logistics_position');
    r=resolve('entity'); check('04 operating entity type default',r.scheme_id===schemes.entity&&r.precedence===2);
    r=resolve('finance'); check('05 exact organization outranks type',r.scheme_id===schemes.finance&&r.precedence===3);
    r=resolve('entity'); check('06 organization type outranks fallback',r.scheme_id===schemes.entity&&r.precedence===2);
    r=resolve('conflict'); check('07 equal priority conflict ambiguous',r.status==='ambiguous'&&r.reason_code==='training_scheme_ambiguous');
    r=resolve('draft'); check('08 draft is never effective',r.status==='blocked'&&r.reason_code==='training_scheme_version_not_effective');
    r=resolve('finance'); check('09 published version effective',r.status==='resolved'&&r.scheme_version_id===versions.finance);
    r=resolve('finance',null,"'2025-06-01'"); check('10 as_of historical version',r.scheme_version_id===versions.finance);

    for(const [n,k] of [['11 contractor not applicable','contractor'],['12 temporary individual not applicable','temp'],['13 visitor not applicable','visitor']]){r=resolve(k);check(n,r.status==='not_applicable'&&r.reason_code==='three_level_not_applicable');}
    r=json(readUser(b.databaseUrl,admin,`SELECT public.resolve_three_level_training_scheme(${q(employees.missingRelation)},NULL,CURRENT_DATE,NULL);`)); check('14 missing employment relation fail closed',r.reason_code==='employment_relation_required');
    r=resolve('missingOrg'); check('15 missing organization assignment fail closed',r.reason_code==='organization_assignment_required');

    r=resolve('finance');check('16 company stage',r.stages[0].stage_level==='company');check('17 organization stage',r.stages[1].stage_level==='organization');check('18 department_position stage',r.stages[2].stage_type==='department_position');
    r=resolve('logistics');check('19 logistics_position stage',r.stages[2].stage_type==='logistics_position');r=resolve('entity');check('20 entity_position stage',r.stages[2].stage_type==='entity_position');
    r=resolve('basic');check('21 basic_project stage',r.stages[2].stage_type==='basic_project');r=resolve('actual',projects.a);check('22 actual_project valid project passes',r.status==='resolved'&&r.stages[2].site_project_id===projects.a);
    r=resolve('actual');check('23 actual_project without project blocked',r.reason_code==='actual_project_required');r=resolve('finance',projects.b);check('24 non-actual stage does not force project',r.status==='resolved'&&r.site_project_id===null);

    const rawPast=asUser(b.databaseUrl,users.self,`SELECT public.generate_three_level_training_requirement_snapshot(${q(employees.finance)},${q(relations.finance)},CURRENT_DATE-365,NULL,'${suffix}-raw-past');`,true);
    const rawFuture=asUser(b.databaseUrl,users.self,`SELECT public.generate_three_level_training_requirement_snapshot(${q(employees.finance)},${q(relations.finance)},CURRENT_DATE+365,NULL,'${suffix}-raw-future');`,true);
    check('25 raw snapshot generator denies client-selected dates',rawPast.status!==0&&rawPast.err.includes('permission denied')&&rawFuture.status!==0&&rawFuture.err.includes('permission denied'));
    let snap=json(snapshotUser(b.databaseUrl,users.self,`SELECT public.training_ensure_three_level_requirement(${q(employees.finance)},NULL,'${suffix}-snap-1');`));snapshots.push(snap.id);
    check('26 self production entry uses server-current snapshot',snap.items.every(x=>x.training_package_version_id===packages.v1&&x.training_package_version_no===1));
    check('27 scheme version frozen',snap.scheme_version_id===versions.finance);
    psql(b.databaseUrl,`BEGIN;
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary) VALUES(${q(versions.finance2)},${q(schemes.finance)},2,'draft',CURRENT_DATE+1,'V2');
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id)
      SELECT ${q(versions.finance2)},stage_order,stage_level,stage_type,${q(packages.v2)} FROM public.three_level_training_scheme_stages WHERE scheme_version_id=${q(versions.finance)};
      SELECT set_config('app.training_scheme_lifecycle','on',true);
      UPDATE public.three_level_training_scheme_versions SET status='superseded',effective_to=CURRENT_DATE WHERE id=${q(versions.finance)};
      UPDATE public.three_level_training_scheme_versions SET status='published',published_at=NOW(),published_by=(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(admin)}) WHERE id=${q(versions.finance2)}; COMMIT;`);
    let reused=json(snapshotUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(employees.finance)},NULL,'${suffix}-snap-2');`));
    check('28 later V2 does not change V1 snapshot',reused.id===snap.id&&reused.scheme_version_id===versions.finance&&reused.items.every(x=>x.training_package_version_id===packages.v1));
    reused=json(snapshotUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(employees.finance)},${q(projects.b)},'${suffix}-snap-project');`));check('29 project change does not rebuild',reused.id===snap.id);
    reused=json(snapshotUser(b.databaseUrl,admin,`SELECT public.training_ensure_three_level_requirement(${q(employees.finance)},NULL,'${suffix}-snap-repeat');`));check('30 repeated call idempotent',reused.id===snap.id&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshots WHERE employment_relation_id=${q(relations.finance)};`)==='1');
    const concurrentSql=`SELECT public.training_ensure_three_level_requirement(${q(employees.party)},NULL,`;
    const [c1,c2]=await Promise.all([asyncUser(b.databaseUrl,admin,`${concurrentSql}'${suffix}-con-1');`),asyncUser(b.databaseUrl,admin,`${concurrentSql}'${suffix}-con-2');`)]);const cj1=json(c1),cj2=json(c2);snapshots.push(cj1.id);
    check('31 concurrent calls create one authority snapshot',c1.status===0&&c2.status===0&&cj1.id===cj2.id&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_requirement_snapshots WHERE employment_relation_id=${q(relations.party)};`)==='1');
    const immutable=psql(b.databaseUrl,`UPDATE public.training_requirement_snapshots SET scheme_version_id=${q(versions.finance2)} WHERE id=${q(snap.id)};`,true);check('32 snapshot immutable in database',immutable.status!==0&&immutable.err.includes('[S3B:requirement_snapshot_immutable]'));

    r=json(readUser(b.databaseUrl,admin,`SELECT public.explain_three_level_training_resolution(${q(employees.finance)},${q(relations.finance)},CURRENT_DATE,NULL);`));check('33 explain includes evidence and exclusions',Array.isArray(r.evaluated_rules)&&r.evaluated_rules.some(x=>x.matched)&&r.explanation);
    let s=shadow('finance');check('34 shadow new employee applicability',s.comparison.production_cutover&&s.comparison.authority==='requirement_snapshot'&&s.new.applicable&&s.new.stages.length===3);
    s=shadow('legacyVerified');check('35 shadow legacy_verified',s.new.applicable&&s.old.onboarding_category==='legacy_verified');
    s=shadow('legacySupplement');check('36 shadow legacy_supplement',s.new.applicable&&s.old.onboarding_category==='legacy_supplement');
    s=shadow('basic');check('37 shadow basic_project',s.new.applicable&&s.new.stages[2].stage_type==='basic_project');
    s=shadow('actual',projects.a);check('38 shadow actual_project',s.new.applicable&&s.new.stages[2].stage_type==='actual_project');
    s=shadow('finance',projects.b);check('39 shadow project change keeps applicability',s.new.applicable&&s.new.stages[2].site_project_id===null);
    for(const [n,k] of [['40 shadow contractor','contractor'],['41 shadow temporary individual','temp'],['42 shadow visitor','visitor']]){s=shadow(k);check(n,s.comparison.production_cutover&&!s.new.applicable&&s.new.status==='not_applicable');}
    const selfRead=json(readUser(b.databaseUrl,users.self,`SELECT public.training_three_level_requirement_snapshot(${q(employees.finance)},${q(relations.finance)});`));
    const denied=asUser(b.databaseUrl,users.attacker,`SELECT public.resolve_three_level_training_scheme(${q(employees.finance)},${q(relations.finance)},CURRENT_DATE,NULL);`,true);
    check('43 permissions are minimum and direct writes denied',selfRead.id===snap.id&&denied.status!==0&&denied.err.includes('[S3B:forbidden]')&&scalar(b.databaseUrl,`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='authenticated' AND privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE') AND table_name LIKE 'training_requirement_snapshot%';`)==='0');
  }finally{
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_requirement_snapshot_events WHERE snapshot_id IN(SELECT id FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(employees).map(q).join(',')}));
      DELETE FROM public.training_requirement_snapshot_items WHERE snapshot_id IN(SELECT id FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(employees).map(q).join(',')}));
      DELETE FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(employees).map(q).join(',')});
      DELETE FROM public.three_level_training_applicability_rules WHERE id IN(${Object.values(rules).map(q).join(',')});
      DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id IN(${Object.values(versions).map(q).join(',')});
      DELETE FROM public.three_level_training_scheme_versions WHERE id IN(${Object.values(versions).map(q).join(',')});
      DELETE FROM public.three_level_training_schemes WHERE id IN(${Object.values(schemes).map(q).join(',')});
      DELETE FROM public.employment_organization_assignment_history WHERE employment_relation_id IN(SELECT employment_relation_id FROM public.training_three_level_profiles WHERE employee_id IN(${Object.values(employees).map(q).join(',')}));
      DELETE FROM public.employment_organization_assignments WHERE employee_id IN(${Object.values(employees).map(q).join(',')});
      DELETE FROM public.organization_unit_versions WHERE organization_unit_id IN(${Object.values(orgs).map(q).join(',')});
      DELETE FROM public.organization_units WHERE id IN(${Object.values(orgs).map(q).join(',')});
      DELETE FROM public.training_three_level_records WHERE employee_id IN(${Object.values(employees).map(q).join(',')});
      DELETE FROM public.training_assignments WHERE id IN(${Object.values(assignments).map(q).join(',')}) OR employee_id IN(${Object.values(employees).map(q).join(',')}) OR plan_id IN(${Object.values(plans).map(q).join(',')});
      DELETE FROM public.training_admission_package_items WHERE package_id IN(${Object.values(packages).map(q).join(',')});
      DELETE FROM public.training_courses WHERE plan_id IN(${Object.values(plans).map(q).join(',')}); DELETE FROM public.training_plans WHERE id IN(${Object.values(plans).map(q).join(',')});
      DELETE FROM public.project_person_admission_path_history WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.project_person_admission_paths WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.site_project_members WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.site_project_roles WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.site_project_entities WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.site_project_audit_logs WHERE project_id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.site_projects WHERE id IN(${Object.values(projects).map(q).join(',')});
      DELETE FROM public.training_admission_packages WHERE id IN(${Object.values(packages).map(q).join(',')});
      DELETE FROM public.training_three_level_profiles WHERE employee_id IN(${Object.values(employees).map(q).join(',')});
      DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')}));
      DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')}));
      DELETE FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')});
      DELETE FROM public.profiles WHERE id IN(${Object.values(users).map(q).join(',')}); DELETE FROM auth.users WHERE id IN(${Object.values(users).map(q).join(',')});
      DELETE FROM public.training_employees WHERE id IN(${Object.values(employees).map(q).join(',')}); COMMIT;`);
    residual=Number(scalar(b.databaseUrl,`SELECT (SELECT count(*) FROM public.training_employees WHERE id IN(${Object.values(employees).map(q).join(',')}))+(SELECT count(*) FROM public.organization_units WHERE id IN(${Object.values(orgs).map(q).join(',')}))+(SELECT count(*) FROM public.three_level_training_schemes WHERE id IN(${Object.values(schemes).map(q).join(',')}))+(SELECT count(*) FROM public.training_requirement_snapshots WHERE employee_id IN(${Object.values(employees).map(q).join(',')}));`));
    check('44 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`S3B_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);if(failed.length)process.exit(1);
}
if(require.main===module)main().catch(e=>{console.error(String(e.message||e).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

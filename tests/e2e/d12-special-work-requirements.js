/** D12 TARGETED: actual project work, drilling scope and special requirement gate. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { admissionId, asUser, cleanup, createFixture, ids, psql, q, readAuthority, scalar, startSql } = require('./d11-three-level-training-reuse');

process.env.PGCONNECT_TIMEOUT ||= '15';
const root = path.resolve(__dirname, '..', '..');
const migrations = [
  path.join(root, 'sql', 'training-admission-v84-special-work-requirements.sql'),
  path.join(root, 'sql', 'training-admission-v85-d12-r01-p1-fixes.sql'),
];
const migration = migrations[0];
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} D12 ${name}${detail ? ` ${detail}` : ''}`); };
const code = (r, value) => r.status !== 0 && r.err.includes(`[D12:${value}]`);
const status = (db, actor, project, employee) => JSON.parse(asUser(db, actor, `SELECT public.training_current_special_requirements(${q(project)},${q(employee)})::text;`).out.split(/\r?\n/).filter(x => x.startsWith('{')).at(-1));
const member = (db, project, employee) => scalar(db, `SELECT id FROM public.site_project_members WHERE project_id=${q(project)} AND employee_id=${q(employee)};`);
const jwtSql = (userId, sql) => `BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(userId)},true); SELECT set_config('request.jwt.claim.role','authenticated',true); ${sql} COMMIT;`;
function psqlAsync(databaseUrl, sql) { return new Promise(resolve => { const child = spawn('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true }); let out='',err=''; child.stdout.on('data',x=>{out+=x;}); child.stderr.on('data',x=>{err+=x;}); child.on('close',status=>resolve({status,out:out.trim(),err:err.trim()})); child.stdin.end(sql); }); }
function apply(db) { for (const file of migrations) { const r=spawnSync('psql',[db,'-X','-q','-v','ON_ERROR_STOP=1','-f',file],{encoding:'utf8',windowsHide:true}); if(r.error||r.status!==0) throw new Error(`${path.basename(file)} failed: ${String(r.stderr||r.error?.message||'').trim().split(/\r?\n/).at(-1)}`); } }
async function request(base,key,pathName,options={}) { const response=await fetch(base+pathName,{...options,signal:AbortSignal.timeout(15000),headers:{apikey:key,...(options.headers||{})}}); const text=await response.text();let json;try{json=text?JSON.parse(text):null;}catch{json=text;}return{status:response.status,json}; }
async function login(b,key,email,password) { const r=await request(b.apiOrigin,key,'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})}); if(r.status!==200||!r.json?.access_token) throw new Error('D12 temporary login failed');return r.json.access_token; }

async function main() {
  const started=process.hrtime.bigint(); const b=validateTestBoundary(); const key=required('SAFETY_SUPABASE_ANON_KEY'); const f=ids(); let residual=-1;
  const id=()=>crypto.randomUUID();
  f.users.safety=id(); f.users.company=id(); f.users.audit=id(); f.employees.safety=id(); f.employees.temp=id(); f.packages.r02=id();
  f.plans.blasting=id(); f.plans.electrical=id(); f.plans.welding=id(); f.plans.drilling=id();
  f.plans.examBlasting=id(); f.plans.examElectrical=id(); f.plans.examWelding=id(); f.plans.examDrilling=id(); f.plans.examMissing=id();
  const papers=[id(),id(),id(),id()]; const docs=[];
  check('01 isolated TEST boundary',assertD02FixtureMarker(b)>0); apply(b.databaseUrl); readAuthority(b.databaseUrl,f);
  try {
    createFixture(b.databaseUrl,f);
    const managerEmployee=scalar(b.databaseUrl,`SELECT employee_id FROM public.profiles WHERE id=${q(f.manager)};`);
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${q(f.users.safety)},'authenticated','authenticated',${q(`d12-${f.suffix}-s@example.invalid`)},crypt('D12-safe-test-password',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now()),
      ('00000000-0000-0000-0000-000000000000',${q(f.users.company)},'authenticated','authenticated',${q(`d12-${f.suffix}-r@example.invalid`)},crypt('D12-safe-test-password',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES
      (${q(f.employees.safety)},'[D12-TEST] safety',${q(`D12-${f.suffix}-s`)},${q(f.entityA)},'安全员','employee','active','D12-TEST'),
      (${q(f.employees.temp)},'[D12-TEST] temp',${q(`D12-${f.suffix}-t`)},${q(f.entityA)},'临时个人','employee','active','D12-TEST');
      INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,is_super_admin,admin_level) VALUES
      (${q(f.users.safety)},${q(`d12-${f.suffix}-s@example.invalid`)},${q(f.employees.safety)},${q(f.entityA)},'employee','[D12-TEST] safety',false,NULL),
      (${q(f.users.company)},${q(`d12-${f.suffix}-r@example.invalid`)},NULL,NULL,'admin','[D12-TEST] company reader',false,'company');
      INSERT INTO public.site_project_roles(project_id,user_id,role,active) VALUES
      (${q(f.projects.a1)},${q(f.users.safety)},'safety_officer',true),(${q(f.projects.a2)},${q(f.users.safety)},'safety_officer',true);
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES
      (${q(f.projects.a2)},${q(managerEmployee)},'internal','active',${q(f.manager)}),
      (${q(f.projects.a2)},${q(f.employees.safety)},'internal','active',${q(f.manager)}),
      (${q(f.projects.a2)},${q(f.employees.temp)},'temporary','active',${q(f.manager)});
      INSERT INTO public.training_plans(id,title,level,department_id,special_type,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
      (${q(f.plans.blasting)},'[D12-TEST] blasting','special',${q(f.entityA)},'blasting',2026,1,0.5,'planned','approved','published',${q(f.plans.blasting)},1,'allow',${q(f.manager)}),
      (${q(f.plans.electrical)},'[D12-TEST] electrical','special',${q(f.entityA)},'electrical',2026,1,0.5,'planned','approved','published',${q(f.plans.electrical)},1,'allow',${q(f.manager)}),
      (${q(f.plans.welding)},'[D12-TEST] welding','special',${q(f.entityA)},'welding',2026,1,0.5,'planned','approved','published',${q(f.plans.welding)},1,'allow',${q(f.manager)}),
      (${q(f.plans.drilling)},'[D12-TEST] drilling','special',${q(f.entityA)},'drilling',2026,1,0.5,'planned','approved','published',${q(f.plans.drilling)},1,'allow',${q(f.manager)}),
      (${q(f.plans.examBlasting)},'[D12-TEST] blasting exam','company',NULL,NULL,2026,1,0.5,'planned','approved','published',${q(f.plans.examBlasting)},1,'retrain',${q(f.manager)}),
      (${q(f.plans.examElectrical)},'[D12-TEST] electrical exam','company',NULL,NULL,2026,1,0.5,'planned','approved','published',${q(f.plans.examElectrical)},1,'retrain',${q(f.manager)}),
      (${q(f.plans.examWelding)},'[D12-TEST] welding exam','company',NULL,NULL,2026,1,0.5,'planned','approved','published',${q(f.plans.examWelding)},1,'retrain',${q(f.manager)}),
      (${q(f.plans.examDrilling)},'[D12-TEST] drilling exam','company',NULL,NULL,2026,1,0.5,'planned','approved','published',${q(f.plans.examDrilling)},1,'retrain',${q(f.manager)}),
      (${q(f.plans.examMissing)},'[D12-TEST] missing exam paper','company',NULL,NULL,2026,1,0.5,'planned','approved','published',${q(f.plans.examMissing)},1,'retrain',${q(f.manager)});
      INSERT INTO public.training_courses(plan_id,title,course_type,content,required,sort_order) SELECT id,title,'text','safe',true,1 FROM public.training_plans WHERE id IN(${[f.plans.blasting,f.plans.electrical,f.plans.welding,f.plans.drilling].map(q).join(',')});
      INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,status,created_by) VALUES
      (${q(papers[0])},${q(f.plans.examBlasting)},'[D12-TEST] blast paper','fixed',30,80,3,'published',${q(f.manager)}),
      (${q(papers[1])},${q(f.plans.examElectrical)},'[D12-TEST] electric paper','fixed',30,80,3,'published',${q(f.manager)}),
      (${q(papers[2])},${q(f.plans.examWelding)},'[D12-TEST] weld paper','fixed',30,80,3,'published',${q(f.manager)}),
      (${q(papers[3])},${q(f.plans.examDrilling)},'[D12-TEST] drill paper','fixed',30,80,3,'published',${q(f.manager)});
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order)
      SELECT p.id,x.plan_id::uuid,'special',true,x.n FROM public.training_admission_packages p CROSS JOIN (VALUES
        (${q(f.plans.blasting)},10),(${q(f.plans.electrical)},11),(${q(f.plans.welding)},12),(${q(f.plans.drilling)},13)) x(plan_id,n)
      WHERE p.id IN(${[f.packages.a1,f.packages.a2].map(q).join(',')});
      INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id)
      SELECT p.id,x.label,x.plan_id::uuid,x.special_type,x.exam_plan_id::uuid FROM public.training_admission_packages p CROSS JOIN (VALUES
        ('爆破',${q(f.plans.blasting)},'blasting',${q(f.plans.examBlasting)}),('电工',${q(f.plans.electrical)},'electrical',${q(f.plans.examElectrical)}),
        ('焊工',${q(f.plans.welding)},'welding',${q(f.plans.examWelding)}),('钻探',${q(f.plans.drilling)},'drilling',${q(f.plans.examDrilling)})) x(label,plan_id,special_type,exam_plan_id)
      WHERE p.id IN(${[f.packages.a1,f.packages.a2].map(q).join(',')});
      INSERT INTO public.training_admission_packages(id,project_id,title,version_no,validity_years,status,created_by,exam_plan_id)
        VALUES(${q(f.packages.r02)},${q(f.projects.a1)},'[D12-R02-TEST] exact type rules',1,1,'draft',${q(f.manager)},${q(f.plans.examElectrical)});
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES
        (${q(f.packages.r02)},${q(f.plans.blasting)},'special',true,1),(${q(f.packages.r02)},${q(f.plans.electrical)},'special',true,2),
        (${q(f.packages.r02)},${q(f.plans.welding)},'special',true,3),(${q(f.packages.r02)},${q(f.plans.drilling)},'special',true,4),
        (${q(f.packages.r02)},${q(f.plans.examElectrical)},'special',true,5); COMMIT;`);

    const token=await login(b,key,f.auth.internalEmail,f.auth.internalPassword); check('02 real ordinary-person JWT',!!token);
    psql(b.databaseUrl,startSql(f,f.projects.a1,f.employees.internal,f.packages.a1));
    docs.push(scalar(b.databaseUrl,`INSERT INTO public.contractor_documents(project_id,employee_id,document_type,certificate_type,certificate_no,valid_from,valid_until,storage_path,review_status,reviewed_by,reviewed_at) VALUES(${q(f.projects.a1)},${q(f.employees.internal)},'special_certificate','焊工','D12-WELD',CURRENT_DATE-1,CURRENT_DATE+365,'training-admission/contractor-documents/${f.projects.a1}/d12-weld.pdf','approved',${q(f.manager)},NOW()) RETURNING id;`));
    let s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('03 certificate alone does not trigger welding',s.reason_code==='special_work_not_required'&&s.required_special_types.length===0);
    const mInternal=member(b.databaseUrl,f.projects.a1,f.employees.internal);
    const weld=asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(mInternal)},ARRAY['焊工'],'D12 actual welding');`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('04 actual welding triggers exact requirement',weld.status===0&&s.required_special_types.join(',')==='welding'&&s.requirements[0].certificate.state==='valid');
    check('05 configured welding enters training and exam chain',['required','incomplete'].includes(s.requirements[0].training_status)&&s.requirements[0].exam_requirement==='required',`training=${s.requirements[0].training_status} exam=${s.requirements[0].exam_requirement}`);

    const mContractor=member(b.databaseUrl,f.projects.a1,f.employees.contractor);
    asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(mContractor)},ARRAY['爆破'],'D12 actual blasting');`);
    psql(b.databaseUrl,startSql(f,f.projects.a1,f.employees.contractor,f.packages.a1));
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.contractor); check('06 actual blasting without certificate is blocked',s.reason_code==='special_certificate_missing');
    const blastDoc=scalar(b.databaseUrl,`INSERT INTO public.contractor_documents(project_id,contractor_id,employee_id,document_type,certificate_type,certificate_no,valid_from,valid_until,storage_path,review_status) VALUES(${q(f.projects.a1)},${q(f.contractors.known)},${q(f.employees.contractor)},'special_certificate','爆破','D12-BLAST',CURRENT_DATE-10,CURRENT_DATE+10,'training-admission/contractor-documents/${f.projects.a1}/d12-blast.pdf','pending') RETURNING id;`); docs.push(blastDoc);
    check('07 unapproved blasting certificate is blocked',status(b.databaseUrl,f.manager,f.projects.a1,f.employees.contractor).reason_code==='special_certificate_unapproved');
    psql(b.databaseUrl,`UPDATE public.contractor_documents SET review_status='approved',reviewed_by=${q(f.manager)},reviewed_at=NOW(),valid_until=CURRENT_DATE-1 WHERE id=${q(blastDoc)};`);
    check('08 expired blasting certificate is blocked',status(b.databaseUrl,f.manager,f.projects.a1,f.employees.contractor).reason_code==='special_certificate_expired');
    psql(b.databaseUrl,`UPDATE public.contractor_documents SET valid_until=CURRENT_DATE+365 WHERE id=${q(blastDoc)};
      UPDATE public.contractor_documents SET review_status='approved',reviewed_by=${q(f.manager)},reviewed_at=NOW(),review_note='D12 renewed certificate reviewed' WHERE id=${q(blastDoc)};`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.contractor); check('09 valid blasting certificate clears certificate gate',s.requirements[0].certificate.state==='valid',`certificate=${s.requirements[0].certificate.state}`);

    asUser(b.databaseUrl,f.users.safety,`SELECT public.training_set_member_special_work_types(${q(mInternal)},ARRAY['电工','焊工'],'D12 multi actual work');`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('10 exact certificate matching does not let welding satisfy electrical',s.requirements.find(x=>x.special_type==='electrical')?.certificate.state==='missing');
    const electricPath=`training-admission/contractor-documents/${f.projects.a1}/d12-elec-${f.suffix}.pdf`;
    psql(b.databaseUrl,`INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('certificates',${q(electricPath)},${q(f.manager)}) ON CONFLICT(bucket_id,name) DO NOTHING;`);
    const createdCertificate=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.contractor_document_create(${q(f.projects.a1)},NULL,${q(f.employees.internal)},'special_certificate','电工','D12-ELEC',CURRENT_DATE,CURRENT_DATE+365,${q(electricPath)})::text;`).out.split(/\r?\n/).find(x=>x.startsWith('{')));
    docs.push(createdCertificate.document_id);
    const reviewedCertificate=asUser(b.databaseUrl,f.manager,`SELECT public.contractor_document_review(${q(createdCertificate.document_id)},'approved','D12 internal certificate approved');`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('11 formal employee certificate can use governed create/review RPC',createdCertificate.created&&reviewedCertificate.status===0&&s.requirements.find(x=>x.special_type==='electrical')?.certificate.state==='valid');
    const fuzzyCertificate=asUser(b.databaseUrl,f.manager,`SELECT public.contractor_document_create(${q(f.projects.a1)},NULL,${q(f.employees.internal)},'special_certificate','高级电工','D12-FUZZY',CURRENT_DATE,CURRENT_DATE+365,${q(electricPath+'-bad.pdf')});`,true);
    check('12 fuzzy certificate type is rejected',code(fuzzyCertificate,'invalid_certificate'));
    const outOfScopeCertificate=asUser(b.databaseUrl,f.manager,`SELECT public.contractor_document_create(${q(f.projects.a1)},NULL,${q(f.employees.temp)},'special_certificate','电工','D12-OUT',CURRENT_DATE,CURRENT_DATE+365,${q(electricPath+'-out.pdf')});`,true);
    check('13 certificate person identity and project membership are enforced',code(outOfScopeCertificate,'certificate_person_out_of_scope'));
    check('14 electrical and welding can coexist',s.required_special_types.includes('electrical')&&s.required_special_types.includes('welding'));
    check('15 two requirements remain independent',s.requirements.length===2&&new Set(s.requirements.map(x=>x.training_plan_id)).size===2);
    asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(mInternal)},ARRAY['电工'],'D12 cancel welding only');`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('16 cancelling welding preserves electrical',s.required_special_types.join(',')==='electrical');
    check('17 cancellation keeps immutable history',Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.training_special_work_audit_logs WHERE member_id=${q(mInternal)} AND special_type='welding';`))>=2);
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE public.training_assignments SET status='completed',progress=100,hours_earned=0.5,completed_at=NOW() WHERE plan_id=${q(f.plans.electrical)} AND employee_id=${q(f.employees.internal)};
      INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,status,progress,exam_status,exam_score)
        VALUES(${q(f.plans.examElectrical)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)},'completed',100,'passed',100)
        ON CONFLICT(plan_id,employee_id) DO UPDATE SET exam_status='passed',exam_score=100; COMMIT;`);
    s=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('18 completed training plus passed exact exam satisfies requirement',s.overall_satisfied&&s.reason_code==='special_requirements_satisfied');
    check('19 project A work does not pollute project B',status(b.databaseUrl,f.manager,f.projects.a2,f.employees.internal).actual_special_work.length===0);

    const selfDenied=asUser(b.databaseUrl,f.users.internal,`SELECT public.training_set_member_special_work_types(${q(mInternal)},ARRAY['焊工'],'self escalation');`,true);
    check('20 ordinary person cannot self-select actual work',code(selfDenied,'forbidden'));
    const crossDenied=asUser(b.databaseUrl,f.users.safety,`SELECT public.training_set_member_special_work_types(${q(member(b.databaseUrl,f.projects.b1,f.employees.internal))},ARRAY['电工'],'cross project');`,true);
    check('21 safety officer cannot modify another project',code(crossDenied,'forbidden'));
    check('22 company read permission does not grant manage',status(b.databaseUrl,f.users.company,f.projects.a1,f.employees.internal).membership_active===true&&code(asUser(b.databaseUrl,f.users.company,`SELECT public.training_set_member_special_work_types(${q(mInternal)},ARRAY['焊工'],'read is not manage');`,true),'forbidden'));
    const direct=await request(b.apiOrigin,key,`/rest/v1/site_project_members?id=eq.${mInternal}`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({special_work_types:['焊工']})});
    check('23 direct REST cannot bypass actual-work RPC',[401,403].includes(direct.status));

    const beforeDrilling=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.training_project_special_requirements(${q(f.projects.a2)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('[')).at(-1));
    check('24 includes_drilling=false does not trigger drilling',beforeDrilling.length>=5&&beforeDrilling.every(x=>!x.drilling_required));
    const mTemp=member(b.databaseUrl,f.projects.a2,f.employees.temp);
    asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(mTemp)},ARRAY['电工'],'D12 temporary individual actual electrical');`);
    check('25 temporary individual actual work follows same exact gate',status(b.databaseUrl,f.manager,f.projects.a2,f.employees.temp).required_special_types.join(',')==='electrical');
    asUser(b.databaseUrl,f.manager,`SELECT public.site_project_set_drilling_operation(${q(f.projects.a2)},true,'D12 drilling project');`);
    const drillRows=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.training_project_special_requirements(${q(f.projects.a2)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('[')).at(-1));
    check('26 includes_drilling=true is project authoritative',drillRows.length>=5&&drillRows.every(x=>x.drilling_required));
    check('27 project manager is in drilling scope',drillRows.some(x=>x.employee_id===managerEmployee&&x.required_special_types.includes('drilling')));
    check('28 safety officer is in drilling scope',drillRows.some(x=>x.employee_id===f.employees.safety&&x.required_special_types.includes('drilling')));
    check('29 internal employee is in drilling scope',drillRows.some(x=>x.employee_id===f.employees.internal&&x.required_special_types.includes('drilling')));
    check('30 contractor is in drilling scope',drillRows.some(x=>x.employee_id===f.employees.contractor&&x.required_special_types.includes('drilling')));
    check('31 temporary individual is in drilling scope',drillRows.some(x=>x.employee_id===f.employees.temp&&x.required_special_types.includes('drilling')));
    check('32 drilling never requires personal certificate',drillRows.every(x=>x.requirements.find(y=>y.special_type==='drilling')?.certificate.state==='not_required'));
    docs.push(scalar(b.databaseUrl,`INSERT INTO public.contractor_documents(project_id,employee_id,document_type,certificate_type,storage_path,review_status,review_note) VALUES(${q(f.projects.a2)},${q(f.employees.temp)},'other','钻探','training-admission/contractor-documents/${f.projects.a2}/legacy-drilling.pdf','approved','legacy only') RETURNING id;`));
    check('33 legacy drilling document does not enter gate',status(b.databaseUrl,f.manager,f.projects.a2,f.employees.temp).requirements.find(x=>x.special_type==='drilling').certificate.required===false);
    psql(b.databaseUrl,`UPDATE public.site_project_members SET status='left',left_at=NOW() WHERE project_id=${q(f.projects.a2)} AND employee_id=${q(f.employees.temp)};`);
    const afterLeft=JSON.parse(asUser(b.databaseUrl,f.manager,`SELECT public.training_project_special_requirements(${q(f.projects.a2)})::text;`).out.split(/\r?\n/).filter(x=>x.startsWith('[')).at(-1));
    check('34 inactive member leaves current drilling scope',!afterLeft.some(x=>x.employee_id===f.employees.temp));

    asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(member(b.databaseUrl,f.projects.b1,f.employees.internal))},ARRAY['爆破'],'D12 missing mapping');`);
    psql(b.databaseUrl,startSql(f,f.projects.b1,f.employees.internal,f.packages.b1));
    check('35 missing special training plan fails closed',status(b.databaseUrl,f.manager,f.projects.b1,f.employees.internal).blocked_reasons.includes('special_training_plan_missing'));
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES(${q(f.packages.b1)},${q(f.plans.blasting)},'special',true,20) ON CONFLICT DO NOTHING;
      INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id) VALUES(${q(f.packages.b1)},'爆破',${q(f.plans.blasting)},'blasting',${q(f.plans.examMissing)});
      UPDATE public.training_plans SET publish_status='draft' WHERE id=${q(f.plans.blasting)}; COMMIT;`);
    check('36 nonpublished special training plan fails closed',status(b.databaseUrl,f.manager,f.projects.b1,f.employees.internal).blocked_reasons.includes('special_training_plan_missing'));
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_plans SET publish_status='published' WHERE id=${q(f.plans.blasting)}; COMMIT;`);
    check('37 missing published exam paper fails closed',status(b.databaseUrl,f.manager,f.projects.b1,f.employees.internal).blocked_reasons.includes('special_exam_plan_missing'));
    psql(b.databaseUrl,`UPDATE public.contractor_documents SET review_status='rejected',revoked_at=NOW(),revoked_by=${q(f.manager)},revocation_reason='D12 revoked test' WHERE id=${q(blastDoc)};`);
    check('38 revoked exact certificate fails closed',status(b.databaseUrl,f.manager,f.projects.a1,f.employees.contractor).reason_code==='special_certificate_revoked');
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES(${q(f.packages.a3)},${q(f.plans.welding)},'special',true,20);
      INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id) VALUES(${q(f.packages.a3)},'焊工',${q(f.plans.welding)},'welding',${q(f.plans.examMissing)}); COMMIT;`);
    const mConcurrent=member(b.databaseUrl,f.projects.a1,f.employees.concurrent);
    const concurrent=await Promise.all([
      psqlAsync(b.databaseUrl,jwtSql(f.manager,`SELECT public.training_set_member_special_work_types(${q(mConcurrent)},ARRAY['电工'],'D12 concurrent electrical');`)),
      psqlAsync(b.databaseUrl,jwtSql(f.manager,`SELECT public.training_set_member_special_work_types(${q(mConcurrent)},ARRAY['焊工'],'D12 concurrent welding');`)),
    ]);
    const finalTypes=JSON.parse(scalar(b.databaseUrl,`SELECT to_json(special_work_types)::text FROM public.site_project_members WHERE id=${q(mConcurrent)};`));
    check('39 concurrent updates serialize to one final state',concurrent.every(x=>x.status===0)&&finalTypes.length===1&&['电工','焊工'].includes(finalTypes[0]));
    const auditBefore=scalar(b.databaseUrl,`SELECT count(*) FROM public.training_special_work_audit_logs WHERE member_id=${q(mConcurrent)};`);
    const same=asUser(b.databaseUrl,f.manager,`SELECT public.training_set_member_special_work_types(${q(mConcurrent)},ARRAY[${q(finalTypes[0])}],'D12 idempotent retry');`);
    check('40 repeated request is idempotent',same.out.includes('"changed": false')&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_special_work_audit_logs WHERE member_id=${q(mConcurrent)};`)===auditBefore);
    const historyEdit=psql(b.databaseUrl,`UPDATE public.training_special_work_audit_logs SET reason='changed' WHERE member_id=${q(mConcurrent)};`,true);
    check('41 audit history is immutable',historyEdit.status!==0&&historyEdit.err.includes('[D12:special_work_history_locked]'));
    check('42 audit records operator role/time/reason',scalar(b.databaseUrl,`SELECT count(*) FROM public.training_special_work_audit_logs WHERE member_id=${q(mInternal)} AND operator_id IS NOT NULL AND operator_role<>'' AND changed_at IS NOT NULL AND reason<>'';`)!=='0');
    check('43 RLS/grants are fail closed',scalar(b.databaseUrl,`SELECT (SELECT relrowsecurity FROM pg_class WHERE oid='public.training_special_work_audit_logs'::regclass) AND NOT has_table_privilege('authenticated','public.training_special_work_audit_logs','INSERT') AND NOT has_table_privilege('authenticated','public.training_admission_special_rules','UPDATE');`)==='t');

    const setRules = rules => asUser(b.databaseUrl,f.manager,`SELECT public.training_set_package_special_requirements(${q(f.packages.r02)},${q(JSON.stringify(rules))}::jsonb);`,true);
    const correctRule=setRules([{special_type:'electrical',training_plan_id:f.plans.electrical,exam_plan_id:f.plans.examElectrical}]);
    check('48 R02 exact electrical plan is accepted',correctRule.status===0&&scalar(b.databaseUrl,`SELECT count(*) FROM public.training_admission_special_rules WHERE package_id=${q(f.packages.r02)} AND special_type='electrical' AND plan_id=${q(f.plans.electrical)};`)==='1');
    const mismatches=[
      ['49 R02 electrical rejects welding plan','electrical',f.plans.welding],
      ['50 R02 welding rejects electrical plan','welding',f.plans.electrical],
      ['51 R02 blasting rejects unrelated special plan','blasting',f.plans.drilling],
      ['52 R02 drilling rejects wrong special plan','drilling',f.plans.welding],
      ['53 R02 null special type plan fails closed','electrical',f.plans.examElectrical],
    ];
    for(const [name,type,plan] of mismatches){
      const rejected=setRules([{special_type:type,training_plan_id:plan,exam_plan_id:f.plans.examElectrical}]);
      check(name,code(rejected,'special_training_type_mismatch'));
    }
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE public.training_admission_special_rules SET plan_id=${q(f.plans.welding)} WHERE package_id=${q(f.packages.a1)} AND special_type='electrical';
      COMMIT;`);
    const legacyMismatch=status(b.databaseUrl,f.manager,f.projects.a1,f.employees.internal);
    check('54 R02 legacy mismatched mapping remains fail closed',legacyMismatch.blocked_reasons.includes('special_training_plan_missing'));
    psql(b.databaseUrl,`UPDATE public.training_admission_special_rules SET plan_id=${q(f.plans.electrical)} WHERE package_id=${q(f.packages.a1)} AND special_type='electrical';`);

    const truncateTables=['site_projects','site_project_members','training_admissions','training_admission_tasks','training_admission_special_rules','training_assignments','training_plans'];
    const truncateGrants=Number(scalar(b.databaseUrl,`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN(${truncateTables.map(q).join(',')}) AND grantee IN('anon','authenticated') AND privilege_type='TRUNCATE';`));
    check('55 R02 anon/authenticated have no D12 core TRUNCATE privilege',truncateGrants===0,`grants=${truncateGrants}`);

    psql(b.databaseUrl,`INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${q(f.users.audit)},'authenticated','authenticated',${q(`d12-${f.suffix}-audit@example.invalid`)},crypt('D12-audit-test-password',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
      INSERT INTO public.training_special_work_audit_logs(member_id,project_id,employee_id,special_type,old_active,new_active,operator_id,operator_role,reason)
      VALUES(${q(mInternal)},${q(f.projects.a1)},${q(f.employees.internal)},'welding',false,true,${q(f.users.audit)},'test_operator','D12 operator deletion snapshot test');`);
    const auditBeforeDelete=JSON.parse(scalar(b.databaseUrl,`SELECT json_build_object('operator_id',operator_id,'snapshot',operator_subject_id,'role',operator_role,'reason',reason,'changed_at',changed_at)::text FROM public.training_special_work_audit_logs WHERE operator_id=${q(f.users.audit)};`));
    check('56 R02 new audit stores operator snapshot',auditBeforeDelete.operator_id===f.users.audit&&auditBeforeDelete.snapshot===f.users.audit);
    psql(b.databaseUrl,`DELETE FROM auth.users WHERE id=${q(f.users.audit)};`);
    const auditAfterDelete=JSON.parse(scalar(b.databaseUrl,`SELECT json_build_object('operator_id',operator_id,'snapshot',operator_subject_id,'role',operator_role,'reason',reason,'changed_at',changed_at)::text FROM public.training_special_work_audit_logs WHERE operator_subject_id=${q(f.users.audit)};`));
    check('57 R02 account deletion clears live FK but preserves operator snapshot',auditAfterDelete.operator_id===null&&auditAfterDelete.snapshot===f.users.audit&&auditAfterDelete.role&&auditAfterDelete.reason&&auditAfterDelete.changed_at);
    const snapshotTamper=asUser(b.databaseUrl,f.users.internal,`UPDATE public.training_special_work_audit_logs SET operator_subject_id=${q(f.users.internal)} WHERE operator_subject_id=${q(f.users.audit)};`,true);
    check('58 R02 ordinary user cannot alter operator snapshot',snapshotTamper.status!==0);
    check('59 final database retains v85 closure objects',scalar(b.databaseUrl,`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='training_special_work_audit_logs' AND column_name='operator_subject_id') AND pg_get_functiondef('public.training_special_rule_type_guard()'::regprocedure) LIKE '%special_training_type_mismatch%';`)==='t');

    const web=['admission-operations.js','admission-mine.js','admission-packages.js'].map(x=>fs.readFileSync(path.join(root,'js/modules/training',x),'utf8')).join('\n');
    check('44 Web shows server status and controlled multi-select',['training_current_special_requirements','training_project_special_requirements','d12-special-work','includes_drilling=true'].every(x=>web.includes(x)));
    const contract=JSON.parse(fs.readFileSync(path.join(root,'docs/contracts/D12-special-work-requirements-v1.json'),'utf8'));
    check('45 machine contract publishes D13/D18 handoff',contract.version==='D12-special-work-requirements-v1'&&contract.consumers.includes('D13')&&contract.consumers.includes('D18'));
    const d11=fs.readFileSync(path.join(root,'sql/training-admission-v83-employee-three-level-foundation.sql'),'utf8');
    check('46 D11 employee three-level meaning remains independent',d11.includes('training_three_level_profiles')&&!migrations.some(file=>fs.readFileSync(file,'utf8').includes('UPDATE public.training_three_level_profiles')));
  } finally {
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_special_work_audit_logs WHERE project_id IN(${Object.values(f.projects).map(q).join(',')});
      DELETE FROM public.contractor_documents WHERE id IN(${docs.length?docs.map(q).join(','):'NULL'});
      DELETE FROM storage.objects WHERE bucket_id='certificates' AND name LIKE ${q(`training-admission/contractor-documents/${f.projects.a1}/d12-%`)};
      DELETE FROM public.exam_papers WHERE id IN(${papers.map(q).join(',')}); COMMIT;`);
    residual=cleanup(b.databaseUrl,f);
    const extra=Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.training_special_work_audit_logs WHERE project_id IN(${Object.values(f.projects).map(q).join(',')});`));
    residual+=extra; check('47 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass); const seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`D12_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length) process.exit(1);
}
if(require.main===module) main().catch(error=>{console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);});

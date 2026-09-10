/** D11 three-level assignment, reuse, history and exam-gate TARGETED/FINAL evidence. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { validateTestBoundary, assertD02FixtureMarker } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migration = path.join(root, 'sql', 'training-admission-v81-three-level-reuse.sql');
const results = [];
const q = value => `'${String(value).replace(/'/g, "''")}'`;
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} D11 ${name}${detail ? ` ${detail}` : ''}`);
}
function psql(databaseUrl, sql, allowFailure = false) {
  const retrySafe = !/\bINSERT\b/i.test(sql) && !/\bSELECT\s+public\./i.test(sql);
  let run;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    run = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
      input: sql, encoding: 'utf8', windowsHide: true,
    });
    const transient = /server closed the connection unexpectedly|connection .* failed|could not connect/i.test(String(run.stderr || run.error?.message || ''));
    if (!(attempt < 2 && retrySafe && transient)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1));
  }
  if (!allowFailure && (run.error || run.status !== 0)) {
    throw new Error(String(run.stderr || run.error?.message || '数据库执行失败')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim());
  }
  return { status: run.status, out: String(run.stdout || '').trim(), err: String(run.stderr || '').trim() };
}
function psqlAsync(databaseUrl, sql) {
  return new Promise(resolve => {
    const child = spawn('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    child.on('close', status => resolve({ status, out: out.trim(), err: err.trim() }));
    child.stdin.end(sql);
  });
}
function apply(databaseUrl) {
  if (scalar(databaseUrl, "SELECT to_regprocedure('public.site_project_set_risk_tags(uuid,text[],text)') IS NOT NULL;") === 't') return;
  const run = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration], {
    encoding: 'utf8', windowsHide: true,
  });
  if (run.error || run.status !== 0) throw new Error(`v81 migration failed: ${String(run.stderr || '').trim().split(/\r?\n/).at(-1)}`);
}
const jwtSql = (userId, sql) => `BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',${q(userId)},true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
${sql}
COMMIT;`;
const scalar = (db, sql) => psql(db, sql).out.split(/\r?\n/).filter(Boolean).at(-1) || '';
function asUser(db, userId, sql, allowFailure = false) { return psql(db, jwtSql(userId, sql), allowFailure); }
function expectCode(db, userId, sql, code) {
  const r = asUser(db, userId, sql, true);
  return r.status !== 0 && r.err.includes(`[D11:${code}]`);
}

function ids() {
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const id = () => crypto.randomUUID();
  return {
    suffix, manager: null, entityA: null, entityB: null,
    auth: {
      internalEmail: `d11-${suffix}-i@example.invalid`, internalPassword: `D11-${crypto.randomUUID()}!`,
      contractorEmail: `d11-${suffix}-c@example.invalid`, contractorPassword: `D11-${crypto.randomUUID()}!`,
    },
    projects: { a1: id(), a2: id(), b1: id(), a3: id() },
    users: { internal: id(), contractor: id() },
    employees: { internal: id(), contractor: id(), leader: id(), missing: id(), concurrent: id(), unknown: id() },
    contractors: { known: id(), unknown: id() },
    plans: { company: id(), company2: id(), entityA: id(), entityB: id(), projectA1: id(), projectA2: id(), projectB1: id(), projectA3: id(), exam: id() },
    packages: { a1: id(), a2: id(), b1: id(), a3: id(), missing: id() },
    paper: id(), question: id(),
  };
}

function readAuthority(db, f) {
  const raw = scalar(db, `SELECT json_build_object(
    'entity_a',(SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'entity_b',(SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'manager',(SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001')
  )::text;`);
  const a = JSON.parse(raw); Object.assign(f, { entityA: a.entity_a, entityB: a.entity_b, manager: a.manager });
  if (!f.entityA || !f.entityB || !f.manager) throw new Error('D02 authoritative fixtures unavailable');
}

function createFixture(db, f) {
  const p = f.projects, e = f.employees, pl = f.plans, pk = f.packages, auth = f.auth;
  const projectValues = Object.entries(p).map(([key, id]) => `(${q(id)},${q(`D11-${f.suffix}-${key}`)},${q(`[D11-TEST] ${key}`)},'active',${q(key === 'b1' ? f.entityB : f.entityA)},'D11-TEST')`).join(',');
  const employeeValues = [
    [e.internal, 'internal', f.entityA, '普通员工'], [e.contractor, 'contractor', f.entityA, '外协人员'],
    [e.leader, 'leader', f.entityA, '公司领导'], [e.missing, 'missing', f.entityA, '普通员工'],
    [e.concurrent, 'concurrent', f.entityA, '普通员工'], [e.unknown, 'unknown', f.entityA, '外协人员'],
  ].map(([id, no, dept, position]) => `(${q(id)},${q(`[D11-TEST] ${no}`)},${q(`D11-${f.suffix}-${no}`)},${q(dept)},${q(position)},'employee','active','D11-TEST')`).join(',');
  const planRows = [
    [pl.company,'company',null,null,pl.company,'allow'], [pl.company2,'company',null,null,pl.company,'retrain'],
    [pl.entityA,'entity',f.entityA,null,pl.entityA,'allow'], [pl.entityB,'entity',f.entityB,null,pl.entityB,'allow'],
    [pl.projectA1,'project',null,p.a1,pl.projectA1,'allow'], [pl.projectA2,'project',null,p.a2,pl.projectA2,'allow'],
    [pl.projectB1,'project',null,p.b1,pl.projectB1,'allow'], [pl.projectA3,'project',null,p.a3,pl.projectA3,'allow'],
    [pl.exam,'company',null,null,pl.exam,'retrain'],
  ].map(([id,level,dept,project,rootId,reuse], index) => `(${q(id)},${q(`[D11-TEST] plan ${index}`)},${q(level)},'basic_three_level',${dept ? q(dept) : 'NULL'},${project ? q(project) : 'NULL'},${level === 'project' ? "'actual_project'" : 'NULL'},2026,1,0.5,'planned','approved','published',${q(rootId)},${index === 1 ? 2 : 1},${q(reuse)},${q(f.manager)})`).join(',');
  const packages = [
    [pk.a1,p.a1,'A1'], [pk.a2,p.a2,'A2'], [pk.b1,p.b1,'B1'], [pk.a3,p.a3,'A3'], [pk.missing,p.a2,'MISSING'],
  ].map(([id,project,title]) => `(${q(id)},${q(project)},${q(`[D11-TEST] ${title}`)},1,1,'published',${q(f.manager)},${q(pl.exam)})`).join(',');
  const item = (pack, plan, level, order) => `(${q(pack)},${q(plan)},${q(level)},true,${order})`;
  const items = [
    item(pk.a1,pl.company,'company',1),item(pk.a1,pl.entityA,'entity',2),item(pk.a1,pl.projectA1,'project',3),
    item(pk.a2,pl.company,'company',1),item(pk.a2,pl.entityA,'entity',2),item(pk.a2,pl.projectA2,'project',3),
    item(pk.b1,pl.company,'company',1),item(pk.b1,pl.entityB,'entity',2),item(pk.b1,pl.projectB1,'project',3),
    item(pk.a3,pl.company2,'company',1),item(pk.a3,pl.entityA,'entity',2),item(pk.a3,pl.projectA3,'project',3),
    item(pk.missing,pl.company,'company',1),item(pk.missing,pl.projectA2,'project',3),
  ].join(',');
  psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES ${projectValues};
INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES
 (${q(p.a1)},${q(f.entityA)},true),(${q(p.a2)},${q(f.entityA)},true),(${q(p.a3)},${q(f.entityA)},true),(${q(p.b1)},${q(f.entityB)},true);
INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES ${employeeValues};
INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-000000000000',${q(f.users.internal)},'authenticated','authenticated',${q(auth.internalEmail)},crypt(${q(auth.internalPassword)},gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now()),
 ('00000000-0000-0000-0000-000000000000',${q(f.users.contractor)},'authenticated','authenticated',${q(auth.contractorEmail)},crypt(${q(auth.contractorPassword)},gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,is_super_admin,admin_level)
 VALUES(${q(f.users.internal)},${q(auth.internalEmail)},${q(e.internal)},${q(f.entityA)},'employee','[D11-TEST] internal',false,NULL),
       (${q(f.users.contractor)},${q(auth.contractorEmail)},${q(e.contractor)},${q(f.entityA)},'employee','[D11-TEST] contractor',false,NULL)
 ON CONFLICT(id) DO UPDATE SET employee_id=EXCLUDED.employee_id,department_id=EXCLUDED.department_id,role='employee',full_name=EXCLUDED.full_name,is_super_admin=false,admin_level=NULL;
INSERT INTO public.account_subjects(auth_user_id,employee_id)
 VALUES(${q(f.users.internal)},${q(e.internal)}),(${q(f.users.contractor)},${q(e.contractor)});
INSERT INTO public.account_lifecycle(subject_id)
 SELECT id FROM public.account_subjects WHERE auth_user_id IN(${q(f.users.internal)},${q(f.users.contractor)});
INSERT INTO public.contractor_companies(id,name,unified_code,status,managing_entity_id,created_by) VALUES
 (${q(f.contractors.known)},${q(`[D11-TEST] known ${f.suffix}`)},${q(`D11K${f.suffix}`)},'active',${q(f.entityA)},${q(f.manager)}),
 (${q(f.contractors.unknown)},${q(`[D11-TEST] unknown ${f.suffix}`)},${q(`D11U${f.suffix}`)},'active',NULL,${q(f.manager)});
INSERT INTO public.training_plans(id,title,level,training_category,department_id,site_project_id,third_level_mode,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES ${planRows};
INSERT INTO public.training_courses(plan_id,title,course_type,content,required,sort_order)
 SELECT id,'[D11-TEST] course','text','D11 safe content',true,1 FROM public.training_plans WHERE id IN (${Object.values(pl).map(q).join(',')});
INSERT INTO public.training_admission_packages(id,project_id,title,version_no,validity_years,status,created_by,exam_plan_id) VALUES ${packages};
INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES ${items};
INSERT INTO public.exam_papers(id,plan_id,title,mode,duration_min,pass_score,retry_limit,status,created_by,exam_type,exam_semantic_type) VALUES (${q(f.paper)},${q(pl.exam)},'[D11-TEST] exam','fixed',30,80,3,'published',${q(f.manager)},'general','general');
INSERT INTO public.exam_questions(id,scope,question_type,stem,options,answer,status,created_by) VALUES (${q(f.question)},'company','single','[D11-TEST] question','[{"key":"A","text":"ok"}]','A','published',${q(f.manager)});
INSERT INTO public.exam_paper_questions(paper_id,question_id,score,sort_order) VALUES (${q(f.paper)},${q(f.question)},100,1);
INSERT INTO public.site_project_roles(project_id,user_id,role,active) SELECT id,${q(f.manager)},'project_manager',true FROM public.site_projects WHERE id IN (${Object.values(p).map(q).join(',')});
INSERT INTO public.site_project_members(project_id,employee_id,membership_type,contractor_id,status,created_by) VALUES
 (${q(p.a1)},${q(e.internal)},'internal',NULL,'active',${q(f.manager)}),(${q(p.a2)},${q(e.internal)},'internal',NULL,'active',${q(f.manager)}),
 (${q(p.b1)},${q(e.internal)},'internal',NULL,'active',${q(f.manager)}),(${q(p.a3)},${q(e.internal)},'internal',NULL,'active',${q(f.manager)}),
 (${q(p.a1)},${q(e.contractor)},'external',${q(f.contractors.known)},'active',${q(f.manager)}),(${q(p.a2)},${q(e.contractor)},'external',${q(f.contractors.known)},'active',${q(f.manager)}),(${q(p.b1)},${q(e.contractor)},'external',${q(f.contractors.known)},'active',${q(f.manager)}),
 (${q(p.a1)},${q(e.leader)},'internal',NULL,'active',${q(f.manager)}),(${q(p.a2)},${q(e.missing)},'internal',NULL,'active',${q(f.manager)}),
 (${q(p.a1)},${q(e.concurrent)},'internal',NULL,'active',${q(f.manager)}),(${q(p.a1)},${q(e.unknown)},'external',${q(f.contractors.unknown)},'active',${q(f.manager)});
COMMIT;`);
}

function startSql(f, project, employee, pack, sleep = 0) {
  return jwtSql(f.manager, `SELECT public.training_start_admission(${q(project)},${q(employee)},${q(pack)},NOW()+INTERVAL '2 days',false);${sleep ? ` SELECT pg_sleep(${sleep});` : ''}`);
}
function admissionId(db, project, employee) { return scalar(db, `SELECT id FROM public.training_admissions WHERE project_id=${q(project)} AND employee_id=${q(employee)};`); }
function complete(db, admission, levels = ['company','entity','project']) {
  psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
UPDATE public.training_admission_tasks SET status='completed',progress=100,effective_hours=COALESCE(required_hours,planned_hours,0),
 fulfillment_kind='original',completed_at=COALESCE(completed_at,NOW()),decision_code='original_completed',evaluated_at=NOW()
WHERE admission_id=${q(admission)} AND level=ANY(ARRAY[${levels.map(q).join(',')}]); COMMIT;`);
}
function status(db, f, project, employee, actor = f.manager) {
  return JSON.parse(asUser(db, actor, `SELECT public.training_three_level_status(${q(project)},${q(employee)})::text;`).out.split(/\r?\n/).filter(x => x.startsWith('{')).at(-1));
}
function cleanup(db, f) {
  const projects = Object.values(f.projects).map(q).join(','), employees = Object.values(f.employees).map(q).join(','), plans = Object.values(f.plans).map(q).join(',');
  psql(db, `BEGIN; SET LOCAL session_replication_role=replica;
DELETE FROM public.exam_attempts WHERE employee_id IN (${employees});
DELETE FROM public.training_three_level_audit_logs WHERE employee_id IN (${employees});
DELETE FROM public.training_three_level_legacy_evidence WHERE employee_id IN (${employees});
DELETE FROM public.training_three_level_records WHERE employee_id IN (${employees});
DELETE FROM public.training_three_level_profiles WHERE employee_id IN (${employees});
DELETE FROM public.training_admission_signatures WHERE admission_id IN (SELECT id FROM public.training_admissions WHERE employee_id IN (${employees}));
DELETE FROM public.training_admission_tasks WHERE admission_id IN (SELECT id FROM public.training_admissions WHERE employee_id IN (${employees}));
DELETE FROM public.training_admissions WHERE employee_id IN (${employees});
DELETE FROM public.training_assignments WHERE employee_id IN (${employees}) OR plan_id IN (${plans});
DELETE FROM public.exam_paper_questions WHERE paper_id=${q(f.paper)}; DELETE FROM public.exam_questions WHERE id=${q(f.question)}; DELETE FROM public.exam_papers WHERE id=${q(f.paper)};
DELETE FROM public.training_admission_package_items WHERE package_id IN (${Object.values(f.packages).map(q).join(',')});
DELETE FROM public.training_admission_packages WHERE id IN (${Object.values(f.packages).map(q).join(',')});
DELETE FROM public.training_courses WHERE plan_id IN (${plans}); DELETE FROM public.training_plans WHERE id IN (${plans});
DELETE FROM public.project_person_admission_path_history WHERE project_id IN (${projects});
DELETE FROM public.project_person_admission_paths WHERE project_id IN (${projects});
DELETE FROM public.site_project_members WHERE project_id IN (${projects}); DELETE FROM public.site_project_roles WHERE project_id IN (${projects});
DELETE FROM public.site_project_entities WHERE project_id IN (${projects}); DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projects});
DELETE FROM public.site_projects WHERE id IN (${projects});
DELETE FROM public.contractor_company_versions WHERE contractor_id IN (${Object.values(f.contractors).map(q).join(',')});
DELETE FROM public.contractor_companies WHERE id IN (${Object.values(f.contractors).map(q).join(',')});
DELETE FROM public.account_high_privilege_approvals WHERE target_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')})) OR requested_by_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')})) OR reviewed_by_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')}));
DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')})) OR operator_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')}));
DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')}));
DELETE FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')});
DELETE FROM public.profiles WHERE id IN (${Object.values(f.users).map(q).join(',')});
DELETE FROM auth.users WHERE id IN (${Object.values(f.users).map(q).join(',')}); DELETE FROM public.training_employees WHERE id IN (${employees}); COMMIT;`);
  return Number(scalar(db, `SELECT (SELECT count(*) FROM public.site_projects WHERE id IN (${projects}))
    +(SELECT count(*) FROM public.training_employees WHERE id IN (${employees}))
    +(SELECT count(*) FROM public.training_plans WHERE id IN (${plans}))
    +(SELECT count(*) FROM public.training_three_level_profiles WHERE employee_id IN (${employees}))
    +(SELECT count(*) FROM public.training_three_level_records WHERE employee_id IN (${employees}))
    +(SELECT count(*) FROM public.training_three_level_legacy_evidence WHERE employee_id IN (${employees}))
    +(SELECT count(*) FROM public.training_three_level_audit_logs WHERE employee_id IN (${employees}))
    +(SELECT count(*) FROM public.profiles WHERE id IN (${Object.values(f.users).map(q).join(',')}))
    +(SELECT count(*) FROM public.account_subjects WHERE auth_user_id IN(${Object.values(f.users).map(q).join(',')}));`));
}

async function main() {
  const started = process.hrtime.bigint(); const db = validateTestBoundary().databaseUrl; const f = ids(); let residual = -1;
  check('01 isolated TEST boundary', assertD02FixtureMarker(validateTestBoundary()) > 0);
  const source = fs.readFileSync(migration, 'utf8');
  check('02 v81 static authority', /reused_from_task_id[\s\S]*training_prepare_admission_exam[\s\S]*training_exam_attempt_admission_gate/.test(source));
  apply(db); readAuthority(db, f);
  try {
    createFixture(db, f);
    const first = psql(db, startSql(f, f.projects.a1, f.employees.internal, f.packages.a1)).out.split(/\r?\n/).filter(Boolean).at(-1);
    check('03 employee receives three required levels', Number(scalar(db, `SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(first)} AND fulfillment_kind='required';`)) === 3);
    check('04 missing company has stable exam reason', status(db,f,f.projects.a1,f.employees.internal).reason_code === 'missing_company_training');
    check('05 prepare exam cannot bypass incomplete levels', expectCode(db,f.users.internal,`SELECT public.training_prepare_admission_exam(${q(first)});`,'missing_company_training'));
    const examAssignment = scalar(db, `INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id) VALUES (${q(f.plans.exam)},${q(f.employees.internal)},${q(f.users.internal)},${q(f.entityA)}) ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id;`);
    psql(db, `UPDATE public.training_admissions SET exam_assignment_id=${q(examAssignment)} WHERE id=${q(first)};`);
    const directExam = asUser(db,f.users.internal,`SELECT public.exam_start(${q(f.plans.exam)});`,true);
    check('06 direct exam RPC is server-gated', directExam.status !== 0 && directExam.err.includes('[D11:missing_company_training]'),
      process.env.D11_FOCUS === '06' ? directExam.err.split(/\r?\n/).find(x => x.includes('ERROR:')) : '');
    if (process.env.D11_FOCUS === '06') return;
    complete(db,first,['entity','project']);
    psql(db, `BEGIN; SET LOCAL session_replication_role=replica; UPDATE public.training_admission_tasks SET status='completed',progress=100,effective_hours=0.25,fulfillment_kind='original',completed_at=NOW() WHERE admission_id=${q(first)} AND level='company'; COMMIT;`);
    check('07 insufficient effective hours remain blocked', status(db,f,f.projects.a1,f.employees.internal).reason_code === 'incomplete_effective_hours');
    complete(db,first);
    const ready = status(db,f,f.projects.a1,f.employees.internal);
    check('08 all original hours satisfy exam gate', ready.exam_allowed === true && ready.reason_code === 'ready');
    check('09 original completion preserves true hours/time', scalar(db,`SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(first)} AND fulfillment_kind='original' AND completed_at IS NOT NULL AND effective_hours>=required_hours;`) === '3');

    psql(db,startSql(f,f.projects.a2,f.employees.internal,f.packages.a2)); const a2=admissionId(db,f.projects.a2,f.employees.internal);
    check('10 company training reuses across projects', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND level='company';`) === 'reused');
    check('11 entity training reuses inside same entity', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND level='entity';`) === 'reused');
    check('12 project training never reuses across projects', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND level='project';`) === 'required');
    check('13 reuse relation does not fake history', scalar(db,`SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND fulfillment_kind='reused' AND reused_from_task_id IS NOT NULL AND completed_at IS NULL AND effective_hours=0;`) === '2');
    check('14 course and version snapshots retained', scalar(db,`SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(a2)} AND jsonb_array_length(course_snapshot)>0 AND plan_version_root_id IS NOT NULL AND plan_version_no>0;`) === '3');
    check('15 ordinary user cannot alter reuse source', expectCode(db,f.users.internal,`UPDATE public.training_admission_tasks SET reused_from_task_id=NULL WHERE admission_id=${q(a2)} AND fulfillment_kind='reused';`,'') || asUser(db,f.users.internal,`UPDATE public.training_admission_tasks SET reused_from_task_id=NULL WHERE admission_id=${q(a2)} AND fulfillment_kind='reused';`,true).status !== 0);
    check('16 ordinary user cannot sync another learner', expectCode(db,f.users.internal,`SELECT public.training_sync_three_level_tasks(${q(a2)});`,'forbidden'));

    psql(db,`UPDATE public.training_employees SET department_id=${q(f.entityB)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityB)} WHERE id=${q(f.users.internal)};`);
    psql(db,startSql(f,f.projects.b1,f.employees.internal,f.packages.b1)); const b1=admissionId(db,f.projects.b1,f.employees.internal);
    check('17 company completion survives entity transfer', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(b1)} AND level='company';`) === 'reused');
    check('18 entity completion never crosses entities', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(b1)} AND level='entity';`) === 'required');
    psql(db,`UPDATE public.training_employees SET department_id=${q(f.entityA)} WHERE id=${q(f.employees.internal)}; UPDATE public.profiles SET department_id=${q(f.entityA)} WHERE id=${q(f.users.internal)};`);
    psql(db,startSql(f,f.projects.a3,f.employees.internal,f.packages.a3)); const a3=admissionId(db,f.projects.a3,f.employees.internal);
    check('19 retrain policy creates remedial original task', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(a3)} AND level='company';`) === 'required');

    psql(db,startSql(f,f.projects.a1,f.employees.contractor,f.packages.a1)); const c1=admissionId(db,f.projects.a1,f.employees.contractor); complete(db,c1);
    psql(db,startSql(f,f.projects.a2,f.employees.contractor,f.packages.a2)); const c2=admissionId(db,f.projects.a2,f.employees.contractor);
    check('20 contractor uses D08 effective entity', status(db,f,f.projects.a2,f.employees.contractor).effective_entity_id === f.entityA);
    check('21 contractor company/entity reuse is scoped', scalar(db,`SELECT count(*) FROM public.training_admission_tasks WHERE admission_id=${q(c2)} AND level IN('company','entity') AND fulfillment_kind='reused';`) === '2');
    psql(db,`UPDATE public.contractor_companies SET managing_entity_id=${q(f.entityB)} WHERE id=${q(f.contractors.known)};`);
    psql(db,startSql(f,f.projects.b1,f.employees.contractor,f.packages.b1)); const cb=admissionId(db,f.projects.b1,f.employees.contractor);
    check('22 contractor entity training never crosses entities', scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(cb)} AND level='company';`) === 'reused' && scalar(db,`SELECT fulfillment_kind FROM public.training_admission_tasks WHERE admission_id=${q(cb)} AND level='entity';`) === 'required');
    check('23 unknown contractor entity is fail-closed', expectCode(db,f.manager,`SELECT public.training_start_admission(${q(f.projects.a1)},${q(f.employees.unknown)},${q(f.packages.a1)},NOW()+INTERVAL '2 days',false);`,'missing_effective_entity'));
    check('24 company leader is routed to visitor briefing', expectCode(db,f.manager,`SELECT public.training_start_admission(${q(f.projects.a1)},${q(f.employees.leader)},${q(f.packages.a1)},NOW()+INTERVAL '2 days',false);`,'visitor_safety_briefing_required') && scalar(db,`SELECT count(*) FROM public.training_admissions WHERE employee_id=${q(f.employees.leader)};`) === '0');
    psql(db,startSql(f,f.projects.a2,f.employees.missing,f.packages.missing));
    check('25 missing level plan has stable blocked reason', status(db,f,f.projects.a2,f.employees.missing).reason_code === 'missing_training_plan');

    const concurrent = await Promise.all([
      psqlAsync(db,startSql(f,f.projects.a1,f.employees.concurrent,f.packages.a1,0.4)),
      psqlAsync(db,startSql(f,f.projects.a1,f.employees.concurrent,f.packages.a1,0)),
    ]);
    const same = concurrent.every(x=>x.status===0) && concurrent[0].out.split(/\r?\n/).find(x=>/^[0-9a-f-]{36}$/i.test(x)) === concurrent[1].out.split(/\r?\n/).find(x=>/^[0-9a-f-]{36}$/i.test(x));
    check('26 concurrent retry is idempotent', same && scalar(db,`SELECT count(*) FROM public.training_admissions WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.concurrent)};`) === '1' && scalar(db,`SELECT count(*) FROM public.training_admission_tasks t JOIN public.training_admissions a ON a.id=t.admission_id WHERE a.project_id=${q(f.projects.a1)} AND a.employee_id=${q(f.employees.concurrent)};`) === '3');
    const packageChange = asUser(db,f.manager,`SELECT public.training_start_admission(${q(f.projects.a1)},${q(f.employees.internal)},${q(f.packages.a2)},NOW()+INTERVAL '2 days',false);`,true);
    check('27 existing history cannot change package', packageChange.status !== 0 && scalar(db,`SELECT package_id FROM public.training_admissions WHERE id=${q(first)};`) === f.packages.a1);
    check('28 manager may read scoped status', status(db,f,f.projects.a1,f.employees.contractor).path === 'training');
  } finally {
    residual=cleanup(db,f); check('29 cleanup residual = 0', residual===0, `residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass); const seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`D11_RESULT ${failed.length ? 'FAIL' : 'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length) process.exit(1);
}
if (require.main === module) {
  const db = validateTestBoundary().databaseUrl;
  if (scalar(db, "SELECT to_regprocedure('public.site_project_set_risk_tags(uuid,text[],text)') IS NOT NULL;") === 't') {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'd11-employee-three-level-foundation.js')], { stdio: 'inherit', windowsHide: true });
    console.log(`D11_REUSE_COMPAT_RESULT ${run.status === 0 ? 'PASS' : 'FAIL'} authority=v83`);
    process.exit(run.status ?? 1);
  }
  main().catch(error=>{ console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]')); process.exit(1); });
}
module.exports = { admissionId, asUser, cleanup, complete, createFixture, ids, psql, q, readAuthority, scalar, startSql, status };

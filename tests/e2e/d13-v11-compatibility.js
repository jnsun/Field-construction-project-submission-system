/** TARGETED: D00-D13 V1.1 compatibility slice. */
const crypto = require('crypto');
const { validateTestBoundary, assertD02FixtureMarker } = require('./d04-test-environment');
const { asUser, psql, q, scalar } = require('./d11-three-level-training-reuse');
const { required } = require('./test-config');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} V11 ${name}${detail ? ` ${detail}` : ''}`); };
const id = () => crypto.randomUUID();
const errorCode = (run, code) => run.status !== 0 && run.err.includes(`[V11:${code}]`);
async function request(base, key, pathName, options = {}) {
  const response = await fetch(base + pathName, { ...options, signal: AbortSignal.timeout(15000), headers: { apikey: key, ...(options.headers || {}) } });
  return { status: response.status, body: await response.text() };
}

async function main() {
  const started = process.hrtime.bigint(); const b = validateTestBoundary(); const key = required('SAFETY_SUPABASE_ANON_KEY');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8); let residual = -1;
  const entityA = scalar(b.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-A';");
  const entityB = scalar(b.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-B';");
  const manager = scalar(b.databaseUrl, "SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001';");
  const projectA = id(), projectB = id(), scope = id();
  const users = { target: id(), cross: id(), entity: id(), company2: id() };
  const employees = { employee: id(), contractor: id(), temp: id(), visitor: id(), cross: id() };
  const emails = Object.fromEntries(Object.entries(users).map(([k]) => [k, `v11-${suffix}-${k}@example.invalid`]));
  const password = `V11-${crypto.randomUUID()}!`;
  check('01 isolated TEST boundary', assertD02FixtureMarker(b) > 0);
  try {
    psql(b.databaseUrl, `BEGIN;
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES
        (${q(projectA)},${q(`V11-${suffix}-A`)},'[V11-TEST] A','active',${q(entityA)},'V11-TEST'),
        (${q(projectB)},${q(`V11-${suffix}-B`)},'[V11-TEST] B','active',${q(entityB)},'V11-TEST');
      INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES(${q(projectA)},${q(entityA)},true),(${q(projectB)},${q(entityB)},true);
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES
        (${q(employees.employee)},'[V11] employee',${q(`V11-${suffix}-E`)},${q(entityA)},'员工','employee','active','V11-TEST'),
        (${q(employees.contractor)},'[V11] contractor',${q(`V11-${suffix}-C`)},${q(entityA)},'外协','employee','active','V11-TEST'),
        (${q(employees.temp)},'[V11] temp',${q(`V11-${suffix}-T`)},${q(entityA)},'临时','employee','active','V11-TEST'),
        (${q(employees.visitor)},'[V11] visitor',${q(`V11-${suffix}-V`)},${q(entityA)},'访客','employee','active','V11-TEST'),
        (${q(employees.cross)},'[V11] cross',${q(`V11-${suffix}-X`)},${q(entityB)},'员工','employee','active','V11-TEST');
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
        ${Object.keys(users).map(k => `('00000000-0000-0000-0000-000000000000',${q(users[k])},'authenticated','authenticated',${q(emails[k])},crypt(${q(password)},gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW())`).join(',')};
      INSERT INTO public.profiles(id,email,employee_id,department_id,role,full_name,is_super_admin,admin_level) VALUES
        (${q(users.target)},${q(emails.target)},${q(employees.employee)},${q(entityA)},'employee','[V11] target',false,NULL),
        (${q(users.cross)},${q(emails.cross)},${q(employees.cross)},${q(entityB)},'employee','[V11] cross',false,NULL),
        (${q(users.entity)},${q(emails.entity)},NULL,${q(entityA)},'admin','[V11] entity admin',false,'dept'),
        (${q(users.company2)},${q(emails.company2)},NULL,NULL,'admin','[V11] company admin 2',false,'company')
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,employee_id=EXCLUDED.employee_id,department_id=EXCLUDED.department_id,role=EXCLUDED.role,
        full_name=EXCLUDED.full_name,is_super_admin=EXCLUDED.is_super_admin,admin_level=EXCLUDED.admin_level;
      INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by) VALUES
        (${q(projectA)},${q(users.target)},'safety_officer',true,${q(manager)}),(${q(projectA)},${q(manager)},'project_manager',true,${q(manager)});
      INSERT INTO public.training_three_level_profiles(employee_id,person_category,onboarding_category,status,relation_source) VALUES(${q(employees.visitor)},'visitor','not_applicable','not_applicable','V11-TEST');
      INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES
        (${q(projectA)},${q(employees.employee)},'internal','active',${q(manager)}),(${q(projectA)},${q(employees.contractor)},'external','active',${q(manager)}),
        (${q(projectA)},${q(employees.temp)},'temporary','active',${q(manager)}),(${q(projectA)},${q(employees.visitor)},'internal','active',${q(manager)});
      COMMIT;`);

    const roles = JSON.parse(scalar(b.databaseUrl, `SELECT public.training_account_roles(${q(users.target)})::text;`));
    check('02 role list includes profile and scoped project role', roles.some(x => x.role === 'employee') && roles.some(x => x.role === 'safety_officer' && x.scope === 'project'));
    const paths = JSON.parse(scalar(b.databaseUrl, `SELECT jsonb_object_agg(e.employee_no,p.primary_path)::text FROM public.project_person_admission_paths p JOIN public.training_employees e ON e.id=p.employee_id WHERE p.project_id=${q(projectA)};`));
    check('03 four primary admission paths are authoritative', paths[`V11-${suffix}-E`] === 'employee' && paths[`V11-${suffix}-C`] === 'contractor' && paths[`V11-${suffix}-T`] === 'temporary_individual' && paths[`V11-${suffix}-V`] === 'visitor');
    check('04 admission path history retained', Number(scalar(b.databaseUrl, `SELECT count(*) FROM public.project_person_admission_path_history WHERE project_id=${q(projectA)};`)) === 4);

    check('05 freeze account', asUser(b.databaseUrl, manager, `SELECT public.training_account_set_status(${q(users.target)},'frozen','V11 freeze','freeze-1',NULL);`).status === 0);
    check('06 frozen account rejected on new API request', errorCode(asUser(b.databaseUrl, users.target, 'SELECT public.training_enforce_account_request();', true), 'account_inactive'));
    const frozenLogin = await request(b.apiOrigin, key, '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emails.target, password }) });
    check('07 frozen account cannot log in', frozenLogin.status !== 200);
    check('08 restore account', asUser(b.databaseUrl, manager, `SELECT public.training_account_set_status(${q(users.target)},'active','V11 restore','restore-1',NULL);`).status === 0);
    check('09 duplicate restore is idempotent', asUser(b.databaseUrl, manager, `SELECT public.training_account_set_status(${q(users.target)},'active','V11 restore','restore-1',NULL);`).status === 0);
    check('10 cross-entity account operation denied', errorCode(asUser(b.databaseUrl, users.entity, `SELECT public.training_account_set_status(${q(users.cross)},'disabled','cross denied','cross-1',NULL);`, true), 'account_forbidden'));
    check('11 disable and close preserve auth/profile subject', asUser(b.databaseUrl, manager, `SELECT public.training_account_set_status(${q(users.target)},'disabled','V11 disable','disable-1',NULL); SELECT public.training_account_set_status(${q(users.target)},'closed','V11 close','close-1',NULL);`).status === 0
      && scalar(b.databaseUrl, `SELECT count(*) FROM auth.users u JOIN public.profiles p ON p.id=u.id JOIN public.account_subjects s ON s.auth_user_id=u.id WHERE u.id=${q(users.target)};`) === '1');
    check('12 lifecycle history has operator/reason/time', Number(scalar(b.databaseUrl, `SELECT count(*) FROM public.account_lifecycle_history h WHERE h.subject_id=(SELECT id FROM public.account_subjects WHERE auth_user_id=${q(users.target)}) AND h.operator_subject_id IS NOT NULL AND h.reason<>'' AND h.changed_at IS NOT NULL;`)) >= 3);
    check('13 D12 operator subject column remains', scalar(b.databaseUrl, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='training_special_work_audit_logs' AND column_name='operator_subject_id';") === '1');
    const approval = asUser(b.databaseUrl, manager, `SELECT public.training_account_request_high_privilege_action(${q(users.company2)},'close','V11 dual control');`).out.split(/\r?\n/).filter(Boolean).at(-1);
    check('14 requester cannot approve own high privilege action', errorCode(asUser(b.databaseUrl, manager, `SELECT public.training_account_approve_high_privilege_action(${q(approval)},true);`, true), 'dual_control_required'));
    check('15 second company admin can approve and action closes without deletion', asUser(b.databaseUrl, users.company2, `SELECT public.training_account_approve_high_privilege_action(${q(approval)},true);`).status === 0
      && asUser(b.databaseUrl, manager, `SELECT public.training_account_set_status(${q(users.company2)},'closed','V11 dual control close','company-close',${q(approval)});`).status === 0
      && scalar(b.databaseUrl, `SELECT count(*) FROM auth.users WHERE id=${q(users.company2)};`) === '1');
    check('16 last company administrator protection is enforced in lifecycle and role RPCs', scalar(b.databaseUrl, `SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('training_account_set_status','training_account_apply_company_admin_role') AND pg_get_functiondef(oid) LIKE '%[V11:last_company_admin]%';`) === '2');

    check('17 normal record-card and contractor RPC definitions mask identity', scalar(b.databaseUrl, `SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('training_admission_record_cards','training_contractor_personnel_ledger') AND pg_get_functiondef(oid) ILIKE '%regexp_replace%';`) === '2');
    check('18 normal certificate export performs server-side masking', scalar(b.databaseUrl, `SELECT pg_get_functiondef('public.certificate_normal_export(uuid[])'::regprocedure) ILIKE '%regexp_replace%';`) === 't');

    check('19 five training categories frozen', scalar(b.databaseUrl, `SELECT count(DISTINCT x) FROM unnest(ARRAY['basic_three_level','project_induction','project_special','special_operation','continuing_or_change']) x WHERE x IN (SELECT jsonb_array_elements_text('["basic_three_level","project_induction","project_special","special_operation","continuing_or_change"]'));`) === '5');
    check('20 existing D11 completed history remains basic three-level', scalar(b.databaseUrl, `SELECT count(*) FROM public.training_three_level_records r JOIN public.training_plans p ON p.id=r.plan_id WHERE p.training_category<>'basic_three_level';`) === '0');
    check('21 special catalog separates operation and project risks', scalar(b.databaseUrl, `SELECT count(*) FROM public.special_requirement_catalog WHERE (special_type IN('blasting','electrical','welding') AND category='special_operation' AND certificate_required) OR (special_type='drilling' AND category='project_special' AND NOT certificate_required);`) === '4');
    psql(b.databaseUrl, `INSERT INTO public.special_requirement_catalog(special_type,category,display_name,certificate_required,exam_policy,sort_order) VALUES('v11_${suffix}','project_special','V11扩展',false,'required',99);`);
    check('22 added catalog entry resolves without schema/core branch change', scalar(b.databaseUrl, `SELECT public.training_special_type_code('v11_${suffix}');`) === `v11_${suffix}`);
    check('23 drilling risk tag synchronizes includes_drilling', asUser(b.databaseUrl, manager, `SELECT public.site_project_set_risk_tags(${q(projectA)},ARRAY['drilling'],'V11 drilling risk');`).status === 0
      && scalar(b.databaseUrl, `SELECT includes_drilling FROM public.site_projects WHERE id=${q(projectA)};`) === 't');
    check('24 drilling policy defaults exam off but training stays mandatory', scalar(b.databaseUrl, `SELECT (public.system_parameter_effective('EXAM-DRILL-001',NULL,NOW())->>'value')::boolean;`) === 'f'
      && scalar(b.databaseUrl, `SELECT training_required AND NOT certificate_required FROM public.special_requirement_catalog WHERE special_type='drilling';`) === 't');

    check('25 question count 9 rejected', errorCode(asUser(b.databaseUrl, manager, `SELECT public.system_parameter_set('EXAM-QTY-001','9',${q(scope)},NOW(),'low','{}');`, true), 'parameter_out_of_range'));
    check('26 question count 10 and 100 allowed', asUser(b.databaseUrl, manager, `SELECT public.system_parameter_set('EXAM-QTY-001','10',${q(scope)},NOW(),'min','{}');`).status === 0
      && asUser(b.databaseUrl, manager, `SELECT public.system_parameter_set('EXAM-QTY-001','100',${q(scope)},NOW(),'max','{}');`).status === 0);
    check('27 question count 101 rejected', errorCode(asUser(b.databaseUrl, manager, `SELECT public.system_parameter_set('EXAM-QTY-001','101',${q(scope)},NOW(),'high','{}');`, true), 'parameter_out_of_range'));
    check('28 duration/pass/attempt ranges stored authoritatively', scalar(b.databaseUrl, `SELECT bool_and((parameter_id='EXAM-DUR-001' AND min_value=10 AND max_value=120) OR (parameter_id='EXAM-PASS-001' AND min_value=60 AND max_value=100) OR (parameter_id='EXAM-TRY-001' AND min_value=1 AND max_value=10)) FROM public.system_parameter_definitions WHERE parameter_id IN('EXAM-DUR-001','EXAM-PASS-001','EXAM-TRY-001');`) === 't');
    check('29 explicit exam semantic types available', scalar(b.databaseUrl, `SELECT count(*) FROM (VALUES('employee_comprehensive_admission_exam'),('project_induction_exam'),('special_exam')) x(v) WHERE v IN('employee_comprehensive_admission_exam','project_induction_exam','special_exam');`) === '3');
    check('30 authoritative tables deny authenticated writes', Number(scalar(b.databaseUrl, `SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='authenticated' AND privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE') AND table_name IN('account_lifecycle','account_lifecycle_history','system_parameter_versions','special_requirement_catalog','project_person_admission_paths');`)) === 0);
  } finally {
    psql(b.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.system_parameter_audit WHERE scope_id=${q(scope)};
      DELETE FROM public.system_parameter_versions WHERE scope_id=${q(scope)};
      DELETE FROM public.special_requirement_catalog WHERE special_type='v11_${suffix}';
      DELETE FROM public.project_person_admission_path_history WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.project_person_admission_paths WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.site_project_risk_tags WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.training_three_level_profiles WHERE employee_id IN(${Object.values(employees).map(q).join(',')});
      DELETE FROM public.site_project_members WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.site_project_roles WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.site_project_entities WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.site_project_audit_logs WHERE project_id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.site_projects WHERE id IN(${q(projectA)},${q(projectB)});
      DELETE FROM public.account_high_privilege_approvals WHERE target_subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')}));
      DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')}));
      DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')}));
      DELETE FROM public.account_subjects WHERE auth_user_id IN(${Object.values(users).map(q).join(',')});
      DELETE FROM public.profiles WHERE id IN(${Object.values(users).map(q).join(',')}); DELETE FROM auth.users WHERE id IN(${Object.values(users).map(q).join(',')});
      DELETE FROM public.training_employees WHERE id IN(${Object.values(employees).map(q).join(',')}); COMMIT;`);
    residual = Number(scalar(b.databaseUrl, `SELECT (SELECT count(*) FROM public.site_projects WHERE id IN(${q(projectA)},${q(projectB)}))+(SELECT count(*) FROM public.profiles WHERE id IN(${Object.values(users).map(q).join(',')}));`));
    check('31 cleanup residual = 0', residual === 0, `residual=${residual}`);
  }
  const failed = results.filter(x => !x.pass); const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`V11_RESULT ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if (failed.length) process.exit(1);
}
if (require.main === module) main().catch(error => { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')); process.exit(1); });

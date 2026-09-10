/** S3-A TARGETED: organization and three-level scheme foundation. */
const crypto = require('crypto');
const { validateTestBoundary, assertD02FixtureMarker } = require('./d04-test-environment');
const { asUser, psql, q, scalar } = require('./d11-three-level-training-reuse');
const { required } = require('./test-config');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} S3A ${name}${detail ? ` ${detail}` : ''}`); };
const id = () => crypto.randomUUID();
const code = (run, value) => run.status !== 0 && run.err.includes(`[S3A:${value}]`);
const last = run => run.out.split(/\r?\n/).filter(Boolean).at(-1) || '';
const call = (db, user, sql, allowFailure = false) => asUser(db, user, sql, allowFailure);

function main() {
  const started = process.hrtime.bigint();
  const b = validateTestBoundary(); assertD02FixtureMarker(b);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const company = scalar(b.databaseUrl, `SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.email=${q(required('SAFETY_TEST_ADMIN_EMAIL'))} AND (p.is_super_admin OR p.admin_level='company');`);
  if (!company) throw new Error('权威公司管理员测试账号不可用');
  const entity = id(), projectManager = id(), ordinary = id(), employee = id(), project = id();
  const org = { internal: id(), entity: id(), logistics: id(), other: id() };
  const scheme = { exact: id(), type: id(), fallback: id(), conflict: id() };
  const version = { exact1: id(), exact2: id() };
  const rules = { exact: id(), type: id(), fallback: id(), high: id(), conflict: id(), inactive: id() };
  const packageId = id(); let relation; let residual = -1;
  const payload = x => q(JSON.stringify(x));
  const saveOrg = (user, oid, data, reason, allowFailure = false) => call(b.databaseUrl,user,`SELECT public.training_organization_save(${q(oid)},${payload(data)}::jsonb,${q(reason)},${q(`${suffix}-${reason}`)});`,allowFailure);
  const saveRule = (rid, data, reason) => call(b.databaseUrl,company,`SELECT public.training_scheme_applicability_save(${q(rid)},${payload(data)}::jsonb,${q(reason)},${q(`${suffix}-${reason}`)});`);
  try {
    psql(b.databaseUrl, `BEGIN;
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${q(entity)},'authenticated','authenticated',${q(`s3a-${suffix}-entity@example.invalid`)},crypt('S3A-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW()),
      ('00000000-0000-0000-0000-000000000000',${q(projectManager)},'authenticated','authenticated',${q(`s3a-${suffix}-project@example.invalid`)},crypt('S3A-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW()),
      ('00000000-0000-0000-0000-000000000000',${q(ordinary)},'authenticated','authenticated',${q(`s3a-${suffix}-ordinary@example.invalid`)},crypt('S3A-test-only',gen_salt('bf')),NOW(),'','','','','{"provider":"email","providers":["email"]}','{}',NOW(),NOW());
      INSERT INTO public.profiles(id,email,role,admin_level,full_name,department_id) VALUES
      (${q(entity)},${q(`s3a-${suffix}-entity@example.invalid`)},'admin','dept','[S3A] entity',(SELECT id FROM public.departments WHERE code='D02-ENT-A')),
      (${q(projectManager)},${q(`s3a-${suffix}-project@example.invalid`)},'employee',NULL,'[S3A] project',NULL),
      (${q(ordinary)},${q(`s3a-${suffix}-ordinary@example.invalid`)},'employee',NULL,'[S3A] ordinary',NULL)
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,role=EXCLUDED.role,admin_level=EXCLUDED.admin_level,
        full_name=EXCLUDED.full_name,department_id=EXCLUDED.department_id;
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES(${q(project)},${q(`S3A-${suffix}`)},'[S3A] project','active',(SELECT id FROM public.departments WHERE code='D02-ENT-A'),'S3A-TEST');
      INSERT INTO public.site_project_entities(project_id,entity_id,is_lead) VALUES(${q(project)},(SELECT id FROM public.departments WHERE code='D02-ENT-A'),TRUE);
      INSERT INTO public.site_project_roles(project_id,user_id,role,active,assigned_by) VALUES(${q(project)},${q(projectManager)},'project_manager',TRUE,${q(company)});
      INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark) VALUES(${q(employee)},'[S3A] employee',${q(`S3A-${suffix}-E`)},(SELECT id FROM public.departments WHERE code='D02-ENT-A'),'财务','employee','active','S3A-TEST');
      INSERT INTO public.training_three_level_profiles(employee_id,person_category,onboarding_category,status,employment_started_on,relation_source) VALUES(${q(employee)},'formal_internal','new_hire','required',CURRENT_DATE,'S3A-TEST');
      INSERT INTO public.training_admission_packages(id,title,status,version_no,training_category,created_by,approved_by,approved_at) VALUES(${q(packageId)},'[S3A] three-level package','published',1,'basic_three_level',${q(company)},${q(company)},NOW());
      COMMIT;`);
    relation = scalar(b.databaseUrl, `SELECT employment_relation_id FROM public.training_three_level_profiles WHERE employee_id=${q(employee)};`);

    const base = { organization_code:`S3A-${suffix}-INT`,name:'内设机构',organization_type:'internal_department',active:true,effective_from:'2026-01-01' };
    check('01 create internal department', JSON.parse(last(saveOrg(company,org.internal,base,'org-internal'))).organization_type === 'internal_department');
    check('02 create operating entity and preserve legacy mapping', JSON.parse(last(saveOrg(company,org.entity,{...base,organization_code:`S3A-${suffix}-ENT`,name:'经营实体',organization_type:'operating_entity'},'org-entity'))).organization_type === 'operating_entity'
      && scalar(b.databaseUrl,`SELECT count(*) FROM public.organization_unit_legacy_mappings m JOIN public.organization_units u ON u.id=m.organization_unit_id JOIN public.departments d ON d.id=m.source_id WHERE m.source_type='departments' AND d.code='D02-ENT-A' AND u.organization_type='operating_entity';`)==='1');
    check('03 create logistics center', JSON.parse(last(saveOrg(company,org.logistics,{...base,organization_code:`S3A-${suffix}-LOG`,name:'后勤中心',organization_type:'logistics_center'},'org-logistics'))).organization_type === 'logistics_center');
    check('04 create other internal unit', JSON.parse(last(saveOrg(company,org.other,{...base,organization_code:`S3A-${suffix}-OTH`,name:'其他单位',organization_type:'other_internal_unit'},'org-other'))).organization_type === 'other_internal_unit');
    const renamed = JSON.parse(last(saveOrg(company,org.internal,{...base,name:'财务资产部'},'org-rename')));
    check('05 stable id survives rename', renamed.id === org.internal && renamed.name === '财务资产部');
    check('06 deactivate preserves versions', call(b.databaseUrl,company,`SELECT public.training_organization_set_active(${q(org.other)},FALSE,'deactivate','${suffix}-deactivate');`).status===0 && Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.organization_unit_versions WHERE organization_unit_id=${q(org.other)};`))===2);
    check('07 ordinary cannot modify organization', code(saveOrg(ordinary,id(),{...base,organization_code:`S3A-${suffix}-DENY1`},'deny-ordinary',true),'forbidden'));
    check('08 entity admin cannot modify organization', code(saveOrg(entity,id(),{...base,organization_code:`S3A-${suffix}-DENY2`},'deny-entity',true),'forbidden'));

    const a1 = JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_employment_organization_assign(${q(relation)},${q(org.internal)},CURRENT_DATE,'initial','${suffix}-assign-1');`)));
    check('09 formal employee assigned to organization', a1.organization_unit_id===org.internal);
    const a2 = JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_employment_organization_assign(${q(relation)},${q(org.logistics)},CURRENT_DATE+1,'transfer','${suffix}-assign-2');`)));
    check('10 organization change creates history', a2.organization_unit_id===org.logistics && Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.employment_organization_assignment_history WHERE employment_relation_id=${q(relation)};`))===2);
    check('11 one current assignment', scalar(b.databaseUrl,`SELECT count(*) FROM public.employment_organization_assignments WHERE employment_relation_id=${q(relation)} AND active AND effective_to IS NULL;`)==='1');
    psql(b.databaseUrl,`INSERT INTO public.site_project_members(project_id,employee_id,membership_type,status,created_by) VALUES(${q(project)},${q(employee)},'internal','active',${q(company)}); UPDATE public.site_project_members SET status='left',left_at=NOW(),left_reason='S3A test' WHERE project_id=${q(project)} AND employee_id=${q(employee)};`);
    check('12 project membership change does not alter employment organization', JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_employment_organization_current(${q(relation)});`))).organization_unit_id===org.logistics);

    for (const [key,sid] of Object.entries(scheme)) {
      const made=JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_create(${q(`3L-${suffix}-${key.toUpperCase()}`)},${q(`S3A ${key}`)},'create scheme',${q(`${suffix}-scheme-${key}`)});`)));
      scheme[key]=made.id;
    }
    check('13 create scheme', !!scheme.exact);
    const v1=JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_create_version(${q(scheme.exact)},NULL,CURRENT_DATE,'V1 draft','create V1','${suffix}-v1');`))); version.exact1=v1.id;
    check('14 create V1 draft', v1.status==='draft' && v1.version_number===1);
    check('15 edit draft', JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_update_draft(${q(v1.id)},CURRENT_DATE,'V1 edited','edit','${suffix}-v1-edit');`))).change_summary==='V1 edited');
    const stages = third => [{stage_order:1,stage_level:'company',stage_type:'company',training_package_id:packageId},{stage_order:2,stage_level:'organization',stage_type:'organization',training_package_id:packageId},{stage_order:3,stage_level:'third',stage_type:third,training_package_id:packageId}];
    const set=JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_set_stages(${q(v1.id)},${payload(stages('department_position'))}::jsonb,'set stages','${suffix}-stages-v1');`)));
    check('16 company stage', set[0].stage_type==='company'); check('17 organization stage',set[1].stage_type==='organization'); check('18 department_position third stage',set[2].stage_type==='department_position');
    check('19 publish V1', JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_publish(${q(v1.id)},'publish V1','${suffix}-publish-v1');`))).status==='published');
    check('20 published V1 edit rejected', code(call(b.databaseUrl,company,`SELECT public.training_scheme_update_draft(${q(v1.id)},CURRENT_DATE,'bad','bad','${suffix}-bad');`,true),'scheme_version_not_draft'));
    const v2=JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_create_version(${q(scheme.exact)},${q(v1.id)},CURRENT_DATE+30,'V2 draft','create V2','${suffix}-v2');`))); version.exact2=v2.id;
    check('21 create V2 from V1',v2.version_number===2 && scalar(b.databaseUrl,`SELECT count(*) FROM public.three_level_training_scheme_stages WHERE scheme_version_id=${q(v2.id)};`)==='3');
    check('22 basic_project compatible', call(b.databaseUrl,company,`SELECT public.training_scheme_set_stages(${q(v2.id)},${payload(stages('basic_project'))}::jsonb,'basic','${suffix}-basic');`).status===0);
    check('23 actual_project compatible', call(b.databaseUrl,company,`SELECT public.training_scheme_set_stages(${q(v2.id)},${payload(stages('actual_project'))}::jsonb,'actual','${suffix}-actual');`).status===0);
    check('24 publish V2 without overwriting V1', call(b.databaseUrl,company,`SELECT public.training_scheme_publish(${q(v2.id)},'publish V2','${suffix}-publish-v2');`).status===0 && scalar(b.databaseUrl,`SELECT count(*) FROM public.three_level_training_scheme_versions WHERE id IN(${q(v1.id)},${q(v2.id)});`)==='2');
    check('25 historical V1 remains queryable', JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_get(${q(scheme.exact)});`))).versions.length===2);
    const empty=JSON.parse(last(call(b.databaseUrl,company,`SELECT public.training_scheme_create_version(${q(scheme.type)},NULL,CURRENT_DATE,'empty','empty','${suffix}-empty');`)));
    check('26 missing stages blocks publish', code(call(b.databaseUrl,company,`SELECT public.training_scheme_publish(${q(empty.id)},'bad publish','${suffix}-empty-publish');`,true),'invalid_stage_structure'));
    const invalidPackageStages = stages('department_position').map(stage => ({ ...stage, training_package_id:id() }));
    const invalidPackage = call(b.databaseUrl,company,`SELECT public.training_scheme_set_stages(${q(empty.id)},${payload(invalidPackageStages)}::jsonb,'bad package','${suffix}-bad-package');`,true);
    check('27 invalid training package rejected', code(invalidPackage,'training_package_not_valid'),invalidPackage.err.split(/\r?\n/)[0]);

    const ruleData=(rid,sid,extra={})=>({rule_code:`S3A-${suffix}-${rid}`,scheme_id:sid,person_category:'formal_internal',effective_from:'2026-01-01',priority:0,active:true,version_selection_policy:'latest_published',...extra});
    saveRule(rules.fallback,ruleData('FALLBACK',scheme.fallback),'fallback');
    saveRule(rules.type,ruleData('TYPE',scheme.type,{organization_type:'logistics_center'}),'type');
    saveRule(rules.exact,ruleData('EXACT',scheme.exact,{organization_unit_id:org.logistics}),'exact');
    let match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.logistics)},'active','employee','finance',CURRENT_DATE)::text;`));
    check('28 exact organization rule wins',match.status==='matched' && match.scheme_id===scheme.exact && match.precedence===3);
    call(b.databaseUrl,company,`SELECT public.training_scheme_applicability_set_active(${q(rules.exact)},FALSE,'type precedence check','${suffix}-exact-off');`);
    match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.logistics)},'active','employee',NULL,CURRENT_DATE)::text;`));
    check('29 organization type default rule',match.status==='matched' && match.scheme_id===scheme.type && match.precedence===2);
    match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.internal)},'active','employee',NULL,CURRENT_DATE)::text;`));
    check('30 company fallback rule',match.scheme_id===scheme.fallback && match.precedence===1);
    saveRule(rules.high,ruleData('HIGH',scheme.conflict,{organization_unit_id:org.internal,priority:10}),'high');
    match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.internal)},'active','employee',NULL,CURRENT_DATE)::text;`));
    check('31 higher priority wins within precedence',match.scheme_id===scheme.conflict && match.priority===10);
    saveRule(rules.conflict,ruleData('CONFLICT',scheme.exact,{organization_unit_id:org.internal,priority:10}),'conflict');
    match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.internal)},'active','employee',NULL,CURRENT_DATE)::text;`));
    check('32 equal priority conflict fails closed',match.status==='ambiguous' && match.reason_code==='applicability_rule_conflict');
    saveRule(rules.inactive,ruleData('INACTIVE',scheme.exact,{organization_unit_id:org.entity,priority:99,active:false}),'inactive');
    match=JSON.parse(scalar(b.databaseUrl,`SELECT public.training_scheme_match_applicability('formal_internal',${q(org.entity)},'active','employee',NULL,CURRENT_DATE)::text;`));
    check('33 inactive rule excluded',match.scheme_id===scheme.fallback);

    check('34 company admin manages scheme', JSON.parse(last(call(b.databaseUrl,company,'SELECT public.training_scheme_list();'))).some(x=>x.id===scheme.exact));
    check('35 entity admin denied scheme write',code(call(b.databaseUrl,entity,`SELECT public.training_scheme_create('DENY-${suffix}-E','deny','deny','deny-e');`,true),'forbidden'));
    check('36 project manager denied scheme write',code(call(b.databaseUrl,projectManager,`SELECT public.training_scheme_create('DENY-${suffix}-P','deny','deny','deny-p');`,true),'forbidden'));
    check('37 ordinary and direct RPC remain denied',code(call(b.databaseUrl,ordinary,`SELECT public.training_scheme_create('DENY-${suffix}-O','deny','deny','deny-o');`,true),'forbidden') && scalar(b.databaseUrl,`SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee='authenticated' AND privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE') AND table_name IN('organization_units','three_level_training_schemes','three_level_training_scheme_versions','three_level_training_scheme_stages','three_level_training_applicability_rules');`)==='0');
    check('38 organization audit/version is complete',Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.organization_unit_versions WHERE organization_unit_id IN(${Object.values(org).map(q).join(',')}) AND reason<>'' AND changed_at IS NOT NULL;`))>=5);
    check('39 configuration audit has operator role snapshot',Number(scalar(b.databaseUrl,`SELECT count(*) FROM public.training_configuration_audit_logs WHERE request_id LIKE ${q(`${suffix}-%`)} AND operator_subject_id IS NOT NULL AND jsonb_array_length(operator_roles_snapshot)>0 AND reason<>'';`))>=10);
    check('40 D11/D12/D13 object smoke',scalar(b.databaseUrl,`SELECT to_regclass('public.training_three_level_profiles') IS NOT NULL
      AND to_regclass('public.training_special_work_audit_logs') IS NOT NULL
      AND to_regprocedure('public.training_set_member_special_work_types(uuid,text[],text)') IS NOT NULL
      AND to_regclass('public.exam_attempts') IS NOT NULL
      AND to_regprocedure('public.training_exam_start(uuid,text,text,text)') IS NOT NULL;`)==='t');
  } finally {
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_configuration_audit_logs WHERE request_id LIKE ${q(`${suffix}-%`)};
      DELETE FROM public.three_level_training_applicability_rules WHERE id IN(${Object.values(rules).map(q).join(',')});
      DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id IN(SELECT id FROM public.three_level_training_scheme_versions WHERE scheme_id IN(${Object.values(scheme).map(q).join(',')}));
      DELETE FROM public.three_level_training_scheme_versions WHERE scheme_id IN(${Object.values(scheme).map(q).join(',')});
      DELETE FROM public.three_level_training_schemes WHERE id IN(${Object.values(scheme).map(q).join(',')});
      DELETE FROM public.employment_organization_assignment_history WHERE employment_relation_id=${q(relation || id())};
      DELETE FROM public.employment_organization_assignments WHERE employment_relation_id=${q(relation || id())};
      DELETE FROM public.organization_unit_versions WHERE organization_unit_id IN(${Object.values(org).map(q).join(',')});
      DELETE FROM public.organization_units WHERE id IN(${Object.values(org).map(q).join(',')});
      DELETE FROM public.training_admission_packages WHERE id=${q(packageId)};
      DELETE FROM public.project_person_admission_path_history WHERE project_id=${q(project)};
      DELETE FROM public.project_person_admission_paths WHERE project_id=${q(project)};
      DELETE FROM public.site_project_members WHERE project_id=${q(project)};
      DELETE FROM public.site_project_roles WHERE project_id=${q(project)};
      DELETE FROM public.site_project_entities WHERE project_id=${q(project)};
      DELETE FROM public.site_project_audit_logs WHERE project_id=${q(project)};
      DELETE FROM public.site_projects WHERE id=${q(project)};
      DELETE FROM public.training_three_level_profiles WHERE employee_id=${q(employee)};
      DELETE FROM public.training_employees WHERE id=${q(employee)};
      DELETE FROM public.account_lifecycle_history WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${q(entity)},${q(projectManager)},${q(ordinary)}));
      DELETE FROM public.account_lifecycle WHERE subject_id IN(SELECT id FROM public.account_subjects WHERE auth_user_id IN(${q(entity)},${q(projectManager)},${q(ordinary)}));
      DELETE FROM public.account_subjects WHERE auth_user_id IN(${q(entity)},${q(projectManager)},${q(ordinary)});
      DELETE FROM public.profiles WHERE id IN(${q(entity)},${q(projectManager)},${q(ordinary)});
      DELETE FROM auth.users WHERE id IN(${q(entity)},${q(projectManager)},${q(ordinary)}); COMMIT;`);
    residual=Number(scalar(b.databaseUrl,`SELECT
      (SELECT count(*) FROM public.organization_units WHERE id IN(${Object.values(org).map(q).join(',')}))+
      (SELECT count(*) FROM public.three_level_training_schemes WHERE id IN(${Object.values(scheme).map(q).join(',')}))+
      (SELECT count(*) FROM public.training_employees WHERE id=${q(employee)})+
      (SELECT count(*) FROM public.site_projects WHERE id=${q(project)});`));
    check('41 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass); const seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`S3A_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length) process.exit(1);
}

if(require.main===module){try{main();}catch(error){console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);}}

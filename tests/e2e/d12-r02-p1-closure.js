/** D12 R02 TARGETED: exact plan type, TRUNCATE revoke and durable operator snapshot. */
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const { asUser, cleanup, createFixture, ids, psql, q, readAuthority, scalar } = require('./d11-three-level-training-reuse');

process.env.PGCONNECT_TIMEOUT ||= '15';
const root = path.resolve(__dirname, '..', '..');
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} D12-R02 ${name}${detail ? ` ${detail}` : ''}`); };
const code = (result, value) => result.status !== 0 && result.err.includes(`[D12:${value}]`);

function apply(databaseUrl) {
  for (const file of ['training-admission-v84-special-work-requirements.sql', 'training-admission-v85-d12-r01-p1-fixes.sql']) {
    const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(root, 'sql', file)], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`${file} failed: ${String(result.stderr || result.error?.message || '').trim().split(/\r?\n/).at(-1)}`);
  }
}

function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const f = ids();
  const id = () => crypto.randomUUID();
  f.users.audit = id();
  f.packages.r02 = id();
  f.plans.blasting = id(); f.plans.electrical = id(); f.plans.welding = id(); f.plans.drilling = id(); f.plans.noType = id();
  let residual = -1;
  check('01 isolated TEST boundary', assertD02FixtureMarker(boundary) > 0);
  apply(boundary.databaseUrl);
  readAuthority(boundary.databaseUrl, f);
  try {
    createFixture(boundary.databaseUrl, f);
    psql(boundary.databaseUrl, `BEGIN;
      INSERT INTO public.training_plans(id,title,level,department_id,special_type,plan_year,hours,required_hours,status,approval_status,publish_status,version_root_id,version_no,reuse_policy,created_by) VALUES
      (${q(f.plans.blasting)},'[D12-R02] blasting','special',${q(f.entityA)},'blasting',2026,1,1,'planned','approved','published',${q(f.plans.blasting)},1,'allow',${q(f.manager)}),
      (${q(f.plans.electrical)},'[D12-R02] electrical','special',${q(f.entityA)},'electrical',2026,1,1,'planned','approved','published',${q(f.plans.electrical)},1,'allow',${q(f.manager)}),
      (${q(f.plans.welding)},'[D12-R02] welding','special',${q(f.entityA)},'welding',2026,1,1,'planned','approved','published',${q(f.plans.welding)},1,'allow',${q(f.manager)}),
      (${q(f.plans.drilling)},'[D12-R02] drilling','special',${q(f.entityA)},'drilling',2026,1,1,'planned','approved','published',${q(f.plans.drilling)},1,'allow',${q(f.manager)}),
      (${q(f.plans.noType)},'[D12-R02] no type','company',NULL,NULL,2026,1,1,'planned','approved','published',${q(f.plans.noType)},1,'allow',${q(f.manager)});
      INSERT INTO public.training_admission_packages(id,project_id,title,version_no,validity_years,status,created_by,exam_plan_id)
      VALUES(${q(f.packages.r02)},${q(f.projects.a1)},'[D12-R02] exact mapping',1,1,'draft',${q(f.manager)},${q(f.plans.noType)});
      INSERT INTO public.training_admission_package_items(package_id,plan_id,level,required,sort_order) VALUES
      (${q(f.packages.r02)},${q(f.plans.blasting)},'special',true,1),(${q(f.packages.r02)},${q(f.plans.electrical)},'special',true,2),
      (${q(f.packages.r02)},${q(f.plans.welding)},'special',true,3),(${q(f.packages.r02)},${q(f.plans.drilling)},'special',true,4),
      (${q(f.packages.r02)},${q(f.plans.noType)},'special',true,5); COMMIT;`);

    const setRule = (type, plan) => asUser(boundary.databaseUrl, f.manager, `SELECT public.training_set_package_special_requirements(${q(f.packages.r02)},${q(JSON.stringify([{ special_type: type, training_plan_id: plan, exam_plan_id: f.plans.noType }]))}::jsonb);`, true);
    check('02 exact electrical plan accepted', setRule('electrical', f.plans.electrical).status === 0);
    for (const [name, type, plan] of [
      ['03 electrical rejects welding', 'electrical', f.plans.welding],
      ['04 welding rejects electrical', 'welding', f.plans.electrical],
      ['05 blasting rejects drilling', 'blasting', f.plans.drilling],
      ['06 drilling rejects welding', 'drilling', f.plans.welding],
      ['07 null-type plan rejected', 'electrical', f.plans.noType],
    ]) check(name, code(setRule(type, plan), 'special_training_type_mismatch'));

    const tables = ['site_projects','site_project_members','training_admissions','training_admission_tasks','training_admission_special_rules','training_assignments','training_plans'];
    const truncateGrants = Number(scalar(boundary.databaseUrl, `SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name IN(${tables.map(q).join(',')}) AND grantee IN('anon','authenticated') AND privilege_type='TRUNCATE';`));
    check('08 client roles have no core TRUNCATE', truncateGrants === 0, `grants=${truncateGrants}`);

    const memberId = scalar(boundary.databaseUrl, `SELECT id FROM public.site_project_members WHERE project_id=${q(f.projects.a1)} AND employee_id=${q(f.employees.internal)};`);
    psql(boundary.databaseUrl, `INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${q(f.users.audit)},'authenticated','authenticated',${q(`d12-r02-${f.suffix}@example.invalid`)},crypt('D12-r02-test-password',gen_salt('bf')),now(),'','','','','{"provider":"email","providers":["email"]}','{}',now(),now());
      INSERT INTO public.training_special_work_audit_logs(member_id,project_id,employee_id,special_type,old_active,new_active,operator_id,operator_role,reason)
      VALUES(${q(memberId)},${q(f.projects.a1)},${q(f.employees.internal)},'welding',false,true,${q(f.users.audit)},'test_operator','D12 R02 snapshot test');`);
    check('09 insert snapshots operator identity', scalar(boundary.databaseUrl, `SELECT operator_subject_id=operator_id FROM public.training_special_work_audit_logs WHERE operator_id=${q(f.users.audit)};`) === 't');
    psql(boundary.databaseUrl, `DELETE FROM auth.users WHERE id=${q(f.users.audit)};`);
    const retained = scalar(boundary.databaseUrl, `SELECT operator_id IS NULL AND operator_subject_id=${q(f.users.audit)} AND operator_role='test_operator' AND reason='D12 R02 snapshot test' AND changed_at IS NOT NULL FROM public.training_special_work_audit_logs WHERE operator_subject_id=${q(f.users.audit)};`);
    check('10 account deletion preserves durable audit identity', retained === 't');
    check('11 ordinary user cannot alter snapshot', asUser(boundary.databaseUrl, f.users.internal, `UPDATE public.training_special_work_audit_logs SET operator_subject_id=${q(f.users.internal)} WHERE operator_subject_id=${q(f.users.audit)};`, true).status !== 0);
  } finally {
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica; DELETE FROM public.training_special_work_audit_logs WHERE project_id IN(${Object.values(f.projects).map(q).join(',')}); COMMIT;`);
    residual = cleanup(boundary.databaseUrl, f);
    check('12 cleanup residual = 0', residual === 0, `residual=${residual}`);
  }
  const failed = results.filter(result => !result.pass);
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`D12_R02_RESULT ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if (failed.length) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]')); process.exit(1); }
}

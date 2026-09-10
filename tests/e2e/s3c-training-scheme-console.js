/** S3-C TARGETED: server publish validation, conflict reporting, permission and cleanup. */
const crypto=require('crypto');
const {validateTestBoundary,assertD02FixtureMarker}=require('./d04-test-environment');
const {asUser,psql,q,scalar}=require('./d11-three-level-training-reuse');
const {required}=require('./test-config');
const results=[]; const check=(name,pass,detail='')=>{results.push({name,pass});console.log(`${pass?'PASS':'FAIL'} S3C ${name}${detail?` ${detail}`:''}`);};
const id=()=>crypto.randomUUID(); const last=run=>run.out.split(/\r?\n/).filter(Boolean).at(-1)||''; const json=run=>JSON.parse(last(run));
function main(){
  const started=process.hrtime.bigint(),b=validateTestBoundary();assertD02FixtureMarker(b);
  const suffix=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase();
  const admin=scalar(b.databaseUrl,`SELECT u.id FROM auth.users u JOIN public.profiles p ON p.id=u.id WHERE u.email=${q(required('SAFETY_TEST_ADMIN_EMAIL'))} AND (p.is_super_admin OR p.admin_level='company');`);
  const entity=scalar(b.databaseUrl,`SELECT u.id FROM auth.users u WHERE u.email=${q(required('SAFETY_TEST_ENTITY_EMAIL'))};`);
  if(!admin||!entity)throw new Error('S3-C 权限测试账号不可用');
  const org=id(),pkg=id(),schemes={a:id(),b:id()},versions={a:id(),a2:id(),b:id()},rules={a:id(),b:id()}; let residual=-1;
  const call=(user,sql,fail=false)=>asUser(b.databaseUrl,user,sql,fail);
  try{
    psql(b.databaseUrl,`BEGIN;
      INSERT INTO public.organization_units(id,organization_code,name,organization_type,effective_from) VALUES(${q(org)},${q(`S3C-${suffix}-ORG`)},'[S3C] 组织','internal_department','2025-01-01');
      INSERT INTO public.training_admission_packages(id,title,version_no,status,training_category,approved_by,approved_at) VALUES(${q(pkg)},'[S3C] 基础三级教育包',1,'published','basic_three_level',${q(admin)},NOW());
      INSERT INTO public.three_level_training_schemes(id,scheme_code,display_name) VALUES(${q(schemes.a)},${q(`S3C-${suffix}-A`)},'[S3C] 方案A'),(${q(schemes.b)},${q(`S3C-${suffix}-B`)},'[S3C] 方案B');
      INSERT INTO public.three_level_training_scheme_versions(id,scheme_id,version_number,status,effective_from,change_summary) VALUES(${q(versions.a)},${q(schemes.a)},1,'draft','2025-01-01','S3C A V1'),(${q(versions.b)},${q(schemes.b)},1,'draft','2025-01-01','S3C B V1');
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id) VALUES
      (${q(versions.a)},1,'company','company',${q(pkg)}),(${q(versions.a)},2,'organization','organization',${q(pkg)}),(${q(versions.a)},3,'third','department_position',${q(pkg)});
      COMMIT;`);
    check('01 company admin may validate',json(call(admin,`SELECT public.training_scheme_validate_publish(${q(versions.a)});`)).valid===true);
    const denied=call(entity,`SELECT public.training_scheme_validate_publish(${q(versions.a)});`,true);
    check('02 entity admin API denied',denied.status!==0&&denied.err.includes('[S3A:forbidden]'));
    let r=json(call(admin,`SELECT public.training_scheme_validate_publish(${q(versions.b)});`));
    check('03 incomplete stages fail closed',r.valid===false&&r.reason_code==='invalid_stage_structure');
    r=json(call(admin,`SELECT public.training_scheme_publish(${q(versions.a)},'S3C publish',${q(`${suffix}-publish`)});`));
    check('04 validated publish succeeds',r.status==='published'&&r.id===versions.a);
    const immutable=call(admin,`UPDATE public.three_level_training_scheme_versions SET change_summary='illegal' WHERE id=${q(versions.a)};`,true);
    check('05 published version remains immutable',immutable.status!==0&&(/\[S3A:published_version_immutable\]|permission denied/i.test(immutable.err)));
    r=json(call(admin,`SELECT public.training_scheme_create_version(${q(schemes.a)},${q(versions.a)},'2026-01-01','S3C A V2','new version',${q(`${suffix}-v2`)});`)); versions.a2=r.id;
    check('06 published V1 creates V2 draft',r.status==='draft'&&r.version_number===2&&scalar(b.databaseUrl,`SELECT count(*) FROM public.three_level_training_scheme_stages WHERE scheme_version_id=${q(versions.a2)};`)==='3');
    psql(b.databaseUrl,`BEGIN;
      INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id) VALUES
      (${q(versions.b)},1,'company','company',${q(pkg)}),(${q(versions.b)},2,'organization','organization',${q(pkg)}),(${q(versions.b)},3,'third','department_position',${q(pkg)});
      INSERT INTO public.three_level_training_applicability_rules(id,rule_code,scheme_id,organization_unit_id,effective_from,priority,active) VALUES
      (${q(rules.a)},${q(`S3C-${suffix}-A`)},${q(schemes.a)},${q(org)},'2025-01-01',100,TRUE),
      (${q(rules.b)},${q(`S3C-${suffix}-B`)},${q(schemes.b)},${q(org)},'2025-01-01',100,TRUE); COMMIT;`);
    r=json(call(admin,`SELECT public.training_scheme_validate_publish(${q(versions.b)});`));
    check('07 conflicting scheme publish blocked',r.valid===false&&r.reason_code==='applicability_rule_conflict'&&r.conflicts.length>0);
    const publishBlocked=call(admin,`SELECT public.training_scheme_publish(${q(versions.b)},'must fail',${q(`${suffix}-conflict`)});`,true);
    check('08 publish RPC enforces conflict',publishBlocked.status!==0&&publishBlocked.err.includes('[S3C:applicability_rule_conflict]'));
    const conflicts=json(call(admin,'SELECT public.training_scheme_applicability_conflicts();'));
    check('09 conflict list is server authoritative',conflicts.some(x=>[x.rule_id,x.conflicting_rule_id].includes(rules.a)&&[x.rule_id,x.conflicting_rule_id].includes(rules.b)));
    const entityConflicts=call(entity,'SELECT public.training_scheme_applicability_conflicts();',true);
    check('10 conflict list denied outside company scope',entityConflicts.status!==0&&entityConflicts.err.includes('[S3A:forbidden]'));
  } finally {
    psql(b.databaseUrl,`BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_configuration_audit_logs WHERE request_id LIKE ${q(`${suffix}-%`)};
      DELETE FROM public.three_level_training_applicability_rules WHERE id IN(${q(rules.a)},${q(rules.b)});
      DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id IN(${q(versions.a)},${q(versions.a2)},${q(versions.b)});
      DELETE FROM public.three_level_training_scheme_versions WHERE id IN(${q(versions.a)},${q(versions.a2)},${q(versions.b)});
      DELETE FROM public.three_level_training_schemes WHERE id IN(${q(schemes.a)},${q(schemes.b)});
      DELETE FROM public.training_admission_packages WHERE id=${q(pkg)};
      DELETE FROM public.organization_units WHERE id=${q(org)}; COMMIT;`);
    residual=Number(scalar(b.databaseUrl,`SELECT (SELECT count(*) FROM public.organization_units WHERE id=${q(org)})+(SELECT count(*) FROM public.three_level_training_schemes WHERE id IN(${q(schemes.a)},${q(schemes.b)}))+(SELECT count(*) FROM public.training_admission_packages WHERE id=${q(pkg)});`));
    check('11 cleanup residual = 0',residual===0,`residual=${residual}`);
  }
  const failed=results.filter(x=>!x.pass),seconds=Number(process.hrtime.bigint()-started)/1e9;
  console.log(`S3C_TARGETED_RESULT ${failed.length?'FAIL':'PASS'} ${results.length-failed.length}/${results.length} duration=${seconds.toFixed(2)}s residual=${residual}`);
  if(failed.length)process.exit(1);
}
if(require.main===module){try{main();}catch(error){console.error(String(error.message||error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url-redacted]'));process.exit(1);}}

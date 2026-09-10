const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),contract=JSON.parse(fs.readFileSync(path.join(root,'docs','contracts','D16-site-confirmation-v1.json'),'utf8')),
  sql=fs.readFileSync(path.join(root,'sql','training-admission-v107-site-confirmation-evidence.sql'),'utf8'),
  r02=fs.readFileSync(path.join(root,'sql','training-admission-v108-d16-r01-p1-fixes.sql'),'utf8'),
  g1=JSON.parse(fs.readFileSync(path.join(root,'docs','contracts','G1-master-data-api-v1.json'),'utf8')),fail=[];
const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} D16-CONTRACT ${name}`);if(!ok)fail.push(name);};
check('01 version',contract.version==='D16-site-confirmation-v1');
check('02 ANY_OF roles',contract.confirmer.mode==='ANY_OF'&&contract.confirmer.roles.join('|')==='project_manager|safety_officer');
check('03 three paths and visitor exclusion',contract.applicable_paths.length===3&&contract.excluded_paths.includes('visitor'));
check('04 exact binding',contract.requirement.binding.includes('exact_admission')&&contract.requirement.binding.includes('active_project_member'));
check('05 D11 D12 D13 D15 prerequisites',JSON.stringify(contract.prerequisites).includes('D11')&&JSON.stringify(contract.prerequisites).includes('D12')&&JSON.stringify(contract.prerequisites).includes('D13')&&JSON.stringify(contract.prerequisites).includes('D15'));
check('06 photo required and location optional',contract.photo.required===true&&contract.location.required_for_confirmation===false);
check('07 separate photo path',contract.photo.path.includes('/site-confirmation/')&&!contract.photo.path.includes('signature-evidence'));
check('08 server time',contract.time.includes('server'));
check('09 lifecycle rules',contract.invalidation.project_reactivated&&contract.invalidation.membership_reactivated);
check('10 no D18 decision',contract.boundary.includes('does not')&&contract.boundary.includes('D18'));
check('11 reason codes',contract.reason_codes.length>=10);
check('12 SQL has one-current uniqueness',sql.includes('training_site_confirmation_one_current_idx'));
check('13 SQL has immutable guards',sql.includes('training_site_confirmation_history_immutable_guard'));
check('14 SQL has no authenticated table grants',!sql.match(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL).*training_site_confirmation_.*authenticated/is));
check('15 service-only validation',sql.includes('TO service_role')&&sql.includes("request.jwt.claim.role"));
check('16 old migrations untouched by contract',!sql.includes('ALTER TABLE public.training_admissions ADD COLUMN site_confirmed'));
check('17 legacy RPC is disabled by v108 and G1',r02.includes('REVOKE ALL ON FUNCTION public.training_confirm_site')&&g1.rpcs.some(x=>x.name==='training_confirm_site'&&x.authorization.includes('disabled'))&&contract.legacy_write_path.ordinary_client_execute===false);
check('18 legacy table writes are disabled',r02.includes('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE public.training_site_confirmations')&&contract.legacy_write_path.ordinary_client_table_write===false);
check('19 D15 requirements are ensured and fail closed',r02.includes('training_signature_ensure_requirements')&&r02.includes("ELSIF v_signature->>'status'<>'not_required'")&&contract.prerequisites.signature.includes('authoritative not_required'));
console.log(`D16_CONTRACT_RESULT ${fail.length?'FAIL':'PASS'} ${19-fail.length}/19`);if(fail.length)process.exit(1);

/** D09-3 focused: lifecycle, auditable notes, withdraw and immutable versions. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');
const root = path.resolve(__dirname, '..', '..');
const migrations = [78,79,80].map(v => path.join(root,'sql',v===78?'training-admission-v78-plan-scope-hours-targets.sql':v===79?'training-admission-v79-plan-lifecycle-audit.sql':'training-admission-v80-d09-r02-p1-closure.sql'));
const contract = JSON.parse(fs.readFileSync(path.join(root,'docs','contracts','D09-training-plan-api-v1.json'),'utf8'));
const results=[]; const literal=x=>`'${String(x).replace(/'/g,"''")}'`; const ok=r=>r.status>=200&&r.status<300; const denied=r=>[400,401,403,404,409].includes(r.status);
function check(name,pass,detail=''){results.push({name,pass});console.log(`${pass?'PASS':'FAIL'} ${name}${detail?` ${detail}`:''}`);}
function psql(db,sql){const r=spawnSync('psql',[db,'-X','-Atq','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8',windowsHide:true});if(r.error||r.status!==0)throw new Error(String(r.stderr||r.error?.message||'数据库失败').replaceAll(db,'[database-url-redacted]').trim());return String(r.stdout||'').trim();}
function apply(db){for(const file of migrations){const r=spawnSync('psql',[db,'-X','-q','-v','ON_ERROR_STOP=1','-f',file],{encoding:'utf8',windowsHide:true});if(r.error||r.status!==0)throw new Error(`迁移应用失败：${path.basename(file)}`);}}
async function req(base,key,pathname,o={}){const r=await fetch(base+pathname,{...o,headers:{apikey:key,...(o.headers||{})}});const t=await r.text();let j;try{j=t?JSON.parse(t):null;}catch{j=t;}return{status:r.status,json:j};}
function rpc(b,k,t,n,body){return req(b.apiOrigin,k,`/rest/v1/rpc/${n}`,{method:'POST',headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'},body:JSON.stringify(body)});}
function rest(b,k,t,table,method,query='',body=null){return req(b.apiOrigin,k,`/rest/v1/${table}${query}`,{method,headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json',Prefer:'return=representation'},body:body==null?undefined:JSON.stringify(body)});}
async function main(){const started=process.hrtime.bigint();const b=validateTestBoundary();const key=required('SAFETY_SUPABASE_ANON_KEY');check('D09-3-GATE 隔离测试边界',assertD02FixtureMarker(b)>0);apply(b.databaseUrl);
 check('D09-4-CONTRACT 机器契约覆盖四类范围、生命周期和有效学时',contract.contract_id==='D09-training-plan-api-v1'&&contract.enums.plan_scope.length===4&&contract.rpcs.length===7&&contract.effective_hours.client_progress_is_not_hours===true);
 const suffix=crypto.randomUUID().replace(/-/g,'').slice(0,12),id=()=>crypto.randomUUID();const f={user:id(),plans:[id(),id(),id()],courses:[id(),id(),id()],email:`d09-v79-${suffix}@example.invalid`,password:crypto.randomBytes(18).toString('base64url'),dept:psql(b.databaseUrl,"SELECT id FROM public.departments WHERE code='D02-ENT-A' LIMIT 1;")};let token,cloneId,residue=-1;
 try{
  psql(b.databaseUrl,`BEGIN;SET LOCAL app.safety_test_confirmation='D02_TEST_ONLY';INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)VALUES('00000000-0000-0000-0000-000000000000',${literal(f.user)}::uuid,'authenticated','authenticated',${literal(f.email)},crypt(${literal(f.password)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}',now(),now());UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(f.dept)}::uuid WHERE id=${literal(f.user)}::uuid;COMMIT;`);
  const login=await req(b.apiOrigin,key,'/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email,password:f.password})});token=login.json?.access_token;check('D09-3-AUTH 真实管理员 JWT',ok(login)&&!!token);
  for(let i=0;i<3;i++){const plan=await rpc(b,key,token,'training_save_plan_draft',{p_plan_id:f.plans[i],p_plan:{title:`[D09-3] plan ${i} ${suffix}`,level:'entity',department_id:f.dept,plan_year:2026,hours:1,required_hours:0.5},p_target_department_ids:[]});const course=await rest(b,key,token,'training_courses','POST','',{id:f.courses[i],plan_id:f.plans[i],title:`course ${i}`,course_type:'text',content:'D09 lifecycle'});if(!ok(plan)||!ok(course))throw new Error(`D09-3 setup failed ${plan.status}/${course.status}`);}
  const submit=await rpc(b,key,token,'training_request_plan_approval',{p_plan_id:f.plans[0]});const noNote=await rpc(b,key,token,'training_approve_plan',{p_plan_id:f.plans[0],p_approved:true,p_note:null});const sign=await rpc(b,key,token,'training_approve_plan',{p_plan_id:f.plans[0],p_approved:true,p_note:'单项签发意见'});
  check('D09-3-SIGN 送审、必填意见、单项签发',ok(submit)&&denied(noNote)&&ok(sign));
  await Promise.all(f.plans.slice(1).map(x=>rpc(b,key,token,'training_request_plan_approval',{p_plan_id:x})));
  const batchBad=await rpc(b,key,token,'training_batch_approve_plans',{p_items:f.plans.slice(1).map(x=>({plan_id:x,note:''}))});
  const batch=await rpc(b,key,token,'training_batch_approve_plans',{p_items:[{plan_id:f.plans[1],note:'批次意见 A'},{plan_id:f.plans[2],note:'批次意见 B'}]});
  check('D09-3-BATCH 每项意见必填且返回可审计结果',denied(batchBad)&&ok(batch)&&batch.json?.results?.length===2&&!!batch.json?.batch_id&&Object.keys(batch.json).sort().join(',')==='batch_id,results');
  const publishBad=await rpc(b,key,token,'training_publish_plan',{p_plan_id:f.plans[0],p_note:null});const publish=await rpc(b,key,token,'training_publish_plan',{p_plan_id:f.plans[0],p_note:'发布说明'});
  check('D09-3-PUBLISH 发布说明、发布人和版本摘要',denied(publishBad)&&ok(publish)&&publish.json?.version_summary?.version_no===1&&['assigned','record_id','success','version_summary'].every(k=>Object.hasOwn(publish.json,k))
    && psql(b.databaseUrl,`SELECT (published_by=${literal(f.user)}::uuid AND publication_note='发布说明')::int FROM public.training_plans WHERE id=${literal(f.plans[0])}::uuid;`)==='1');
  const tamper=await rest(b,key,token,'training_plans','PATCH',`?id=eq.${f.plans[0]}`,{title:'tampered'});const withdrawBad=await rpc(b,key,token,'training_withdraw_plan',{p_plan_id:f.plans[0],p_reason:''});const withdraw=await rpc(b,key,token,'training_withdraw_plan',{p_plan_id:f.plans[0],p_reason:'版本需要更新'});
  check('D09-3-WITHDRAW 已发布内容不可原改、撤回原因必填且保留历史',denied(tamper)&&denied(withdrawBad)&&ok(withdraw)&&['plan_id','previous_approval_status','previous_publish_status','status'].every(k=>Object.hasOwn(withdraw.json,k))
    && psql(b.databaseUrl,`SELECT (publish_status='withdrawn' AND withdraw_reason='版本需要更新')::int FROM public.training_plans WHERE id=${literal(f.plans[0])}::uuid;`)==='1');
  const clone=await rpc(b,key,token,'training_clone_plan_version',{p_plan_id:f.plans[0]});cloneId=clone.json;
  check('D09-3-VERSION 新草稿复制内容但不复制学习记录',ok(clone)&&!!cloneId&&psql(b.databaseUrl,`SELECT ((SELECT count(*) FROM public.training_courses WHERE plan_id=${literal(cloneId)}::uuid)=1 AND (SELECT count(*) FROM public.training_assignments WHERE plan_id=${literal(cloneId)}::uuid)=0)::int;`)==='1');
  const events=psql(b.databaseUrl,`SELECT string_agg(event_type||':'||COALESCE(note,''),',' ORDER BY occurred_at,id) FROM public.training_plan_events WHERE plan_id=${literal(f.plans[0])}::uuid;`);
  const batches=psql(b.databaseUrl,`SELECT count(DISTINCT batch_id) FROM public.training_plan_events WHERE plan_id IN(${literal(f.plans[1])}::uuid,${literal(f.plans[2])}::uuid) AND event_type='signed' AND batch_id IS NOT NULL;`);
  check('D09-3-AUDIT 事件含操作人、时间、意见、版本摘要及批次',events.includes('submitted:')&&events.includes('signed:单项签发意见')&&events.includes('published:发布说明')&&events.includes('withdrawn:版本需要更新')&&batches==='1');
 }finally{
  const ids=[...f.plans,...(cloneId?[cloneId]:[])].map(x=>`${literal(x)}::uuid`).join(',');
  psql(b.databaseUrl,`BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM public.training_course_progress WHERE course_id IN(SELECT id FROM public.training_courses WHERE plan_id IN(${ids}));DELETE FROM public.training_study_logs WHERE course_id IN(SELECT id FROM public.training_courses WHERE plan_id IN(${ids}));DELETE FROM public.training_assignments WHERE plan_id IN(${ids});DELETE FROM public.training_records WHERE plan_id IN(${ids});DELETE FROM public.training_plan_events WHERE plan_id IN(${ids});DELETE FROM public.training_courses WHERE plan_id IN(${ids});DELETE FROM public.training_plan_targets WHERE plan_id IN(${ids});DELETE FROM public.training_plans WHERE id IN(${ids});COMMIT;DELETE FROM auth.users WHERE id=${literal(f.user)}::uuid;`);
  residue=Number(psql(b.databaseUrl,`SELECT (SELECT count(*) FROM auth.users WHERE id=${literal(f.user)}::uuid)+(SELECT count(*) FROM public.training_plans WHERE title LIKE '[D09-3]%');`));
 }
 check('D09-3-RESIDUE 测试残留为 0',residue===0);const failed=results.filter(x=>!x.pass),elapsed=Number(process.hrtime.bigint()-started)/1e6;console.log(`D09_LIFECYCLE_AUDIT_SUMMARY total=${results.length} passed=${results.length-failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsed.toFixed(0)}`);if(failed.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

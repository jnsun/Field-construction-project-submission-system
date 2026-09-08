/** D09-2 focused: authoritative scopes, atomic targets and effective hours. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrations = [
  path.join(root, 'sql', 'training-admission-v78-plan-scope-hours-targets.sql'),
  path.join(root, 'sql', 'training-admission-v80-d09-r02-p1-closure.sql'),
];
const migration = migrations[0];
const effectiveOnly = process.argv.includes('--effective-only');
const results = [];
const literal = value => `'${String(value).replace(/'/g, "''")}'`;
const ok = response => response.status >= 200 && response.status < 300;
const denied = response => [400, 401, 403, 404, 409].includes(response.status);
function check(name, pass, detail = '') { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`); }

function psql(databaseUrl, sql) {
  const r = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(String(r.stderr || r.error?.message || '数据库操作失败').replaceAll(databaseUrl, '[database-url-redacted]').trim());
  return String(r.stdout || '').trim();
}
function apply(databaseUrl) {
  for (const file of migrations) {
    const r = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`测试迁移应用失败：${path.basename(file)}`);
  }
}
async function request(base, key, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { apikey: key, ...(options.headers || {}) } });
  const text = await response.text(); let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(base, key, email, password) {
  const r = await request(base, key, '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!ok(r) || !r.json?.access_token) throw new Error('D09-2 临时账号登录失败');
  return r.json.access_token;
}
function rpc(boundary, key, token, name, body) {
  return request(boundary.apiOrigin, key, `/rest/v1/rpc/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function rest(boundary, key, token, table, method, body) {
  return request(boundary.apiOrigin, key, `/rest/v1/${table}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body == null ? undefined : JSON.stringify(body) });
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const key = required('SAFETY_SUPABASE_ANON_KEY');
  check('D09-2-GATE 隔离测试边界与 D02 夹具', assertD02FixtureMarker(boundary) > 0);
  const source = fs.readFileSync(migration, 'utf8');
  check('D09-2-STATIC 权威范围、原子 RPC、targets 最小权限、有效学时 guard',
    source.includes('site_project_id') && source.includes('training_save_plan_draft')
    && /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.training_plan_targets FROM authenticated/i.test(source)
    && source.includes('training_assignment_effective_hours_guard'));
  apply(boundary.databaseUrl);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const id = () => crypto.randomUUID();
  const f = {
    userA: id(), userB: id(), employeeA: id(), planEntity: id(), planProject: id(), planSpecial: id(),
    planStudy: id(), courseStudy: id(), assignment: id(), projectForeign: id(),
    emailA: `d09-v78-a-${suffix}@example.invalid`, emailB: `d09-v78-b-${suffix}@example.invalid`,
    passwordA: crypto.randomBytes(18).toString('base64url'), passwordB: crypto.randomBytes(18).toString('base64url'),
    deptA: psql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-A' LIMIT 1;"),
    deptB: psql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-B' LIMIT 1;"),
    projectA: psql(boundary.databaseUrl, "SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL' LIMIT 1;"),
  };
  let tokenA; let tokenB; let residue = -1;
  try {
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL app.safety_test_confirmation='D02_TEST_ONLY';
      INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,confirmation_token,recovery_token,email_change,email_change_token_new,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000000000',${literal(f.userA)}::uuid,'authenticated','authenticated',${literal(f.emailA)},crypt(${literal(f.passwordA)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}',now(),now()),
      ('00000000-0000-0000-0000-000000000000',${literal(f.userB)}::uuid,'authenticated','authenticated',${literal(f.emailB)},crypt(${literal(f.passwordB)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}',now(),now());
      UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(f.deptA)}::uuid WHERE id=${literal(f.userA)}::uuid;
      UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(f.deptB)}::uuid WHERE id=${literal(f.userB)}::uuid;
      INSERT INTO public.site_projects(id,project_code,name,status,lead_entity_id,report_notes) VALUES(${literal(f.projectForeign)}::uuid,'D09-${suffix}','D09 foreign project','active',${literal(f.deptB)}::uuid,'D09-2 TEST'); COMMIT;`);
    [tokenA, tokenB] = await Promise.all([login(boundary.apiOrigin, key, f.emailA, f.passwordA), login(boundary.apiOrigin, key, f.emailB, f.passwordB)]);
    check('D09-2-AUTH 两个独立真实 JWT', tokenA !== tokenB);

    if (!effectiveOnly) {
    const entity = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: f.planEntity, p_plan: { title: `[D09-2] entity ${suffix}`, level: 'entity', department_id: f.deptA, plan_year: 2026, hours: 1, required_hours: 0.5 }, p_target_department_ids: [f.deptA] });
    check('D09-2-ENTITY 经营实体范围及 targets 原子创建', ok(entity)
      && psql(boundary.databaseUrl, `SELECT count(*) FROM public.training_plan_targets WHERE plan_id=${literal(f.planEntity)}::uuid;`) === '1');

    const before = psql(boundary.databaseUrl, `SELECT title||'|'||(SELECT count(*) FROM public.training_plan_targets WHERE plan_id=p.id) FROM public.training_plans p WHERE id=${literal(f.planEntity)}::uuid;`);
    const crossTarget = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: f.planEntity, p_plan: { title: 'SHOULD NOT SAVE', level: 'entity', department_id: f.deptA, plan_year: 2026, hours: 1, required_hours: 0.5 }, p_target_department_ids: [f.deptB] });
    check('D09-2-ATOMIC 越权 target 拒绝且计划主体不部分成功', denied(crossTarget)
      && psql(boundary.databaseUrl, `SELECT title||'|'||(SELECT count(*) FROM public.training_plan_targets WHERE plan_id=p.id) FROM public.training_plans p WHERE id=${literal(f.planEntity)}::uuid;`) === before);

    const project = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: f.planProject, p_plan: { title: `[D09-2] project ${suffix}`, level: 'project', site_project_id: f.projectA, plan_year: 2026, hours: 1, required_hours: 1 }, p_target_department_ids: [] });
    const crossProject = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: id(), p_plan: { title: 'cross project', level: 'project', site_project_id: f.projectForeign, plan_year: 2026, hours: 1, required_hours: 1 }, p_target_department_ids: [] });
    check('D09-2-PROJECT 正式项目关联按项目权限允许/拒绝', ok(project) && denied(crossProject), JSON.stringify({own:project.status,cross:crossProject.status}));

    const specialMissing = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: id(), p_plan: { title: 'bad special', level: 'special', site_project_id: f.projectA, plan_year: 2026, hours: 1, required_hours: 1 }, p_target_department_ids: [] });
    const special = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: f.planSpecial, p_plan: { title: `[D09-2] special ${suffix}`, level: 'special', special_type: '焊工实作', site_project_id: f.projectA, plan_year: 2026, hours: 1, required_hours: 1 }, p_target_department_ids: [] });
    check('D09-2-SPECIAL 专项类型必填且不按持证自动建名单', denied(specialMissing) && ok(special)
      && psql(boundary.databaseUrl, `SELECT count(*) FROM public.training_assignments WHERE plan_id=${literal(f.planSpecial)}::uuid;`) === '0');

    const badHours = await rpc(boundary, key, tokenA, 'training_save_plan_draft', { p_plan_id: id(), p_plan: { title: 'bad hours', level: 'entity', department_id: f.deptA, plan_year: 2026, hours: 1, required_hours: 2 }, p_target_department_ids: [] });
    const directTarget = await rest(boundary, key, tokenA, 'training_plan_targets', 'POST', { plan_id: f.planEntity, department_id: f.deptA });
    check('D09-2-HOURS/TARGET 非法学时与 targets 直写均拒绝', denied(badHours) && denied(directTarget));
    }

    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
      INSERT INTO public.training_employees(id,name,employee_no,department_id,user_id,status) VALUES(${literal(f.employeeA)}::uuid,'D09 v78 employee','D09-${suffix}',${literal(f.deptA)}::uuid,${literal(f.userA)}::uuid,'active');
      UPDATE public.profiles SET employee_id=${literal(f.employeeA)}::uuid WHERE id=${literal(f.userA)}::uuid;
      INSERT INTO public.training_plans(id,title,level,department_id,plan_year,hours,required_hours,approval_status,publish_status,version_root_id) VALUES(${literal(f.planStudy)}::uuid,'D09 study','entity',${literal(f.deptA)}::uuid,2026,1,0.5,'approved','published',${literal(f.planStudy)}::uuid);
      INSERT INTO public.training_courses(id,plan_id,title,course_type,content) VALUES(${literal(f.courseStudy)}::uuid,${literal(f.planStudy)}::uuid,'study','text','content');
      INSERT INTO public.training_assignments(id,plan_id,employee_id,user_id,department_id) VALUES(${literal(f.assignment)}::uuid,${literal(f.planStudy)}::uuid,${literal(f.employeeA)}::uuid,${literal(f.userA)}::uuid,${literal(f.deptA)}::uuid); COMMIT;`);
    const instant = await rpc(boundary, key, tokenA, 'training_save_course_progress', { p_course_id: f.courseStudy, p_progress: 100, p_position: 1 });
    const asg = psql(boundary.databaseUrl, `SELECT status||'|'||COALESCE(hours_earned,0)::text FROM public.training_assignments WHERE id=${literal(f.assignment)}::uuid;`);
    const directComplete = await request(boundary.apiOrigin, key, `/rest/v1/training_assignments?id=eq.${f.assignment}`, { method: 'PATCH', headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ status: 'completed', hours_earned: 0.5 }) });
    check('D09-2-EFFECTIVE 打开/提交 100 不获要求学时，assignment 直改拒绝', ok(instant) && !asg.startsWith('completed|') && denied(directComplete), JSON.stringify({instant:instant.status,instantError:instant.json?.message||'',assignment:asg,direct:directComplete.status}));
  } finally {
    psql(boundary.databaseUrl, `BEGIN; SET LOCAL session_replication_role=replica;
      DELETE FROM public.training_course_progress WHERE course_id=${literal(f.courseStudy)}::uuid;
      DELETE FROM public.training_assignments WHERE id=${literal(f.assignment)}::uuid;
      DELETE FROM public.training_courses WHERE id=${literal(f.courseStudy)}::uuid;
      DELETE FROM public.training_plan_targets WHERE plan_id IN (${literal(f.planEntity)}::uuid,${literal(f.planProject)}::uuid,${literal(f.planSpecial)}::uuid,${literal(f.planStudy)}::uuid);
      DELETE FROM public.training_plans WHERE id IN (${literal(f.planEntity)}::uuid,${literal(f.planProject)}::uuid,${literal(f.planSpecial)}::uuid,${literal(f.planStudy)}::uuid);
      DELETE FROM public.training_employees WHERE id=${literal(f.employeeA)}::uuid; COMMIT;
      DELETE FROM public.site_projects WHERE id=${literal(f.projectForeign)}::uuid;
      DELETE FROM auth.users WHERE id IN (${literal(f.userA)}::uuid,${literal(f.userB)}::uuid);`);
    residue = Number(psql(boundary.databaseUrl, `SELECT (SELECT count(*) FROM auth.users WHERE id IN (${literal(f.userA)}::uuid,${literal(f.userB)}::uuid))+(SELECT count(*) FROM public.training_plans WHERE title LIKE '[D09-2]%')+(SELECT count(*) FROM public.training_employees WHERE id=${literal(f.employeeA)}::uuid);`));
  }
  check('D09-2-RESIDUE 测试残留为 0', residue === 0);
  const failed = results.filter(x => !x.pass);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D09_PLAN_SCOPE_HOURS_SUMMARY total=${results.length} passed=${results.length-failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsed.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

/** D09-1 R02 targeted: three P1 permission boundaries through real JWT/API calls. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v76-d09-p1-permission-boundaries.sql');
const closureMigrationPath = path.join(root, 'sql', 'training-admission-v80-d09-r02-p1-closure.sql');
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const results = [];

function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}
function success(response) { return response.status >= 200 && response.status < 300; }
function denied(response) { return [400, 401, 403, 404].includes(response.status); }
function blockedMutation(response) {
  return denied(response) || (success(response) && Array.isArray(response.json) && response.json.length === 0);
}
function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`D09-1 P1 数据库操作失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}
function applyMigration(databaseUrl) {
  for (const file of [migrationPath, closureMigrationPath]) {
    const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`D09-1 测试迁移应用失败：${path.basename(file)}`);
  }
}
async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options, headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}
async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D09-1 P1 隔离测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}
function rest(boundary, anonKey, token, table, method, query = '', body = null) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/${table}${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}
function storageUpload(boundary, anonKey, token, storagePath, content, upsert = false) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/training-courses/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'x-upsert': String(upsert),
      }, body: Buffer.from(content),
    });
}
function storageSign(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/sign/training-courses/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    });
}
function storageDelete(boundary, anonKey, token, storagePath) {
  return request(boundary.apiOrigin, anonKey, '/storage/v1/object/training-courses', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
}
function storageFingerprint(databaseUrl, storagePath) {
  return runPsql(databaseUrl, `SELECT COALESCE(json_build_object('id',id,'name',name,'updated_at',updated_at,'metadata',metadata)::text,'')
    FROM storage.objects WHERE bucket_id='training-courses' AND name=${literal(storagePath)};`);
}
function readScope(databaseUrl) {
  return JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'company_user',(SELECT id FROM auth.users WHERE email=${literal(required('SAFETY_TEST_ADMIN_EMAIL'))}),
    'entity_user',(SELECT id FROM auth.users WHERE email=${literal(required('SAFETY_TEST_ENTITY_EMAIL'))}),
    'company_profile',(SELECT json_build_object('role',role,'admin_level',admin_level,'department_id',department_id,'employee_id',employee_id) FROM public.profiles WHERE id=(SELECT id FROM auth.users WHERE email=${literal(required('SAFETY_TEST_ADMIN_EMAIL'))})),
    'entity_profile',(SELECT json_build_object('role',role,'admin_level',admin_level,'department_id',department_id,'employee_id',employee_id) FROM public.profiles WHERE id=(SELECT id FROM auth.users WHERE email=${literal(required('SAFETY_TEST_ENTITY_EMAIL'))})),
    'dept_a',(SELECT department_id FROM public.profiles WHERE id=(SELECT id FROM auth.users WHERE email=${literal(required('SAFETY_TEST_ENTITY_EMAIL'))})),
    'dept_b',(SELECT id FROM public.departments WHERE code='D02-ENT-B' LIMIT 1)
  );`));
}
function verifyStatic() {
  const sql = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hash = crypto.createHash('sha256').update(sql).digest('hex').toUpperCase();
  const v76 = manifest.migrations.find(item => item.version === 76);
  return v76?.file === path.basename(migrationPath) && v76.sha256 === hash
    && sql.includes('training_plan_row_can_write')
    && sql.includes('training_library_can_read')
    && sql.includes('training_course_file_owned_unlinked')
    && !/SELECT\s+public\.is_admin\(\)\s+OR\s+EXISTS/i.test(sql);
}
function setup(databaseUrl, f, scope) {
  runPsql(databaseUrl, `
    INSERT INTO public.training_employees(id,name,employee_no,department_id,position,emp_type,status,remark)
    VALUES (${literal(f.employeeA)}::uuid,'[D09-P1] employee A',${literal(`D09A-${f.suffix}`)},${literal(scope.dept_a)}::uuid,'测试','employee','active','D09-P1 TEST');
    UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(scope.dept_b)}::uuid,employee_id=NULL
      WHERE id=${literal(scope.company_user)}::uuid;
    INSERT INTO public.training_plans(id,title,level,department_id,plan_year,created_by) VALUES
      (${literal(f.planA)}::uuid,'[D09-P1] dept A','entity',${literal(scope.dept_a)}::uuid,2026,${literal(scope.entity_user)}::uuid),
      (${literal(f.planB)}::uuid,'[D09-P1] dept B','entity',${literal(scope.dept_b)}::uuid,2026,${literal(scope.company_user)}::uuid),
      (${literal(f.planFormal)}::uuid,'[D09-P1] formal','entity',${literal(scope.dept_b)}::uuid,2026,${literal(scope.company_user)}::uuid);
  `);
}
function linkLibraries(databaseUrl, f, scope) {
  runPsql(databaseUrl, `
    BEGIN;
    SELECT set_config('request.jwt.claim.sub',${literal(scope.entity_user)},TRUE);
    INSERT INTO public.training_library(id,title,course_type,scope,department_id,storage_path,content,status) VALUES
      (${literal(f.libraryA)}::uuid,'[D09-P1] library A','article','dept',${literal(scope.dept_a)}::uuid,${literal(f.pathA)},'content A v1','published'),
      (${literal(f.libraryB)}::uuid,'[D09-P1] library B','article','dept',${literal(scope.dept_b)}::uuid,${literal(f.pathB)},'content B private','published');
    COMMIT;
  `);
}
function linkStorage(databaseUrl, f, scope) {
  runPsql(databaseUrl, `
    BEGIN;
    SET LOCAL session_replication_role=replica;
    INSERT INTO public.training_courses(id,plan_id,title,course_type,file_path,content) VALUES
      (${literal(f.courseA)}::uuid,${literal(f.planA)}::uuid,'[D09-P1] file A','text',${literal(f.pathA)},'A'),
      (${literal(f.courseB)}::uuid,${literal(f.planB)}::uuid,'[D09-P1] file B','text',${literal(f.pathB)},'B'),
      (${literal(f.courseFormal)}::uuid,${literal(f.planFormal)}::uuid,'[D09-P1] formal file','text',${literal(f.pathFormal)},'formal');
    SELECT set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
    UPDATE public.training_plans SET approval_status='approved',publish_status='published',approved_at=NOW(),published_at=NOW()
      WHERE id=${literal(f.planFormal)}::uuid;
    INSERT INTO public.training_assignments(id,plan_id,employee_id,user_id,department_id)
    VALUES (${literal(f.assignment)}::uuid,${literal(f.planFormal)}::uuid,${literal(f.employeeA)}::uuid,${literal(scope.entity_user)}::uuid,${literal(scope.dept_a)}::uuid);
    COMMIT;
  `);
}
function restoreProfile(databaseUrl, userId, profile) {
  runPsql(databaseUrl, `UPDATE public.profiles SET role=${literal(profile.role)},
    admin_level=${profile.admin_level == null ? 'NULL' : literal(profile.admin_level)},
    department_id=${profile.department_id == null ? 'NULL' : `${literal(profile.department_id)}::uuid`},
    employee_id=${profile.employee_id == null ? 'NULL' : `${literal(profile.employee_id)}::uuid`}
    WHERE id=${literal(userId)}::uuid;`);
}
function cleanupBusiness(databaseUrl, f, scope) {
  restoreProfile(databaseUrl, scope.company_user, scope.company_profile);
  restoreProfile(databaseUrl, scope.entity_user, scope.entity_profile);
  runPsql(databaseUrl, `
    BEGIN;
    SET LOCAL session_replication_role=replica;
    DELETE FROM public.training_assignments WHERE id=${literal(f.assignment)}::uuid;
    DELETE FROM public.training_courses WHERE id IN (${[f.courseA, f.courseB, f.courseFormal, f.courseLibraryA, f.courseLibraryCross, f.courseLibraryEmployee, f.courseLibraryCompany].map(x => `${literal(x)}::uuid`).join(',')});
    DELETE FROM public.training_plans WHERE id IN (${[f.planFormal, f.planA, f.planB, f.planOwn, f.planCompany, f.planEscalate].map(x => `${literal(x)}::uuid`).join(',')});
    DELETE FROM public.training_library WHERE id IN (${literal(f.libraryA)}::uuid,${literal(f.libraryB)}::uuid);
    DELETE FROM public.training_employee_versions WHERE employee_id=${literal(f.employeeA)}::uuid;
    DELETE FROM public.training_employees WHERE id=${literal(f.employeeA)}::uuid;
    COMMIT;
  `);
}

async function main() {
  const started = process.hrtime.bigint();
  check('D09-P1-STATIC v76 manifest/hash 和三项边界', verifyStatic());
  if (process.argv.includes('--static')) return finish(started, '-');

  const boundary = validateTestBoundary();
  check('D09-P1-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigration(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const entity = await login(boundary.apiOrigin, anonKey,
    required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
  const scope = readScope(boundary.databaseUrl);
  check('D09-P1-ACCOUNTS 真实 JWT 与 D02 entity 账号一致且第二 Auth profile 存在',
    entity.userId === scope.entity_user && Boolean(scope.company_user));

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const id = () => crypto.randomUUID();
  const f = {
    suffix, employeeA: id(), planA: id(), planB: id(), planFormal: id(),
    planOwn: id(), planCompany: id(), planEscalate: id(), libraryA: id(), libraryB: id(),
    courseA: id(), courseB: id(), courseFormal: id(), courseLibraryA: id(), courseLibraryCross: id(),
    courseLibraryEmployee: id(), courseLibraryCompany: id(), assignment: id(),
    pathA: `d09-p1/${suffix}/dept-a.txt`, pathB: `d09-p1/${suffix}/dept-b.txt`,
    pathOwner: `d09-p1/${suffix}/owner-temp.txt`, pathOtherOwner: `d09-p1/${suffix}/other-owner-temp.txt`,
    pathFormal: `d09-p1/${suffix}/formal.txt`,
  };
  const paths = [f.pathA, f.pathB, f.pathOwner, f.pathOtherOwner, f.pathFormal];
  let residue = -1;

  try {
    setup(boundary.databaseUrl, f, scope);
    check('D09-P1-SETUP 第二 Auth profile 临时成为另一部门真实管理员', runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.profiles WHERE id IN (${literal(scope.company_user)}::uuid,${literal(scope.entity_user)}::uuid) AND role='admin' AND admin_level='dept' AND department_id IN (${literal(scope.dept_a)}::uuid,${literal(scope.dept_b)}::uuid);`) === '2');

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(scope.dept_b)}::uuid,employee_id=NULL WHERE id=${literal(scope.entity_user)}::uuid;`);
    const bUploads = await Promise.all([
      storageUpload(boundary, anonKey, entity.token, f.pathB, 'owner B'),
      storageUpload(boundary, anonKey, entity.token, f.pathOtherOwner, 'other owner temporary'),
      storageUpload(boundary, anonKey, entity.token, f.pathFormal, 'formal owner B'),
    ]);
    runPsql(boundary.databaseUrl, `UPDATE storage.objects SET owner=${literal(scope.company_user)}::uuid,owner_id=${literal(scope.company_user)} WHERE bucket_id='training-courses' AND name=${literal(f.pathOtherOwner)};`);
    restoreProfile(boundary.databaseUrl, scope.entity_user, scope.entity_profile);
    const aUploads = await Promise.all([
      storageUpload(boundary, anonKey, entity.token, f.pathA, 'owner A'),
      storageUpload(boundary, anonKey, entity.token, f.pathOwner, 'owner A temporary'),
    ]);
    const uploads = [...aUploads, ...bUploads];
    check('D09-P1-STORAGE-00 两部门管理员通过真实 Storage API 上传测试文件', uploads.every(success));
    linkLibraries(boundary.databaseUrl, f, scope);
    linkStorage(boundary.databaseUrl, f, scope);

    check('D09-P1-STORAGE-01 dept A 可读取本部门草稿文件', success(await storageSign(boundary, anonKey, entity.token, f.pathA)));
    check('D09-P1-STORAGE-02 dept A 不能读取 dept B 草稿文件', denied(await storageSign(boundary, anonKey, entity.token, f.pathB)));
    const crossBefore = storageFingerprint(boundary.databaseUrl, f.pathB);
    const crossOverwrite = await storageUpload(boundary, anonKey, entity.token, f.pathB, 'cross overwrite', true);
    const crossDelete = await storageDelete(boundary, anonKey, entity.token, f.pathB);
    check('D09-P1-STORAGE-03 dept A 不能覆盖或删除 dept B 文件', denied(crossOverwrite)
      && (denied(crossDelete) || success(crossDelete)) && storageFingerprint(boundary.databaseUrl, f.pathB) === crossBefore);
    const otherBefore = storageFingerprint(boundary.databaseUrl, f.pathOtherOwner);
    const nonOwner = await storageUpload(boundary, anonKey, entity.token, f.pathOtherOwner, 'non-owner overwrite', true);
    const ownerBefore = storageFingerprint(boundary.databaseUrl, f.pathOwner);
    const ownerUpdate = await storageUpload(boundary, anonKey, entity.token, f.pathOwner, 'owner overwrite', true);
    check('D09-P1-STORAGE-04 未关联临时文件仅 owner 可维护', denied(nonOwner) && success(ownerUpdate)
      && storageFingerprint(boundary.databaseUrl, f.pathOtherOwner) === otherBefore
      && storageFingerprint(boundary.databaseUrl, f.pathOwner) !== ownerBefore);

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='admin',admin_level='company',department_id=${literal(scope.dept_a)}::uuid,employee_id=${literal(f.employeeA)}::uuid WHERE id=${literal(scope.entity_user)}::uuid;`);
    check('D09-P1-STORAGE-05 company admin 可读取批准管理范围文件', success(await storageSign(boundary, anonKey, entity.token, f.pathB)));
    const formalBefore = storageFingerprint(boundary.databaseUrl, f.pathFormal);
    const formalOverwrite = await storageUpload(boundary, anonKey, entity.token, f.pathFormal, 'formal overwrite', true);
    const formalDelete = await storageDelete(boundary, anonKey, entity.token, f.pathFormal);
    check('D09-P1-STORAGE-06 正式历史文件不能覆盖或删除', denied(formalOverwrite)
      && (denied(formalDelete) || success(formalDelete)) && storageFingerprint(boundary.databaseUrl, f.pathFormal) === formalBefore);

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='employee',admin_level=NULL,department_id=${literal(scope.dept_a)}::uuid,employee_id=${literal(f.employeeA)}::uuid WHERE id=${literal(scope.entity_user)}::uuid;`);
    check('D09-P1-STORAGE-07 未分配 employee 不能读取文件', denied(await storageSign(boundary, anonKey, entity.token, f.pathB)));
    check('D09-P1-STORAGE-08 published + assignment 学员可以读取', success(await storageSign(boundary, anonKey, entity.token, f.pathFormal)));
    const employeeLibrary = await rest(boundary, anonKey, entity.token, 'training_courses', 'POST', '', {
      id: f.courseLibraryEmployee, plan_id: f.planA, title: 'employee cross', course_type: 'text', library_id: f.libraryB,
    });
    check('D09-P1-LIBRARY-03 无权限用户知道 UUID 仍不能复制资源', denied(employeeLibrary));
    restoreProfile(boundary.databaseUrl, scope.entity_user, scope.entity_profile);

    const ownLibrary = await rest(boundary, anonKey, entity.token, 'training_courses', 'POST', '', {
      id: f.courseLibraryA, plan_id: f.planA, title: 'own library', course_type: 'text', library_id: f.libraryA,
    });
    const crossLibrary = await rest(boundary, anonKey, entity.token, 'training_courses', 'POST', '', {
      id: f.courseLibraryCross, plan_id: f.planA, title: 'cross library', course_type: 'text', library_id: f.libraryB,
    });
    check('D09-P1-LIBRARY-01 dept A 可快照本部门资源', success(ownLibrary));
    check('D09-P1-LIBRARY-02 dept A 不能按 UUID 快照 dept B 资源且无残留', denied(crossLibrary)
      && runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.training_courses WHERE id=${literal(f.courseLibraryCross)}::uuid;`) === '0');
    const libraryUpdate = await rest(boundary, anonKey, entity.token, 'training_library', 'PATCH', `?id=eq.${f.libraryA}`, { content: 'content A v2' });
    check('D09-P1-LIBRARY-04 合法快照不随 library 后续更新变化', success(libraryUpdate)
      && runPsql(boundary.databaseUrl, `SELECT content FROM public.training_courses WHERE id=${literal(f.courseLibraryA)}::uuid;`) === 'content A v1');

    const deptCompanyInsert = await rest(boundary, anonKey, entity.token, 'training_plans', 'POST', '', {
      id: f.planEscalate, title: '[D09-P1] illegal company', level: 'company', department_id: null, plan_year: 2026,
    });
    const ownPlan = await rest(boundary, anonKey, entity.token, 'training_plans', 'POST', '', {
      id: f.planOwn, title: '[D09-P1] own dept', level: 'entity', department_id: scope.dept_a, plan_year: 2026,
    });
    const elevate = await rest(boundary, anonKey, entity.token, 'training_plans', 'PATCH', `?id=eq.${f.planOwn}`, {
      level: 'company', department_id: null,
    });
    const crossPlan = await rest(boundary, anonKey, entity.token, 'training_plans', 'PATCH', `?id=eq.${f.planB}`, { title: '[D09-P1] cross changed' });
    check('D09-P1-PLAN-01 dept admin 不能创建 company draft', denied(deptCompanyInsert));
    check('D09-P1-PLAN-02 dept admin 可以创建本部门 draft', success(ownPlan));
    check('D09-P1-PLAN-03 dept draft 不能提升为 company', blockedMutation(elevate));
    check('D09-P1-PLAN-04 dept admin 不能修改其他部门 plan', blockedMutation(crossPlan));
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='admin',admin_level='company',department_id=${literal(scope.dept_a)}::uuid,employee_id=${literal(f.employeeA)}::uuid WHERE id=${literal(scope.entity_user)}::uuid;`);
    const companyPlan = await rest(boundary, anonKey, entity.token, 'training_plans', 'POST', '', {
      id: f.planCompany, title: '[D09-P1] company legal', level: 'company', department_id: null, plan_year: 2026,
    });
    check('D09-P1-PLAN-05 company admin 可以创建 company draft', success(companyPlan));
    const companyLibrary = await rest(boundary, anonKey, entity.token, 'training_courses', 'POST', '', {
      id: f.courseLibraryCompany, plan_id: f.planCompany, title: 'company library', course_type: 'text', library_id: f.libraryB,
    });
    check('D09-P1-LIBRARY-05 company admin 可按批准范围快照资源', success(companyLibrary));
  } finally {
    cleanupBusiness(boundary.databaseUrl, f, scope);
    runPsql(boundary.databaseUrl, `UPDATE storage.objects SET owner=${literal(scope.entity_user)}::uuid,owner_id=${literal(scope.entity_user)} WHERE bucket_id='training-courses' AND name LIKE ${literal(`d09-p1/${suffix}/%`)};`);
    for (const storagePath of paths) {
      await storageDelete(boundary, anonKey, entity.token, storagePath);
    }
    residue = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT
      (SELECT count(*) FROM public.training_plans WHERE title LIKE '[D09-P1]%')
      + (SELECT count(*) FROM public.training_courses WHERE id IN (${[f.courseA, f.courseB, f.courseFormal, f.courseLibraryA, f.courseLibraryCross, f.courseLibraryEmployee, f.courseLibraryCompany].map(x => `${literal(x)}::uuid`).join(',')}))
      + (SELECT count(*) FROM public.training_library WHERE id IN (${literal(f.libraryA)}::uuid,${literal(f.libraryB)}::uuid))
      + (SELECT count(*) FROM public.training_employees WHERE remark='D09-P1 TEST')
      + (SELECT count(*) FROM storage.objects WHERE bucket_id='training-courses' AND name LIKE ${literal(`d09-p1/${suffix}/%`)});`), 10);
  }
  check('D09-P1-RESIDUE 测试残留为 0 且账号角色已恢复', residue === 0
    && readScope(boundary.databaseUrl).company_profile.admin_level === scope.company_profile.admin_level
    && readScope(boundary.databaseUrl).entity_profile.admin_level === scope.entity_profile.admin_level);
  finish(started, residue);
}

function finish(started, residue) {
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D09_P1_BOUNDARY_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

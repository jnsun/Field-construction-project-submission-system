/** D09-1 v77 focused: Storage paths must be authorized before course/library binding. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrations = [75, 76, 77, 80].map(version => path.join(root, 'sql',
  version === 75 ? 'training-admission-v75-history-content-boundary.sql'
    : version === 76 ? 'training-admission-v76-d09-p1-permission-boundaries.sql'
      : version === 77 ? 'training-admission-v77-storage-binding-boundary.sql'
        : 'training-admission-v80-d09-r02-p1-closure.sql'));
const reproduce = process.argv.includes('--reproduce-v76');
const diagnosePlan = process.argv.includes('--diagnose-plan');
const results = [];

function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}
function success(response) { return response.status >= 200 && response.status < 300; }
function denied(response) { return [400, 401, 403, 404, 409].includes(response.status); }

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`D09 v77 数据库操作失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function applyMigrations(databaseUrl) {
  const files = reproduce ? migrations.slice(0, 2) : migrations;
  for (const file of files) {
    const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error || result.status !== 0) throw new Error(`迁移应用失败：${path.basename(file)}`);
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
    throw new Error('D09 v77 临时测试账号登录失败');
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
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain', 'x-upsert': String(upsert) },
      body: Buffer.from(content),
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

function fingerprint(databaseUrl, storagePath) {
  return runPsql(databaseUrl, `SELECT COALESCE(id::text||'|'||updated_at::text||'|'||metadata::text,'')
    FROM storage.objects WHERE bucket_id='training-courses' AND name=${literal(storagePath)};`);
}

function createUsers(databaseUrl, fixture) {
  runPsql(databaseUrl, `
    BEGIN;
    SET LOCAL app.safety_test_confirmation='D02_TEST_ONLY';
    INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
      confirmation_token,recovery_token,email_change,email_change_token_new,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES
      ('00000000-0000-0000-0000-000000000000',${literal(fixture.userA)}::uuid,'authenticated','authenticated',${literal(fixture.emailA)},crypt(${literal(fixture.passwordA)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()),
      ('00000000-0000-0000-0000-000000000000',${literal(fixture.userB)}::uuid,'authenticated','authenticated',${literal(fixture.emailB)},crypt(${literal(fixture.passwordB)},gen_salt('bf',10)),now(),'','','','','{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now());
    UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(fixture.deptA)}::uuid
      WHERE id=${literal(fixture.userA)}::uuid;
    UPDATE public.profiles SET role='admin',admin_level='dept',department_id=${literal(fixture.deptB)}::uuid
      WHERE id=${literal(fixture.userB)}::uuid;
    COMMIT;
  `);
}

function cleanupRows(databaseUrl, fixture) {
  runPsql(databaseUrl, `
    BEGIN;
    SET LOCAL session_replication_role=replica;
    DELETE FROM public.training_courses WHERE id IN (${fixture.courseIds.map(id => `${literal(id)}::uuid`).join(',')});
    DELETE FROM public.training_library WHERE id IN (${fixture.libraryIds.map(id => `${literal(id)}::uuid`).join(',')});
    DELETE FROM public.training_plans WHERE id IN (${fixture.planIds.map(id => `${literal(id)}::uuid`).join(',')});
    COMMIT;
  `);
}

function deleteUsers(databaseUrl, fixture) {
  runPsql(databaseUrl, `DELETE FROM auth.users WHERE id IN (${literal(fixture.userA)}::uuid,${literal(fixture.userB)}::uuid);`);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  check('D09-V77-GATE 隔离测试边界与 D02 夹具', assertD02FixtureMarker(boundary) > 0);
  if (!reproduce) {
    const source = fs.readFileSync(migrations[2], 'utf8');
    check('D09-V77-STATIC 单一绑定 helper、双表 BEFORE guard、最小授权',
      source.includes('training_course_file_can_bind')
      && source.includes('trg_training_course_storage_binding_guard')
      && source.includes('trg_training_library_storage_binding_guard')
      && /SECURITY DEFINER SET search_path = public/g.test(source)
      && /REVOKE ALL ON FUNCTION public\.training_course_file_can_bind\(TEXT\)[\s\S]*FROM PUBLIC, anon, authenticated/i.test(source));
  }
  applyMigrations(boundary.databaseUrl);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const id = () => crypto.randomUUID();
  const fixture = {
    suffix, userA: id(), userB: id(), passwordA: crypto.randomBytes(18).toString('base64url'),
    passwordB: crypto.randomBytes(18).toString('base64url'),
    emailA: `d09-v77-a-${suffix}@example.invalid`, emailB: `d09-v77-b-${suffix}@example.invalid`,
    deptA: runPsql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-A' LIMIT 1;"),
    deptB: runPsql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-B' LIMIT 1;"),
    planA: id(), planB: id(), planFormal: id(), courseA: id(), courseB: id(), courseFormal: id(),
    courseRebind: id(), courseMissing: id(), courseReuse: id(), courseFormalReuse: id(), courseSnapshotCross: id(),
    libraryA: id(), libraryB: id(), libraryRebind: id(),
    pathA: `d09-v77/${suffix}/a-course.txt`, pathB: `d09-v77/${suffix}/b-course.txt`,
    pathBTemp: `d09-v77/${suffix}/b-temp.txt`, pathALibrary: `d09-v77/${suffix}/a-library.txt`,
    pathBLibrary: `d09-v77/${suffix}/b-library.txt`, pathFormal: `d09-v77/${suffix}/b-formal.txt`,
    pathMissing: `d09-v77/${suffix}/missing.txt`,
  };
  fixture.planIds = [fixture.planA, fixture.planB, fixture.planFormal];
  fixture.courseIds = [fixture.courseA, fixture.courseB, fixture.courseFormal, fixture.courseRebind,
    fixture.courseMissing, fixture.courseReuse, fixture.courseFormalReuse, fixture.courseSnapshotCross];
  fixture.libraryIds = [fixture.libraryA, fixture.libraryB, fixture.libraryRebind];
  const ownerAPaths = [fixture.pathA, fixture.pathALibrary];
  const ownerBPaths = [fixture.pathB, fixture.pathBTemp, fixture.pathBLibrary, fixture.pathFormal];
  let userA; let userB; let rowsCleaned = false; let storageCleaned = false; let residue = -1;

  try {
    createUsers(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    [userA, userB] = await Promise.all([
      login(boundary.apiOrigin, anonKey, fixture.emailA, fixture.passwordA),
      login(boundary.apiOrigin, anonKey, fixture.emailB, fixture.passwordB),
    ]);
    check('D09-V77-AUTH 两个独立 Auth 用户和真实 JWT', userA.userId === fixture.userA
      && userB.userId === fixture.userB && userA.userId !== userB.userId);

    const plans = await Promise.all([
      rest(boundary, anonKey, userA.token, 'training_plans', 'POST', '', { id: fixture.planA, title: `[D09-V77] A ${suffix}`, level: 'entity', department_id: fixture.deptA, plan_year: 2026 }),
      rest(boundary, anonKey, userB.token, 'training_plans', 'POST', '', { id: fixture.planB, title: `[D09-V77] B ${suffix}`, level: 'entity', department_id: fixture.deptB, plan_year: 2026 }),
      rest(boundary, anonKey, userB.token, 'training_plans', 'POST', '', { id: fixture.planFormal, title: `[D09-V77] formal ${suffix}`, level: 'entity', department_id: fixture.deptB, plan_year: 2026 }),
    ]);
    check('D09-V77-SETUP A/B 真实 JWT 创建各自草稿计划', plans.every(success),
      plans.every(success) ? '' : JSON.stringify(plans.map(item => ({ status: item.status, error: item.json?.message || item.json?.code || '' }))));
    if (diagnosePlan) return;

    const uploads = await Promise.all([
      ...ownerAPaths.map(p => storageUpload(boundary, anonKey, userA.token, p, `owner A ${p}`)),
      ...ownerBPaths.map(p => storageUpload(boundary, anonKey, userB.token, p, `owner B ${p}`)),
    ]);
    check('D09-V77-OWNER Storage API 产生真实且不同 owner', uploads.every(success)
      && runPsql(boundary.databaseUrl, `SELECT count(*) FROM storage.objects WHERE bucket_id='training-courses'
        AND ((name IN (${ownerAPaths.map(literal).join(',')}) AND owner=${literal(fixture.userA)}::uuid)
          OR (name IN (${ownerBPaths.map(literal).join(',')}) AND owner=${literal(fixture.userB)}::uuid));`) === String(ownerAPaths.length + ownerBPaths.length));

    const ownCourse = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseA, plan_id: fixture.planA, title: 'A own', course_type: 'text', file_path: fixture.pathA,
    });
    const bCourse = await rest(boundary, anonKey, userB.token, 'training_courses', 'POST', '', {
      id: fixture.courseB, plan_id: fixture.planB, title: 'B own', course_type: 'text', file_path: fixture.pathB,
    });
    const formalCourse = await rest(boundary, anonKey, userB.token, 'training_courses', 'POST', '', {
      id: fixture.courseFormal, plan_id: fixture.planFormal, title: 'B formal', course_type: 'text', file_path: fixture.pathFormal,
    });
    const ownLibrary = await rest(boundary, anonKey, userA.token, 'training_library', 'POST', '', {
      id: fixture.libraryA, title: 'A library', course_type: 'article', scope: 'dept', department_id: fixture.deptA,
      storage_path: fixture.pathALibrary, content: 'A content', status: 'published',
    });
    const bLibrary = await rest(boundary, anonKey, userB.token, 'training_library', 'POST', '', {
      id: fixture.libraryB, title: 'B library', course_type: 'article', scope: 'dept', department_id: fixture.deptB,
      storage_path: fixture.pathBLibrary, content: 'B private', status: 'published',
    });
    check('D09-V77-BIND-OWN owner 首次绑定本人 course/library',
      [ownCourse, bCourse, formalCourse, ownLibrary, bLibrary].every(success));

    if (reproduce) {
      const forged = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
        id: fixture.courseRebind, plan_id: fixture.planA, title: 'forged B path', course_type: 'text', file_path: fixture.pathB,
      });
      const before = fingerprint(boundary.databaseUrl, fixture.pathB);
      const read = await storageSign(boundary, anonKey, userA.token, fixture.pathB);
      const overwrite = await storageUpload(boundary, anonKey, userA.token, fixture.pathB, 'forged overwrite', true);
      check('D09-V77-REPRO v76 允许跨部门 path 重绑定', success(forged));
      check('D09-V77-REPRO 伪造关联随后放行 read/manage', success(read) && success(overwrite)
        && fingerprint(boundary.databaseUrl, fixture.pathB) !== before);
      return;
    }

    runPsql(boundary.databaseUrl, `BEGIN; SELECT set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
      UPDATE public.training_plans SET approval_status='approved',publish_status='published',approved_at=now(),published_at=now()
      WHERE id=${literal(fixture.planFormal)}::uuid; COMMIT;`);

    const forgedCourse = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseRebind, plan_id: fixture.planA, title: 'forged B path', course_type: 'text', file_path: fixture.pathB,
    });
    const foreignOwnerTemp = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseMissing, plan_id: fixture.planA, title: 'B owner temp', course_type: 'text', file_path: fixture.pathBTemp,
    });
    check('D09-V77-COURSE dept A 不能绑定 dept B 已关联或未关联 owner 文件',
      denied(forgedCourse) && denied(foreignOwnerTemp));

    const missing = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseMissing, plan_id: fixture.planA, title: 'missing', course_type: 'text', file_path: fixture.pathMissing,
    });
    check('D09-V77-COURSE 不存在的 Storage object 拒绝且无残留', denied(missing)
      && runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.training_courses WHERE id IN (${literal(fixture.courseRebind)}::uuid,${literal(fixture.courseMissing)}::uuid);`) === '0');

    const forgedLibrary = await rest(boundary, anonKey, userA.token, 'training_library', 'POST', '', {
      id: fixture.libraryRebind, title: 'forged B library', course_type: 'article', scope: 'dept', department_id: fixture.deptA,
      storage_path: fixture.pathBLibrary, status: 'published',
    });
    check('D09-V77-LIBRARY dept A 不能把 dept B path 绑定到本部门 library', denied(forgedLibrary)
      && runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.training_library WHERE id=${literal(fixture.libraryRebind)}::uuid;`) === '0');

    const beforeB = fingerprint(boundary.databaseUrl, fixture.pathB);
    const crossRead = await storageSign(boundary, anonKey, userA.token, fixture.pathB);
    const crossOverwrite = await storageUpload(boundary, anonKey, userA.token, fixture.pathB, 'blocked overwrite', true);
    const crossDelete = await storageDelete(boundary, anonKey, userA.token, fixture.pathB);
    check('D09-V77-STORAGE 绑定失败后 A 仍不能 read/overwrite/delete B 文件', denied(crossRead)
      && denied(crossOverwrite) && (denied(crossDelete) || success(crossDelete))
      && fingerprint(boundary.databaseUrl, fixture.pathB) === beforeB);

    const reuse = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseReuse, plan_id: fixture.planA, title: 'A library reuse', course_type: 'text', library_id: fixture.libraryA,
    });
    const snapshotCross = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseSnapshotCross, plan_id: fixture.planA, title: 'B library cross', course_type: 'text', library_id: fixture.libraryB,
    });
    const formalReuse = await rest(boundary, anonKey, userB.token, 'training_courses', 'POST', '', {
      id: fixture.courseFormalReuse, plan_id: fixture.planB, title: 'formal path reuse', course_type: 'text', file_path: fixture.pathFormal,
    });
    check('D09-V77-REUSE 已有权限资源可复用，跨部门 library UUID 仍拒绝', success(reuse)
      && success(formalReuse) && denied(snapshotCross)
      && runPsql(boundary.databaseUrl, `SELECT count(*) FROM public.training_courses WHERE id=${literal(fixture.courseSnapshotCross)}::uuid;`) === '0');

    const formalBefore = fingerprint(boundary.databaseUrl, fixture.pathFormal);
    const formalOverwrite = await storageUpload(boundary, anonKey, userB.token, fixture.pathFormal, 'formal blocked', true);
    const formalDelete = await storageDelete(boundary, anonKey, userB.token, fixture.pathFormal);
    check('D09-V77-LOCK 合法复用不授予正式历史 overwrite/delete', denied(formalOverwrite)
      && (denied(formalDelete) || success(formalDelete)) && fingerprint(boundary.databaseUrl, fixture.pathFormal) === formalBefore);

    const draftBefore = fingerprint(boundary.databaseUrl, fixture.pathA);
    const draftOverwrite = await storageUpload(boundary, anonKey, userA.token, fixture.pathA, 'A draft updated', true);
    check('D09-V77-DRAFT owner 合法草稿文件仍可管理', success(draftOverwrite)
      && fingerprint(boundary.databaseUrl, fixture.pathA) !== draftBefore);

    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='employee',admin_level=NULL WHERE id=${literal(fixture.userA)}::uuid;`);
    const employeeBind = await rest(boundary, anonKey, userA.token, 'training_courses', 'POST', '', {
      id: fixture.courseMissing, plan_id: fixture.planA, title: 'employee path', course_type: 'text', file_path: fixture.pathB,
    });
    check('D09-V77-EMPLOYEE 普通 employee 知道 path 仍不能绑定', denied(employeeBind));
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET role='admin',admin_level='dept' WHERE id=${literal(fixture.userA)}::uuid;`);
  } finally {
    try {
      cleanupRows(boundary.databaseUrl, fixture);
      rowsCleaned = true;
      if (userA && userB) {
        const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
        for (const p of ownerAPaths) await storageDelete(boundary, anonKey, userA.token, p);
        for (const p of ownerBPaths) await storageDelete(boundary, anonKey, userB.token, p);
        storageCleaned = [...ownerAPaths, ...ownerBPaths].every(p => fingerprint(boundary.databaseUrl, p) === '');
      }
    } finally {
      deleteUsers(boundary.databaseUrl, fixture);
      residue = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT
        (SELECT count(*) FROM auth.users WHERE email IN (${literal(fixture.emailA)},${literal(fixture.emailB)}))
        + (SELECT count(*) FROM public.profiles WHERE id IN (${literal(fixture.userA)}::uuid,${literal(fixture.userB)}::uuid))
        + (SELECT count(*) FROM public.training_plans WHERE id IN (${fixture.planIds.map(id => `${literal(id)}::uuid`).join(',')}))
        + (SELECT count(*) FROM public.training_courses WHERE id IN (${fixture.courseIds.map(id => `${literal(id)}::uuid`).join(',')}))
        + (SELECT count(*) FROM public.training_library WHERE id IN (${fixture.libraryIds.map(id => `${literal(id)}::uuid`).join(',')}))
        + (SELECT count(*) FROM storage.objects WHERE bucket_id='training-courses' AND name LIKE ${literal(`d09-v77/${suffix}/%`)});`), 10);
    }
  }

  check('D09-V77-RESIDUE 夹具、Auth 用户和 Storage 残留为 0', rowsCleaned && storageCleaned && residue === 0);
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D09_STORAGE_BINDING_SUMMARY mode=${reproduce ? 'reproduce-v76' : 'v77'} total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

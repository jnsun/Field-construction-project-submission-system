/** D09-1 targeted: immutable training history, scoped content reads and safe files. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v75-history-content-boundary.sql');
const p1MigrationPath = path.join(root, 'sql', 'training-admission-v76-d09-p1-permission-boundaries.sql');
const currentMigrationPaths = [77, 78, 79, 80].map(version => path.join(root, 'sql', {
  77: 'training-admission-v77-storage-binding-boundary.sql',
  78: 'training-admission-v78-plan-scope-hours-targets.sql',
  79: 'training-admission-v79-plan-lifecycle-audit.sql',
  80: 'training-admission-v80-d09-r02-p1-closure.sql',
}[version]));
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const minePath = path.join(root, 'js', 'modules', 'training', 'mine.js');
const results = [];

function check(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
}

function sqlLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function runPsql(databaseUrl, args, input = null, allowFailure = false) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', ...args], {
    input, encoding: 'utf8', windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`D09-1 数据库检查失败${detail ? `：${detail}` : ''}`);
  }
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

function staticChecks() {
  const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const p1Migration = fs.readFileSync(p1MigrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mine = fs.readFileSync(minePath, 'utf8');
  const hash = crypto.createHash('sha256').update(migration).digest('hex').toUpperCase();
  const v75 = manifest.migrations.find(x => x.version === 75);
  const v76 = manifest.migrations.find(x => x.version === 76);
  check('D09-STATIC-01 v75 已登记且哈希匹配', !!v75 && v75.sha256 === hash);
  check('D09-STATIC-01A v76 已登记且包含三个 P1 边界', !!v76
    && v76.sha256 === crypto.createHash('sha256').update(p1Migration).digest('hex').toUpperCase()
    && p1Migration.includes('training_plan_row_can_write')
    && p1Migration.includes('training_library_can_read')
    && p1Migration.includes('training_course_file_owned_unlinked'));
  check('D09-STATIC-02 plan/course/history guard 已定义',
    migration.includes('trg_training_plan_history_guard')
      && migration.includes('training_course_version_guard()')
      && migration.includes('training_plan_has_history'));
  check('D09-STATIC-03 学员读取要求 published + assignment',
    migration.includes("p.publish_status = 'published'") && migration.includes('FROM public.training_assignments a'));
  check('D09-STATIC-04 Storage UPDATE/DELETE 使用业务锁定函数',
    migration.includes('training_course_file_can_manage(name)')
      && migration.includes('training_course_file_is_locked'));
  check('D09-STATIC-05 外链只接受 HTTPS',
    migration.includes('training_courses_file_url_https')
      && migration.includes('training_library_file_url_https'));
  check('D09-STATIC-06 text 使用 textContent 且 HTML 路径保留',
    mine.includes("body.textContent = c.content || '';")
      && !mine.includes("${(c.content || '').replace(/\\n/g, '<br>')}")
      && mine.includes("else if (c.course_type === 'html') await this.renderHtml"));

  const body = { textContent: '', addEventListener() {} };
  const stage = { innerHTML: '' };
  const context = {
    Utils: { escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') },
    document: { getElementById: id => id === 'text-body' ? body : null },
  };
  vm.runInNewContext(`${mine}\n;globalThis.__TrainingMine = TrainingMine;`, context);
  const attack = '<script>globalThis.__xss=1</script><img src=x onerror="globalThis.__xss=2">';
  context.__TrainingMine.renderText(stage, { id: 'x', title: '安全文本', content: attack }, {});
  check('D09-STATIC-07 text 恶意标签仅进入 textContent',
    body.textContent === attack && !stage.innerHTML.includes('<script>') && !stage.innerHTML.includes('<img src=x'));
}

const matrixSql = actorEmail => String.raw`
BEGIN;
SET LOCAL app.safety_test_confirmation = 'D02_TEST_ONLY';

CREATE OR REPLACE FUNCTION pg_temp.assert_ok(p_ok BOOLEAN, p_message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT COALESCE(p_ok, FALSE) THEN RAISE EXCEPTION 'D09_ASSERT: %', p_message; END IF;
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql TEXT, p_state TEXT, p_message TEXT)
RETURNS VOID LANGUAGE plpgsql AS $f$
DECLARE v_state TEXT; v_message TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    IF v_state = p_state AND (p_message IS NULL OR position(p_message IN v_message) > 0) THEN RETURN; END IF;
    RAISE EXCEPTION 'D09_WRONG_ERROR state=% message=%', v_state, v_message;
  END;
  RAISE EXCEPTION 'D09_EXPECTED_ERROR_MISSING: %', p_sql;
END $f$;

SELECT p.id AS actor_id, p.department_id AS dept_id
FROM public.profiles p JOIN auth.users u ON u.id = p.id
WHERE u.email = ${sqlLiteral(actorEmail)} AND p.role = 'admin' AND p.admin_level = 'dept' \gset
SELECT p.id AS employee_user_id, p.employee_id AS employee_id
FROM public.profiles p
WHERE p.role = 'employee' AND p.department_id = :'dept_id'::UUID AND p.employee_id IS NOT NULL
ORDER BY p.id LIMIT 1 \gset
SELECT set_config('request.jwt.claim.sub', :'actor_id', TRUE) AS ignored \gset

INSERT INTO public.training_plans(id,title,level,department_id,plan_year,hours,required_hours,created_by)
VALUES
 ('75000000-0000-4000-8000-000000000001','[D09-TEST] draft','entity',:'dept_id',2026,1,0.5,:'actor_id'),
 ('75000000-0000-4000-8000-000000000002','[D09-TEST] lifecycle','entity',:'dept_id',2026,1,0.5,:'actor_id'),
 ('75000000-0000-4000-8000-000000000003','[D09-TEST] history','entity',:'dept_id',2026,1,0.5,:'actor_id'),
 ('75000000-0000-4000-8000-000000000004','[D09-TEST] library','entity',:'dept_id',2026,1,0.5,:'actor_id'),
 ('75000000-0000-4000-8000-000000000005','[D09-TEST] company-unpublished','company',NULL,2026,1,0.5,:'actor_id');

INSERT INTO storage.objects(id,bucket_id,name,owner) VALUES
 ('75000000-0000-4000-8000-000000000201','training-courses','d09/draft.txt',:'actor_id'),
 ('75000000-0000-4000-8000-000000000202','training-courses','d09/formal.pdf',:'actor_id'),
 ('75000000-0000-4000-8000-000000000203','training-courses','d09/company.txt',:'actor_id'),
 ('75000000-0000-4000-8000-000000000204','training-courses','d09/library-v1.txt',:'actor_id'),
 ('75000000-0000-4000-8000-000000000205','training-courses','d09/library-v2.txt',:'actor_id'),
 ('75000000-0000-4000-8000-000000000206','training-courses','d09/a.pdf',:'actor_id'),
 ('75000000-0000-4000-8000-000000000207','training-courses','d09/a.mp4',:'actor_id'),
 ('75000000-0000-4000-8000-000000000208','training-courses','d09/a.png',:'actor_id'),
 ('75000000-0000-4000-8000-000000000209','training-courses','d09/a.html',:'actor_id');

INSERT INTO public.training_courses(id,plan_id,title,course_type,file_path,content)
VALUES
 ('75000000-0000-4000-8000-000000000101','75000000-0000-4000-8000-000000000001','draft course','text','d09/draft.txt','draft'),
 ('75000000-0000-4000-8000-000000000102','75000000-0000-4000-8000-000000000002','lifecycle course','pdf','d09/formal.pdf',NULL),
 ('75000000-0000-4000-8000-000000000103','75000000-0000-4000-8000-000000000003','history course','text',NULL,'history'),
 ('75000000-0000-4000-8000-000000000105','75000000-0000-4000-8000-000000000005','company draft','text','d09/company.txt','not published');

INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
VALUES ('75000000-0000-4000-8000-000000000003',:'employee_id',:'employee_user_id',:'dept_id');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'actor_id', TRUE) AS ignored \gset

UPDATE public.training_plans SET title='[D09-TEST] draft edited' WHERE id='75000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_ok((SELECT title LIKE '%edited' FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000001'),'draft plan edit');
SELECT pg_temp.expect_error($q$UPDATE public.training_plans SET approval_status='approved' WHERE id='75000000-0000-4000-8000-000000000001'$q$,'P0001','受控流程');
UPDATE public.training_courses SET title='draft course edited' WHERE id='75000000-0000-4000-8000-000000000101';
SELECT pg_temp.assert_ok((SELECT title='draft course edited' FROM public.training_courses WHERE id='75000000-0000-4000-8000-000000000101'),'draft course edit');

INSERT INTO public.training_courses(id,plan_id,title,course_type,file_url)
VALUES ('75000000-0000-4000-8000-000000000110','75000000-0000-4000-8000-000000000001','https link','link','https://example.invalid/course');
SELECT pg_temp.expect_error($q$INSERT INTO public.training_courses(id,plan_id,title,course_type,file_url) VALUES ('75000000-0000-4000-8000-000000000111','75000000-0000-4000-8000-000000000001','bad js','link','javascript:alert(1)')$q$,'23514','training_courses_file_url_https');
SELECT pg_temp.expect_error($q$INSERT INTO public.training_courses(id,plan_id,title,course_type,file_url) VALUES ('75000000-0000-4000-8000-000000000112','75000000-0000-4000-8000-000000000001','bad data','link','data:text/html,bad')$q$,'23514','training_courses_file_url_https');
SELECT pg_temp.expect_error($q$INSERT INTO public.training_courses(id,plan_id,title,course_type,file_url) VALUES ('75000000-0000-4000-8000-000000000113','75000000-0000-4000-8000-000000000001','bad file','link','file:///tmp/bad')$q$,'23514','training_courses_file_url_https');

SELECT public.training_request_plan_approval('75000000-0000-4000-8000-000000000002');
SELECT set_config('app.training_lifecycle_write','',TRUE) AS ignored \gset
SELECT pg_temp.assert_ok((SELECT approval_status='pending_review' FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000002'),'request approval RPC');
SELECT pg_temp.expect_error($q$UPDATE public.training_plans SET title='tampered pending' WHERE id='75000000-0000-4000-8000-000000000002'$q$,'P0001','不可直接修改');
SELECT pg_temp.expect_error($q$UPDATE public.training_courses SET title='tampered pending' WHERE id='75000000-0000-4000-8000-000000000102'$q$,'P0001','不可修改或删除');
SELECT pg_temp.expect_error($q$UPDATE public.training_courses SET plan_id='75000000-0000-4000-8000-000000000001' WHERE id='75000000-0000-4000-8000-000000000102'$q$,'P0001','不可修改或删除');

SELECT public.training_approve_plan('75000000-0000-4000-8000-000000000002',TRUE,'D09 test');
SELECT set_config('app.training_lifecycle_write','',TRUE) AS ignored \gset
SELECT pg_temp.assert_ok((SELECT approval_status='approved' FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000002'),'approve RPC');
SELECT pg_temp.expect_error($q$UPDATE public.training_plans SET title='tampered approved' WHERE id='75000000-0000-4000-8000-000000000002'$q$,'P0001','不可直接修改');
SELECT pg_temp.expect_error($q$UPDATE public.training_courses SET title='tampered approved' WHERE id='75000000-0000-4000-8000-000000000102'$q$,'P0001','不可修改或删除');

DO $d$
DECLARE v_rows BIGINT;
BEGIN
  -- Supabase Storage API 在删除事务中设置此标记；直接 SQL 默认被平台语句触发器拒绝。
  PERFORM set_config('storage.allow_delete_query','true',TRUE);
  UPDATE storage.objects SET metadata='{"d09":"blocked"}'::jsonb WHERE bucket_id='training-courses' AND name='d09/formal.pdf';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'formal storage overwrite allowed'; END IF;
  DELETE FROM storage.objects WHERE bucket_id='training-courses' AND name='d09/formal.pdf';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'formal storage delete allowed'; END IF;
  UPDATE storage.objects SET metadata='{"d09":"draft"}'::jsonb WHERE bucket_id='training-courses' AND name='d09/draft.txt';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'draft storage update blocked'; END IF;
  DELETE FROM storage.objects WHERE bucket_id='training-courses' AND name='d09/draft.txt';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'draft storage delete blocked'; END IF;
END $d$;

SELECT public.training_publish_plan('75000000-0000-4000-8000-000000000002','D09 publish test');
SELECT set_config('app.training_lifecycle_write','',TRUE) AS ignored \gset
SELECT pg_temp.assert_ok((SELECT publish_status='published' FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000002'),'publish RPC');
SELECT pg_temp.expect_error($q$UPDATE public.training_plans SET title='tampered published' WHERE id='75000000-0000-4000-8000-000000000002'$q$,'P0001','不可直接修改');
SELECT pg_temp.expect_error($q$UPDATE public.training_courses SET title='tampered published' WHERE id='75000000-0000-4000-8000-000000000102'$q$,'P0001','不可修改或删除');
SELECT pg_temp.expect_error($q$DELETE FROM public.training_courses WHERE id='75000000-0000-4000-8000-000000000102'$q$,'P0001','不可修改或删除');
SELECT pg_temp.expect_error($q$DELETE FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000002'$q$,'P0001','不可删除');
SELECT pg_temp.expect_error($q$UPDATE public.training_courses SET title='tampered history' WHERE id='75000000-0000-4000-8000-000000000103'$q$,'P0001','形成培训历史');
SELECT pg_temp.expect_error($q$DELETE FROM public.training_courses WHERE id='75000000-0000-4000-8000-000000000103'$q$,'P0001','形成培训历史');
SELECT pg_temp.expect_error($q$DELETE FROM public.training_plans WHERE id='75000000-0000-4000-8000-000000000003'$q$,'P0001','形成培训历史');

INSERT INTO public.training_library(id,title,course_type,scope,department_id,storage_path,content,status)
VALUES ('75000000-0000-4000-8000-000000000301','library v1','article','dept',:'dept_id','d09/library-v1.txt','content v1','published');
INSERT INTO public.training_courses(id,plan_id,title,course_type,library_id)
VALUES ('75000000-0000-4000-8000-000000000104','75000000-0000-4000-8000-000000000004','snapshot one','text','75000000-0000-4000-8000-000000000301');
UPDATE public.training_library SET storage_path='d09/library-v2.txt',content='content v2' WHERE id='75000000-0000-4000-8000-000000000301';
SELECT pg_temp.assert_ok((SELECT file_path='d09/library-v1.txt' AND content='content v1' FROM public.training_courses WHERE id='75000000-0000-4000-8000-000000000104'),'library old snapshot immutable');
INSERT INTO public.training_courses(id,plan_id,title,course_type,library_id)
VALUES ('75000000-0000-4000-8000-000000000106','75000000-0000-4000-8000-000000000004','snapshot two','text','75000000-0000-4000-8000-000000000301');
SELECT pg_temp.assert_ok((SELECT file_path='d09/library-v2.txt' AND content='content v2' FROM public.training_courses WHERE id='75000000-0000-4000-8000-000000000106'),'library new snapshot current');
SELECT pg_temp.expect_error(
  format($q$INSERT INTO public.training_library(id,title,course_type,scope,department_id,file_url) VALUES ('75000000-0000-4000-8000-000000000302','bad library','article','dept',%L,'data:text/html,bad')$q$, :'dept_id'),
  '23514','training_library_file_url_https');

INSERT INTO public.training_courses(id,plan_id,title,course_type,file_path) VALUES
 ('75000000-0000-4000-8000-000000000120','75000000-0000-4000-8000-000000000004','pdf ok','pdf','d09/a.pdf'),
 ('75000000-0000-4000-8000-000000000121','75000000-0000-4000-8000-000000000004','video ok','video','d09/a.mp4'),
 ('75000000-0000-4000-8000-000000000122','75000000-0000-4000-8000-000000000004','image ok','image','d09/a.png'),
 ('75000000-0000-4000-8000-000000000123','75000000-0000-4000-8000-000000000004','html ok','html','d09/a.html');

SELECT pg_temp.assert_ok(public.training_can_read_course('75000000-0000-4000-8000-000000000002'),'admin management read');
SELECT pg_temp.assert_ok(public.training_course_file_can_read('d09/formal.pdf'),'admin storage read');

SELECT set_config('request.jwt.claim.sub', :'employee_user_id', TRUE) AS ignored \gset
SELECT pg_temp.assert_ok(NOT public.training_can_read_course('75000000-0000-4000-8000-000000000005'),'employee unpublished company denied');
SELECT pg_temp.assert_ok(public.training_can_read_course('75000000-0000-4000-8000-000000000002'),'employee published assignment read');
SELECT pg_temp.assert_ok((SELECT count(*)=1 FROM public.training_courses WHERE id IN ('75000000-0000-4000-8000-000000000102','75000000-0000-4000-8000-000000000105')),'course RLS assignment scope');
SELECT pg_temp.assert_ok((SELECT count(*)=0 FROM public.training_library WHERE id='75000000-0000-4000-8000-000000000301'),'employee library body denied');
SELECT pg_temp.assert_ok(public.training_course_file_can_read('d09/formal.pdf'),'employee published file read');
SELECT pg_temp.assert_ok(NOT public.training_course_file_can_read('d09/company.txt'),'employee unpublished file denied');

SELECT set_config('request.jwt.claim.sub','75000000-0000-4000-8000-000000000999',TRUE) AS ignored \gset
SELECT pg_temp.assert_ok(NOT public.training_can_read_course('75000000-0000-4000-8000-000000000002'),'unassigned course denied');
SELECT pg_temp.assert_ok(NOT public.training_course_file_can_read('d09/formal.pdf'),'unassigned file denied');

RESET ROLE;
ROLLBACK;

SELECT json_build_object(
 'plan_residue',(SELECT count(*) FROM public.training_plans WHERE title LIKE '[D09-TEST]%'),
 'course_residue',(SELECT count(*) FROM public.training_courses WHERE id::text LIKE '75000000-%'),
 'library_residue',(SELECT count(*) FROM public.training_library WHERE id::text LIKE '75000000-%'),
 'storage_residue',(SELECT count(*) FROM storage.objects WHERE bucket_id='training-courses' AND name LIKE 'd09/%')
);
`;

function main() {
  const started = process.hrtime.bigint();
  staticChecks();
  if (process.env.D09_STATIC_ONLY === '1') {
    const failed = results.filter(x => !x.pass);
    console.log(`D09_HISTORY_CONTENT_STATIC_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
    if (failed.length) process.exitCode = 1;
    return;
  }
  const boundary = validateTestBoundary();
  assertD02FixtureMarker(boundary);
  runPsql(boundary.databaseUrl, ['-f', migrationPath]);
  runPsql(boundary.databaseUrl, ['-f', p1MigrationPath]);
  currentMigrationPaths.forEach(file => runPsql(boundary.databaseUrl, ['-f', file]));
  check('D09-DB-01 v75-v80 可连续应用', true);
  const matrix = runPsql(boundary.databaseUrl, [], matrixSql(required('SAFETY_TEST_ENTITY_EMAIL')));
  const summary = JSON.parse(matrix.stdout.split(/\r?\n/).filter(Boolean).at(-1));
  check('D09-DB-02 plan/course/RPC/library/read/Storage 矩阵', true);
  check('D09-DB-03 测试残留为 0', Object.values(summary).every(Number.isInteger) && Object.values(summary).every(x => x === 0));
  const failed = results.filter(x => !x.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D09_HISTORY_CONTENT_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

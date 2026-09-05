/** D06 targeted regression: project and initial entities are created atomically. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D06 隔离测试库操作失败');
  return String(result.stdout || '').trim();
}

async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token) throw new Error('D06 隔离测试账号登录失败');
  return response.json.access_token;
}

function projectRow(response) {
  if (response.status !== 200) return null;
  const value = Array.isArray(response.json) ? response.json[0] : response.json;
  return value && /^[0-9a-f-]{36}$/i.test(String(value.id || '')) ? value : null;
}

function isDenied(response) {
  return (response.status === 400 || response.status === 403)
    && ['42501', 'P0001'].includes(String(response.json?.code || ''));
}

function verifySourceBoundary() {
  const migrationPath = path.join(root, 'sql', 'training-admission-v55-atomic-project-create.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const web = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'projects.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(migration).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 55);
  return /CREATE FUNCTION public\.site_project_create\([\s\S]*p_entity_ids UUID\[\] DEFAULT NULL/i.test(migration)
    && /INSERT INTO public\.site_projects[\s\S]*INSERT INTO public\.site_project_entities/i.test(migration)
    && /SELECT DISTINCT entity_id[\s\S]*unnest\(COALESCE\(p_entity_ids/i.test(migration)
    && /p_entity_ids: entityIds/i.test(web)
    && /if \(id\) \{[\s\S]*sb\.rpc\('site_project_set_entities'/i.test(web)
    && entry?.file === 'training-admission-v55-atomic-project-create.sql'
    && entry.sha256 === digest;
}

async function createProject(baseUrl, anonKey, token, body) {
  return request(baseUrl, anonKey, '/rest/v1/rpc/site_project_create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function relationCounts(databaseUrl, projectId) {
  return JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'rows', count(*),
    'distinct_entities', count(DISTINCT entity_id),
    'lead_rows', count(*) FILTER (WHERE is_lead)
  )::text FROM public.site_project_entities WHERE project_id=${sqlLiteral(projectId)}::uuid;`));
}

function projectCountByName(databaseUrl, name) {
  return Number.parseInt(runPsql(databaseUrl,
    `SELECT count(*) FROM public.site_projects WHERE name=${sqlLiteral(name)};`), 10);
}

function cleanupFixture(databaseUrl, prefix) {
  const like = `${prefix}%`;
  const sql = `
BEGIN;
CREATE TEMP TABLE d06_atomic_targets ON COMMIT DROP AS
SELECT id FROM public.site_projects WHERE name LIKE ${sqlLiteral(like)};
DELETE FROM public.site_project_audit_logs
WHERE project_id IN (SELECT id FROM d06_atomic_targets) OR entity_id IN (SELECT id FROM d06_atomic_targets);
DELETE FROM public.site_projects WHERE id IN (SELECT id FROM d06_atomic_targets);
DELETE FROM public.site_project_audit_logs
WHERE entity_id IN (SELECT id FROM d06_atomic_targets) OR detail::text LIKE ${sqlLiteral(`%${prefix}%`)};
COMMIT;
SELECT (
  (SELECT count(*) FROM public.site_projects WHERE name LIKE ${sqlLiteral(like)})
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE detail::text LIKE ${sqlLiteral(`%${prefix}%`)})
);`;
  return Number.parseInt(runPsql(databaseUrl, sql), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D06-ATOMIC-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D06-ATOMIC-00 v55 与 Web 单 RPC 调用一致', verifySourceBoundary());

  const entities = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
    'lead', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'participant', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'invalid', (SELECT id FROM public.departments WHERE code='D02-SAFE')
  )::text;`));
  if (!entities.lead || !entities.participant || !entities.invalid) throw new Error('D02 经营实体测试夹具不完整');

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const prefix = `[D06-ATOMIC] ${suffix}`;
  const names = {
    leadOnly: `${prefix} 仅主责`,
    multi: `${prefix} 多参与`,
    invalid: `${prefix} 关系失败`,
    unauthorized: `${prefix} 跨实体拒绝`,
  };
  const baseBody = name => ({
    p_name: name,
    p_project_type: 'D06 定向测试',
    p_location: 'D06 测试区',
    p_start_date: '2026-09-05',
    p_expected_end_date: '2026-09-06',
    p_lead_entity_id: entities.lead,
    p_report_notes: 'D06-TEST',
  });

  let residue = -1;
  try {
    const permissionState = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'rpc', has_function_privilege('authenticated', 'public.site_project_create(text,text,text,date,date,uuid,text,uuid[])', 'EXECUTE'),
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.site_project_entities'::regclass),
      'insert_policy', EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='site_project_entities' AND cmd='INSERT')
    )::text;`));
    check('D06-ATOMIC-01 新创建 RPC 可用且关系表仍由 RLS 封闭',
      permissionState.rpc === true && permissionState.rls === true && permissionState.insert_policy === false);

    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const adminToken = await login(
      boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD'),
    );
    const entityToken = await login(
      boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'),
    );

    const leadOnlyResponse = await createProject(boundary.apiOrigin, anonKey, adminToken, {
      ...baseBody(names.leadOnly), p_entity_ids: [entities.lead],
    });
    const leadOnly = projectRow(leadOnlyResponse);
    const leadOnlyCounts = leadOnly ? relationCounts(boundary.databaseUrl, leadOnly.id) : {};
    check('D06-ATOMIC-02 只含主责实体创建成功',
      !!leadOnly && leadOnlyCounts.rows === 1 && leadOnlyCounts.lead_rows === 1,
      `status=${leadOnlyResponse.status} relations=${leadOnlyCounts.rows ?? -1}`);

    const multiResponse = await createProject(boundary.apiOrigin, anonKey, adminToken, {
      ...baseBody(names.multi),
      p_entity_ids: [entities.lead, entities.participant, entities.lead, entities.participant],
    });
    const multi = projectRow(multiResponse);
    const multiCounts = multi ? relationCounts(boundary.databaseUrl, multi.id) : {};
    check('D06-ATOMIC-03 主责和多参与实体创建成功',
      !!multi && multiCounts.rows === 2 && multiCounts.lead_rows === 1,
      `status=${multiResponse.status} relations=${multiCounts.rows ?? -1}`);
    check('D06-ATOMIC-04 重复参与实体不会产生重复关系',
      !!multi && multiCounts.distinct_entities === 2 && multiCounts.rows === 2,
      `rows=${multiCounts.rows ?? -1} distinct=${multiCounts.distinct_entities ?? -1}`);

    const invalidResponse = await createProject(boundary.apiOrigin, anonKey, adminToken, {
      ...baseBody(names.invalid), p_entity_ids: [entities.lead, entities.invalid],
    });
    const invalidCount = projectCountByName(boundary.databaseUrl, names.invalid);
    check('D06-ATOMIC-05 参与实体错误时整个项目创建回滚',
      isDenied(invalidResponse) && invalidCount === 0,
      `status=${invalidResponse.status} code=${invalidResponse.json?.code || 'none'} projects=${invalidCount}`);

    const unauthorizedResponse = await createProject(boundary.apiOrigin, anonKey, entityToken, {
      ...baseBody(names.unauthorized),
      p_lead_entity_id: entities.participant,
      p_entity_ids: [entities.participant],
    });
    const unauthorizedCount = projectCountByName(boundary.databaseUrl, names.unauthorized);
    check('D06-ATOMIC-06 无权限跨实体创建被拒绝',
      isDenied(unauthorizedResponse) && unauthorizedCount === 0,
      `status=${unauthorizedResponse.status} code=${unauthorizedResponse.json?.code || 'none'} projects=${unauthorizedCount}`);

    if (leadOnly) {
      const directRelation = await request(boundary.apiOrigin, anonKey, '/rest/v1/site_project_entities', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ project_id: leadOnly.id, entity_id: entities.participant, is_lead: false }),
      });
      check('D06-ATOMIC-07 客户端仍不能直接写参与实体关系',
        directRelation.status === 403 && directRelation.json?.code === '42501',
        `status=${directRelation.status} code=${directRelation.json?.code || 'none'}`);
    } else {
      check('D06-ATOMIC-07 客户端仍不能直接写参与实体关系', false, '缺少前置项目');
    }
  } catch (error) {
    check('D06-ATOMIC 执行过程', false, error.message);
  } finally {
    try {
      residue = cleanupFixture(boundary.databaseUrl, prefix);
      check('D06-ATOMIC-08 测试数据最终残留为零', residue === 0, `residue=${residue}`);
    } catch (error) {
      check('D06-ATOMIC-08 测试数据最终残留为零', false, error.message);
    }
  }

  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(JSON.stringify({
    suite: 'D06-ATOMIC-PROJECT-CREATE',
    passed: results.length - failed.length,
    failed: failed.length,
    residue,
    elapsed_ms: Number(elapsedMs.toFixed(0)),
  }));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});

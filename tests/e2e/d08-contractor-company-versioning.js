/** D08-1 targeted regression: contractor company writes are RPC-only and versioned. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const migrationPath = path.join(root, 'sql', 'training-admission-v69-contractor-company-versioning.sql');
const manifestPath = path.join(root, 'sql', 'training-admission-v17-v49.manifest.json');
const webPath = path.join(root, 'js', 'modules', 'training', 'contractors.js');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function finish(started) {
  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D08_CONTRACTOR_COMPANY_VERSIONING_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
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
  if (result.error || result.status !== 0) throw new Error('D08-1 专项测试库操作失败');
  return String(result.stdout || '').trim();
}

function applyMigration(databaseUrl) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migrationPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('D08-1 v69 测试迁移应用失败');
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
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D08-1 经营实体测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

async function rpc(boundary, anonKey, token, name, body) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isSuccess(response) {
  return response.status === 200 || response.status === 204;
}

function isDenied(response) {
  return [400, 401, 403].includes(response.status);
}

function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function verifySourceBoundary() {
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const web = fs.readFileSync(webPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 69);
  return {
    migration: /CREATE TABLE IF NOT EXISTS public\.contractor_company_versions/i.test(source)
      && /BEFORE UPDATE OR DELETE ON public\.contractor_company_versions/i.test(source)
      && /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.contractor_companies FROM anon, authenticated/i.test(source)
      && /SECURITY DEFINER SET search_path = public/gi.test(source)
      && /CREATE POLICY contractor_company_versions_read/i.test(source)
      && entry?.file === path.basename(migrationPath)
      && entry.sha256 === digest,
    web: web.includes("sb.rpc('contractor_company_create'")
      && web.includes("sb.rpc('contractor_company_update'")
      && web.includes("sb.rpc('contractor_company_review'")
      && !/from\('contractor_companies'\)\.\s*(insert|update|delete)\s*\(/i.test(web),
  };
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'lead_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'entity_user_id', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002')
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.lead_entity_id || !scope.outside_entity_id || !scope.entity_user_id) {
    throw new Error('D02 外协单位测试夹具不完整');
  }
  return scope;
}

function companyState(databaseUrl, companyId) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'count', count(*),
    'name', max(name),
    'contact_name', max(contact_name),
    'status', max(status),
    'managing_entity_id', max(managing_entity_id::text)
  )::text FROM public.contractor_companies WHERE id=${sqlLiteral(companyId)}::uuid;`);
  return JSON.parse(raw);
}

function companyVersions(databaseUrl, companyId) {
  const raw = runPsql(databaseUrl, `SELECT COALESCE(json_agg(json_build_object(
    'version_no', version_no, 'name', name, 'contact_name', contact_name,
    'status', status, 'change_kind', change_kind, 'changed_by', changed_by
  ) ORDER BY version_no), '[]'::json)::text
  FROM public.contractor_company_versions WHERE contractor_id=${sqlLiteral(companyId)}::uuid;`);
  return JSON.parse(raw);
}

function verifyDeniedAs(databaseUrl, scope, companyId, setupSql) {
  const raw = runPsql(databaseUrl, `
BEGIN;
${setupSql}
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', ${sqlLiteral(scope.entity_user_id)}, true);
DO $d08$
BEGIN
  BEGIN
    PERFORM public.contractor_company_update(
      ${sqlLiteral(companyId)}::uuid, '[D08-TEST] 越权改名', NULL, NULL, NULL, NULL);
    RAISE EXCEPTION '预期拒绝未发生' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM NOT LIKE '%无权%' THEN RAISE; END IF;
  END;
END $d08$;
ROLLBACK;
SELECT 'ok';`);
  return raw.endsWith('ok');
}

function verifyHistoryHiddenAcrossEntities(databaseUrl, scope, companyId) {
  const raw = runPsql(databaseUrl, `
BEGIN;
UPDATE public.profiles
SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept'
WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', ${sqlLiteral(scope.entity_user_id)}, true);
SELECT count(*) FROM public.contractor_company_versions
WHERE contractor_id=${sqlLiteral(companyId)}::uuid;
ROLLBACK;`);
  return raw.split(/\r?\n/).includes('0');
}

function cleanup(databaseUrl, names) {
  const list = names.map(sqlLiteral).join(', ');
  return Number.parseInt(runPsql(databaseUrl, `
BEGIN;
SET LOCAL session_replication_role = replica;
DELETE FROM public.contractor_company_versions
WHERE contractor_id IN (SELECT id FROM public.contractor_companies WHERE name IN (${list}));
DELETE FROM public.contractor_companies WHERE name IN (${list});
COMMIT;
SELECT count(*) FROM public.contractor_companies WHERE name IN (${list});`), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const source = verifySourceBoundary();
  check('D08-COMPANY-00 v69 历史、权限和迁移登记完整', source.migration);
  check('D08-COMPANY-01 Web 单位维护只调用受控 RPC', source.web);
  if (process.argv.includes('--static')) {
    finish(started);
    return;
  }

  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D08-COMPANY-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  applyMigration(boundary.databaseUrl);
  const scope = readScope(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const entity = await login(boundary.apiOrigin, anonKey,
    required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
  check('D08-COMPANY-02 测试账号与经营实体夹具一致', entity.userId === scope.entity_user_id);

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  const primaryName = `[D08-TEST] 外协单位 ${suffix}`;
  const retryName = `[D08-TEST] 重试单位 ${suffix}`;
  const legacyName = `[D08-TEST] NULL归属 ${suffix}`;
  const orphanName = `[D08-TEST] 无法解析归属 ${suffix}`;
  const primaryCode = `D08${suffix}000`.slice(0, 18);
  const retryCode = `D09${suffix}000`.slice(0, 18);
  const fixtureNames = [primaryName, `${primaryName}-V2`, `${primaryName}-V3`, retryName,
    legacyName, `${legacyName}-V2`, orphanName];
  let primaryId = null;
  let residue = -1;

  try {
    const createPayload = {
      p_name: primaryName,
      p_unified_code: primaryCode,
      p_legal_representative: '测试代表人',
      p_contact_name: '测试负责人一',
      p_contact_phone: null,
    };
    const created = await rpc(boundary, anonKey, entity.token, 'contractor_company_create', createPayload);
    primaryId = created.json?.company_id;
    const initial = primaryId ? companyState(boundary.databaseUrl, primaryId) : {};
    const initialVersions = primaryId ? companyVersions(boundary.databaseUrl, primaryId) : [];
    check('D08-COMPANY-03 有权限用户创建成功并形成首版',
      isSuccess(created) && created.json?.created === true && initial.count === 1
        && exactKeys(created.json, ['company_id', 'created', 'version_no'])
        && initial.managing_entity_id === scope.lead_entity_id && initialVersions.length === 1
        && initialVersions[0].version_no === 1 && initialVersions[0].changed_by === entity.userId,
      `status=${created.status}`);

    const firstUpdate = await rpc(boundary, anonKey, entity.token, 'contractor_company_update', {
      p_company_id: primaryId,
      ...createPayload,
      p_name: `${primaryName}-V2`,
      p_contact_name: '测试负责人二',
    });
    const afterFirst = companyState(boundary.databaseUrl, primaryId);
    const versionsAfterFirst = companyVersions(boundary.databaseUrl, primaryId);
    check('D08-COMPANY-04 修改后当前数据正确且旧版保留',
      isSuccess(firstUpdate) && firstUpdate.json?.changed === true
        && exactKeys(firstUpdate.json, ['company_id', 'changed', 'version_no'])
        && afterFirst.name === `${primaryName}-V2` && afterFirst.contact_name === '测试负责人二'
        && versionsAfterFirst.length === 2 && versionsAfterFirst[0].name === primaryName
        && versionsAfterFirst[1].name === `${primaryName}-V2`,
      `status=${firstUpdate.status}`);

    const secondUpdate = await rpc(boundary, anonKey, entity.token, 'contractor_company_update', {
      p_company_id: primaryId,
      ...createPayload,
      p_name: `${primaryName}-V3`,
      p_contact_name: '测试负责人三',
    });
    const versionsAfterSecond = companyVersions(boundary.databaseUrl, primaryId);
    check('D08-COMPANY-05 第二次修改追加连续版本',
      isSuccess(secondUpdate) && versionsAfterSecond.length === 3
        && versionsAfterSecond.map(item => item.version_no).join(',') === '1,2,3'
        && versionsAfterSecond[2].name === `${primaryName}-V3`);

    const review = await rpc(boundary, anonKey, entity.token, 'contractor_company_review', {
      p_company_id: primaryId, p_status: 'active', p_note: 'D08-1 测试审核',
    });
    const versionsAfterReview = companyVersions(boundary.databaseUrl, primaryId);
    check('D08-COMPANY-06 审核通过受控 RPC 留下新版本',
      isSuccess(review) && companyState(boundary.databaseUrl, primaryId).status === 'active'
        && exactKeys(review.json, ['company_id', 'changed', 'status', 'version_no'])
        && versionsAfterReview.length === 4 && versionsAfterReview[3].change_kind === 'review');

    const historyRead = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/contractor_company_versions?select=version_no,name,change_kind&contractor_id=eq.${primaryId}&order=version_no.asc`, {
        headers: { Authorization: `Bearer ${entity.token}` },
      });
    check('D08-COMPANY-07 有权限用户可按 RLS 查询完整版本链',
      historyRead.status === 200 && Array.isArray(historyRead.json) && historyRead.json.length === 4);

    const directUpdate = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/contractor_companies?id=eq.${primaryId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ name: '[D08-TEST] REST 绕过' }),
      });
    check('D08-COMPANY-08 REST 直接 UPDATE 被拒绝且数据未变',
      isDenied(directUpdate) && companyState(boundary.databaseUrl, primaryId).name === `${primaryName}-V3`,
      `status=${directUpdate.status}`);

    const directDelete = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/contractor_companies?id=eq.${primaryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${entity.token}`, Prefer: 'return=representation' },
      });
    check('D08-COMPANY-09 REST 直接 DELETE 被拒绝且历史仍在',
      isDenied(directDelete) && companyState(boundary.databaseUrl, primaryId).count === 1
        && companyVersions(boundary.databaseUrl, primaryId).length === 4,
      `status=${directDelete.status}`);

    check('D08-COMPANY-10 普通角色修改被数据库 RPC 拒绝', verifyDeniedAs(
      boundary.databaseUrl, scope, primaryId,
      `UPDATE public.profiles SET role='employee', admin_level=NULL WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`));
    check('D08-COMPANY-11 跨经营实体修改被数据库 RPC 拒绝', verifyDeniedAs(
      boundary.databaseUrl, scope, primaryId,
      `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`));
    check('D08-COMPANY-12 跨经营实体不能读取单位历史版本',
      verifyHistoryHiddenAcrossEntities(boundary.databaseUrl, scope, primaryId));

    const legacyId = crypto.randomUUID();
    const orphanId = crypto.randomUUID();
    runPsql(boundary.databaseUrl, `INSERT INTO public.contractor_companies(
      id,name,unified_code,managing_entity_id,status,created_by
    ) VALUES
      (${sqlLiteral(legacyId)}::uuid,${sqlLiteral(legacyName)},${sqlLiteral(`L69${suffix}000`.slice(0, 18))},NULL,'active',${sqlLiteral(scope.entity_user_id)}::uuid),
      (${sqlLiteral(orphanId)}::uuid,${sqlLiteral(orphanName)},${sqlLiteral(`O69${suffix}000`.slice(0, 18))},NULL,'active',NULL);`);
    applyMigration(boundary.databaseUrl);
    const resolved = runPsql(boundary.databaseUrl,
      `SELECT public.contractor_company_effective_entity(${sqlLiteral(legacyId)}::uuid)::text;`);
    const unresolved = runPsql(boundary.databaseUrl,
      `SELECT public.contractor_company_effective_entity(${sqlLiteral(orphanId)}::uuid)::text;`);
    const legacyOwnUpdate = await rpc(boundary, anonKey, entity.token, 'contractor_company_update', {
      p_company_id: legacyId, p_name: `${legacyName}-V2`, p_unified_code: `L69${suffix}000`.slice(0, 18),
      p_legal_representative: null, p_contact_name: '归属A', p_contact_phone: null,
    });
    const legacyCrossDenied = verifyDeniedAs(boundary.databaseUrl, scope, legacyId,
      `UPDATE public.profiles SET department_id=${sqlLiteral(scope.outside_entity_id)}::uuid, role='admin', admin_level='dept' WHERE id=${sqlLiteral(scope.entity_user_id)}::uuid;`);
    const orphanDenied = await rpc(boundary, anonKey, entity.token, 'contractor_company_update', {
      p_company_id: orphanId, p_name: orphanName, p_unified_code: `O69${suffix}000`.slice(0, 18),
      p_legal_representative: null, p_contact_name: null, p_contact_phone: null,
    });
    check('D08-COMPANY-R02-04 NULL 归属统一解析：A 可管理、B 被拒、无法解析默认拒绝',
      resolved === scope.lead_entity_id && unresolved === '' && isSuccess(legacyOwnUpdate)
        && legacyCrossDenied && isDenied(orphanDenied));

    const retryPayload = {
      p_name: retryName,
      p_unified_code: retryCode,
      p_legal_representative: null,
      p_contact_name: '弱网重试负责人',
      p_contact_phone: null,
    };
    const retries = await Promise.all([
      rpc(boundary, anonKey, entity.token, 'contractor_company_create', retryPayload),
      rpc(boundary, anonKey, entity.token, 'contractor_company_create', retryPayload),
    ]);
    const retryIds = retries.map(item => item.json?.company_id).filter(Boolean);
    const retryCount = Number.parseInt(runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.contractor_companies WHERE name=${sqlLiteral(retryName)};`), 10);
    const retryVersionCount = retryIds[0] ? companyVersions(boundary.databaseUrl, retryIds[0]).length : 0;
    check('D08-COMPANY-13 并发重复创建收敛为同一单位和单一首版',
      retries.every(isSuccess) && retryIds.length === 2 && retryIds[0] === retryIds[1]
        && retryCount === 1 && retryVersionCount === 1);
  } finally {
    residue = cleanup(boundary.databaseUrl, fixtureNames);
  }

  check('D08-COMPANY-14 测试数据残留为零', residue === 0, `residue=${residue}`);
  finish(started);
}

main().catch(error => {
  console.error(`D08 contractor company versioning failed: ${error.message}`);
  process.exit(1);
});

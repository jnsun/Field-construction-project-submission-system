/** D06 targeted regression: project applications must be created through the guarded RPC. */
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
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D06 隔离测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

function isDenied(response) {
  return (response.status === 400 || response.status === 403)
    && ['42501', 'P0001'].includes(String(response.json?.code || ''));
}

function isRpcSuccess(response) {
  return response.status === 200 && typeof response.json === 'string'
    && /^[0-9a-f-]{36}$/i.test(response.json);
}

function verifySourceBoundary() {
  const migrationPath = path.join(root, 'sql', 'training-admission-v54-project-application-insert-boundary.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const web = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'admission-mine.js'), 'utf8');
  const latestRpc = fs.readFileSync(path.join(root, 'sql', 'training-admission-v45.sql'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(migration).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 54);
  return /REVOKE INSERT ON TABLE public\.project_join_applications\s+FROM anon, authenticated/i.test(migration)
    && !/DISABLE ROW LEVEL SECURITY/i.test(migration)
    && /ALTER FUNCTION public\.site_project_apply\(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB\)\s+SET search_path = public, extensions/i.test(migration)
    && /sb\.rpc\('site_project_apply'/i.test(web)
    && !/from\('project_join_applications'\)\.insert/i.test(web)
    && /IF v_project\.status <> 'active' THEN RAISE EXCEPTION '项目当前未开放外协人员申请'/i.test(latestRpc)
    && /id_number_digest = v_id_digest[\s\S]*status IN \('pending_project_review', 'pending_entity_review', 'approved'\)/i.test(latestRpc)
    && entry?.file === 'training-admission-v54-project-application-insert-boundary.sql'
    && entry.sha256 === digest;
}

function createFixture(databaseUrl, fixture) {
  const sql = `
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name='training_admission_identity_key') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'training_admission_identity_key',
      ${sqlLiteral(fixture.secretDescription)}
    );
  END IF;
END $$;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.activeProjectId)}::uuid, ${sqlLiteral(fixture.activeCode)}, '[D06-TEST] 正常申请项目', 'active', (SELECT id FROM public.departments WHERE code='D02-ENT-A'), 'D06-TEST'),
  (${sqlLiteral(fixture.pausedProjectId)}::uuid, ${sqlLiteral(fixture.pausedCode)}, '[D06-TEST] 暂停申请项目', 'paused', (SELECT id FROM public.departments WHERE code='D02-ENT-A'), 'D06-TEST'),
  (${sqlLiteral(fixture.outsideProjectId)}::uuid, ${sqlLiteral(fixture.outsideCode)}, '[D06-TEST] 跨实体项目', 'active', (SELECT id FROM public.departments WHERE code='D02-ENT-B'), 'D06-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
SELECT p.id, p.lead_entity_id, true FROM public.site_projects p
WHERE p.id IN (${sqlLiteral(fixture.activeProjectId)}::uuid, ${sqlLiteral(fixture.pausedProjectId)}::uuid, ${sqlLiteral(fixture.outsideProjectId)}::uuid);
INSERT INTO public.site_project_invites(project_id, token_hash, expires_at)
VALUES
  (${sqlLiteral(fixture.activeProjectId)}::uuid, encode(digest(${sqlLiteral(fixture.activeToken)}, 'sha256'), 'hex'), now() + interval '1 hour'),
  (${sqlLiteral(fixture.pausedProjectId)}::uuid, encode(digest(${sqlLiteral(fixture.pausedToken)}, 'sha256'), 'hex'), now() + interval '1 hour');
COMMIT;
SELECT EXISTS (SELECT 1 FROM vault.secrets WHERE name='training_admission_identity_key' AND description=${sqlLiteral(fixture.secretDescription)});`;
  return runPsql(databaseUrl, sql) === 't';
}

function cleanupFixture(databaseUrl, fixture) {
  const ids = [fixture.activeProjectId, fixture.pausedProjectId, fixture.outsideProjectId]
    .map(id => `${sqlLiteral(id)}::uuid`).join(', ');
  const sql = `
BEGIN;
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${ids}) OR entity_id IN (${ids});
DELETE FROM public.site_projects WHERE id IN (${ids});
DELETE FROM public.site_project_audit_logs WHERE entity_id IN (${ids});
DELETE FROM public.contractor_companies WHERE name IN (${sqlLiteral(fixture.activeCompany)}, ${sqlLiteral(fixture.resumedCompany)});
DELETE FROM vault.secrets WHERE name='training_admission_identity_key' AND description=${sqlLiteral(fixture.secretDescription)};
COMMIT;
SELECT count(*) FROM public.site_projects WHERE id IN (${ids});`;
  return Number.parseInt(runPsql(databaseUrl, sql), 10);
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D06-APP-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D06-APP-00 v54 与现有 RPC 架构一致', verifySourceBoundary());

  const runKey = crypto.randomUUID();
  const suffix = runKey.replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    activeProjectId: crypto.randomUUID(),
    pausedProjectId: crypto.randomUUID(),
    outsideProjectId: crypto.randomUUID(),
    activeCode: `D06-A-${suffix}`,
    pausedCode: `D06-P-${suffix}`,
    outsideCode: `D06-X-${suffix}`,
    activeToken: `D06ACTIVE${suffix}`,
    pausedToken: `D06PAUSED${suffix}`,
    activeCompany: `[D06-TEST] 外协单位 A ${suffix}`,
    resumedCompany: `[D06-TEST] 外协单位 B ${suffix}`,
    secretDescription: `D06-TEST temporary identity key ${suffix}`,
  };
  const seed = Number.parseInt(runKey.replace(/\D/g, '').slice(0, 8) || '12345678', 10) % 100000000;
  const activeBody = {
    p_token: fixture.activeToken,
    p_name: 'D06测试申请人甲',
    p_phone: `139${String(seed).padStart(8, '0')}`,
    p_id_number: `11010119900101${String(seed % 10000).padStart(4, '0')}`,
    p_position: '辅助作业员',
    p_contractor_name: fixture.activeCompany,
    p_contractor_code: null,
    p_photo_path: `training-admission/join-applications/${runKey}/active.jpg`,
    p_attachments: [],
  };
  const resumedBody = {
    ...activeBody,
    p_token: fixture.pausedToken,
    p_name: 'D06测试申请人乙',
    p_phone: `138${String((seed + 1) % 100000000).padStart(8, '0')}`,
    p_id_number: `11010119900202${String((seed + 1) % 10000).padStart(4, '0')}`,
    p_contractor_name: fixture.resumedCompany,
    p_photo_path: `training-admission/join-applications/${runKey}/resumed.jpg`,
  };

  let residue = -1;
  try {
    const privilegeState = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'insert', has_table_privilege('authenticated', 'public.project_join_applications', 'INSERT'),
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.project_join_applications'::regclass),
      'rpc', has_function_privilege('authenticated', 'public.site_project_apply(text,text,text,text,text,text,text,text,jsonb)', 'EXECUTE')
    )::text;`));
    check('D06-APP-01 直接 INSERT 已关闭且 RLS/RPC 保留',
      privilegeState.insert === false && privilegeState.rls === true && privilegeState.rpc === true);

    const temporaryKeyCreated = createFixture(boundary.databaseUrl, fixture);
    check('D06-APP-01A 测试加密条件就绪', true,
      temporaryKeyCreated ? 'temporary_key=yes' : 'temporary_key=no');
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entity = await login(
      boundary.apiOrigin,
      anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'),
      required('SAFETY_TEST_ENTITY_PASSWORD'),
    );
    const headers = { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'application/json' };

    const activeApply = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_apply', {
      method: 'POST', headers, body: JSON.stringify(activeBody),
    });
    check('D06-APP-02 在建项目合法 RPC 申请成功', isRpcSuccess(activeApply),
      `status=${activeApply.status}`);

    const pausedApply = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_apply', {
      method: 'POST', headers, body: JSON.stringify(resumedBody),
    });
    check('D06-APP-03 暂停项目 RPC 申请被拒绝', isDenied(pausedApply),
      `status=${pausedApply.status} code=${pausedApply.json?.code || 'none'}`);

    const directBody = {
      project_id: fixture.pausedProjectId,
      applicant_user_id: entity.userId,
      name: 'D06直接写表测试',
      phone: '13900009991',
      position: '辅助作业员',
      contractor_name_input: fixture.activeCompany,
      status: 'pending_project_review',
    };
    const pausedDirect = await request(boundary.apiOrigin, anonKey, '/rest/v1/project_join_applications', {
      method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(directBody),
    });
    check('D06-APP-04 暂停项目直接 REST 写表被拒绝',
      pausedDirect.status === 403 && pausedDirect.json?.code === '42501',
      `status=${pausedDirect.status} code=${pausedDirect.json?.code || 'none'}`);

    const outsideDirect = await request(boundary.apiOrigin, anonKey, '/rest/v1/project_join_applications', {
      method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({ ...directBody, project_id: fixture.outsideProjectId }),
    });
    const outsideInvite = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_refresh_invite', {
      method: 'POST', headers, body: JSON.stringify({ p_project_id: fixture.outsideProjectId }),
    });
    check('D06-APP-05 跨项目及无权限操作仍被拒绝',
      outsideDirect.status === 403 && outsideDirect.json?.code === '42501' && isDenied(outsideInvite),
      `rest=${outsideDirect.status}/${outsideDirect.json?.code || 'none'} rpc=${outsideInvite.status}/${outsideInvite.json?.code || 'none'}`);

    const duplicateApply = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_apply', {
      method: 'POST', headers, body: JSON.stringify(activeBody),
    });
    const activeCount = Number.parseInt(runPsql(boundary.databaseUrl,
      `SELECT count(*) FROM public.project_join_applications WHERE project_id=${sqlLiteral(fixture.activeProjectId)}::uuid AND applicant_user_id=${sqlLiteral(entity.userId)}::uuid;`), 10);
    check('D06-APP-06 重复请求被拒绝且只保留一条申请',
      isDenied(duplicateApply) && activeCount === 1,
      `status=${duplicateApply.status} code=${duplicateApply.json?.code || 'none'} rows=${activeCount}`);

    runPsql(boundary.databaseUrl,
      `UPDATE public.site_projects SET status='active', pause_started_at=NULL, pause_reason=NULL WHERE id=${sqlLiteral(fixture.pausedProjectId)}::uuid;`);
    const resumedApply = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_apply', {
      method: 'POST', headers, body: JSON.stringify(resumedBody),
    });
    check('D06-APP-07 恢复在建后正常 RPC 路径可用', isRpcSuccess(resumedApply),
      `status=${resumedApply.status}`);
  } catch (error) {
    check('D06-APP 执行过程', false, error.message);
  } finally {
    try {
      residue = cleanupFixture(boundary.databaseUrl, fixture);
      check('D06-APP-08 测试数据清理完成', residue === 0, `residue=${residue}`);
    } catch (error) {
      check('D06-APP-08 测试数据清理完成', false, error.message);
    }
  }

  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(JSON.stringify({
    suite: 'D06-PROJECT-APPLICATION-BOUNDARY',
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

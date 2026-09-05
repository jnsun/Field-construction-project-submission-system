/** D06 targeted regression: read-only project status history and RLS scope. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
  if (result.error || result.status !== 0) throw new Error('D06 状态历史隔离测试库操作失败');
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
    throw new Error('D06 状态历史隔离测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

function isDenied(response) {
  return [401, 403].includes(response.status)
    && ['42501', 'PGRST301'].includes(String(response.json?.code || ''));
}

function readScope(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'legal_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity_id', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'entity_user_id', (
      SELECT p.id FROM public.profiles p
      JOIN public.training_employees e ON e.id=p.employee_id
      WHERE e.employee_no='D02-002'
    )
  )::text;`);
  const scope = JSON.parse(raw);
  if (!scope.legal_entity_id || !scope.outside_entity_id || !scope.entity_user_id) {
    throw new Error('D02 状态历史范围夹具不完整');
  }
  return scope;
}

function createFixture(databaseUrl, fixture) {
  const sql = `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, project_type, location, status, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.legalProjectId)}::uuid, ${sqlLiteral(fixture.legalCode)}, ${sqlLiteral(fixture.legalName)}, 'D06 定向测试', 'D06 合法范围', 'active', ${sqlLiteral(fixture.legalEntityId)}::uuid, 'D06-TEST'),
  (${sqlLiteral(fixture.outsideProjectId)}::uuid, ${sqlLiteral(fixture.outsideCode)}, ${sqlLiteral(fixture.outsideName)}, 'D06 定向测试', 'D06 跨实体范围', 'active', ${sqlLiteral(fixture.outsideEntityId)}::uuid, 'D06-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES
  (${sqlLiteral(fixture.legalProjectId)}::uuid, ${sqlLiteral(fixture.legalEntityId)}::uuid, true),
  (${sqlLiteral(fixture.outsideProjectId)}::uuid, ${sqlLiteral(fixture.outsideEntityId)}::uuid, true);
INSERT INTO public.site_project_roles(id, project_id, user_id, role, active)
VALUES (${sqlLiteral(fixture.roleId)}::uuid, ${sqlLiteral(fixture.legalProjectId)}::uuid, ${sqlLiteral(fixture.entityUserId)}::uuid, 'project_manager', true);
INSERT INTO public.site_project_audit_logs(id, project_id, actor_id, action, entity_type, entity_id, detail, created_at)
VALUES
  (${sqlLiteral(fixture.structuredAuditId)}::uuid, ${sqlLiteral(fixture.legalProjectId)}::uuid, ${sqlLiteral(fixture.entityUserId)}::uuid,
    'update', 'site_projects', ${sqlLiteral(fixture.legalProjectId)}::uuid,
    '{"status_change":{"from":"active","to":"paused","reason":"现场条件暂停"}}'::jsonb, now() - interval '2 minutes'),
  (${sqlLiteral(fixture.legacyAuditId)}::uuid, ${sqlLiteral(fixture.legalProjectId)}::uuid, NULL,
    'update', 'site_projects', ${sqlLiteral(fixture.legalProjectId)}::uuid,
    '{"old":{"status":"paused"},"new":{"status":"active","report_notes":"条件消除重新开启"}}'::jsonb, now() - interval '1 minute'),
  (${sqlLiteral(fixture.outsideAuditId)}::uuid, ${sqlLiteral(fixture.outsideProjectId)}::uuid, NULL,
    'update', 'site_projects', ${sqlLiteral(fixture.outsideProjectId)}::uuid,
    '{"status_change":{"from":"active","to":"closed","reason":"跨实体记录"}}'::jsonb, now());
COMMIT;`;
  runPsql(databaseUrl, sql);
}

function cleanupFixture(databaseUrl, fixture) {
  const projectIds = [fixture.legalProjectId, fixture.outsideProjectId]
    .map(id => `${sqlLiteral(id)}::uuid`).join(', ');
  const sql = `
BEGIN;
DELETE FROM public.site_project_roles WHERE id=${sqlLiteral(fixture.roleId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.site_projects WHERE id IN (${projectIds});
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
COMMIT;
SELECT (
  (SELECT count(*) FROM public.site_projects WHERE id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_entities WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_roles WHERE project_id IN (${projectIds}) OR id=${sqlLiteral(fixture.roleId)}::uuid)
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds}))
);`;
  return Number.parseInt(runPsql(databaseUrl, sql), 10);
}

function verifyDatabaseBoundary(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'rls', c.relrowsecurity,
    'select_policy', EXISTS (
      SELECT 1 FROM pg_policies p WHERE p.schemaname='public'
        AND p.tablename='site_project_audit_logs' AND p.policyname='site_project_audit_read'
        AND p.cmd='SELECT' AND p.qual LIKE '%site_project_can_read%'
    ),
    'can_select', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'SELECT'),
    'can_insert', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'INSERT'),
    'can_update', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'UPDATE'),
    'can_delete', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'DELETE'),
    'can_truncate', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'TRUNCATE'),
    'can_references', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'REFERENCES'),
    'can_trigger', has_table_privilege('authenticated', 'public.site_project_audit_logs', 'TRIGGER'),
    'anon_any', has_any_column_privilege('anon', 'public.site_project_audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
      OR has_table_privilege('anon', 'public.site_project_audit_logs', 'DELETE, TRUNCATE, TRIGGER')
  )::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname='site_project_audit_logs';`);
  const boundary = JSON.parse(raw);
  return boundary.rls === true && boundary.select_policy === true && boundary.can_select === true
    && boundary.can_insert === false && boundary.can_update === false && boundary.can_delete === false
    && boundary.can_truncate === false && boundary.can_references === false
    && boundary.can_trigger === false && boundary.anon_any === false;
}

function verifyMigrationSource() {
  const migrationPath = path.join(root, 'sql', 'training-admission-v57-project-audit-readonly.sql');
  const source = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 57);
  return /REVOKE ALL ON TABLE public\.site_project_audit_logs FROM anon, authenticated/i.test(source)
    && /GRANT SELECT ON TABLE public\.site_project_audit_logs TO authenticated/i.test(source)
    && entry?.file === 'training-admission-v57-project-audit-readonly.sql'
    && entry.sha256 === digest;
}

function verifyPageBehavior() {
  const file = path.join(root, 'js', 'modules', 'training', 'projects.js');
  const source = fs.readFileSync(file, 'utf8');
  const sandbox = {
    Utils: { escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.__projects = TrainingProjects;`, sandbox);
  const projects = sandbox.__projects;
  const structured = projects.normalizeStatusHistory({
    id: 'new', actor_id: 'actor-1', created_at: '2026-09-05T10:30:00Z',
    detail: { status_change: { from: 'active', to: 'paused', reason: '<暂停原因>' } },
  });
  const legacy = projects.normalizeStatusHistory({
    id: 'old', actor_id: null, created_at: null,
    detail: { old: { status: 'paused' }, new: { status: 'active', report_notes: '旧记录恢复' } },
  });
  const ignored = projects.normalizeStatusHistory({ detail: { old: null, new: { status: 'active' } } });
  const html = projects.renderStatusHistory([structured, legacy], { 'actor-1': '测试管理员' });
  const empty = projects.renderStatusHistory([]);
  return {
    display: ['状态历史', '变更时间', '操作者', '前状态', '后状态', '变更原因']
      .every(label => source.includes(label))
      && html.includes('测试管理员') && html.includes('在建') && html.includes('暂停')
      && html.includes('&lt;暂停原因&gt;') && html.includes('旧记录恢复'),
    fallback: legacy?.from === 'paused' && legacy?.to === 'active'
      && html.includes('历史账号已失效') && empty.includes('暂无状态历史') && ignored === null,
    readOnly: /from\('site_project_audit_logs'\)[\s\S]*?\.select\('id, actor_id, action, detail, created_at'\)/.test(source)
      && /\.order\('created_at', \{ ascending: false \}\)/.test(source)
      && !/from\('site_project_audit_logs'\)\s*\.(?:insert|update|upsert|delete)\(/.test(source)
      && !/<button[\s\S]*?(?:修改|删除|覆盖)[\s\S]*?<\/button>/.test(html),
  };
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D06-HISTORY-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D06-HISTORY-00 v57 仅保留受 RLS 约束的 authenticated SELECT', verifyMigrationSource()
    && verifyDatabaseBoundary(boundary.databaseUrl));

  const page = verifyPageBehavior();
  check('D06-HISTORY-01 页面显示前后状态、原因和操作者', page.display);
  check('D06-HISTORY-02 无记录、失效账号和旧结构安全降级', page.fallback);
  check('D06-HISTORY-03 页面只读且按时间倒序查询', page.readOnly);

  const scope = readScope(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    legalEntityId: scope.legal_entity_id,
    outsideEntityId: scope.outside_entity_id,
    entityUserId: scope.entity_user_id,
    legalProjectId: crypto.randomUUID(),
    outsideProjectId: crypto.randomUUID(),
    roleId: crypto.randomUUID(),
    structuredAuditId: crypto.randomUUID(),
    legacyAuditId: crypto.randomUUID(),
    outsideAuditId: crypto.randomUUID(),
    legalCode: `D06-HL-${suffix}`,
    outsideCode: `D06-HX-${suffix}`,
    legalName: `[D06-HISTORY] ${suffix} 合法项目`,
    outsideName: `[D06-HISTORY] ${suffix} 跨实体项目`,
  };
  let residue = -1;
  try {
    createFixture(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entity = await login(boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
    check('D06-HISTORY-04 测试账号与合法项目角色对应', entity.userId === fixture.entityUserId);

    const headers = { Authorization: `Bearer ${entity.token}` };
    const select = 'select=id,project_id,actor_id,action,detail,created_at&order=created_at.desc';
    const legal = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_audit_logs?project_id=eq.${fixture.legalProjectId}&${select}`, { headers });
    const legalIds = new Set((Array.isArray(legal.json) ? legal.json : []).map(row => row.id));
    check('D06-HISTORY-05 合法项目管理角色能读取状态历史', legal.status === 200
      && legalIds.has(fixture.structuredAuditId) && legalIds.has(fixture.legacyAuditId),
    `status=${legal.status} rows=${legalIds.size}`);

    const outside = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_audit_logs?project_id=eq.${fixture.outsideProjectId}&${select}`, { headers });
    check('D06-HISTORY-06 跨项目读取返回空', outside.status === 200
      && Array.isArray(outside.json) && outside.json.length === 0,
    `status=${outside.status} rows=${Array.isArray(outside.json) ? outside.json.length : 'error'}`);

    const visible = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_audit_logs?project_id=in.(${fixture.legalProjectId},${fixture.outsideProjectId})&select=id,project_id`, { headers });
    const visibleRows = Array.isArray(visible.json) ? visible.json : [];
    check('D06-HISTORY-07 跨经营实体记录被 RLS 过滤', visible.status === 200
      && visibleRows.some(row => row.project_id === fixture.legalProjectId)
      && visibleRows.every(row => row.project_id !== fixture.outsideProjectId),
    `status=${visible.status} visible=${visibleRows.length}`);

    const mutationHeaders = { ...headers, 'Content-Type': 'application/json' };
    const insert = await request(boundary.apiOrigin, anonKey, '/rest/v1/site_project_audit_logs', {
      method: 'POST', headers: mutationHeaders,
      body: JSON.stringify({ project_id: fixture.legalProjectId, action: 'update', entity_type: 'site_projects', detail: {} }),
    });
    const update = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_audit_logs?id=eq.${fixture.structuredAuditId}`, {
        method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ action: 'overwrite' }),
      });
    const remove = await request(boundary.apiOrigin, anonKey,
      `/rest/v1/site_project_audit_logs?id=eq.${fixture.structuredAuditId}`, {
        method: 'DELETE', headers,
      });
    check('D06-HISTORY-08 REST 无法新增、修改或删除历史',
      isDenied(insert) && isDenied(update) && isDenied(remove),
    `insert=${insert.status} update=${update.status} delete=${remove.status}`);
  } catch (error) {
    check('D06-HISTORY 执行过程', false, error.message);
  } finally {
    try { residue = cleanupFixture(boundary.databaseUrl, fixture); }
    catch (error) { check('D06-HISTORY-CLEANUP 清理测试数据', false, error.message); }
  }
  check('D06-HISTORY-09 测试数据残留为 0', residue === 0, `residue=${residue}`);

  const failed = results.filter(item => !item.pass);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`D06 project status history targeted: ${results.length - failed.length}/${results.length} passed in ${elapsed.toFixed(2)}s`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

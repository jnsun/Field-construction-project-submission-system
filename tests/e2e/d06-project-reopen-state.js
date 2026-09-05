/** D06 targeted regression: pause, close, reopen, audit history, and invite invalidation. */
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

function rowOf(response) {
  if (response.status !== 200) return null;
  return Array.isArray(response.json) ? response.json[0] : response.json;
}

function isDenied(response) {
  return (response.status === 400 || response.status === 403)
    && ['42501', 'P0001'].includes(String(response.json?.code || ''));
}

function verifySourceBoundary() {
  const migrationPath = path.join(root, 'sql', 'training-admission-v56-project-reopen-state.sql');
  const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const hints = fs.readFileSync(path.join(root, 'sql', 'training-admission-v16.sql'), 'utf8');
  const web = fs.readFileSync(path.join(root, 'js', 'modules', 'training', 'projects.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
  const digest = crypto.createHash('sha256').update(migration).digest('hex').toUpperCase();
  const entry = manifest.migrations.find(item => item.version === 56);
  return /v_old\.status IS DISTINCT FROM p_status[\s\S]*项目状态变化必须填写原因/i.test(migration)
    && /v_old\.status = 'closed' AND p_status NOT IN \('closed', 'active'\)/i.test(migration)
    && /actual_end_date = CASE WHEN v_old\.status = 'closed' AND p_status = 'active' THEN NULL/i.test(migration)
    && /UPDATE public\.site_project_invites[\s\S]*SET revoked_at = NOW\(\)/i.test(migration)
    && /'status_change',[\s\S]*'from', OLD\.status[\s\S]*'to', NEW\.status[\s\S]*'reason'/i.test(migration)
    && !/UPDATE public\.project_reports/i.test(migration)
    && !/UPDATE public\.site_projects/i.test(hints)
    && /\[\['closed', '已关闭'\], \['active', '重新开启为在建'\]\]/i.test(web)
    && entry?.file === 'training-admission-v56-project-reopen-state.sql'
    && entry.sha256 === digest;
}

function createFixture(databaseUrl, fixture) {
  const sql = `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, project_type, location, status, start_date, expected_end_date, lead_entity_id, report_notes)
VALUES
  (${sqlLiteral(fixture.pauseProjectId)}::uuid, ${sqlLiteral(fixture.pauseCode)}, ${sqlLiteral(fixture.pauseName)}, 'D06 定向测试', 'D06 测试区', 'active', '2026-09-01', '2026-12-31', ${sqlLiteral(fixture.entityId)}::uuid, 'D06-TEST'),
  (${sqlLiteral(fixture.closeProjectId)}::uuid, ${sqlLiteral(fixture.closeCode)}, ${sqlLiteral(fixture.closeName)}, 'D06 定向测试', 'D06 测试区', 'active', '2026-09-01', '2026-12-31', ${sqlLiteral(fixture.entityId)}::uuid, 'D06-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES
  (${sqlLiteral(fixture.pauseProjectId)}::uuid, ${sqlLiteral(fixture.entityId)}::uuid, true),
  (${sqlLiteral(fixture.closeProjectId)}::uuid, ${sqlLiteral(fixture.entityId)}::uuid, true);
INSERT INTO public.site_project_invites(id, project_id, token_hash, expires_at)
VALUES
  (${sqlLiteral(fixture.pauseInviteId)}::uuid, ${sqlLiteral(fixture.pauseProjectId)}::uuid, encode(digest(${sqlLiteral(fixture.pauseToken)}, 'sha256'), 'hex'), now() + interval '1 day'),
  (${sqlLiteral(fixture.closeInviteId)}::uuid, ${sqlLiteral(fixture.closeProjectId)}::uuid, encode(digest(${sqlLiteral(fixture.closeToken)}, 'sha256'), 'hex'), now() + interval '1 day');
INSERT INTO public.project_join_applications(id, project_id, name, phone, position, status)
VALUES (${sqlLiteral(fixture.historyApplicationId)}::uuid, ${sqlLiteral(fixture.closeProjectId)}::uuid, ${sqlLiteral(fixture.historyApplicationName)}, '13900008881', '历史测试岗位', 'pending_project_review');
INSERT INTO public.project_reports(
  id, department_id, project_name, project_type, construction_location, contract_amount,
  duration_months, department_entity, project_manager, contact_info, overall_progress,
  monthly_construction_status, equipment_models, on_site_personnel, on_site_vehicles,
  safety_inspection, safety_hazards, reporting_year, reporting_month, project_status, site_project_id
) VALUES (
  ${sqlLiteral(fixture.reportId)}::uuid, ${sqlLiteral(fixture.entityId)}::uuid, ${sqlLiteral(fixture.closeName)},
  'D06 定向测试', 'D06 测试区', 1, 1, 'D02-ENT-A', 'D06测试负责人', '13900008882',
  '100%', '月报已完工', '无', 0, 0, true, false, 2026, 9, 'completed', ${sqlLiteral(fixture.closeProjectId)}::uuid
);
COMMIT;`;
  runPsql(databaseUrl, sql);
}

function cleanupFixture(databaseUrl, fixture) {
  const projectIds = [fixture.pauseProjectId, fixture.closeProjectId]
    .map(id => `${sqlLiteral(id)}::uuid`).join(', ');
  const sql = `
BEGIN;
DELETE FROM public.project_reports WHERE id=${sqlLiteral(fixture.reportId)}::uuid;
DELETE FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds});
DELETE FROM public.site_projects WHERE id IN (${projectIds});
DELETE FROM public.site_project_audit_logs WHERE entity_id IN (${projectIds});
COMMIT;
SELECT (
  (SELECT count(*) FROM public.site_projects WHERE id IN (${projectIds}))
  + (SELECT count(*) FROM public.project_reports WHERE id=${sqlLiteral(fixture.reportId)}::uuid)
  + (SELECT count(*) FROM public.project_join_applications WHERE id=${sqlLiteral(fixture.historyApplicationId)}::uuid)
  + (SELECT count(*) FROM public.site_project_invites WHERE project_id IN (${projectIds}))
  + (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id IN (${projectIds}) OR entity_id IN (${projectIds}))
);`;
  return Number.parseInt(runPsql(databaseUrl, sql), 10);
}

async function updateProject(baseUrl, anonKey, token, project, status, reason, actualEnd = null) {
  return request(baseUrl, anonKey, '/rest/v1/rpc/site_project_update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_project_id: project.id,
      p_name: project.name,
      p_project_type: 'D06 定向测试',
      p_location: 'D06 测试区',
      p_status: status,
      p_start_date: '2026-09-01',
      p_expected_end_date: '2026-12-31',
      p_actual_end_date: actualEnd,
      p_lead_entity_id: project.entityId,
      p_reason: reason,
    }),
  });
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const markers = assertD02FixtureMarker(boundary);
  check('D06-STATE-GATE 隔离测试边界', markers > 0, `fixture_markers=${markers}`);
  check('D06-STATE-00 v56 状态权威、审计及页面规则一致', verifySourceBoundary());

  const entityId = runPsql(boundary.databaseUrl, "SELECT id FROM public.departments WHERE code='D02-ENT-A';");
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw new Error('D02 经营实体夹具不完整');
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const fixture = {
    entityId,
    pauseProjectId: crypto.randomUUID(),
    closeProjectId: crypto.randomUUID(),
    pauseInviteId: crypto.randomUUID(),
    closeInviteId: crypto.randomUUID(),
    historyApplicationId: crypto.randomUUID(),
    reportId: crypto.randomUUID(),
    pauseCode: `D06-SP-${suffix}`,
    closeCode: `D06-SC-${suffix}`,
    pauseName: `[D06-STATE] ${suffix} 暂停复工`,
    closeName: `[D06-STATE] ${suffix} 关闭重开`,
    historyApplicationName: `[D06-STATE] ${suffix} 历史申请`,
    pauseToken: `D06PAUSE${suffix}`,
    closeToken: `D06CLOSE${suffix}`,
  };
  const pauseProject = { id: fixture.pauseProjectId, name: fixture.pauseName, entityId };
  const closeProject = { id: fixture.closeProjectId, name: fixture.closeName, entityId };
  const reasons = {
    pause: 'D06 暂停测试',
    pauseResume: 'D06 暂停后恢复在建',
    close: 'D06 正式关闭测试',
    reopen: 'D06 关闭后重新开启',
  };

  let residue = -1;
  try {
    createFixture(boundary.databaseUrl, fixture);
    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const admin = await login(boundary.apiOrigin, anonKey,
      required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD'));

    const hintResponse = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_report_status_hints', {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const hint = Array.isArray(hintResponse.json)
      ? hintResponse.json.find(item => item.project_id === fixture.closeProjectId) : null;
    const reportState = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'project', (SELECT status FROM public.site_projects WHERE id=${sqlLiteral(fixture.closeProjectId)}::uuid),
      'report', (SELECT project_status FROM public.project_reports WHERE id=${sqlLiteral(fixture.reportId)}::uuid)
    )::text;`));
    check('D06-STATE-01 月报已完工只提示且项目仍为在建',
      hintResponse.status === 200 && hint?.latest_status === 'completed'
        && reportState.report === 'completed' && reportState.project === 'active',
      `hint=${hint?.latest_status || 'none'} project=${reportState.project}`);

    const paused = await updateProject(boundary.apiOrigin, anonKey, admin.token, pauseProject, 'paused', reasons.pause);
    const pausedRow = rowOf(paused);
    const pausedInviteRevoked = runPsql(boundary.databaseUrl,
      `SELECT revoked_at IS NOT NULL FROM public.site_project_invites WHERE id=${sqlLiteral(fixture.pauseInviteId)}::uuid;`) === 't';
    const pausedRefresh = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_refresh_invite', {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_project_id: fixture.pauseProjectId }),
    });
    check('D06-STATE-02 在建转暂停并阻止项目操作',
      pausedRow?.status === 'paused' && !!pausedRow.pause_started_at && pausedInviteRevoked && isDenied(pausedRefresh),
      `update=${paused.status} refresh=${pausedRefresh.status}`);

    const pauseResumed = await updateProject(boundary.apiOrigin, anonKey, admin.token, pauseProject, 'active', reasons.pauseResume);
    const pauseResumedRow = rowOf(pauseResumed);
    const pauseNewInvite = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_refresh_invite', {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_project_id: fixture.pauseProjectId }),
    });
    check('D06-STATE-03 暂停恢复为正确在建状态且正常操作恢复',
      pauseResumedRow?.status === 'active' && !pauseResumedRow.pause_started_at && !pauseResumedRow.pause_reason
        && pauseNewInvite.status === 200 && !!pauseNewInvite.json?.token,
      `update=${pauseResumed.status} refresh=${pauseNewInvite.status}`);

    const closed = await updateProject(boundary.apiOrigin, anonKey, admin.token, closeProject, 'closed', reasons.close, '2026-09-05');
    const closedRow = rowOf(closed);
    const closedInviteRevoked = runPsql(boundary.databaseUrl,
      `SELECT revoked_at IS NOT NULL FROM public.site_project_invites WHERE id=${sqlLiteral(fixture.closeInviteId)}::uuid;`) === 't';
    check('D06-STATE-04 在建项目必须经显式操作正式关闭',
      closedRow?.status === 'closed' && !!closedRow.closed_at && closedRow.closed_by === admin.userId
        && closedRow.close_reason === reasons.close && closedInviteRevoked,
      `status=${closed.status} closed=${closedRow?.status || 'none'}`);

    const invalidReopen = await updateProject(boundary.apiOrigin, anonKey, admin.token, closeProject, 'planning', reasons.reopen, '2026-09-05');
    check('D06-STATE-05 已关闭项目不能恢复到非在建状态', isDenied(invalidReopen),
      `status=${invalidReopen.status} code=${invalidReopen.json?.code || 'none'}`);

    const reopened = await updateProject(boundary.apiOrigin, anonKey, admin.token, closeProject, 'active', reasons.reopen, '2026-09-05');
    const reopenedRow = rowOf(reopened);
    const oldInviteStillRevoked = runPsql(boundary.databaseUrl,
      `SELECT revoked_at IS NOT NULL FROM public.site_project_invites WHERE id=${sqlLiteral(fixture.closeInviteId)}::uuid;`) === 't';
    const oldInviteApply = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_apply', {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_token: fixture.closeToken, p_name: 'D06旧邀请码测试', p_phone: '13900008883',
        p_id_number: '110101199001010000', p_position: '辅助作业员', p_contractor_name: 'D06不落库单位',
        p_contractor_code: null, p_photo_path: 'training-admission/join-applications/d06-old/old.jpg', p_attachments: [],
      }),
    });
    const closeNewInvite = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_refresh_invite', {
      method: 'POST', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_project_id: fixture.closeProjectId }),
    });
    check('D06-STATE-06 关闭后重新开启为在建且旧字段清理',
      reopenedRow?.status === 'active' && !reopenedRow.closed_at && !reopenedRow.closed_by
        && !reopenedRow.close_reason && !reopenedRow.actual_end_date,
      `status=${reopened.status} reopened=${reopenedRow?.status || 'none'}`);
    check('D06-STATE-07 旧邀请码不复活且可显式生成新邀请码',
      oldInviteStillRevoked && isDenied(oldInviteApply)
        && closeNewInvite.status === 200 && !!closeNewInvite.json?.token,
      `old=${oldInviteApply.status} refresh=${closeNewInvite.status}`);

    const history = JSON.parse(runPsql(boundary.databaseUrl, `SELECT COALESCE(json_agg(json_build_object(
      'project_id', project_id, 'actor_id', actor_id, 'created_at', created_at,
      'from', detail->'status_change'->>'from', 'to', detail->'status_change'->>'to',
      'reason', detail->'status_change'->>'reason'
    ) ORDER BY created_at, id), '[]'::json)::text
    FROM public.site_project_audit_logs
    WHERE project_id IN (${sqlLiteral(fixture.pauseProjectId)}::uuid, ${sqlLiteral(fixture.closeProjectId)}::uuid)
      AND detail ? 'status_change';`));
    const expected = new Set([
      `${fixture.pauseProjectId}|active|paused|${reasons.pause}`,
      `${fixture.pauseProjectId}|paused|active|${reasons.pauseResume}`,
      `${fixture.closeProjectId}|active|closed|${reasons.close}`,
      `${fixture.closeProjectId}|closed|active|${reasons.reopen}`,
    ]);
    const actual = new Set(history.map(item => `${item.project_id}|${item.from}|${item.to}|${item.reason}`));
    const completeHistory = history.length === 4
      && history.every(item => item.actor_id === admin.userId && !!item.created_at)
      && [...expected].every(item => actual.has(item));
    check('D06-STATE-08 状态历史完整记录前后状态、原因、操作者和时间',
      completeHistory, `rows=${history.length}`);

    const preserved = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'application', EXISTS (SELECT 1 FROM public.project_join_applications WHERE id=${sqlLiteral(fixture.historyApplicationId)}::uuid AND status='pending_project_review'),
      'report', EXISTS (SELECT 1 FROM public.project_reports WHERE id=${sqlLiteral(fixture.reportId)}::uuid AND project_status='completed'),
      'audit_rows', (SELECT count(*) FROM public.site_project_audit_logs WHERE project_id=${sqlLiteral(fixture.closeProjectId)}::uuid AND detail ? 'status_change')
    )::text;`));
    check('D06-STATE-09 重新开启不覆盖历史申请、月报和审计',
      preserved.application === true && preserved.report === true && preserved.audit_rows === 2,
      `application=${preserved.application} report=${preserved.report} audit=${preserved.audit_rows}`);
  } catch (error) {
    check('D06-STATE 执行过程', false, error.message);
  } finally {
    try {
      residue = cleanupFixture(boundary.databaseUrl, fixture);
      check('D06-STATE-10 测试数据最终残留为零', residue === 0, `residue=${residue}`);
    } catch (error) {
      check('D06-STATE-10 测试数据最终残留为零', false, error.message);
    }
  }

  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(JSON.stringify({
    suite: 'D06-PROJECT-REOPEN-STATE',
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

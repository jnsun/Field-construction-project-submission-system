/**
 * verify-stats.js - statistics-module.sql 执行后远程回归验证
 * 用法：node tests/e2e/verify-stats.js
 * 前提：用户已在 Supabase 控制台执行 sql/statistics-module.sql
 * 检查项：
 *   1. 公司级 stats_overview(NULL) → 五指标 + 明细
 *   2. 公司级穿透任一下级部门 → scope 正确
 *   3. 经营实体 stats_overview(NULL) → 数据范围 ⊆ 公司级（三级隔离）
 *   4. 经营实体穿透非管辖部门 → 42501 拒绝（越权必须失败）
 *   5. stats_alert_sync 懒计算幂等（两次调用均 200）
 *   6. stats_alert_inbox 返回 rows + unread
 *   7. stats_alert_ack 全部已读 → unread 归零
 *   8. stats_set_settings：实体被拒(42501)、公司级成功
 *   9. stats_set_cert_target：公司级可设、实体越权被拒
 *  10. stats_export_records / stats_overdue_list 正常返回
 */
const SUPABASE_URL = 'https://exwsuwhqqpsqekzkmdol.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4d3N1d2hxcXBzcWVremttZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzUyNTcsImV4cCI6MjEwMzExMTI1N30.bMqWlGbJ0IGL9mgT33r9IjUQiJ7E2dwADKHNU04ukW0';

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function login(emailOrPhone, password) {
  const isEmail = String(emailOrPhone).includes('@');
  let email = emailOrPhone;
  if (!isEmail) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_login_identifier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_identifier: emailOrPhone }),
    });
    const json = await res.json();
    if (!res.ok || !json || !json.email) throw new Error(`解析登录标识失败 ${emailOrPhone}: ${JSON.stringify(json)}`);
    email = json.email;
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`登录失败 ${email}: ${JSON.stringify(json)}`);
  return json.access_token;
}

function rest(token) {
  return async (method, path, body) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  };
}

async function main() {
  const adminToken = await login('jnsun@qq.com', '31803180');
  const entityToken = await login('13835938299', '123456');
  const adminApi = rest(adminToken);
  const entityApi = rest(entityToken);

  // ---- 1. 公司级总览 ----
  const ov = await adminApi('POST', 'rpc/stats_overview', { p_dept: null, p_from: null, p_to: null });
  const ok1 = ov.status === 200 && ov.json && ov.json.total && Array.isArray(ov.json.depts) && ov.json.settings;
  report('1. 公司级 stats_overview(NULL)', ok1,
    ok1 ? `任务=${ov.json.total.tasks} 完成率=${ov.json.total.completion_rate} 明细=${ov.json.depts.length}部门` : JSON.stringify(ov.json));

  // ---- 2. 公司级穿透第一个下级部门 ----
  const firstDept = ok1 && ov.json.depts[0];
  let outOfScopeDeptId = null;
  if (firstDept) {
    const ov2 = await adminApi('POST', 'rpc/stats_overview', { p_dept: firstDept.dept_id, p_from: null, p_to: null });
    const ok2 = ov2.status === 200 && ov2.json && ov2.json.scope && ov2.json.scope.dept_id === firstDept.dept_id;
    report('2. 公司级穿透下级部门', ok2, ok2 ? `scope=${ov2.json.scope.dept_name}` : JSON.stringify(ov2.json));
  } else {
    report('2. 公司级穿透下级部门', false, '无明细部门可测');
  }

  // ---- 3. 经营实体总览（范围应 ⊆ 公司级） ----
  const ovE = await entityApi('POST', 'rpc/stats_overview', { p_dept: null, p_from: null, p_to: null });
  const ok3 = ovE.status === 200 && ovE.json && ovE.json.total;
  const entTaskCount = ok3 ? ovE.json.total.tasks : -1;
  const admTaskCount = ok1 ? ov.json.total.tasks : -2;
  report('3. 经营实体 stats_overview 且范围⊆公司级', ok3 && entTaskCount >= 0 && entTaskCount <= admTaskCount,
    `entity tasks=${entTaskCount} ≤ admin tasks=${admTaskCount}`);

  // ---- 4. 经营实体穿透非管辖部门 → 42501 ----
  const entDepts = (ok3 && ovE.json.depts || []).map(d => d.dept_id);
  const admDepts = (ok1 && ov.json.depts || []).map(d => d.dept_id);
  outOfScopeDeptId = admDepts.find(id => !entDepts.includes(id)) || null;
  if (outOfScopeDeptId) {
    const denied = await entityApi('POST', 'rpc/stats_overview', { p_dept: outOfScopeDeptId, p_from: null, p_to: null });
    const ok4 = (denied.status === 400 || denied.status === 403) && (denied.json && (denied.json.code === '42501'
      || /无权|仅公司级/i.test(denied.json.message || '')));
    report('4. 经营实体穿透非管辖部门被拒', ok4, `${denied.status}: ${denied.json && denied.json.message}`);
  } else {
    report('4. 经营实体穿透非管辖部门被拒', false, '未找到范围外部门（公司级明细可能为空）');
  }

  // ---- 5. 预警同步幂等 ----
  const sy1 = await entityApi('POST', 'rpc/stats_alert_sync', {});
  const sy2 = await entityApi('POST', 'rpc/stats_alert_sync', {});
  report('5. stats_alert_sync 两次调用', sy1.status === 200 && sy2.status === 200,
    `first=${JSON.stringify(sy1.json)}, second=${JSON.stringify(sy2.json)}`);

  // ---- 6. 信箱 ----
  const ib = await entityApi('POST', 'rpc/stats_alert_inbox', { p_unread_only: false });
  const ok6 = ib.status === 200 && ib.json && Array.isArray(ib.json.rows);
  report('6. stats_alert_inbox', ok6, ok6 ? `rows=${ib.json.rows.length} unread=${ib.json.unread}` : JSON.stringify(ib.json));

  // ---- 7. 已读归零 ----
  if (ok6 && ib.json.rows.length) {
    const ids = ib.json.rows.filter(r => r.unread).map(r => r.id);
    if (ids.length) {
      const ack = await entityApi('POST', 'rpc/stats_alert_ack', { p_ids: ids });
      const ib2 = await entityApi('POST', 'rpc/stats_alert_inbox', { p_unread_only: false });
      report('7. stats_alert_ack 后 unread=0', (ack.status === 200 || ack.status === 204) && ib2.json.unread === 0,
        `acked=${ids.length}(${ack.status}), unread=${ib2.json && ib2.json.unread}`);
    } else {
      report('7. stats_alert_ack 后 unread=0', true, '无未读可测');
    }
  } else {
    report('7. stats_alert_ack 后 unread=0', true, '信箱为空跳过');
  }

  // ---- 8. 阈值设置：实体拒 / 公司级成 ----
  const ssE = await entityApi('POST', 'rpc/stats_set_settings', { p_completion_threshold: 60, p_overdue_grace_days: 5 });
  const ok8a = (ssE.status === 400 || ssE.status === 403) && ssE.json && (ssE.json.code === '42501' || /仅公司级/i.test(ssE.json.message || ''));
  report('8a. 实体 stats_set_settings 被拒', ok8a, `${ssE.status}: ${ssE.json && ssE.json.message}`);
  const ssA = await adminApi('POST', 'rpc/stats_set_settings', { p_completion_threshold: 80, p_overdue_grace_days: 7 });
  report('8b. 公司级 stats_set_settings', ssA.status === 200 || ssA.status === 204, `${ssA.status}`);

  // ---- 9. 持证基准：公司级设 / 实体越权拒 ----
  if (outOfScopeDeptId) {
    const ctA = await adminApi('POST', 'rpc/stats_set_cert_target', { p_dept: outOfScopeDeptId, p_count: 3 });
    const ctE = await entityApi('POST', 'rpc/stats_set_cert_target', { p_dept: outOfScopeDeptId, p_count: 3 });
    const ok9 = (ctA.status === 200 || ctA.status === 204) && (ctE.status === 400 || ctE.status === 403)
      && (ctE.json && (ctE.json.code === '42501' || /仅公司级/i.test(ctE.json.message || '')));
    report('9. stats_set_cert_target 权限', ok9, `admin=${ctA.status}, entity=${ctE.status}`);
    // 清理：基准归零不影响业务
    await adminApi('POST', 'rpc/stats_set_cert_target', { p_dept: outOfScopeDeptId, p_count: 0 });
  }

  // ---- 10. 导出与逾期名单 ----
  const ex = await adminApi('POST', 'rpc/stats_export_records', { p_plan: null, p_dept: null });
  report('10a. stats_export_records', ex.status === 200 && ex.json && Array.isArray(ex.json.rows),
    `rows=${ex.json && ex.json.count}`);
  const od = await adminApi('POST', 'rpc/stats_overdue_list', { p_dept: null, p_limit: 50 });
  report('10b. stats_overdue_list', od.status === 200 && od.json && Array.isArray(od.json.rows),
    `rows=${od.json && od.json.count}`);

  const failed = results.filter(r => !r.pass);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });

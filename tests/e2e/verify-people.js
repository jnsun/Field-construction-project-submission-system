/**
 * verify-people.js - personnel-center-v1.sql 执行后远程回归验证
 * 用法：node tests/e2e/verify-people.js
 * 前提：用户已在 Supabase 控制台执行 sql/personnel-center-v1.sql
 * 检查项：
 *   1. 缝合迁移生效（profiles.employee_id 非空计数 > 0）
 *   2. 员工表新列 job_grade / photo_path 可查询
 *   3. 公司级建测试档案 → people_create_account 开通账号 → profiles.employee_id 绑定
 *   4. 测试账号登录 + employee_self_profile 返回本人档案
 *   5. employee_self_update 改手机号（员工表+账号表联动）→ 改回
 *   6. employee_self_update 拒绝非放行字段（name）
 *   7. 实体管理员 people_link_account 越权被拒（仅公司级）
 *   8. 公司级 people_unlink_account / people_link_account 正常
 *   9. 清理：删除测试账号与测试档案
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
  return async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json };
  };
}

const randPhone = () => '19' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');

async function main() {
  const adminToken = await login('jnsun@qq.com', '31803180');
  const entityToken = await login('13835938299', '123456');
  const adminApi = rest(adminToken);
  const entityApi = rest(entityToken);

  // ---- 1. 缝合迁移 ----
  const stitch = await adminApi('GET', 'profiles?employee_id=not.is.null&select=id,phone,employee_id');
  report('1. 缝合迁移生效（profiles.employee_id 非空）',
    stitch.status === 200 && Array.isArray(stitch.json) && stitch.json.length > 0,
    `已绑定 ${Array.isArray(stitch.json) ? stitch.json.length : 0} 对`);

  // ---- 2. 员工表新列 ----
  const cols = await adminApi('GET', 'training_employees?select=id,name,job_grade,photo_path&limit=1');
  report('2. training_employees 新列 job_grade/photo_path', cols.status === 200 && Array.isArray(cols.json),
    cols.status === 200 ? '可查询' : JSON.stringify(cols.json));

  // ---- 3. 建测试档案 + 开通账号 ----
  const rootDept = await adminApi('GET', 'departments?dept_type=eq.company&select=id&limit=1');
  const deptId = rootDept.json && rootDept.json[0] && rootDept.json[0].id;
  if (!deptId) throw new Error('找不到公司根部门');
  const testPhone = randPhone();
  const empRes = await adminApi('POST', 'training_employees',
    { name: '__P1测试员工__', department_id: deptId, phone: testPhone, status: 'active', emp_type: 'employee', job_grade: '测试岗' },
    { Prefer: 'return=representation' });
  const emp = Array.isArray(empRes.json) ? empRes.json[0] : null;
  if (!emp) throw new Error(`创建测试档案失败: ${empRes.status} ${JSON.stringify(empRes.json)}`);

  const acctPhone = testPhone; // 缺省取档案手机号
  const createRes = await adminApi('POST', 'rpc/people_create_account', {
    p_employee_id: emp.id, p_email: null, p_password: 'p1test123', p_role: 'employee',
  });
  const userId = createRes.json && (createRes.json.user_id || (createRes.json.user_id));
  report('3. people_create_account 开通并绑定', createRes.status === 200 && !!userId,
    createRes.status === 200 ? `user_id=${userId}` : JSON.stringify(createRes.json));

  let bound = null;
  if (userId) {
    const chk = await adminApi('GET', `profiles?id=eq.${userId}&select=id,employee_id,phone`);
    bound = chk.json && chk.json[0];
    report('3b. profiles.employee_id 已绑定', !!bound && bound.employee_id === emp.id,
      bound ? `employee_id=${bound.employee_id}` : JSON.stringify(chk.json));
  } else {
    report('3b. profiles.employee_id 已绑定', false, '无账号可查');
  }

  // ---- 4. 测试账号登录 + 自视图 ----
  let empToken = null;
  try { empToken = await login(acctPhone, 'p1test123'); } catch (e) { /* 下方报告 */ }
  if (empToken) {
    const prof = await rest(empToken)('POST', 'rpc/employee_self_profile', {});
    const p = prof.json || {};
    report('4. 测试账号登录 + employee_self_profile',
      prof.status === 200 && p.has_employee === true && p.employee && p.employee.name === '__P1测试员工__',
      `name=${p.employee && p.employee.name}`);
  } else {
    report('4. 测试账号登录 + employee_self_profile', false, '手机号登录失败');
  }

  // ---- 5. 自助改手机号（联动）----
  if (empToken) {
    const newPhone = randPhone();
    const up = await rest(empToken)('POST', 'rpc/employee_self_update', { p_field: 'phone', p_value: newPhone });
    const teChk = await adminApi('GET', `training_employees?id=eq.${emp.id}&select=phone`);
    const pfChk = await adminApi('GET', `profiles?id=eq.${userId}&select=phone`);
    const tePhone = teChk.json && teChk.json[0] && teChk.json[0].phone;
    const pfPhone = pfChk.json && pfChk.json[0] && pfChk.json[0].phone;
    report('5. employee_self_update 改手机号双表联动',
      up.status === 200 && tePhone === newPhone && pfPhone === newPhone,
      `员工表=${tePhone} 账号表=${pfPhone}`);
    // 改回原手机号，保持档案数据干净（随后整档案删除）
    await rest(empToken)('POST', 'rpc/employee_self_update', { p_field: 'phone', p_value: acctPhone });
  } else {
    report('5. employee_self_update 改手机号双表联动', false, '无测试账号 token');
  }

  // ---- 6. 拒绝非放行字段 ----
  if (empToken) {
    const bad = await rest(empToken)('POST', 'rpc/employee_self_update', { p_field: 'name', p_value: '黑客改的' });
    const ok6 = bad.status >= 400 && /不允许自助修改/.test((bad.json && bad.json.message) || '');
    report('6. employee_self_update 拒绝 name 字段', ok6,
      `${bad.status}: ${bad.json && bad.json.message}`);
  } else {
    report('6. employee_self_update 拒绝 name 字段', false, '无测试账号 token');
  }

  // ---- 7. 实体越权被拒 ----
  const deny = await entityApi('POST', 'rpc/people_link_account', { p_employee_id: emp.id, p_user_id: userId });
  const ok7 = deny.status >= 400 && /仅公司级/.test((deny.json && deny.json.message) || '');
  report('7. 实体管理员 people_link_account 越权被拒', ok7,
    `${deny.status}: ${deny.json && deny.json.message}`);

  // ---- 8. 公司级解绑/绑定 ----
  const unlink = await adminApi('POST', 'rpc/people_unlink_account', { p_user_id: userId });
  const afterUnlink = await adminApi('GET', `profiles?id=eq.${userId}&select=employee_id`);
  const relink = await adminApi('POST', 'rpc/people_link_account', { p_employee_id: emp.id, p_user_id: userId });
  const afterLink = await adminApi('GET', `profiles?id=eq.${userId}&select=employee_id`);
  report('8. 公司级 unlink/link',
    unlink.status === 200 && relink.status === 200
    && afterUnlink.json[0].employee_id === null && afterLink.json[0].employee_id === emp.id,
    `unlink=${unlink.status} relink=${relink.status}`);

  // ---- 9. 清理 ----
  const delAcct = await adminApi('POST', 'rpc/delete_dept_user', { p_user_id: userId });
  const delEmp = await adminApi('DELETE', `training_employees?id=eq.${emp.id}`);
  report('9. 清理测试数据', delAcct.status === 200 && delEmp.status === 204,
    `账号=${delAcct.status} 档案=${delEmp.status}`);

  const failed = results.filter(r => !r.pass);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });

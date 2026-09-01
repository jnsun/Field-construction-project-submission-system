/**
 * verify-dept-fix.js - department-fix-v1.sql 补丁执行后远程回归验证
 * 用法：node tests/e2e/verify-dept-fix.js
 * 检查项：
 *   1. 公司级管理员最小参数调用 create_department → 不再 PGRST203，创建成功
 *   2. 公司级管理员 delete_department 清理测试部门
 *   3. 经营实体管理员最小参数调用 → 应报权限错（P0001），而非 PGRST203
 *   4. 经营实体管理员在本部门下建项目部 → 成功（6 参完整路径）+ 删除清理
 *   5. RLS：经营实体管理员直连 profiles 只见本部门子树
 *   6. RLS：公司级管理员直连 profiles 仍见全量；departments 两账号均可全读（设计如此）
 */
const SUPABASE_URL = 'https://exwsuwhqqpsqekzkmdol.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4d3N1d2hxcXBzcWVremttZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzUyNTcsImV4cCI6MjEwMzExMTI1N30.bMqWlGbJ0IGL9mgT33r9IjUQiJ7E2dwADKHNU04ukW0';

const results = [];
function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function login(emailOrPhone, password) {
  // 与前端 auth.js 同链路：手机号先经 resolve_login_identifier 解析出真实邮箱
  const isEmail = String(emailOrPhone).includes('@');
  let email = emailOrPhone;
  if (!isEmail) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/resolve_login_identifier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_identifier: emailOrPhone }),
    });
    const json = await res.json();
    if (!res.ok || !json || !json.email) {
      throw new Error(`解析登录标识失败 ${emailOrPhone}: ${JSON.stringify(json)}`);
    }
    email = json.email;
    console.log(`[login] ${emailOrPhone} → ${email}`);
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

  // ---- 1. 公司级管理员最小参数建部门（PGRST203 回归点）----
  const mk = await adminApi('POST', 'rpc/create_department', { p_name: '补丁验证临时部门' });
  report('1. 公司级最小参数 create_department', mk.status === 200 && mk.json && mk.json.success === true,
    JSON.stringify(mk.json));
  const testDeptId = mk.json && mk.json.department_id;

  // ---- 2. 清理：删除该测试部门 ----
  if (testDeptId) {
    const del = await adminApi('POST', 'rpc/delete_department', { p_department_id: testDeptId });
    report('2. 公司级 delete_department 清理', del.status === 200 && del.json && del.json.success === true,
      JSON.stringify(del.json));
  }

  // ---- 3. 经营实体管理员最小参数建部门 → 应为权限错而非 PGRST203 ----
  const mk2 = await entityApi('POST', 'rpc/create_department', { p_name: '越权测试部门' });
  const errCode = mk2.json && mk2.json.code;
  const errMsg = mk2.json && mk2.json.message;
  report('3. 经营实体最小参数调用（期望 P0001 权限错，非 PGRST203）',
    mk2.status === 400 && errCode === 'P0001' && !/PGRST203|could not choose/i.test(errMsg || ''),
    `${errCode}: ${errMsg}`);

  // ---- 4. 经营实体管理员在本部门下建项目部（完整 6 参路径）+ 清理 ----
  const me = await entityApi('GET', 'profiles?select=id,department_id&limit=1');
  const myDept = me.json && me.json[0] && me.json[0].department_id;
  if (myDept) {
    const mk3 = await entityApi('POST', 'rpc/create_department',
      { p_name: '补丁验证项目部', p_dept_type: 'project', p_parent_id: myDept });
    report('4a. 经营实体建本部门项目部', mk3.status === 200 && mk3.json && mk3.json.success === true,
      JSON.stringify(mk3.json));
    if (mk3.json && mk3.json.department_id) {
      const del2 = await entityApi('POST', 'rpc/delete_department', { p_department_id: mk3.json.department_id });
      report('4b. 经营实体删除本部门项目部', del2.status === 200 && del2.json && del2.json.success === true,
        JSON.stringify(del2.json));
    }
  } else {
    report('4a. 经营实体建本部门项目部', false, '未取到 department_id');
  }

  // ---- 5/6. RLS 可见数 ----
  const epAll = await entityApi('GET', 'profiles?select=id,department_id,role');
  const epCount = Array.isArray(epAll.json) ? epAll.json.length : -1;
  report('5. 经营实体 REST 直连 profiles 可见数（期望个位数，非 370）', epCount > 0 && epCount < 20,
    `count=${epCount}, roles=${JSON.stringify((epAll.json || []).reduce((a, r) => (a[r.role] = (a[r.role] || 0) + 1, a), {}))}`);

  const apAll = await adminApi('GET', 'profiles?select=id');
  const apCount = Array.isArray(apAll.json) ? apAll.json.length : -1;
  report('6a. 公司级 REST 直连 profiles 仍全量（期望 370 左右）', apCount > 300, `count=${apCount}`);

  const edAll = await entityApi('GET', 'departments?select=id');
  const adAll = await adminApi('GET', 'departments?select=id');
  report('6b. departments 两账号均全读（设计如此，未收紧）',
    edAll.json.length === adAll.json.length, `entity=${edAll.json.length}, admin=${adAll.json.length}`);

  const failed = results.filter(r => !r.pass);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });

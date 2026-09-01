/**
 * cleanup-e6-testdata.js - 一次性清理 E6 导入测试的 5 条员工数据
 * 逻辑：公司级登录 → 按 remark 含 E6测试 查 training_employees
 *      → 检查是否被培训记录引用（有引用则跳过并报告）→ 删除 → 复核
 */
const SUPABASE_URL = 'https://exwsuwhqqpsqekzkmdol.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4d3N1d2hxcXBzcWVremttZG9sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1MzUyNTcsImV4cCI6MjEwMzExMTI1N30.bMqWlGbJ0IGL9mgT33r9IjUQiJ7E2dwADKHNU04ukW0';

async function api(tok, method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json',
      Prefer: method === 'DELETE' ? 'return=representation' : 'count=exact',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, range: res.headers.get('content-range') };
}

const main = async () => {
  // 登录
  const lr = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({ email: 'jnsun@qq.com', password: '31803180' }),
  });
  const tok = (await lr.json()).access_token;
  if (!tok) throw new Error('登录失败');

  // 1. 查找目标行
  const found = await api(tok, 'GET',
    "training_employees?select=id,name,phone,remark,status&remark=ilike.*E6*");
  const rows = Array.isArray(found.json) ? found.json : [];
  console.log(`匹配 remark 含 E6 的员工 ${rows.length} 条：`);
  rows.forEach(r => console.log(`  ${r.name}  ${r.phone || '-'}  ${r.status}  备注=${r.remark}`));
  if (!rows.length) { console.log('无可清理数据'); return; }

  // 2. 引用检查：培训分配是否引用这些 id
  const ids = rows.map(r => r.id);
  const q = `training_assignments?select=employee_id&employee_id=in.(${ids.join(',')})`;
  const refs = await api(tok, 'GET', q);
  const refRows = Array.isArray(refs.json) ? refs.json : [];
  const referenced = new Set(refRows.map(r => r.employee_id));
  if (referenced.size) {
    console.log(`⚠️ ${referenced.size} 条已被培训记录引用，跳过：`);
    rows.filter(r => referenced.has(r.id)).forEach(r => console.log(`  跳过 ${r.name}`));
  }

  // 3. 删除未被引用的行
  const deletable = rows.filter(r => !referenced.has(r.id));
  if (!deletable.length) { console.log('全部被引用，未删除任何行'); return; }
  const delIds = deletable.map(r => r.id).join(',');
  const del = await api(tok, 'DELETE', `training_employees?id=in.(${delIds})`);
  const deleted = Array.isArray(del.json) ? del.json : [];
  console.log(`已删除 ${deleted.length} 条：${deleted.map(r => r.name).join('、')}`);

  // 4. 复核
  const recheck = await api(tok, 'GET', 'training_employees?select=id&remark=ilike.*E6*');
  console.log(`复核：剩余 remark 含 E6 的记录 ${Array.isArray(recheck.json) ? recheck.json.length : '?'} 条`);
};

main().catch(e => { console.error('异常:', e.message); process.exit(2); });

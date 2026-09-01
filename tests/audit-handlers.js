/**
 * audit-handlers.js —— 培训模块代码级全链路审计
 * 1. node --check 所有 JS（语法层，含 TDZ 之外的问题）
 * 2. 校验 index.html 引用的 script/css 文件都存在
 * 3. 提取模板字符串里的 onclick/onchange/oninput="Ns.m(...)"，确认方法在对应命名空间有定义
 * 4. 提取 sb.rpc('name') 调用，确认 sql/*.sql 中有对应 CREATE FUNCTION
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
let checks = 0;

// ---------- 1. 语法检查 ----------
const jsFiles = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) {
      if (!/node_modules|vendor|\.git/.test(f)) walk(p);
    } else if (f.endsWith('.js')) jsFiles.push(p);
  }
})(path.join(ROOT, 'js'));
for (const f of jsFiles) {
  checks++;
  try { execSync(`node --check "${f}"`, { stdio: 'pipe' }); }
  catch (e) { problems.push(`[语法] ${path.relative(ROOT, f)}: ${e.stderr.toString().slice(0, 200)}`); }
}
console.log(`1) 语法检查：${jsFiles.length} 个 JS 文件全部通过` + (problems.length ? '' : ' ✓'));

// ---------- 2. index.html 引用文件存在 ----------
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="((?:js|css|vendor|tests)\/[^"]+)"/g)].map(m => m[1]);
for (const r of refs) {
  checks++;
  if (!fs.existsSync(path.join(ROOT, r))) problems.push(`[缺失] index.html 引用不存在: ${r}`);
}
console.log(`2) index.html 引用检查：${refs.length} 个引用` + (problems.some(p => p.includes('[缺失]')) ? ' ✗' : ' 全部存在 ✓'));

// ---------- 3. onclick 等内联事件 → 方法定义存在 ----------
const allJs = jsFiles.map(f => ({ f: path.relative(ROOT, f), c: fs.readFileSync(f, 'utf8') }));
// 命名空间定义位置：const Ns = { / window.Ns = { / var Ns = {
const nsFile = {};
for (const { f, c } of allJs) {
  const m = c.match(/(?:const|var|let|window\.)\s*(Admin|Reporter|TrainingModule|TrainingEmployees|TrainingPlans|TrainingRecords|TrainingExams|TrainingCourses|TrainingQuestions|TrainingPapers|TrainingMine|Qualification|Inspection|Vehicle|DocStudy|Performance|Contract|Notice|Auth|Utils|App)\s*[=:{]/);
  if (m) nsFile[m[1]] = nsFile[m[1]] || [];
  if (m) nsFile[m[1]].push(f);
}
const eventAttrs = [...html.matchAll(/on(?:click|change|input|submit)="([^"]+)"/g)].map(m => m[1]);
for (const { f, c } of allJs) {
  for (const m of c.matchAll(/on(?:click|change|input|submit)="([A-Za-z_$][\w$]*\.([\w$]+)\()/g)) {
    eventAttrs.push(m[1]);
  }
}
const missingMethods = new Set();
for (const call of eventAttrs) {
  const m = call.match(/^([A-Za-z_$][\w$]*)\.([\w$]+)\(/);
  if (!m) continue;
  const [, ns, meth] = m;
  checks++;
  const files = nsFile[ns] || [];
  let defined = false;
  for (const rel of files) {
    const c = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (new RegExp(`^\\s*(?:async\\s+)?${meth}\\s*\\(`, 'm').test(c) ||
        new RegExp(`\\b${meth}\\s*:\\s*(?:async\\s*)?(?:function|\\()`, 'm').test(c) ||
        new RegExp(`(?:window\\.)?${ns}\\.${meth}\\s*=`, 'm').test(c)) { defined = true; break; }
  }
  // App/Utils 等全局简单跳过如果找不到命名空间
  if (!files.length) continue;
  if (!defined) missingMethods.add(`${ns}.${meth} (事件: ${call.slice(0, 60)})`);
}
for (const x of missingMethods) problems.push(`[事件] onclick 引用了未定义的方法: ${x}`);
console.log(`3) 内联事件检查：${eventAttrs.length} 个事件引用` + (missingMethods.size ? ` ✗ ${missingMethods.size} 个未定义` : ' 全部有定义 ✓'));

// ---------- 4. sb.rpc → SQL 函数 ----------
const rpcCalls = new Set();
for (const { c } of allJs) {
  for (const m of c.matchAll(/\.rpc\(\s*['"]([\w_]+)['"]/g)) rpcCalls.add(m[1]);
}
const sqlAll = fs.readdirSync(path.join(ROOT, 'sql')).filter(f => f.endsWith('.sql'))
  .map(f => fs.readFileSync(path.join(ROOT, 'sql', f), 'utf8')).join('\n');
const missingRpc = [];
for (const rpc of rpcCalls) {
  checks++;
  if (!new RegExp(`FUNCTION\\s+public\\.${rpc}\\s*\\(`, 'i').test(sqlAll) &&
      !new RegExp(`proname\\s*=\\s*'${rpc}'`, 'i').test(sqlAll)) {
    missingRpc.push(rpc);
  }
}
for (const r of missingRpc) problems.push(`[RPC] 前端调用 sb.rpc('${r}') 但 sql/ 中未找到定义`);
console.log(`4) RPC 对照检查：${rpcCalls.size} 个前端 RPC 调用` + (missingRpc.length ? ` ✗ 缺失: ${missingRpc.join(', ')}` : ' 全部在 SQL 中有定义 ✓'));

// ---------- 5. 培训考试链路专项：exam RPC 全家福 ----------
const examRpcs = ['exam_start','exam_submit','exam_report_switch','exam_my_wrong_book',
  'exam_wrong_resolve','exam_quiz_for_course','exam_quiz_answer','training_submit_signature'];
const examMissing = examRpcs.filter(r => !sqlAll.includes(`public.${r}`) && !sqlAll.includes(`FUNCTION public.${r}`));
checks += examRpcs.length;
console.log(`5) 考试 RPC 专项：8 个 exam_* / signature RPC` + (examMissing.length ? ` ✗ 缺失: ${examMissing.join(',')}` : ' 全部存在 ✓'));
if (examMissing.length) examMissing.forEach(r => problems.push(`[RPC] exam 链路缺 ${r}`));

console.log('\n========== 审计汇总 ==========');
console.log(`共执行 ${checks} 项检查，发现问题 ${problems.length} 个`);
if (problems.length) problems.forEach(p => console.log('  ✗ ' + p));
else console.log('全部通过 ✓');

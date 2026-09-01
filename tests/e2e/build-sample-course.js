/**
 * build-sample-course.js - 从 tools/course-generator.html 中抽取生成逻辑，
 * 在 node 里实际执行一次：产出 tests/e2e/sample-courseware.html
 * 并对内嵌运行时 JS 做 node --check 级语法校验。
 * 用法：node tests/e2e/build-sample-course.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const genPath = path.join(ROOT, 'tools', 'course-generator.html');
const html = fs.readFileSync(genPath, 'utf8');

// 抽取主脚本：独占一行的 <script> 标签之后的代码
const tagMatch = html.match(/^<script>\s*$/m);
if (!tagMatch) { console.error('未找到生成器主 <script> 块'); process.exit(2); }
const start = html.indexOf(tagMatch[0]) + tagMatch[0].length;
const end = html.lastIndexOf('</script>');
const code = html.slice(start, end);

// 最小 DOM stub，让生成器顶层代码（初始 render）能跑
const el = () => ({
  value: '', srcdoc: '', textContent: '', innerHTML: '', disabled: false,
  style: {}, dataset: {}, files: [],
  addEventListener() {}, click() {},
});
const sandbox = {
  document: { getElementById: el, createElement: el },
  window: { addEventListener() {}, parent: {} },
  localStorage: { getItem: () => null, setItem() {} },
  Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  console, setTimeout, Date, JSON, Math,
};
vm.createContext(sandbox);
try {
  vm.runInContext(code + '\n;this.__api = { parseMarkdown, buildCourseHtml, RUNTIME_JS, SAMPLE_MD, escapeHtml };', sandbox);
} catch (e) {
  console.error('生成器脚本执行失败:', e.message);
  process.exit(2);
}
const api = sandbox.__api;

// 1. 解析示例 → 结构校验
const parsed = api.parseMarkdown(api.SAMPLE_MD);
console.log(`示例解析：标题="${parsed.title}"，节数=${parsed.sections.length}`);
parsed.sections.forEach((s, i) =>
  console.log(`  节${i + 1}: "${s.title}" ${s.blocks.length} 个块`));
if (parsed.sections.length < 4) { console.error('节数异常'); process.exit(1); }

// 2. 运行时 JS 语法校验（写入临时文件后 node --check）
const rtPath = path.join(__dirname, '.runtime-check.js');
fs.writeFileSync(rtPath, api.RUNTIME_JS);
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['--check', rtPath]);
fs.unlinkSync(rtPath);
console.log('运行时 JS 语法校验通过');

// 3. 产出示例课件文件
const out = api.buildCourseHtml(parsed.title, parsed.sections, '示例单位');
const outPath = path.join(__dirname, 'sample-courseware.html');
fs.writeFileSync(outPath, out, 'utf8');
console.log(`已生成示例课件: ${outPath}（${(out.length / 1024).toFixed(1)} KB）`);

// 4. 产物完整性抽查
const checks = [
  ['包含门控 CSS（未解锁隐藏）', /\.cw-sec\{display:none/.test(out)],
  ['包含运行时', out.includes('tr-courseware')],
  ['包含 5 个节', (out.match(/class="cw-sec"/g) || []).length === 5],
  ['无未转义的 </script> 冲突', (out.match(/<\/script>/g) || []).length === 1],
];
let bad = 0;
checks.forEach(([name, ok]) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) bad++; });
process.exit(bad ? 1 : 0);

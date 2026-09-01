/**
 * test-courseware-runtime.js - 生成的 HTML 课件运行时行为实测（headless Chrome）
 * 验证：
 *   1. 初始仅第 1 节可见，第 2 节隐藏（门控生效）
 *   2. 「下一节」按钮初始禁用，gate 提示显示驻留要求
 *   3. 停留时间不足时即使滚到底也不解锁
 *   4. 驻留达标 + 滚动到底后按钮启用，点击解锁第 2 节
 *   5. 本地模式进度写入 localStorage，刷新后恢复
 */
const { chromium } = require('C:/Users/sjn/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const http = require('http');

const FILE = 'file:///C:/Users/sjn/WorkBuddy/workbuddynewweb/project-reporting/tests/e2e/sample-courseware.html';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const info = await fetchJson('http://127.0.0.1:9333/json/version');
  const ws = info.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:9333');
  const browser = await chromium.connectOverCDP(ws, { timeout: 20000 });
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
  };

  await page.goto(FILE, { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => localStorage.clear());   // 清掉历史会话进度，从零开始测
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);

  // 1. 门控初始状态
  const vis = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cw-sec'))
      .map(s => getComputedStyle(s).display !== 'none'));
  check('初始仅第 1 节可见', vis[0] === true && vis.slice(1).every(x => !x), JSON.stringify(vis));

  // 2. 按钮初始禁用 + gate 提示
  const btn = page.locator('.cw-sec[data-i="0"] .cw-btn-next');
  check('按钮初始禁用', await btn.isDisabled());
  const msg0 = await page.locator('.cw-sec[data-i="0"] .cw-gate-msg').textContent();
  check('gate 提示含驻留秒数', /驻留 \d+\/\d+ 秒/.test(msg0), msg0.trim());

  // 3. 滚到底但停留不足 → 仍禁用
  await page.evaluate(() => {
    const r = document.querySelector('.cw-sec[data-i="0"]').getBoundingClientRect();
    window.scrollTo(0, Math.max(0, r.bottom - window.innerHeight + 40));
  });
  await page.waitForTimeout(800);
  const msgScroll = await page.locator('.cw-sec[data-i="0"] .cw-gate-msg').textContent();
  check('滚动到底后提示「已读至本节底部」', /已读至本节底部/.test(msgScroll), msgScroll.trim());
  check('停留不足时按钮仍禁用', await btn.isDisabled());

  // 4. 等驻留达标（第 1 节要求 8s）→ 按钮启用
  await page.waitForFunction(
    () => !document.querySelector('.cw-sec[data-i="0"] .cw-btn-next').disabled,
    { timeout: 15000 });
  check('驻留达标后按钮启用', true);

  // 5. 点击解锁第 2 节
  await btn.click();
  await page.waitForTimeout(700);
  const vis2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cw-sec'))
      .map(s => getComputedStyle(s).display !== 'none'));
  check('点击后第 1、2 节可见，第 3 节仍锁', vis2[0] && vis2[1] && vis2.slice(2).every(x => !x),
    JSON.stringify(vis2));
  const doneMsg = await page.locator('.cw-sec[data-i="0"] .cw-gate-msg').textContent();
  check('第 1 节标记已完成', /本节已完成/.test(doneMsg), doneMsg.trim());

  // 6. 本地模式 localStorage + 刷新恢复
  const ls = await page.evaluate(() =>
    localStorage.getItem('tr-course:' + document.title));
  check('本地模式进度已落 localStorage', !!ls && /"done":1/.test(ls), ls);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  const vis3 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cw-sec'))
      .map(s => getComputedStyle(s).display !== 'none'));
  check('刷新后进度恢复（1、2 节可见）', vis3[0] && vis3[1] && vis3.slice(2).every(x => !x),
    JSON.stringify(vis3));

  const pass = results.filter(Boolean).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  await page.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });

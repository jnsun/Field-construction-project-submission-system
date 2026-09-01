/* HTML 增强模式端到端测试（v3）
 * 1) 生成器注入模式：精美样本（h2 嵌在 .wrap 容器内）→ 切出 3 节
 * 2) 产物嵌入宿主模拟页 → 验证门控状态/协议/逐节解锁（动态等待按钮亮起）
 * 3) 整页模式样本（无顶层 h1/h2）→ body 单节
 * 4) 预分节结构（真实文件：地震手册，<section> 各包一个 h2）→ 原地门控 + 重复增强幂等
 * 5) Markdown 模式回归 */
const { chromium } = require('C:/Users/sjn/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const GEN = 'file:///E:/OneDrive/%E5%B7%A5%E4%BD%9C%E7%9B%AE%E5%BD%95/2026/WORKBUDDY/project-reporting/tools/course-generator.html';
const SAMPLE = path.join(__dirname, 'fancy-course-sample.html');
const REAL = 'E:/OneDrive/工作目录/2026/WORKBUDDY/制作公司级培训课件/地震安全手册/运城市地震安全手册 — 防震减灾·守护家园.html';
const OUT = path.join(__dirname, '.enhanced-sections.html');
const OUT2 = path.join(__dirname, '.enhanced-whole.html');
const OUT3 = path.join(__dirname, '.enhanced-pre.html');

const results = [];
function check(name, ok, extra) {
  results.push((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  [' + extra + ']' : ''));
}
function fetchJson(url) {
  return new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
}

(async () => {
  /* ---------- 步骤 1：生成器内增强 ---------- */
  const info = await fetchJson('http://127.0.0.1:9333/json/version');
  const ws = info.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:9333');
  const browser = await chromium.connectOverCDP(ws, { timeout: 20000 });
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 150)));
  await page.goto(GEN, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(800);

  const src = fs.readFileSync(SAMPLE, 'utf8');
  const r1 = await page.evaluate(s => {
    document.getElementById('html-input').value = s;
    setMode('inject');
    render();
    const btn = document.getElementById('btn-download');
    return {
      info: document.getElementById('sec-count').textContent,
      html: currentHtml,
      downloadEnabled: !!btn && !btn.disabled,
    };
  }, src);
  check('增强模式信息提示', /分节模式 · 检测到 3 个顶层标题/.test(r1.info), r1.info);
  check('下载按钮可用', r1.downloadEnabled);
  fs.writeFileSync(OUT, r1.html);

  const wholeSrc = src.replace(/<h2>一、[^<]*<\/h2>/, '').replace(/<h2>二、[^<]*<\/h2>/, '').replace(/<h2>三、[^<]*<\/h2>/, '');
  const r2 = await page.evaluate(s => {
    document.getElementById('html-input').value = s;
    render();
    return { info: document.getElementById('sec-count').textContent, html: currentHtml };
  }, wholeSrc);
  check('整页模式信息提示', /整页模式/.test(r2.info), r2.info);
  fs.writeFileSync(OUT2, r2.html);

  /* ---- 预分节结构：真实地震手册（每个 h2 各包在 <section> 里） ---- */
  let preN = 0;
  if (fs.existsSync(REAL)) {
    const realSrc = fs.readFileSync(REAL, 'utf8');
    const rPre = await page.evaluate(s => {
      document.getElementById('html-input').value = s;
      render();
      return { info: document.getElementById('sec-count').textContent, html: currentHtml };
    }, realSrc);
    check('预分节：信息提示（真实地震手册）', /预分节结构/.test(rPre.info), rPre.info);
    const preEval = await page.evaluate(s => {
      const r = enhanceExistingHtml(s);   /* 第二次增强：验证重复增强清理幂等 */
      return { count: r.count, pre: r.pre, html: r.html };
    }, realSrc);
    preN = preEval.count;
    check('预分节：重复增强后节数一致（幂等）', preEval.pre && preEval.count >= 5, 'count=' + preEval.count + ' pre=' + preEval.pre);
    check('预分节：产物含 data-cw-pre 门控容器',
      (preEval.html.match(/data-cw-pre="1"/g) || []).length === preEval.count,
      'marks=' + (preEval.html.match(/data-cw-pre="1"/g) || []).length);
    check('预分节：产物非整页模式', !/cw-whole/.test(preEval.html));
    fs.writeFileSync(OUT3, preEval.html);
  } else {
    check('预分节：真实文件存在', false, REAL);
  }

  const r3 = await page.evaluate(() => {
    setMode('md');
    return {
      info: document.getElementById('sec-count').textContent,
      ok: currentHtml.includes('cw-sec') && !document.getElementById('btn-download').disabled,
    };
  });
  check('Markdown 模式回归（示例正常生成）', r3.ok && /节/.test(r3.info), r3.info);
  await page.close();

  /* ---------- 步骤 2：宿主模拟页验证 ---------- */
  const DIR = __dirname;
  const srv = http.createServer((req, res) => {
    const rel = req.url === '/' ? '.host-sim2.html' : decodeURIComponent(req.url.replace(/^\//, ''));
    let buf;
    try { buf = fs.readFileSync(path.join(DIR, rel)); }
    catch (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
  const hostSim = (pos) => '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>'
    + '<script>try{localStorage.clear();sessionStorage.clear();}catch(e){}<\/script>'
    + '<iframe id="f" src="' + pos + '" style="width:1000px;height:800px"></iframe>'
    + '<script>window.msgs=[];window.addEventListener("message",function(e){var d=e.data;'
    + 'if(!d||d.source!=="tr-courseware")return;window.msgs.push(JSON.parse(JSON.stringify(d)));'
    + 'if(d.type==="hello"){document.getElementById("f").contentWindow.postMessage({source:"tr-host",type:"hello",position:0},"*");}});<\/script>'
    + '</body></html>';
  srv.listen(8902, '127.0.0.1', async () => {
    try {
      for (const [name, file] of [['分节模式', OUT], ['整页模式', OUT2], ['预分节', OUT3]]) {
        fs.writeFileSync(path.join(DIR, '.host-sim2.html'), hostSim(path.basename(file)));
        const p2 = await ctx.newPage();
        await p2.goto('http://127.0.0.1:8902/', { waitUntil: 'load', timeout: 30000 });
        await p2.waitForTimeout(1500);
        const st = await p2.evaluate(() => {
          const d = document.getElementById('f').contentDocument;
          const ifrUrl = d ? d.location.href : '';
          const secs = d ? d.querySelectorAll('.cw-sec') : [];
          const unlocked = Array.from(secs).map(s => s.classList.contains('cw-unlocked'));
          return {
            ifrUrl: ifrUrl.slice(-45),
            bodyIsSec: d ? d.body.classList.contains('cw-sec') : false,
            n: secs.length,
            unlocked,
            hasBar: d ? !!d.getElementById('cw-bar') : false,
            hasHeader: d ? !!d.querySelector('.cw-inj-header') : false,
            msgs: window.msgs ? window.msgs.map(m => m.type) : [],
          };
        });
        if (name === '分节模式') {
          check('分节：iframe 加载了增强产物', /enhanced-sections/.test(st.ifrUrl), st.ifrUrl);
          check('分节：切出 3 节', st.n === 3, 'n=' + st.n);
          check('分节：进度条/头部注入', st.hasBar && st.hasHeader);
          check('分节：仅第 1 节解锁', st.unlocked[0] && !st.unlocked[1] && !st.unlocked[2], JSON.stringify(st.unlocked));
          check('分节：hello + hello-ack 已发', st.msgs.includes('hello') && st.msgs.includes('hello-ack'), JSON.stringify(st.msgs));
        } else if (name === '预分节') {
          check('预分节：iframe 加载了增强产物', /enhanced-pre/.test(st.ifrUrl), st.ifrUrl);
          check('预分节：节数与生成器一致', st.n === preN, 'n=' + st.n + ' preN=' + preN);
          check('预分节：进度条/头部注入', st.hasBar && st.hasHeader);
          check('预分节：仅第 1 节解锁', st.unlocked[0] && !st.unlocked[1], JSON.stringify(st.unlocked.slice(0, 3)));
          check('预分节：hello + hello-ack 已发', st.msgs.includes('hello') && st.msgs.includes('hello-ack'), JSON.stringify(st.msgs));
        } else {
          check('整页：iframe 加载了增强产物', /enhanced-whole/.test(st.ifrUrl), st.ifrUrl);
          check('整页：body 即唯一节', st.bodyIsSec && st.n === 1, 'bodySec=' + st.bodyIsSec + ' n=' + st.n);
          check('整页：页面可见（未被锁定隐藏）', st.unlocked[0] === true, JSON.stringify(st.unlocked));
          check('整页：协议握手', st.msgs.includes('hello') && st.msgs.includes('hello-ack'), JSON.stringify(st.msgs));
        }
        /* 滚到底 → 动态等待驻留门槛 → 按钮自动亮起 → 点击 → 解锁下一节 + progress */
        await p2.evaluate(() => {
          const w = document.getElementById('f').contentWindow;
          w.scrollTo(0, w.document.body.scrollHeight);
        });
        let unlockedNext = false, progMsgs = [];
        try {
          await p2.waitForFunction(() => {
            const d = document.getElementById('f') && document.getElementById('f').contentDocument;
            const b = d && d.querySelector('.cw-sec:not([style*="none"]) .cw-btn-next');
            return b && !b.disabled;
          }, null, { timeout: 100000, polling: 500 });
          const clickRes = await p2.evaluate(() => {
            const d = document.getElementById('f').contentDocument;
            const btns = Array.from(d.querySelectorAll('.cw-btn-next')).filter(b => !b.disabled);
            btns[0].click();
            return { clicked: true };
          });
          await p2.waitForTimeout(700);
          const after = await p2.evaluate(() => ({
            msgs: window.msgs.map(m => m.type + (m.progress !== undefined ? ':' + m.progress : '')),
            unlocked: Array.from(document.getElementById('f').contentDocument.querySelectorAll('.cw-sec'))
              .map(s => s.classList.contains('cw-unlocked')),
          }));
          unlockedNext = name !== '整页模式' ? after.unlocked[1] === true : after.msgs.some(m => m.startsWith('progress:100'));
          progMsgs = after.msgs;
        } catch (e) {
          progMsgs = ['等待按钮亮起超时: ' + e.message.slice(0, 60)];
        }
        check(name + '：驻留+滚到底后按钮解锁并点击生效', unlockedNext, JSON.stringify(progMsgs) + ' unlocked[1]=' + unlockedNext);
        await p2.close();
      }
      srv.close();
      console.log(results.join('\n'));
      const fails = results.filter(r => r.startsWith('FAIL')).length;
      console.log('\n===== ' + (results.length - fails) + '/' + results.length + ' 通过 =====');
      process.exit(fails ? 1 : 0);
    } catch (e) {
      console.error('异常:', e.message.slice(0, 200));
      process.exit(2);
    }
  });
})().catch(e => { console.error('异常:', e.message.slice(0, 200)); process.exit(2); });

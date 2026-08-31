// =============================================================
// js/modules/training/mine.js —— 员工端「我的培训」
//
// 员工登录后只看得到指派给自己的培训任务。
// 课件进度达到 90% 才算完成；全部必修课件完成后由数据库自动记录学时与完成时间。
//
// 进度判定规则：
//   视频  按播放到的最大秒数 / 总时长，并限制拖拽跳看
//   PDF   按翻到的最大页码 / 总页数（pdf.js 逐页渲染，vendor/pdf.min.js）
//   图文  正文滚动到底部
//   图片 / 外链  由员工确认「已学习完毕」
// =============================================================
const TrainingMine = {

  PASS: 90,                 // 达到该百分比视为课件完成

  state: {
    list: [],
    plan: null,
    courses: [],
    progress: {},           // course_id -> { progress, max_position, finished }
    saving: false,
    pending: null,
  },

  TYPE_LABEL: {
    pdf: 'PDF 文档', video: '视频', image: '图片', text: '图文', link: '外链',
  },

  // ---------------------------------------------------------------- 列表
  async render(box) {
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="text-muted">下面是分配给您的培训任务，请在截止日期前完成学习。</span>
        </div>
      </div>
      <div id="mine-list"></div>
    `;
    await this.load();
  },

  async load() {
    const { data, error } = await sb.rpc('training_my_trainings');
    if (error) throw error;
    this.state.list = data || [];
    this.renderList();
  },

  renderList() {
    const box = document.getElementById('mine-list');
    if (!box) return;
    const rows = this.state.list;

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>我的培训（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>培训名称</th>
                <th style="width:110px">截止日期</th>
                <th style="width:80px">学时</th>
                <th style="width:180px">学习进度</th>
                <th style="width:90px">状态</th>
                <th style="width:100px">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(6, '暂无分配给您的培训任务')
                : rows.map(r => {
                    const pct = Number(r.progress || 0);
                    const cls = r.status === 'completed' ? '#22c55e'
                      : (r.status === 'overdue' ? '#ef4444' : '#f59e0b');
                    return `
                    <tr>
                      <td title="${Utils.escapeHtml(r.title)}">${Utils.escapeHtml(r.title)}</td>
                      <td>${Utils.escapeHtml(r.deadline || '—')}</td>
                      <td>${r.required_hours != null ? r.required_hours : '—'}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:8px">
                          <div style="flex:1;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:${cls}"></div>
                          </div>
                          <span style="width:70px;font-size:12px;color:#6b7280">
                            ${r.course_done}/${r.course_total} 课件
                          </span>
                        </div>
                      </td>
                      <td>${this.statusBadge(r.status)}</td>
                      <td>
                        <button class="btn btn-sm btn-primary" onclick="TrainingMine.openLearn('${r.plan_id}')">
                          ${r.status === 'completed' ? '查看' : '去学习'}
                        </button>
                      </td>
                    </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  statusBadge(s) {
    if (s === 'completed') return '<span class="badge badge-success">已完成</span>';
    if (s === 'overdue') return '<span class="badge badge-danger">已逾期</span>';
    if (s === 'learning') return '<span class="badge badge-info">学习中</span>';
    return '<span class="badge badge-warning">未开始</span>';
  },

  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  close() {
    const d = document.getElementById('training-modal-host');
    if (d) d.innerHTML = '';
  },

  // ---------------------------------------------------------------- 学习页
  async openLearn(planId) {
    const r = this.state.list.find(x => x.plan_id === planId);
    if (!r) return;
    this.state.plan = r;
    this.state.activeId = '';

    const [{ data: courses, error: e1 }, { data: prog, error: e2 }] = await Promise.all([
      sb.from('training_courses').select('*').eq('plan_id', planId).order('sort_order'),
      sb.from('training_course_progress').select('course_id, progress, max_position, finished'),
    ]);
    if (e1) { alert('加载课件失败：' + e1.message); return; }
    if (e2) { alert('加载学习进度失败：' + e2.message); return; }

    this.state.courses = courses || [];
    this.state.progress = {};
    (prog || []).forEach(p => { this.state.progress[p.course_id] = p; });

    if (!this.state.courses.length) {
      alert('该培训还没有课件，请联系管理员添加后再学习。');
      return;
    }
    this.renderLearn();
    this.openCourse(this.state.courses[0].id);
  },

  fileUrl(c) {
    if (!c.file_path) return c.file_url || '';
    const { data } = sb.storage.from('training-courses').getPublicUrl(c.file_path);
    return data ? data.publicUrl : '';
  },

  renderLearn() {
    const r = this.state.plan;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingMine.close()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:1000px">
          <div class="modal-header">
            <h3>${Utils.escapeHtml(r.title)}</h3>
            <button class="modal-close" onclick="TrainingMine.close()">×</button>
          </div>
          <div class="modal-body" style="display:flex;gap:12px;align-items:flex-start">
            <div style="width:220px;flex:none">
              <div class="text-muted" style="font-size:12px;margin-bottom:6px">课件列表</div>
              <div id="learn-nav"></div>
            </div>
            <div style="flex:1;min-width:0">
              <div id="learn-stage" style="min-height:420px"></div>
            </div>
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <span id="learn-hint" class="text-muted" style="font-size:12px"></span>
            <button class="btn btn-secondary" onclick="TrainingMine.finishLearn()">关闭</button>
          </div>
        </div>
      </div>
    `;
    this.renderNav();
  },

  renderNav() {
    const box = document.getElementById('learn-nav');
    if (!box) return;
    box.innerHTML = this.state.courses.map(c => {
      const p = this.state.progress[c.id];
      const pct = p ? Number(p.progress || 0) : 0;
      const active = c.id === this.state.activeId;
      const done = p && p.finished;
      return `
        <div onclick="TrainingMine.openCourse('${c.id}')"
          style="padding:8px 10px;margin-bottom:6px;border-radius:6px;cursor:pointer;
                 border:1px solid ${active ? '#4f46e5' : '#e5e7eb'};
                 background:${active ? '#eef2ff' : '#fff'}">
          <div style="font-size:13px;font-weight:500;color:#111827">
            ${done ? '<span style="color:#22c55e">✓</span> ' : ''}${Utils.escapeHtml(c.title)}
          </div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px">
            ${this.TYPE_LABEL[c.course_type] || c.course_type}
            ${c.required ? ' · 必修' : ' · 选修'}
          </div>
          <div style="height:4px;background:#e5e7eb;border-radius:2px;margin-top:5px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${done ? '#22c55e' : '#4f46e5'}"></div>
          </div>
        </div>`;
    }).join('');
  },

  async openCourse(courseId) {
    this.state.activeId = courseId;
    this.renderNav();

    const c = this.state.courses.find(x => x.id === courseId);
    const stage = document.getElementById('learn-stage');
    const p = this.state.progress[courseId] || {};
    const hint = document.getElementById('learn-hint');
    if (hint) {
      hint.textContent = c.required
        ? '这是必修课件，学到 90% 以上才会计入完成。'
        : '这是选修课件，不影响完成判定。';
    }
    if (!stage || !c) return;

    if (c.course_type === 'video') this.renderVideo(stage, c, p);
    else if (c.course_type === 'pdf') this.renderPdf(stage, c, p);
    else if (c.course_type === 'image') this.renderImage(stage, c, p);
    else if (c.course_type === 'text') this.renderText(stage, c, p);
    else this.renderLink(stage, c, p);
  },

  // ------------------------------------------------------------- 进度上报
  async report(courseId, pct, position) {
    const prev = this.state.progress[courseId] || { progress: 0, max_position: 0 };
    const p = Math.min(100, Math.max(Number(prev.progress || 0), Number(pct || 0)));
    const pos = Math.max(Number(prev.max_position || 0), Number(position || 0));

    // 变化太小就不打搅数据库（完成时必须上报一次）
    if (p < this.PASS && p - Number(prev.progress || 0) < 5) return;

    this.state.progress[courseId] = {
      progress: p, max_position: pos, finished: p >= this.PASS,
    };
    this.renderNav();

    if (this.state.saving) return;
    this.state.saving = true;
    try {
      const { data } = await sb.rpc('training_save_course_progress', {
        p_course_id: courseId, p_progress: p, p_position: pos,
      });
      if (data && data.completed) {
        const hint = document.getElementById('learn-hint');
        if (hint) hint.innerHTML = '<b style="color:#22c55e">全部必修课件已完成，系统已自动记录本次培训。</b>';
        await this.load();
      }
    } catch (e) {
      // 静默失败，下次继续上报
    } finally {
      this.state.saving = false;
    }
  },

  // ------------------------------------------------------------- 各类渲染
  renderVideo(stage, c, p) {
    const last = Number(p.max_position || 0);
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <video id="learn-video" controls controlsList="nodownload"
        style="width:100%;max-height:60vh;background:#000;border-radius:6px" preload="metadata">
        <source src="${Utils.escapeHtml(this.fileUrl(c))}">
        您的浏览器不支持视频播放
      </video>
      <p class="text-muted" style="font-size:12px;margin-top:6px">
        必须完整观看，快进跳过的部分不计入进度。
      </p>
    `;
    const v = document.getElementById('learn-video');
    if (!v) return;
    let maxT = last;
    v.addEventListener('loadedmetadata', () => { if (maxT > 0) v.currentTime = maxT; });
    v.addEventListener('timeupdate', () => {
      if (!v.duration) return;
      if (v.currentTime > maxT) maxT = v.currentTime;
      this.report(c.id, (v.currentTime / v.duration) * 100, v.currentTime);
    });
    // 防拖拽：跳到没看过的位置就拉回
    v.addEventListener('seeking', () => {
      if (v.currentTime > maxT + 5) v.currentTime = maxT;
    });
  },

  async renderPdf(stage, c, p) {
    stage.innerHTML = `
      <div style="max-width:760px;margin:0 auto">
        <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
        <div id="pdf-stage" class="text-muted">正在加载 PDF…</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
          <button class="btn btn-sm btn-secondary" onclick="TrainingMine.pdfPage(-1)">上一页</button>
          <span id="pdf-page-label" style="font-size:13px">—</span>
          <button class="btn btn-sm btn-secondary" onclick="TrainingMine.pdfPage(1)">下一页</button>
          <span class="text-muted" style="font-size:12px;margin-left:8px">需翻到最后几页才算学完</span>
        </div>
      </div>
    `;

    if (typeof pdfjsLib === 'undefined') {
      document.getElementById('pdf-stage').innerHTML =
        '<span style="color:#b91c1c">PDF 组件未加载，请刷新页面重试。</span>';
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('vendor/pdf.worker.min.js', document.baseURI).href;

    try {
      // 带进度反馈：大文件 / 弱网下载慢时能看到"已下载 x MB"，不再黑盒等待
      const task = pdfjsLib.getDocument(this.fileUrl(c));
      task.onProgress = (d) => {
        const box = document.getElementById('pdf-stage');
        if (!box || !d) return;
        const loaded = ((d.loaded || 0) / 1048576).toFixed(1);
        const total = d.total ? ' / ' + (d.total / 1048576).toFixed(1) + ' MB' : ' MB';
        box.textContent = `正在加载 PDF…（已下载 ${loaded}${total}，文件较大时请耐心等待）`;
      };
      const pdf = await task.promise;
      this.state.pdf = { doc: pdf, page: Math.max(1, Math.min(pdf.numPages, Number(p.max_position || 1))), max: Number(p.max_position || 1) };
      this.pdfRender();
      this.report(c.id, (this.state.pdf.max / pdf.numPages) * 100, this.state.pdf.max);
    } catch (e) {
      document.getElementById('pdf-stage').innerHTML =
        `<span style="color:#b91c1c">PDF 加载失败：${Utils.escapeHtml(e.message || '')}</span>`;
    }
  },

  pdfPage(delta) {
    const s = this.state.pdf;
    if (!s) return;
    s.page = Math.max(1, Math.min(s.doc.numPages, s.page + delta));
    s.max = Math.max(s.max, s.page);
    this.pdfRender();
    const c = this.state.courses.find(x => x.id === this.state.activeId);
    if (c) this.report(c.id, (s.max / s.doc.numPages) * 100, s.max);
  },

  async pdfRender() {
    const s = this.state.pdf;
    const box = document.getElementById('pdf-stage');
    if (!s || !box) return;
    // 等一帧让布局稳定后再量宽，避免初次渲染量到 0 或错误宽度
    await new Promise(r => requestAnimationFrame(r));
    const page = await s.doc.getPage(s.page);
    let containerWidth = box.clientWidth;
    if (!containerWidth) {
      const wrap = box.parentElement;
      containerWidth = (wrap && wrap.clientWidth)
        || Math.min(600, (window.innerWidth || 600) - 48);
    }
    const base = page.getViewport({ scale: 1 });
    const scale = Math.max(0.2, containerWidth / base.width);
    const viewport = page.getViewport({ scale });

    box.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = '100%';
    canvas.style.maxWidth = '760px';
    canvas.style.height = 'auto';
    canvas.style.display = 'block';
    canvas.style.margin = '0 auto';
    canvas.style.border = '1px solid #e5e7eb';
    canvas.style.borderRadius = '4px';
    box.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const label = document.getElementById('pdf-page-label');
    if (label) label.textContent = `第 ${s.page} / ${s.doc.numPages} 页`;
  },

  renderImage(stage, c, p) {
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <img src="${Utils.escapeHtml(this.fileUrl(c))}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
      <div style="margin-top:10px">
        <button class="btn btn-primary btn-sm" onclick="TrainingMine.report('${c.id}', 100, 1)">
          我已看完这份课件
        </button>
      </div>
    `;
  },

  renderText(stage, c, p) {
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <div id="text-body" style="max-height:52vh;overflow:auto;padding:12px;border:1px solid #e5e7eb;border-radius:6px;line-height:1.8">
        ${(c.content || '').replace(/\n/g, '<br>')}
      </div>
      <p class="text-muted" style="font-size:12px;margin-top:6px">把内容滚动到底部即视为学完。</p>
    `;
    const body = document.getElementById('text-body');
    if (!body) return;
    body.addEventListener('scroll', () => {
      const remain = body.scrollHeight - body.scrollTop - body.clientHeight;
      const pct = body.scrollHeight ? ((body.scrollTop + body.clientHeight) / body.scrollHeight) * 100 : 100;
      if (remain < 20) this.report(c.id, 100, 1);
      else this.report(c.id, pct, body.scrollTop);
    });
  },

  renderLink(stage, c, p) {
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <p class="text-muted">这是外部链接课件，请点开学习后回来确认。</p>
      <div style="margin:10px 0">
        <a href="${Utils.escapeHtml(c.file_url || '')}" target="_blank" rel="noopener"
          class="btn btn-secondary btn-sm">打开外链</a>
      </div>
      <button class="btn btn-primary btn-sm" onclick="TrainingMine.report('${c.id}', 100, 1)">
        我已学习完毕
      </button>
    `;
  },

  async finishLearn() {
    this.close();
    await this.load();
  },
};

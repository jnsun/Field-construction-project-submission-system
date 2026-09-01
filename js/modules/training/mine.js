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
        <div class="toolbar-right">
          <button class="btn btn-secondary btn-sm" onclick="TrainingMine.openWrongBook()">我的错题本</button>
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

    // 考试状态 / 签字状态（本人 assignments，RLS 保证只读自己的）
    const ids = this.state.list.map(r => r.plan_id);
    this.state.asgMap = {};
    if (ids.length) {
      const { data: asg } = await sb.from('training_assignments')
        .select('id, plan_id, exam_status, exam_attempts, status, progress, completed_at, training_signatures(assignment_id)')
        .in('plan_id', ids);
      (asg || []).forEach(a => { this.state.asgMap[a.plan_id] = a; });
    }
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
                    const a = this.state.asgMap ? (this.state.asgMap[r.plan_id] || {}) : {};
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
                      <td>${this.statusBadge(r.status)}${this.examBadge(a.exam_status)}</td>
                      <td>
                        <button class="btn btn-sm btn-primary" onclick="TrainingMine.openLearn('${r.plan_id}')">
                          ${r.status === 'completed' ? '查看' : '去学习'}
                        </button>
                        ${this.examAction(r, a)}
                        ${this.signAction(r, a)}
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

  examBadge(es) {
    if (es === 'passed') return ' <span class="badge badge-success">考试通过</span>';
    if (es === 'failed') return ' <span class="badge badge-danger">未通过</span>';
    if (es === 'pending') return ' <span class="badge badge-warning">待考试</span>';
    if (es === 'ongoing') return ' <span class="badge badge-info">考试中</span>';
    return '';
  },

  examAction(r, a) {
    const es = a.exam_status;
    if (es === 'passed') return '';
    if (es === 'pending' || es === 'ongoing' || es === 'failed') {
      const label = es === 'ongoing' ? '继续考试' : (es === 'failed' ? '再考一次' : '开始考试');
      return `<button class="btn btn-sm btn-danger" onclick="TrainingMine.openExam('${r.plan_id}')">${label}</button>`;
    }
    return '';
  },

  signAction(r, a) {
    const signed = a.training_signatures && a.training_signatures.length > 0;
    const canSign = (r.status === 'completed' || a.exam_status === 'passed') && !signed;
    return canSign
      ? `<button class="btn btn-sm btn-primary" onclick="TrainingMine.openSign('${a.id}')">签字确认</button>`
      : '';
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
        const mode = this.state.plan?.exam_mode || 'none';
        const msg = mode === 'none'
          ? '全部必修课件已完成，系统已自动记录本次培训。'
          : '全部必修课件已学完，请返回列表开始考试，考试通过并签字后本次培训才会归档。';
        if (hint) hint.innerHTML = `<b style="color:#22c55e">${msg}</b>`;
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

  // ---------------------------------------------------------------- 考试
  async openExam(planId) {
    try {
      const { data, error } = await sb.rpc('exam_start', { p_plan_id: planId });
      if (error) { alert(error.message); return; }
      this.state.exam = {
        attemptId: data.attempt_id,
        deadline: new Date(data.deadline_at),
        totalScore: data.total_score,
        questions: data.questions || [],
      };
      this.renderExamModal();
    } catch (e) {
      alert('开考失败：' + (e.message || e));
    }
  },

  renderExamModal() {
    const ex = this.state.exam;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingMine.closeExam()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:820px">
          <div class="modal-header">
            <h3>在线考试</h3>
            <span id="exam-timer" style="font-weight:600;color:#b91c1c;font-size:15px">--:--</span>
          </div>
          <div class="modal-body">
            <p class="hint" style="font-size:12px;margin-bottom:12px">
              共 ${ex.questions.length} 题，总分 ${ex.totalScore} 分。切屏会被记录，请专注作答；到时自动交卷。
            </p>
            ${ex.questions.map((q, idx) => this.renderQuestion(q, idx)).join('')}
          </div>
          <div class="modal-footer" style="justify-content:space-between">
            <span class="hint" style="font-size:12px">答完请点「交卷」，未提交不保存答案</span>
            <button class="btn btn-primary" onclick="TrainingMine.submitExam()">交卷</button>
          </div>
        </div>
      </div>
    `;
    this.attachSwitchWatch();
    this.startTimer();
  },

  renderQuestion(q, idx) {
    const head = `
      <div style="margin:14px 0 8px">
        <b style="font-size:14px">${idx + 1}. ${this.TYPE_LABEL[q.type] || ''}（${q.score} 分）</b>
        <div style="margin-top:6px;line-height:1.7;white-space:pre-wrap">${Utils.escapeHtml(q.stem)}</div>
      </div>`;
    if (q.type === 'case') {
      const subs = q.sub_questions || [];
      return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px">
        ${head}
        ${subs.map((s, i) => `
          <div style="margin-top:10px">
            <div style="font-size:13px;font-weight:500">（${i + 1}）${Utils.escapeHtml(s.stem || '')}</div>
            ${(s.options || []).map(k => `
              <label style="display:flex;gap:8px;align-items:center;padding:5px 10px;margin:4px 0;
                border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px">
                <input type="radio" name="q-${q.id}-${i}" value="${k.key}" style="width:15px;height:15px">
                <span><b>${k.key}.</b> ${Utils.escapeHtml(k.text)}</span>
              </label>`).join('')}
          </div>`).join('')}
      </div>`;
    }
    const name = `q-${q.id}`;
    return `<div style="margin-bottom:10px">${head}
      ${(q.options || []).map(k => `
        <label style="display:flex;gap:8px;align-items:flex-start;padding:7px 10px;margin-bottom:5px;
          border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-size:13px;line-height:1.5">
          <input type="${q.type === 'multi' ? 'checkbox' : 'radio'}" name="${name}" value="${k.key}"
            style="margin-top:2px;width:15px;height:15px;flex:none">
          <span><b>${k.key}.</b> ${Utils.escapeHtml(k.text)}</span>
        </label>`).join('')}
      ${q.type === 'multi' ? '<p class="hint" style="font-size:12px">多选题：全部选对才得分</p>' : ''}
    </div>`;
  },

  startTimer() {
    this.stopTimer();
    const tick = () => {
      const el = document.getElementById('exam-timer');
      if (!el) { this.stopTimer(); return; }
      const ms = this.state.exam.deadline - Date.now();
      if (ms <= 0) {
        el.textContent = '00:00';
        this.stopTimer();
        alert('考试时间已到，系统自动交卷');
        this.submitExam(true);
        return;
      }
      const m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000);
      el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    tick();
    this.state.examTimer = setInterval(tick, 1000);
  },

  stopTimer() {
    if (this.state.examTimer) { clearInterval(this.state.examTimer); this.state.examTimer = null; }
  },

  attachSwitchWatch() {
    this.detachSwitchWatch();
    this.state.switchHandler = () => {
      if (document.visibilityState === 'hidden' && this.state.exam) {
        sb.rpc('exam_report_switch', { p_attempt_id: this.state.exam.attemptId }).then(() => {}, () => {});
      }
    };
    document.addEventListener('visibilitychange', this.state.switchHandler);
  },

  detachSwitchWatch() {
    if (this.state.switchHandler) {
      document.removeEventListener('visibilitychange', this.state.switchHandler);
      this.state.switchHandler = null;
    }
  },

  async submitExam(auto) {
    const ex = this.state.exam;
    if (!ex) return;
    if (this.state.submitting) return;
    if (!auto && !confirm('确定交卷？交卷后立即判分，无法修改。')) return;
    this.state.submitting = true;

    const answers = {};
    ex.questions.forEach(q => {
      if (q.type === 'case') {
        const arr = [];
        (q.sub_questions || []).forEach((s, i) => {
          const el = document.querySelector(`input[name="q-${q.id}-${i}"]:checked`);
          arr.push(el ? el.value : '');
        });
        answers[q.id] = arr;
      } else if (q.type === 'multi') {
        answers[q.id] = [...document.querySelectorAll(`input[name="q-${q.id}"]:checked`)]
          .map(x => x.value).sort().join('');
      } else {
        const el = document.querySelector(`input[name="q-${q.id}"]:checked`);
        answers[q.id] = el ? el.value : '';
      }
    });

    try {
      const { data, error } = await sb.rpc('exam_submit', {
        p_attempt_id: ex.attemptId, p_answers: answers,
      });
      if (error) { alert('交卷失败：' + error.message); return; }
      this.stopTimer();
      this.detachSwitchWatch();
      this.renderExamResult(data);
    } catch (e) {
      alert('交卷失败：' + (e.message || e));
    } finally {
      this.state.submitting = false;
    }
  },

  renderExamResult(res) {
    const pass = res.result === 'pass';
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingMine.closeExam()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:460px">
          <div class="modal-header">
            <h3>考试结果</h3>
            <button class="modal-close" onclick="TrainingMine.closeExam()">×</button>
          </div>
          <div class="modal-body" style="text-align:center;padding:32px 24px">
            <div style="font-size:44px;font-weight:600;color:${pass ? '#22c55e' : '#ef4444'}">${res.score}</div>
            <div style="font-size:13px;color:#64748b;margin:6px 0 14px">及格线 ${res.pass_line} 分</div>
            <div>${pass
              ? '<span class="badge badge-success" style="font-size:14px;padding:6px 16px">恭喜通过！请回到任务列表完成签字确认</span>'
              : '<span class="badge badge-danger" style="font-size:14px;padding:6px 16px">未通过，可在错题本复习后再考</span>'}</div>
            ${res.timeout ? '<p class="hint" style="font-size:12px;margin-top:10px">本场考试已超时，按已答内容判分</p>' : ''}
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="TrainingMine.closeExam()">知道了</button>
          </div>
        </div>
      </div>`;
  },

  async closeExam() {
    this.stopTimer();
    this.detachSwitchWatch();
    this.host().innerHTML = '';
    this.state.exam = null;
    await this.load();
  },

  // ---------------------------------------------------------------- 错题本
  async openWrongBook() {
    const { data, error } = await sb.rpc('exam_my_wrong_book', { p_unresolved_only: false });
    if (error) { alert('加载失败：' + error.message); return; }
    const rows = data || [];
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingMine.closeSimple()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:720px">
          <div class="modal-header">
            <h3>我的错题本（${rows.length}）</h3>
            <button class="modal-close" onclick="TrainingMine.closeSimple()">×</button>
          </div>
          <div class="modal-body">
            ${rows.length === 0
              ? '<p class="text-muted" style="text-align:center;padding:24px">暂无错题，继续保持！</p>'
              : rows.map(w => `
                <div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:10px">
                  <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
                    <span class="badge badge-muted">${this.TYPE_LABEL[w.question_type] || w.question_type}</span>
                    ${w.resolved ? '<span class="badge badge-success">已掌握</span>' : ''}
                    ${w.course_title ? `<span class="hint" style="font-size:12px">关联课件：${Utils.escapeHtml(w.course_title)}</span>` : ''}
                  </div>
                  <div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${Utils.escapeHtml(w.stem)}</div>
                  <div style="font-size:13px;margin-top:8px">
                    <span style="color:#ef4444">我的答案：${Utils.escapeHtml(w.my_answer || '未作答')}</span>
                    <span style="color:#22c55e;margin-left:12px">正确答案：${Utils.escapeHtml(w.correct_answer || '')}</span>
                  </div>
                  ${w.analysis ? `<div class="hint" style="font-size:12px;margin-top:6px;line-height:1.6">解析：${Utils.escapeHtml(w.analysis)}</div>` : ''}
                  ${!w.resolved ? `<button class="btn btn-sm btn-secondary" style="margin-top:8px"
                    onclick="TrainingMine.resolveWrong('${w.question_id}', this)">我已掌握</button>` : ''}
                </div>`).join('')}
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingMine.closeSimple()">关闭</button>
          </div>
        </div>
      </div>`;
  },

  async resolveWrong(qid, btn) {
    const { error } = await sb.rpc('exam_wrong_resolve', { p_question_id: qid });
    if (error) { alert(error.message); return; }
    btn.textContent = '已掌握';
    btn.disabled = true;
  },

  closeSimple() {
    this.host().innerHTML = '';
  },

  // ---------------------------------------------------------------- 签字
  openSign(assignmentId) {
    this.state.signAsg = assignmentId;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingMine.closeSimple()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>培训完成签字确认</h3>
            <button class="modal-close" onclick="TrainingMine.closeSimple()">×</button>
          </div>
          <div class="modal-body">
            <p class="hint" style="font-size:13px;margin-bottom:10px">
              请在下方空白处<b>手写签名</b>，确认本人已完成本次培训。签字将留档备查。
            </p>
            <canvas id="sign-canvas" width="600" height="220"
              style="width:100%;border:1.5px dashed #c7d0dc;border-radius:10px;touch-action:none;
                     background:#fff;cursor:crosshair"></canvas>
            <div style="display:flex;gap:10px;margin-top:10px;align-items:center">
              <button class="btn btn-sm btn-secondary" onclick="TrainingMine.clearSign()">清除重写</button>
              <span class="hint" style="font-size:12px">请用手指或鼠标在框内签名</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="TrainingMine.saveSign()">确认签字</button>
            <button class="btn btn-secondary" onclick="TrainingMine.closeSimple()">取消</button>
          </div>
        </div>
      </div>`;
    this.initSignCanvas();
  },

  initSignCanvas() {
    const cv = document.getElementById('sign-canvas');
    const ctx = cv.getContext('2d');
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
    this.state.signHasDrawn = false;
    let drawing = false;
    const pos = e => {
      const r = cv.getBoundingClientRect();
      return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
    };
    cv.onpointerdown = e => {
      drawing = true; cv.setPointerCapture(e.pointerId);
      const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
    };
    cv.onpointermove = e => {
      if (!drawing) return;
      const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
      this.state.signHasDrawn = true;
    };
    cv.onpointerup = cv.onpointerleave = () => { drawing = false; };
  },

  clearSign() {
    const cv = document.getElementById('sign-canvas');
    if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    this.state.signHasDrawn = false;
  },

  async saveSign() {
    if (!this.state.signHasDrawn) { alert('请先在框内签名'); return; }
    const cv = document.getElementById('sign-canvas');
    const blob = await (await fetch(cv.toDataURL('image/png'))).blob();
    const path = `signatures/${this.state.signAsg}_${Date.now()}.png`;
    const { error: upErr } = await sb.storage.from('training-courses')
      .upload(path, blob, { contentType: 'image/png' });
    if (upErr) { alert('签字上传失败：' + upErr.message); return; }
    const { error } = await sb.rpc('training_submit_signature', {
      p_assignment_id: this.state.signAsg, p_path: path,
      p_device: (navigator.userAgent || '').slice(0, 200),
    });
    if (error) { alert('签字失败：' + error.message); return; }
    if (Utils.toast) Utils.toast('签字成功，培训已完成！');
    this.closeSimple();
    await this.load();
  },
};

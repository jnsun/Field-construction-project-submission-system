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
//   HTML  Markdown 生成的单文件课件（tools/course-generator.html 产出），
//         iframe 加载，课件内按「节」门控防一滑到底；postMessage 上报：
//         progress(已解锁节/总节) → training_save_course_progress；
//         heartbeat(20s 有效时长) → training_course_heartbeat（学时/防刷）
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
    htmlCourse: null,       // 当前打开的 HTML 课件 { courseId }（message 校验用）
    hbSessions: {},         // course_id -> 心跳会话 id（training_study_logs.id）
    fileUrls: {},           // course_id -> 短期签名链接
    studyQuizPassed: {},    // course_id -> 已通过的学习确认节点
    studyQuizPending: null,
    pendingProgress: {},    // 弱网时待回传的课件进度（只保存在当前账号的浏览器中）
    queueKey: '',
    queueUserId: '',
    syncFlushing: false,
    networkBound: false,
  },

  TYPE_LABEL: {
    pdf: 'PDF 文档', video: '视频', image: '图片', text: '图文', link: '外链',
    html: 'HTML 课件', ppt: 'PPT',
  },

  // ---------------------------------------------------------------- 列表
  async render(box) {
    await this.initWeakNetworkSupport();
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

  // 弱网现场：先把已产生的学习进度放在当前账号的本机缓冲中，恢复网络后再由服务端复核。
  async initWeakNetworkSupport() {
    const { data } = await sb.auth.getSession();
    const uid = data?.session?.user?.id;
    if (uid && this.state.queueUserId !== uid) {
      // 公用手机切换账号时绝不复用上一人的缓冲进度。
      this.state.queueUserId = uid;
      this.state.queueKey = `training-pending-progress-v1:${uid}`;
      try { this.state.pendingProgress = JSON.parse(localStorage.getItem(this.state.queueKey) || '{}') || {}; } catch (_) { this.state.pendingProgress = {}; }
    }
    if (!this.state.networkBound) {
      this.state.networkBound = true;
      window.addEventListener('online', () => {
        this.updateWeakNetworkHint();
        this.flushPendingProgress();
      });
      window.addEventListener('offline', () => this.updateWeakNetworkHint());
    }
    if (navigator.onLine) this.flushPendingProgress();
  },

  persistPendingProgress() {
    if (!this.state.queueKey) return;
    try { localStorage.setItem(this.state.queueKey, JSON.stringify(this.state.pendingProgress)); } catch (_) { /* 本机存储不可用时仍保留当前页面内存 */ }
  },

  queueProgress(courseId, progress, position) {
    const old = this.state.pendingProgress[courseId] || {};
    this.state.pendingProgress[courseId] = {
      progress: Math.max(Number(old.progress || 0), Number(progress || 0)),
      position: Math.max(Number(old.position || 0), Number(position || 0)),
      queuedAt: Date.now(),
    };
    this.persistPendingProgress();
    this.updateWeakNetworkHint();
  },

  updateWeakNetworkHint() {
    const hint = document.getElementById('learn-sync-status');
    if (!hint) return;
    const count = Object.keys(this.state.pendingProgress || {}).length;
    if (!navigator.onLine) {
      hint.innerHTML = `<span style="color:#b45309">当前网络不稳定，${count || '新的'}学习进度已暂存，恢复网络后自动上传。</span>`;
    } else if (count) {
      hint.innerHTML = `<span style="color:#2563eb">有 ${count} 项学习进度正在同步，请保持页面打开。</span>`;
    } else {
      hint.textContent = '学习进度已同步';
    }
  },

  async flushPendingProgress() {
    if (this.state.syncFlushing || !navigator.onLine || !Object.keys(this.state.pendingProgress || {}).length) { this.updateWeakNetworkHint(); return; }
    this.state.syncFlushing = true;
    let completed = false;
    try {
      for (const [courseId, item] of Object.entries({ ...this.state.pendingProgress })) {
        const { data, error } = await sb.rpc('training_save_course_progress', {
          p_course_id: courseId, p_progress: Number(item.progress || 0), p_position: Number(item.position || 0),
        });
        if (error) break; // 保留队列，下次联网或刷新后继续；服务端仍会重新验证参训范围。
        delete this.state.pendingProgress[courseId];
        completed = completed || !!data?.completed;
        this.persistPendingProgress();
      }
    } catch (_) {
      // 网络再次中断时不清队列。
    } finally {
      this.state.syncFlushing = false;
      this.updateWeakNetworkHint();
    }
    if (completed) {
      const hint = document.getElementById('learn-hint');
      const mode = this.state.plan?.exam_mode || 'none';
      if (hint) hint.innerHTML = `<b style="color:#22c55e">${mode === 'none' ? '全部必修课件已完成，系统已自动记录本次培训。' : '全部必修课件已学完，请返回列表开始考试。'}</b>`;
      await this.load();
    }
  },

  async load() {
    const { data, error } = await sb.rpc('training_my_trainings');
    if (error) throw error;
    this.state.list = data || [];

    // 考试状态 / 签字状态（本人 assignments；RLS 不限定本人时必须前端过滤，
    // 否则 asgMap 可能映射到别人的 assignment，导致状态显示错误甚至替别人签字）
    const ids = this.state.list.map(r => r.plan_id);
    this.state.asgMap = {};
    if (ids.length) {
      const { data: sess } = await sb.auth.getSession();
      const uid = sess?.session?.user?.id || null;
      // user_id 是发布瞬间的快照（发布时未开通账号则为空），employee_id 是实时绑定，
      // 双通道都要参与匹配；uid 取不到时仅按 employee_id 过滤
      const empId = (await sb.rpc('training_my_employee_id')).data;
      const own = [];
      if (uid) own.push('user_id.eq.' + uid);
      if (empId) own.push('employee_id.eq.' + empId);
      let q = sb.from('training_assignments')
        .select('id, plan_id, user_id, employee_id, exam_status, exam_attempts, status, progress, completed_at, training_signatures(assignment_id)')
        .in('plan_id', ids);
      if (own.length) q = q.or(own.join(','));
      const { data: asg } = await q;
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
    // PostgREST 对一对一关系（assignment_id 唯一）返回对象而非数组，两种都要兼容
    const sig = a.training_signatures;
    const signed = Array.isArray(sig) ? sig.length > 0 : !!sig;
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
    this.state.htmlCourse = null;   // 停止接收 HTML 课件 postMessage
  },

  // ------------------------------------------------- HTML 课件宿主（iframe）
  // 消息监听只绑一次；只处理「当前打开的 HTML 课件 iframe」发来的消息
  bindCourseMessage() {
    if (this._msgBound) return;
    this._msgBound = true;
    window.addEventListener('message', e => this.onCourseMessage(e));
  },

  onCourseMessage(e) {
    const d = e.data;
    if (!d || d.source !== 'tr-courseware' || !this.state.htmlCourse) return;
    const frame = document.getElementById('learn-html-frame');
    if (!frame || e.source !== frame.contentWindow) return;   // 只信当前课件窗口
    const cid = this.state.htmlCourse.courseId;

    if (d.type === 'hello') {
      // 握手应答：带上已学到的节号（max_position），课件据此恢复进度
      const p = this.state.progress[cid] || {};
      frame.contentWindow.postMessage({
        source: 'tr-host', type: 'hello', position: Number(p.max_position || 0),
      }, '*');
      return;
    }
    if (d.type === 'progress') {
      this.report(cid, Number(d.progress || 0), Number(d.position || 0));
      return;
    }
    if (d.type === 'heartbeat') {
      const delta = Math.max(1, Math.min(60, parseInt(d.deltaSec, 10) || 0));
      sb.rpc('training_course_heartbeat', {
        p_session_id: this.state.hbSessions[cid] || null,
        p_course_id: cid,
        p_delta_sec: delta,
        p_position: Number(d.position || 0),
        p_progress: d.progress == null ? null : Number(d.progress),
      }).then(({ data, error }) => {
        if (error) { console.warn('心跳失败：', error.message); return; }
        if (data && data.session_id) this.state.hbSessions[cid] = data.session_id;
      }).catch(() => { /* 静默，下个心跳继续 */ });
    }
  },

  async renderHtml(stage, c, p) {
    const url = await this.fileUrl(c);
    if (this.state.activeId !== c.id) return;
    this.bindCourseMessage();
    this.state.htmlCourse = { courseId: c.id };
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <iframe id="learn-html-frame" src="${Utils.escapeHtml(url)}"
        title="courseware" style="width:100%;height:66vh;border:1px solid #e5e7eb;border-radius:6px;background:#fff">
      </iframe>
      <p class="text-muted" style="font-size:12px;margin-top:6px">
        课件按节解锁：读完本节（滚动到底 + 停留足够时间）才能进入下一节，离开页面会自动暂停计时。
      </p>
    `;
  },

  // ---------------------------------------------------------------- 学习页
  async openLearn(planId) {
    const r = this.state.list.find(x => x.plan_id === planId);
    if (!r) return;
    this.state.plan = r;
    this.state.activeId = '';
    await this.flushPendingProgress();

    const [{ data: courses, error: e1 }, { data: prog, error: e2 }] = await Promise.all([
      sb.from('training_courses').select('*').eq('plan_id', planId).order('sort_order'),
      sb.from('training_course_progress').select('course_id, progress, max_position, finished'),
    ]);
    if (e1) { alert('加载课件失败：' + e1.message); return; }
    if (e2) { alert('加载学习进度失败：' + e2.message); return; }

    this.state.courses = courses || [];
    this.state.fileUrls = {};
    this.state.progress = {};
    (prog || []).forEach(p => { this.state.progress[p.course_id] = p; });
    // 离线缓冲优先展示较大的本地进度，避免员工恢复页面后看到进度倒退。
    Object.entries(this.state.pendingProgress || {}).forEach(([courseId, p]) => {
      const remote = this.state.progress[courseId] || {};
      this.state.progress[courseId] = {
        ...remote,
        progress: Math.max(Number(remote.progress || 0), Number(p.progress || 0)),
        max_position: Math.max(Number(remote.max_position || 0), Number(p.position || 0)),
        finished: !!remote.finished || Number(p.progress || 0) >= this.PASS,
      };
    });

    if (!this.state.courses.length) {
      alert('该培训还没有课件，请联系管理员添加后再学习。');
      return;
    }
    this.renderLearn();
    this.openCourse(this.state.courses[0].id);
  },

  async fileUrl(c) {
    if (!c.file_path) return c.file_url || '';
    if (this.state.fileUrls[c.id]) return this.state.fileUrls[c.id];
    const { data, error } = await sb.storage.from('training-courses')
      .createSignedUrl(c.file_path, 3600);
    if (error || !data || !data.signedUrl) {
      throw new Error(error ? error.message : '无法获取课件访问链接');
    }
    this.state.fileUrls[c.id] = data.signedUrl;
    return data.signedUrl;
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
            <div style="display:grid;gap:3px"><span id="learn-hint" class="text-muted" style="font-size:12px"></span><span id="learn-sync-status" class="text-muted" style="font-size:12px"></span></div>
            <div style="display:flex;gap:8px"><button class="btn btn-secondary" onclick="TrainingMine.downloadCurrentCourse()">下载当前课件</button><button class="btn btn-secondary" onclick="TrainingMine.finishLearn()">关闭</button></div>
          </div>
        </div>
      </div>
    `;
    this.renderNav();
    this.updateWeakNetworkHint();
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

  async downloadCurrentCourse() {
    const c = this.state.courses.find(x => x.id === this.state.activeId);
    if (!c) { Utils.toast('请先选择要下载的课件', 'info'); return; }
    if (c.course_type === 'link' && !c.file_path) { Utils.toast('外部链接课件不能作为系统离线资料下载', 'info'); return; }
    try {
      let blob, ext;
      if (c.course_type === 'text') {
        blob = new Blob([c.content || ''], { type: 'text/plain;charset=utf-8' }); ext = 'txt';
      } else {
        const url = await this.fileUrl(c);
        if (!url) throw new Error('课件文件不存在');
        const response = await fetch(url);
        if (!response.ok) throw new Error('课件下载失败');
        blob = await response.blob();
        ext = (c.file_path || '').split('.').pop().replace(/[^a-z0-9]/ig, '') ||
          ({ html: 'html', pdf: 'pdf', video: 'mp4', image: 'jpg' }[c.course_type] || 'file');
      }
      const name = (c.title || '培训课件').replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      Utils.toast('课件已开始下载。离线查看不计入系统学习进度。', 'success');
    } catch (e) { Utils.toast(`下载失败：${e.message || e}`, 'error'); }
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

    stage.innerHTML = '<div class="text-muted" style="padding:24px">正在加载课件...</div>';
    try {
      if (c.course_type === 'video') await this.renderVideo(stage, c, p);
      else if (c.course_type === 'pdf') await this.renderPdf(stage, c, p);
      else if (c.course_type === 'image') await this.renderImage(stage, c, p);
      else if (c.course_type === 'text') this.renderText(stage, c, p);
      else if (c.course_type === 'html') await this.renderHtml(stage, c, p);
      else this.renderLink(stage, c, p);
    } catch (e) {
      if (this.state.activeId === c.id) {
        stage.innerHTML = `<div class="alert alert-danger">课件加载失败：${Utils.escapeHtml(e.message || '')}</div>`;
      }
    }
  },

  // ------------------------------------------------------------- 进度上报
  async report(courseId, pct, position) {
    const prev = this.state.progress[courseId] || { progress: 0, max_position: 0 };
    const p = Math.min(100, Math.max(Number(prev.progress || 0), Number(pct || 0)));
    const pos = Math.max(Number(prev.max_position || 0), Number(position || 0));

    const gate = this.nextStudyQuizGate(courseId, Number(prev.progress || 0), p);
    if (gate) { await this.openStudyQuiz(courseId, gate, pct, position); return; }

    // 变化太小就不打搅数据库（完成时必须上报一次）
    if (p < this.PASS && p - Number(prev.progress || 0) < 5) return;

    this.state.progress[courseId] = {
      progress: p, max_position: pos, finished: p >= this.PASS,
    };
    this.renderNav();

    this.queueProgress(courseId, p, pos);
    await this.flushPendingProgress();
  },

  nextStudyQuizGate(courseId, previous, current) {
    if (this.state.studyQuizPending || current < previous) return null;
    const passed = this.state.studyQuizPassed[courseId] || new Set();
    return [45, 85].find(point => previous < point && current >= point && !passed.has(point)) || null;
  },

  async openStudyQuiz(courseId, gate, pct, position) {
    this.state.studyQuizPending = { courseId, gate, pct, position };
    const { data, error } = await sb.rpc('training_study_quiz_for_course', { p_course_id: courseId });
    const question = data?.question;
    if (error || !question) {
      (this.state.studyQuizPassed[courseId] ||= new Set()).add(gate);
      this.state.studyQuizPending = null;
      await this.report(courseId, pct, position);
      return;
    }
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    const options = Array.isArray(question.options) ? question.options : [];
    host.innerHTML = `<div class="modal-overlay"><div class="modal" style="max-width:620px"><div class="modal-header"><h3>学习确认</h3></div><div class="modal-body"><p class="hint">请完成确认题后继续学习。</p><p style="font-weight:600;line-height:1.7">${Utils.escapeHtml(question.stem || '')}</p><div style="display:grid;gap:8px;margin-top:14px">${options.map(x => `<label style="display:flex;gap:8px;padding:9px;border:1px solid #e5e7eb;border-radius:6px"><input type="radio" name="study-quiz-answer" value="${Utils.escapeHtml(x.key || '')}"><span><b>${Utils.escapeHtml(x.key || '')}.</b> ${Utils.escapeHtml(x.text || '')}</span></label>`).join('')}</div><div id="study-quiz-feedback" style="margin-top:12px"></div></div><div class="modal-footer"><button class="btn btn-primary" onclick="TrainingMine.submitStudyQuiz('${courseId}', ${gate}, '${question.id}', ${Number(pct)}, ${Number(position)})">提交答案</button></div></div></div>`;
  },

  async submitStudyQuiz(courseId, gate, questionId, pct, position) {
    const answer = document.querySelector('input[name="study-quiz-answer"]:checked')?.value;
    const feedback = document.getElementById('study-quiz-feedback');
    if (!answer) { if (feedback) feedback.innerHTML = '<span style="color:#b91c1c">请选择一个答案。</span>'; return; }
    const { data, error } = await sb.rpc('training_study_quiz_answer', { p_course_id: courseId, p_question_id: questionId, p_answer: answer });
    if (error) { if (feedback) feedback.innerHTML = `<span style="color:#b91c1c">提交失败：${Utils.escapeHtml(error.message)}</span>`; return; }
    if (!data?.correct) { if (feedback) feedback.innerHTML = `<span style="color:#b91c1c">答案不正确，请重新阅读并再试一次。${data?.analysis ? ` ${Utils.escapeHtml(data.analysis)}` : ''}</span>`; return; }
    (this.state.studyQuizPassed[courseId] ||= new Set()).add(gate);
    this.state.studyQuizPending = null;
    const host = document.getElementById('training-modal-host'); if (host) host.innerHTML = '';
    await this.report(courseId, pct, position);
  },

  // ------------------------------------------------------------- 各类渲染
  async renderVideo(stage, c, p) {
    const url = await this.fileUrl(c);
    if (this.state.activeId !== c.id) return;
    const last = Number(p.max_position || 0);
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <video id="learn-video" controls controlsList="nodownload"
        style="width:100%;max-height:60vh;background:#000;border-radius:6px" preload="metadata">
        <source src="${Utils.escapeHtml(url)}">
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
      const task = pdfjsLib.getDocument(await this.fileUrl(c));
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

  async renderImage(stage, c, p) {
    const url = await this.fileUrl(c);
    if (this.state.activeId !== c.id) return;
    stage.innerHTML = `
      <div style="font-size:14px;font-weight:500;margin-bottom:8px">${Utils.escapeHtml(c.title)}</div>
      <img src="${Utils.escapeHtml(url)}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
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

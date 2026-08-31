// =============================================================
// js/modules/training/questions.js —— 三级试题库管理
// 对应 sql/exam-module.sql 的 exam_questions（scope: company/dept/project）
// 题型：single 单选 / multi 多选 / judge 判断 / case 案例（材料+子选择题）
// 判分口径：多选全对才得分；案例逐子题判（子题均分，可给子题分值）
// =============================================================
const TrainingQuestions = {

  TYPE_LABEL: { single: '单选', multi: '多选', judge: '判断', case: '案例分析' },
  TYPE_BADGE: { single: 'badge-info', multi: 'badge-warning', judge: 'badge-success', case: 'badge-primary' },

  SCOPES: [
    { key: 'company', label: '公司通用库' },
    { key: 'dept',    label: '部门专业库' },
    { key: 'project', label: '项目专项库' },
  ],

  state: {
    scope: 'company',
    list: [],
    courses: [],
    filterDept: '',
    filters: { type: '', category: '', kw: '' },
  },

  /** 公司库仅公司级可写；部门/项目库树内管理员可写（RLS 兜底） */
  canWrite() {
    if (!TrainingModule.canEdit()) return false;
    if (this.state.scope === 'company') return TrainingModule.isCompanyAdmin();
    return true;
  },

  async render(box) {
    this.state.filterDept = this.myDeptId() || '';
    box.innerHTML = `
      <div class="cat-tabs">
        ${this.SCOPES.map(s => `
          <button type="button" class="cat-tab${this.state.scope === s.key ? ' active' : ''}"
            onclick="TrainingQuestions.switchScope('${s.key}')">${s.label}</button>`).join('')}
      </div>
      <div class="toolbar">
        <div class="toolbar-left">
          <select id="q-filter-dept" onchange="TrainingQuestions.onFilter()" style="display:${this.state.scope === 'company' ? 'none' : ''}">
            <option value="">全部部门</option>
            ${TrainingModule.deptOptions(this.state.filterDept, false)}
          </select>
          <select id="q-filter-type" onchange="TrainingQuestions.onFilter()">
            <option value="">全部题型</option>
            ${Object.entries(this.TYPE_LABEL).map(([k, v]) =>
              `<option value="${k}"${this.state.filters.type === k ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
          <select id="q-filter-category" onchange="TrainingQuestions.onFilter()">
            <option value="">全部分类</option>
          </select>
          <input id="q-filter-kw" placeholder="搜索题干…" oninput="TrainingQuestions.onFilter()">
        </div>
        <div class="toolbar-right">
          ${this.canWrite() ? '<button class="btn btn-primary btn-sm" onclick="TrainingQuestions.openForm()">+ 新增试题</button>' : '<span class="badge badge-muted">公司库只读，如需维护请联系公司级管理员</span>'}
        </div>
      </div>
      <div id="question-table"></div>
    `;
    await Promise.all([this.load(), this.loadCourses()]);
    this.renderCategoryOptions();
  },

  myDeptId() {
    return (this.state.profile || (TrainingModule.state.profile || {})).department_id
      || (TrainingModule.state.profile || {}).department_id || '';
  },

  async switchScope(scope) {
    this.state.scope = scope;
    const tabs = box => box;
    document.querySelectorAll('#training-section .cat-tab').forEach(b => {
      if (this.SCOPES.some(s => s.key === b.getAttribute('onclick')?.match(/'(\w+)'/)?.[1])) {
        b.classList.toggle('active', b.getAttribute('onclick').includes(`'${scope}'`));
      }
    });
    const deptSel = document.getElementById('q-filter-dept');
    if (deptSel) deptSel.style.display = scope === 'company' ? 'none' : '';
    document.getElementById('question-table').closest('.toolbar')
      .querySelector('.toolbar-right').innerHTML = this.canWrite()
        ? '<button class="btn btn-primary btn-sm" onclick="TrainingQuestions.openForm()">+ 新增试题</button>'
        : '<span class="badge badge-muted">该库对您只读</span>';
    await this.load();
    this.renderCategoryOptions();
  },

  async load() {
    let q = sb.from('exam_questions').select('*')
      .eq('scope', this.state.scope);
    if (this.state.scope !== 'company' && this.state.filterDept) {
      q = q.eq('department_id', this.state.filterDept);
    }
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    this.state.list = data || [];
    this.renderTable();
  },

  async loadCourses() {
    if (this.state.courses.length) return;
    const { data, error } = await sb.from('training_courses')
      .select('id, title').order('created_at', { ascending: false }).limit(500);
    if (error) { this.state.courses = []; return; }
    this.state.courses = data || [];
  },

  onFilter() {
    this.state.filters.type = document.getElementById('q-filter-type').value;
    this.state.filters.category = document.getElementById('q-filter-category').value;
    this.state.filters.kw = (document.getElementById('q-filter-kw').value || '').trim();
    const deptSel = document.getElementById('q-filter-dept');
    if (deptSel && this.state.scope !== 'company') {
      this.state.filterDept = deptSel.value;
      this.load();
      return;
    }
    this.renderTable();
  },

  categories() {
    return [...new Set(this.state.list.map(x => x.category).filter(Boolean))];
  },

  renderCategoryOptions() {
    const sel = document.getElementById('q-filter-category');
    if (!sel) return;
    const cur = this.state.filters.category;
    sel.innerHTML = `<option value="">全部分类</option>` +
      this.categories().map(c =>
        `<option value="${Utils.escapeHtml(c)}"${c === cur ? ' selected' : ''}>${Utils.escapeHtml(c)}</option>`).join('');
  },

  filtered() {
    const { type, category, kw } = this.state.filters;
    const k = kw.toLowerCase();
    return this.state.list.filter(x => {
      if (type && x.question_type !== type) return false;
      if (category && x.category !== category) return false;
      if (k && !(x.stem || '').toLowerCase().includes(k)) return false;
      return true;
    });
  },

  renderTable() {
    const box = document.getElementById('question-table');
    if (!box) return;
    const rows = this.filtered();
    const canW = this.canWrite();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>${this.SCOPES.find(s => s.key === this.state.scope).label}（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:52px">序</th>
                <th>题干 / 材料</th>
                <th style="width:76px">题型</th>
                <th style="width:110px">分类</th>
                <th style="width:70px">默认分</th>
                <th style="width:150px">关联课件</th>
                <th style="width:70px">状态</th>
                ${canW ? '<th style="width:130px">操作</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(canW ? 8 : 7,
                    '暂无试题。点右上角「+ 新增试题」录入；案例分析题 = 材料 + 若干子选择题。')
                : rows.map((x, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td title="${Utils.escapeHtml(x.stem)}">${Utils.escapeHtml(x.stem)}</td>
                    <td><span class="badge ${this.TYPE_BADGE[x.question_type] || 'badge-muted'}">${this.TYPE_LABEL[x.question_type] || x.question_type}</span></td>
                    <td title="${Utils.escapeHtml(x.category || '')}">${Utils.escapeHtml(x.category || '—')}</td>
                    <td>${x.score_default != null ? x.score_default : '—'}</td>
                    <td title="${Utils.escapeHtml(this.courseTitle(x.course_id))}">${Utils.escapeHtml(this.courseTitle(x.course_id))}</td>
                    <td>${x.status === 'published' ? '<span class="badge badge-success">发布</span>'
                        : x.status === 'draft' ? '<span class="badge badge-muted">草稿</span>'
                        : '<span class="badge badge-danger">停用</span>'}</td>
                    ${canW ? `<td>
                      <button class="btn btn-sm btn-secondary" onclick="TrainingQuestions.openForm('${x.id}')">编辑</button>
                      <button class="btn btn-sm btn-danger" onclick="TrainingQuestions.remove('${x.id}')">删除</button>
                    </td>` : ''}
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  courseTitle(id) {
    if (!id) return '—';
    const c = this.state.courses.find(x => x.id === id);
    return c ? c.title : '—';
  },

  host() {
    let h = document.getElementById('training-modal-host');
    if (!h) {
      h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
    }
    return h;
  },

  // ================================================================ 表单
  async openForm(id) {
    const q = id ? this.state.list.find(x => x.id === id) : null;
    if (q) this.state.scope = q.scope;
    this.state.editingId = id || null;
    this.renderForm(q);
  },

  renderForm(q) {
    const type = q ? q.question_type : (this.state.formType || 'single');
    this.state.formType = type;
    const isCompany = this.state.scope === 'company';
    const deptField = isCompany ? '' : `
      <div class="form-group">
        <label>所属部门 <span class="required">*</span></label>
        <select id="qf-dept">
          <option value="">请选择部门</option>
          ${TrainingModule.deptOptions(q ? q.department_id : (this.state.filterDept || ''), false)}
        </select>
      </div>`;

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingQuestions.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:760px">
          <div class="modal-header">
            <h3>${q ? '编辑试题' : '新增试题'} — ${this.SCOPES.find(s => s.key === this.state.scope).label}</h3>
            <button class="modal-close" onclick="TrainingQuestions.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div id="qf-error" style="color:#b91c1c;font-size:13px;margin-bottom:8px"></div>
            <div class="form-row">
              <div class="form-group">
                <label>题型</label>
                <select id="qf-type" onchange="TrainingQuestions.onTypeChange()">
                  ${Object.entries(this.TYPE_LABEL).map(([k, v]) =>
                    `<option value="${k}"${type === k ? ' selected' : ''}>${v}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label>分类（如：动火作业）</label>
                <input id="qf-category" list="qf-cat-list" value="${Utils.escapeHtml(q ? (q.category || '') : '')}">
                <datalist id="qf-cat-list">
                  ${this.categories().map(c => `<option value="${Utils.escapeHtml(c)}">`).join('')}
                </datalist>
              </div>
            </div>
            ${deptField}
            <div class="form-group">
              <label>${type === 'case' ? '案例材料' : '题干'} <span class="required">*</span></label>
              <textarea id="qf-stem" rows="${type === 'case' ? 4 : 2}">${Utils.escapeHtml(q ? q.stem : '')}</textarea>
            </div>
            <div id="qf-body"></div>
            <div class="form-row">
              <div class="form-group">
                <label>默认分值（组卷可改）</label>
                <input id="qf-score" type="number" step="0.5" min="0.5" value="${q && q.score_default != null ? q.score_default : 1}">
              </div>
              <div class="form-group">
                <label>状态</label>
                <select id="qf-status">
                  <option value="published"${!q || q.status === 'published' ? ' selected' : ''}>发布</option>
                  <option value="draft"${q && q.status === 'draft' ? ' selected' : ''}>草稿</option>
                  <option value="archived"${q && q.status === 'archived' ? ' selected' : ''}>停用</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>关联课件（选填，错题回看 / 学习弹窗抽题用）</label>
              <select id="qf-course">
                <option value="">不关联</option>
                ${this.state.courses.map(c =>
                  `<option value="${c.id}"${q && q.course_id === c.id ? ' selected' : ''}>${Utils.escapeHtml(c.title)}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>答案解析（选填，错题本展示）</label>
              <textarea id="qf-analysis" rows="2">${Utils.escapeHtml(q ? (q.analysis || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="TrainingQuestions.save()">保存</button>
            <button class="btn btn-secondary" onclick="TrainingQuestions.closeForm()">取消</button>
          </div>
        </div>
      </div>
    `;
    this.renderTypeBody(q);
  },

  /** 按题型渲染答题区（选项 / 判断 / 案例子题） */
  renderTypeBody(q) {
    const type = this.state.formType;
    const body = document.getElementById('qf-body');
    if (!body) return;
    const KEYS = ['A', 'B', 'C', 'D'];

    if (type === 'judge') {
      const ans = q ? q.answer : '';
      body.innerHTML = `
        <div class="form-group">
          <label>正确答案 <span class="required">*</span></label>
          <select id="qf-answer">
            <option value="A"${ans === 'A' ? ' selected' : ''}>正确</option>
            <option value="B"${ans === 'B' ? ' selected' : ''}>错误</option>
          </select>
        </div>`;
      return;
    }

    if (type === 'case') {
      const subs = (q && q.sub_questions) || [];
      body.innerHTML = `
        <div class="form-group">
          <label>子选择题（每个子题独立判分）</label>
          <div id="qf-subs"></div>
          <button type="button" class="btn btn-sm btn-secondary" onclick="TrainingQuestions.addSub()" style="margin-top:6px">+ 添加子题</button>
        </div>`;
      const wrap = document.getElementById('qf-subs');
      if (subs.length) subs.forEach(s => wrap.appendChild(this.buildSubRow(s)));
      else this.addSub();
      return;
    }

    // single / multi：四选项
    const opts = (q && q.options) || [];
    const val = k => { const o = opts.find(x => x.key === k); return o ? o.text : ''; };
    const radio = k => `<input type="radio" name="qf-answer" value="${k}" ${q && q.answer === k ? 'checked' : ''}>`;
    const check = k => `<input type="checkbox" name="qf-answer" value="${k}" ${q && q.answer && q.answer.includes(k) ? 'checked' : ''}>`;
    body.innerHTML = `
      <div class="form-group">
        <label>选项（留空的不会保存）与正确答案 <span class="required">*</span></label>
        ${KEYS.map(k => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <b style="width:18px;font-size:13px">${k}.</b>
            <input class="qf-opt" data-key="${k}" value="${Utils.escapeHtml(val(k))}" style="flex:1">
            <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:3px;white-space:nowrap">
              ${type === 'multi' ? check(k) : radio(k)} 正确
            </label>
          </div>`).join('')}
        ${type === 'multi' ? '<p class="hint">多选：勾选全部正确选项，判分时全对才得分</p>' : ''}
      </div>`;
  },

  buildSubRow(s) {
    const div = document.createElement('div');
    div.style.cssText = 'border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:8px';
    const val = k => { const o = (s.options || []).find(x => x.key === k); return o ? o.text : ''; };
    div.innerHTML = `
      <input class="qs-stem" placeholder="子题干" value="${Utils.escapeHtml(s.stem || '')}"
        style="width:100%;margin-bottom:6px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-bottom:6px">
        ${['A', 'B', 'C', 'D'].map(k => `
          <div style="display:flex;align-items:center;gap:4px">
            <b style="font-size:12px">${k}.</b>
            <input class="qs-opt" data-key="${k}" value="${Utils.escapeHtml(val(k))}" style="flex:1">
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <label style="font-size:12px">答案
          <select class="qs-answer">
            ${['A', 'B', 'C', 'D'].map(k =>
              `<option value="${k}"${s.answer === k ? ' selected' : ''}>${k}</option>`).join('')}
          </select>
        </label>
        <label style="font-size:12px">分值（留空均分）
          <input class="qs-score" type="number" step="0.5" min="0" value="${s.score != null ? s.score : ''}" style="width:70px">
        </label>
        <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.qs-row').remove()">删除子题</button>
      </div>`;
    div.className = 'qs-row';
    return div;
  },

  addSub() {
    const wrap = document.getElementById('qf-subs');
    if (wrap) wrap.appendChild(this.buildSubRow({}));
  },

  onTypeChange() {
    const has = ['qf-stem'].some(i => {
      const el = document.getElementById(i);
      return el && el.value.trim();
    });
    if (has && !confirm('切换题型会清空已填写的选项，确定？')) {
      document.getElementById('qf-type').value = this.state.formType;
      return;
    }
    this.state.formType = document.getElementById('qf-type').value;
    this.renderTypeBody(null);
  },

  closeForm() {
    this.host().innerHTML = '';
    this.state.editingId = null;
  },

  readOptions() {
    const keys = [];
    document.querySelectorAll('#qf-body .qf-opt').forEach(inp => {
      const t = inp.value.trim();
      if (t) keys.push({ key: inp.dataset.key, text: t });
    });
    return keys;
  },

  async save() {
    const err = msg => { document.getElementById('qf-error').textContent = msg; };
    err('');
    const type = this.state.formType;
    const stem = document.getElementById('qf-stem').value.trim();
    if (!stem) return err('请填写题干' + (type === 'case' ? '（案例材料）' : ''));

    const payload = {
      scope: this.state.scope,
      question_type: type,
      stem,
      category: document.getElementById('qf-category').value.trim() || null,
      score_default: parseFloat(document.getElementById('qf-score').value) || 1,
      status: document.getElementById('qf-status').value,
      course_id: document.getElementById('qf-course').value || null,
      analysis: document.getElementById('qf-analysis').value.trim() || null,
    };
    if (this.state.scope !== 'company') {
      const dept = document.getElementById('qf-dept') ? document.getElementById('qf-dept').value : '';
      if (!dept) return err('请选择所属部门');
      payload.department_id = dept;
    } else {
      payload.department_id = null;
    }

    if (type === 'judge') {
      payload.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
      payload.answer = document.getElementById('qf-answer').value;
      payload.sub_questions = null;
    } else if (type === 'case') {
      const subs = [];
      let bad = false;
      document.querySelectorAll('#qf-subs .qs-row').forEach(row => {
        const st = row.querySelector('.qs-stem').value.trim();
        const opts = [];
        row.querySelectorAll('.qs-opt').forEach(inp => {
          const t = inp.value.trim();
          if (t) opts.push({ key: inp.dataset.key, text: t });
        });
        const ans = row.querySelector('.qs-answer').value;
        const sc = row.querySelector('.qs-score').value;
        if (!st && !opts.length) return;   // 整行为空则跳过
        if (!st || opts.length < 2) bad = true;
        subs.push({ stem: st, options: opts, answer: ans, score: sc === '' ? null : parseFloat(sc) });
      });
      if (bad) return err('子题需填写题干和至少 2 个选项');
      if (!subs.length) return err('案例分析至少需要 1 个子选择题');
      payload.sub_questions = subs;
      payload.options = null;
      payload.answer = null;
    } else {
      const opts = this.readOptions();
      if (opts.length < 2) return err('请至少填写 2 个选项');
      const sel = document.querySelector('input[name="qf-answer"]:checked');
      if (!sel) return err('请选择正确答案');
      if (!opts.some(o => o.key === sel.value)) return err('正确答案对应的选项不能为空');
      payload.options = opts;
      payload.answer = [...document.querySelectorAll('input[name="qf-answer"]:checked')]
        .map(x => x.value).sort().join('');
      payload.sub_questions = null;
    }

    let error;
    if (this.state.editingId) {
      ({ error } = await sb.from('exam_questions').update(payload).eq('id', this.state.editingId));
    } else {
      payload.created_by = (Auth.currentProfile || {}).id || null;
      ({ error } = await sb.from('exam_questions').insert(payload));
    }
    if (error) return err('保存失败：' + error.message);

    this.closeForm();
    await this.load();
    this.renderCategoryOptions();
    if (Utils.toast) Utils.toast('试题已保存');
  },

  async remove(id) {
    const q = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除这道${this.TYPE_LABEL[q ? q.question_type : ''] || ''}题？已组卷的试卷会受影响，建议改用「停用」。`)) return;
    const { error } = await sb.from('exam_questions').delete().eq('id', id);
    if (error) {
      if ((error.message || '').includes('foreign key')) {
        alert('该题已被试卷引用，无法删除；请改为「停用」。');
      } else {
        alert('删除失败：' + error.message);
      }
      return;
    }
    await this.load();
    this.renderCategoryOptions();
    if (Utils.toast) Utils.toast('已删除');
  },
};

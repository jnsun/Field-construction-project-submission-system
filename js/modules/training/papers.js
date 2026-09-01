// =============================================================
// js/modules/training/papers.js —— 试卷管理（固定 / 随机组卷）
// 对应 sql/exam-module.sql 的 exam_papers / exam_paper_questions / exam_paper_rules
// fixed  = 手动选题，逐题可改分值
// random = 按规则抽题（题型 + 分类 + 数量 + 每题分值），开考时生成快照
// =============================================================
const ExamPapers = {

  state: {
    list: [],
    plans: [],
    picked: [],     // fixed：已选题目 [{question_id, stem, question_type, score}]
    rules: [],      // random：[{question_type, category, count, score_each}]
    qPool: [],      // 题库候选
    qFilter: { type: '', kw: '' },
    editingId: null,
  },

  TYPE_LABEL: { single: '单选', multi: '多选', judge: '判断', case: '案例' },

  async render(box) {
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="text-muted" style="font-size:13px">
            试卷必须「发布」且挂接计划后，员工完成课件（auto）或管理员发起（manual）才能开考。
          </span>
        </div>
        <div class="toolbar-right">
          ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="ExamPapers.openForm()">+ 新建试卷</button>' : ''}
        </div>
      </div>
      <div id="paper-table"></div>
    `;
    await Promise.all([this.load(), this.loadPlans()]);
  },

  async load() {
    const { data, error } = await sb.from('exam_papers')
      .select('*, training_plans(title)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    this.state.list = data || [];
    this.renderTable();
  },

  async loadPlans() {
    const { data } = await sb.from('training_plans')
      .select('id, title, publish_status')
      .order('created_at', { ascending: false }).limit(300);
    this.state.plans = data || [];
  },

  renderTable() {
    const box = document.getElementById('paper-table');
    if (!box) return;
    const rows = this.state.list;
    const canW = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>试卷（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>试卷名称</th>
                <th style="width:64px">模式</th>
                <th style="width:170px">挂接计划</th>
                <th style="width:66px">时长</th>
                <th style="width:70px">及格线</th>
                <th style="width:76px">补考次数</th>
                <th style="width:70px">总分</th>
                <th style="width:64px">状态</th>
                ${canW ? '<th style="width:170px">操作</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(canW ? 9 : 8, '暂无试卷。先在「题库管理」录题，再点右上角「+ 新建试卷」。')
                : rows.map(x => `
                  <tr>
                    <td title="${Utils.escapeHtml(x.title)}">${Utils.escapeHtml(x.title)}</td>
                    <td>${x.mode === 'fixed'
                        ? '<span class="badge badge-info">固定</span>'
                        : '<span class="badge badge-warning">随机</span>'}</td>
                    <td>${Utils.escapeHtml(x.training_plans ? x.training_plans.title : '未挂接')}</td>
                    <td>${x.duration_min} 分钟</td>
                    <td>${x.pass_score}</td>
                    <td>${x.retry_limit} 次</td>
                    <td>${x.total_score != null ? x.total_score : '—'}</td>
                    <td>${x.status === 'published' ? '<span class="badge badge-success">发布</span>'
                        : x.status === 'draft' ? '<span class="badge badge-muted">草稿</span>'
                        : '<span class="badge badge-danger">停用</span>'}</td>
                    ${canW ? `<td>
                      <button class="btn btn-sm btn-secondary" onclick="ExamPapers.openForm('${x.id}')">编辑</button>
                      <button class="btn btn-sm ${x.status === 'published' ? 'btn-secondary' : 'btn-primary'}"
                        onclick="ExamPapers.toggleStatus('${x.id}', '${x.status === 'published' ? 'archived' : 'published'}')">
                        ${x.status === 'published' ? '停用' : '发布'}</button>
                      <button class="btn btn-sm btn-danger" onclick="ExamPapers.remove('${x.id}')">删除</button>
                    </td>` : ''}
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
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
    this.state.editingId = id || null;
    this.state.picked = [];
    this.state.rules = [];
    this.state.qPool = [];

    let p = null, picked = [], rules = [];
    if (id) {
      const [pr, pq, prr] = await Promise.all([
        sb.from('exam_papers').select('*').eq('id', id).single(),
        sb.from('exam_paper_questions')
          .select('question_id, score, exam_questions(question_type, stem, category, score_default)')
          .eq('paper_id', id)
          .order('sort_order'),
        sb.from('exam_paper_rules').select('*').eq('paper_id', id),
      ]);
      if (pr.error) { alert('加载失败：' + pr.error.message); return; }
      p = pr.data;
      picked = (pq.data || []).map(r => ({
        question_id: r.question_id,
        stem: r.exam_questions.stem,
        question_type: r.exam_questions.question_type,
        category: r.exam_questions.category,
        score: r.score != null ? r.score : r.exam_questions.score_default,
      }));
      rules = prr.data || [];
    }
    this.state.picked = picked;
    this.state.rules = rules;
    this.state.formMode = p ? p.mode : 'fixed';
    this.renderForm(p);
  },

  renderForm(p) {
    const planOpts = this.state.plans.map(pl =>
      `<option value="${pl.id}"${p && p.plan_id === pl.id ? ' selected' : ''}>${Utils.escapeHtml(pl.title)}（${pl.publish_status === 'published' ? '已发布' : pl.publish_status}）</option>`).join('');

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="ExamPapers.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:880px">
          <div class="modal-header">
            <h3>${p ? '编辑试卷' : '新建试卷'}</h3>
            <button class="modal-close" onclick="ExamPapers.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div id="pf-error" style="color:#b91c1c;font-size:13px;margin-bottom:8px"></div>
            <div class="form-row">
              <div class="form-group">
                <label>试卷名称 <span class="required">*</span></label>
                <input id="pf-title" value="${Utils.escapeHtml(p ? p.title : '')}">
              </div>
              <div class="form-group">
                <label>挂接培训计划（员工据此触发考试）</label>
                <select id="pf-plan">
                  <option value="">未挂接（备用卷）</option>
                  ${planOpts}
                </select>
              </div>
            </div>
            <div class="form-row" style="grid-template-columns:repeat(4,1fr)">
              <div class="form-group">
                <label>组卷模式</label>
                <select id="pf-mode" onchange="ExamPapers.onModeChange()">
                  <option value="fixed"${this.state.formMode === 'fixed' ? ' selected' : ''}>固定（手动选题）</option>
                  <option value="random"${this.state.formMode === 'random' ? ' selected' : ''}>随机（按规则抽题）</option>
                </select>
              </div>
              <div class="form-group">
                <label>时长（分钟）</label>
                <input id="pf-duration" type="number" min="5" value="${p ? p.duration_min : 30}">
              </div>
              <div class="form-group">
                <label>及格线</label>
                <input id="pf-pass" type="number" step="0.5" min="0" value="${p ? p.pass_score : 60}">
              </div>
              <div class="form-group">
                <label>补考次数（含首考）</label>
                <input id="pf-retry" type="number" min="1" max="10" value="${p ? p.retry_limit : 3}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group" style="display:flex;align-items:center;gap:8px">
                <input id="pf-shuffle" type="checkbox" ${!p || p.shuffle ? 'checked' : ''}>
                <label for="pf-shuffle" style="margin:0">题序乱序（选项顺序固定，保证答案 key 对应）</label>
              </div>
              <div class="form-group">
                <label>状态</label>
                <select id="pf-status">
                  <option value="draft"${!p || p.status === 'draft' ? ' selected' : ''}>草稿</option>
                  <option value="published"${p && p.status === 'published' ? ' selected' : ''}>发布</option>
                  <option value="archived"${p && p.status === 'archived' ? ' selected' : ''}>停用</option>
                </select>
              </div>
            </div>
            <div class="form-group" style="display:flex;justify-content:space-between;align-items:center;
                background:#f4f6fa;border-radius:8px;padding:8px 12px">
              <b style="font-size:13px">试卷总分：<span id="pf-total">0</span> 分</b>
              <span class="hint" style="font-size:12px">及格线不能超过总分</span>
            </div>
            <div id="pf-body"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="ExamPapers.save()">保存</button>
            <button class="btn btn-secondary" onclick="ExamPapers.closeForm()">取消</button>
          </div>
        </div>
      </div>
    `;
    this.renderModeBody();
  },

  onModeChange() {
    const next = document.getElementById('pf-mode').value;
    if (next !== this.state.formMode) {
      const hasContent = this.state.picked.length || this.state.rules.length;
      if (hasContent && !confirm('切换组卷模式会清空已选题目 / 抽题规则，确定？')) {
        document.getElementById('pf-mode').value = this.state.formMode;
        return;
      }
      this.state.formMode = next;
      this.state.picked = [];
      this.state.rules = [];
    }
    this.renderModeBody();
  },

  renderModeBody() {
    const mode = this.state.formMode;
    const body = document.getElementById('pf-body');
    if (!body) return;
    if (mode === 'fixed') this.renderFixed();
    else this.renderRandom();
    this.updateTotal();
  },

  // ------------------------------------------------ 固定卷：已选 + 题库候选
  renderFixed() {
    const body = document.getElementById('pf-body');
    body.innerHTML = `
      <div class="form-group">
        <label>已选题目（${this.state.picked.length}）</label>
        <div id="pf-picked"></div>
      </div>
      <div class="form-group">
        <label>从题库添加（公司库 + 您可见的部门/项目库）</label>
        <div style="display:flex;gap:8px;margin-bottom:6px">
          <select id="pf-qtype" onchange="ExamPapers.loadPool()">
            <option value="">全部题型</option>
            ${Object.entries(this.TYPE_LABEL).map(([k, v]) =>
              `<option value="${k}"${this.state.qFilter.type === k ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
          <input id="pf-qkw" placeholder="搜索题干…" oninput="ExamPapers.loadPool()" style="flex:1">
        </div>
        <div id="pf-pool" style="max-height:240px;overflow-y:auto;border:1px solid #eef2f7;border-radius:8px"></div>
      </div>
    `;
    this.renderPicked();
    this.loadPool();
  },

  renderPicked() {
    const box = document.getElementById('pf-picked');
    if (!box) return;
    const list = this.state.picked;
    box.innerHTML = list.length === 0
      ? '<p class="hint" style="font-size:12px">还未选题目，请从下方题库添加。</p>'
      : list.map((q, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:13px">
          <span style="width:20px;color:#94a3b8">${i + 1}</span>
          <span class="badge ${q.question_type === 'case' ? 'badge-primary' : 'badge-muted'}"
            style="width:40px;justify-content:center">${this.TYPE_LABEL[q.question_type]}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${Utils.escapeHtml(q.stem)}">${Utils.escapeHtml(q.stem)}</span>
          <input type="number" step="0.5" min="0.5" value="${q.score}" style="width:64px"
            onchange="ExamPapers.setScore('${q.question_id}', this.value)" title="本题分值">
          <button class="btn btn-sm btn-secondary" onclick="ExamPapers.moveQuestion(${i}, -1)"
            ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-sm btn-secondary" onclick="ExamPapers.moveQuestion(${i}, 1)"
            ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-sm btn-danger" onclick="ExamPapers.removePicked('${q.question_id}')">×</button>
        </div>`).join('');
    this.updateTotal();
  },

  async loadPool() {
    this.state.qFilter.type = document.getElementById('pf-qtype')?.value || '';
    this.state.qFilter.kw = (document.getElementById('pf-qkw')?.value || '').trim();
    let q = sb.from('exam_questions')
      .select('id, question_type, stem, category, score_default')
      .eq('status', 'published')
      .limit(300);
    if (this.state.qFilter.type) q = q.eq('question_type', this.state.qFilter.type);
    const { data, error } = await q;
    if (error) { document.getElementById('pf-pool').innerHTML = `<span style="color:#b91c1c">${Utils.escapeHtml(error.message)}</span>`; return; }
    this.state.qPool = data || [];
    this.renderPool();
  },

  renderPool() {
    const box = document.getElementById('pf-pool');
    if (!box) return;
    const kw = this.state.qFilter.kw.toLowerCase();
    const pickedIds = new Set(this.state.picked.map(x => x.question_id));
    const rows = this.state.qPool.filter(x =>
      !kw || (x.stem || '').toLowerCase().includes(kw));

    box.innerHTML = rows.length === 0
      ? '<p class="hint" style="padding:10px;font-size:12px">没有可选题目。请先到「题库管理」录入并发布。</p>'
      : rows.map(q => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:13px">
          <span class="badge badge-muted" style="width:40px;justify-content:center">${this.TYPE_LABEL[q.question_type]}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${Utils.escapeHtml(q.stem)}">${Utils.escapeHtml(q.stem)}</span>
          ${pickedIds.has(q.id)
            ? '<span class="badge badge-success">已选</span>'
            : `<button class="btn btn-sm btn-secondary" onclick="ExamPapers.addPicked('${q.id}')">添加</button>`}
        </div>`).join('');
  },

  addPicked(qid) {
    const q = this.state.qPool.find(x => x.id === qid);
    if (!q || this.state.picked.some(x => x.question_id === qid)) return;
    this.state.picked.push({
      question_id: q.id, stem: q.stem, question_type: q.question_type,
      score: q.score_default != null ? q.score_default : 1,
    });
    this.renderPicked();
    this.renderPool();
  },

  removePicked(qid) {
    this.state.picked = this.state.picked.filter(x => x.question_id !== qid);
    this.renderPicked();
    this.renderPool();
  },

  setScore(qid, val) {
    const q = this.state.picked.find(x => x.question_id === qid);
    if (q) q.score = Math.max(0.5, parseFloat(val) || 1);
    this.updateTotal();
  },

  moveQuestion(i, dir) {
    const list = this.state.picked;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.renderPicked();
  },

  // ------------------------------------------------ 随机卷：抽题规则
  renderRandom() {
    const body = document.getElementById('pf-body');
    body.innerHTML = `
      <div class="form-group">
        <label>抽题规则（开考时按规则随机抽取，每人生成题目快照）</label>
        <div id="pf-rules"></div>
        <button type="button" class="btn btn-sm btn-secondary" onclick="ExamPapers.addRule()" style="margin-top:6px">+ 添加规则</button>
        <p class="hint" style="font-size:12px;margin-top:6px">
          抽题范围 = 公司通用库 + 员工所属部门的题库；分类留空表示不限。示例：
          单选×20题×1分 + 多选×5题×2分 + 判断×10题×1分 + 案例×2题×10分。
        </p>
      </div>
    `;
    const wrap = document.getElementById('pf-rules');
    if (this.state.rules.length) this.state.rules.forEach(r => wrap.appendChild(this.buildRuleRow(r)));
    else this.addRule();
    this.updateTotal();
  },

  buildRuleRow(r) {
    const div = document.createElement('div');
    div.className = 'pf-rule-row';
    div.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap';
    div.innerHTML = `
      <select class="pr-type">
        ${Object.entries(this.TYPE_LABEL).map(([k, v]) =>
          `<option value="${k}"${r.question_type === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <input class="pr-category" placeholder="分类（留空不限）" value="${Utils.escapeHtml(r.category || '')}" style="width:140px">
      <label style="font-size:12px">数量
        <input class="pr-count" type="number" min="1" value="${r.count || 5}" style="width:60px">
      </label>
      <label style="font-size:12px">每题
        <input class="pr-score" type="number" step="0.5" min="0.5" value="${r.score_each || 1}" style="width:60px"> 分
      </label>
      <button type="button" class="btn btn-sm btn-danger" onclick="ExamPapers.removeRuleRow(this)">×</button>
    `;
    return div;
  },

  addRule() {
    const wrap = document.getElementById('pf-rules');
    if (wrap) {
      wrap.appendChild(this.buildRuleRow({}));
      this.updateTotal();
    }
  },

  removeRuleRow(btn) {
    btn.closest('.pf-rule-row').remove();
    this.updateTotal();
  },

  // ------------------------------------------------ 汇总与保存
  updateTotal() {
    const el = document.getElementById('pf-total');
    if (!el) return;
    let total = 0;
    if (this.state.formMode === 'fixed') {
      total = this.state.picked.reduce((s, q) => s + (Number(q.score) || 0), 0);
    } else {
      document.querySelectorAll('#pf-rules .pf-rule-row').forEach(row => {
        const c = parseFloat(row.querySelector('.pr-count').value) || 0;
        const s = parseFloat(row.querySelector('.pr-score').value) || 0;
        total += c * s;
      });
    }
    el.textContent = Math.round(total * 10) / 10;
  },

  closeForm() {
    this.host().innerHTML = '';
    this.state.editingId = null;
  },

  async save() {
    const err = msg => { document.getElementById('pf-error').textContent = msg; };
    err('');
    const title = document.getElementById('pf-title').value.trim();
    if (!title) return err('请填写试卷名称');

    const mode = document.getElementById('pf-mode').value;
    const pass = parseFloat(document.getElementById('pf-pass').value) || 60;
    const total = parseFloat(document.getElementById('pf-total').textContent) || 0;
    if (total <= 0) return err(mode === 'fixed' ? '请至少添加 1 道题' : '请配置有效的抽题规则');
    if (pass > total) return err(`及格线（${pass}）不能超过试卷总分（${total}）`);

    if (mode === 'fixed' && !this.state.picked.length) return err('请至少添加 1 道题');
    if (mode === 'random') {
      const rules = [];
      let bad = false;
      document.querySelectorAll('#pf-rules .pf-rule-row').forEach(row => {
        const r = {
          question_type: row.querySelector('.pr-type').value,
          category: row.querySelector('.pr-category').value.trim() || null,
          count: parseInt(row.querySelector('.pr-count').value, 10) || 0,
          score_each: parseFloat(row.querySelector('.pr-score').value) || 0,
        };
        if (r.count >= 1 && r.score_each > 0) rules.push(r); else bad = true;
      });
      if (bad) return err('抽题规则的数量 / 每题分值必须有效');
      if (!rules.length) return err('请至少添加 1 条抽题规则');
      this.state.rules = rules;
    }

    const payload = {
      title,
      plan_id: document.getElementById('pf-plan').value || null,
      mode,
      duration_min: parseInt(document.getElementById('pf-duration').value, 10) || 30,
      pass_score: pass,
      retry_limit: parseInt(document.getElementById('pf-retry').value, 10) || 3,
      shuffle: document.getElementById('pf-shuffle').checked,
      total_score: total,
      status: document.getElementById('pf-status').value,
    };

    let paperId = this.state.editingId;
    if (paperId) {
      const { error } = await sb.from('exam_papers').update(payload).eq('id', paperId);
      if (error) return err('保存失败：' + error.message);
    } else {
      const { data, error } = await sb.from('exam_papers').insert(payload).select('id').single();
      if (error) return err('保存失败：' + error.message);
      paperId = data.id;
    }

    // 重建子表
    if (mode === 'fixed') {
      await sb.from('exam_paper_questions').delete().eq('paper_id', paperId);
      const rows = this.state.picked.map((q, i) => ({
        paper_id: paperId, question_id: q.question_id, score: q.score, sort_order: i,
      }));
      const { error } = await sb.from('exam_paper_questions').insert(rows);
      if (error) return err('题目保存失败：' + error.message);
    } else {
      await sb.from('exam_paper_rules').delete().eq('paper_id', paperId);
      const { error } = await sb.from('exam_paper_rules')
        .insert(this.state.rules.map(r => ({ ...r, paper_id: paperId })));
      if (error) return err('规则保存失败：' + error.message);
    }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast('试卷已保存');
  },

  async toggleStatus(id, status) {
    const { error } = await sb.from('exam_papers').update({ status }).eq('id', id);
    if (error) { alert('操作失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast(status === 'published' ? '已发布，员工可开考' : '已停用');
  },

  async remove(id) {
    if (!confirm('确定删除该试卷？已产生的答题记录会一并删除（CASCADE）。建议改用「停用」。')) return;
    const { error } = await sb.from('exam_papers').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },
};

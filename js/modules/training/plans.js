// =============================================================
// js/modules/training/plans.js —— 培训计划
// 三级各自创建：company 公司级 / dept 部门级 / project 项目级
// 适用范围通过 training_plan_targets 下发到具体部门
// =============================================================
const TrainingPlans = {

  state: {
    list: [],
    targets: {},          // plan_id -> [部门id]
    targetRows: [],       // 下发记录原始行（含 status / record_id / participant_count）
    filters: { year: String(new Date().getFullYear()), level: '', status: '' },
  },

  LEVEL_LABEL: { company: '公司级', dept: '部门级', project: '项目级' },
  STATUS_LABEL: { planned: '计划中', ongoing: '进行中', done: '已完成', cancelled: '已取消' },

  async render(box) {
    const years = Utils.getYearOptions ? Utils.getYearOptions() : [new Date().getFullYear()];
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>年度：</label>
          <select id="plan-filter-year" onchange="TrainingPlans.onFilterChange()">
            <option value="">全部</option>
            ${years.map(y => `<option value="${y}"${String(y) === this.state.filters.year ? ' selected' : ''}>${y}年</option>`).join('')}
          </select>
          <label>层级：</label>
          <select id="plan-filter-level" onchange="TrainingPlans.onFilterChange()">
            <option value="">全部</option>
            <option value="company"${this.state.filters.level === 'company' ? ' selected' : ''}>公司级</option>
            <option value="dept"${this.state.filters.level === 'dept' ? ' selected' : ''}>部门级</option>
            <option value="project"${this.state.filters.level === 'project' ? ' selected' : ''}>项目级</option>
          </select>
          <label>状态：</label>
          <select id="plan-filter-status" onchange="TrainingPlans.onFilterChange()">
            <option value="">全部</option>
            ${Object.entries(this.STATUS_LABEL).map(([k, v]) => `<option value="${k}"${this.state.filters.status === k ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="toolbar-right">
          ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingPlans.openForm()">+ 新建计划</button>' : ''}
        </div>
      </div>
      <div id="plan-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.year = document.getElementById('plan-filter-year').value;
    this.state.filters.level = document.getElementById('plan-filter-level').value;
    this.state.filters.status = document.getElementById('plan-filter-status').value;
    this.renderTable();
  },

  async load() {
    const [{ data, error }, tg] = await Promise.all([
      sb.from('training_plans')
        .select('id, title, category, level, department_id, plan_year, plan_month, start_date, end_date, hours, trainer, location, target_desc, require_exam, status, remark, deadline, required_hours, publish_status, exam_mode')
        .order('plan_year', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('training_plan_targets')
        .select('id, plan_id, department_id, due_date, status, actual_date, participant_count, record_id, trainer, location, content, sign_method, hours'),
    ]);
    if (error) throw error;
    this.state.list = data || [];
    this.state.targets = {};
    this.state.targetRows = tg.data || [];
    (tg.data || []).forEach(t => {
      (this.state.targets[t.plan_id] = this.state.targets[t.plan_id] || []).push(t.department_id);
    });
    await this.loadProgress();
    this.renderTable();
  },

  /** 已发布计划的完成进度（未执行 v2 脚本时静默跳过） */
  async loadProgress() {
    this.state.progress = {};
    const published = this.state.list.filter(p => p.publish_status === 'published');
    if (!published.length) return;
    try {
      const res = await Promise.all(
        published.map(p => sb.rpc('training_plan_progress', { p_plan_id: p.id }))
      );
      published.forEach((p, i) => {
        const d = res[i] && res[i].data;
        this.state.progress[p.id] = Array.isArray(d) ? d[0] : d;
      });
    } catch (_) { /* v2 脚本未执行 */ }
  },

  /** 完成进度单元格 */
  progressCell(p) {
    if (p.publish_status !== 'published') return '<span class="text-muted">未发布</span>';
    const g = this.state.progress[p.id];
    if (!g || !g.total) return '<span class="text-muted">—</span>';
    const pct = g.total ? (g.completed / g.total * 100) : 0;
    const cls = pct >= 100 ? '#22c55e' : (pct >= 50 ? '#f59e0b' : '#ef4444');
    return `<span style="color:${cls};font-weight:600">${g.completed}/${g.total}</span>
      <span class="text-muted" style="font-size:12px">（${pct.toFixed(0)}%）</span>
      ${g.overdue ? `<span class="badge badge-danger" style="margin-left:4px">逾期${g.overdue}</span>` : ''}`;
  },

  publishBadge(s) {
    if (s === 'published') return '<span class="badge badge-success">已发布</span>';
    if (s === 'closed') return '<span class="badge badge-muted">已结束</span>';
    return '<span class="badge badge-warning">草稿</span>';
  },

  /** 发布：按层级自动展开参训名单 */
  async publish(id) {
    const p = this.state.list.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`发布后系统会按层级自动把「${p.title}」推送给覆盖范围内的在职员工，员工登录即可看到并开始学习。\n\n确定发布？`)) return;
    const { data, error } = await sb.rpc('training_publish_plan', { p_plan_id: id });
    if (error) { alert('发布失败：' + (error.message || '')); return; }
    await this.load();
    alert(`已发布，自动推送给 ${data.assigned} 名员工。`);
    if (data.assigned === 0) alert('提示：覆盖范围内没有在职员工。请检查计划层级、覆盖部门，或员工是否已导入并归属部门。');
  },

  filtered() {
    const { year, level, status } = this.state.filters;
    return this.state.list.filter(p => {
      if (year && String(p.plan_year) !== String(year)) return false;
      if (level && p.level !== level) return false;
      if (status && p.status !== status) return false;
      return true;
    });
  },

  renderTable() {
    const box = document.getElementById('plan-table');
    if (!box) return;
    const rows = this.filtered();
    const canEdit = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>培训计划（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:70px">层级</th>
                <th>培训名称</th>
                <th style="width:100px">类别</th>
                <th style="width:130px">组织部门</th>
                <th style="width:150px">计划时间</th>
                <th style="width:70px">学时</th>
                <th style="width:120px">讲师/单位</th>
                <th style="width:150px">适用范围</th>
                <th style="width:90px">发布</th>
                <th style="width:130px">完成情况</th>
                <th style="width:80px">状态</th>
                <th style="width:${canEdit ? '230px' : '90px'}">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(canEdit ? 11 : 10, '暂无培训计划')
                : rows.map(p => `
                  <tr>
                    <td>${this.levelBadge(p.level)}</td>
                    <td title="${Utils.escapeHtml(p.title)}">${Utils.escapeHtml(p.title)}</td>
                    <td>${Utils.escapeHtml(p.category || '')}</td>
                    <td>${Utils.escapeHtml(TrainingModule.deptName(p.department_id))}</td>
                    <td>${this.dateRange(p)}</td>
                    <td>${p.hours != null ? p.hours : ''}</td>
                    <td>${Utils.escapeHtml(p.trainer || '')}</td>
                    <td>${this.targetText(p)}</td>
                    <td>${this.publishBadge(p.publish_status)}</td>
                    <td>${this.progressCell(p)}</td>
                    <td>${this.statusBadge(p.status)}</td>
                    <td>
                      ${canEdit ? `
                        ${p.publish_status === 'draft'
                          ? `<button class="btn btn-sm btn-primary" onclick="TrainingPlans.publish('${p.id}')">发布</button>`
                          : `<button class="btn btn-sm btn-secondary" onclick="TrainingPlans.openExecution('${p.id}')">执行</button>`}
                        <button class="btn btn-sm btn-secondary" onclick="TrainingCourses.open('${p.id}')">课件</button>
                        <button class="btn btn-sm btn-secondary" onclick="TrainingPlans.openForm('${p.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingPlans.remove('${p.id}')">删除</button>`
                        : `<button class="btn btn-sm btn-secondary" onclick="TrainingPlans.openExecution('${p.id}')">执行</button>`}
                    </td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  levelBadge(lv) {
    const cls = lv === 'company' ? 'badge-danger' : (lv === 'project' ? 'badge-warning' : 'badge-success');
    return `<span class="badge ${cls}">${this.LEVEL_LABEL[lv] || '部门级'}</span>`;
  },

  statusBadge(s) {
    const cls = { planned: 'badge-muted', ongoing: 'badge-info', done: 'badge-success', cancelled: 'badge-danger' }[s] || 'badge-muted';
    return `<span class="badge ${cls}">${this.STATUS_LABEL[s] || s}</span>`;
  },

  dateRange(p) {
    if (p.start_date && p.end_date) return `${p.start_date} ~ ${p.end_date}`;
    if (p.start_date) return String(p.start_date);
    return p.plan_month ? `${p.plan_year}年${p.plan_month}月` : `${p.plan_year}年`;
  },

  targetText(p) {
    const ids = this.state.targets[p.id] || [];
    if (!ids.length) return Utils.escapeHtml(p.target_desc || '—');
    const names = ids.map(id => TrainingModule.deptName(id)).slice(0, 2).join('、');
    return Utils.escapeHtml(ids.length > 2 ? `${names} 等${ids.length}个部门` : names);
  },

  /** 执行情况列：显示 已上报/总数，点击查看详情 */
  executionCell(p) {
    const rows = (this.state.targetRows || []).filter(t => t.plan_id === p.id);
    if (!rows.length) {
      return `<button class="btn btn-sm btn-secondary" onclick="TrainingPlans.openExecution('${p.id}')">查看</button>`;
    }
    const done = rows.filter(t => t.status === 'reported').length;
    const cls = done === rows.length ? '#22c55e' : (done ? '#f59e0b' : '#6b7280');
    return `<button class="btn btn-sm btn-secondary" onclick="TrainingPlans.openExecution('${p.id}')"
      style="color:${cls};font-weight:600">${done}/${rows.length}</button>`;
  },

  // ---------------------------------------------------------------- 执行上报
  async openExecution(planId) {
    const p = this.state.list.find(x => x.id === planId);
    if (!p) return;
    const rows = (this.state.targetRows || []).filter(t => t.plan_id === planId);
    const canEdit = TrainingModule.canEdit();

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingPlans.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:820px">
          <div class="modal-header">
            <h3>执行情况 — ${Utils.escapeHtml(p.title)}</h3>
            <button class="modal-close" onclick="TrainingPlans.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              计划下发 ${rows.length} 个部门；上报完成后系统自动生成培训记录，并按部门档案带入在职员工为参训人员。
              ${p.require_exam ? '<b>（该计划要求考试，上报时会自动生成一条待填的考试登记）</b>' : ''}
            </p>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:180px">部门</th>
                  <th style="width:110px">要求完成</th>
                  <th style="width:90px">状态</th>
                  <th style="width:110px">实际日期</th>
                  <th style="width:90px">参训人数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? TrainingModule.emptyRow(6, '该计划尚未下发到具体部门（可在编辑里勾选下发部门）')
                  : rows.map(t => `
                    <tr>
                      <td>${Utils.escapeHtml(TrainingModule.deptName(t.department_id))}</td>
                      <td>${Utils.escapeHtml(t.due_date || '—')}</td>
                      <td>${t.status === 'reported'
                          ? '<span class="badge badge-success">已上报</span>'
                          : (t.status === 'skipped'
                              ? '<span class="badge badge-muted">已跳过</span>'
                              : '<span class="badge badge-warning">待上报</span>')}</td>
                      <td>${Utils.escapeHtml(t.actual_date || '—')}</td>
                      <td>${t.participant_count || 0}</td>
                      <td>
                        ${t.status === 'reported'
                          ? `<button class="btn btn-sm btn-secondary" onclick="TrainingPlans.closeForm();TrainingModule.switchView('records')">查看记录</button>`
                          : (canEdit
                              ? `<button class="btn btn-sm btn-primary" onclick="TrainingPlans.openReportForm('${t.id}')">上报完成</button>`
                              : '—')}
                      </td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingPlans.closeForm()">关闭</button>
          </div>
        </div>
      </div>
    `;
  },

  openReportForm(targetId) {
    const t = (this.state.targetRows || []).find(x => x.id === targetId);
    if (!t) return;
    const plan = this.state.list.find(p => p.id === t.plan_id) || {};

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingPlans.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>上报完成 — ${Utils.escapeHtml(TrainingModule.deptName(t.department_id))}</h3>
            <button class="modal-close" onclick="TrainingPlans.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              培训名称：${Utils.escapeHtml(plan.title || '')}
              ${plan.require_exam ? '<b>｜含考试</b>' : ''}
            </p>
            <div class="form-row">
              <div class="form-group">
                <label>实际培训日期 <span class="required">*</span></label>
                <input id="rep-date" type="date" class="form-control" value="${new Date().toISOString().slice(0, 10)}">
              </div>
              <div class="form-group">
                <label>学时</label>
                <input id="rep-hours" type="number" step="0.5" class="form-control" value="${plan.hours != null ? plan.hours : ''}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>讲师 / 组织单位</label>
                <input id="rep-trainer" class="form-control" value="${Utils.escapeHtml(plan.trainer || '')}">
              </div>
              <div class="form-group">
                <label>培训地点</label>
                <input id="rep-location" class="form-control" value="${Utils.escapeHtml(plan.location || '')}">
              </div>
            </div>
            <div class="form-group">
              <label>签到方式</label>
              <select id="rep-sign" class="form-control">
                <option value="sign_sheet">签到表</option>
                <option value="photo">拍照留痕</option>
                <option value="gps">定位签到</option>
                <option value="manual">手工登记</option>
              </select>
            </div>
            <div class="form-group">
              <label>培训内容</label>
              <textarea id="rep-content" class="form-control" rows="2">${Utils.escapeHtml(plan.content || '')}</textarea>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:8px">
              <input id="rep-exam" type="checkbox" ${plan.require_exam ? 'checked' : ''} style="width:16px;height:16px">
              <label for="rep-exam" style="margin:0">本次组织了考试（勾选后自动生成一条待填的考试登记）</label>
            </div>
            <p class="text-muted" style="font-size:12px">
              提交后：自动生成培训记录 → 按部门档案带入在职员工为参训人员${plan.require_exam ? ' → 自动生成待填的考试登记' : ''}
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingPlans.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingPlans.submitReport('${targetId}')">提交上报</button>
          </div>
        </div>
      </div>
    `;
  },

  async submitReport(targetId) {
    const { data, error } = await sb.rpc('training_report_complete', {
      p_target_id: targetId,
      p_actual_date: document.getElementById('rep-date').value || null,
      p_hours: document.getElementById('rep-hours').value ? parseFloat(document.getElementById('rep-hours').value) : null,
      p_sign_method: document.getElementById('rep-sign').value,
      p_trainer: document.getElementById('rep-trainer').value.trim() || null,
      p_location: document.getElementById('rep-location').value.trim() || null,
      p_content: document.getElementById('rep-content').value.trim() || null,
      p_with_exam: document.getElementById('rep-exam').checked,
    });
    if (error) { alert('上报失败：' + error.message); return; }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast('已上报，培训记录已自动生成');
    await this.openExecution(this.state.list.find(p =>
      (this.state.targetRows || []).some(t => t.id === targetId && t.plan_id === p.id))?.id || '');
  },

  // ---------------------------------------------------------------- 表单
  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  openForm(id) {
    const p = id ? this.state.list.find(x => x.id === id) : null;
    const selected = id ? (this.state.targets[id] || []) : [];
    const myDept = (Auth.currentProfile || {}).department_id || '';

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingPlans.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:640px">
          <div class="modal-header">
            <h3>${p ? '编辑培训计划' : '新建培训计划'}</h3>
            <button class="modal-close" onclick="TrainingPlans.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>培训名称 <span class="required">*</span></label>
              <input id="plan-title" class="form-control" value="${Utils.escapeHtml(p ? p.title : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>计划层级</label>
                <select id="plan-level" class="form-control">
                  <option value="company"${p && p.level === 'company' ? ' selected' : ''}>公司级</option>
                  <option value="dept"${(!p || p.level === 'dept') ? ' selected' : ''}>部门级</option>
                  <option value="project"${p && p.level === 'project' ? ' selected' : ''}>项目级</option>
                </select>
              </div>
              <div class="form-group">
                <label>组织部门</label>
                <select id="plan-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(p ? p.department_id : myDept, false)}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>培训类别</label>
                <input id="plan-category" class="form-control" placeholder="如 入场三级教育 / 年度再培训 / 专项培训"
                  value="${Utils.escapeHtml(p ? (p.category || '') : '')}">
              </div>
              <div class="form-group">
                <label>计划年度</label>
                <input id="plan-year" type="number" class="form-control" value="${p ? p.plan_year : new Date().getFullYear()}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>开始日期</label>
                <input id="plan-start" type="date" class="form-control" value="${p ? (p.start_date || '') : ''}">
              </div>
              <div class="form-group">
                <label>结束日期</label>
                <input id="plan-end" type="date" class="form-control" value="${p ? (p.end_date || '') : ''}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>计划学时</label>
                <input id="plan-hours" type="number" step="0.5" class="form-control" value="${p && p.hours != null ? p.hours : ''}">
              </div>
              <div class="form-group">
                <label>讲师 / 组织单位</label>
                <input id="plan-trainer" class="form-control" value="${Utils.escapeHtml(p ? (p.trainer || '') : '')}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>完成截止时间</label>
                <input id="plan-deadline" type="date" class="form-control" value="${p ? (p.deadline || '') : ''}">
              </div>
              <div class="form-group">
                <label>要求学时（完成后计入档案）</label>
                <input id="plan-required-hours" type="number" step="0.5" class="form-control" value="${p && p.required_hours != null ? p.required_hours : ''}">
              </div>
            </div>
            <p class="text-muted" style="font-size:12px;margin-top:-4px">
              覆盖范围规则：公司级 → 全体在职员工；部门级 / 项目级 → 下面勾选的部门（含其下级部门），不勾选则为计划所属部门。
            </p>
            <div class="form-row">
              <div class="form-group">
                <label>培训地点</label>
                <input id="plan-location" class="form-control" value="${Utils.escapeHtml(p ? (p.location || '') : '')}">
              </div>
              <div class="form-group">
                <label>状态</label>
                <select id="plan-status" class="form-control">
                  ${Object.entries(this.STATUS_LABEL).map(([k, v]) =>
                    `<option value="${k}"${(p ? p.status : 'planned') === k ? ' selected' : ''}>${v}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>适用对象说明</label>
              <input id="plan-target-desc" class="form-control" placeholder="如：全体作业人员 / 新进场人员"
                value="${Utils.escapeHtml(p ? (p.target_desc || '') : '')}">
            </div>
            <div class="form-group">
              <label>考试关联模式</label>
              <select id="plan-exam-mode" class="form-control">
                <option value="none"${(!p || p.exam_mode === 'none') ? ' selected' : ''}>仅培训，不考试</option>
                <option value="auto"${p && p.exam_mode === 'auto' ? ' selected' : ''}>课件学完自动触发考试</option>
                <option value="manual"${p && p.exam_mode === 'manual' ? ' selected' : ''}>管理员手动发起考试</option>
              </select>
              <p class="text-muted" style="font-size:12px;margin:4px 0 0">
                需先在「试卷管理」创建并发布挂接本计划的试卷，考试才会生效。
              </p>
            </div>
            <div class="form-group">
              <label>下发部门（可不选，用于跟踪各单位完成情况）</label>
              <div style="max-height:150px;overflow:auto;border:1px solid var(--color-border);border-radius:6px;padding:8px">
                ${TrainingModule.state.depts.map(d => `
                  <label style="display:inline-block;min-width:150px;font-weight:400;margin-bottom:4px">
                    <input type="checkbox" class="plan-target-cb" value="${d.id}"${selected.includes(d.id) ? ' checked' : ''}>
                    ${Utils.escapeHtml(d.name)}
                  </label>`).join('')}
              </div>
            </div>
            <div class="form-group">
              <label>培训内容摘要</label>
              <textarea id="plan-content" class="form-control" rows="2">${Utils.escapeHtml(p ? (p.content || '') : '')}</textarea>
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea id="plan-remark" class="form-control" rows="2">${Utils.escapeHtml(p ? (p.remark || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingPlans.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingPlans.submit('${p ? p.id : ''}')">保存</button>
          </div>
        </div>
      </div>
    `;
  },

  closeForm() {
    const d = document.getElementById('training-modal-host');
    if (d) d.innerHTML = '';
  },

  async submit(id) {
    const payload = {
      title: document.getElementById('plan-title').value.trim(),
      level: document.getElementById('plan-level').value,
      department_id: document.getElementById('plan-dept').value || null,
      category: document.getElementById('plan-category').value.trim() || null,
      plan_year: parseInt(document.getElementById('plan-year').value, 10) || new Date().getFullYear(),
      start_date: document.getElementById('plan-start').value || null,
      end_date: document.getElementById('plan-end').value || null,
      hours: document.getElementById('plan-hours').value ? parseFloat(document.getElementById('plan-hours').value) : null,
      deadline: document.getElementById('plan-deadline').value || null,
      required_hours: document.getElementById('plan-required-hours').value
        ? parseFloat(document.getElementById('plan-required-hours').value) : null,
      trainer: document.getElementById('plan-trainer').value.trim() || null,
      location: document.getElementById('plan-location').value.trim() || null,
      status: document.getElementById('plan-status').value,
      exam_mode: document.getElementById('plan-exam-mode').value || 'none',
      target_desc: document.getElementById('plan-target-desc').value.trim() || null,
      content: document.getElementById('plan-content').value.trim() || null,
      remark: document.getElementById('plan-remark').value.trim() || null,
    };
    if (!payload.title) { alert('请填写培训名称'); return; }

    const targets = Array.from(document.querySelectorAll('.plan-target-cb:checked')).map(cb => cb.value);

    let planId = id, error;
    if (id) {
      ({ error } = await sb.from('training_plans').update(payload).eq('id', id));
    } else {
      payload.created_by = Auth.currentUser ? Auth.currentUser.id : null;
      const res = await sb.from('training_plans').insert(payload).select('id').single();
      error = res.error;
      planId = res.data ? res.data.id : null;
    }
    if (error) { alert('保存失败：' + error.message); return; }

    await sb.from('training_plan_targets').delete().eq('plan_id', planId);
    if (targets.length) {
      const rows = targets.map(depId => ({ plan_id: planId, department_id: depId }));
      const tErr = (await sb.from('training_plan_targets').insert(rows)).error;
      if (tErr) alert('计划已保存，但下发部门保存失败：' + tErr.message);
    }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(id ? '已保存' : '已新建计划');
  },

  async remove(id) {
    const p = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除培训计划「${p ? p.title : ''}」？`)) return;
    const { error } = await sb.from('training_plans').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },
};

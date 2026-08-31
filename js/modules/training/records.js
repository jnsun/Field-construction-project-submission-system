// =============================================================
// js/modules/training/records.js —— 培训记录 + 参训人员明细
// 一次培训 = 一条记录；参训人员在详情弹窗里维护（签到/成绩/结果）
// =============================================================
const TrainingRecords = {

  state: {
    list: [],
    employees: [],
    filters: { year: String(new Date().getFullYear()), dept: '', source: '' },
  },

  SIGN_LABEL: { manual: '手工登记', sign_sheet: '签到表', photo: '拍照留痕', gps: '定位签到' },
  RESULT_LABEL: { pass: '合格', fail: '不合格', absent: '缺考/缺勤', unknown: '未记录' },

  async render(box) {
    const years = Utils.getYearOptions ? Utils.getYearOptions() : [new Date().getFullYear()];
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>年度：</label>
          <select id="rec-filter-year" onchange="TrainingRecords.onFilterChange()">
            <option value="">全部</option>
            ${years.map(y => `<option value="${y}"${String(y) === this.state.filters.year ? ' selected' : ''}>${y}年</option>`).join('')}
          </select>
          <label>组织部门：</label>
          <select id="rec-filter-dept" onchange="TrainingRecords.onFilterChange()">
            ${TrainingModule.deptOptions(this.state.filters.dept, true)}
          </select>
          <label>来源：</label>
          <select id="rec-filter-source" onchange="TrainingRecords.onFilterChange()">
            <option value="">全部</option>
            <option value="auto"${this.state.filters.source === 'auto' ? ' selected' : ''}>计划自动上报</option>
            <option value="manual"${this.state.filters.source === 'manual' ? ' selected' : ''}>手工登记</option>
          </select>
        </div>
        <div class="toolbar-right">
          ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingRecords.openForm()">+ 登记培训</button>' : ''}
        </div>
      </div>
      <div id="rec-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.year = document.getElementById('rec-filter-year').value;
    this.state.filters.dept = document.getElementById('rec-filter-dept').value;
    this.state.filters.source = document.getElementById('rec-filter-source').value;
    this.renderTable();
  },

  async load() {
    const [{ data, error }, emps] = await Promise.all([
      sb.from('training_records')
        .select('id, plan_id, title, train_date, hours, trainer, location, department_id, content, participant_count, sign_method, remark, source')
        .order('train_date', { ascending: false }),
      sb.from('training_employees').select('id, name, department_id, position, status').eq('status', 'active').order('name'),
    ]);
    if (error) throw error;
    this.state.list = data || [];
    this.state.employees = emps.data || [];
    this.renderTable();
  },

  filtered() {
    const { year, dept, source } = this.state.filters;
    return this.state.list.filter(r => {
      if (year && !(r.train_date || '').startsWith(String(year))) return false;
      if (dept && r.department_id !== dept) return false;
      if (source && (r.source || 'manual') !== source) return false;
      return true;
    });
  },

  renderTable() {
    const box = document.getElementById('rec-table');
    if (!box) return;
    const rows = this.filtered();
    const canEdit = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>培训记录（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:110px">培训日期</th>
                <th>培训内容/名称</th>
                <th style="width:130px">组织部门</th>
                <th style="width:70px">学时</th>
                <th style="width:120px">讲师/单位</th>
                <th style="width:110px">地点</th>
                <th style="width:90px">参训人数</th>
                <th style="width:100px">签到方式</th>
                <th style="width:100px">来源</th>
                <th style="width:${canEdit ? '180px' : '80px'}">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(9, '暂无培训记录')
                : rows.map(r => `
                  <tr>
                    <td>${Utils.escapeHtml(r.train_date || '')}</td>
                    <td title="${Utils.escapeHtml(r.title)}">${Utils.escapeHtml(r.title)}</td>
                    <td>${Utils.escapeHtml(TrainingModule.deptName(r.department_id))}</td>
                    <td>${r.hours != null ? r.hours : ''}</td>
                    <td>${Utils.escapeHtml(r.trainer || '')}</td>
                    <td>${Utils.escapeHtml(r.location || '')}</td>
                    <td>${r.participant_count || 0}</td>
                    <td>${this.SIGN_LABEL[r.sign_method] || '手工登记'}</td>
                    <td>${r.source === 'auto'
                        ? '<span class="badge badge-info">自动上报</span>'
                        : '<span class="badge badge-muted">手工登记</span>'}</td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="TrainingRecords.openDetail('${r.id}')">人员明细</button>
                      ${canEdit ? `
                        <button class="btn btn-sm btn-secondary" onclick="TrainingRecords.openForm('${r.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingRecords.remove('${r.id}')">删除</button>` : ''}
                    </td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  // ---------------------------------------------------------------- 记录表单
  openForm(id) {
    const r = id ? this.state.list.find(x => x.id === id) : null;
    const myDept = (Auth.currentProfile || {}).department_id || '';

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingRecords.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:600px">
          <div class="modal-header">
            <h3>${r ? '编辑培训记录' : '登记培训'}</h3>
            <button class="modal-close" onclick="TrainingRecords.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>培训名称 <span class="required">*</span></label>
              <input id="rec-title" class="form-control" value="${Utils.escapeHtml(r ? r.title : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>培训日期 <span class="required">*</span></label>
                <input id="rec-date" type="date" class="form-control" value="${r ? r.train_date : new Date().toISOString().slice(0, 10)}">
              </div>
              <div class="form-group">
                <label>学时</label>
                <input id="rec-hours" type="number" step="0.5" class="form-control" value="${r && r.hours != null ? r.hours : ''}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>组织部门</label>
                <select id="rec-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(r ? r.department_id : myDept, false)}
                </select>
              </div>
              <div class="form-group">
                <label>关联计划</label>
                <select id="rec-plan" class="form-control">
                  <option value="">不关联</option>
                  ${(TrainingPlans.state.list || []).map(p =>
                    `<option value="${p.id}"${r && r.plan_id === p.id ? ' selected' : ''}>${Utils.escapeHtml(p.title)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>讲师 / 组织单位</label>
                <input id="rec-trainer" class="form-control" value="${Utils.escapeHtml(r ? (r.trainer || '') : '')}">
              </div>
              <div class="form-group">
                <label>培训地点</label>
                <input id="rec-location" class="form-control" value="${Utils.escapeHtml(r ? (r.location || '') : '')}">
              </div>
            </div>
            <div class="form-group">
              <label>签到方式</label>
              <select id="rec-sign" class="form-control">
                ${Object.entries(this.SIGN_LABEL).map(([k, v]) =>
                  `<option value="${k}"${(r ? r.sign_method : 'manual') === k ? ' selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>培训内容</label>
              <textarea id="rec-content" class="form-control" rows="2">${Utils.escapeHtml(r ? (r.content || '') : '')}</textarea>
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea id="rec-remark" class="form-control" rows="2">${Utils.escapeHtml(r ? (r.remark || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingRecords.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingRecords.submit('${r ? r.id : ''}')">保存</button>
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
      title: document.getElementById('rec-title').value.trim(),
      train_date: document.getElementById('rec-date').value,
      hours: document.getElementById('rec-hours').value ? parseFloat(document.getElementById('rec-hours').value) : null,
      department_id: document.getElementById('rec-dept').value || null,
      plan_id: document.getElementById('rec-plan').value || null,
      trainer: document.getElementById('rec-trainer').value.trim() || null,
      location: document.getElementById('rec-location').value.trim() || null,
      sign_method: document.getElementById('rec-sign').value,
      content: document.getElementById('rec-content').value.trim() || null,
      remark: document.getElementById('rec-remark').value.trim() || null,
    };
    if (!payload.title || !payload.train_date) { alert('请填写培训名称与日期'); return; }

    let error;
    if (id) {
      ({ error } = await sb.from('training_records').update(payload).eq('id', id));
    } else {
      payload.created_by = Auth.currentUser ? Auth.currentUser.id : null;
      ({ error } = await sb.from('training_records').insert(payload));
    }
    if (error) { alert('保存失败：' + error.message); return; }
    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(id ? '已保存' : '已登记');
  },

  async remove(id) {
    const r = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除培训记录「${r ? r.title : ''}」？参训明细会一并删除。`)) return;
    const { error } = await sb.from('training_records').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },

  // ---------------------------------------------------------------- 参训人员明细
  async openDetail(recordId) {
    const r = this.state.list.find(x => x.id === recordId);
    if (!r) return;
    const { data, error } = await sb.from('training_participants')
      .select('id, employee_id, employee_name, department_id, signed, score, result, remark')
      .eq('record_id', recordId).order('employee_name');
    if (error) { alert('加载明细失败：' + error.message); return; }

    const parts = data || [];
    const canEdit = TrainingModule.canEdit();

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingRecords.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:780px">
          <div class="modal-header">
            <h3>参训人员明细 — ${Utils.escapeHtml(r.title)}</h3>
            <button class="modal-close" onclick="TrainingRecords.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              ${Utils.escapeHtml(r.train_date || '')} ｜ 共 ${parts.length} 人
            </p>
            ${canEdit ? `
              <div class="form-row" style="align-items:flex-end">
                <div class="form-group" style="flex:2">
                  <label>选择员工</label>
                  <select id="part-emp" class="form-control">
                    ${this.state.employees.map(e =>
                      `<option value="${e.id}">${Utils.escapeHtml(e.name)}${e.position ? '（' + Utils.escapeHtml(e.position) + '）' : ''}</option>`).join('')}
                  </select>
                </div>
                <div class="form-group" style="flex:1">
                  <label>成绩</label>
                  <input id="part-score" type="number" step="0.5" class="form-control" placeholder="可空">
                </div>
                <div class="form-group">
                  <button class="btn btn-primary btn-sm" onclick="TrainingRecords.addParticipant('${recordId}')">添加</button>
                </div>
              </div>` : ''}
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:110px">姓名</th>
                  <th style="width:140px">所属部门</th>
                  <th style="width:80px">签到</th>
                  <th style="width:80px">成绩</th>
                  <th style="width:100px">结果</th>
                  ${canEdit ? '<th style="width:70px">操作</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${parts.length === 0
                  ? TrainingModule.emptyRow(canEdit ? 6 : 5, '尚未登记参训人员')
                  : parts.map(p => `
                    <tr>
                      <td>${Utils.escapeHtml(p.employee_name)}</td>
                      <td>${Utils.escapeHtml(TrainingModule.deptName(p.department_id))}</td>
                      <td>${p.signed ? '<span class="badge badge-success">已签到</span>' : '<span class="badge badge-muted">未签到</span>'}</td>
                      <td>${p.score != null ? p.score : '—'}</td>
                      <td>${this.resultBadge(p.result)}</td>
                      ${canEdit ? `<td><button class="btn btn-sm btn-danger" onclick="TrainingRecords.removeParticipant('${p.id}', '${recordId}')">移除</button></td>` : ''}
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingRecords.closeForm()">关闭</button>
          </div>
        </div>
      </div>
    `;
  },

  resultBadge(res) {
    const cls = { pass: 'badge-success', fail: 'badge-danger', absent: 'badge-warning' }[res] || 'badge-muted';
    return `<span class="badge ${cls}">${this.RESULT_LABEL[res] || '未记录'}</span>`;
  },

  async addParticipant(recordId) {
    const empId = document.getElementById('part-emp').value;
    const scoreRaw = document.getElementById('part-score').value;
    const emp = this.state.employees.find(e => e.id === empId);
    if (!emp) return;

    const score = scoreRaw === '' ? null : parseFloat(scoreRaw);
    let result = 'unknown';
    if (score != null) result = score >= 60 ? 'pass' : 'fail';

    const { error } = await sb.from('training_participants').insert({
      record_id: recordId,
      employee_id: emp.id,
      employee_name: emp.name,
      department_id: emp.department_id,
      signed: true,
      score,
      result,
    });
    if (error) { alert('添加失败：' + error.message); return; }

    await this.syncCount(recordId);
    await this.load();
    await this.openDetail(recordId);
  },

  async removeParticipant(partId, recordId) {
    const { error } = await sb.from('training_participants').delete().eq('id', partId);
    if (error) { alert('移除失败：' + error.message); return; }
    await this.syncCount(recordId);
    await this.load();
    await this.openDetail(recordId);
  },

  /** 同步培训记录上的参训人数 */
  async syncCount(recordId) {
    const { count } = await sb.from('training_participants')
      .select('id', { count: 'exact', head: true }).eq('record_id', recordId);
    await sb.from('training_records').update({ participant_count: count || 0 }).eq('id', recordId);
  },
};

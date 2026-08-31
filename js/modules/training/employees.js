// =============================================================
// js/modules/training/employees.js —— 员工档案（一人一档）
// v1：员工本人不登录，由管理员录入与维护
// =============================================================
const TrainingEmployees = {

  state: {
    list: [],
    filters: { dept: '', status: '', keyword: '' },
  },

  async render(box) {
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>部门：</label>
          <select id="emp-filter-dept" onchange="TrainingEmployees.onFilterChange()">
            ${TrainingModule.deptOptions(this.state.filters.dept, true)}
          </select>
          <label>状态：</label>
          <select id="emp-filter-status" onchange="TrainingEmployees.onFilterChange()">
            <option value="">全部</option>
            <option value="active"${this.state.filters.status === 'active' ? ' selected' : ''}>在职</option>
            <option value="left"${this.state.filters.status === 'left' ? ' selected' : ''}>离职</option>
          </select>
        </div>
        <div class="toolbar-right">
          <input type="search" id="emp-search" class="toolbar-search" placeholder="搜索姓名/工号/岗位/手机号"
            value="${Utils.escapeHtml(this.state.filters.keyword)}" oninput="TrainingEmployees.onSearch()">
          ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingEmployees.openForm()">+ 新增员工</button>' : ''}
        </div>
      </div>
      <div id="emp-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.dept = document.getElementById('emp-filter-dept').value;
    this.state.filters.status = document.getElementById('emp-filter-status').value;
    this.renderTable();
  },

  onSearch() {
    this.state.filters.keyword = document.getElementById('emp-search').value.trim();
    this.renderTable();
  },

  async load() {
    const { data, error } = await sb
      .from('training_employees')
      .select('id, name, employee_no, department_id, position, id_number, phone, hire_date, emp_type, status, remark')
      .order('name');
    if (error) throw error;
    this.state.list = data || [];
    this.renderTable();
  },

  filtered() {
    const { dept, status, keyword } = this.state.filters;
    const kw = (keyword || '').toLowerCase();
    return this.state.list.filter(e => {
      if (dept && e.department_id !== dept) return false;
      if (status && e.status !== status) return false;
      if (kw && ![e.name, e.employee_no, e.position, e.phone].join(' ').toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  renderTable() {
    const box = document.getElementById('emp-table');
    if (!box) return;
    const rows = this.filtered();
    const canEdit = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>员工档案（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:110px">姓名</th>
                <th style="width:100px">工号</th>
                <th style="width:150px">所属部门</th>
                <th style="width:130px">岗位/工种</th>
                <th style="width:150px">身份证号</th>
                <th style="width:120px">手机号</th>
                <th style="width:110px">入职日期</th>
                <th style="width:80px">类型</th>
                <th style="width:70px">状态</th>
                <th style="width:${canEdit ? '200px' : '90px'}">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(10, '暂无员工档案')
                : rows.map(e => `
                  <tr>
                    <td>${Utils.escapeHtml(e.name)}</td>
                    <td>${Utils.escapeHtml(e.employee_no || '')}</td>
                    <td>${Utils.escapeHtml(TrainingModule.deptName(e.department_id))}</td>
                    <td>${Utils.escapeHtml(e.position || '')}</td>
                    <td>${Utils.escapeHtml(Utils.maskIdNumber ? Utils.maskIdNumber(e.id_number) : (e.id_number || ''))}</td>
                    <td>${Utils.escapeHtml(e.phone || '')}</td>
                    <td>${Utils.escapeHtml(e.hire_date || '')}</td>
                    <td>${this.typeLabel(e.emp_type)}</td>
                    <td>${e.status === 'left'
                        ? '<span class="badge badge-muted">离职</span>'
                        : '<span class="badge badge-success">在职</span>'}</td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openHistory('${e.id}')">培训档案</button>
                      ${canEdit ? `
                        <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openForm('${e.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingEmployees.remove('${e.id}')">删除</button>` : ''}
                    </td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  typeLabel(t) {
    return { employee: '普通员工', special: '特种作业', manager: '管理人员' }[t] || '普通员工';
  },

  /** 个人培训档案（一人一档）：列出该员工历年培训与成绩 */
  async openHistory(empId) {
    const emp = this.state.list.find(x => x.id === empId);
    if (!emp) return;
    const { data, error } = await sb.rpc('training_employee_history', { p_employee_id: empId });
    if (error) { alert('加载培训档案失败：' + error.message); return; }
    const rows = data || [];

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:720px">
          <div class="modal-header">
            <h3>个人培训档案 — ${Utils.escapeHtml(emp.name)}</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              ${Utils.escapeHtml(TrainingModule.deptName(emp.department_id))} ｜
              ${Utils.escapeHtml(emp.position || '')} ｜ 累计参训 ${rows.length} 次
            </p>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:110px">培训日期</th>
                  <th>培训名称</th>
                  <th style="width:70px">学时</th>
                  <th style="width:80px">签到</th>
                  <th style="width:80px">成绩</th>
                  <th style="width:90px">结果</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? TrainingModule.emptyRow(6, '暂无参训记录')
                  : rows.map(r => `
                    <tr>
                      <td>${Utils.escapeHtml(r.train_date || '')}</td>
                      <td>${Utils.escapeHtml(r.title || '')}</td>
                      <td>${r.hours != null ? r.hours : '—'}</td>
                      <td>${r.signed ? '<span class="badge badge-success">已签到</span>' : '<span class="badge badge-muted">未签到</span>'}</td>
                      <td>${r.score != null ? r.score : '—'}</td>
                      <td>${TrainingRecords.resultBadge(r.result)}</td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">关闭</button>
          </div>
        </div>
      </div>
    `;
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
    const e = id ? this.state.list.find(x => x.id === id) : null;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>${e ? '编辑员工' : '新增员工'}</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>姓名 <span class="required">*</span></label>
              <input id="emp-name" class="form-control" value="${Utils.escapeHtml(e ? e.name : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>工号</label>
                <input id="emp-no" class="form-control" value="${Utils.escapeHtml(e ? (e.employee_no || '') : '')}">
              </div>
              <div class="form-group">
                <label>所属部门</label>
                <select id="emp-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(e ? e.department_id : '', false)}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>岗位/工种</label>
                <input id="emp-position" class="form-control" value="${Utils.escapeHtml(e ? (e.position || '') : '')}">
              </div>
              <div class="form-group">
                <label>人员类型</label>
                <select id="emp-type" class="form-control">
                  <option value="employee"${e && e.emp_type === 'employee' ? ' selected' : ''}>普通员工</option>
                  <option value="special"${e && e.emp_type === 'special' ? ' selected' : ''}>特种作业</option>
                  <option value="manager"${e && e.emp_type === 'manager' ? ' selected' : ''}>管理人员</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>身份证号</label>
                <input id="emp-idnumber" class="form-control" value="${Utils.escapeHtml(e ? (e.id_number || '') : '')}">
              </div>
              <div class="form-group">
                <label>手机号</label>
                <input id="emp-phone" class="form-control" value="${Utils.escapeHtml(e ? (e.phone || '') : '')}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>入职日期</label>
                <input id="emp-hire" type="date" class="form-control" value="${e ? (e.hire_date || '') : ''}">
              </div>
              <div class="form-group">
                <label>状态</label>
                <select id="emp-status" class="form-control">
                  <option value="active"${e && e.status === 'active' ? ' selected' : ''}>在职</option>
                  <option value="left"${e && e.status === 'left' ? ' selected' : ''}>离职</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea id="emp-remark" class="form-control" rows="2">${Utils.escapeHtml(e ? (e.remark || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingEmployees.submit('${e ? e.id : ''}')">保存</button>
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
      name: document.getElementById('emp-name').value.trim(),
      employee_no: document.getElementById('emp-no').value.trim() || null,
      department_id: document.getElementById('emp-dept').value || null,
      position: document.getElementById('emp-position').value.trim() || null,
      emp_type: document.getElementById('emp-type').value,
      id_number: document.getElementById('emp-idnumber').value.trim() || null,
      phone: document.getElementById('emp-phone').value.trim() || null,
      hire_date: document.getElementById('emp-hire').value || null,
      status: document.getElementById('emp-status').value,
      remark: document.getElementById('emp-remark').value.trim() || null,
    };
    if (!payload.name) { alert('请填写姓名'); return; }

    let error;
    if (id) {
      ({ error } = await sb.from('training_employees').update(payload).eq('id', id));
    } else {
      payload.created_by = Auth.currentUser ? Auth.currentUser.id : null;
      ({ error } = await sb.from('training_employees').insert(payload));
    }
    if (error) { alert('保存失败：' + error.message); return; }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(id ? '已保存' : '已新增');
  },

  async remove(id) {
    const e = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除员工「${e ? e.name : ''}」？该员工的参训记录会保留姓名快照，不受影响。`)) return;
    const { error } = await sb.from('training_employees').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },
};

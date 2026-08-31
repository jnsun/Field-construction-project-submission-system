// =============================================================
// js/modules/training/employees.js —— 员工档案（一人一档）
// v1：员工本人不登录，由管理员录入与维护
// =============================================================
const TrainingEmployees = {

  state: {
    list: [],
    filters: { dept: '', status: '', keyword: '' },
    selected: new Set(),     // 批量删除勾选的员工 id
    view: localStorage.getItem('emp-view') || 'table',   // table 表格 | card 方块
    expanded: new Set(JSON.parse(localStorage.getItem('emp-expanded') || '[]')), // 展开的部门组（默认全折叠）
    profileMap: {},          // user_id -> profiles 行（管理员标识，读不到时静默降级）
  },

  setView(v) {
    this.state.view = v;
    localStorage.setItem('emp-view', v);
    this.renderTable();
  },

  toggleGroup(key) {
    if (this.state.expanded.has(key)) this.state.expanded.delete(key);
    else this.state.expanded.add(key);
    localStorage.setItem('emp-expanded', JSON.stringify([...this.state.expanded]));
    this.renderTable();
  },

  /** 按部门分组；未分配部门单独一组 */
  grouped() {
    const groups = {};
    this.filtered().forEach(e => {
      const key = e.department_id || '_none';
      (groups[key] = groups[key] || []).push(e);
    });
    return Object.entries(groups).map(([key, emps]) => ({
      key,
      name: key === '_none' ? '未分配部门' : TrainingModule.deptName(emps[0].department_id),
      emps,
    })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  },

  isGroupOpen(key) {
    const kw = (this.state.filters.keyword || '').toLowerCase();
    return kw ? true : this.state.expanded.has(key);   // 搜索时自动展开匹配组
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
          <span style="margin-left:10px;display:inline-flex;background:#e9edf3;border-radius:999px;padding:3px;vertical-align:middle">
            <button type="button" class="cat-tab${this.state.view === 'table' ? ' active' : ''}"
              style="padding:4px 14px;font-size:12px" onclick="TrainingEmployees.setView('table')">表格</button>
            <button type="button" class="cat-tab${this.state.view === 'card' ? ' active' : ''}"
              style="padding:4px 14px;font-size:12px" onclick="TrainingEmployees.setView('card')">方块</button>
          </span>
        </div>
        <div class="toolbar-right">
          <input type="search" id="emp-search" class="toolbar-search" placeholder="搜索姓名/工号/岗位/手机号"
            value="${Utils.escapeHtml(this.state.filters.keyword)}" oninput="TrainingEmployees.onSearch()">
          ${TrainingModule.canEdit() ? `
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.downloadTemplate()">导入模板</button>
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.openImport()">Excel 导入</button>
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.provisionAll()">批量开通账号</button>
            <button class="btn btn-danger btn-sm" onclick="TrainingEmployees.openBatchDelete()">批量删除</button>
            <button class="btn btn-primary btn-sm" onclick="TrainingEmployees.openForm()">+ 新增员工</button>` : ''}
        </div>
      </div>
      <div id="emp-legend"></div>
      <div id="emp-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.dept = document.getElementById('emp-filter-dept').value;
    this.state.filters.status = document.getElementById('emp-filter-status').value;
    this.state.selected.clear();      // 条件变了，避免误删看不见的人
    this.renderTable();
  },

  onSearch() {
    this.state.filters.keyword = document.getElementById('emp-search').value.trim();
    this.state.selected.clear();
    this.renderTable();
  },

  /** 全选 / 取消全选（只作用于当前筛选出来的行） */
  toggleAll(checked) {
    this.filtered().forEach(e => {
      if (checked) this.state.selected.add(e.id);
      else this.state.selected.delete(e.id);
    });
    this.renderTable();
  },

  toggleOne(id, checked) {
    if (checked) this.state.selected.add(id);
    else this.state.selected.delete(id);
    this.renderTable();
  },

  async load() {
    const { data, error } = await sb
      .from('training_employees')
      .select('id, name, gender, employee_no, department_id, position, id_number, phone, hire_date, emp_type, status, remark, user_id')
      .order('name');
    if (error) throw error;
    this.state.list = data || [];

    // 管理员标识（profiles 不可读时静默降级，不影响主流程）
    try {
      const { data: profs } = await sb.from('profiles').select('id, role');
      const map = {};
      (profs || []).forEach(p => { map[p.id] = p; });
      this.state.profileMap = map;
    } catch (_) { this.state.profileMap = {}; }

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
    const selCount = rows.filter(e => this.state.selected.has(e.id)).length;
    const groups = this.grouped();
    const isCard = this.state.view === 'card';

    // 方块视图的颜色图例
    const legend = document.getElementById('emp-legend');
    if (legend) legend.innerHTML = isCard ? `
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#64748b;margin:6px 2px">
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#ecfdf5;border:1px solid #22c55e;margin-right:4px;vertical-align:-1px"></span>已开通账号</span>
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#fff;border:1px solid #e5e7eb;margin-right:4px;vertical-align:-1px"></span>未开通账号</span>
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#eef2ff;border:1px solid #4f46e5;margin-right:4px;vertical-align:-1px"></span>管理员</span>
        <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:#f3f4f6;border:1px solid #9ca3af;margin-right:4px;vertical-align:-1px"></span>离职</span>
        <span style="margin-left:auto">默认按部门折叠，点击部门名展开</span>
      </div>` : '';

    box.innerHTML = `
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h2>员工档案（${rows.length}）</h2>
          ${canEdit && selCount
            ? `<span style="font-size:13px;color:#b91c1c">已勾选 ${selCount} 人
                 <button class="btn btn-danger btn-sm" style="margin-left:8px"
                   onclick="TrainingEmployees.openBatchDelete()">删除勾选</button></span>`
            : ''}
        </div>
        <div class="card-body" style="padding:0">
          ${isCard ? this.renderCardGroups(groups, canEdit) : this.renderTableGroups(groups, canEdit)}
        </div>
      </div>
    `;
  },

  /** 组头（两种视图共用） */
  groupHead(g, open) {
    const active = g.emps.filter(e => e.status === 'active').length;
    const opened = g.emps.filter(e => e.user_id).length;
    return `
      <span style="display:inline-block;transform:rotate(${open ? '90deg' : '0deg'});transition:transform .15s;color:#64748b">▸</span>
      <b style="font-size:13px">${Utils.escapeHtml(g.name)}</b>
      <span style="color:#64748b;font-weight:400;font-size:12px;margin-left:8px">
        ${g.emps.length} 人 · 在职 ${active}${opened ? ` · 已开通 ${opened}` : ''}
      </span>`;
  },

  renderTableGroups(groups, canEdit) {
    const kwEmpty = !(this.state.filters.keyword || '').trim();
    if (!groups.length) {
      return `<table class="data-table"><tbody>
        ${TrainingModule.emptyRow(canEdit ? 13 : 11, '暂无员工档案，可用上方「Excel 导入」批量建档')}
      </tbody></table>`;
    }
    return groups.map(g => {
      const open = kwEmpty ? this.isGroupOpen(g.key) : this.isGroupOpen(g.key);
      return `
        <table class="data-table" style="margin-bottom:2px">
          <thead>
            <tr style="cursor:pointer;background:#f4f6fa" onclick="TrainingEmployees.toggleGroup('${g.key}')">
              <th colspan="${canEdit ? 13 : 11}" style="text-align:left">${this.groupHead(g, open)}</th>
            </tr>
          </thead>
          ${open ? `<tbody>${g.emps.map(e => this.empRow(e, canEdit)).join('')}</tbody>` : ''}
        </table>`;
    }).join('');
  },

  empRow(e, canEdit) {
    return `
      <tr>
        ${canEdit ? `<td>
          <input type="checkbox" ${this.state.selected.has(e.id) ? 'checked' : ''}
            onchange="TrainingEmployees.toggleOne('${e.id}', this.checked)"
            style="width:15px;height:15px">
        </td>` : ''}
        <td>${Utils.escapeHtml(e.name)}</td>
        <td>${Utils.escapeHtml(e.gender || '—')}</td>
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
        <td>${e.user_id
            ? '<span class="badge badge-success">已开通</span>'
            : '<span class="badge badge-muted">未开通</span>'}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openHistory('${e.id}')">培训档案</button>
          ${canEdit ? `
            ${e.user_id
              ? `<button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.provision('${e.id}', true)" title="重置为身份证后6位">重置密码</button>`
              : `<button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.provision('${e.id}')">开通账号</button>`}
            <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openForm('${e.id}')">编辑</button>
            <button class="btn btn-sm btn-danger" onclick="TrainingEmployees.remove('${e.id}')">删除</button>` : ''}
        </td>
      </tr>`;
  },

  renderCardGroups(groups, canEdit) {
    if (!groups.length) {
      return '<p class="text-muted" style="text-align:center;padding:24px">暂无员工档案，可用上方「Excel 导入」批量建档</p>';
    }
    return groups.map(g => {
      const open = this.isGroupOpen(g.key);
      return `
        <div style="padding:10px 14px;border-bottom:1px solid #f1f5f9">
          <div style="cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none"
            onclick="TrainingEmployees.toggleGroup('${g.key}')">
            ${this.groupHead(g, open)}
          </div>
          ${open ? `
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
              ${g.emps.map(e => this.empCard(e, canEdit)).join('')}
            </div>` : ''}
        </div>`;
    }).join('');
  },

  empCard(e, canEdit) {
    const prof = e.user_id ? this.state.profileMap[e.user_id] : null;
    const isAdmin = prof && prof.role === 'admin';
    let bg = '#ffffff', bd = '#e5e7eb', nameColor = '#111827';
    if (e.status === 'left')      { bg = '#f3f4f6'; bd = '#9ca3af'; nameColor = '#9ca3af'; }
    else if (isAdmin)             { bg = '#eef2ff'; bd = '#4f46e5'; }
    else if (e.user_id)           { bg = '#ecfdf5'; bd = '#22c55e'; }
    return `
      <div style="width:150px;border:1.5px solid ${bd};background:${bg};border-radius:10px;padding:8px 10px;font-size:12px">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <b style="font-size:13px;color:${nameColor}">${Utils.escapeHtml(e.name)}</b>
          ${isAdmin ? '<span class="badge badge-primary" style="font-size:10px;padding:1px 5px">管理员</span>' : ''}
          ${e.status === 'left' ? '<span class="badge badge-muted" style="font-size:10px;padding:1px 5px">离职</span>' : ''}
        </div>
        <div style="color:#6b7280;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${Utils.escapeHtml(e.position || '')}">${Utils.escapeHtml(e.position || '—')}</div>
        <div style="color:#9ca3af;margin-top:2px;font-size:11px">
          ${e.user_id ? '✓ 已开通' : '未开通'}${e.phone ? ' · ' + Utils.escapeHtml(e.phone) : ''}
        </div>
        <div style="margin-top:6px;display:flex;gap:4px">
          <button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px"
            onclick="event.stopPropagation();TrainingEmployees.openHistory('${e.id}')">档案</button>
          ${canEdit ? `<button class="btn btn-sm btn-secondary" style="padding:2px 8px;font-size:11px"
            onclick="event.stopPropagation();TrainingEmployees.openForm('${e.id}')">编辑</button>` : ''}
        </div>
      </div>`;
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
                <label>性别</label>
                <select id="emp-gender" class="form-control">
                  <option value="">未填写</option>
                  <option value="男"${e && e.gender === '男' ? ' selected' : ''}>男</option>
                  <option value="女"${e && e.gender === '女' ? ' selected' : ''}>女</option>
                </select>
              </div>
              <div class="form-group">
                <label>工号</label>
                <input id="emp-no" class="form-control" value="${Utils.escapeHtml(e ? (e.employee_no || '') : '')}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>所属部门</label>
                <select id="emp-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(e ? e.department_id : '', false)}
                </select>
              </div>
              <div class="form-group">
                <label>岗位/工种</label>
                <input id="emp-position" class="form-control" value="${Utils.escapeHtml(e ? (e.position || '') : '')}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>人员类型</label>
                <select id="emp-type" class="form-control">
                  <option value="employee"${e && e.emp_type === 'employee' ? ' selected' : ''}>普通员工</option>
                  <option value="special"${e && e.emp_type === 'special' ? ' selected' : ''}>特种作业</option>
                  <option value="manager"${e && e.emp_type === 'manager' ? ' selected' : ''}>管理人员</option>
                </select>
              </div>
              <div class="form-group">
                <label>入职日期</label>
                <input id="emp-hire" type="date" class="form-control" value="${e ? (e.hire_date || '') : ''}">
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
      gender: document.getElementById('emp-gender').value || null,
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

  // ------------------------------------------------------------ 批量删除
  openBatchDelete() {
    const rows = this.filtered();
    const sel = rows.filter(e => this.state.selected.has(e.id));
    const { dept, status, keyword } = this.state.filters;
    const filterDesc = [
      dept ? `部门=${TrainingModule.deptName(dept)}` : '',
      status ? `状态=${status === 'active' ? '在职' : '离职'}` : '',
      keyword ? `关键词=${keyword}` : '',
    ].filter(Boolean).join(' ／ ');

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>批量删除员工档案</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p style="color:#b91c1c;font-weight:500">删除后无法恢复，请确认。</p>
            <p class="text-muted" style="font-size:13px;margin:8px 0">
              删除员工时会一并清掉：该员工的<b>登录账号</b>、<b>参训名单</b>、<b>学习进度</b>。<br>
              历史培训记录里的参训明细会保留姓名快照，不受影响。
            </p>
            <div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin-top:10px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-weight:500">删除勾选的员工</div>
                  <div class="text-muted" style="font-size:12px">已勾选 ${sel.length} 人</div>
                </div>
                <button class="btn btn-danger btn-sm" ${sel.length ? '' : 'disabled'}
                  onclick="TrainingEmployees.runBatchDelete('selected')">删除</button>
              </div>
            </div>
            <div style="border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin-top:10px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-weight:500">删除当前筛选结果</div>
                  <div class="text-muted" style="font-size:12px">
                    当前列表共 ${rows.length} 人${filterDesc ? `（${Utils.escapeHtml(filterDesc)}）` : '（未设置筛选，即全部员工）'}
                  </div>
                </div>
                <button class="btn btn-danger btn-sm" ${rows.length ? '' : 'disabled'}
                  onclick="TrainingEmployees.runBatchDelete('filtered')">删除</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">取消</button>
          </div>
        </div>
      </div>
    `;
  },

  async runBatchDelete(scope) {
    const rows = this.filtered();
    const ids = (scope === 'selected'
      ? rows.filter(e => this.state.selected.has(e.id))
      : rows).map(e => e.id);

    if (!ids.length) { alert('没有可删除的员工'); return; }
    if (!confirm(`确定删除这 ${ids.length} 名员工？\n\n登录账号与学习进度会一并清除，且无法恢复。`)) return;

    const { data, error } = await sb.rpc('training_employees_batch_delete', { p_ids: ids });
    if (error) {
      const msg = error.message || '';
      if (msg.includes('does not exist') || msg.includes('function')) {
        alert('批量删除功能尚未启用。\n请先在 Supabase 的 SQL 编辑器里执行 sql/training-online-v2.sql 的第 16 节。');
      } else {
        alert('删除失败：' + msg);
      }
      return;
    }

    this.closeForm();
    this.state.selected.clear();
    await this.load();

    let info = `已删除 ${data.deleted} 名员工，连带清除 ${data.accounts} 个登录账号。`;
    if (data.account_error) {
      info += `\n\n注意：有 ${data.accounts === 0 ? '部分' : ''}登录账号没能删掉（多半是被其他业务数据引用），` +
        `员工档案已删除，重新导入时若提示账号已存在，请让管理员在账号管理里手动删除。\n原始提示：${data.account_error}`;
    }
    alert(info);
    if (Utils.toast) Utils.toast(`已删除 ${data.deleted} 名员工`);
  },

  // ------------------------------------------------------------ 账号开通
  /** 开通 / 重置员工登录账号（登录名=手机号，初始密码=身份证后6位） */
  async provision(id, isReset) {
    const e = this.state.list.find(x => x.id === id);
    if (!e) return;
    if (isReset && !confirm(`确定把「${e.name}」的密码重置为身份证后 6 位？`)) return;

    const { data, error } = await sb.rpc('training_staff_reset', { p_employee_id: id });
    if (error) { alert('操作失败：' + (error.message || '')); return; }

    await this.load();
    alert(`已${isReset ? '重置' : '开通'}：\n登录名（手机号）：${e.phone}\n初始密码：身份证后 6 位`);
    if (Utils.toast) Utils.toast(isReset ? '密码已重置' : '账号已开通');
  },

  /** 批量为所有在职员工开通账号 */
  async provisionAll() {
    const todo = this.state.list.filter(e => e.status === 'active' && !e.user_id);
    if (!todo.length) { alert('在职员工都已开通账号，无需重复操作。'); return; }
    if (!confirm(`将为 ${todo.length} 名在职员工开通登录账号（登录名=手机号，初始密码=身份证后6位）。\n缺少手机号或身份证号的员工会被跳过。\n\n确定继续？`)) return;

    let ok = 0;
    const failed = [];
    for (const e of todo) {
      const { error } = await sb.rpc('training_staff_reset', { p_employee_id: e.id });
      if (error) failed.push(`${e.name}：${error.message}`);
      else ok += 1;
    }
    await this.load();

    let msg = `成功开通 ${ok} 个账号。`;
    if (failed.length) msg += `\n\n以下 ${failed.length} 个失败（多半是缺手机号或身份证号）：\n` + failed.slice(0, 10).join('\n');
    alert(msg);
  },

  // ------------------------------------------------------------ Excel 导入
  HEADERS: ['姓名*', '性别', '工号', '所属部门', '岗位/工种', '身份证号', '手机号', '入职日期', '人员类型', '状态', '备注'],

  downloadTemplate() {
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请刷新页面重试'); return; }
    const sample = [['张三', '男', 'GY001', '工程物探所', '物探工程师', '110101199001011234', '13800138000', '2024-01-15', '普通员工', '在职', '']];
    const ws = XLSX.utils.aoa_to_sheet([this.HEADERS, ...sample]);
    ws['!cols'] = [{ wch: 10 }, { wch: 6 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];

    const help = XLSX.utils.aoa_to_sheet([
      ['填写说明'],
      [''],
      ['1. 姓名必填；带 * 的为必填列'],
      ['2. 性别填「男」或「女」，留空也可以'],
      ['3. 所属部门在系统里不存在时会自动新建（按名称匹配，已存在的直接复用）；留空则归为「未指定」'],
      ['4. 身份证号与手机号用于员工登录：登录名=手机号，初始密码=身份证后6位'],
      ['5. 身份证号 / 手机号必须唯一，重复的整行会被跳过'],
      ['6. 入职日期格式 YYYY-MM-DD，例如 2024-01-15'],
      ['7. 人员类型：普通员工 / 特种作业 / 管理人员（留空按普通员工）'],
      ['8. 状态：在职 / 离职（留空按在职）'],
      ['9. 第一行是表头，请勿删除；不要修改列名'],
    ]);
    help['!cols'] = [{ wch: 60 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '员工导入');
    XLSX.utils.book_append_sheet(wb, help, '填写说明');
    XLSX.writeFile(wb, `员工档案批量导入模板_${Utils.formatDate(new Date())}.xlsx`);
  },

  openImport() {
    this.state.importRows = null;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:640px">
          <div class="modal-header">
            <h3>Excel 批量导入员工</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              先点「导入模板」下载表格，按说明填好后在这里选择文件。
              身份证号与手机号用于员工登录，请务必填写准确。<br>
              表格里的部门名如果在系统里还不存在，<b>会自动新建该部门</b>，不会中断导入。
            </p>
            <div class="form-group">
              <input type="file" id="emp-file" accept=".xlsx,.xls" class="form-control">
            </div>
            <div id="emp-import-preview"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingEmployees.parseFile()">解析文件</button>
          </div>
        </div>
      </div>
    `;
  },

  async parseFile() {
    const input = document.getElementById('emp-file');
    if (!input || !input.files.length) { alert('请先选择 Excel 文件'); return; }
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请刷新页面重试'); return; }

    const buf = await input.files[0].arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    if (rows.length < 2) { alert('表格里没有数据行'); return; }

    const deptByName = {};
    TrainingModule.state.depts.forEach(d => { deptByName[(d.name || '').trim()] = d.id; });

    const seenPhone = {};
    const seenIdNo = {};
    this.state.list.forEach(e => {
      if (e.phone) seenPhone[String(e.phone).trim()] = true;
      if (e.id_number) seenIdNo[String(e.id_number).trim()] = true;
    });

    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = String(r[0] == null ? '' : r[0]).trim();
      if (!name) continue;

      const phone = String(r[6] == null ? '' : r[6]).trim();
      const idNo = String(r[5] == null ? '' : r[5]).trim();
      const deptName = String(r[3] == null ? '' : r[3]).trim();
      const genderRaw = String(r[1] == null ? '' : r[1]).trim();
      const gender = { 男: '男', 女: '女', M: '男', F: '女' }[genderRaw.toUpperCase()] || null;
      const errors = [];

      if (phone && seenPhone[phone]) errors.push('手机号重复');
      if (idNo && seenIdNo[idNo]) errors.push('身份证号重复');
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) errors.push('手机号格式不对');
      if (idNo && idNo.length < 15) errors.push('身份证号太短');
      if (genderRaw && !gender) errors.push('性别只能填男或女');
      // 系统里没有的部门不再算错误，导入时自动新建
      const newDept = !!(deptName && !deptByName[deptName]);

      if (phone) seenPhone[phone] = true;
      if (idNo) seenIdNo[idNo] = true;

      parsed.push({
        name,
        gender,
        employee_no: String(r[2] == null ? '' : r[2]).trim() || null,
        department_id: deptByName[deptName] || null,
        dept_raw: deptName,
        new_dept: newDept,
        position: String(r[4] == null ? '' : r[4]).trim() || null,
        id_number: idNo || null,
        phone: phone || null,
        hire_date: this.toDateStr(r[7]),
        emp_type: { 特种作业: 'special', 管理人员: 'manager' }[String(r[8] == null ? '' : r[8]).trim()] || 'employee',
        status: String(r[9] == null ? '' : r[9]).trim() === '离职' ? 'left' : 'active',
        remark: String(r[10] == null ? '' : r[10]).trim() || null,
        errors,
      });
    }

    this.state.importRows = parsed;
    this.renderImportPreview();
  },

  toDateStr(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v).trim().replace(/\//g, '-');
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  },

  renderImportPreview() {
    const rows = this.state.importRows || [];
    const bad = rows.filter(r => r.errors.length);
    const good = rows.filter(r => !r.errors.length);
    const newDepts = [...new Set(good.filter(r => r.new_dept).map(r => r.dept_raw))];
    const box = document.getElementById('emp-import-preview');
    if (!box) return;

    box.innerHTML = `
      <p style="margin:8px 0">
        共解析 ${rows.length} 行：
        <b style="color:#22c55e">可导入 ${good.length}</b>
        ${bad.length ? `｜<b style="color:#ef4444">有问题的 ${bad.length}</b>` : ''}
      </p>
      ${newDepts.length ? `
      <p style="margin:0 0 8px;color:#b45309;font-size:13px">
        将自动新建 ${newDepts.length} 个部门：${Utils.escapeHtml(newDepts.join('、'))}
      </p>` : ''}
      ${rows.length ? `
      <div style="max-height:280px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">
        <table class="data-table">
          <thead><tr>
            <th style="width:90px">姓名</th><th style="width:50px">性别</th>
            <th style="width:130px">部门</th>
            <th style="width:120px">手机号</th><th>校验结果</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${Utils.escapeHtml(r.name)}</td>
                <td>${Utils.escapeHtml(r.gender || '—')}</td>
                <td>${Utils.escapeHtml(r.dept_raw || '未指定')}</td>
                <td>${Utils.escapeHtml(r.phone || '')}</td>
                <td style="color:${r.errors.length ? '#ef4444' : (r.new_dept ? '#b45309' : '#22c55e')}">
                  ${r.errors.length
                    ? Utils.escapeHtml(r.errors.join('；'))
                    : (r.new_dept ? '通过（将自动新建该部门）' : '通过')}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
      ${good.length ? `
      <div class="modal-footer" style="padding:12px 0 0;border:none">
        <button class="btn btn-primary" onclick="TrainingEmployees.saveImport()">确认导入 ${good.length} 条</button>
      </div>` : ''}
    `;
  },

  async saveImport() {
    const rows = (this.state.importRows || []).filter(r => !r.errors.length);
    if (!rows.length) return;

    // 1) 表格里出现的新部门先自动建档，拿到名称 → 部门ID 对照
    const byName = {};
    TrainingModule.state.depts.forEach(d => { byName[(d.name || '').trim()] = d.id; });
    const missing = [...new Set(rows.map(r => r.dept_raw).filter(Boolean))].filter(n => !byName[n]);

    let createdNames = [];
    if (missing.length) {
      const { data, error } = await sb.rpc('training_ensure_departments', { p_names: missing });
      if (error) {
        alert('自动新建部门失败：' + (error.message || '')
          + '\n\n若提示函数不存在，请先在 Supabase 执行 sql/training-online-v2.sql 的第 17 节。');
        return;
      }
      (data || []).forEach(x => { byName[x.dept_name] = x.department_id; });
      createdNames = (data || []).filter(x => x.created).map(x => x.dept_name);
      // 部门列表变了，刷新缓存与下拉框
      TrainingModule.state.depts = [];
      await TrainingModule.loadDepartments();
    }

    // 2) 回填部门 ID 后写入员工
    const payload = rows.map(r => ({
      name: r.name,
      gender: r.gender,
      employee_no: r.employee_no,
      department_id: r.dept_raw ? (byName[r.dept_raw] || null) : null,
      position: r.position,
      id_number: r.id_number,
      phone: r.phone,
      hire_date: r.hire_date,
      emp_type: r.emp_type,
      status: r.status,
      remark: r.remark,
      created_by: Auth.currentUser ? Auth.currentUser.id : null,
    }));

    const { error } = await sb.from('training_employees').insert(payload);
    if (error) { alert('导入失败：' + error.message); return; }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(`已导入 ${payload.length} 名员工`);

    let msg = `已导入 ${payload.length} 名员工。`;
    if (createdNames.length) msg += `\n\n自动新建了 ${createdNames.length} 个部门：${createdNames.join('、')}`;
    msg += '\n\n记得点「批量开通账号」，员工才能登录参加在线培训。';
    alert(msg);
  },
};

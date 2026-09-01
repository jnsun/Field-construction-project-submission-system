// =============================================================
// js/modules/people/people.js —— 人员与组织中心
//
// 设计文档：docs/personnel-architecture-v1-design.md
// 定位：全系统唯一的「管人」入口（组织架构 + 员工台账 + 账号管理）
//   · 组织架构：部门树（公司级可增改删，复用 create/update/delete_department RPC）
//   · 员工台账：档案 CRUD（直写 training_employees，RLS 按三级树管控）
//               + 账号开通/管理（复用 people_create_account / update_dept_user RPC）
//               + 纯管理账号区块（employee_id 为空的公司级账号）
//               + 360 视图（档案/账号/持证/培训汇总/变更留痕，全部实时查询）
// 权限：仅管理员可见；权限矩阵见设计文档第六节
// =============================================================
const PeopleModule = {

  state: {
    view: 'staff',           // staff | org
    profile: null,
    depts: [], deptMap: {},
    employees: [], accounts: [],
    loadedStaff: false,
    filters: { status: 'active', account: 'all', special: false, dept: '', kw: '' },
    editingEmpId: null,
    // 账号弹窗上下文：mode 'create'（为档案开通）| 'edit'（管理已绑账号）| 'pure'（纯管理账号）
    acctCtx: null,
  },

  TABS: [
    { key: 'staff', label: '员工台账' },
    { key: 'org',   label: '组织架构' },
  ],

  // ---------------------------------------------------------------- 入口
  async render(app) {
    this.state.profile = Auth.currentProfile || {};
    if (!Auth.isAdmin()) {
      app.innerHTML = `
        <div class="dashboard">
          ${this.buildHeader()}
          <div class="dashboard-content">
            <div class="card"><div class="card-body">
              <p class="text-muted">该模块仅对管理员开放。员工自助入口（我的档案）将在后续版本提供。</p>
            </div></div>
          </div>
        </div>`;
      return;
    }

    app.innerHTML = `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildTabs()}
          <div id="people-section">
            <div class="card"><div class="card-body">加载中...</div></div>
          </div>
        </div>
      </div>`;
    await this.renderView();
  },

  buildHeader() {
    const p = this.state.profile || {};
    const name = p.full_name || p.email || '管理员';
    return `
      <div class="dashboard-header">
        <div class="dashboard-header-inner">
          <div class="header-left">
            <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          </div>
          <div class="header-center">
            <h1 class="page-title">人员与组织</h1>
          </div>
          <div class="header-right">
            <span class="badge badge-muted">${Utils.escapeHtml(Auth.getDepartmentName ? (Auth.getDepartmentName() || '') : '')}</span>
            ${this.levelBadge()}
            <div class="user-info"><span class="user-name">${Utils.escapeHtml(name)}</span></div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>`;
  },

  levelBadge() {
    if (Auth.isSuperAdmin && Auth.isSuperAdmin()) return '<span class="badge badge-danger">超级管理员</span>';
    if (this.isCompanyAdmin()) return '<span class="badge badge-danger">公司级</span>';
    const lv = (this.state.profile || {}).admin_level;
    if (lv === 'project') return '<span class="badge badge-warning">项目级</span>';
    return '<span class="badge badge-success">部门级</span>';
  },

  buildTabs() {
    return `
      <div class="cat-tabs" id="people-tabs">
        ${this.TABS.map(t => `
          <button type="button" class="cat-tab${this.state.view === t.key ? ' active' : ''}"
            data-view="${t.key}" onclick="PeopleModule.switchView('${t.key}')">${t.label}</button>
        `).join('')}
      </div>`;
  },

  async switchView(view) {
    this.state.view = view;
    const tabs = document.getElementById('people-tabs');
    if (tabs) tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    await this.renderView();
  },

  async renderView() {
    const box = document.getElementById('people-section');
    if (!box) return;
    try {
      if (this.state.view === 'org') await this.renderOrg(box);
      else await this.renderStaff(box);
    } catch (e) {
      box.innerHTML = `<div class="card"><div class="card-body">
        <p style="color:#b91c1c">加载失败：${Utils.escapeHtml(e.message || e)}</p>
        <p class="text-muted" style="margin-top:8px">若提示函数/列不存在，请先在 Supabase 执行 sql/personnel-center-v1.sql</p>
      </div></div>`;
    }
  },

  // ================================================================
  // 页签一：员工台账
  // ================================================================
  async renderStaff(box) {
    box.innerHTML = `<div class="card"><div class="card-body"><div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:12px;">加载中...</p></div></div></div>`;

    const [empRes, acctRes, deptRes] = await Promise.all([
      sb.from('training_employees').select('*').order('created_at', { ascending: false }),
      sb.from('profiles').select('*, departments(name)').order('created_at', { ascending: false }),
      sb.from('departments').select('*').order('sort_order'),
    ]);
    if (empRes.error) throw new Error(empRes.error.message);
    if (deptRes.error) throw new Error(deptRes.error.message);
    // profiles 读取失败不阻塞台账（仅账号状态降级）
    if (acctRes.error) console.warn('账号列表加载失败：', acctRes.error.message);

    this.state.employees = empRes.data || [];
    this.state.accounts = acctRes.data || [];
    this.state.depts = deptRes.data || [];
    this.state.deptMap = {};
    this.state.depts.forEach(d => { this.state.deptMap[d.id] = d; });
    this.state.loadedStaff = true;
    this.renderStaffTable();
  },

  accountOf(empId) {
    return (this.state.accounts || []).find(a => a.employee_id === empId) || null;
  },

  filteredEmployees() {
    const f = this.state.filters;
    let list = this.state.employees;
    if (f.status !== 'all') list = list.filter(e => e.status === f.status);
    if (f.account === 'yes') list = list.filter(e => this.accountOf(e.id));
    if (f.account === 'no')  list = list.filter(e => !this.accountOf(e.id));
    if (f.special) list = list.filter(e => e.emp_type === 'special');
    if (f.dept) {
      // 含下级子树
      const vis = this.subtreeIds(f.dept);
      list = list.filter(e => e.department_id && vis.has(e.department_id));
    }
    const kw = (f.kw || '').trim().toLowerCase();
    if (kw) {
      list = list.filter(e => [e.name, e.employee_no, e.phone, e.position, e.job_grade]
        .some(x => (x || '').toLowerCase().includes(kw)));
    }
    return list;
  },

  subtreeIds(rootId) {
    const children = {};
    this.state.depts.forEach(d => { if (d.parent_id) (children[d.parent_id] = children[d.parent_id] || []).push(d.id); });
    const out = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      (children[id] || []).forEach(c => { out.add(c); stack.push(c); });
    }
    return out;
  },

  renderStaffTable() {
    const box = document.getElementById('people-section');
    if (!box) return;
    const f = this.state.filters;
    const list = this.filteredEmployees();
    const empAcctCount = this.state.employees.filter(e => this.accountOf(e.id)).length;
    const specialCount = this.state.employees.filter(e => e.emp_type === 'special').length;
    const isCompany = this.isCompanyAdmin();
    const pureAdmins = isCompany
      ? (this.state.accounts || []).filter(a => !a.employee_id) : [];

    const pill = (active, label, onclick) =>
      `<button class="stats-pill${active ? ' active' : ''}" onclick="${onclick}">${label}</button>`;

    box.innerHTML = `
      <div class="stats-toolbar">
        <div class="stats-pills">
          ${pill(f.status === 'active', '在职', "PeopleModule.setFilter('status','active')")}
          ${pill(f.status === 'left', '离职', "PeopleModule.setFilter('status','left')")}
          ${pill(f.status === 'all', '全部', "PeopleModule.setFilter('status','all')")}
          <span class="stats-crumb-sep" style="margin:0 4px">|</span>
          ${pill(f.account === 'yes', '已开通账号', "PeopleModule.setFilter('account','yes')")}
          ${pill(f.account === 'no', '未开通', "PeopleModule.setFilter('account','no')")}
          ${pill(f.account === 'all', '不限', "PeopleModule.setFilter('account','all')")}
          <span class="stats-crumb-sep" style="margin:0 4px">|</span>
          ${pill(f.special, `特种作业（${specialCount}）`, "PeopleModule.setFilter('special')")}
        </div>
        <div class="stats-crumbs">
          <select class="toolbar-search" style="width:auto;padding:4px 8px"
            onchange="PeopleModule.setFilter('dept', this.value)">
            <option value="">全部部门</option>
            ${this.state.depts.map(d => `<option value="${d.id}"${f.dept === d.id ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`).join('')}
          </select>
          <input type="text" class="toolbar-search" placeholder="搜索姓名 / 工号 / 手机号"
            value="${Utils.escapeHtml(f.kw)}" oninput="PeopleModule.setFilter('kw', this.value, true)">
          <button class="btn btn-primary" onclick="PeopleModule.openEmpModal()">+ 新增员工</button>
          <button class="btn btn-secondary" onclick="PeopleModule.renderStaff(document.getElementById('people-section'))">刷新</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h2>员工台账</h2></div>
        <div class="card-body">
          <div class="toolbar-hint" style="margin-bottom:8px">
            共 ${this.state.employees.length} 名员工（在职 ${this.state.employees.filter(e => e.status === 'active').length} · 已开通账号 ${empAcctCount}），
            当前筛选命中 ${list.length} 条
          </div>
          <div class="table-wrapper">
            <table class="data-table">
              <thead><tr>
                <th>姓名</th><th>工号</th><th>部门</th><th>岗位/工种</th><th>岗级</th>
                <th>手机号</th><th>状态</th><th>账号</th><th>操作</th>
              </tr></thead>
              <tbody>
                ${list.length === 0 ? `
                  <tr><td colspan="9" class="text-muted" style="text-align:center;padding:24px">没有符合条件的员工</td></tr>
                ` : list.map(e => this.renderEmpRow(e)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      ${isCompany ? this.renderPureAdmins(pureAdmins) : ''}
    `;
  },

  renderEmpRow(e) {
    const acct = this.accountOf(e.id);
    const acctBadge = acct
      ? (acct.role === 'admin'
          ? `<span class="badge badge-danger" title="${Utils.escapeHtml(acct.email || '')}">管理员账号</span>`
          : `<span class="badge badge-success" title="${Utils.escapeHtml(acct.email || '')}">已开通</span>`)
      : '<span class="badge badge-muted">未开通</span>';
    const canManageAcct = this.isCompanyAdmin() || (acct ? acct.role !== 'admin' : e.department_id ? this.isMySubtree(e.department_id) : false);
    return `<tr>
      <td>${Utils.escapeHtml(e.name || '')}${e.emp_type === 'special' ? ' <span class="badge badge-warning" title="特种作业人员">特</span>' : ''}</td>
      <td>${Utils.escapeHtml(e.employee_no || '—')}</td>
      <td title="${Utils.escapeHtml(this.deptName(e.department_id))}">${Utils.escapeHtml(this.deptName(e.department_id))}</td>
      <td>${Utils.escapeHtml(e.position || '—')}</td>
      <td>${Utils.escapeHtml(e.job_grade || '—')}</td>
      <td>${Utils.escapeHtml(e.phone || '—')}</td>
      <td>${e.status === 'active' ? '<span class="badge badge-success">在职</span>' : '<span class="badge badge-muted">离职</span>'}</td>
      <td>${acctBadge}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="PeopleModule.openEmpModal('${e.id}')">编辑</button>
        ${canManageAcct ? (acct
          ? `<button class="btn btn-secondary btn-sm" onclick="PeopleModule.openAcctModal('edit','${acct.id}')">登录</button>`
          : `<button class="btn btn-secondary btn-sm" onclick="PeopleModule.openAcctModal('create','${e.id}')">开通登录</button>`) : ''}
        <button class="btn btn-secondary btn-sm" onclick="PeopleModule.open360('${e.id}')">360</button>
        ${this.isCompanyAdmin() ? `<button class="btn btn-danger btn-sm" onclick="PeopleModule.deleteEmp('${e.id}')">删除</button>` : ''}
      </td>
    </tr>`;
  },

  isMySubtree(deptId) {
    return this.subtreeIds((this.state.profile || {}).department_id).has(deptId);
  },

  /** 纯管理账号区块（无 employee_id 的 profiles，公司级可见可管） */
  renderPureAdmins(list) {
    return `
      <div class="card" style="margin-top:12px">
        <div class="card-header">
          <h2>纯管理账号</h2>
          <button class="btn btn-primary" onclick="PeopleModule.openAcctModal('pure')">+ 新增纯管理账号</button>
        </div>
        <div class="card-body">
          <p class="toolbar-hint" style="margin-bottom:8px">
            不对应任何员工档案的管理账号（超管、领导查数账号等）。员工登录账号请在上方员工台账里按人开通。
          </p>
          <div class="table-wrapper">
            <table class="data-table">
              <thead><tr><th>账号名称</th><th>登录邮箱</th><th>手机号</th><th>角色</th><th>部门</th><th>操作</th></tr></thead>
              <tbody>
                ${list.length === 0 ? '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:16px">暂无纯管理账号</td></tr>'
                  : list.map(a => `<tr>
                    <td>${Utils.escapeHtml(a.full_name || '—')}</td>
                    <td>${Utils.escapeHtml(a.email || '—')}</td>
                    <td>${Utils.escapeHtml(a.phone || '—')}</td>
                    <td>${a.role === 'admin' ? `<span class="badge badge-danger">管理员${a.is_super_admin ? '·超管' : ''}</span>` : '<span class="badge badge-muted">非管理</span>'}</td>
                    <td>${Utils.escapeHtml((a.departments && a.departments.name) || this.deptName(a.department_id) || '—')}</td>
                    <td>
                      <button class="btn btn-secondary btn-sm" onclick="PeopleModule.openAcctModal('edit','${a.id}')">编辑</button>
                      ${a.id !== ((Auth.currentUser || {}).id) ? `<button class="btn btn-danger btn-sm" onclick="PeopleModule.deleteAcct('${a.id}')">删除</button>` : ''}
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

  setFilter(key, value, debounce) {
    if (key === 'special') this.state.filters.special = !this.state.filters.special;
    else this.state.filters[key] = value;
    if (debounce) {
      clearTimeout(this._kwTimer);
      this._kwTimer = setTimeout(() => this.renderStaffTable(), 250);
    } else {
      this.renderStaffTable();
    }
  },

  // ---------------------------------------------------------------- 档案弹窗
  openEmpModal(empId = null) {
    const emp = empId ? this.state.employees.find(e => e.id === empId) : null;
    if (empId && !emp) { Utils.toast('未找到该员工', 'error'); return; }
    this.state.editingEmpId = empId;
    const v = emp || {};
    const deptOptions = this.visibleDepts()
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
      .map(d => `<option value="${d.id}"${v.department_id === d.id ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`).join('');

    this.openModal(`
      <h2>${empId ? '编辑员工档案' : '新增员工'}</h2>
      <div id="people-modal-error"></div>
      <div class="form-group"><label>姓名 *</label>
        <input name="name" value="${Utils.escapeHtml(v.name || '')}" placeholder="员工姓名"></div>
      <div class="form-row-2">
        <div class="form-group"><label>工号</label>
          <input name="employee_no" value="${Utils.escapeHtml(v.employee_no || '')}"></div>
        <div class="form-group"><label>岗级 / 职务</label>
          <input name="job_grade" value="${Utils.escapeHtml(v.job_grade || '')}" placeholder="如：班长 / 技师"></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label>部门 *</label>
          <select name="department_id">${deptOptions}</select></div>
        <div class="form-group"><label>岗位 / 工种</label>
          <input name="position" value="${Utils.escapeHtml(v.position || '')}" placeholder="如：电工"></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label>身份证号</label>
          <input name="id_number" value="${Utils.escapeHtml(v.id_number || '')}"></div>
        <div class="form-group"><label>手机号（也是登录标识）</label>
          <input name="phone" value="${Utils.escapeHtml(v.phone || '')}"></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label>入职 / 入场日期</label>
          <input type="date" name="hire_date" value="${Utils.escapeHtml(v.hire_date || '')}"></div>
        <div class="form-group"><label>人员类别</label>
          <select name="emp_type">
            <option value="employee"${v.emp_type === 'employee' ? ' selected' : ''}>普通员工</option>
            <option value="special"${v.emp_type === 'special' ? ' selected' : ''}>特种作业</option>
            <option value="manager"${v.emp_type === 'manager' ? ' selected' : ''}>管理人员</option>
          </select></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label>在职状态</label>
          <select name="status">
            <option value="active"${v.status !== 'left' ? ' selected' : ''}>在职</option>
            <option value="left"${v.status === 'left' ? ' selected' : ''}>离职</option>
          </select></div>
        <div class="form-group"><label>备注</label>
          <input name="remark" value="${Utils.escapeHtml(v.remark || '')}"></div>
      </div>
      ${empId && v.phone ? `<p class="hint">修改手机号会自动联动其登录账号的手机号（登录标识同步变更）。</p>` : ''}
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="PeopleModule.closeModal()">取消</button>
        <button class="btn btn-primary" onclick="PeopleModule.submitEmp()">${empId ? '保存修改' : '创建档案'}</button>
      </div>
    `);
  },

  async submitEmp() {
    const overlay = document.getElementById('people-modal');
    const get = (n) => { const el = overlay.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ''; };
    const payload = {
      name: get('name'), employee_no: get('employee_no') || null,
      department_id: get('department_id') || null, position: get('position') || null,
      job_grade: get('job_grade') || null, id_number: get('id_number') || null,
      phone: get('phone') || null, hire_date: get('hire_date') || null,
      emp_type: get('emp_type'), status: get('status'), remark: get('remark') || null,
    };
    if (!payload.name) { Utils.toast('请填写姓名', 'error'); return; }
    if (!payload.department_id) { Utils.toast('请选择部门', 'error'); return; }

    const btn = overlay.querySelector('.modal-footer .btn-primary');
    const isEdit = !!this.state.editingEmpId;
    btn.disabled = true; btn.textContent = isEdit ? '保存中...' : '创建中...';
    try {
      const { error } = isEdit
        ? await sb.from('training_employees').update(payload).eq('id', this.state.editingEmpId)
        : await sb.from('training_employees').insert({ ...payload, created_by: (Auth.currentUser || {}).id });
      if (error) throw error;
      Utils.toast(isEdit ? '档案已更新' : '员工档案已创建', 'success');
      this.closeModal();
      await this.renderStaff(document.getElementById('people-section'));
    } catch (e) {
      this.showModalError(Auth.mapDbError ? Auth.mapDbError(e) : (e.message || '操作失败'));
      btn.disabled = false; btn.textContent = isEdit ? '保存修改' : '创建档案';
    }
  },

  async deleteEmp(empId) {
    const emp = this.state.employees.find(e => e.id === empId);
    if (!emp) return;
    const acct = this.accountOf(empId);
    if (!confirm(`确定删除员工「${emp.name}」吗？\n\n其培训记录关联、变更留痕将一并删除${acct ? '，登录账号将解除关联但不会被删除' : ''}。`)) return;
    const { error } = await sb.rpc('training_employees_batch_delete', { p_ids: [empId] });
    if (error) { Utils.toast('删除失败：' + (Auth.mapDbError ? Auth.mapDbError(error) : error.message), 'error'); return; }
    Utils.toast('员工已删除', 'success');
    await this.renderStaff(document.getElementById('people-section'));
  },

  // ---------------------------------------------------------------- 账号弹窗
  /**
   * mode:
   *  create —— 为员工档案开通登录（p1 = employee_id）
   *  edit   —— 管理一个已有账号（p1 = user_id；纯管理账号和员工账号共用）
   *  pure   —— 新增纯管理账号
   */
  openAcctModal(mode, p1 = null) {
    const isCompany = this.isCompanyAdmin();
    let emp = null, acct = null;
    if (mode === 'create') {
      emp = this.state.employees.find(e => e.id === p1);
      if (!emp) { Utils.toast('未找到该员工', 'error'); return; }
      if (this.accountOf(emp.id)) { Utils.toast('该员工已绑定登录账号', 'error'); return; }
    } else if (mode === 'edit') {
      acct = (this.state.accounts || []).find(a => a.id === p1);
      if (!acct) { Utils.toast('未找到该账号', 'error'); return; }
      emp = acct.employee_id ? this.state.employees.find(e => e.id === acct.employee_id) : null;
    }

    this.state.acctCtx = { mode, employeeId: emp ? emp.id : null, userId: acct ? acct.id : null };
    const v = acct || {};
    const roleSel = (role) => `<option value="employee"${(v.role || 'employee') === role ? ' selected' : ''}>员工账号（可参训）</option>
      <option value="admin"${v.role === 'admin' ? ' selected' : ''}>管理员账号</option>`;

    const body = mode === 'create' ? `
      <p class="hint" style="margin-bottom:8px">
        为 <b>${Utils.escapeHtml(emp.name)}</b>（${Utils.escapeHtml(this.deptName(emp.department_id))}）开通登录账号。
        姓名 / 部门 / 手机号将自动取自档案，无需重复填写。
      </p>
      <div class="form-group"><label>初始密码 *（至少 6 位）</label>
        <input name="password" type="text" placeholder="请告知员工后自行修改"></div>
      <div class="form-group"><label>登录邮箱（选填）</label>
        <input name="email" placeholder="留空则用手机号作为登录名"></div>
      <div class="form-group"><label>手机号（缺省用档案手机号）</label>
        <input name="phone" value="${Utils.escapeHtml(emp.phone || '')}"></div>
      ${isCompany ? `<div class="form-group"><label>角色</label><select name="role">${roleSel()}</select></div>
      <div class="form-group" id="acct-level-group" style="display:none"><label>管理员级别</label>
        <select name="admin_level">
          <option value="company">公司级</option>
          <option value="dept">部门级（须指定部门）</option>
          <option value="project">项目级（须指定项目部）</option>
        </select></div>` : `<input type="hidden" name="role" value="employee">`}
      <div class="form-group"><label class="checkbox-label">
        <input type="checkbox" name="can_report" checked> 允许报送野外施工项目
      </label></div>
    ` : `
      <p class="hint" style="margin-bottom:8px">
        ${emp ? `员工 <b>${Utils.escapeHtml(emp.name)}</b> 的登录账号` : '纯管理账号（未绑定员工档案）'}
      </p>
      <div class="form-group"><label>账号名称</label>
        <input name="full_name" value="${Utils.escapeHtml(v.full_name || '')}"></div>
      <div class="form-group"><label>登录邮箱</label>
        <input name="email" value="${Utils.escapeHtml(v.email || '')}" ${emp && (v.email || '').endsWith('@login.local') ? 'placeholder="占位邮箱，可换成真实邮箱"' : ''}></div>
      <div class="form-group"><label>手机号</label>
        <input name="phone" value="${Utils.escapeHtml(v.phone || '')}"></div>
      <div class="form-group"><label>重置密码（留空 = 不修改）</label>
        <input name="password" type="text" placeholder="至少 6 位"></div>
      ${isCompany ? `<div class="form-group"><label>角色</label><select name="role">${roleSel()}</select></div>
      <div class="form-group" id="acct-level-group" style="display:none"><label>管理员级别</label>
        <select name="admin_level">
          <option value="company"${v.admin_level === 'company' ? ' selected' : ''}>公司级</option>
          <option value="dept"${v.admin_level === 'dept' ? ' selected' : ''}>部门级</option>
          <option value="project"${v.admin_level === 'project' ? ' selected' : ''}>项目级</option>
        </select></div>
      <div class="form-group"><label>所属部门</label>
        <select name="department_id">
          <option value="">（无）</option>
          ${this.state.depts.map(d => `<option value="${d.id}"${v.department_id === d.id ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="checkbox-label">
        <input type="checkbox" name="can_report" ${v.can_report ? 'checked' : ''}> 允许报送野外施工项目
      </label></div>` : `<input type="hidden" name="role" value="${v.role || 'employee'}">`}
      ${emp && isCompany ? `<p class="hint">解除关联后账号保留但回到「纯管理账号」区，员工将无法用账号参训。</p>` : ''}
    `;

    const footer = `
      <div class="modal-footer">
        ${mode === 'edit' && emp && isCompany ? `<button class="btn btn-danger" style="float:left" onclick="PeopleModule.unlinkAcct('${acct.id}')">解除关联</button>` : ''}
        <button class="btn btn-secondary" onclick="PeopleModule.closeModal()">取消</button>
        <button class="btn btn-primary" onclick="PeopleModule.submitAcct()">${mode === 'create' ? '开通账号' : '保存修改'}</button>
      </div>`;

    this.openModal(`<h2>${mode === 'create' ? '开通登录账号' : (mode === 'pure' ? '新增纯管理账号' : '管理登录账号')}</h2>
      <div id="people-modal-error"></div>${body}${footer}`);

    const roleEl = document.querySelector('#people-modal [name="role"]');
    if (roleEl) roleEl.addEventListener('change', () => this.toggleLevelGroup());
    this.toggleLevelGroup();
  },

  toggleLevelGroup() {
    const roleEl = document.querySelector('#people-modal [name="role"]');
    const grp = document.getElementById('acct-level-group');
    if (roleEl && grp) grp.style.display = roleEl.value === 'admin' ? '' : 'none';
  },

  async submitAcct() {
    const ctx = this.state.acctCtx;
    if (!ctx) return;
    const overlay = document.getElementById('people-modal');
    const get = (n) => { const el = overlay.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ''; };
    const btn = overlay.querySelector('.modal-footer .btn-primary');
    const isCompany = this.isCompanyAdmin();

    try {
      let result, targetUserId = ctx.userId;

      if (ctx.mode === 'create') {
        const password = get('password');
        if (password.length < 6) { Utils.toast('密码长度至少 6 位', 'error'); return; }
        btn.disabled = true; btn.textContent = '开通中...';
        result = await sb.rpc('people_create_account', {
          p_employee_id: ctx.employeeId,
          p_email: get('email') || null,
          p_password: password,
          p_role: get('role') || 'employee',
          p_phone: get('phone') || null,
          p_admin_level: isCompany ? (get('admin_level') || null) : null,
        });
        if (result.error) throw result.error;
        targetUserId = result.data && result.data.user_id;
      } else {
        btn.disabled = true; btn.textContent = '保存中...';
        const params = {
          p_user_id: ctx.userId,
          p_email: get('email') || null,
          p_full_name: get('full_name') || null,
          p_role: get('role') || 'employee',
          p_password: get('password') || null,
          p_phone: get('phone') || null,
          p_admin_level: isCompany ? (get('admin_level') || null) : null,
          p_department_id: isCompany ? (get('department_id') || null) : undefined,
        };
        result = await sb.rpc('update_dept_user', params);
        if (result.error) throw result.error;
      }

      // 报送权（独立 RPC，失败不阻塞）
      if (targetUserId && isCompany) {
        const wantReport = !!overlay.querySelector('[name="can_report"]:checked');
        const rr = await sb.rpc('set_user_can_report', { p_user_id: targetUserId, p_can_report: wantReport });
        if (rr.error) console.warn('报送权设置失败：', rr.error.message);
      }

      Utils.toast(ctx.mode === 'create' ? '账号已开通并绑定员工档案' : '账号已更新', 'success');
      this.closeModal();
      await this.renderStaff(document.getElementById('people-section'));
    } catch (e) {
      this.showModalError(Auth.mapDbError ? Auth.mapDbError(e) : (e.message || '操作失败'));
      if (btn) { btn.disabled = false; btn.textContent = ctx.mode === 'create' ? '开通账号' : '保存修改'; }
    }
  },

  async unlinkAcct(userId) {
    if (!confirm('确定解除该账号与员工档案的关联吗？\n\n账号本身保留（变为纯管理账号），员工的培训记录不受影响。')) return;
    const { error } = await sb.rpc('people_unlink_account', { p_user_id: userId });
    if (error) { Utils.toast('解除失败：' + (Auth.mapDbError ? Auth.mapDbError(error) : error.message), 'error'); return; }
    Utils.toast('已解除关联', 'success');
    this.closeModal();
    await this.renderStaff(document.getElementById('people-section'));
  },

  async deleteAcct(userId) {
    if (!confirm('确定删除该账号吗？删除后无法登录。')) return;
    const { error } = await sb.rpc('delete_dept_user', { p_user_id: userId });
    if (error) { Utils.toast('删除失败：' + (Auth.mapDbError ? Auth.mapDbError(error) : error.message), 'error'); return; }
    Utils.toast('账号已删除', 'success');
    await this.renderStaff(document.getElementById('people-section'));
  },

  // ---------------------------------------------------------------- 360 视图
  async open360(empId) {
    const emp = this.state.employees.find(e => e.id === empId);
    if (!emp) return;
    this.openModal(`<h2>员工 360 视图 · ${Utils.escapeHtml(emp.name)}</h2>
      <div id="people-360-body"><div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:12px;">加载中...</p></div></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="PeopleModule.closeModal()">关闭</button></div>`);

    const acct = this.accountOf(empId);
    const tasks = [
      acct && emp.id_number
        ? sb.from('certificates').select('id, cert_name, cert_no, valid_until, is_long_term')
            .eq('cert_category', 'personal').eq('holder_id_no', emp.id_number)
        : Promise.resolve({ data: [] }),
      sb.from('training_assignments').select('status, exam_status').eq('employee_id', empId),
      sb.from('personnel_change_logs').select('field, old_value, new_value, created_at')
        .eq('employee_id', empId).order('created_at', { ascending: false }).limit(10),
    ];
    const [certRes, asgRes, logRes] = await Promise.all(tasks);
    const certs = certRes.data || [];
    const asgs = asgRes.data || [];
    const logs = (logRes.data || []);

    const rows = (pairs) => pairs.map(([k, v]) =>
      `<tr><td style="padding:3px 16px 3px 0;color:#6b7280;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join('');
    const typeLabel = { employee: '普通员工', special: '特种作业', manager: '管理人员' }[emp.emp_type] || emp.emp_type;

    const certRows = certs.length
      ? certs.map(c => {
          const exp = c.is_long_term ? '长期' : (c.valid_until || '—');
          const days = c.is_long_term ? null : Math.ceil((new Date(c.valid_until) - new Date()) / 86400000);
          const color = days !== null && days <= 90 ? '#b91c1c' : 'inherit';
          return `<tr><td>${Utils.escapeHtml(c.cert_name || '')}</td>
            <td>${Utils.escapeHtml(c.cert_no || '—')}</td>
            <td style="color:${color}">${exp}${days !== null && days <= 90 ? `（剩 ${days} 天）` : ''}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3" class="text-muted" style="text-align:center">暂无个人持证（证照模块按身份证号匹配）</td></tr>';

    const doneCount = asgs.filter(a => a.status === 'completed').length;
    const passCount = asgs.filter(a => a.exam_status === 'passed').length;

    document.getElementById('people-360-body').innerHTML = `
      <div style="max-height:52vh;overflow:auto;padding-right:4px">
      <h3 style="font-size:14px;margin:4px 0 6px">基本信息</h3>
      <table style="font-size:13px;width:100%">
        ${rows([
          ['姓名', Utils.escapeHtml(emp.name || '')],
          ['部门', Utils.escapeHtml(this.deptName(emp.department_id))],
          ['岗位 / 工种', Utils.escapeHtml([emp.position, emp.job_grade].filter(Boolean).join(' / ') || '—')],
          ['人员类别', typeLabel],
          ['身份证号', Utils.escapeHtml(emp.id_number || '—')],
          ['手机号', Utils.escapeHtml(emp.phone || '—')],
          ['入职日期', Utils.escapeHtml(emp.hire_date || '—')],
          ['状态', emp.status === 'active' ? '在职' : '离职'],
        ])}
      </table>
      <h3 style="font-size:14px;margin:12px 0 6px">登录账号</h3>
      <table style="font-size:13px;width:100%">
        ${acct
          ? rows([
              ['状态', '<span class="badge badge-success">已开通</span>'],
              ['账号名称', Utils.escapeHtml(acct.full_name || '—')],
              ['登录标识', Utils.escapeHtml(acct.email || acct.phone || '—')],
              ['角色', acct.role === 'admin' ? '管理员' : '员工账号'],
            ])
          : '<tr><td class="text-muted">未开通登录账号</td></tr>'}
      </table>
      <h3 style="font-size:14px;margin:12px 0 6px">培训概览</h3>
      <table style="font-size:13px;width:100%">
        ${rows([
          ['培训任务', `${doneCount} / ${asgs.length} 已完成`],
          ['考试通过', `${passCount} 场`],
        ])}
      </table>
      <h3 style="font-size:14px;margin:12px 0 6px">个人持证（实时 · 90 天内到期标红）</h3>
      <table class="data-table" style="font-size:13px">
        <thead><tr><th>证照名称</th><th>证号</th><th>有效期至</th></tr></thead>
        <tbody>${certRows}</tbody>
      </table>
      <h3 style="font-size:14px;margin:12px 0 6px">变更留痕（最近 10 条）</h3>
      ${logs.length ? `<table class="data-table" style="font-size:12px">
        <thead><tr><th>时间</th><th>字段</th><th>变更</th></tr></thead>
        <tbody>${logs.map(l => `<tr>
          <td>${Utils.escapeHtml((l.created_at || '').slice(0, 16).replace('T', ' '))}</td>
          <td>${l.field === 'phone' ? '手机号' : l.field === 'photo_path' ? '照片' : Utils.escapeHtml(l.field)}</td>
          <td>${Utils.escapeHtml(l.old_value || '（空）')} → ${Utils.escapeHtml(l.new_value || '（空）')}</td>
        </tr>`).join('')}</tbody></table>`
        : '<p class="text-muted" style="font-size:12px">暂无变更记录</p>'}
      </div>`;
  },

  // ================================================================
  // 页签二：组织架构
  // ================================================================
  async renderOrg(box) {
    // 直接进入组织架构页签时，补拉员工/账号数据用于计数
    if (!this.state.loadedStaff) {
      const [empRes, acctRes] = await Promise.all([
        sb.from('training_employees').select('id, department_id, status'),
        sb.from('profiles').select('id, department_id, employee_id'),
      ]);
      if (!empRes.error) {
        this.state.employees = empRes.data || [];
        this.state.accounts = (acctRes && !acctRes.error) ? (acctRes.data || []) : [];
      }
    }
    const { data, error } = await sb.from('departments').select('*').order('sort_order');
    if (error) throw new Error(error.message);
    this.state.depts = data || [];
    this.state.deptMap = {};
    this.state.depts.forEach(d => { this.state.deptMap[d.id] = d; });

    const empCount = {}, acctCount = {};
    this.state.employees.forEach(e => {
      if (e.department_id && e.status === 'active') empCount[e.department_id] = (empCount[e.department_id] || 0) + 1;
    });
    (this.state.accounts || []).forEach(a => {
      if (a.department_id) acctCount[a.department_id] = (acctCount[a.department_id] || 0) + 1;
    });

    const isCompany = this.isCompanyAdmin();
    const isEntity = Auth.isEntityManager && Auth.isEntityManager();
    const myId = (this.state.profile || {}).department_id;
    const typeLabel = { company: '公司', entity: '经营实体', internal: '内设机构', project: '项目部' };
    const deptType = (d) => typeLabel[d.dept_type] || d.dept_type || '—';

    // 树形排序：按 sort_order + 父子缩进
    const children = {};
    this.state.depts.forEach(d => { (children[d.parent_id || '__root__'] = children[d.parent_id || '__root__'] || []).push(d); });
    const rowsHtml = [];
    const walk = (pid, depth) => {
      (children[pid || '__root__'] || []).forEach(d => {
        const canSee = isCompany || !myId || this.subtreeIds(myId).has(d.id);
        if (!canSee) return;
        const canEdit = isCompany || (isEntity && d.id === myId) || (isEntity && d.parent_id === myId && d.dept_type === 'project');
        const canAddChild = isCompany && d.dept_type !== 'internal';
        const canAddProject = isEntity && d.id === myId;
        const canDelete = isCompany && d.dept_type !== 'company';
        rowsHtml.push(`
          <tr>
            <td style="padding-left:${8 + depth * 22}px">
              ${depth > 0 ? '<span style="color:#cbd5e1;margin-right:4px">└</span>' : ''}
              <b>${Utils.escapeHtml(d.name)}</b>
              <span class="badge badge-muted" style="margin-left:6px">${deptType(d)}</span>
            </td>
            <td>${empCount[d.id] || 0}</td>
            <td>${acctCount[d.id] || 0}</td>
            <td>${d.needs_report ? '✅' : '—'}</td>
            <td>${d.can_view_admin ? '✅' : '—'}</td>
            <td>
              ${canAddChild ? `<button class="btn btn-secondary btn-sm" onclick="PeopleModule.openDeptModal(null,'${d.id}')">+ 子部门</button>` : ''}
              ${canAddProject ? `<button class="btn btn-secondary btn-sm" onclick="PeopleModule.openDeptModal(null,'${d.id}','project')">+ 项目部</button>` : ''}
              ${canEdit ? `<button class="btn btn-secondary btn-sm" onclick="PeopleModule.openDeptModal('${d.id}')">编辑</button>` : ''}
              ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="PeopleModule.deleteDept('${d.id}')">删除</button>` : ''}
            </td>
          </tr>`);
        walk(d.id, depth + 1);
      });
    };
    walk(null, 0);

    box.innerHTML = `
      <div class="stats-toolbar">
        <div class="stats-crumbs">
          <span class="toolbar-hint">组织架构是全系统的数据基座：培训下发、账号归属、报送权限都按这棵树划分。</span>
        </div>
        <div class="stats-pills">
          ${isCompany ? `<button class="btn btn-primary" onclick="PeopleModule.openDeptModal()">+ 新增部门</button>` : ''}
          <button class="btn btn-secondary" onclick="PeopleModule.renderOrg(document.getElementById('people-section'))">刷新</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead><tr><th>部门</th><th>在职员工</th><th>账号</th><th>报送</th><th>看后台</th><th>操作</th></tr></thead>
              <tbody>${rowsHtml.length ? rowsHtml.join('') : '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:24px">暂无可见部门</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  },

  openDeptModal(deptId = null, presetParent = null, presetType = null) {
    const dept = deptId ? this.state.depts.find(d => d.id === deptId) : null;
    if (deptId && !dept) { Utils.toast('未找到该部门', 'error'); return; }
    this.state.editingDeptId = deptId;
    const v = dept || {};
    const isEdit = !!deptId;
    const isCompany = this.isCompanyAdmin();
    const isEntity = Auth.isEntityManager && Auth.isEntityManager();
    const myId = (this.state.profile || {}).department_id;

    // 上级部门选项（公司级编辑：排除自己及子树；实体级：锁定为本部门）
    let parentOptions;
    if (isEntity && !isEdit) {
      const me = this.state.depts.find(d => d.id === myId);
      parentOptions = `<option value="${myId}" selected>${Utils.escapeHtml(me ? me.name : '本部门')}（本部门）</option>`;
    } else if (isEntity && isEdit) {
      const me = this.state.depts.find(d => d.id === (v.parent_id || myId));
      parentOptions = `<option value="${v.parent_id || myId}" selected>${Utils.escapeHtml(me ? me.name : '本部门')}（锁定）</option>`;
    } else if (isEdit && v.dept_type === 'company') {
      parentOptions = '';
    } else {
      const exclude = this.subtreeIds(deptId);
      parentOptions = this.state.depts
        .filter(d => !exclude.has(d.id))
        .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
        .map(d => `<option value="${d.id}"${(v.parent_id || presetParent) === d.id ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`)
        .join('');
    }

    const t = (val, label) => `<option value="${val}"${(v.dept_type || presetType) === val ? ' selected' : ''}>${label}</option>`;
    const typeOptions = isEntity && !isEdit
      ? t('project', '项目部')
      : (isEdit && v.dept_type === 'company' ? t('company', '公司') : t('entity', '经营实体') + t('internal', '内设机构') + t('project', '项目部'));

    this.openModal(`
      <h2>${isEdit ? '编辑部门' : (isEntity ? '新建项目部' : '新增部门')}</h2>
      <div id="people-modal-error"></div>
      <div class="form-group"><label>部门名称 *</label>
        <input name="name" value="${Utils.escapeHtml(v.name || '')}"></div>
      ${isEdit && v.dept_type === 'company' ? '' : `
      <div class="form-group"><label>上级部门</label>
        <select name="parent_id">${parentOptions}</select></div>`}
      <div class="form-group"><label>部门类型</label>
        <select name="dept_type" ${isEdit && v.dept_type === 'company' ? 'disabled' : ''}>${typeOptions}</select>
        <p class="hint">entity=经营实体 / internal=内设机构（叶子）/ project=项目部</p></div>
      <div class="form-group"><label>排序号</label>
        <input type="number" name="sort_order" value="${v.sort_order != null ? v.sort_order : (this.state.depts.length + 1)}" min="0"></div>
      ${isCompany ? `
      <div class="form-group"><label class="checkbox-label">
        <input type="checkbox" name="needs_report" value="1" ${v.needs_report ? 'checked' : ''}> 需要报送野外施工项目
      </label></div>
      <div class="form-group"><label class="checkbox-label">
        <input type="checkbox" name="can_view_admin" value="1" ${v.can_view_admin ? 'checked' : ''}> 账号可查看后台汇总
      </label></div>` : ''}
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="PeopleModule.closeModal()">取消</button>
        <button class="btn btn-primary" onclick="PeopleModule.submitDept()">${isEdit ? '保存修改' : '创建'}</button>
      </div>
    `);
  },

  async submitDept() {
    const overlay = document.getElementById('people-modal');
    const get = (n) => { const el = overlay.querySelector(`[name="${n}"]`); return el ? el.value.trim() : ''; };
    const name = get('name');
    const sortOrder = parseInt(get('sort_order'), 10);
    if (!name) { Utils.toast('请填写部门名称', 'error'); return; }
    if (isNaN(sortOrder) || sortOrder < 0) { Utils.toast('排序号必须为非负整数', 'error'); return; }
    const isEdit = !!this.state.editingDeptId;
    const parentId = get('parent_id') || null;
    const deptType = get('dept_type') || null;
    const btn = overlay.querySelector('.modal-footer .btn-primary');
    btn.disabled = true; btn.textContent = isEdit ? '保存中...' : '创建中...';

    try {
      const params = isEdit
        ? { p_department_id: this.state.editingDeptId, p_name: name, p_sort_order: sortOrder,
            p_needs_report: !!overlay.querySelector('[name="needs_report"]:checked'),
            p_can_view_admin: !!overlay.querySelector('[name="can_view_admin"]:checked'),
            p_parent_id: parentId, p_dept_type: deptType }
        : { p_name: name, p_sort_order: sortOrder,
            p_needs_report: !!overlay.querySelector('[name="needs_report"]:checked'),
            p_can_view_admin: !!overlay.querySelector('[name="can_view_admin"]:checked'),
            p_parent_id: parentId, p_dept_type: deptType };
      const result = isEdit
        ? await sb.rpc('update_department', params)
        : await sb.rpc('create_department', params);
      if (result.error) throw result.error;
      Utils.toast(isEdit ? '部门已更新' : '部门已创建', 'success');
      this.closeModal();
      await this.renderOrg(document.getElementById('people-section'));
    } catch (e) {
      this.showModalError(Auth.mapDbError ? Auth.mapDbError(e) : (e.message || '操作失败'));
      btn.disabled = false; btn.textContent = isEdit ? '保存修改' : '创建';
    }
  },

  async deleteDept(deptId) {
    const dept = this.state.depts.find(d => d.id === deptId);
    if (!dept) return;
    const empN = this.state.employees.filter(e => e.department_id === deptId).length;
    const acctN = (this.state.accounts || []).filter(a => a.department_id === deptId).length;
    if (!confirm(`确定删除部门「${dept.name}」吗？\n\n该部门下有 ${empN} 名员工、${acctN} 个账号、及其下级部门——有挂载内容时删除会被拒绝。`)) return;
    const { error } = await sb.rpc('delete_department', { p_department_id: deptId });
    if (error) { Utils.toast('删除失败：' + (Auth.mapDbError ? Auth.mapDbError(error) : error.message), 'error'); return; }
    Utils.toast('部门已删除', 'success');
    await this.renderOrg(document.getElementById('people-section'));
  },

  // ================================================================
  // 公共
  // ================================================================
  isAdmin() { return typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin(); },

  isCompanyAdmin() {
    if (!this.isAdmin()) return false;
    if (Auth.isSuperAdmin && Auth.isSuperAdmin()) return true;
    return (this.state.profile || {}).admin_level === 'company';
  },

  visibleDepts() {
    const all = this.state.depts || [];
    if (this.isCompanyAdmin()) return all;
    const myId = (this.state.profile || {}).department_id;
    if (!myId) return all;
    return all.filter(d => this.subtreeIds(myId).has(d.id));
  },

  deptName(id) {
    if (!id) return '—';
    const d = this.state.deptMap[id];
    return d ? d.name : '—';
  },

  openModal(inner) {
    this.closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'people-modal';
    overlay.onclick = (ev) => { if (ev.target === overlay) this.closeModal(); };
    overlay.innerHTML = `<div class="modal-card">${inner}</div>`;
    document.body.appendChild(overlay);
  },

  closeModal() {
    const m = document.getElementById('people-modal');
    if (m) m.remove();
  },

  showModalError(msg) {
    const box = document.getElementById('people-modal-error');
    if (box) box.innerHTML = `<div class="alert alert-danger">${Utils.escapeHtml(String(msg))}</div>`;
  },
};

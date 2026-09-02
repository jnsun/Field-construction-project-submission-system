// =============================================================
// js/modules/training/training.js —— 培训教育模块入口
//
// v1 范围（2026-08-31 与用户确认）：
//   · Web 版，并入现有系统；员工只建档案不登录；三级管理员权限
//   · 员工档案管理已移至九宫格「人员与组织」模块；本模块页签：
//     培训计划 / 培训记录 / 考试登记 / 题库 / 试卷 / 统计分析 / 统计概览
//
// 布局约定（与资质证照管理页一致）：
//   header-left 仅「← 返回上级菜单」 / header-center 标题居中 /
//   header-right 徽章 + 用户 + 账户设置 + 退出登录
// =============================================================
const TrainingModule = {

  state: {
    view: 'plans',         // projects | contractors | plans | records | exams | qbank | papers | analytics | stats
    depts: [],             // 全部部门（id/name/code/dept_type/parent_id）
    deptMap: {},           // id -> 部门对象
    profile: null,
    fieldRoles: [],        // 普通员工被任命为项目经理/安全员时的受限现场管理权限
  },

  TABS: [
    { key: 'projects',  label: '正式项目台账' },
    { key: 'contractors', label: '外协与入场' },
    { key: 'packages', label: '准入培训包' },
    { key: 'admission-operations', label: '准入执行' },
    { key: 'admission-review', label: '入场审核' },
    { key: 'admission-verify', label: '二维码核验' },
    { key: 'admission-reports', label: '准入固定报表' },
    { key: 'plans',     label: '培训计划' },
    { key: 'records',   label: '培训记录' },
    { key: 'exams',     label: '考试登记' },
    { key: 'qbank',     label: '题库管理' },
    { key: 'papers',    label: '试卷管理' },
    { key: 'analytics', label: '统计分析' },
    { key: 'stats',     label: '统计概览' },
    // 员工档案页签已移至九宫格「人员与组织」模块（js/modules/people/people.js）
  ],

  // ---------------------------------------------------------------- 入口
  async render(app) {
    this.state.profile = Auth.currentProfile || {};
    await this.loadFieldRoles();
    const staff = this.isStaff();
    const fieldManager = this.isFieldManager();

    if (fieldManager && !['admission-operations', 'admission-verify'].includes(this.state.view)) {
      this.state.view = 'admission-operations';
    }

    app.innerHTML = `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${staff && !fieldManager ? '' : this.buildTabs()}
          <div id="training-section">
            <div class="card"><div class="card-body">加载中...</div></div>
          </div>
        </div>
      </div>
    `;

    const box = document.getElementById('training-section');
    if (staff && !fieldManager) {
      // 员工端：只看「我的培训」
      await TrainingMine.render(box);
      await TrainingAdmissionMine.mount(box);
      return;
    }
    await this.loadDepartments();
    await this.renderView();
  },

  /** 员工账号（非管理员、非部门报送账号） */
  isStaff() {
    return (this.state.profile || {}).role === 'employee';
  },

  /** 普通员工账号被经营实体指定为项目经理/安全员时，仅开放现场管理页。 */
  isFieldManager() {
    return this.isStaff() && (this.state.fieldRoles || []).length > 0;
  },

  async loadFieldRoles() {
    this.state.fieldRoles = [];
    if (!this.isStaff() || !Auth.currentUser?.id) return;
    try {
      const { data, error } = await sb.from('site_project_roles')
        .select('project_id, role, active')
        .eq('user_id', Auth.currentUser.id).eq('active', true);
      if (!error) this.state.fieldRoles = data || [];
    } catch (_) { /* 未执行准入脚本时维持普通员工界面 */ }
  },

  // ---------------------------------------------------------------- 顶部
  buildHeader() {
    const p = this.state.profile || {};
    const name = p.full_name || p.email || '用户';
    const dept = Auth.getDepartmentName ? Auth.getDepartmentName() : '';
    return `
      <div class="dashboard-header">
        <div class="dashboard-header-inner">
          <div class="header-left">
            <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          </div>
          <div class="header-center">
            <h1 class="page-title">培训教育</h1>
          </div>
          <div class="header-right">
            <span class="badge badge-muted">${Utils.escapeHtml(dept || '')}</span>
            ${this.levelBadge()}
            <div class="user-info">
              <span class="user-name">${Utils.escapeHtml(name)}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>
    `;
  },

  /** 层级徽章：公司级 / 部门级 / 项目级 / 只读 */
  levelBadge() {
    if (!this.isAdmin()) return this.isFieldManager() ? '<span class="badge badge-warning">现场管理</span>' : '<span class="badge badge-muted">只读</span>';
    if (this.isCompanyAdmin()) return '<span class="badge badge-danger">公司级</span>';
    const lv = (this.state.profile || {}).admin_level;
    if (lv === 'project') return '<span class="badge badge-warning">项目级</span>';
    return '<span class="badge badge-success">部门级</span>';
  },

  buildTabs() {
    const tabs = this.isFieldManager()
      ? this.TABS.filter(t => ['admission-operations', 'admission-verify'].includes(t.key))
      : this.TABS;
    return `
      <div class="cat-tabs" id="training-tabs">
        ${tabs.map(t => `
          <button type="button" class="cat-tab${this.state.view === t.key ? ' active' : ''}"
            data-view="${t.key}" onclick="TrainingModule.switchView('${t.key}')">${t.label}</button>
        `).join('')}
      </div>
    `;
  },

  async switchView(view) {
    this.state.view = view;
    const tabs = document.getElementById('training-tabs');
    if (tabs) {
      tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    }
    await this.renderView();
  },

  async renderView() {
    const box = document.getElementById('training-section');
    if (!box) return;
    try {
      switch (this.state.view) {
        case 'projects':  await TrainingProjects.render(box);  break;
        case 'contractors': await TrainingContractors.render(box); break;
        case 'packages':  await TrainingAdmissionPackages.render(box); break;
        case 'admission-operations': await TrainingAdmissionOperations.render(box); break;
        case 'admission-review': await TrainingAdmissionReview.render(box); break;
        case 'admission-verify': await TrainingAdmissionVerify.render(box); break;
        case 'admission-reports': await TrainingAdmissionReports.render(box); break;
        case 'plans':     await TrainingPlans.render(box);     break;
        case 'records':   await TrainingRecords.render(box);   break;
        case 'exams':     await TrainingExams.render(box);     break;
        case 'qbank':     await TrainingQuestions.render(box); break;
        case 'papers':    await ExamPapers.render(box);        break;
        case 'analytics': await StatsModule.render(box, { embedded: true }); break;
        default:          await this.renderStats(box);
      }
    } catch (e) {
      const migrationHint = ['projects', 'contractors', 'packages', 'admission-operations', 'admission-review', 'admission-verify', 'admission-reports'].includes(this.state.view)
        ? '若提示项目台账相关表不存在，请依次执行 sql/training-admission-v1.sql、v2.sql、v3.sql'
        : '若提示表不存在，请先在 Supabase 执行 sql/training-management.sql';
      box.innerHTML = `<div class="card"><div class="card-body">
        <p style="color:#b91c1c">加载失败：${Utils.escapeHtml(e.message || e)}</p>
        <p class="text-muted" style="margin-top:8px">${migrationHint}</p>
      </div></div>`;
    }
  },

  // ---------------------------------------------------------------- 统计概览
  async renderStats(box) {
    const year = new Date().getFullYear();
    const [emps, plans, recs, parts, exams] = await Promise.all([
      sb.from('training_employees').select('id, status'),
      sb.from('training_plans').select('id, plan_year, status'),
      sb.from('training_records').select('id, train_date'),
      sb.from('training_participants').select('id'),
      sb.from('training_exams').select('participant_count, pass_count'),
    ]);
    const err = [emps, plans, recs, parts, exams].find(r => r.error);
    if (err) throw new Error(err.error.message);

    // 权限自检（RPC 不存在时静默跳过，不影响主流程）
    let me = null;
    try {
      const { data } = await sb.rpc('training_debug_me');
      me = Array.isArray(data) ? data[0] : (data || null);
    } catch (_) { /* 未执行 v1.3 补丁 */ }

    const empList = emps.data || [];
    const planList = plans.data || [];
    const recList = recs.data || [];
    const partList = parts.data || [];
    const examList = exams.data || [];

    const yearPlans = planList.filter(p => p.plan_year === year);
    const yearRecs = recList.filter(r => (r.train_date || '').startsWith(String(year)));
    const totalJoin = examList.reduce((s, e) => s + (e.participant_count || 0), 0);
    const totalPass = examList.reduce((s, e) => s + (e.pass_count || 0), 0);
    const passRate = totalJoin ? (totalPass / totalJoin * 100) : 0;

    const cards = [
      { label: '员工总数', value: empList.length, cls: 'total' },
      { label: '在职员工', value: empList.filter(e => e.status === 'active').length, cls: 'success' },
      { label: '本年培训计划', value: yearPlans.length, cls: 'info' },
      { label: '本年培训次数', value: yearRecs.length, cls: 'info' },
      { label: '参训人次', value: partList.length, cls: 'total' },
      { label: '考试合格率', value: `${passRate.toFixed(1)}%`,
        cls: passRate >= 80 ? 'success' : (passRate >= 60 ? 'warning' : 'danger') },
    ];

    box.innerHTML = `
      <div class="cert-stats-block">
        ${cards.map(c => `
          <div class="cert-stat-card ${c.cls}">
            <div class="cert-stat-value">${c.value}</div>
            <div class="cert-stat-label">${Utils.escapeHtml(c.label)}</div>
          </div>`).join('')}
      </div>
      ${me ? `
      <div class="card" style="margin-top:12px">
        <div class="card-header"><h2>当前账号权限自检</h2></div>
        <div class="card-body">
          <table style="font-size:13px">
            <tr><td style="padding:2px 16px 2px 0;color:#6b7280">账号</td><td>${Utils.escapeHtml(me.email || '')}</td></tr>
            <tr><td style="padding:2px 16px 2px 0;color:#6b7280">角色 / 级别</td>
                <td>${Utils.escapeHtml(me.role || '')} / <b>${Utils.escapeHtml(
                  me.is_super_admin ? '超级管理员' : (me.admin_level === 'company' ? '公司级'
                    : me.admin_level === 'dept' ? '部门级' : me.admin_level === 'project' ? '项目级'
                    : '未设置（暂按公司级）'))}</b></td></tr>
            <tr><td style="padding:2px 16px 2px 0;color:#6b7280">所属部门</td><td>${Utils.escapeHtml(me.dept_name || '未设置')}</td></tr>
            <tr><td style="padding:2px 16px 2px 0;color:#6b7280">可见部门数</td>
                <td style="color:${(me.visible_dept_count || 0) > 0 ? '#22c55e' : '#ef4444'};font-weight:600">
                  ${me.visible_dept_count || 0} 个${(me.visible_dept_count || 0) === 0
                    ? '（为 0 说明看不到任何数据，请检查该账号是否归属部门）' : ''}</td></tr>
          </table>
        </div>
      </div>` : ''}
      <div class="card" style="margin-top:12px">
        <div class="card-header"><h2>说明</h2></div>
        <div class="card-body">
          <p class="text-muted">
            统计范围为<b>您有权限查看的数据</b>（公司级看全部，部门级看本部门及下属项目部，项目级只看本项目）。
            合格率 = 合格人数合计 ÷ 参考人数合计。
          </p>
        </div>
      </div>
    `;
  },

  // ---------------------------------------------------------------- 公共方法
  isAdmin() {
    return typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
  },

  isCompanyAdmin() {
    if (!this.isAdmin()) return false;
    if (Auth.isSuperAdmin && Auth.isSuperAdmin()) return true;
    return (this.state.profile || {}).admin_level === 'company';
  },

  canEdit() {
    return this.isAdmin();
  },

  /** 供项目准入执行页使用：管理员或被任命的现场管理人员。 */
  canManageAdmission() {
    return this.isAdmin() || this.isFieldManager();
  },

  /**
   * 当前账号可管理部门（本部门 + 全部下级，递归展开）
   * 公司级管理员返回全部部门；未分配部门的账号退化为全部（由 RLS 兜底拦截）
   */
  visibleDepts() {
    const all = this.state.depts || [];
    if (this.isCompanyAdmin()) return all;
    const myId = (this.state.profile || {}).department_id;
    if (!myId) return all;
    const children = {};
    all.forEach(d => {
      if (d.parent_id) (children[d.parent_id] = children[d.parent_id] || []).push(d);
    });
    const out = [];
    const seen = new Set();
    const stack = [myId];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      const d = all.find(x => x.id === id);
      if (d) out.push(d);
      (children[id] || []).forEach(c => stack.push(c.id));
    }
    return out;
  },

  async loadDepartments() {
    if (this.state.depts.length) return;
    const { data, error } = await sb.from('departments').select('id, name, code, dept_type, parent_id');
    if (error) throw error;
    this.state.depts = data || [];
    this.state.deptMap = {};
    this.state.depts.forEach(d => { this.state.deptMap[d.id] = d; });
  },

  deptName(id) {
    if (!id) return '—';
    const d = this.state.deptMap[id];
    return d ? d.name : '—';
  },

  /** 部门下拉（可传 selected 与是否含「全部」） */
  deptOptions(selected, includeAll) {
    // 表单场景（includeAll=false）按可见范围限定：部门管理员只能选本部门及下级
    const list = (includeAll ? [...this.state.depts] : this.visibleDepts())
      .sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    return [
      includeAll ? '<option value="">全部</option>' : '',
      list.map(d => `<option value="${d.id}"${d.id === selected ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`).join(''),
    ].join('');
  },

  /** 空态表格行 */
  emptyRow(colspan, text) {
    return `<tr><td colspan="${colspan}" class="text-muted" style="text-align:center;padding:24px">${Utils.escapeHtml(text)}</td></tr>`;
  },
};

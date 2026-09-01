/**
 * admin.js - 报送模块管理员仪表盘
 * 负责报送状态概览、汇总明细表、CSV 导出、报送配置
 * （账号/部门管理已移至「人员与组织」模块 js/modules/people/people.js）
 */

const Admin = {

  state: {
    view: 'reports',          // 'reports' | 'completed' | 'myreport' | 'config'
    year: null,
    month: null,
    departments: [],
    reports: [],
    completedProjects: [],    // 已完工项目（按项目归并，取最近一次完工报送）
    users: [],
    usersLoaded: false,
    hasPhoneColumn: false,    // profiles 是否有 phone 列（未执行 sql/phone-login.sql 时为 false，自动隐藏手机号功能）
    departmentsLoaded: false,
    deptUserCounts: {},       // department_id -> 账号数
    deptReportCounts: {},     // department_id -> 报送记录数
    loading: false,
    editingUserId: null,
    editingDeptId: null,
    // 报送配置
    projectTypes: [],         // 项目类型（project_types 表）
    reportFields: [],         // 自定义字段（report_fields 表）
    formConfigLoaded: false,
    editingTypeId: null,
    editingFieldId: null,
    statusFilter: 'all',      // 部门报送状态筛选：all | submitted | pending | confirmed
    noFieldStatus: {},        // department_id -> department_month_status 行（无野外施工确认，含全部状态）
    // 账号管理页
    userSearch: '',           // 账号搜索关键词（姓名/手机号/邮箱/部门）
    userExpanded: new Set(JSON.parse(localStorage.getItem('admin-user-expanded') || '[]')),
  },

  /**
   * 渲染管理员仪表盘
   * @param {HTMLElement} container
   * @param {{readOnly?: boolean}} [opts] readOnly=true 时为只读模式（不可修改）
   */
  async render(container, opts = {}) {
    this.state.readOnly = !!(opts && opts.readOnly);
    this.state.entityMode = !!(opts && opts.entityMode);
    // 每次进入模块统一回到「报送管理」，避免胶囊高亮停留在上次退出前的视图
    this.state.view = 'reports';
    const ym = Utils.getCurrentYearMonth();
    this.state.year = ym.year;
    this.state.month = ym.month;

    container.innerHTML = this.buildHTML();
    this.bindEvents(container);
    Utils.bindBackToTop('report-admin-back-top');
    await this.loadData();
  },

  /**
   * 只读模式守卫：返回 true 表示当前为只读，应中止写操作
   */
  assertWritable() {
    if (this.state.readOnly) {
      Utils.toast('当前为只读模式，无权修改数据', 'error');
      return true;
    }
    return false;
  },

  /**
   * 构建 HTML
   */
  buildHTML() {
    return `
      <div class="dashboard${this.state.readOnly ? ' admin-readonly' : ''}">
        <button class="back-to-top" id="report-admin-back-top" title="回到顶部" aria-label="回到顶部">↑</button>
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildTabs()}
          <!-- 项目报送视图（有报送权的管理员：内嵌部门报送界面） -->
          <div id="admin-myreport-view" style="display:none;">
            <div id="admin-myreport-content"></div>
          </div>
          <!-- 报送管理视图 -->
          <div id="admin-reports-view">
            ${this.buildToolbar()}
            <div id="admin-stats"></div>
            <div id="admin-status"></div>
            <div id="admin-summary"></div>
          </div>
          <!-- 完工项目汇总视图 -->
          <div id="admin-completed-view" style="display:none;">
            <div id="admin-completed-content"></div>
          </div>
          <!-- 报送配置视图 -->
          <div id="admin-config-view" style="display:none;">
            <div id="admin-config-content"></div>
          </div>
        </div>
      </div>
    `;
  },

  buildTabs() {
    const views = [];
    // 有报送权的管理员（部门管理员/项目管理员/经营实体管理员）：内嵌「项目报送」
    if (Auth.canReport() && (Auth.isAdmin() || Auth.isEntityManager())) {
      views.push({ key: 'myreport', label: '项目报送' });
    }
    views.push(
      { key: 'reports',     label: '报送管理' },
      { key: 'completed',   label: '完工项目' },
    );
    // 报送配置仅公司级管理员；账号/部门管理已移至「人员与组织」模块
    if (!this.state.entityMode && Auth.isAdmin() && Auth.isCompanyAdmin()) {
      views.push({ key: 'config', label: '报送配置' });
    }
    return `
      <div class="dashboard-tabs">
        ${views.map(v => `
          <button class="tab-btn ${this.state.view === v.key ? 'active' : ''}" data-view="${v.key}"
            onclick="Admin.switchView('${v.key}')">${v.label}</button>
        `).join('')}
      </div>
    `;
  },

  /**
   * 切换视图
   * @param {'reports'|'completed'|'myreport'|'config'} view
   */
  async switchView(view) {
    // 经营实体模式不开放报送配置
    if (this.state.entityMode && view === 'config') return;
    // 报送配置仅公司级管理员可进入
    if (view === 'config' && !Auth.isCompanyAdmin()) return;
    // 项目报送：仅被授予报送权的账号可进入
    if (view === 'myreport' && !Auth.canReport()) return;

    this.state.view = view;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.querySelector(`.dashboard-tabs .tab-btn[data-view="${view}"]`);
    if (btn) btn.classList.add('active');

    const myreportView = document.getElementById('admin-myreport-view');
    const reportsView = document.getElementById('admin-reports-view');
    const completedView = document.getElementById('admin-completed-view');
    const configView = document.getElementById('admin-config-view');
    if (!reportsView || !completedView || !configView) return;

    if (myreportView) myreportView.style.display = view === 'myreport' ? '' : 'none';
    reportsView.style.display = view === 'reports' ? '' : 'none';
    completedView.style.display = view === 'completed' ? '' : 'none';
    configView.style.display = view === 'config' ? '' : 'none';

    if (view === 'myreport') {
      // 内嵌部门报送界面（Reporter 独立模块，embedded 模式：无头部/外框，每次进入重新渲染）
      const content = document.getElementById('admin-myreport-content');
      if (content) await Reporter.render(content, { embedded: true });
    } else if (view === 'completed') {
      await this.loadCompletedProjects();
    } else if (view === 'config') {
      if (!this.state.formConfigLoaded) {
        await this.loadFormConfig();
      } else {
        this.renderConfig();
      }
    }
  },

  buildHeader() {
    return `
      <div class="dashboard-header">
        <div class="dashboard-header-inner">
          <div class="header-left">
            <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          </div>
          <div class="header-center">
            <h1 class="page-title">野外施工项目报送</h1>
          </div>
          <div class="header-right">
            <span class="badge ${this.state.readOnly ? 'badge-muted' : (this.state.entityMode ? 'badge-info' : 'badge-success')}">${this.state.readOnly ? '只读查看' : (this.state.entityMode ? '经营实体' : '管理员')}</span>
            ${!this.state.readOnly && Auth.isSuperAdmin() ? '<span class="badge badge-danger">超级管理员</span>' : ''}
            <div class="user-info">
              <span class="user-name">${Utils.escapeHtml(Auth.currentProfile.full_name || Auth.currentProfile.email || '管理员')}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>
    `;
  },

  buildToolbar() {
    const years = Utils.getYearOptions();
    const months = Utils.getMonthOptions();
    return `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>报送年份：</label>
          <select id="admin-filter-year" onchange="Admin.onMonthChange()">
            ${years.map(y => `<option value="${y}" ${y === this.state.year ? 'selected' : ''}>${y}年</option>`).join('')}
          </select>
          <label>月份：</label>
          <select id="admin-filter-month" onchange="Admin.onMonthChange()">
            ${months.map(m => `<option value="${m}" ${m === this.state.month ? 'selected' : ''}>${m}月</option>`).join('')}
          </select>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-secondary" onclick="Admin.exportCSV()">导出汇总表 (CSV)</button>
          <button class="btn btn-secondary" onclick="Admin.loadData()">刷新</button>
        </div>
      </div>
    `;
  },

  onMonthChange() {
    this.state.year = parseInt(document.getElementById('admin-filter-year').value);
    this.state.month = parseInt(document.getElementById('admin-filter-month').value);
    this.loadData();
  },

  bindEvents() { /* 事件绑定在 buildToolbar 的 onchange 中已完成 */ },

  /**
   * 加载所有数据（部门 + 报送记录）
   */
  async loadData() {
    this.state.loading = true;
    this.renderLoading();

    // 并行查询部门、报送记录、表单配置（自定义字段）、无野外施工确认状态
    const [deptRes, reportRes, fieldsRes, dmsRes] = await Promise.all([
      sb.from('departments').select('*').order('sort_order'),
      sb.from('project_reports')
        .select('*, departments(name, code)')
        .eq('reporting_year', this.state.year)
        .eq('reporting_month', this.state.month)
        .order('department_id', { ascending: true })
        .order('submitted_at', { ascending: false }),
      sb.from('report_fields').select('*').order('sort_order'),
      // 无野外施工确认状态（旧库未执行 no-field-projects.sql 时该表不存在，自动降级）
      sb.from('department_month_status')
        .select('*')
        .eq('reporting_year', this.state.year)
        .eq('reporting_month', this.state.month)
    ]);

    if (deptRes.error) {
      Utils.toast('加载部门列表失败: ' + deptRes.error.message, 'error');
      return;
    }

    if (reportRes.error) {
      Utils.toast('加载报送记录失败: ' + reportRes.error.message, 'error');
      return;
    }

    this.state.departments = deptRes.data || [];
    this.state.reports = reportRes.data || [];
    // 报送字段配置（内置+自定义，用于汇总表/CSV 动态列；查询失败不阻断主流程）
    this.state.reportFields = Utils.normalizeReportFields(
      (fieldsRes && !fieldsRes.error) ? (fieldsRes.data || []) : []
    );
    // 无野外施工确认状态：旧库未执行 no-field-projects.sql 时该表不存在，自动降级（忽略错误）
    const dmsMap = {};
    if (dmsRes && !dmsRes.error && dmsRes.data) {
      for (const s of dmsRes.data) dmsMap[s.department_id] = s;
    }
    this.state.noFieldStatus = dmsMap;
    this.state.loading = false;

    this.renderStats();
    this.renderStatus();
    this.renderSummary();
  },

  renderLoading() {
    document.getElementById('admin-stats').innerHTML = '';
    document.getElementById('admin-status').innerHTML = '';
    document.getElementById('admin-summary').innerHTML = `
      <div class="card">
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;
  },

  /**
   * 参与月度报送的部门（管理部门如「安全生产部」、子公司如「物化院有限公司」「六勘院有限公司」
   * 不是报送部门，从报送统计的「部门总数」「部门报送状态」中排除，但仍保留在「部门管理」列表中）
   */
  reportingDepts() {
    const depts = this.state.departments || [];
    const hasFlag = depts.some(d => 'needs_report' in d);
    if (hasFlag) {
      return depts.filter(d => d.needs_report !== false);
    }
    const excludedDeptNames = new Set(['安全生产部', '物化院有限公司', '六勘院有限公司']);
    return depts.filter(d => !excludedDeptNames.has(d.name));
  },

  /**
   * 统计卡片
   */
  renderStats() {
    const container = document.getElementById('admin-stats');
    // 仅统计需要报送的部门（安全生产部为管理部门，无需报送）
    const depts = this.reportingDepts();
    const reports = this.state.reports;

    // 已报送的部门集合（含已确认"无野外施工"视同 0 填报的部门）
    const noFieldMap = this.state.noFieldStatus || {};
    const submittedDeptIds = new Set(reports.map(r => r.department_id));
    // 已确认无野外施工、且无实际报送记录的部门（与有实际报送的部门互斥计数）
    const noFieldDeptIds = new Set(
      Object.keys(noFieldMap)
        .filter(id => noFieldMap[id] && noFieldMap[id].no_field_projects && !submittedDeptIds.has(id))
    );
    const reportedSet = new Set([...submittedDeptIds, ...noFieldDeptIds]);
    const submittedCount = depts.filter(d => reportedSet.has(d.id)).length;
    const noFieldCount = noFieldDeptIds.size;
    const notSubmittedCount = depts.length - submittedCount;

    const totalPersonnel = reports.reduce((sum, r) => sum + (r.on_site_personnel || 0), 0);
    const totalVehicles = reports.reduce((sum, r) => sum + (r.on_site_vehicles || 0), 0);
    const hazardCount = reports.filter(r => r.safety_hazards).length;
    const inspectionRate = reports.length > 0
      ? Math.round(reports.filter(r => r.safety_inspection).length / reports.length * 100)
      : 0;

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">部门总数</div>
          <div class="stat-value">${depts.length}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">已报送部门</div>
          <div class="stat-value">${submittedCount}</div>
        </div>
        <div class="stat-card info">
          <div class="stat-label">已确认无野外</div>
          <div class="stat-value">${noFieldCount}</div>
        </div>
        <div class="stat-card danger">
          <div class="stat-label">未报送部门</div>
          <div class="stat-value">${notSubmittedCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">报送项目总数</div>
          <div class="stat-value">${reports.length}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">现场总人数</div>
          <div class="stat-value">${totalPersonnel}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">现场总车辆数</div>
          <div class="stat-value">${totalVehicles}</div>
        </div>
        <div class="stat-card ${hazardCount > 0 ? 'danger' : 'success'}">
          <div class="stat-label">安全隐患项目</div>
          <div class="stat-value">${hazardCount}</div>
        </div>
        <div class="stat-card ${inspectionRate >= 80 ? 'success' : (inspectionRate >= 50 ? 'warning' : 'danger')}">
          <div class="stat-label">安全自检率</div>
          <div class="stat-value">${inspectionRate}%</div>
        </div>
      </div>
    `;
  },

  /**
   * 部门报送状态（紧凑网格卡片 + 筛选）
   */
  renderStatus() {
    const container = document.getElementById('admin-status');
    // 仅展示需要报送的部门（安全生产部为管理部门，无需报送，从报送状态中排除）
    const depts = this.reportingDepts();
    const reports = this.state.reports;

    // 按部门分组报送记录
    const reportsByDept = {};
    for (const r of reports) {
      if (!reportsByDept[r.department_id]) reportsByDept[r.department_id] = [];
      reportsByDept[r.department_id].push(r);
    }

    const noFieldMap = this.state.noFieldStatus || {};
    // 已报送部门 = 有实际报送 或 已确认无野外施工（互斥计数，避免重复）
    const reportedSet = new Set([
      ...Object.keys(reportsByDept),
      ...Object.keys(noFieldMap).filter(id => noFieldMap[id] && noFieldMap[id].no_field_projects && !reportsByDept[id])
    ]);
    const submittedCount = reportedSet.size;
    const noFieldCount = Object.keys(noFieldMap)
      .filter(id => noFieldMap[id] && noFieldMap[id].no_field_projects && !reportsByDept[id]).length;
    const pendingCount = depts.length - submittedCount;
    const filter = this.state.statusFilter;

    const chip = (key, label, count) => `
      <button class="chip ${filter === key ? 'active' : ''}" data-status="${key}"
        onclick="Admin.filterStatus('${key}')">${label} ${count}</button>
    `;

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>部门报送状态（${this.state.year}年${this.state.month}月）</h2>
          <div class="status-filter">
            ${chip('all', '全部', depts.length)}
            ${chip('submitted', '已报送', submittedCount)}
            ${chip('confirmed', '已确认无野外', noFieldCount)}
            ${chip('pending', '未报送', pendingCount)}
          </div>
        </div>
        <div class="card-body has-padding">
          <div class="dept-status-grid" id="dept-status-grid">
            ${depts.map(d => this.buildStatusChip(d, reportsByDept[d.id] || [])).join('')}
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 单个部门状态卡片
   */
  buildStatusChip(d, deptReports) {
    const nf = this.state.noFieldStatus ? this.state.noFieldStatus[d.id] : null;
    const confirmedNoField = !!(nf && nf.no_field_projects);
    const submitted = deptReports.length > 0;

    let cls, statusText, title, timeHtml;
    if (submitted) {
      cls = 'submitted';
      const lastTime = deptReports[0].submitted_at;
      statusText = `已报送 ${deptReports.length} 项`;
      title = lastTime ? `最近报送：${Utils.formatDateTime(lastTime)}` : `${Utils.escapeHtml(d.name)} 已报送`;
      timeHtml = lastTime ? `<div class="dept-chip-time">${Utils.formatDateTime(lastTime).slice(5)}</div>` : '';
    } else if (confirmedNoField) {
      cls = 'confirmed';
      statusText = '已确认无野外施工';
      title = `${Utils.escapeHtml(d.name)} 已确认本月无正在野外施工的项目（视同 0 填报）`;
      timeHtml = nf.confirmed_at
        ? `<div class="dept-chip-time">确认于 ${Utils.formatDateTime(nf.confirmed_at).slice(5)}</div>`
        : '';
    } else {
      cls = 'pending';
      statusText = '未报送';
      title = `${Utils.escapeHtml(d.name)} 尚未报送`;
      timeHtml = '';
    }

    return `
      <div class="dept-chip ${cls}" data-status="${cls}" title="${title}">
        <div class="dept-chip-name">${Utils.escapeHtml(d.name)}</div>
        <div class="dept-chip-status">${statusText}</div>
        ${timeHtml}
      </div>
    `;
  },

  /**
   * 切换部门报送状态筛选
   * @param {'all'|'submitted'|'confirmed'|'pending'} filter
   */
  filterStatus(filter) {
    this.state.statusFilter = filter;
    const grid = document.getElementById('dept-status-grid');
    if (!grid) return;
    document.querySelectorAll('#admin-status .chip').forEach(c =>
      c.classList.toggle('active', c.dataset.status === filter));
    grid.querySelectorAll('.dept-chip').forEach(card => {
      card.style.display = (filter === 'all' || card.dataset.status === filter) ? '' : 'none';
    });
  },

  /**
   * 汇总明细表（列完全由报送字段配置驱动，停用的字段自动不显示）
   * - safety_hazard_detail（安全隐患详情）仅在详情弹窗中展示，汇总表不单独列
   * - 短表头字段（工期/人数/车辆/安全自检/安全隐患/合同额）紧凑显示、表头 2 行
   */
  // 汇总表隐藏的内置字段（详情弹窗仍完整展示）
  // 注：contact_info 已与 project_manager 合并为一列展示，故在此隐藏
  SUMMARY_HIDDEN_KEYS: new Set(['safety_hazard_detail', 'contact_info', 'equipment_models']),
  // 「项目归属部门」按部门着色的浅色板（每个部门一个固定底色，便于区分不同部门项目）
  DEPT_PALETTE: ['#E6F4F1', '#FCEEE3', '#EAF0F6', '#F2F8E0', '#F3E8F7', '#FDE8EF', '#EAEFE6', '#FFF4CC', '#E9E4F0', '#F0E6DD'],
  // 紧凑列：表头短 + 值短 → 窄列、表头允许 2 行换行
  COMPACT_KEYS: new Set([
    'duration_months', 'contract_amount', 'on_site_personnel',
    'on_site_vehicles', 'safety_inspection', 'safety_hazards',
  ]),
  // 单行列：长文本字段在汇总表中只显示一行（省略号），悬停看全文
  SINGLE_LINE_KEYS: new Set([
    'department_entity',
  ]),
  // 三行列：长文本字段最多显示三行（省略号），悬停看全文
  THREE_LINE_KEYS: new Set([
    'construction_location', 'overall_progress', 'monthly_construction_status',
    'project_type',
  ]),
  // 固定宽度列：内容短，限定紧凑宽度避免占用过多空间（如项目负责人姓名）
  FIXED_WIDTH_KEYS: new Set(['project_manager']),
  // 窄列：内容较短（项目归属部门），限定更窄宽度，节省横向空间给项目名称
  NARROW_KEYS: new Set(['department_entity']),
  // 每行最多 N 个汉字的列：列宽按 em 精确控制（1em≈1 个全角汉字），配合三行截断
  // 项目名称：每行 10 个汉字（完整换行，不截断，点击 td 看详情）
  CH_PER_LINE: { construction_location: 6, project_type: 7, project_name: 10 },
  // 汇总表表头改名（仅影响表头展示，不影响表单/详情）
  LABEL_OVERRIDES: { department_entity: '项目归属部门' },
  // 汇总表表头按指定位置换行（一行 N 个汉字），用 <br> 精确控制
  HEADER_BREAKS: {
    on_site_personnel: '现场<br>人数',
    on_site_vehicles: '现场<br>车辆数',
    project_manager: '负责人<br>联系方式',
    department_entity: '项目归属<br>部门',
    overall_progress: '项目整体<br>进度情况',
    monthly_construction_status: '本月项目<br>施工情况',
  },
  // 汇总表字段内容截断长度（超过该字数省略，悬停 title 看全文）
  FIELD_MAXLEN: {},

  renderSummary() {
    const container = document.getElementById('admin-summary');
    const reports = this.state.reports;
    const allFields = this.state.reportFields || [];
    // 汇总明细表隐藏字段
    const fields = allFields.filter(f => !Admin.SUMMARY_HIDDEN_KEYS.has(f.field_key));

    if (reports.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2>汇总明细表</h2>
          </div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📋</div>
              <p>${this.state.year}年${this.state.month}月暂无任何报送记录</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const thClass = (f) => {
      const cls = [];
      if (Admin.COMPACT_KEYS.has(f.field_key)) cls.push('th-compact');
      if (Admin.FIXED_WIDTH_KEYS.has(f.field_key)) cls.push('cell-fixed');
      if (Admin.NARROW_KEYS.has(f.field_key)) cls.push('cell-narrow');
      if (Admin.CH_PER_LINE[f.field_key]) cls.push('cell-ch' + Admin.CH_PER_LINE[f.field_key]);
      return cls.join(' ');
    };
    const thLabel = (f) => {
      if (Admin.HEADER_BREAKS[f.field_key]) return Admin.HEADER_BREAKS[f.field_key];
      return Utils.escapeHtml(Admin.LABEL_OVERRIDES[f.field_key] || f.label);
    };

    // 部门底色：每个不同部门分配一个固定的浅色，仅用于「项目归属部门」单元格标注
    const deptColorMap = (() => {
      const map = new Map();
      let idx = 0;
      reports.forEach(r => {
        const dept = (r.department_entity || '').trim();
        if (dept && !map.has(dept)) { map.set(dept, idx % Admin.DEPT_PALETTE.length); idx++; }
      });
      return map;
    })();

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>汇总明细表（${this.state.year}年${this.state.month}月，共 ${reports.length} 条记录）</h2>
        </div>
        <div class="card-body">
          <div class="table-wrapper summary-wrapper">
            <table class="data-table summary-table">
              <thead>
                <tr>
                  <th>序号</th>
                  ${fields.map(f => `<th class="${thClass(f)}">${thLabel(f)}</th>`).join('')}
                  <th>报送时间</th>
                </tr>
              </thead>
              <tbody>
                ${reports.map((r, i) => this.renderSummaryRow(r, i, fields, deptColorMap)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  renderSummaryRow(r, index, fields, deptColorMap) {
    fields = fields || (this.state.reportFields || []).filter(f => !Admin.SUMMARY_HIDDEN_KEYS.has(f.field_key));
    // 当前行的「项目归属部门」对应底色索引（用于单元格内标签着色）
    const deptIdx = deptColorMap.get((r.department_entity || '').trim());
    const deptBg = deptIdx != null ? Admin.DEPT_PALETTE[deptIdx] : '';
    return `
      <tr>
        <td>${index + 1}</td>
        ${fields.map(f => {
          const isProjectName = f.field_key === 'project_name';
          const isCompact = Admin.COMPACT_KEYS.has(f.field_key);
          const isSingleLine = Admin.SINGLE_LINE_KEYS.has(f.field_key);
          const isThreeLine = Admin.THREE_LINE_KEYS.has(f.field_key);
          const isFixed = Admin.FIXED_WIDTH_KEYS.has(f.field_key);
          const isNarrow = Admin.NARROW_KEYS.has(f.field_key);
          const chPerLine = Admin.CH_PER_LINE[f.field_key];
          // 单行/三行/固定窄列字段由 CSS 省略号控制显示；title 悬停看全文
          const rawVal = f.is_builtin ? r[f.field_key] : (r.custom_data || {})[f.field_key];

          const titleAttr = (isSingleLine || isThreeLine || isFixed) && rawVal ? ` title="${Utils.escapeHtml(String(rawVal))}"` : '';
          const maxLen = Admin.FIELD_MAXLEN[f.field_key] || 0;
          const tdClass = [
            isProjectName ? 'cell-project-name' : '',
            isCompact ? 'cell-compact' : '',
            isSingleLine ? 'cell-oneline' : '',
            isThreeLine ? 'cell-three-line' : '',
            isFixed ? 'cell-fixed' : '',
            isNarrow ? 'cell-narrow' : '',
            chPerLine ? 'cell-ch' + chPerLine : '',
          ].filter(Boolean).join(' ');

          // 「项目归属部门」：用部门专属浅色标签标注，便于区分不同部门项目
          if (f.field_key === 'department_entity') {
            const txt = this.formatFieldValue(r, f, 0, { omitUnit: true });
            return `<td class="${tdClass}"><span class="dept-tag" style="background:${deptBg};">${txt}</span></td>`;
          }
          if (isProjectName) {
            return `<td class="${tdClass}" onclick="Admin.showReportDetail('${r.id}')" title="点击查看项目详情"><span class="project-name-clamp">${this.formatFieldValue(r, f)}</span></td>`;
          }
          // 三行字段：td 保持 table-cell，内层 span 负责最多三行截断（避免 display 变更盖住相邻列）
          if (isThreeLine) {
            return `<td class="${tdClass}"${titleAttr}><span class="three-line-clamp">${this.formatFieldValue(r, f)}</span></td>`;
          }
          // 项目负责人与联系方式合并为一列：负责人上一行、联系方式下一行
          if (f.field_key === 'project_manager') {
            const mgr = r.project_manager != null ? String(r.project_manager) : '';
            const ct = r.contact_info != null ? String(r.contact_info) : '';
            const full = [mgr, ct].filter(Boolean).join(' ');
            const title = full ? ` title="${Utils.escapeHtml(full)}"` : '';
            const body = `${Utils.escapeHtml(mgr)}<br>${Utils.escapeHtml(ct)}`;
            return `<td class="${tdClass}"${title}>${body}</td>`;
          }
          return `<td class="${tdClass}"${titleAttr}>${this.formatFieldValue(r, f, maxLen, { omitUnit: true })}</td>`;
        }).join('')}
        <td style="white-space:nowrap;">${Utils.formatDateTime(r.submitted_at)}</td>
      </tr>
    `;
  },

  /**
   * 读取字段在记录中的值并格式化展示（内置字段读列、自定义字段读 custom_data）
   * @param {number} maxLen 文本字段最大显示字数（0 = 不截断）；用于汇总明细表精简长文本
   * @returns {string} 展示用 HTML（已转义）
   */
  formatFieldValue(r, f, maxLen = 0, opts = {}) {
    let v;
    if (f.is_builtin) {
      v = r[f.field_key];
      // 安全自检：已自检=绿；安全隐患：存在隐患=红（与部门报送列表语义一致）
      if (f.field_key === 'safety_inspection') {
        return v ? '<span class="badge badge-success">是</span>' : '<span class="badge badge-danger">否</span>';
      }
      if (f.field_key === 'safety_hazards') {
        return v ? '<span class="badge badge-danger">是</span>' : '<span class="badge badge-success">否</span>';
      }
      // 合同额：汇总表传 omitUnit=true 时只显示数字（不带"万元"）
      if (f.field_key === 'contract_amount' && v != null && v !== '') {
        if (opts && opts.omitUnit) {
          return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        return Utils.formatAmount(v);
      }
      return this.truncateText(v, maxLen);
    }
    const cd = r.custom_data || {};
    v = cd[f.field_key];
    return this.truncateText(v, maxLen);
  },

  /**
   * 文本截断（超出 maxLen 个汉字时省略，保留悬停全文由调用方加 title）
   * @param {*} v 原始值
   * @param {number} maxLen 最大字数（0 = 不截断）
   * @returns {string} 已转义的展示 HTML
   */
  truncateText(v, maxLen) {
    if (v == null || v === '') return '-';
    const s = String(v);
    if (maxLen > 0 && s.length > maxLen) {
      return Utils.escapeHtml(s.slice(0, maxLen)) + '…';
    }
    return Utils.escapeHtml(s);
  },

  /**
   * 读取字段在记录中的原始值（供 CSV 导出；布尔由 exportCSV 统一转"是/否"）
   */
  rawFieldValue(r, f) {
    if (f.is_builtin) {
      const v = r[f.field_key];
      return (v == null || v === '') ? '' : v;
    }
    const cd = r.custom_data || {};
    return (cd[f.field_key] == null || cd[f.field_key] === '') ? '' : cd[f.field_key];
  },

  /**
   * 导出 CSV
   */
  exportCSV() {
    const reports = this.state.reports;
    if (reports.length === 0) {
      Utils.toast('暂无数据可导出', 'error');
      return;
    }

    const columns = [
      { key: 'index', label: '序号' },
      { key: 'department_name', label: '报送部门' },
      // 报送字段（内置+自定义，与汇总表列一致，停用的自动排除）
      // 「联系方式」并入「项目负责人」列导出，避免拆分两列
      ...(this.state.reportFields || []).map(f => {
        if (f.field_key === 'contact_info') return null;
        if (f.field_key === 'project_manager') return { key: 'manager_contact', label: '负责人/联系方式' };
        return { key: `f_${f.field_key}`, label: f.label };
      }).filter(Boolean),
      { key: 'submitted_at', label: '报送时间' },
    ];

    // 添加部门名称、序号、各字段值
    const exportData = reports.map((r, i) => {
      const mgr = r.project_manager || '';
      const contact = r.contact_info || '';
      const row = {
        ...r,
        index: i + 1,
        department_name: r.departments ? r.departments.name : '',
        submitted_at: Utils.formatDateTime(r.submitted_at),
        // 负责人与联系方式合并到一个单元格（换行分隔，与汇总表展示一致）
        manager_contact: mgr + (contact ? '\n' + contact : ''),
      };
      for (const f of this.state.reportFields || []) {
        if (f.field_key === 'project_manager' || f.field_key === 'contact_info') continue;
        row[`f_${f.field_key}`] = this.rawFieldValue(r, f);
      }
      return row;
    });

    const filename = `施工项目月报汇总_${this.state.year}年${this.state.month}月.csv`;
    Utils.exportCSV(exportData, filename, columns);
    Utils.toast(`已导出 ${reports.length} 条记录`, 'success');
  },

  // ========================================================================
  // 完工项目汇总（全部部门已完工项目）
  // ========================================================================

  /**
   * 加载全部已完工项目
   * 查询所有报送记录中 project_status = 'completed' 的记录，
   * 按 部门+项目名称+施工地点 归并为项目，取最近一次完工报送。
   * 旧库未执行 project-status.sql（列不存在）时给出明确升级提示。
   */
  async loadCompletedProjects() {
    const container = document.getElementById('admin-completed-content');
    if (!container) return;

    container.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>已完工项目汇总</h2></div>
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;

    const res = await sb.from('project_reports')
      .select('*, departments(name, code)')
      .eq('project_status', 'completed')
      .order('reporting_year', { ascending: false })
      .order('reporting_month', { ascending: false });

    if (res.error) {
      // 旧库未执行 project-status.sql：列不存在 → 明确提示升级
      const isMissingColumn = res.error.code === '42703' || res.error.code === 'PGRST204'
        || /project_status/.test(res.error.message || '');
      container.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>已完工项目汇总</h2></div>
          <div class="card-body">
            <div class="alert ${isMissingColumn ? 'alert-warning' : 'alert-danger'}">
              ${isMissingColumn
                ? '当前数据库尚未启用「项目状态」功能。请在 Supabase SQL Editor 中执行 <code>sql/project-status.sql</code>，刷新本页后即可查看全部部门已完工项目。'
                : '加载失败：' + Utils.escapeHtml(res.error.message)}
            </div>
          </div>
        </div>
      `;
      return;
    }

    // 按 部门+项目名称+施工地点 归并（查询结果已按年月倒序，Map 首次放入的即最新一次）
    const map = new Map();
    for (const r of res.data || []) {
      const key = r.department_id + '|' + String(r.project_name) + '|' + String(r.construction_location || '');
      if (!map.has(key)) map.set(key, r);
    }
    const projects = [...map.values()]
      .sort((a, b) => (b.reporting_year - a.reporting_year) || (b.reporting_month - a.reporting_month));

    this.state.completedProjects = projects;
    this.renderCompletedTable(projects);
  },

  /**
   * 渲染完工项目汇总表
   */
  renderCompletedTable(projects) {
    const container = document.getElementById('admin-completed-content');
    if (!container) return;

    const totalAmount = projects.reduce((s, p) => s + Number(p.contract_amount || 0), 0);
    const deptCount = new Set(projects.map(p => p.department_id)).size;

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">已完工项目数</div>
          <div class="stat-value">${projects.length}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">涉及部门</div>
          <div class="stat-value">${deptCount}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">完工项目合同总额（万元）</div>
          <div class="stat-value">${totalAmount.toLocaleString('zh-CN', {maximumFractionDigits: 2})}</div>
        </div>
      </div>
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="toolbar-hint">全部部门已完工项目汇总（按项目归并，取最近一次完工报送）</span>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-secondary" onclick="Admin.exportCompletedCSV()">导出完工项目表 (CSV)</button>
          <button class="btn btn-secondary" onclick="Admin.loadCompletedProjects()">刷新</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h2>已完工项目汇总（共 ${projects.length} 个）</h2>
        </div>
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>报送部门</th>
                  <th>项目名称</th>
                  <th>项目类型</th>
                  <th>施工地点</th>
                  <th>合同额(万元)</th>
                  <th>完工报送月份</th>
                  <th>报送时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${projects.length === 0 ? `
                  <tr class="empty-row"><td colspan="9">暂无已完工项目</td></tr>
                ` : projects.map((p, i) => this.renderCompletedRow(p, i)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  renderCompletedRow(p, index) {
    const deptName = p.departments ? p.departments.name : '-';
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${Utils.escapeHtml(deptName)}</td>
        <td><strong>${Utils.escapeHtml(p.project_name)}</strong></td>
        <td>${Utils.escapeHtml(p.project_type)}</td>
        <td>${Utils.escapeHtml(p.construction_location)}</td>
        <td>${Utils.formatAmount(p.contract_amount)}</td>
        <td>${p.reporting_year}年${p.reporting_month}月</td>
        <td style="white-space:nowrap;">${Utils.formatDateTime(p.submitted_at)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="Admin.showCompletedDetail('${p.id}')">查看</button>
        </td>
      </tr>
    `;
  },

  /**
   * 完工项目详情弹窗（展示该条完工报送记录的全部配置字段）
   */
  showCompletedDetail(id) {
    const r = this.state.completedProjects.find(x => x.id === id);
    if (!r) {
      Utils.toast('未找到该项目', 'error');
      return;
    }

    const fields = (this.state.reportFields && this.state.reportFields.length > 0)
      ? this.state.reportFields
      : Utils.normalizeReportFields([]);

    const itemHTML = (f) => `
      <div class="detail-item">
        <div class="detail-label">${Utils.escapeHtml(f.label)}</div>
        <div class="detail-value">${this.formatFieldValue(r, f)}</div>
      </div>
    `;

    const modalHTML = `
      <div class="modal-overlay" id="completed-detail-modal" onclick="Admin.onCompletedDetailOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>完工项目详情：${Utils.escapeHtml(r.project_name)}</h2>
            <button class="modal-close" onclick="Admin.closeCompletedDetail()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              ${fields.map(itemHTML).join('')}
              <div class="detail-item col-span-2 form-section-divider">报送信息</div>
              <div class="detail-item">
                <div class="detail-label">报送部门</div>
                <div class="detail-value">${Utils.escapeHtml(r.departments ? r.departments.name : '-')}</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">完工报送月份</div>
                <div class="detail-value">${r.reporting_year}年${r.reporting_month}月</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">报送时间</div>
                <div class="detail-value">${Utils.formatDateTime(r.submitted_at)}</div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Admin.closeCompletedDetail()">关闭</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('completed-detail-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 完工详情弹窗：遮罩点击关闭（需 mousedown 起点也在遮罩，避免框选划出误关）
   */
  onCompletedDetailOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      this.closeCompletedDetail();
    }
  },

  closeCompletedDetail() {
    const modal = document.getElementById('completed-detail-modal');
    if (modal) modal.remove();
  },

  /**
   * 汇总明细表：点击「项目名称」查看该报送项目的具体信息（完整字段，不截断）
   * @param {string} id project_reports.id
   */
  showReportDetail(id) {
    const r = (this.state.reports || []).find(x => x.id === id);
    if (!r) {
      Utils.toast('未找到该项目', 'error');
      return;
    }

    const fields = this.state.reportFields || [];
    const itemHTML = (f) => `
      <div class="detail-item">
        <div class="detail-label">${Utils.escapeHtml(Admin.LABEL_OVERRIDES[f.field_key] || f.label)}</div>
        <div class="detail-value">${this.formatFieldValue(r, f)}</div>
      </div>
    `;

    const modalHTML = `
      <div class="modal-overlay" id="report-detail-modal" onclick="Admin.onReportDetailOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>项目详情：${Utils.escapeHtml(r.project_name || '')}</h2>
            <button class="modal-close" onclick="Admin.closeReportDetail()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              ${fields.map(itemHTML).join('')}
              <div class="detail-item col-span-2 form-section-divider">报送信息</div>
              <div class="detail-item">
                <div class="detail-label">报送部门</div>
                <div class="detail-value">${Utils.escapeHtml(r.departments ? r.departments.name : '-')}</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">报送月份</div>
                <div class="detail-value">${r.reporting_year}年${r.reporting_month}月</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">报送时间</div>
                <div class="detail-value">${Utils.formatDateTime(r.submitted_at)}</div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Admin.closeReportDetail()">关闭</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('report-detail-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 项目详情弹窗：遮罩点击关闭（需 mousedown 起点也在遮罩，避免框选划出误关）
   */
  onReportDetailOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      this.closeReportDetail();
    }
  },

  closeReportDetail() {
    const modal = document.getElementById('report-detail-modal');
    if (modal) modal.remove();
  },

  /**
   * 导出完工项目表 CSV
   */
  exportCompletedCSV() {
    const projects = this.state.completedProjects || [];
    if (projects.length === 0) {
      Utils.toast('暂无完工项目可导出', 'error');
      return;
    }

    const columns = [
      { key: 'index', label: '序号' },
      { key: 'department_name', label: '报送部门' },
      { key: 'project_name', label: '项目名称' },
      { key: 'project_type', label: '项目类型' },
      { key: 'construction_location', label: '施工地点' },
      { key: 'contract_amount', label: '合同额(万元)' },
      { key: 'completed_month', label: '完工报送月份' },
      { key: 'submitted_at', label: '报送时间' },
    ];

    const exportData = projects.map((p, i) => ({
      ...p,
      index: i + 1,
      department_name: p.departments ? p.departments.name : '',
      completed_month: `${p.reporting_year}年${p.reporting_month}月`,
      submitted_at: Utils.formatDateTime(p.submitted_at),
    }));

    const filename = `已完工项目汇总_${new Date().getFullYear()}.csv`;
    Utils.exportCSV(exportData, filename, columns);
    Utils.toast(`已导出 ${projects.length} 个完工项目`, 'success');
  },

  /**
   * 将 RPC 错误转为友好提示
   * RPC 函数 RAISE EXCEPTION 时，PostgREST 返回的 error.message 是 JSON 字符串
   * 如：{"code":"P0001","message":"该邮箱已被使用","detail":"","hint":""}
   */
  mapRpcError(err) {
    const msg = err && err.message ? err.message : String(err);
    // 尝试解析 JSON 格式（PostgreSQL 函数异常的标准返回格式）
    try {
      const parsed = JSON.parse(msg);
      if (parsed && parsed.message) return parsed.message;
    } catch (e) { /* 非 JSON，继续走字符串清理 */ }
    const cleaned = msg
      .replace(/^PGRST\d+:\s*/i, '')
      .replace(/^server message:\s*/i, '')
      .trim();
    // 数据库唯一索引兜底翻译（旧版 RPC 未做中文预检查时也能看懂）
    if (/idx_profiles_phone/.test(cleaned)) {
      return '该手机号已被其他账号绑定，不能重复开通。请在账号列表中找到该员工的现有账号（培训模块自助开通的账号也在列表中），点「编辑」调整角色/部门即可；若是别人的手机号，请更换。';
    }
    return cleaned || '操作失败';
  },



  // ========================================================================
  // 报送配置（项目类型 + 自定义字段）
  // ========================================================================

  /**
   * 加载表单配置：项目类型 + 自定义字段 + 类型使用次数
   */
  async loadFormConfig() {
    const container = document.getElementById('admin-config-content');
    if (!container) return;

    container.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>报送配置</h2></div>
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;

    // 并行查询：项目类型 + 自定义字段 + 历史报送记录的类型使用情况
    const [typesRes, fieldsRes, reportRes] = await Promise.all([
      sb.from('project_types').select('*').order('sort_order'),
      sb.from('report_fields').select('*').order('sort_order'),
      sb.from('project_reports').select('project_type'),
    ]);

    this.state.projectTypes = (typesRes && !typesRes.error) ? (typesRes.data || []) : [];
    // 归一化：新库直接取（含内置种子）；旧库合并静态内置字段 + 库中自定义字段
    this.state.reportFields = Utils.normalizeReportFields(
      (fieldsRes && !fieldsRes.error) ? (fieldsRes.data || []) : []
    );

    // 统计各项目类型的历史使用次数
    const typeUsage = {};
    if (reportRes && !reportRes.error) {
      for (const r of reportRes.data || []) {
        if (r.project_type) typeUsage[r.project_type] = (typeUsage[r.project_type] || 0) + 1;
      }
    }
    this.state.typeUsage = typeUsage;
    this.state.formConfigLoaded = true;

    this.renderConfig();
  },

  /**
   * 渲染报送配置页面（项目类型表格 + 自定义字段表格）
   */
  renderConfig() {
    const container = document.getElementById('admin-config-content');
    if (!container) return;

    const types = this.state.projectTypes;
    const fields = this.state.reportFields;
    const usage = this.state.typeUsage || {};

    container.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <span class="toolbar-hint">配置部门报送表单的项目类型选项与附加字段</span>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-primary" onclick="Admin.openTypeModal()">+ 新增项目类型</button>
          <button class="btn btn-primary" onclick="Admin.openFieldModal()">+ 新增字段</button>
          <button class="btn btn-secondary" onclick="Admin.loadFormConfig()">刷新</button>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>项目类型选项（报送表单「项目类型」下拉框）</h2></div>
        <div class="card-body">
          <div class="table-wrapper has-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>类型名称</th>
                  <th>排序</th>
                  <th>使用次数</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${types.length === 0 ? `
                  <tr class="empty-row"><td colspan="6">暂无项目类型，点击右上角「+ 新增项目类型」创建</td></tr>
                ` : types.map((t, i) => `
                  <tr>
                    <td>${i + 1}</td>
                    <td><strong>${Utils.escapeHtml(t.name)}</strong></td>
                    <td>${t.sort_order ?? 0}</td>
                    <td>${usage[t.name] ? `<span class="badge badge-warning">${usage[t.name]}</span>` : 0}</td>
                    <td>${t.is_active === false ? '<span class="badge badge-muted">已停用</span>' : '<span class="badge badge-success">启用</span>'}</td>
                    <td style="white-space:nowrap;">
                      <button class="btn btn-secondary btn-sm" onclick="Admin.openTypeModal('${t.id}')">编辑</button>
                      <button class="btn btn-danger btn-sm" onclick="Admin.handleDeleteType('${t.id}')">删除</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>报送字段（默认项目报送表格的字段，可编辑名称/必填/排序/启停）</h2></div>
        <div class="card-body">
          <div class="table-wrapper has-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>序号</th>
                  <th>来源</th>
                  <th>字段名称</th>
                  <th>字段标识</th>
                  <th>类型</th>
                  <th>选项</th>
                  <th>必填</th>
                  <th>排序</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${fields.length === 0 ? `
                  <tr class="empty-row"><td colspan="10">暂无字段，点击右上角「+ 新增字段」创建</td></tr>
                ` : fields.map((f, i) => this.renderFieldRow(f, i)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="alert alert-info" style="margin-top:12px;line-height:1.8;">
        📌 使用说明：<br>
        1. <strong>项目类型</strong>决定部门报送时「项目类型」下拉框的可选项；已被历史报送记录使用的类型不能删除，如有需要可编辑改为「停用」。<br>
        2. <strong>报送字段</strong>即部门填报表格的完整字段。带「<span class="badge badge-info">内置</span>」标记的是系统默认字段（如项目名称、合同额、安全自检等）：<br>
        　 • 可以<strong>修改名称、必填、排序</strong>，也可以<strong>停用</strong>（停用后不再出现在部门报送表单、汇总表和 CSV 导出中）；<br>
        　 • 内置字段的<strong>数据类型由数据库决定，不可修改，也不可删除</strong>（防止历史数据与表结构损坏），删除请改用「停用」。<br>
        3. 点击「+ 新增字段」可增加<strong>自定义字段</strong>（支持 文本 / 数字 / 多行文本 / 下拉选择 / 日期），值随每条报送记录保存，并自动出现在汇总表和 CSV 导出中。<br>
        4. 删除或修改字段后，历史记录中已保存的值仍保留在数据库里，只是不再展示；请谨慎操作。
      </div>
    `;
  },

  renderFieldRow(f, index) {
    const typeMap = { text: '文本', number: '数字', textarea: '多行文本', select: '下拉选择', date: '日期' };
    const optionsStr = f.field_type === 'select' && Array.isArray(f.options)
      ? f.options.join('、') : '-';
    const sourceBadge = f.is_builtin
      ? '<span class="badge badge-info">内置</span>'
      : '<span class="badge badge-muted">自定义</span>';
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${sourceBadge}</td>
        <td><strong>${Utils.escapeHtml(f.label)}</strong></td>
        <td><code class="code-key">${Utils.escapeHtml(f.field_key)}</code></td>
        <td><span class="badge badge-muted">${typeMap[f.field_type] || f.field_type}</span></td>
        <td style="max-width:200px;">${Utils.escapeHtml(optionsStr)}</td>
        <td>${f.is_required ? '<span class="badge badge-warning">必填</span>' : '<span class="dept-meta">选填</span>'}</td>
        <td>${f.sort_order ?? 0}</td>
        <td>${f.is_active === false ? '<span class="badge badge-muted">已停用</span>' : '<span class="badge badge-success">启用</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="Admin.openFieldModal('${f.id}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="Admin.handleDeleteField('${f.id}')">删除</button>
        </td>
      </tr>
    `;
  },

  // ---------- 项目类型：新增 / 编辑 / 删除 ----------

  openTypeModal(typeId = null) {
    if (this.assertWritable()) return;
    const type = typeId ? this.state.projectTypes.find(t => t.id === typeId) : null;
    if (typeId && !type) {
      Utils.toast('未找到该项目类型', 'error');
      return;
    }

    this.state.editingTypeId = typeId;
    const v = type || {};
    const isEdit = !!typeId;
    const nextSort = this.state.projectTypes.length > 0
      ? Math.max(...this.state.projectTypes.map(t => Number(t.sort_order || 0))) + 1
      : 1;

    const modalHTML = `
      <div class="modal-overlay" id="type-modal" onclick="Admin.onTypeModalOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>${isEdit ? '编辑项目类型' : '新增项目类型'}</h2>
            <button class="modal-close" onclick="Admin.closeTypeModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div id="type-modal-error"></div>
            <form id="type-form" onsubmit="return false">
              <div class="form-grid">
                <div class="form-group col-span-2">
                  <label>类型名称 <span class="required">*</span></label>
                  <input type="text" name="name" value="${Utils.escapeHtml(v.name || '')}" required
                    placeholder="如：幕墙工程 / 消防工程" autocomplete="off">
                </div>
                <div class="form-group">
                  <label>排序号</label>
                  <input type="number" name="sort_order" value="${v.sort_order != null ? v.sort_order : nextSort}" min="0">
                  <p class="hint">数字越小越靠前</p>
                </div>
                ${isEdit ? `
                <div class="form-group">
                  <label>状态</label>
                  <div class="radio-group">
                    <label><input type="radio" name="is_active" value="true" ${v.is_active !== false ? 'checked' : ''}> 启用</label>
                    <label><input type="radio" name="is_active" value="false" ${v.is_active === false ? 'checked' : ''}> 停用</label>
                  </div>
                  <p class="hint">停用后不出现在报送表单</p>
                </div>
                <div class="form-group col-span-2">
                  <p class="hint">⚠️ 修改名称后，历史报送记录中的旧名称不会自动更新</p>
                </div>` : ''}
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Admin.closeTypeModal()">取消</button>
            <button class="btn btn-primary" onclick="Admin.submitType()">${isEdit ? '保存修改' : '创建类型'}</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('type-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  onTypeModalOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') this.closeTypeModal();
  },

  closeTypeModal() {
    const modal = document.getElementById('type-modal');
    if (modal) modal.remove();
    this.state.editingTypeId = null;
  },

  async submitType() {
    if (this.assertWritable()) return;
    const form = document.getElementById('type-form');
    if (!form) return;

    const fd = new FormData(form);
    const name = (fd.get('name') || '').trim();
    const sortOrder = parseInt(fd.get('sort_order'), 10);

    if (!name) { Utils.toast('请填写类型名称', 'error'); return; }
    if (isNaN(sortOrder) || sortOrder < 0) { Utils.toast('排序号必须为非负整数', 'error'); return; }

    const isEdit = !!this.state.editingTypeId;
    const submitBtn = document.querySelector('#type-modal .modal-footer .btn-primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';
    }

    try {
      const result = isEdit
        ? await sb.rpc('update_project_type', {
            p_type_id: this.state.editingTypeId,
            p_name: name,
            p_sort_order: sortOrder,
            p_is_active: fd.get('is_active') !== 'false',
          })
        : await sb.rpc('create_project_type', {
            p_name: name,
            p_sort_order: sortOrder,
          });

      if (result.error) {
        Utils.toast(this.mapRpcError(result.error), 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? '保存修改' : '创建类型'; }
        return;
      }

      Utils.toast(isEdit ? '项目类型已更新' : '项目类型已创建', 'success');
      this.closeTypeModal();
      await this.loadFormConfig();
    } catch (e) {
      console.error('提交项目类型失败:', e);
      Utils.toast('操作失败：' + (e.message || '未知错误'), 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? '保存修改' : '创建类型'; }
    }
  },

  async handleDeleteType(typeId) {
    if (this.assertWritable()) return;
    const type = this.state.projectTypes.find(t => t.id === typeId);
    if (!type) return;

    if (!confirm(`确定要删除项目类型「${type.name}」吗？\n\n此操作不可恢复！`)) return;

    try {
      const result = await sb.rpc('delete_project_type', { p_type_id: typeId });
      if (result.error) {
        Utils.toast(this.mapRpcError(result.error), 'error');
        return;
      }
      Utils.toast('项目类型已删除', 'success');
      await this.loadFormConfig();
      await this.loadData();
    } catch (e) {
      console.error('删除项目类型失败:', e);
      Utils.toast('删除失败：' + (e.message || '未知错误'), 'error');
    }
  },

  // ---------- 自定义字段：新增 / 编辑 / 删除 ----------

  openFieldModal(fieldId = null) {
    if (this.assertWritable()) return;
    const field = fieldId ? this.state.reportFields.find(f => f.id === fieldId) : null;
    if (fieldId && !field) {
      Utils.toast('未找到该字段', 'error');
      return;
    }

    // 旧库场景：默认字段是前端静态兜底（builtin_ 伪 id），数据库尚无对应记录，提示先升级 SQL
    if (field && String(field.id || '').startsWith('builtin_')) {
      Utils.toast('「' + field.label + '」为系统默认字段的预置配置，请先在 Supabase 执行最新版 sql/form-config.sql 完成升级后，即可在页面中编辑', 'error');
      return;
    }

    this.state.editingFieldId = fieldId;
    const v = field || {};
    const isEdit = !!fieldId;
    const isBuiltin = !!(v.is_builtin);
    const fieldType = v.field_type || 'text';
    const optionsStr = (v.options && Array.isArray(v.options)) ? v.options.join(',') : '';
    const nextSort = this.state.reportFields.length > 0
      ? Math.max(...this.state.reportFields.map(f => Number(f.sort_order || 0))) + 1
      : 1;

    const typeOptions = [
      { value: 'text', label: '文本' },
      { value: 'number', label: '数字' },
      { value: 'textarea', label: '多行文本' },
      { value: 'select', label: '下拉选择' },
      { value: 'date', label: '日期' },
    ];

    const modalHTML = `
      <div class="modal-overlay" id="field-modal" onclick="Admin.onFieldModalOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>${isEdit ? '编辑字段' : '新增自定义字段'}</h2>
            <button class="modal-close" onclick="Admin.closeFieldModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div id="field-modal-error"></div>
            <form id="field-form" onsubmit="return false">
              <div class="form-grid">
                <div class="form-group col-span-2">
                  <label>字段名称 <span class="required">*</span></label>
                  <input type="text" name="label" value="${Utils.escapeHtml(v.label || '')}" required
                    placeholder="如：质量评分 / 竣工日期 / 分包单位" autocomplete="off">
                  <p class="hint">报送表单中显示的名称</p>
                </div>
                <div class="form-group">
                  <label>字段类型 <span class="required">*</span></label>
                  <select name="field_type" onchange="Admin.onFieldTypeChange()" ${isBuiltin ? 'disabled' : ''}>
                    ${typeOptions.map(t => `<option value="${t.value}" ${fieldType === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
                  </select>
                  ${isBuiltin
                    ? '<p class="hint">🔒 系统内置字段，类型由数据库定义，不可修改</p>'
                    : '<p class="hint">选择字段的数据类型</p>'}
                </div>
                <div class="form-group">
                  <label>是否必填</label>
                  <div class="radio-group">
                    <label><input type="radio" name="is_required" value="true" ${v.is_required ? 'checked' : ''}> 必填</label>
                    <label><input type="radio" name="is_required" value="false" ${v.is_required ? '' : 'checked'}> 选填</label>
                  </div>
                </div>
                <div class="form-group col-span-2" id="field-options-group" style="${fieldType === 'select' ? '' : 'display:none;'}">
                  <label>选项列表 <span class="required">*</span></label>
                  <input type="text" name="options" value="${Utils.escapeHtml(optionsStr)}"
                    placeholder="多个选项用英文逗号分隔，如：优,良,中,差" ${isBuiltin ? 'disabled' : ''}>
                  <p class="hint">${isBuiltin ? '🔒 系统内置字段，选项不可修改' : '仅「下拉选择」类型需要填写，多个选项用英文逗号分隔'}</p>
                </div>
                <div class="form-group">
                  <label>排序号</label>
                  <input type="number" name="sort_order" value="${v.sort_order != null ? v.sort_order : nextSort}" min="0">
                  <p class="hint">数字越小越靠前</p>
                </div>
                ${isEdit ? `
                <div class="form-group">
                  <label>状态</label>
                  <div class="radio-group">
                    <label><input type="radio" name="is_active" value="true" ${v.is_active !== false ? 'checked' : ''}> 启用</label>
                    <label><input type="radio" name="is_active" value="false" ${v.is_active === false ? 'checked' : ''}> 停用</label>
                  </div>
                  <p class="hint">停用后不显示在报送表单与汇总表</p>
                </div>` : ''}
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Admin.closeFieldModal()">取消</button>
            <button class="btn btn-primary" onclick="Admin.submitField()">${isEdit ? '保存修改' : '创建字段'}</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('field-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 字段类型切换：只有「下拉选择」显示选项输入框
   */
  onFieldTypeChange() {
    const sel = document.querySelector('#field-form select[name="field_type"]');
    const group = document.getElementById('field-options-group');
    if (sel && group) {
      group.style.display = sel.value === 'select' ? '' : 'none';
    }
  },

  onFieldModalOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') this.closeFieldModal();
  },

  closeFieldModal() {
    const modal = document.getElementById('field-modal');
    if (modal) modal.remove();
    this.state.editingFieldId = null;
  },

  async submitField() {
    if (this.assertWritable()) return;
    const form = document.getElementById('field-form');
    if (!form) return;

    const fd = new FormData(form);
    const label = (fd.get('label') || '').trim();
    const fieldType = fd.get('field_type');
    const isRequired = fd.get('is_required') === 'true';
    const sortOrder = parseInt(fd.get('sort_order'), 10);

    if (!label) { Utils.toast('请填写字段名称', 'error'); return; }
    if (isNaN(sortOrder) || sortOrder < 0) { Utils.toast('排序号必须为非负整数', 'error'); return; }

    // 选项：仅下拉选择需要，中英文逗号均支持
    let options = null;
    if (fieldType === 'select') {
      options = (fd.get('options') || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      if (options.length === 0) {
        Utils.toast('下拉选择类型至少需要一个选项', 'error');
        return;
      }
    }

    const isEdit = !!this.state.editingFieldId;
    // 内置字段的类型/选项由数据库定义，提交时沿用原值（SQL 层同样锁定）
    const editingField = isEdit
      ? this.state.reportFields.find(x => x.id === this.state.editingFieldId) : null;
    const isBuiltin = !!(editingField && editingField.is_builtin);
    const submitBtn = document.querySelector('#field-modal .modal-footer .btn-primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '保存中...';
    }

    try {
      const result = isEdit
        ? await sb.rpc('update_report_field', {
            p_field_id: this.state.editingFieldId,
            p_label: label,
            p_field_type: isBuiltin ? editingField.field_type : fieldType,
            p_options: isBuiltin ? (editingField.options || null) : options,
            p_is_required: isRequired,
            p_sort_order: sortOrder,
            p_is_active: fd.get('is_active') !== 'false',
          })
        : await sb.rpc('create_report_field', {
            p_label: label,
            p_field_type: fieldType,
            p_options: options,
            p_is_required: isRequired,
            p_sort_order: sortOrder,
          });

      if (result.error) {
        Utils.toast(this.mapRpcError(result.error), 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? '保存修改' : '创建字段'; }
        return;
      }

      Utils.toast(isEdit ? '字段已更新' : '字段已创建', 'success');
      this.closeFieldModal();
      await this.loadFormConfig();
    } catch (e) {
      console.error('提交字段失败:', e);
      Utils.toast('操作失败：' + (e.message || '未知错误'), 'error');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? '保存修改' : '创建字段'; }
    }
  },

  async handleDeleteField(fieldId) {
    if (this.assertWritable()) return;
    const field = this.state.reportFields.find(f => f.id === fieldId);
    if (!field) return;

    // 内置字段禁止删除（对应数据库表列），提示改用停用
    if (field.is_builtin) {
      Utils.toast(`「${field.label}」为系统内置字段，不能删除；如需从报送表格中移除，请编辑并设为「停用」`, 'error');
      return;
    }

    if (!confirm(`确定要删除自定义字段「${field.label}」吗？\n\n历史报送记录中该字段已保存的值仍保留在数据中，但将不再展示。\n此操作不可恢复！`)) return;

    try {
      const result = await sb.rpc('delete_report_field', { p_field_id: fieldId });
      if (result.error) {
        Utils.toast(this.mapRpcError(result.error), 'error');
        return;
      }
      Utils.toast('字段已删除', 'success');
      await this.loadFormConfig();
    } catch (e) {
      console.error('删除字段失败:', e);
      Utils.toast('删除失败：' + (e.message || '未知错误'), 'error');
    }
  },
};

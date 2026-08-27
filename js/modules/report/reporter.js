/**
 * reporter.js - 部门报送模块
 * 负责部门用户的报送表单、报送记录列表、编辑、删除
 */

const Reporter = {

  state: {
    departmentId: null,
    departmentName: '',
    fullName: '',
    email: '',
    year: null,
    month: null,
    reports: [],
    editingId: null,
    projectTypes: [],   // 项目类型选项（来自 project_types 表）
    formFields: [],     // 报送字段配置（内置字段 + 自定义字段，来自 report_fields 表）
    hasStatusColumn: false,   // 数据库是否支持 project_status 列（旧库未执行 SQL 时降级）
    projectTab: 'active',     // 项目视角下的列表：'active' 在建 | 'completed' 已完工
    noFieldConfirmed: false,  // 当前月本部门是否已确认"无野外施工项目"（视同 0 填报）
    noFieldInfo: null,        // 确认记录详情（confirmed_at 等）
  },

  /**
   * 项目类型默认值（数据库配置未就绪时的兜底，保证系统不因缺表而崩溃）
   */
  DEFAULT_PROJECT_TYPES: [
    '房屋建筑工程', '市政公用工程', '公路工程', '水利工程',
    '电力工程', '通信工程', '机电安装工程', '装饰装修工程',
    '园林绿化工程', '环保工程', '钢结构工程', '基础设施工程', '其他'
  ],

  /**
   * 加载报送表单配置（项目类型 + 报送字段）
   * 无论 report_fields 查询成功与否，都归一化出完整的字段列表：
   *  - 查询成功（新库含 is_builtin 种子）→ 用库中配置
   *  - 查询失败 / 表不存在 / 旧库无 is_builtin 标记 → 内置字段用 Utils.DEFAULT_REPORT_FIELDS 静态兜底
   * 保证报送表单永远能渲染出全部内置字段，不会出现"只能改年份月份"的情况
   */
  async loadFormConfig() {
    try {
      const [typesRes, fieldsRes, statusProbe] = await Promise.all([
        sb.from('project_types').select('*').order('sort_order'),
        sb.from('report_fields').select('*').order('sort_order'),
        // 探测 project_status 列是否存在（旧库未执行 project-status.sql 时该列不存在，
        // 前端自动降级：表单不显示状态、列表不区分在建/完工，报送功能不受影响）
        sb.from('project_reports').select('project_status').limit(1)
      ]);
      if (!typesRes.error) {
        this.state.projectTypes = (typesRes.data || []).filter(t => t.is_active !== false);
      }
      // 查询出错时按空数据处理 → normalizeReportFields 自动用内置字段兜底
      const fieldsRaw = fieldsRes.error ? [] : (fieldsRes.data || []);
      this.state.formFields = Utils.normalizeReportFields(fieldsRaw);
      // 列探测：无错误即视为支持（返回空数组也是支持，说明列存在）
      this.state.hasStatusColumn = !statusProbe.error;
    } catch (e) {
      console.warn('加载报送表单配置失败，使用默认配置:', e);
      this.state.formFields = Utils.normalizeReportFields([]);
    }
  },

  /**
   * 渲染报送仪表盘
   * @param {HTMLElement} container
   */
  async render(container) {
    const profile = Auth.currentProfile;
    this.state.departmentId = profile.department_id;
    this.state.departmentName = profile.departments ? profile.departments.name : '';
    this.state.fullName = profile.full_name || '';
    const rawEmail = profile.email || '';
    // 占位邮箱（以手机号登录）不展示，避免暴露系统内部地址
    this.state.email = (typeof rawEmail === 'string' && rawEmail.endsWith('@login.local')) ? '' : rawEmail;

    const ym = Utils.getCurrentYearMonth();
    this.state.year = ym.year;
    // 默认显示当前年度全部月份的报送记录（含当月/上月），避免"默认看不到历史列表"；
    // 用户仍可通过工具栏筛选到具体月份
    this.state.month = null;

    container.innerHTML = this.buildHTML();
    this.bindEvents(container);
    await this.loadFormConfig();
    await this.loadReports();
    await this.loadNoFieldStatus();
  },

  /**
   * 事件绑定占位：所有交互均通过 HTML 内联 onchange/onclick 完成
   * （与 admin.js 的 bindEvents 一致）；此方法必须存在，否则 render() 会中断，
   * 导致列表与表单配置无法加载
   */
  bindEvents() { /* 事件绑定在 buildHTML 的内联事件中已完成 */ },

  /**
   * 构建 HTML 结构
   */
  buildHTML() {
    return `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildToolbar()}
          <div id="no-field-banner"></div>
          <div id="reports-section"></div>
        </div>
      </div>
    `;
  },

  /**
   * 顶部导航栏
   */
  buildHeader() {
    const name = this.state.fullName || this.state.email || '用户';
    return `
      <div class="dashboard-header">
        <div class="header-left">
          <h1>野外施工项目报送</h1>
          <span class="badge badge-muted">${Utils.escapeHtml(this.state.departmentName)}</span>
        </div>
        <div class="header-right">
          <div class="user-info">
            <span class="user-name">${Utils.escapeHtml(name)}</span>
          </div>
          <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
          <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
        </div>
      </div>
    `;
  },

  /**
   * 工具栏：月份选择（支持"全部月份"查看历史）+ 搜索 + 新建按钮
   */
  buildToolbar() {
    const years = Utils.getYearOptions();
    const months = Utils.getMonthOptions();
    return `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>报送年份：</label>
          <select id="filter-year" onchange="Reporter.onMonthChange()">
            ${years.map(y => `<option value="${y}" ${y === this.state.year ? 'selected' : ''}>${y}年</option>`).join('')}
          </select>
          <label>月份：</label>
          <select id="filter-month" onchange="Reporter.onMonthChange()">
            <option value="">全部月份</option>
            ${months.map(m => `<option value="${m}" ${m === this.state.month ? 'selected' : ''}>${m}月</option>`).join('')}
          </select>
          <span class="toolbar-hint">选择"全部月份"可查看年度内全部历史报送</span>
        </div>
        <div class="toolbar-right">
          <input type="search" id="report-search" class="toolbar-search" placeholder="搜索项目名称/类型/地点" oninput="Reporter.onSearch()">
          <button class="btn btn-primary" onclick="Reporter.showReportForm()">+ 新建项目报送</button>
        </div>
      </div>
    `;
  },

  /**
   * 月份切换（month 为 null 表示查看该年全部月份的历史报送）
   */
  onMonthChange() {
    this.state.year = parseInt(document.getElementById('filter-year').value);
    const mVal = document.getElementById('filter-month').value;
    this.state.month = mVal === '' ? null : parseInt(mVal);
    this.loadReports();
  },

  /**
   * 当前筛选周期的标题文案
   */
  getPeriodTitle() {
    const { year, month } = this.state;
    return month ? `${year}年${month}月报送记录` : `${year}年历史报送记录`;
  },

  /**
   * 加载报送记录（按当前筛选条件；month 为 null 时不限定月份）
   */
  async loadReports() {
    const section = document.getElementById('reports-section');
    if (!section) return;

    const title = this.getPeriodTitle();
    section.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>${title}</h2></div>
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;

    let query = sb
      .from('project_reports')
      .select('*')
      .eq('department_id', this.state.departmentId)
      .eq('reporting_year', this.state.year);
    if (this.state.month) {
      query = query.eq('reporting_month', this.state.month);
    }
    const { data, error } = await query.order('submitted_at', { ascending: false });

    if (error) {
      Utils.toast('加载报送记录失败: ' + error.message, 'error');
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>${title}</h2></div>
          <div class="card-body"><div class="alert alert-danger">加载失败：${Utils.escapeHtml(error.message)}</div></div>
        </div>
      `;
      return;
    }

    this.state.reports = data || [];
    this.renderReports();
  },

  /**
   * 加载当前月本部门「无野外施工项目」确认状态
   * 读取当前年/月本部门在 department_month_status 中的记录（RLS 仅可见本部门）
   */
  async loadNoFieldStatus() {
    const ym = Utils.getCurrentYearMonth();
    try {
      const { data, error } = await sb
        .from('department_month_status')
        .select('*')
        .eq('department_id', this.state.departmentId)
        .eq('reporting_year', ym.year)
        .eq('reporting_month', ym.month)
        .limit(1);
      if (!error && data && data.length) {
        this.state.noFieldInfo = data[0];
        this.state.noFieldConfirmed = !!data[0].no_field_projects;
      } else {
        this.state.noFieldInfo = null;
        this.state.noFieldConfirmed = false;
      }
    } catch (e) {
      // 旧库未执行 no-field-projects.sql 时降级：不展示该功能
      this.state.noFieldInfo = null;
      this.state.noFieldConfirmed = false;
    }
    this.renderNoFieldBanner();
  },

  /**
   * 渲染「无野外施工项目」横幅（按钮 / 已确认提示）
   */
  renderNoFieldBanner() {
    const el = document.getElementById('no-field-banner');
    if (!el) return;
    const ym = Utils.getCurrentYearMonth();

    if (this.state.noFieldConfirmed) {
      const time = this.state.noFieldInfo && this.state.noFieldInfo.confirmed_at
        ? Utils.formatDateTime(this.state.noFieldInfo.confirmed_at)
        : '';
      el.innerHTML = `
        <div class="alert alert-info no-field-banner-confirmed">
          <span class="nfb-icon">✅</span>
          <span class="nfb-text">已确认：<strong>${ym.year}年${ym.month}月</strong>无正在野外施工的项目，视同 0 填报。管理员可同步查看。${time ? `（确认时间：${Utils.escapeHtml(time)}）` : ''}</span>
          <button class="btn btn-sm btn-secondary nfb-btn" onclick="Reporter.clearNoField()">撤销确认</button>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div class="no-field-banner">
          <span class="nfb-hint">本月（${ym.year}年${ym.month}月）如确实没有正在野外施工的项目，可一键确认，视同 0 填报：</span>
          <button class="btn btn-sm btn-primary nfb-btn" onclick="Reporter.confirmNoField()">本月无野外施工项目</button>
        </div>
      `;
    }
  },

  /**
   * 确认本月无野外施工项目
   */
  async confirmNoField() {
    const ym = Utils.getCurrentYearMonth();
    if (!confirm(`确认 ${ym.year}年${ym.month}月 无正在野外施工的项目？\n提交后将视同 0 填报，管理员可在报送状态中同步查看。\n后续如有项目，可随时重新报送并撤销此确认。`)) {
      return;
    }
    const { error } = await sb.rpc('upsert_dept_no_field_status', {
      p_department_id: this.state.departmentId,
      p_year: ym.year,
      p_month: ym.month,
      p_no_field: true,
    });
    if (error) {
      Utils.toast('确认失败: ' + error.message, 'error');
      return;
    }
    Utils.toast('已确认本月无野外施工项目（视同 0 填报）', 'success');
    await this.loadNoFieldStatus();
  },

  /**
   * 撤销"无野外施工项目"确认
   */
  async clearNoField() {
    const ym = Utils.getCurrentYearMonth();
    if (!confirm(`撤销 ${ym.year}年${ym.month}月 的"无野外施工项目"确认？\n撤销后该月将重新视为"未报送"，直到提交实际项目报送。`)) {
      return;
    }
    const { error } = await sb.rpc('upsert_dept_no_field_status', {
      p_department_id: this.state.departmentId,
      p_year: ym.year,
      p_month: ym.month,
      p_no_field: false,
    });
    if (error) {
      Utils.toast('撤销失败: ' + error.message, 'error');
      return;
    }
    Utils.toast('已撤销确认', 'success');
    await this.loadNoFieldStatus();
  },

  /**
   * 渲染报送记录
   * - 月份 = 全部（默认）：项目视角，按项目归并历史报送，区分在建/已完工，支持历史对比
   * - 月份 = 具体：报送明细视图，展示该月每条报送记录（保留查看/编辑/删除）
   */
  renderReports() {
    const section = document.getElementById('reports-section');
    if (!section) return;
    if (!this.state.month) return this.renderProjectView();
    return this.renderRecordsView();
  },

  /**
   * 报送明细视图（具体月份）：统计卡片 + 表格，支持关键字过滤
   * 列由字段配置动态生成：关键内置字段 + 管理员自定义字段
   */
  renderRecordsView() {
    const section = document.getElementById('reports-section');
    if (!section) return;

    const title = this.getPeriodTitle();
    const keyword = this.getSearchKeyword();
    const reports = this.state.reports.filter(r => this.matchKeyword(r, keyword));

    // 无任何报送记录
    if (this.state.reports.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2>${title}</h2>
          </div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📝</div>
              <p>${this.state.month ? '本月暂无报送记录' : '该年度暂无报送记录'}</p>
              <p style="margin-top:8px;">
                <button class="btn btn-primary" onclick="Reporter.showReportForm()">+ 新建项目报送</button>
              </p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    // 搜索无匹配结果
    if (reports.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>${title}</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <p>未找到与「${Utils.escapeHtml(keyword)}」匹配的报送记录</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    // 统计信息
    const totalAmount = reports.reduce((sum, r) => sum + Number(r.contract_amount || 0), 0);
    const totalPersonnel = reports.reduce((sum, r) => sum + (r.on_site_personnel || 0), 0);
    const hasHazards = reports.filter(r => r.safety_hazards).length;

    // 动态列：自定义字段（启用的）+ 全部月份时显示"报送月份"列
    const customFields = this.state.formFields.filter(f => !f.is_builtin);
    const showMonthCol = !this.state.month;

    section.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">${this.state.month ? '本月报送项目数' : '年度报送项目数'}</div>
          <div class="stat-value">${reports.length}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">合同总额（万元）</div>
          <div class="stat-value">${totalAmount.toLocaleString('zh-CN', {maximumFractionDigits: 2})}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">${this.state.month ? '现场总人数' : '累计现场人数'}</div>
          <div class="stat-value">${totalPersonnel}</div>
        </div>
        <div class="stat-card ${hasHazards > 0 ? 'danger' : 'success'}">
          <div class="stat-label">安全隐患项目</div>
          <div class="stat-value">${hasHazards}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h2>${title}</h2>
          <span class="toolbar-hint">共 ${reports.length} 条${keyword ? `（匹配「${Utils.escapeHtml(keyword)}」）` : ''}</span>
        </div>
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>项目名称</th>
                  <th>项目类型</th>
                  <th>施工地点</th>
                  <th>合同额(万元)</th>
                  ${customFields.map(f => `<th>${Utils.escapeHtml(f.label)}</th>`).join('')}
                  ${showMonthCol ? '<th>报送月份</th>' : ''}
                  ${this.state.hasStatusColumn ? '<th>项目状态</th>' : ''}
                  <th>报送时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${reports.map(r => this.renderReportRow(r, customFields, showMonthCol)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  // ========================================================================
  // 项目视角（按月报送的日常场景：按项目归并历史，直观对比每月状态变化）
  // ========================================================================

  /**
   * 按项目归并报送记录（部门内 项目名称+施工地点 唯一标识一个项目）
   * 每组按报送年月倒序，latest 为最近一次报送；返回 [{key,name,location,latest,history,count,status,completedAt}]
   */
  groupReportsByProject(reports) {
    const map = new Map();
    for (const r of reports) {
      const key = String(r.project_name || '未命名项目') + '|' + String(r.construction_location || '');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const projects = [];
    for (const [key, list] of map.entries()) {
      list.sort((a, b) =>
        (b.reporting_year - a.reporting_year) ||
        (b.reporting_month - a.reporting_month) ||
        (new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0))
      );
      const latest = list[0];
      projects.push({
        key,
        name: latest.project_name,
        location: latest.construction_location,
        latest,
        history: list,
        count: list.length,
        status: latest.project_status || 'active',
        completedAt: latest.project_status === 'completed'
          ? `${latest.reporting_year}年${latest.reporting_month}月` : null,
      });
    }
    projects.sort((a, b) =>
      (b.latest.reporting_year - a.latest.reporting_year) ||
      (b.latest.reporting_month - a.latest.reporting_month)
    );
    return projects;
  },

  /**
   * 项目状态徽章
   */
  statusBadge(status) {
    return status === 'completed'
      ? '<span class="badge badge-info">已完工</span>'
      : '<span class="badge badge-success">在建</span>';
  },

  /**
   * 转义单引号（用于拼接到 HTML 内联 onclick 参数中）
   */
  esc(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  },

  /**
   * 项目视角渲染（月份 = 全部）：在建 / 已完工项目列表 + 统计卡
   */
  renderProjectView() {
    const section = document.getElementById('reports-section');
    if (!section) return;

    const title = this.getPeriodTitle();
    const keyword = this.getSearchKeyword();
    const projects = this.groupReportsByProject(this.state.reports)
      .filter(p => this.matchKeyword(p.latest, keyword));

    // 无任何报送记录
    if (this.state.reports.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>${title}</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📝</div>
              <p>${this.state.month ? '本月暂无报送记录' : '该年度暂无报送记录'}</p>
              <p style="margin-top:8px;">
                <button class="btn btn-primary" onclick="Reporter.showReportForm()">+ 新建项目报送</button>
              </p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    // 搜索无匹配
    if (projects.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>${title}</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <p>未找到与「${Utils.escapeHtml(keyword)}」匹配的项目</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const hasStatus = this.state.hasStatusColumn;
    const activeProjects = projects.filter(p => p.status !== 'completed');
    const completedProjects = projects.filter(p => p.status === 'completed');
    // 未执行 SQL（无状态列）时只有"在建"列表（即全部项目）
    const tab = (hasStatus && this.state.projectTab === 'completed') ? 'completed' : 'active';
    const list = tab === 'completed' ? completedProjects : activeProjects;

    // 统计卡（在建项目的合同总额 / 现场总人数）
    const totalAmount = activeProjects.reduce((s, p) => s + Number(p.latest.contract_amount || 0), 0);
    const totalPersonnel = activeProjects.reduce((s, p) => s + (p.latest.on_site_personnel || 0), 0);

    const tabTpl = hasStatus ? `
        <div class="card-body project-tabs-wrap">
          <div class="project-tabs">
            <button class="chip ${tab === 'active' ? 'active' : ''}" onclick="Reporter.switchProjectTab('active')">
              在建项目 <span class="chip-count">${activeProjects.length}</span>
            </button>
            <button class="chip ${tab === 'completed' ? 'active' : ''}" onclick="Reporter.switchProjectTab('completed')">
              已完工项目 <span class="chip-count">${completedProjects.length}</span>
            </button>
          </div>
        </div>` : '';

    section.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">在建项目数</div>
          <div class="stat-value">${activeProjects.length}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">在建合同总额（万元）</div>
          <div class="stat-value">${totalAmount.toLocaleString('zh-CN', {maximumFractionDigits: 2})}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">现场总人数</div>
          <div class="stat-value">${totalPersonnel}</div>
        </div>
        ${hasStatus ? `
        <div class="stat-card ${completedProjects.length > 0 ? 'success' : ''}">
          <div class="stat-label">已完工项目</div>
          <div class="stat-value">${completedProjects.length}</div>
        </div>` : ''}
      </div>
      <div class="card">
        <div class="card-header">
          <h2>${tab === 'completed' ? '已完工项目' : '在建项目'}（${this.state.year}年）</h2>
          <span class="toolbar-hint">共 ${list.length} 个${keyword ? `（匹配「${Utils.escapeHtml(keyword)}」）` : ''}</span>
        </div>
        ${tabTpl}
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>项目名称</th>
                  <th>项目类型</th>
                  <th>施工地点</th>
                  <th>合同额(万元)</th>
                  <th>现场人数</th>
                  <th>项目进度</th>
                  <th>最近报送</th>
                  ${hasStatus ? '<th>项目状态</th>' : ''}
                  <th>报送次数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${list.length === 0 ? `
                  <tr class="empty-row">
                    <td colspan="${hasStatus ? 10 : 9}">${tab === 'completed' ? '暂无已完工项目' : '暂无在建项目，点击右上角「+ 新建项目报送」创建'}</td>
                  </tr>
                ` : list.map(p => this.renderProjectRow(p)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 渲染项目视角单行（取该项目最近一次报送）
   */
  renderProjectRow(p) {
    const r = p.latest;
    const progress = r.overall_progress || '';
    return `
      <tr>
        <td><strong>${Utils.escapeHtml(r.project_name)}</strong></td>
        <td>${Utils.escapeHtml(r.project_type)}</td>
        <td>${Utils.escapeHtml(r.construction_location)}</td>
        <td>${Utils.formatAmount(r.contract_amount)}</td>
        <td>${r.on_site_personnel ?? '-'}</td>
        <td class="cell-ellipsis" title="${Utils.escapeHtml(progress)}">${Utils.escapeHtml(progress) || '-'}</td>
        <td style="white-space:nowrap;">${r.reporting_year}年${r.reporting_month}月</td>
        ${this.state.hasStatusColumn ? `<td>${this.statusBadge(r.project_status)}</td>` : ''}
        <td>${p.count > 1 ? `<span class="badge badge-info" title="${p.count} 次月度报送">${p.count} 次</span>` : p.count}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportDetail('${r.id}')">查看</button>
          <button class="btn btn-secondary btn-sm" onclick="Reporter.showHistoryCompare('${this.esc(r.project_name)}', '${this.esc(r.construction_location)}')">历史对比</button>
          <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportForm('${r.id}')">编辑</button>
        </td>
      </tr>
    `;
  },

  /**
   * 项目视角 tab 切换（在建 / 已完工）
   */
  switchProjectTab(tab) {
    this.state.projectTab = tab;
    this.renderReports();
  },

  /**
   * 历史对比弹窗：同一项目各月份报送的关键字段逐月对比，数值变化用 ▲▼ 标注
   */
  showHistoryCompare(name, location) {
    const history = this.state.reports
      .filter(r => r.project_name === name && (r.construction_location || '') === location)
      .sort((a, b) => (a.reporting_year - b.reporting_year) || (a.reporting_month - b.reporting_month));
    if (history.length === 0) {
      Utils.toast('未找到该项目的报送记录', 'error');
      return;
    }

    // 数值较上月变化标注
    const diffHTML = (cur, prev) => {
      if (cur == null || prev == null || cur === '' || prev === '') return '';
      const c = Number(cur), p = Number(prev);
      if (isNaN(c) || isNaN(p) || c === p) return '<span class="trend-flat">→</span>';
      const delta = c - p;
      return delta > 0
        ? `<span class="trend-up" title="较上月 +${delta}">▲${delta}</span>`
        : `<span class="trend-down" title="较上月 ${delta}">▼${Math.abs(delta)}</span>`;
    };
    const statusCell = this.state.hasStatusColumn ? '<th>状态</th>' : '';
    const statusVal = (r) => this.state.hasStatusColumn
      ? `<td>${this.statusBadge(r.project_status)}</td>` : '';

    const modalHTML = `
      <div class="modal-overlay" id="history-modal" onclick="Reporter.onModalOverlayClick(event, 'history-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>历史对比：${Utils.escapeHtml(name)}（共 ${history.length} 次报送）</h2>
            <button class="modal-close" onclick="Reporter.closeHistoryModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="table-wrapper has-scroll">
              <table class="data-table compare-table">
                <thead>
                  <tr>
                    <th>报送月份</th>
                    ${statusCell}
                    <th>现场人数</th>
                    <th>现场车辆</th>
                    <th>合同额(万元)</th>
                    <th>安全自检</th>
                    <th>安全隐患</th>
                    <th>项目进度</th>
                    <th>本月施工情况</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${history.map((r, i) => {
                    const prev = i > 0 ? history[i - 1] : null;
                    return `
                    <tr>
                      <td style="white-space:nowrap;"><strong>${r.reporting_year}年${r.reporting_month}月</strong></td>
                      ${statusVal(r)}
                      <td>${r.on_site_personnel ?? '-'} ${diffHTML(r.on_site_personnel, prev ? prev.on_site_personnel : null)}</td>
                      <td>${r.on_site_vehicles ?? '-'} ${diffHTML(r.on_site_vehicles, prev ? prev.on_site_vehicles : null)}</td>
                      <td>${Utils.formatAmount(r.contract_amount)}</td>
                      <td>${r.safety_inspection ? '<span class="badge badge-success">已自检</span>' : '<span class="badge badge-danger">未自检</span>'}</td>
                      <td>${r.safety_hazards ? '<span class="badge badge-danger">有隐患</span>' : '<span class="badge badge-success">无</span>'}</td>
                      <td class="cell-ellipsis" title="${Utils.escapeHtml(r.overall_progress || '')}">${Utils.escapeHtml(r.overall_progress) || '-'}</td>
                      <td class="cell-ellipsis" title="${Utils.escapeHtml(r.monthly_construction_status || '')}">${Utils.escapeHtml(r.monthly_construction_status) || '-'}</td>
                      <td style="white-space:nowrap;">
                        <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportDetail('${r.id}')">查看</button>
                        <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportForm('${r.id}')">编辑</button>
                      </td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
            <p class="hint" style="margin-top:8px;">▲▼ 表示该数字相对上月的变化量；悬停列可查看被截断的完整内容。</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Reporter.closeHistoryModal()">关闭</button>
            <button class="btn btn-primary" onclick="Reporter.editLatestOf('${this.esc(name)}', '${this.esc(location)}')">编辑最近一次报送</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('history-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 关闭历史对比弹窗
   */
  closeHistoryModal() {
    const modal = document.getElementById('history-modal');
    if (modal) modal.remove();
  },

  /**
   * 编辑项目最近一次报送（从历史对比弹窗进入）
   */
  editLatestOf(name, location) {
    const list = this.state.reports
      .filter(r => r.project_name === name && (r.construction_location || '') === location)
      .sort((a, b) => (b.reporting_year - a.reporting_year) || (b.reporting_month - a.reporting_month));
    if (list.length === 0) return;
    this.closeHistoryModal();
    this.showReportForm(list[0].id);
  },

  /**
   * 读取搜索关键字
   */
  getSearchKeyword() {
    const el = document.getElementById('report-search');
    return el ? el.value.trim().toLowerCase() : '';
  },

  /**
   * 判断记录是否匹配搜索关键字（项目名称/类型/施工地点）
   */
  matchKeyword(r, kw) {
    if (!kw) return true;
    return ['project_name', 'project_type', 'construction_location']
      .some(k => r[k] != null && String(r[k]).toLowerCase().includes(kw));
  },

  /**
   * 搜索框输入
   */
  onSearch() {
    this.renderReports();
  },

  /**
   * 渲染单行报送记录（动态列）
   */
  renderReportRow(r, customFields, showMonthCol) {
    return `
      <tr>
        <td>${Utils.escapeHtml(r.project_name)}</td>
        <td>${Utils.escapeHtml(r.project_type)}</td>
        <td>${Utils.escapeHtml(r.construction_location)}</td>
        <td>${Utils.formatAmount(r.contract_amount)}</td>
        ${customFields.map(f => {
          const val = (r.custom_data && r.custom_data[f.field_key] != null) ? r.custom_data[f.field_key] : '';
          return `<td>${Utils.escapeHtml(val)}</td>`;
        }).join('')}
        ${showMonthCol ? `<td>${r.reporting_year}年${r.reporting_month}月</td>` : ''}
        ${this.state.hasStatusColumn ? `<td>${this.statusBadge(r.project_status)}</td>` : ''}
        <td style="white-space:nowrap;">${Utils.formatDateTime(r.submitted_at)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportDetail('${r.id}')">查看</button>
          <button class="btn btn-secondary btn-sm" onclick="Reporter.showReportForm('${r.id}')">编辑</button>
          <button class="btn btn-danger btn-sm" onclick="Reporter.handleDelete('${r.id}')">删除</button>
        </td>
      </tr>
    `;
  },

  /**
   * 显示报送表单（新建或编辑）
   */
  async showReportForm(reportId = null) {
    this.state.editingId = reportId;

    let report = null;
    if (reportId) {
      report = this.state.reports.find(r => r.id === reportId);
      if (!report) {
        Utils.toast('未找到该报送记录', 'error');
        return;
      }
    }

    // 字段分组：内置字段（基本信息区）+ 自定义字段（附加数据区）
    // 防御兜底：formFields 意外为空时用内置字段静态定义，保证表单永远完整可填
    const fields = this.state.formFields.length > 0
      ? this.state.formFields
      : Utils.normalizeReportFields([]);
    const builtinFields = fields.filter(f => f.is_builtin);
    const customFields = fields.filter(f => !f.is_builtin);

    // 表单默认值
    const v = report || {};
    const ym = Utils.getCurrentYearMonth();
    const defYear = v.reporting_year || ym.year;
    const defMonth = v.reporting_month || ym.month;
    // 编辑标题附带报送月份，方便定位历史记录
    const editTitle = reportId && report
      ? `编辑项目报送（${report.reporting_year}年${report.reporting_month}月）`
      : '新建项目报送';

    // 基本信息区（内置字段，完全由管理员配置驱动）
    const builtinHTML = this.buildFieldSectionHTML(builtinFields, report);
    // 附加数据区（管理员自定义字段）
    const customHTML = customFields.length > 0 ? `
                <div class="form-group col-span-2 form-section-divider">
                  附加数据<span class="hint" style="margin-left:8px;font-weight:400;">（由管理员在「报送配置」中定义）</span>
                </div>
                ${this.buildFieldSectionHTML(customFields, report)}
    ` : '';

    const modalHTML = `
      <div class="modal-overlay" id="report-modal" onclick="Reporter.onModalOverlayClick(event, 'report-modal')">
        <div class="modal-card">
          <div class="modal-header">
            <h2>${editTitle}</h2>
            <button class="modal-close" onclick="Reporter.closeModal()">&times;</button>
          </div>
          <div class="modal-body">
            <form id="report-form" onsubmit="return false">
              <div class="form-grid">
                ${builtinHTML}
                ${customHTML}
                ${this.state.hasStatusColumn ? `
                <div class="form-group">
                  <label>项目状态 <span class="required">*</span></label>
                  <select name="project_status" required>
                    <option value="active" ${(v.project_status || 'active') !== 'completed' ? 'selected' : ''}>在建</option>
                    <option value="completed" ${v.project_status === 'completed' ? 'selected' : ''}>已完工</option>
                  </select>
                  <p class="hint">标记「已完工」后，项目将自动归入完工项目列表</p>
                </div>` : ''}
                <div class="form-group">
                  <label>报送年份 <span class="required">*</span></label>
                  <select name="reporting_year" required>
                    ${Utils.getYearOptions().map(y => `<option value="${y}" ${y === defYear ? 'selected' : ''}>${y}年</option>`).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>报送月份 <span class="required">*</span></label>
                  <select name="reporting_month" required>
                    ${Utils.getMonthOptions().map(m => `<option value="${m}" ${m === defMonth ? 'selected' : ''}>${m}月</option>`).join('')}
                  </select>
                </div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Reporter.closeModal()">取消</button>
            <button class="btn btn-primary" onclick="Reporter.handleSubmit()">${reportId ? '保存修改' : '提交报送'}</button>
          </div>
        </div>
      </div>
    `;

    // 移除已有模态框
    const existing = document.getElementById('report-modal');
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 生成一组字段的表单控件 HTML（内置字段 / 自定义字段通用）
   * @param {Array} fields 字段配置列表
   * @param {Object|null} report 正在编辑的报送记录
   */
  buildFieldSectionHTML(fields, report) {
    if (!fields || fields.length === 0) return '';
    return fields.map(f => this.buildFieldControlHTML(f, report)).join('');
  },

  /**
   * 生成单个字段的表单控件 HTML
   * 内置字段 name = 数据库列名，值读记录列；自定义字段 name = cf_字段key，值读 custom_data
   * @param {Object} f 字段配置
   * @param {Object|null} report 正在编辑的报送记录
   */
  buildFieldControlHTML(f, report) {
    const v = report || {};
    const isBuiltin = !!f.is_builtin;

    // 字段值：内置读列，自定义读 custom_data
    let val;
    if (isBuiltin) {
      val = v[f.field_key];
    } else {
      val = (v.custom_data && v.custom_data[f.field_key] != null) ? v.custom_data[f.field_key] : '';
    }

    // 项目归属部门或实体：新建时默认填充登录部门（账号可手动修改）；编辑时保留已填值，空值兜底
    if (f.field_key === 'department_entity' && (!report || !val)) {
      val = this.state.departmentName || '';
    }

    const name = isBuiltin ? f.field_key : `cf_${f.field_key}`;
    const reqMark = f.is_required ? ' <span class="required">*</span>' : '';
    const requiredAttr = f.is_required ? ' required' : '';
    const placeholder = f.is_required
      ? `请输入${Utils.escapeHtml(f.label)}`
      : `（选填）请输入${Utils.escapeHtml(f.label)}`;

    // 占整行（2 列）的字段：多行文本 + 名称/联系方式等长字段
    const wide = (f.field_type === 'textarea'
      || f.field_key === 'project_name'
      || f.field_key === 'contact_info'
      || f.field_key === 'safety_hazard_detail'
      || f.field_key === 'equipment_models') ? ' col-span-2' : '';

    let control = '';
    switch (f.field_type) {
      case 'number': {
        const min = f.field_key === 'duration_months' ? ' min="1"' : ' min="0"';
        control = `<input type="number" name="${name}" value="${Utils.escapeHtml(val)}" step="0.01"${min}${requiredAttr} placeholder="${placeholder}">`;
        break;
      }
      case 'textarea':
        control = `<textarea name="${name}" rows="${f.field_key === 'monthly_construction_status' ? 3 : 2}"${requiredAttr} placeholder="${placeholder}">${Utils.escapeHtml(val)}</textarea>`;
        break;
      case 'select': {
        // 项目类型特殊：选项来自 project_types 配置表
        const options = f.field_key === 'project_type'
          ? (this.state.projectTypes.length > 0
              ? this.state.projectTypes.map(t => t.name)
              : this.DEFAULT_PROJECT_TYPES)
          : (Array.isArray(f.options) ? f.options : []);
        // 布尔字段（安全自检/安全隐患）：值 true/false → 是/否
        const isBoolField = f.field_key === 'safety_inspection' || f.field_key === 'safety_hazards';
        const selVal = isBoolField ? (val === true ? '是' : '否') : val;
        const onChange = f.field_key === 'safety_hazards' ? ' onchange="Reporter.onHazardChange()"' : '';
        const opts = options.map(o =>
          `<option value="${Utils.escapeHtml(o)}" ${String(selVal) === String(o) ? 'selected' : ''}>${Utils.escapeHtml(o)}</option>`
        ).join('');
        control = `<select name="${name}"${requiredAttr}${onChange}><option value="">-- 请选择 --</option>${opts}</select>`;
        break;
      }
      case 'date':
        control = `<input type="date" name="${name}" value="${Utils.escapeHtml(val)}"${requiredAttr}>`;
        break;
      default:
        control = `<input type="text" name="${name}" value="${Utils.escapeHtml(val)}"${requiredAttr} placeholder="${placeholder}">`;
    }

    // 安全隐患详情：跟随"是否存在安全隐患"联动显示
    const isHazardDetail = f.field_key === 'safety_hazard_detail';
    const hazardStyle = isHazardDetail
      ? ` style="${v.safety_hazards === true ? '' : 'display:none;'}" id="hazard-detail-group"`
      : '';

    return `
        <div class="form-group${wide}"${hazardStyle}>
          <label>${Utils.escapeHtml(f.label)}${reqMark}</label>
          ${control}
        </div>
      `;
  },

  /**
   * 安全隐患选择变化：联动显示/隐藏隐患详情
   */
  onHazardChange() {
    const sel = document.querySelector('select[name="safety_hazards"]');
    const group = document.getElementById('hazard-detail-group');
    if (!group) return;
    if (sel && sel.value === '是') {
      group.style.display = '';
    } else {
      group.style.display = 'none';
    }
  },

  /**
   * 模态框遮罩点击关闭（区分表单弹窗 / 详情弹窗 / 历史对比弹窗）
   */
  onModalOverlayClick(event, modalId) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      if (modalId === 'report-detail-modal') {
        this.closeDetailModal();
      } else if (modalId === 'history-modal') {
        this.closeHistoryModal();
      } else {
        this.closeModal();
      }
    }
  },

  /**
   * 关闭模态框
   */
  closeModal() {
    const modal = document.getElementById('report-modal');
    if (modal) modal.remove();
    this.state.editingId = null;
  },

  /**
   * 查看报送详情（只读弹窗，展示全部配置字段 + 报送信息）
   * @param {string} id 报送记录 ID
   */
  showReportDetail(id) {
    const r = this.state.reports.find(x => x.id === id);
    if (!r) {
      Utils.toast('未找到该报送记录', 'error');
      return;
    }

    // 防御兜底：formFields 意外为空时用内置字段静态定义，保证详情弹窗完整
    const fields = this.state.formFields.length > 0
      ? this.state.formFields
      : Utils.normalizeReportFields([]);
    const builtinFields = fields.filter(f => f.is_builtin);
    const customFields = fields.filter(f => !f.is_builtin);

    const itemHTML = (f) => {
      const isBuiltin = !!f.is_builtin;
      const val = isBuiltin
        ? r[f.field_key]
        : (r.custom_data && r.custom_data[f.field_key] != null ? r.custom_data[f.field_key] : '');
      return `
        <div class="detail-item">
          <div class="detail-label">${Utils.escapeHtml(f.label)}</div>
          <div class="detail-value">${this.formatDetailValue(f, val)}</div>
        </div>
      `;
    };

    const modalHTML = `
      <div class="modal-overlay" id="report-detail-modal" onclick="Reporter.onModalOverlayClick(event, 'report-detail-modal')">
        <div class="modal-card">
          <div class="modal-header">
            <h2>报送详情（${r.reporting_year}年${r.reporting_month}月）</h2>
            <button class="modal-close" onclick="Reporter.closeDetailModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              ${builtinFields.map(itemHTML).join('')}
              ${customFields.length > 0 ? `
                <div class="detail-item col-span-2 form-section-divider">附加数据<span class="hint" style="margin-left:8px;font-weight:400;">（管理员自定义字段）</span></div>
                ${customFields.map(itemHTML).join('')}
              ` : ''}
              <div class="detail-item col-span-2 form-section-divider">报送信息</div>
              ${this.state.hasStatusColumn ? `
              <div class="detail-item">
                <div class="detail-label">项目状态</div>
                <div class="detail-value">${this.statusBadge(r.project_status)}</div>
              </div>` : ''}
              <div class="detail-item">
                <div class="detail-label">报送年份</div>
                <div class="detail-value">${r.reporting_year}年</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">报送月份</div>
                <div class="detail-value">${r.reporting_month}月</div>
              </div>
              <div class="detail-item">
                <div class="detail-label">报送时间</div>
                <div class="detail-value">${Utils.formatDateTime(r.submitted_at)}</div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Reporter.closeDetailModal()">关闭</button>
            <button class="btn btn-primary" onclick="Reporter.editFromDetail('${r.id}')">编辑此记录</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('report-detail-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 关闭详情弹窗
   */
  closeDetailModal() {
    const modal = document.getElementById('report-detail-modal');
    if (modal) modal.remove();
  },

  /**
   * 从详情弹窗进入编辑
   */
  editFromDetail(id) {
    this.closeDetailModal();
    this.showReportForm(id);
  },

  /**
   * 格式化详情展示值（布尔徽章 / 金额 / 多行文本 / 空值占位）
   */
  formatDetailValue(f, val) {
    if (val == null || val === '') return '<span class="detail-empty">—</span>';
    if (f.field_key === 'safety_inspection') {
      return val === true ? '<span class="badge badge-success">已自检</span>' : '<span class="badge badge-muted">未自检</span>';
    }
    if (f.field_key === 'safety_hazards') {
      return val === true ? '<span class="badge badge-danger">存在隐患</span>' : '<span class="badge badge-success">无</span>';
    }
    if (f.field_type === 'number') {
      return f.field_key === 'contract_amount' ? Utils.formatAmount(val) : String(Number(val));
    }
    if (f.field_type === 'textarea') {
      return `<div class="detail-text">${Utils.escapeHtml(val)}</div>`;
    }
    return Utils.escapeHtml(val);
  },

  /**
   * 表单验证（按字段配置动态校验必填项）
   */
  validateForm(formData) {
    const customData = formData.custom_data || {};

    for (const f of this.state.formFields) {
      if (!f.is_required) continue;

      let v;
      if (f.is_builtin) {
        v = formData[f.field_key];
      } else {
        v = customData[f.field_key];
      }

      // 安全隐患详情：仅当存在安全隐患（是）时必填
      if (f.field_key === 'safety_hazard_detail') {
        if (formData.safety_hazards === true && (v == null || v === '')) {
          return { valid: false, message: '存在安全隐患时需填写隐患详情' };
        }
        continue;
      }

      if (v == null || v === '') {
        return { valid: false, message: `请填写「${f.label}」` };
      }
    }

    return { valid: true };
  },

  /**
   * 提交表单
   */
  async handleSubmit() {
    const form = document.getElementById('report-form');
    const fd = new FormData(form);

    const data = {
      reporting_year: parseInt(fd.get('reporting_year')),
      reporting_month: parseInt(fd.get('reporting_month')),
    };
    // 项目状态（旧库未执行 project-status.sql、无此列时不写入，避免报错）
    if (this.state.hasStatusColumn) {
      data.project_status = fd.get('project_status') === 'completed' ? 'completed' : 'active';
    }

    // 活跃的内置字段 key 集合（停用的内置字段不在表单中，需补默认值防数据库 NOT NULL 报错）
    const activeBuiltinKeys = new Set(
      this.state.formFields.filter(f => f.is_builtin).map(f => f.field_key)
    );

    // 收集内置字段 → 写入 project_reports 固定列（类型转换 + 停用字段兜底默认值）
    for (const f of Utils.DEFAULT_REPORT_FIELDS) {
      const raw = activeBuiltinKeys.has(f.field_key) ? fd.get(f.field_key) : null;
      if (f.field_type === 'number') {
        data[f.field_key] = (raw == null || String(raw).trim() === '') ? 0 : Number(raw);
      } else if (f.field_key === 'safety_inspection' || f.field_key === 'safety_hazards') {
        data[f.field_key] = raw == null ? false : raw === '是';
      } else {
        data[f.field_key] = raw == null ? '' : String(raw).trim();
      }
    }
    // 安全隐患详情联动：无隐患时不记录详情
    data.safety_hazard_detail = data.safety_hazards
      ? (data.safety_hazard_detail || null)
      : null;

    // 收集自定义字段值（非空才写入，数字转数值类型）→ custom_data
    const customData = {};
    for (const f of this.state.formFields) {
      if (f.is_builtin) continue;
      const raw = fd.get(`cf_${f.field_key}`);
      if (raw == null) continue;
      const value = String(raw).trim();
      if (value === '') continue;
      customData[f.field_key] = f.field_type === 'number' ? Number(value) : value;
    }
    data.custom_data = Object.keys(customData).length > 0 ? customData : null;

    const validation = this.validateForm(data);
    if (!validation.valid) {
      Utils.toast(validation.message, 'error');
      return;
    }

    // 提交按钮禁用
    const submitBtn = document.querySelector('.modal-footer .btn-primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';
    }

    if (this.state.editingId) {
      // 编辑模式
      const { error } = await sb
        .from('project_reports')
        .update({
          ...data,
          submitted_by: Auth.currentUser.id,
          submitted_at: new Date().toISOString(),
        })
        .eq('id', this.state.editingId);

      if (error) {
        Utils.toast('保存失败: ' + error.message, 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '保存修改'; }
        return;
      }

      Utils.toast('报送记录已更新', 'success');
    } else {
      // 新建模式
      const { error } = await sb
        .from('project_reports')
        .insert({
          ...data,
          department_id: this.state.departmentId,
          submitted_by: Auth.currentUser.id,
        });

      if (error) {
        Utils.toast('提交失败: ' + error.message, 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '提交报送'; }
        return;
      }

      Utils.toast('报送成功', 'success');

      // 提交真实项目后，若此前确认过"无野外施工"，自动撤销该确认（视同 0 填报失效）
      const ymNf = Utils.getCurrentYearMonth();
      if (this.state.noFieldConfirmed
          && data.reporting_year === ymNf.year
          && data.reporting_month === ymNf.month) {
        await sb.rpc('upsert_dept_no_field_status', {
          p_department_id: this.state.departmentId,
          p_year: ymNf.year,
          p_month: ymNf.month,
          p_no_field: false,
        }).catch(() => {});
      }
    }

    // closeModal 会清空 editingId，先记录当前是否为编辑模式
    const isEditMode = !!this.state.editingId;
    this.closeModal();
    // 新建报送后自动切换到报送月份查看最新记录；编辑则保持进入前的筛选视图
    if (isEditMode) {
      // 保持当前筛选（项目视角或月份明细）
    } else {
      this.state.year = data.reporting_year;
      this.state.month = data.reporting_month;
      const yearSelect = document.getElementById('filter-year');
      const monthSelect = document.getElementById('filter-month');
      if (yearSelect) yearSelect.value = String(this.state.year);
      if (monthSelect) monthSelect.value = String(this.state.month);
    }

    await this.loadReports();
  },

  /**
   * 删除报送记录
   */
  async handleDelete(id) {
    if (!confirm('确定要删除这条报送记录吗？此操作不可撤销。')) return;

    const { error } = await sb
      .from('project_reports')
      .delete()
      .eq('id', id);

    if (error) {
      Utils.toast('删除失败: ' + error.message, 'error');
      return;
    }

    Utils.toast('报送记录已删除', 'success');
    await this.loadReports();
  },
};

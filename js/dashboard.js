/**
 * dashboard.js - 登录后工作台（首页）
 * 上方：个人待办事项；下方：九宫格功能导航（首个为本模块「野外施工项目报送」）
 */

const Dashboard = {

  /**
   * 渲染工作台首页
   */
  async render(container) {
    const profile = Auth.currentProfile || {};
    const name = profile.full_name || profile.email || '用户';
    const dept = Auth.getDepartmentName();
    const roleLabel = profile.role === 'admin' ? '管理员' : '部门用户';

    container.innerHTML = `
      <div class="dashboard dashboard-home">
        <div class="dashboard-header">
          <div class="header-left">
            <h1>安全生产管理系统</h1>
            <span class="badge badge-muted">${Utils.escapeHtml(dept)}</span>
          </div>
          <div class="header-right">
            <div class="user-info">
              <span class="user-name">${Utils.escapeHtml(name)}</span>
              <span class="badge badge-muted">${roleLabel}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>

        <div class="dashboard-content">
          <!-- 个人待办事项 -->
          <section class="home-section">
            <h2 class="section-title">个人待办事项</h2>
            <div id="todo-panel" class="todo-panel">
              <div class="todo-loading">加载中...</div>
            </div>
          </section>

          <!-- 功能导航九宫格 -->
          <section class="home-section">
            <h2 class="section-title">功能导航</h2>
            <div class="module-grid">
              ${this.buildGrid()}
            </div>
          </section>
        </div>
      </div>
    `;

    this.loadTodos();
  },

  /**
   * 九宫格：第一个为本模块（可使用），其余 8 个占位「待开发」
   */
  /**
   * 九宫格：从注册表读取全部模块；可用模块可进入，占位模块展示「建设中」页但仍可点击
   */
  buildGrid() {
    const modules = ModuleRegistry.list;

    return modules.map((m) => {
      const isPlaceholder = !m.ready;
      return `
        <div class="module-card ${isPlaceholder ? 'module-placeholder' : 'module-ready'}" onclick="App.openModule('${m.id}')">
          <div class="module-icon">${m.icon}</div>
          <div class="module-name">${Utils.escapeHtml(m.name)}</div>
          <div class="module-desc">${Utils.escapeHtml(m.desc)}</div>
          <span class="module-badge ${isPlaceholder ? 'badge-dev' : 'badge-ready'}">${isPlaceholder ? '建设中' : '可使用'}</span>
        </div>`;
    }).join('');
  },

  /**
   * 加载个人待办（按角色拉取真实数据）
   */
  async loadTodos() {
    const el = document.getElementById('todo-panel');
    if (!el) return;
    const profile = Auth.currentProfile;
    try {
      const { year, month } = Utils.getCurrentYearMonth();

      // 参与报送的部门（排除管理部门与子公司）
      const excluded = new Set(['安全生产部', '物化院有限公司', '六勘院有限公司']);

      if (profile && profile.role === 'admin') {
        const { data: depts } = await sb.from('departments').select('id, name, needs_report');
        // 需要报送的部门（needs_report 字段；旧库缺失时按名称兜底排除非报送部门）
        const hasFlag = (depts || []).some(d => 'needs_report' in d);
        const reportDepts = (depts || []).filter(d =>
          hasFlag ? d.needs_report !== false : !excluded.has(d.name));
        const { data: reps } = await sb
          .from('project_reports')
          .select('department_id')
          .eq('reporting_year', year)
          .eq('reporting_month', month);
        const reported = new Set((reps || []).map(r => r.department_id));
        // 已「确认无野外施工」的部门视同已报送，不计入未报送
        const { data: dms } = await sb
          .from('department_month_status')
          .select('department_id, no_field_projects')
          .eq('reporting_year', year)
          .eq('reporting_month', month);
        const noField = new Set(
          (dms || []).filter(x => x.no_field_projects && !reported.has(x.department_id)).map(x => x.department_id)
        );
        const submittedSet = new Set([...reported, ...noField]);
        const pending = reportDepts.filter(d => !submittedSet.has(d.id)).length;

        if (pending > 0) {
          el.innerHTML = `
            <div class="todo-item todo-warn">
              <span class="todo-dot"></span>
              <span>本月（${year}年${month}月）还有 <b>${pending}</b> 个部门尚未报送施工月报</span>
            </div>
            <div class="todo-actions">
              <button class="btn btn-primary btn-sm" onclick="App.openModule('report')">前往报送管理</button>
            </div>`;
        } else {
          el.innerHTML = `
            <div class="todo-item todo-ok">
              <span class="todo-dot"></span>
              <span>本月所有报送部门均已报送 ✓</span>
            </div>`;
        }
      } else {
        // 普通部门用户：本月是否已填报
        const deptId = profile && profile.department_id;
        let done = false;
        if (deptId) {
          const { data } = await sb
            .from('project_reports')
            .select('id')
            .eq('department_id', deptId)
            .eq('reporting_year', year)
            .eq('reporting_month', month);
          done = (data || []).length > 0;
        }
        if (done) {
          el.innerHTML = `
            <div class="todo-item todo-ok">
              <span class="todo-dot"></span>
              <span>您本月（${year}年${month}月）施工月报已报送 ✓</span>
            </div>`;
        } else {
          el.innerHTML = `
            <div class="todo-item todo-warn">
              <span class="todo-dot"></span>
              <span>您本月施工月报尚未报送，请尽快完成</span>
            </div>
            <div class="todo-actions">
              <button class="btn btn-primary btn-sm" onclick="App.openModule('report')">去填报</button>
            </div>`;
        }
      }
    } catch (e) {
      el.innerHTML = `<div class="todo-item todo-warn">待办信息加载失败：${Utils.escapeHtml(e.message || '未知错误')}</div>`;
    }
  },
};

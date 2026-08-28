// =============================================================
// js/modules/training.js —— 培训教育模块（骨架版）
// 分支：feature/training-module（仅 GitHub，未部署服务器）
//
// 当前阶段：UI 骨架。数据表（培训计划/培训记录/考试）尚未建立，
// 三个页签先以「待接入数据」空态呈现；后续迭代在此文件内逐步充实，
// 保持 render(app) 签名与 registry.js 中 TrainingModule 引用不变。
//
// 布局约定（与资质证照管理页一致）：
//   header-left   仅「← 返回上级菜单」
//   header-center 标题绝对居中
//   header-right  徽章 + 用户 + 账户设置 + 退出登录
// =============================================================
const TrainingModule = {

  state: {
    view: 'plans',        // 当前页签：plans | records | exams
  },

  TABS: [
    { key: 'plans',   label: '培训计划', desc: '年度/月度培训计划制定与审批跟踪' },
    { key: 'records', label: '培训记录', desc: '培训实施情况登记（时间/内容/学时/参训人员）' },
    { key: 'exams',   label: '考试管理', desc: '培训后考试成绩与合格率统计' },
  ],

  /**
   * 模块入口（registry.js 调用）
   */
  render(app) {
    const profile = Auth.currentProfile || {};
    this.state.userName = profile.full_name || profile.email || '用户';
    this.state.departmentName = Auth.getDepartmentName ? Auth.getDepartmentName() : '';

    app.innerHTML = `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildTabs()}
          <div id="training-section"></div>
        </div>
      </div>
    `;
    this.renderView();
  },

  /**
   * 顶部导航栏（三段式，与资质证照管理页一致）
   */
  buildHeader() {
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
            <span class="badge badge-muted">${Utils.escapeHtml(this.state.departmentName || '')}</span>
            <div class="user-info">
              <span class="user-name">${Utils.escapeHtml(this.state.userName)}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 页签栏（复用资质证照模块的 cat-tab 胶囊样式）
   */
  buildTabs() {
    return `
      <div class="cat-tabs" id="training-tabs">
        ${this.TABS.map(t => `
          <button type="button" class="cat-tab${this.state.view === t.key ? ' active' : ''}"
            data-view="${t.key}" onclick="TrainingModule.switchView('${t.key}')">${t.label}</button>
        `).join('')}
      </div>
    `;
  },

  /**
   * 切换页签
   */
  switchView(view) {
    this.state.view = view;
    const tabs = document.getElementById('training-tabs');
    if (tabs) {
      tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    }
    this.renderView();
  },

  /**
   * 渲染当前页签内容
   */
  renderView() {
    const box = document.getElementById('training-section');
    if (!box) return;
    const tab = this.TABS.find(t => t.key === this.state.view) || this.TABS[0];

    // 骨架阶段：统一空态。接入数据库后按页签替换为统计卡片 + 台账列表。
    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>${tab.label}</h2></div>
        <div class="card-body">
          <p class="text-muted">${tab.desc}</p>
          <div class="alert alert-warning" style="margin-top:12px;">
            该板块正在开发中（分支 feature/training-module），数据表建立后将在此展示
            ${tab.key === 'plans' ? '计划列表与新建计划入口' :
              tab.key === 'records' ? '培训实施记录与参训人员明细' : '考试安排与成绩统计'}。
          </div>
        </div>
      </div>
    `;
  },
};

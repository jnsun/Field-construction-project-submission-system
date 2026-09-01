// =============================================================
// js/modules/stats/stats.js —— 统计分析模块 v1
//
// 四个页签：数据看板 / 逾期名单 / 预警中心 / 报表导出
// 权限：仅管理员可用；数据范围由服务端 RPC 强制（越权穿透 42501）
// 依赖：sql/statistics-module.sql（未执行时各页签有降级提示）
// 口径：所有任务统计按 employee_id 维度（双通道），逾期按计划×部门 due_date
// =============================================================
const StatsModule = {

  state: {
    view: 'dashboard',        // dashboard | overdue | alerts | export
    window: 'all',            // all | year | quarter | month
    crumbs: [],               // 穿透面包屑 [{id, name}]
    overview: null,
    unread: 0,
    profile: null,
  },

  TABS: [
    { key: 'dashboard', label: '数据看板' },
    { key: 'overdue',   label: '逾期名单' },
    { key: 'alerts',    label: '预警中心' },
    { key: 'export',    label: '报表导出' },
  ],

  // ---------------------------------------------------------------- 入口
  async render(app) {
    this.state.profile = Auth.currentProfile || {};
    if (!Auth.isAdmin()) {
      app.innerHTML = `
        <div class="page">
          <div class="page-header"><h1>统计分析</h1></div>
          <div class="card"><div class="card-body">
            <p class="text-muted">该模块仅对管理员开放。</p>
          </div></div>
        </div>`;
      return;
    }

    app.innerHTML = `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildTabs()}
          <div id="stats-section">
            <div class="card"><div class="card-body">加载中...</div></div>
          </div>
        </div>
      </div>`;
    await this.renderView();
  },

  buildHeader() {
    const p = this.state.profile || {};
    const name = p.full_name || p.email || '用户';
    const dept = Auth.getDepartmentName ? Auth.getDepartmentName() : '';
    const lv = this.levelBadge();
    return `
      <div class="dashboard-header">
        <div class="dashboard-header-inner">
          <div class="header-left">
            <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          </div>
          <div class="header-center"><h1 class="page-title">统计分析</h1></div>
          <div class="header-right">
            <span class="badge badge-muted">${Utils.escapeHtml(dept || '')}</span>
            ${lv}
            <div class="user-info"><span class="user-name">${Utils.escapeHtml(name)}</span></div>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>`;
  },

  levelBadge() {
    if (Auth.isCompanyAdmin()) return '<span class="badge badge-danger">公司级</span>';
    const lv = (this.state.profile || {}).admin_level;
    if (lv === 'project') return '<span class="badge badge-warning">项目级</span>';
    return '<span class="badge badge-success">部门级</span>';
  },

  buildTabs() {
    return `
      <div class="cat-tabs" id="stats-tabs">
        ${this.TABS.map(t => `
          <button type="button" class="cat-tab${this.state.view === t.key ? ' active' : ''}"
            data-view="${t.key}" onclick="StatsModule.switchView('${t.key}')">
            ${t.label}${t.key === 'alerts' && this.state.unread > 0
              ? `<span class="stats-unread-dot">${this.state.unread > 99 ? '99+' : this.state.unread}</span>` : ''}
          </button>`).join('')}
      </div>`;
  },

  async switchView(view) {
    this.state.view = view;
    const tabs = document.getElementById('stats-tabs');
    if (tabs) tabs.outerHTML = this.buildTabs();
    await this.renderView();
  },

  async renderView() {
    const box = document.getElementById('stats-section');
    if (!box) return;
    try {
      switch (this.state.view) {
        case 'dashboard': await this.renderDashboard(box); break;
        case 'overdue':   await this.renderOverdue(box);   break;
        case 'alerts':    await this.renderAlerts(box);    break;
        case 'export':    await this.renderExport(box);    break;
      }
    } catch (e) {
      const msg = this.rpcError(e);
      box.innerHTML = `<div class="card"><div class="card-body">
        <p style="color:#b91c1c">加载失败：${Utils.escapeHtml(msg)}</p>
        <p class="text-muted" style="margin-top:8px">若提示函数不存在，请先在 Supabase 执行 sql/statistics-module.sql</p>
      </div></div>`;
    }
  },

  /** RPC 报错信息提取（附带 SQLSTATE 错误码，便于定位） */
  rpcError(e) {
    const err = e && (e.message || e.error_description || e);
    const code = (e && e.code) || '';
    const s = String(err);
    if (/Could not find the function|PGRST202/.test(s)) {
      return 'RPC 未安装（先执行 sql/statistics-module.sql；若已执行请强制刷新页面后重试）';
    }
    return code ? `【${code}】${s}` : s;
  },

  /** 当前时间窗的 p_from（null=全部） */
  windowFrom() {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    switch (this.state.window) {
      case 'month':   return `${y}-${String(m + 1).padStart(2, '0')}-01`;
      case 'quarter': return `${y}-${String(Math.floor(m / 3) * 3 + 1).padStart(2, '0')}-01`;
      case 'year':    return `${y}-01-01`;
      default:        return null;
    }
  },

  currentDept() {
    return this.state.crumbs.length ? this.state.crumbs[this.state.crumbs.length - 1] : null;
  },

  // ---------------------------------------------------------------- 数据看板
  async renderDashboard(box, keepCrumbs) {
    if (!keepCrumbs && this.state.view !== 'dashboard') this.state.crumbs = [];
    box.innerHTML = `<div class="card"><div class="card-body">统计计算中，请稍候...</div></div>`;

    const dept = this.currentDept();
    const { data, error } = await sb.rpc('stats_overview', {
      p_dept: dept ? dept.id : null,
      p_from: this.windowFrom(),
      p_to: null,
    });
    if (error) throw error;
    this.state.overview = data;

    const t = data.total || {};
    const st = data.settings || {};
    const certEnabled = t.cert_enabled === true;

    const cards = [
      { label: '培训完成率', sub: `${t.completed ?? 0} / ${t.tasks ?? 0} 项任务`,
        value: t.completion_rate != null ? t.completion_rate + '%' : '—',
        cls: this.rateCls(t.completion_rate, st.completion_threshold) },
      { label: '考试通过率', sub: `首考通过率 ${t.first_pass_rate != null ? t.first_pass_rate + '%' : '—'}（${t.first_pass ?? 0}/${t.first_pass_total ?? 0}）`,
        value: t.exam_rate != null ? t.exam_rate + '%' : '—',
        cls: this.rateCls(t.exam_rate, 60) },
      { label: '人均学习时长', sub: `${t.learners ?? 0} 名员工有学习记录`,
        value: t.avg_minutes != null ? t.avg_minutes + ' 分钟' : '—', cls: 'info' },
      { label: '持证率', sub: certEnabled
          ? `有效持证 ${t.cert_holders ?? 0} 人 / 基准 ${t.cert_target ?? '未配置'}`
          : '证照模块未启用（先执行 certificate-management.sql）',
        value: t.cert_rate != null ? t.cert_rate + '%' : '—',
        cls: this.rateCls(t.cert_rate, 90) },
      { label: '逾期未学', sub: '超过截止日期未完成的员工数',
        value: t.overdue_persons ?? 0, cls: (t.overdue_persons || 0) > 0 ? 'danger' : 'success' },
    ];

    const depts = data.depts || [];
    const lowDepts = depts.filter(d => d.completion_rate != null
      && d.completion_rate < (st.completion_threshold || 80));

    box.innerHTML = `
      ${this.buildToolbar()}
      ${lowDepts.length ? `
        <div class="stats-alert-banner">⚠ 完成率低于阈值（${st.completion_threshold}%）的单位：${lowDepts.map(d =>
          `${Utils.escapeHtml(d.dept_name)}（${d.completion_rate}%）`).join('、')}</div>` : ''}
      <div class="cert-stats-block">
        ${cards.map(c => `
          <div class="cert-stat-card ${c.cls}">
            <div class="cert-stat-value">${c.value}</div>
            <div class="cert-stat-label">${Utils.escapeHtml(c.label)}</div>
            <div class="stats-card-sub">${Utils.escapeHtml(c.sub)}</div>
          </div>`).join('')}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="card-header"><h2>下级部门明细</h2></div>
        <div class="card-body" style="padding-top:4px">
          ${depts.length === 0
            ? '<p class="text-muted">当前范围内暂无培训任务数据。</p>'
            : this.buildDeptTable(depts)}
        </div>
      </div>
      <details class="stats-legend" style="margin-top:10px">
        <summary>指标口径说明</summary>
        <div class="card-body text-muted" style="font-size:12px;line-height:1.9">
          · 培训完成率 = 已完成任务数 ÷ 全部下发任务数（按员工维度去重统计）<br>
          · 考试通过率 = 考试通过任务数 ÷ 有考试要求的任务数；首考通过率仅统计第一次尝试<br>
          · 人均学习时长 = 心跳有效学习秒数合计 ÷ 有学习记录的员工数（失焦/切屏时段已剔除）<br>
          · 持证率 = 部门有效个人持证人数 ÷ 部门持证基准数（基准由公司级管理员维护；未配置显示"—"）<br>
          · 逾期未学 = 截止日期已过且未完成的任务的去重员工数（截止日期取计划对该部门的要求完成日期）<br>
          · 数据范围由服务端按账号管辖部门强制过滤，时间窗作用于任务下发时间与学习开始时间
        </div>
      </details>`;
  },

  rateCls(rate, threshold) {
    if (rate == null) return 'total';
    if (threshold == null) return 'info';
    if (rate >= threshold) return 'success';
    if (rate >= threshold - 20) return 'warning';
    return 'danger';
  },

  buildToolbar() {
    const win = this.state.window;
    const crumbs = this.state.crumbs;
    const rootLabel = Auth.isCompanyAdmin() ? '全公司' : '我的辖区';
    return `
      <div class="stats-toolbar">
        <div class="stats-pills">
          ${[['all', '全部'], ['year', '本年'], ['quarter', '本季'], ['month', '本月']].map(([k, l]) => `
            <button class="stats-pill${win === k ? ' active' : ''}"
              onclick="StatsModule.setWindow('${k}')">${l}</button>`).join('')}
        </div>
        <div class="stats-crumbs">
          ${crumbs.length ? `<button type="button" class="btn btn-sm stats-btn-back"
            onclick="StatsModule.crumbsRoot()">‹ 返回上级</button>` : ''}
          <span class="stats-crumb${crumbs.length ? '' : ' current'}"
            onclick="StatsModule.crumbsRoot()">${rootLabel}</span>
          ${crumbs.map((c, i) => `
            <span class="stats-crumb-sep">▸</span><span
              class="stats-crumb${i === crumbs.length - 1 ? ' current' : ''}"
              onclick="StatsModule.crumbsTo(${i})">${Utils.escapeHtml(c.name)}</span>`).join('')}
        </div>
      </div>`;
  },

  async setWindow(w) {
    this.state.window = w;
    await this.renderDashboard(document.getElementById('stats-section'), true);
  },

  async crumbsTo(i) {
    this.state.crumbs = this.state.crumbs.slice(0, i + 1);
    await this.renderDashboard(document.getElementById('stats-section'), true);
  },

  /** 返回穿透起点（我的辖区/全公司根节点），在看板与逾期名单页均可用 */
  async crumbsRoot() {
    this.state.crumbs = [];
    await this.renderView();
  },

  buildDeptTable(depts) {
    const max = Math.max(...depts.map(d => d.tasks || 0), 1);
    const isCompany = Auth.isCompanyAdmin();
    return `
      <div style="overflow-x:auto">
      <table class="stats-table">
        <thead>
          <tr>
            <th style="width:200px">部门</th>
            <th style="width:70px">任务数</th>
            <th style="width:170px">完成率</th>
            <th style="width:80px">通过率</th>
            <th style="width:90px">人均时长</th>
            <th style="width:80px">持证率</th>
            <th style="width:70px">逾期</th>
            <th style="width:70px">操作</th>
          </tr>
        </thead>
        <tbody>
          ${depts.map(d => `
            <tr>
              <td class="stats-td-ellipsis" title="${Utils.escapeHtml(d.dept_name)}">${Utils.escapeHtml(d.dept_name)}</td>
              <td>${d.tasks ?? 0}</td>
              <td>
                <div class="stats-bar-row">
                  <div class="stats-bar"><div class="stats-bar-fill ${this.rateCls(d.completion_rate, (this.state.overview.settings || {}).completion_threshold)}"
                    style="width:${Math.max(2, d.completion_rate || 0)}%"></div></div>
                  <span>${d.completion_rate != null ? d.completion_rate + '%' : '—'}</span>
                </div>
              </td>
              <td>${d.exam_rate != null ? d.exam_rate + '%' : '—'}</td>
              <td>${d.avg_minutes != null ? d.avg_minutes + '分' : '—'}</td>
              <td>${d.cert_rate != null ? d.cert_rate + '%'
                : (d.cert_target != null ? '0%' : '—')}</td>
              <td>${d.overdue_persons > 0
                ? `<span style="color:#b91c1c;font-weight:600">${d.overdue_persons}</span>` : '0'}</td>
              <td>
                <button class="btn btn-sm" onclick="StatsModule.drill('${d.dept_id}')">穿透 ▸</button>
                ${isCompany ? `<button class="btn btn-sm stats-btn-ghost" title="设置该部门持证基准数"
                  onclick="StatsModule.setCertTarget('${d.dept_id}', ${d.cert_target ?? 'null'})">基准</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
  },

  async drill(deptId) {
    const d = (this.state.overview.depts || []).find(x => x.dept_id === deptId);
    if (!d) return;
    this.state.crumbs.push({ id: deptId, name: d.dept_name });
    await this.renderDashboard(document.getElementById('stats-section'), true);
  },

  async setCertTarget(deptId, current) {
    const v = prompt('输入该部门的应持证人数基准（0-999）：', current != null ? current : '');
    if (v === null) return;
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0 || n > 999) { Utils.toast('请输入 0-999 的整数', 'error'); return; }
    const { error } = await sb.rpc('stats_set_cert_target', { p_dept: deptId, p_count: n });
    if (error) { Utils.toast('设置失败：' + this.rpcError(error), 'error'); return; }
    Utils.toast('持证基准已更新', 'success');
    await this.renderDashboard(document.getElementById('stats-section'), true);
  },

  // ---------------------------------------------------------------- 逾期名单
  async renderOverdue(box) {
    box.innerHTML = `<div class="card"><div class="card-body">加载中...</div></div>`;
    const dept = this.currentDept();
    const { data, error } = await sb.rpc('stats_overdue_list', {
      p_dept: dept ? dept.id : null, p_limit: 500,
    });
    if (error) throw error;
    const rows = data.rows || [];

    box.innerHTML = `
      ${this.buildToolbar()}
      <div class="card" style="margin-top:10px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h2>逾期未学名单（${data.count} 条）</h2>
          <button class="btn btn-sm" onclick="StatsModule.exportOverdueXlsx()">导出 Excel</button>
        </div>
        <div class="card-body" style="padding-top:4px">
          ${rows.length === 0 ? '<p class="text-muted">当前范围内没有逾期未学记录 🎉</p>' : `
          <div style="overflow-x:auto">
          <table class="stats-table">
            <thead><tr>
              <th style="width:100px">姓名</th><th style="width:180px">部门</th>
              <th>培训任务</th><th style="width:110px">截止日期</th>
              <th style="width:80px">逾期天数</th><th style="width:80px">状态</th>
            </tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${Utils.escapeHtml(r.emp_name)}</td>
                  <td class="stats-td-ellipsis" title="${Utils.escapeHtml(r.dept_name)}">${Utils.escapeHtml(r.dept_name)}</td>
                  <td class="stats-td-ellipsis" title="${Utils.escapeHtml(r.plan_title)}">${Utils.escapeHtml(r.plan_title)}</td>
                  <td>${r.due_date || '—'}</td>
                  <td><span style="color:#b91c1c;font-weight:600">${r.overdue_days}</span> 天</td>
                  <td>${this.statusLabel(r.status)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>`}
        </div>
      </div>`;
    this.state._overdueRows = rows;
  },

  statusLabel(s) {
    return { pending: '<span class="badge badge-muted">未开始</span>',
      learning: '<span class="badge badge-warning">学习中</span>',
      completed: '<span class="badge badge-success">已完成</span>',
      overdue: '<span class="badge badge-danger">已逾期</span>' }[s] || Utils.escapeHtml(s || '');
  },

  exportOverdueXlsx() {
    const rows = this.state._overdueRows || [];
    if (!rows.length) { Utils.toast('没有可导出的数据', 'info'); return; }
    const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
      姓名: r.emp_name, 部门: r.dept_name, 培训任务: r.plan_title,
      截止日期: r.due_date, 逾期天数: r.overdue_days, 状态: r.status,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '逾期名单');
    XLSX.writeFile(wb, `逾期未学名单_${new Date().toISOString().slice(0, 10)}.xlsx`);
  },

  // ---------------------------------------------------------------- 预警中心
  async renderAlerts(box) {
    box.innerHTML = `<div class="card"><div class="card-body">预警计算中...</div></div>`;

    // 懒计算（幂等，月度去重）→ 拉取信箱
    const [syncRes, ] = await Promise.all([
      sb.rpc('stats_alert_sync').catch(() => ({ data: null, error: null })),
      Promise.resolve(),
    ]);
    if (syncRes.error) { Utils.toast('预警同步失败：' + this.rpcError(syncRes.error), 'error'); }
    const { data, error } = await sb.rpc('stats_alert_inbox', { p_unread_only: false });
    if (error) throw error;
    this.state.unread = data.unread || 0;
    // 同步页签徽标
    const tabs = document.getElementById('stats-tabs');
    if (tabs) tabs.outerHTML = this.buildTabs();

    const rows = data.rows || [];
    const isCompany = Auth.isCompanyAdmin();
    const st = (this.state.overview && this.state.overview.settings) || {};

    box.innerHTML = `
      ${isCompany ? `
      <div class="card">
        <div class="card-header"><h2>预警阈值设置（公司级）</h2></div>
        <div class="card-body" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div>
            <div class="stats-field-label">单位完成率预警阈值（%）</div>
            <input type="number" id="stats-th-input" class="input stats-input-sm"
              value="${st.completion_threshold ?? 80}" min="0" max="100">
          </div>
          <div>
            <div class="stats-field-label">个人逾期宽限（天）</div>
            <input type="number" id="stats-grace-input" class="input stats-input-sm"
              value="${st.overdue_grace_days ?? 7}" min="0" max="365">
          </div>
          <button class="btn btn-primary btn-sm" onclick="StatsModule.saveSettings()">保存</button>
        </div>
      </div>` : ''}
      <div class="card" style="margin-top:10px">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h2>预警信箱 ${this.state.unread > 0
            ? `<span class="stats-unread-dot">${this.state.unread} 条未读</span>` : ''}</h2>
          ${this.state.unread > 0 ? '<button class="btn btn-sm" onclick="StatsModule.ackAll()">全部标为已读</button>' : ''}
        </div>
        <div class="card-body" style="padding-top:4px">
          ${rows.length === 0 ? '<p class="text-muted">暂无预警。各部门完成率正常、无逾期未学人员。</p>'
            : rows.map(r => this.alertItem(r)).join('')}
        </div>
      </div>`;
    this.state._alertRows = rows;
  },

  alertItem(r) {
    const p = r.payload || {};
    let title = '', detail = '', icon = '';
    if (r.alert_type === 'unit_completion') {
      icon = '📉';
      title = `${p.dept_name || '该单位'} 培训完成率 ${p.rate}%（低于阈值 ${p.threshold}%）`;
      detail = `任务 ${p.tasks} 项，已完成 ${p.completed} 项`;
    } else {
      icon = '⏰';
      title = `${p.emp_name || '员工'} 逾期未完成「${p.plan_title || '培训任务'}」`;
      detail = `截止 ${p.due_date}，已逾期 ${p.overdue_days} 天（宽限 ${p.grace_days} 天）`;
    }
    const dt = (r.created_at || '').replace('T', ' ').slice(0, 16);
    return `
      <div class="stats-alert-item${r.unread ? ' unread' : ''}">
        <div class="stats-alert-icon">${icon}</div>
        <div class="stats-alert-main">
          <div class="stats-alert-title">${Utils.escapeHtml(title)}${r.unread ? '<span class="stats-unread-dot">未读</span>' : ''}</div>
          <div class="stats-alert-detail">${Utils.escapeHtml(detail)}</div>
        </div>
        <div class="stats-alert-time">${dt}</div>
      </div>`;
  },

  async saveSettings() {
    const th = parseFloat(document.getElementById('stats-th-input').value);
    const gr = parseInt(document.getElementById('stats-grace-input').value, 10);
    const { error } = await sb.rpc('stats_set_settings', {
      p_completion_threshold: th, p_overdue_grace_days: gr,
    });
    if (error) { Utils.toast('保存失败：' + this.rpcError(error), 'error'); return; }
    Utils.toast('预警阈值已保存', 'success');
    if (this.state.overview) this.state.overview.settings = { completion_threshold: th, overdue_grace_days: gr };
  },

  async ackAll() {
    const unreadIds = (this.state._alertRows || []).filter(r => r.unread).map(r => r.id);
    if (!unreadIds.length) return;
    const { error } = await sb.rpc('stats_alert_ack', { p_ids: unreadIds });
    if (error) { Utils.toast('操作失败：' + this.rpcError(error), 'error'); return; }
    this.state.unread = 0;
    Utils.toast('已全部标为已读', 'success');
    await this.renderAlerts(document.getElementById('stats-section'));
  },

  // ---------------------------------------------------------------- 报表导出
  async renderExport(box) {
    box.innerHTML = `<div class="card"><div class="card-body">加载培训计划...</div></div>`;
    const { data: plans, error } = await sb.from('training_plans')
      .select('id, title, plan_year, plan_month, status')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>培训记录 PDF 导出（A4，含手写签字）</h2></div>
        <div class="card-body">
          <p class="text-muted" style="margin-bottom:10px">
            导出范围为<b>您管辖范围内已完成</b>的培训记录；每条记录占 A4 一页，
            手写签字图自动嵌入。浏览器打印对话框中请选择「另存为 PDF / 目标打印机」。
          </p>
          <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
            <div>
              <div class="stats-field-label">选择培训计划（可全部）</div>
              <select id="stats-export-plan" class="input stats-input-md">
                <option value="">全部计划</option>
                ${(plans || []).map(p => `
                  <option value="${p.id}">${Utils.escapeHtml(p.title)}（${p.plan_year}${p.plan_month ? '-' + p.plan_month : ''}）</option>`).join('')}
              </select>
            </div>
            <button class="btn btn-primary" onclick="StatsModule.exportPdf()">生成 PDF（打印视图）</button>
            <button class="btn" onclick="StatsModule.exportXlsx()">导出 Excel 明细</button>
          </div>
          <div id="stats-export-progress" class="text-muted" style="margin-top:10px"></div>
        </div>
      </div>`;
    this.state._plans = plans || [];
  },

  async fetchExportRows() {
    const planSel = document.getElementById('stats-export-plan');
    const planId = planSel ? planSel.value || null : null;
    const dept = this.currentDept();
    const { data, error } = await sb.rpc('stats_export_records', {
      p_plan: planId, p_dept: dept ? dept.id : null,
    });
    if (error) throw error;
    return data.rows || [];
  },

  async exportXlsx() {
    try {
      const rows = await this.fetchExportRows();
      if (!rows.length) { Utils.toast('范围内没有已完成的培训记录', 'info'); return; }
      const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
        姓名: r.emp_name, 工号: r.employee_no || '', 部门: r.dept_name,
        岗位: r.position || '', 培训任务: r.plan_title, 计划学时: r.plan_hours ?? '',
        完成时间: r.completed_at ? r.completed_at.slice(0, 16).replace('T', ' ') : '',
        有效学习秒数: r.study_sec, 考试状态: r.exam_status, 考试成绩: r.exam_score ?? '',
        考试次数: r.exam_attempts, 状态: r.status, 已签字: r.storage_path ? '是' : '否',
      })));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '培训记录');
      XLSX.writeFile(wb, `培训记录明细_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      Utils.toast('导出失败：' + this.rpcError(e), 'error');
    }
  },

  async exportPdf() {
    const progress = document.getElementById('stats-export-progress');
    try {
      progress.textContent = '正在获取培训记录...';
      const rows = await this.fetchExportRows();
      if (!rows.length) { Utils.toast('范围内没有已完成的培训记录', 'info'); progress.textContent = ''; return; }

      // 拉签字图 → base64（打印视图必须内嵌，不能热链）
      const noSig = rows.filter(r => !r.storage_path).length;
      let sigMap = {};
      const withSig = rows.filter(r => r.storage_path);
      if (withSig.length) {
        progress.textContent = `正在拉取手写签字（0/${withSig.length}）...`;
        for (let i = 0; i < withSig.length; i++) {
          const r = withSig[i];
          try {
            const { data } = await sb.storage.from('training-courses').createSignedUrl(r.storage_path, 300);
            if (data && data.signedUrl) {
              const resp = await fetch(data.signedUrl);
              const blob = await resp.blob();
              sigMap[r.assignment_id] = await new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => resolve(null);
                fr.readAsDataURL(blob);
              });
            }
          } catch (_) { /* 单张失败继续 */ }
          progress.textContent = `正在拉取手写签字（${i + 1}/${withSig.length}）...`;
        }
      }

      progress.textContent = '正在生成打印视图...';
      const html = this.buildPrintHtml(rows, sigMap);
      const w = window.open('', '_blank');
      if (!w) { Utils.toast('弹窗被拦截，请允许本站弹出窗口后重试', 'error'); progress.textContent = ''; return; }
      w.document.write(html);
      w.document.close();
      if (noSig > 0) Utils.toast(`注意：${noSig} 条记录无手写签字，已打印占位框`, 'info');
      progress.textContent = `已生成 ${rows.length} 条记录的打印视图（在新窗口，Ctrl+P → 另存为 PDF）`;
      setTimeout(() => { try { w.focus(); w.print(); } catch (_) {} }, 600);
    } catch (e) {
      progress.textContent = '';
      Utils.toast('导出失败：' + this.rpcError(e), 'error');
    }
  },

  buildPrintHtml(rows, sigMap) {
    const pages = rows.map((r, idx) => {
      const sig = sigMap[r.assignment_id];
      const studyH = r.study_sec ? (r.study_sec / 3600).toFixed(2) + ' 小时'
        : (r.study_sec === 0 ? '0 小时' : '—');
      return `
      <div class="rec-page">
        <div class="rec-head">
          <span>${Utils.escapeHtml(r.dept_name)} · 培训记录</span>
          <span>编号：${String(r.plan_id || '').slice(0, 8)}-${String(r.assignment_id || '').slice(0, 8)}</span>
        </div>
        <h1 class="rec-title">${Utils.escapeHtml(r.plan_title)}</h1>
        <table class="rec-info">
          <tr><th>姓名</th><td>${Utils.escapeHtml(r.emp_name)}</td>
              <th>部门</th><td>${Utils.escapeHtml(r.dept_name)}</td></tr>
          <tr><th>工号</th><td>${Utils.escapeHtml(r.employee_no || '—')}</td>
              <th>岗位</th><td>${Utils.escapeHtml(r.position || '—')}</td></tr>
          <tr><th>培训类别</th><td>${Utils.escapeHtml(r.plan_category || '—')}</td>
              <th>计划学时</th><td>${r.plan_hours ?? '—'}</td></tr>
          <tr><th>学习区间</th><td colspan="3">${r.start_date || '—'} 至 ${r.end_date || '—'}</td></tr>
        </table>
        <table class="rec-detail">
          <tr><th>完成时间</th><td>${r.completed_at ? r.completed_at.slice(0, 16).replace('T', ' ') : '—'}</td>
              <th>有效学习时长</th><td>${studyH}</td></tr>
          <tr><th>考试状态</th><td>${this.examLabel(r.exam_status)}</td>
              <th>考试成绩 / 次数</th><td>${r.exam_score ?? '—'} / ${r.exam_attempts ?? 0} 次</td></tr>
          <tr><th>完成判定</th><td colspan="3"><b>${this.statusLabel(r.status)}</b>
              （系统自动判定：学习进度 100%${r.exam_status && r.exam_status !== 'none' ? ' + 考试通过' : ''}）</td></tr>
        </table>
        <div class="rec-sig-block">
          <div class="rec-sig-label">员工手写签字${r.signed_at ? `（${r.signed_at.slice(0, 10)}）` : ''}</div>
          ${sig ? `<img class="rec-sig-img" src="${sig}" alt="签字">`
                : `<div class="rec-sig-empty">员工未签字</div>`}
        </div>
        <div class="rec-foot">
          <span>打印时间：${new Date().toLocaleString('zh-CN')}</span>
          <span>第 ${idx + 1} 页 / 共 ${rows.length} 页</span>
        </div>
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>培训记录导出</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #1a1a1a; }
  .rec-page { page-break-after: always; padding: 0 2mm; position: relative; min-height: 250mm; }
  .rec-page:last-child { page-break-after: auto; }
  .rec-head { display: flex; justify-content: space-between; font-size: 11px; color: #666;
    border-bottom: 1px solid #ccc; padding-bottom: 6px; }
  .rec-title { text-align: center; font-size: 20px; margin: 24px 0 20px; }
  .rec-info, .rec-detail { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 18px; }
  .rec-info th, .rec-info td, .rec-detail th, .rec-detail td { border: 1px solid #999; padding: 7px 10px; text-align: left; }
  .rec-info th, .rec-detail th { background: #f2f4f7; width: 90px; font-weight: 600; white-space: nowrap; }
  .rec-sig-block { margin-top: 28px; }
  .rec-sig-label { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  .rec-sig-img { height: 30mm; max-width: 80mm; object-fit: contain; border: 1px dashed #bbb; padding: 4px; }
  .rec-sig-empty { width: 60mm; height: 22mm; border: 1px dashed #bbb; display: flex;
    align-items: center; justify-content: center; color: #999; font-size: 12px; }
  .rec-foot { position: absolute; bottom: 0; left: 2mm; right: 2mm; display: flex;
    justify-content: space-between; font-size: 11px; color: #888; border-top: 1px solid #ccc; padding-top: 6px; }
</style>
</head>
<body>${pages}</body>
</html>`;
  },

  examLabel(s) {
    return { none: '无考试要求', pending: '待考试', ongoing: '考试中',
      passed: '<b style="color:#16a34a">通过</b>', failed: '<b style="color:#b91c1c">未通过</b>' }[s]
      || Utils.escapeHtml(s || '—');
  },
};

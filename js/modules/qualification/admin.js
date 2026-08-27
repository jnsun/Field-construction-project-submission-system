/**
 * admin.js - 管理员模块（资质证照全公司视图）
 * 负责证照汇总台账（公司/大类/类型/状态多维筛选 + 统计 + CSV 导出）、
 * 证照登记 / 编辑 / 删除 / 换证 / 附件上传删除（v3 权限模型：写操作仅管理员）、
 * Excel 批量导入（入口在此，实现在 import.js / CertImport）、
 * 证照类型字典维护（含子分类维度）、预警天数配置
 *
 * 说明：
 *   - 公司 = departments 表中 is_company = true 的行（物化院有限公司、六勘院有限公司）
 *   - 公司账号对本公司证照只读；证照与附件的全部维护操作由管理员在本模块完成，
 *     与 RLS 策略（写仅 is_admin()）保持一致
 */

const CertAdmin = {

  state: {
    view: 'certs',            // 'certs' | 'types' | 'settings'
    companies: [],            // 全部公司（departments 中 is_company = true 的行）
    certs: [],                // 全部证照（关联公司）
    types: [],                // 证照类型字典（含子分类维度）
    warnDays: 90,             // 预警天数
    filters: {
      company: '',            // '' 全部公司
      category: '',
      type: '',
      status: '',
      keyword: '',
    },
    editingTypeId: null,      // 正在编辑的类型 ID
    editingId: null,          // 正在编辑的证照 ID
    renewingFrom: null,       // 换证来源证照 ID（提交时写 renewed_from）
    detailId: null,           // 详情弹窗当前证照 ID
    detailFiles: [],          // 详情弹窗附件列表
    detailTrainings: [],      // 详情弹窗历年培训记录列表
    loading: false,
    dedupeGroups: null,       // 去重扫描结果 [{ keep, remove[] }]，仅管理员用
    dedupeDeleting: false,    // 去重删除执行中（防重复提交）
    dedupeFailed: [],         // 去重删除失败项 [{ id, name, message }]（失败后不再自动重开弹窗）
    selectedIds: [],          // 批量操作（调整培训状态）勾选的证照 ID
  },

  /**
   * 证照类型默认值（数据库配置未就绪时的兜底，保证系统不因缺表而崩溃）
   */
  DEFAULT_CERT_TYPES: [
    { name: '安全生产许可证', category: 'company' },
    { name: '爆破作业单位许可证', category: 'company' },
    { name: '应急预案备案登记表', category: 'company' },
    { name: '安全生产部标准化二级', category: 'company' },
    { name: '安全生产责任保险', category: 'company' },
    { name: '爆破作业人员许可证', category: 'personal',
      sub1_label: '人员类别',
      sub1_options: ['爆破员', '保管员', '安全员', '爆破工程技术人员初级/D', '爆破工程技术人员中级/C'] },
    { name: '非煤矿山安全管理人员证书', category: 'personal',
      sub1_label: '证书类别', sub1_options: ['主要负责人', '安全管理人员'],
      sub2_label: '学习地点', sub2_options: ['太原', '运城'] },
    { name: '特种作业人员资格证', category: 'personal',
      sub1_label: '培训机构', sub1_options: ['应急局', '住建局'],
      sub2_label: '作业类别', sub2_options: ['低压电工作业', '焊接与热切割作业'] },
    { name: '安全生产考核合格证书', category: 'personal',
      sub1_label: '类别', sub1_options: ['A类人员', 'B类人员', 'C类人员'] },
    { name: '注册安全工程师', category: 'personal',
      sub1_label: '专业类别', sub1_options: ['金属非金属矿山安全', '其他安全'] },
  ],

  /**
   * 渲染管理员仪表盘
   * @param {HTMLElement} container
   */
  async render(container) {
    this.state.filters = { company: '', category: '', type: '', status: '', keyword: '' };
    container.innerHTML = this.buildHTML();
    // 全局点击关闭工具栏下拉菜单（仅注册一次）
    if (!this._dropdownListener) {
      this._dropdownListener = (e) => {
        const dropdown = document.getElementById('admin-toolbar-dropdown');
        if (dropdown && !dropdown.contains(e.target)) this.closeToolbarDropdown();
      };
      document.addEventListener('click', this._dropdownListener);
    }
    await this.loadData();
  },

  /**
   * 构建 HTML
   */
  buildHTML() {
    return `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildTabs()}
          <!-- 证照台账视图 -->
          <div id="admin-certs-view">
            ${this.buildToolbar()}
            <div id="admin-certs-content"></div>
          </div>
          <!-- 类型字典视图 -->
          <div id="admin-types-view" style="display:none;">
            <div id="admin-types-content"></div>
          </div>
          <!-- 系统设置视图 -->
          <div id="admin-settings-view" style="display:none;">
            <div id="admin-settings-content"></div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 顶部导航栏
   */
  buildHeader() {
    return `
      <div class="dashboard-header">
        <div class="dashboard-header-inner">
          <div class="header-left">
            <h1>资质证照管理</h1>
            <span class="badge badge-success">管理员</span>
            ${Auth.isSuperAdmin() ? '<span class="badge badge-danger">超级管理员</span>' : ''}
          </div>
          <div class="header-right">
            <div class="user-info">
              <span class="user-name">${Utils.escapeHtml(Auth.currentProfile.full_name || Auth.currentProfile.email || '管理员')}</span>
            </div>
            <button class="btn btn-secondary btn-sm" onclick="App.openDashboard()">工作台</button>
            <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
            <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 选项卡
   */
  buildTabs() {
    const views = [
      { key: 'certs',    label: '证照台账' },
      { key: 'types',    label: '证照类型' },
      { key: 'settings', label: '系统设置' },
    ];
    return `
      <div class="dashboard-tabs">
        ${views.map(v => `
          <button class="tab-btn ${this.state.view === v.key ? 'active' : ''}" data-view="${v.key}"
            onclick="CertAdmin.switchView('${v.key}')">${v.label}</button>
        `).join('')}
      </div>
    `;
  },

  /**
   * 切换视图
   */
  async switchView(view) {
    this.state.view = view;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const btn = document.querySelector(`.dashboard-tabs .tab-btn[data-view="${view}"]`);
    if (btn) btn.classList.add('active');

    const certsView = document.getElementById('admin-certs-view');
    const typesView = document.getElementById('admin-types-view');
    const settingsView = document.getElementById('admin-settings-view');
    if (!certsView || !typesView || !settingsView) return;

    certsView.style.display = view === 'certs' ? '' : 'none';
    typesView.style.display = view === 'types' ? '' : 'none';
    settingsView.style.display = view === 'settings' ? '' : 'none';

    if (view === 'types') await this.renderTypesView();
    if (view === 'settings') await this.renderSettingsView();
  },

  /**
   * 工具栏：大类选项卡 + 筛选 + 搜索/导出/新增，全部放到一行
   */
  buildToolbar() {
    const cat = this.state.filters.category || '';
    return `
      <div class="toolbar cert-toolbar">
        <div class="toolbar-left cert-toolbar-left">
          <div class="cat-tabs" id="admin-cat-tabs">
            <button type="button" class="cat-tab${cat === '' ? ' active' : ''}" data-cat="" onclick="CertAdmin.setCategory('')">全部</button>
            <button type="button" class="cat-tab${cat === 'company' ? ' active' : ''}" data-cat="company" onclick="CertAdmin.setCategory('company')">公司证照</button>
            <button type="button" class="cat-tab${cat === 'personal' ? ' active' : ''}" data-cat="personal" onclick="CertAdmin.setCategory('personal')">个人证照</button>
          </div>
          <label>公司：</label>
          <select id="admin-filter-company" class="filter-select-sm" onchange="CertAdmin.onFilterChange()">
            <option value="">全部公司</option>
          </select>
          <label>类型：</label>
          <select id="admin-filter-type" class="filter-select-sm" onchange="CertAdmin.onFilterChange()">
            <option value="">全部</option>
          </select>
          <label>状态：</label>
          <select id="admin-filter-status" class="filter-select-sm" onchange="CertAdmin.onFilterChange()">
            <option value="">全部</option>
            <option value="valid">有效</option>
            <option value="expiring">即将到期</option>
            <option value="expired">已过期</option>
            <option value="replaced">已换证</option>
            <option value="revoked">已注销</option>
          </select>
        </div>
        <div class="toolbar-right cert-toolbar-right">
          <input type="search" id="admin-cert-search" class="toolbar-search cert-search-sm" placeholder="搜索证照名称/编号/持证人/子分类" oninput="CertAdmin.onSearch()">
          <button class="btn btn-secondary btn-sm" onclick="CertAdmin.exportCSV()">导出台账 (CSV)</button>

          <!-- 工具下拉菜单（批量导入 / 去重清理 / 培训状态操作） -->
          <div class="toolbar-dropdown" id="admin-toolbar-dropdown">
            <button class="btn btn-secondary btn-sm dropdown-toggle" onclick="CertAdmin.toggleToolbarDropdown(event)" title="批量导入、去重、培训状态等工具">工具 ▾</button>
            <ul class="dropdown-menu" id="admin-toolbar-menu">
              <li><a href="javascript:void(0)" onclick="CertAdmin.closeToolbarDropdown(); CertImport.openModal()" title="通过 Excel 批量登记公司证照与个人证照">📥 批量导入</a></li>
              <li><a href="javascript:void(0)" onclick="CertAdmin.closeToolbarDropdown(); CertAdmin.openDedupeModal()" title="查找信息完全相同的重复证照，仅保留最早的一条">🧹 去重清理</a></li>
              <li><a href="javascript:void(0)" onclick="CertAdmin.closeToolbarDropdown(); CertAdmin.openBatchTrainingModal()" title="勾选多条证照后，批量设置当年培训状态；选「已培训」会自动补一条当年培训记录">📋 批量调整培训状态</a></li>
              <li><a href="javascript:void(0)" onclick="CertAdmin.closeToolbarDropdown(); CertAdmin.initTrainingStatusByRule()" title="按证照类型规则批量设置培训状态：公司证照与无需年培的特定个人证照→无需培训；需年培个人证照→待培训（已培训保留）">⚙️ 按规则初始化培训状态</a></li>
            </ul>
          </div>

          <span id="admin-selected-count" class="toolbar-hint">已选 0 条</span>
          <button class="btn btn-primary btn-sm" onclick="CertAdmin.showCertForm()">+ 新增证照</button>
        </div>
      </div>
    `;
  },

  /**
   * 初始加载全部数据（公司 + 证照 + 类型 + 设置）
   */
  async loadData() {
    this.showCertsLoading();
    try {
      const [companyRes, certRes, typesRes, settingsRes] = await Promise.all([
        sb.from('departments').select('*').eq('is_company', true).order('sort_order'),
        sb.from('certificates').select('*, departments(name, code)').order('created_at', { ascending: false }),
        sb.from('certificate_types').select('*').order('category, sort_order'),
        sb.from('cert_settings').select('warn_days').eq('id', 1).limit(1),
      ]);

      if (companyRes.error) throw new Error('公司列表加载失败: ' + companyRes.error.message + '（请先执行 sql/schema.sql 注册公司）');
      if (certRes.error) throw new Error('证照加载失败: ' + certRes.error.message + '（若提示表不存在，请先执行 sql/schema.sql）');

      this.state.companies = companyRes.data || [];
      this.state.certs = certRes.data || [];
      this.state.types = (typesRes.error ? [] : (typesRes.data || []));
      if (!settingsRes.error && settingsRes.data && settingsRes.data.length) {
        this.state.warnDays = settingsRes.data[0].warn_days || 90;
      }

      // 填充公司/类型筛选下拉
      this.fillCompanyFilter();
      this.fillTypeFilter('');
    } catch (e) {
      Utils.toast(e.message || '数据加载失败', 'error');
      const el = document.getElementById('admin-certs-content');
      if (el) {
        el.innerHTML = `<div class="card"><div class="card-body has-padding"><div class="alert alert-danger">${Utils.escapeHtml(e.message || '数据加载失败')}</div></div></div>`;
      }
      return;
    }
    this.renderCerts();
  },

  /**
   * 台账视图加载中占位
   */
  showCertsLoading() {
    const el = document.getElementById('admin-certs-content');
    if (!el) return;
    el.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;
  },

  /**
   * 填充公司筛选下拉（含各公司证照数）
   */
  fillCompanyFilter() {
    const sel = document.getElementById('admin-filter-company');
    if (!sel) return;
    const current = sel.value;
    const counts = {};
    for (const c of this.state.certs) {
      if (c.department_id) counts[c.department_id] = (counts[c.department_id] || 0) + 1;
    }
    sel.innerHTML = `
      <option value="">全部公司（${this.state.certs.length}）</option>
      ${this.state.companies.map(d => `
        <option value="${d.id}">${Utils.escapeHtml(d.name)}（${counts[d.id] || 0}）</option>
      `).join('')}
    `;
    if (current) sel.value = current;
  },

  /**
   * 填充类型筛选下拉（跟随类别筛选联动）
   */
  fillTypeFilter(category) {
    const sel = document.getElementById('admin-filter-type');
    if (!sel) return;
    const current = sel.value;
    const types = this.state.types.filter(t => !category || t.category === category);
    sel.innerHTML = `
      <option value="">全部</option>
      ${types.map(t => `<option value="${Utils.escapeHtml(t.name)}">${Utils.escapeHtml(t.name)}</option>`).join('')}
    `;
    if (current) sel.value = current;
  },

  /**
   * 大类选项卡切换：联动类型下拉 + 刷新列表
   */
  setCategory(cat) {
    this.state.filters.category = cat;
    const tabs = document.getElementById('admin-cat-tabs');
    if (tabs) {
      tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    }
    this.fillTypeFilter(cat);
    this.onFilterChange();
  },

  /**
   * 筛选条件变化（大类由选项卡管理）
   */
  onFilterChange() {
    this.state.filters.company = document.getElementById('admin-filter-company').value;
    this.state.filters.type = document.getElementById('admin-filter-type').value;
    this.state.filters.status = document.getElementById('admin-filter-status').value;
    this.renderCerts();
  },

  /**
   * 搜索框输入
   */
  onSearch() {
    const el = document.getElementById('admin-cert-search');
    this.state.filters.keyword = el ? el.value.trim().toLowerCase() : '';
    this.renderCerts();
  },

  /**
   * 获取证照展示状态（自动带当前预警天数）
   */
  statusOf(cert) {
    return Utils.certDisplayStatus(cert, this.state.warnDays);
  },

  /**
   * 匹配搜索关键字
   */
  matchKeyword(c, kw) {
    if (!kw) return true;
    return ['cert_name', 'cert_type', 'cert_no', 'holder_name', 'sub1_value', 'sub2_value', 'issuing_authority']
      .some(k => c[k] != null && String(c[k]).toLowerCase().includes(kw));
  },

  /**
   * 渲染证照台账（统计卡片 + 表格）
   */
  renderCerts() {
    const el = document.getElementById('admin-certs-content');
    if (!el) return;

    const { company, category, type, status, keyword } = this.state.filters;
    const all = this.state.certs;

    const enriched = all.map(c => ({ cert: c, st: this.statusOf(c) }));
    const filtered = enriched.filter(({ cert, st }) =>
      (!company || cert.department_id === company)
      && (!category || cert.cert_category === category)
      && (!type || cert.cert_type === type)
      && (!status || st.key === status)
      && this.matchKeyword(cert, keyword)
    );

    if (all.length === 0) {
      el.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>证照台账</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📋</div>
              <p>全公司暂无证照记录</p>
              <p style="margin-top:8px;">
                <button class="btn btn-primary" onclick="CertAdmin.showCertForm()">+ 新增证照</button>
                <button class="btn btn-secondary" onclick="CertImport.openModal()">批量导入 Excel</button>
              </p>
            </div>
          </div>
        </div>
      `;
      return;
    }
    if (filtered.length === 0) {
      el.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>证照台账</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">🔍</div>
              <p>未找到匹配的证照记录</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    // 统计（基于筛选后的公司/大类范围，不受状态筛选影响，便于横向比较）
    const scope = enriched.filter(({ cert }) =>
      (!company || cert.department_id === company)
      && (!category || cert.cert_category === category)
      && (!type || cert.cert_type === type));
    const activeScope = scope.filter(e => e.cert.status === 'active');
    const expiringCount = activeScope.filter(e => e.st.key === 'expiring').length;
    const expiredCount = activeScope.filter(e => e.st.key === 'expired').length;
    const companyCount = new Set(scope.map(e => e.cert.department_id).filter(Boolean)).size;

    // 排序：过期 > 即将到期 > 其他在用（按到期日升序）> 已换证/已注销
    // 「安全生产考核合格证书」默认按子分类 A→B→C 排序（子分类内再按到期日）
    const priority = { expired: 0, expiring: 1, valid: 2, replaced: 3, revoked: 3 };
    const SPECIAL_TYPE = '安全生产考核合格证书';
    const cmpDate = (ca, cb) => {
      const da = ca.valid_until || '9999-12-31';
      const db = cb.valid_until || '9999-12-31';
      return da < db ? -1 : da > db ? 1 : 0;
    };
    filtered.sort((a, b) => {
      const p = (priority[a.st.key] ?? 2) - (priority[b.st.key] ?? 2);
      if (p !== 0) return p;
      const sa = a.cert.cert_type === SPECIAL_TYPE ? Utils.subCategoryRank(a.cert.sub1_value) : null;
      const sb = b.cert.cert_type === SPECIAL_TYPE ? Utils.subCategoryRank(b.cert.sub1_value) : null;
      if (sa !== null && sb !== null) {
        if (sa !== sb) return sa - sb;
        return cmpDate(a.cert, b.cert);
      }
      return cmpDate(a.cert, b.cert);
    });

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">在用证照 / 涉及公司</div>
          <div class="stat-value">${activeScope.length} <span class="stat-sub">/ ${companyCount}</span></div>
        </div>
        <div class="stat-card ${expiringCount > 0 ? 'warning' : 'success'}">
          <div class="stat-label">即将到期（${this.state.warnDays} 天内）</div>
          <div class="stat-value">${expiringCount}</div>
        </div>
        <div class="stat-card ${expiredCount > 0 ? 'danger' : 'success'}">
          <div class="stat-label">已过期</div>
          <div class="stat-value">${expiredCount}</div>
        </div>
        <div class="stat-card info">
          <div class="stat-label">当前筛选结果</div>
          <div class="stat-value">${filtered.length}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h2>全公司证照台账</h2>
          <span class="toolbar-hint">共 ${filtered.length} 条${keyword ? `，匹配「${Utils.escapeHtml(keyword)}」` : ''}</span>
        </div>
        <div class="card-body">
          <div class="table-wrapper has-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="col-select"><input type="checkbox" id="admin-select-all" onchange="CertAdmin.toggleSelectAll(this.checked)" title="全选当前列表"></th>
                  <th>公司</th>
                  <th>证照名称</th>
                  ${category ? '' : '<th>大类</th>'}
                  <th>类型</th>
                  ${category === 'company' ? '' : '<th>子分类</th>'}
                  ${category === 'company' ? '' : '<th>持证人</th>'}
                  ${category === 'personal' ? '<th>备注</th>' : ''}
                  <th>有效期至</th>
                  <th>状态</th>
                  ${category === 'company' ? '' : '<th>当年培训</th>'}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map(({ cert, st }) => this.renderCertRow(cert, st)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    this.updateSelectionUI();
  },

  /**
   * 渲染单行证照
   */
  renderCertRow(cert, st) {
    const cat = this.state.filters.category;
    const selected = this.state.selectedIds.includes(cert.id);
    const compactCompanyView = cat === 'company';
    const hideCategoryCol = !!cat;            // 公司/个人视图均隐藏「大类」，仅「全部」显示
    const showRemarkCol = cat === 'personal'; // 仅个人证照视图显示「备注」
    const rowCls = st.key === 'expired' ? 'row-danger'
      : st.key === 'expiring' ? 'row-warning' : '';
    const companyName = cert.departments ? cert.departments.name : '未分配';
    const subCol = Utils.subText(cert)
      ? Utils.escapeHtml(Utils.subText(cert))
      : '<span class="text-muted">—</span>';
    const ownerCol = cert.cert_category === 'personal'
      ? Utils.escapeHtml(cert.holder_name || '-')
      : '<span class="text-muted">—</span>';
    const validUntil = cert.is_long_term
      ? '<span class="text-muted">长期</span>'
      : Utils.formatDate(cert.valid_until);
    const remarkCol = cert.remark
      ? `<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${Utils.escapeHtml(cert.remark)}">${Utils.escapeHtml(cert.remark)}</td>`
      : '<td><span class="text-muted">—</span></td>';
    const trainingCol = Utils.trainingStatusBadge(cert.training_status);
    return `
      <tr class="${rowCls}">
        <td class="col-select"><input type="checkbox" class="admin-row-select" data-id="${cert.id}" ${selected ? 'checked' : ''} onchange="CertAdmin.toggleRowSelect('${cert.id}', this.checked)"></td>
        <td>${Utils.escapeHtml(companyName)}</td>
        <td><strong>${Utils.escapeHtml(cert.cert_name)}</strong></td>
        ${hideCategoryCol ? '' : `<td>${Utils.categoryLabel(cert.cert_category)}</td>`}
        <td>${Utils.typeChip(cert.cert_type)}</td>
        ${compactCompanyView ? '' : `<td>${subCol}</td>`}
        ${compactCompanyView ? '' : `<td>${ownerCol}</td>`}
        ${showRemarkCol ? remarkCol : ''}
        <td style="white-space:nowrap;">${validUntil}</td>
        <td><span class="badge ${st.badge}">${st.label}</span></td>
        ${compactCompanyView ? '' : `<td>${trainingCol}</td>`}
        <td style="white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="CertAdmin.showCertDetail('${cert.id}')">查看</button>
          <button class="btn btn-secondary btn-sm" onclick="CertAdmin.showCertForm('${cert.id}')">编辑</button>
          ${cert.status === 'active' ? `<button class="btn btn-secondary btn-sm" onclick="CertAdmin.showCertForm(null, '${cert.id}')" title="归档旧证并生成新证记录">换证</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="CertAdmin.handleDelete('${cert.id}')">删除</button>
        </td>
      </tr>
    `;
  },

  // ========================================================================
  // 批量调整培训状态（勾选多条证照 → 统一设置当年培训状态；选「已培训」自动补培训记录）
  // ========================================================================

  /**
   * 行复选框变化：维护选中集合
   */
  toggleRowSelect(id, checked) {
    const set = this.state.selectedIds;
    const idx = set.indexOf(id);
    if (checked && idx === -1) set.push(id);
    if (!checked && idx !== -1) set.splice(idx, 1);
    this.updateSelectionUI();
  },

  /**
   * 全选 / 取消全选：作用于当前已渲染（筛选后）的所有行
   */
  toggleSelectAll(checked) {
    const rows = document.querySelectorAll('#admin-certs-content .admin-row-select');
    rows.forEach(cb => {
      const id = cb.dataset.id;
      const idx = this.state.selectedIds.indexOf(id);
      if (checked && idx === -1) this.state.selectedIds.push(id);
      if (!checked && idx !== -1) this.state.selectedIds.splice(idx, 1);
      cb.checked = checked;
    });
    this.updateSelectionUI();
  },

  /**
   * 更新「全选」框状态与已选计数
   */
  updateSelectionUI() {
    const countEl = document.getElementById('admin-selected-count');
    if (countEl) countEl.textContent = `已选 ${this.state.selectedIds.length} 条`;
    const allBox = document.getElementById('admin-select-all');
    if (allBox) {
      const rows = document.querySelectorAll('#admin-certs-content .admin-row-select');
      const total = rows.length;
      const allChecked = total > 0 && this.state.selectedIds.length >= total;
      allBox.checked = allChecked;
      allBox.indeterminate = this.state.selectedIds.length > 0 && !allChecked;
    }
  },

  /**
   * 打开批量调整培训状态弹窗
   */
  openBatchTrainingModal() {
    if (!this.state.selectedIds.length) {
      Utils.toast('请先在列表中勾选至少一条证照', 'error');
      return;
    }
    const existing = document.getElementById('admin-batch-training-modal');
    if (existing) existing.remove();
    const year = new Date().getFullYear();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="admin-batch-training-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-batch-training-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>批量调整培训状态</h2>
            <button class="modal-close" onclick="CertAdmin.closeBatchTrainingModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="alert alert-info">
              已勾选 <strong>${this.state.selectedIds.length}</strong> 条证照。设置后，所有勾选证照的「当年培训状态」将更新为所选值。
            </div>
            <form id="admin-batch-training-form" onsubmit="return false">
              <div class="form-row">
                <label>目标状态 <span class="required">*</span></label>
                <select name="batch_training_status" onchange="CertAdmin.onBatchTrainingStatusChange()">
                  <option value="已培训">已培训</option>
                  <option value="无需培训">无需培训</option>
                  <option value="待培训">待培训</option>
                </select>
                <p class="hint">选择「已培训」时，下方可填写一条当年培训记录，系统会自动为每条勾选证照补入「历年培训情况」（若该证照当年已有培训记录则跳过，不重复插入）。</p>
              </div>
              <div id="admin-batch-training-extra">
                <div class="form-row">
                  <label>培训年份</label>
                  <input type="number" name="batch_training_year" min="2000" max="9999" value="${year}">
                </div>
                <div class="form-row">
                  <label>培训日期</label>
                  <input type="date" name="batch_training_date">
                </div>
                <div class="form-row">
                  <label>培训内容 <span class="required">*</span></label>
                  <input type="text" name="batch_training_content" maxlength="200" placeholder="如：安全生产法规年度培训" value="年度培训">
                </div>
                <div class="form-row">
                  <label>培训机构 / 组织</label>
                  <input type="text" name="batch_training_org" maxlength="100" placeholder="（选填）">
                </div>
                <div class="form-row">
                  <label>培训学时</label>
                  <input type="number" name="batch_training_hours" min="0" step="0.5" placeholder="（选填）">
                </div>
                <div class="form-row">
                  <label>培训结果 / 考核</label>
                  <input type="text" name="batch_training_result" maxlength="50" placeholder="（选填）如：合格">
                </div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="CertAdmin.closeBatchTrainingModal()">取消</button>
            <button class="btn btn-primary" onclick="CertAdmin.submitBatchTraining()">确定更新</button>
          </div>
        </div>
      </div>
    `);
  },

  /**
   * 切换目标状态时，控制「已培训」专属字段的显隐
   */
  onBatchTrainingStatusChange() {
    const sel = document.querySelector('#admin-batch-training-form [name="batch_training_status"]');
    const extra = document.getElementById('admin-batch-training-extra');
    if (!sel || !extra) return;
    extra.style.display = sel.value === '已培训' ? '' : 'none';
  },

  /**
   * 提交批量更新：更新培训状态；若选「已培训」则自动补当年培训记录
   */
  async submitBatchTraining() {
    const ids = this.state.selectedIds.slice();
    if (!ids.length) { Utils.toast('请先勾选至少一条证照', 'error'); return; }
    const form = document.getElementById('admin-batch-training-form');
    if (!form) return;
    const getStr = (n) => { const el = form.querySelector(`[name="${n}"]`); return el ? String(el.value).trim() : ''; };

    const status = getStr('batch_training_status');
    const btn = document.querySelector('#admin-batch-training-modal .modal-footer .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }

    try {
      // 1) 批量更新培训状态
      const { error: upErr } = await sb
        .from('certificates')
        .update({ training_status: status })
        .in('id', ids);
      if (upErr) throw upErr;

      // 同步内存中的状态，使台账徽章立即更新
      const idSet = new Set(ids);
      this.state.certs.forEach(c => { if (idSet.has(c.id)) c.training_status = status; });

      // 2) 选「已培训」时，自动补当年培训记录（已存在则跳过）
      let added = 0;
      if (status === '已培训') {
        const year = Number(getStr('batch_training_year')) || new Date().getFullYear();
        const date = getStr('batch_training_date') || null;
        const content = getStr('batch_training_content') || '年度培训';
        const org = getStr('batch_training_org') || null;
        const hoursRaw = getStr('batch_training_hours');
        const hours = hoursRaw === '' ? null : Number(hoursRaw);
        const result = getStr('batch_training_result') || null;

        // 查找这些证照在当年的已有培训记录，避免重复插入
        const { data: existing, error: exErr } = await sb
          .from('certificate_trainings')
          .select('certificate_id')
          .in('certificate_id', ids)
          .eq('training_year', year);
        if (exErr) throw exErr;
        const have = new Set((existing || []).map(t => t.certificate_id));

        const toInsert = ids
          .filter(id => !have.has(id))
          .map(id => ({
            certificate_id: id,
            training_year: year,
            training_date: date,
            training_content: content,
            training_org: org,
            hours: hours,
            training_result: result,
            created_by: (Auth.currentUser && Auth.currentUser.id) || null,
          }));
        if (toInsert.length) {
          const { error: insErr } = await sb.from('certificate_trainings').insert(toInsert);
          if (insErr) throw insErr;
          added = toInsert.length;
        }
      }

      Utils.toast(
        `已更新 ${ids.length} 条培训状态` + (status === '已培训' ? `，新增 ${added} 条当年培训记录` : ''),
        'success'
      );
      this.renderCerts();
      this.state.selectedIds = [];
      this.updateSelectionUI();
      this.closeBatchTrainingModal();
    } catch (e) {
      Utils.toast('批量更新失败：' + (e.message || e), 'error');
      if (btn) { btn.disabled = false; btn.textContent = '确定更新'; }
    }
  },

  /**
   * 关闭批量调整培训状态弹窗
   */
  closeBatchTrainingModal() {
    const modal = document.getElementById('admin-batch-training-modal');
    if (modal) modal.remove();
  },

  /**
   * 工具栏「工具」下拉菜单：切换显示 / 隐藏
   */
  toggleToolbarDropdown(e) {
    e.stopPropagation();
    const menu = document.getElementById('admin-toolbar-menu');
    const open = menu.classList.contains('open');
    // 先关闭所有其他下拉
    this.closeToolbarDropdown();
    if (!open) {
      menu.classList.add('open');
    }
  },

  /** 关闭工具栏下拉菜单 */
  closeToolbarDropdown() {
    const menu = document.getElementById('admin-toolbar-menu');
    if (menu) menu.classList.remove('open');
  },

  /**
   * 按证照类型规则批量初始化 / 校正「当年培训状态」
   * 规则（见 Utils.trainingRequirement）：
   *  - 公司证照 → 无需培训
   *  - 特种作业人员资格证（应急局/住建局）、安全生产考核合格证书 → 无需培训
   *  - 非煤矿山安全管理人员证书、爆破作业人员许可证等需年培个人证照 → 待培训
   * 非破坏式：保留已明确填写的「已培训」；仅把「空 / 误填为无需培训」的应培项校正为「待培训」，
   * 并把本就无需培训的类型统一置为「无需培训」。
   */
  async initTrainingStatusByRule() {
    const certs = this.state.certs || [];
    if (!certs.length) { Utils.toast('暂无证照数据', 'error'); return; }
    if (!confirm(
      '将按以下规则设置培训状态：\n' +
      '· 公司证照 → 无需培训\n' +
      '· 特种作业人员资格证（应急局/住建局）、安全生产考核合格证书 → 无需培训\n' +
      '· 非煤矿山安全管理人员证书、爆破作业人员许可证等需年培个人证照 → 待培训（原「已培训」保留）\n\n' +
      '仅校正「无需培训/空」的应培项为待培训，不会清除已填的「已培训」。是否继续？'
    )) return;

    const noneIds = [];
    const annualFillIds = [];
    for (const c of certs) {
      const req = Utils.trainingRequirement(c.cert_category, c.cert_type, c.sub1_value);
      if (req === 'none') {
        noneIds.push(c.id);
      } else if (req === 'annual') {
        // 需年培：空或「无需培训」(误填) → 待培训；已培训/待培训保留
        if (!c.training_status || c.training_status === '无需培训') {
          annualFillIds.push(c.id);
        }
      }
    }

    try {
      if (noneIds.length) {
        const { error } = await sb.from('certificates').update({ training_status: '无需培训' }).in('id', noneIds);
        if (error) throw error;
      }
      if (annualFillIds.length) {
        const { error } = await sb.from('certificates').update({ training_status: '待培训' }).in('id', annualFillIds);
        if (error) throw error;
      }
      const noneSet = new Set(noneIds);
      const annualSet = new Set(annualFillIds);
      this.state.certs.forEach(c => {
        if (noneSet.has(c.id)) c.training_status = '无需培训';
        else if (annualSet.has(c.id)) c.training_status = '待培训';
      });
      this.renderCerts();
      Utils.toast(
        `已按规则更新：无需培训 ${noneIds.length} 条，待培训 ${annualFillIds.length} 条`,
        'success'
      );
    } catch (e) {
      Utils.toast('初始化失败：' + (e.message || e), 'error');
    }
  },

  /**
   * 导出台账 CSV（按当前筛选结果）
   */
  exportCSV() {
    const { company, category, type, status, keyword } = this.state.filters;
    const filtered = this.state.certs
      .map(c => ({ cert: c, st: this.statusOf(c) }))
      .filter(({ cert, st }) =>
        (!company || cert.department_id === company)
        && (!category || cert.cert_category === category)
        && (!type || cert.cert_type === type)
        && (!status || st.key === status)
        && this.matchKeyword(cert, keyword));

    if (filtered.length === 0) {
      Utils.toast('当前筛选下暂无数据可导出', 'error');
      return;
    }

    const columns = [
      { key: 'index', label: '序号' },
      { key: 'company_name', label: '所属公司' },
      { key: 'cert_name', label: '证照名称' },
      { key: 'category_label', label: '证照大类' },
      { key: 'cert_type', label: '证照类型' },
      { key: 'sub_text', label: '子分类' },
      { key: 'cert_no', label: '证照编号' },
      { key: 'issuing_authority', label: '发证机关' },
      { key: 'issue_date', label: '发证日期' },
      { key: 'valid_from', label: '有效期起' },
      { key: 'valid_until_label', label: '有效期止' },
      { key: 'is_long_term', label: '长期有效' },
      { key: 'holder_name', label: '持证人' },
      { key: 'holder_id_no', label: '证件号' },
      { key: 'holder_position', label: '职务/岗位' },
      { key: 'status_label', label: '状态' },
      { key: 'remark', label: '备注' },
      { key: 'created_at', label: '登记时间' },
    ];

    const exportData = filtered.map(({ cert, st }, i) => ({
      index: i + 1,
      company_name: cert.departments ? cert.departments.name : '未分配',
      cert_name: cert.cert_name,
      category_label: Utils.categoryLabel(cert.cert_category),
      cert_type: cert.cert_type,
      sub_text: Utils.subText(cert),
      cert_no: cert.cert_no,
      issuing_authority: cert.issuing_authority || '',
      issue_date: cert.issue_date || '',
      valid_from: cert.valid_from || '',
      valid_until_label: cert.is_long_term ? '长期有效' : (cert.valid_until || ''),
      is_long_term: cert.is_long_term,
      holder_name: cert.holder_name || '',
      holder_id_no: cert.holder_id_no || '',
      holder_position: cert.holder_position || '',
      status_label: st.label,
      remark: cert.remark || '',
      created_at: Utils.formatDateTime(cert.created_at),
    }));

    const filename = `资质证照台账_${Utils.formatDate(new Date())}.csv`;
    Utils.exportCSV(exportData, filename, columns);
    Utils.toast(`已导出 ${filtered.length} 条记录`, 'success');
  },

  // ========================================================================
  // 证照详情（含换证历史 + 附件管理）
  // ========================================================================

  /**
   * 按类型名称取类型定义（含子分类维度；优先数据库字典，兜底默认值）
   */
  typeDefFor(typeName) {
    if (!typeName) return null;
    if (this.state.types && this.state.types.length > 0) {
      return this.state.types.find(t => t.name === typeName) || null;
    }
    return this.DEFAULT_CERT_TYPES.find(t => t.name === typeName) || null;
  },

  /**
   * 查看证照详情
   */
  showCertDetail(id) {
    const cert = this.state.certs.find(c => c.id === id);
    if (!cert) {
      Utils.toast('未找到该证照记录', 'error');
      return;
    }
    this.state.detailId = id;
    this.state.detailFiles = [];

    const st = this.statusOf(cert);
    const days = Utils.daysUntil(cert.valid_until);
    const item = (label, valueHTML) => `
      <div class="detail-item">
        <div class="detail-label">${label}</div>
        <div class="detail-value">${valueHTML}</div>
      </div>
    `;
    const text = (v) => (v == null || v === '') ? '<span class="detail-empty">—</span>' : Utils.escapeHtml(v);

    // 子分类展示（按类型字典的维度名称；类型已变更但历史值仍保留展示）
    const def = this.typeDefFor(cert.cert_type);
    const sub1Label = (def && def.sub1_label) || '子分类';
    const sub2Label = (def && def.sub2_label) || '子分类2';

    const validUntilHTML = cert.is_long_term
      ? '<span class="badge badge-success">长期有效</span>'
      : `${text(cert.valid_until)}${days != null && cert.status === 'active'
          ? (days < 0 ? ` <span class="badge badge-danger">已过期 ${Math.abs(days)} 天</span>`
            : ` <span class="badge ${days <= this.state.warnDays ? 'badge-warning' : 'badge-success'}">剩余 ${days} 天</span>`)
          : ''}`;

    // 换证历史链（沿 renewed_from 向上追溯 + 向下找新证）
    const chain = this.buildRenewalChain(cert);

    // 公司证照无需培训：详情中不展示「当年培训状态」与「历年培训情况」
    const trainingSection = cert.cert_category === 'company' ? '' : `
            <div class="detail-section">
              <h3>历年培训情况</h3>
              <div id="admin-cert-trainings-list" class="trainings-list">
                <div class="empty-state" style="padding:16px;"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;">培训记录加载中...</p></div>
              </div>
              <div class="trainings-actions">
                <button class="btn btn-primary btn-sm" onclick="CertAdmin.openTrainingForm('${cert.id}')">+ 添加培训记录</button>
              </div>
            </div>`;

    const modalHTML = `
      <div class="modal-overlay" id="admin-cert-detail-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-cert-detail-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>证照详情：${Utils.escapeHtml(cert.cert_name)}</h2>
            <button class="modal-close" onclick="CertAdmin.closeDetailModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              ${item('所属公司', text(cert.departments ? cert.departments.name : ''))}
              ${item('状态', `<span class="badge ${st.badge}">${st.label}</span>`)}
              ${item('证照大类', Utils.categoryLabel(cert.cert_category))}
              ${item('证照类型', text(cert.cert_type))}
              ${((def && def.sub1_label) || cert.sub1_value) ? item(sub1Label, text(cert.sub1_value)) : ''}
              ${((def && def.sub2_label) || cert.sub2_value) ? item(sub2Label, text(cert.sub2_value)) : ''}
              ${item('证照编号', text(cert.cert_no))}
              ${item('发证机关', text(cert.issuing_authority))}
              ${item('发证日期', text(cert.issue_date))}
              ${item('有效期起', text(cert.valid_from))}
              ${item('有效期止', validUntilHTML)}
              ${cert.cert_category === 'personal' ? item('持证人', text(cert.holder_name)) : ''}
              ${cert.cert_category === 'personal' ? item('证件号', text(cert.holder_id_no)) : ''}
              ${cert.cert_category === 'personal' ? item('职务 / 岗位', text(cert.holder_position)) : ''}
              ${item('备注', text(cert.remark))}
              ${cert.cert_category === 'company' ? '' : item('当年培训状态', Utils.trainingStatusBadge(cert.training_status))}
              ${item('登记时间', Utils.formatDateTime(cert.created_at))}
            </div>

            ${chain.length > 1 ? `
            <div class="detail-section">
              <h3>换证历史</h3>
              <ol class="renewal-chain">
                ${chain.map((c, i) => `
                  <li class="${c.id === cert.id ? 'current' : ''}">
                    <span class="badge ${this.statusOf(c).badge}">${this.statusOf(c).label}</span>
                    ${Utils.escapeHtml(c.cert_no || '')}
                    <span class="text-muted">${c.valid_until ? Utils.formatDate(c.valid_until) + ' 到期' : (c.is_long_term ? '长期有效' : '')}</span>
                    ${i === chain.length - 1 && c.id === cert.id && c.renewed_at ? `<span class="text-muted">（${Utils.formatDateTime(c.renewed_at)} 换证）</span>` : ''}
                  </li>
                `).join('')}
              </ol>
            </div>` : ''}

            ${trainingSection}

            <div class="detail-section">
              <h3>证照附件（扫描件）</h3>
              <div id="admin-cert-files-list" class="cert-files-list">
                <div class="empty-state" style="padding:16px;"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;">附件加载中...</p></div>
              </div>
              <div class="cert-files-upload">
                <input type="file" id="admin-cert-file-input" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" style="display:none;" onchange="CertAdmin.onFileSelected(event)">
                <button class="btn btn-primary btn-sm" onclick="document.getElementById('admin-cert-file-input').click()">上传附件</button>
                <span class="toolbar-hint">支持 PDF / PNG / JPG / WebP，单个文件不超过 10MB</span>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="CertAdmin.closeDetailModal()">关闭</button>
            <button class="btn btn-primary" onclick="CertAdmin.editFromDetail('${cert.id}')">编辑此证照</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('admin-cert-detail-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    this.loadDetailFiles(id);
    this.loadDetailTrainings(id);
  },

  /**
   * 加载详情附件列表
   */
  async loadDetailFiles(certId) {
    const listEl = document.getElementById('admin-cert-files-list');
    if (!listEl || this.state.detailId !== certId) return;

    const { data, error } = await sb
      .from('certificate_files')
      .select('*')
      .eq('certificate_id', certId)
      .order('created_at', { ascending: false });

    if (error) {
      listEl.innerHTML = `<div class="alert alert-danger">附件加载失败：${Utils.escapeHtml(error.message)}</div>`;
      return;
    }
    this.state.detailFiles = data || [];

    if (this.state.detailFiles.length === 0) {
      listEl.innerHTML = `<p class="text-muted" style="padding:8px 0;">该证照暂无附件，可点击下方按钮上传证照扫描件。</p>`;
      return;
    }
    listEl.innerHTML = this.state.detailFiles.map((f, i) => `
      <div class="cert-file-item">
        <span class="cert-file-icon">${Utils.isImageFile(f.content_type, f.file_name) ? '🖼️' : '📄'}</span>
        <div class="cert-file-info">
          <div class="cert-file-name" title="${Utils.escapeHtml(f.file_name)}">${Utils.escapeHtml(f.file_name)}</div>
          <div class="cert-file-meta">${Utils.formatFileSize(f.file_size)} · ${Utils.formatDateTime(f.created_at)}</div>
        </div>
        <div class="cert-file-actions">
          <button class="btn btn-secondary btn-sm" onclick="CertAdmin.previewFile(${i})">预览</button>
          <button class="btn btn-secondary btn-sm" onclick="CertAdmin.downloadFile(${i})">下载</button>
          <button class="btn btn-danger btn-sm" onclick="CertAdmin.deleteFile(${i})">删除</button>
        </div>
      </div>
    `).join('');
  },

  /**
   * 生成附件签名 URL
   */
  async signedUrl(file) {
    const { data, error } = await sb.storage
      .from(CERT_STORAGE_BUCKET)
      .createSignedUrl(file.storage_path, 3600);
    if (error || !data) {
      Utils.toast('获取文件访问链接失败: ' + (error ? error.message : '未知错误'), 'error');
      return null;
    }
    return data.signedUrl;
  },

  /**
   * 预览附件（图片弹窗 / PDF 新窗口）
   */
  async previewFile(index) {
    const file = this.state.detailFiles[index];
    if (!file) return;
    const url = await this.signedUrl(file);
    if (!url) return;

    if (Utils.isImageFile(file.content_type, file.file_name)) {
      const existing = document.getElementById('admin-file-preview-modal');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay" id="admin-file-preview-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-file-preview-modal')">
          <div class="modal-card modal-lg file-preview-card">
            <div class="modal-header">
              <h2>${Utils.escapeHtml(file.file_name)}</h2>
              <button class="modal-close" onclick="CertAdmin.closePreviewModal()">&times;</button>
            </div>
            <div class="modal-body file-preview-body">
              <img src="${url}" alt="${Utils.escapeHtml(file.file_name)}">
            </div>
          </div>
        </div>
      `);
    } else {
      window.open(url, '_blank');
    }
  },

  /**
   * 关闭图片预览弹窗
   */
  closePreviewModal() {
    const modal = document.getElementById('admin-file-preview-modal');
    if (modal) modal.remove();
  },

  /**
   * 下载附件
   */
  async downloadFile(index) {
    const file = this.state.detailFiles[index];
    if (!file) return;
    const url = await this.signedUrl(file);
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = file.file_name;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  },

  /**
   * 从详情弹窗进入编辑
   */
  editFromDetail(id) {
    this.closeDetailModal();
    this.showCertForm(id);
  },

  /**
   * 构建换证历史链（从最早的祖先到当前证照）
   */
  buildRenewalChain(cert) {
    const byId = new Map(this.state.certs.map(c => [c.id, c]));
    // 向上追溯
    let head = cert;
    const guard = new Set();
    while (head.renewed_from && byId.has(head.renewed_from) && !guard.has(head.renewed_from)) {
      guard.add(head.renewed_from);
      head = byId.get(head.renewed_from);
    }
    // 从祖先向当前下钻
    const chain = [];
    let cur = head;
    const guard2 = new Set();
    while (cur && !guard2.has(cur.id)) {
      guard2.add(cur.id);
      chain.push(cur);
      const next = this.state.certs.find(c => c.renewed_from === cur.id);
      cur = next || null;
    }
    return chain;
  },

  /**
   * 附件选择（上传入口）
   */
  onFileSelected(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;
    this.uploadFiles(files);
    // 清空 input，保证选择同名文件也能再次触发 onchange
    event.target.value = '';
  },

  /**
   * 上传附件到 Storage 并登记 certificate_files
   * 存储路径：{证照所属公司ID}/{证照ID}/{时间戳+随机数}.{ext}
   */
  async uploadFiles(files) {
    const certId = this.state.detailId;
    if (!certId) return;
    const cert = this.state.certs.find(c => c.id === certId);
    if (!cert || !cert.department_id) {
      Utils.toast('证照信息异常（缺少所属公司），无法上传', 'error');
      return;
    }

    for (const file of files) {
      // 校验类型
      const okType = CERT_FILE_TYPES.includes(file.type) || /\.(pdf|png|jpe?g|webp)$/i.test(file.name);
      if (!okType) {
        Utils.toast(`「${file.name}」格式不支持，仅支持 PDF / PNG / JPG / WebP`, 'error');
        continue;
      }
      // 校验大小
      if (file.size > CERT_FILE_MAX_SIZE) {
        Utils.toast(`「${file.name}」超过 10MB 限制`, 'error');
        continue;
      }

      const ext = (file.name.match(/\.[^.]+$/) || [''])[0];
      const storagePath = `${cert.department_id}/${certId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;

      const { error: upError } = await sb.storage
        .from(CERT_STORAGE_BUCKET)
        .upload(storagePath, file, { contentType: file.type || undefined, upsert: false });

      if (upError) {
        Utils.toast(`「${file.name}」上传失败: ${upError.message}`, 'error');
        continue;
      }

      const { error: dbError } = await sb
        .from('certificate_files')
        .insert({
          certificate_id: certId,
          file_name: file.name,
          storage_path: storagePath,
          file_size: file.size,
          content_type: file.type || null,
          uploaded_by: Auth.currentUser.id,
        });

      if (dbError) {
        // 数据库登记失败时回滚已上传对象，避免孤儿文件
        await sb.storage.from(CERT_STORAGE_BUCKET).remove([storagePath]);
        Utils.toast(`「${file.name}」登记失败: ${dbError.message}`, 'error');
        continue;
      }
      Utils.toast(`「${file.name}」上传成功`, 'success');
    }

    await this.loadDetailFiles(certId);
  },

  /**
   * 删除附件（Storage 对象 + 记录）
   */
  async deleteFile(index) {
    const file = this.state.detailFiles[index];
    if (!file) return;
    if (!confirm(`确定要删除附件「${file.file_name}」吗？此操作不可撤销。`)) return;

    const { error: delError } = await sb.storage
      .from(CERT_STORAGE_BUCKET)
      .remove([file.storage_path]);
    if (delError) {
      Utils.toast('删除文件失败: ' + delError.message, 'error');
      return;
    }
    const { error: dbError } = await sb
      .from('certificate_files')
      .delete()
      .eq('id', file.id);
    if (dbError) {
      Utils.toast('删除附件记录失败: ' + dbError.message, 'error');
      return;
    }
    Utils.toast('附件已删除', 'success');
    await this.loadDetailFiles(file.certificate_id);
  },

  /**
   * 关闭详情弹窗
   */
  closeDetailModal() {
    const modal = document.getElementById('admin-cert-detail-modal');
    if (modal) modal.remove();
    this.state.detailId = null;
    this.state.detailFiles = [];
  },

  // ========================================================================
  // 证照新增 / 编辑 / 删除 / 换证（v3 权限模型：仅管理员可写）
  // ========================================================================

  /**
   * 取指定大类的类型选项（字典为空时用默认值兜底；编辑时包含证照当前类型即使已停用）
   */
  typeOptionsFor(category, includeType = null) {
    const source = (this.state.types && this.state.types.length > 0)
      ? this.state.types
      : this.DEFAULT_CERT_TYPES;
    const list = source
      .filter(t => t.category === category && t.is_active !== false)
      .map(t => t.name);
    if (includeType && !list.includes(includeType)) {
      list.unshift(includeType);
    }
    return list;
  },

  /**
   * 显示证照表单（新建 / 编辑 / 换证；管理员可指定所属公司）
   * @param {string|null} certId 编辑的证照 ID
   * @param {string|null} renewFromId 换证来源证照 ID（旧证将被归档为"已换证"）
   */
  showCertForm(certId = null, renewFromId = null) {
    if (this.state.companies.length === 0) {
      Utils.toast('公司列表为空，请先在 Supabase 执行 sql/schema.sql 注册公司', 'error');
      return;
    }

    this.state.editingId = certId;
    this.state.renewingFrom = renewFromId;

    let cert = null;
    if (certId) {
      cert = this.state.certs.find(c => c.id === certId);
      if (!cert) {
        Utils.toast('未找到该证照记录', 'error');
        return;
      }
    } else if (renewFromId) {
      // 换证：预填旧证信息，待填新有效期
      cert = this.state.certs.find(c => c.id === renewFromId);
      if (!cert) {
        Utils.toast('未找到原证照记录', 'error');
        return;
      }
    }

    const v = cert || {};
    const isRenew = !!renewFromId;
    const isEdit = !!certId;
    const category = v.cert_category || 'company';
    // 所属公司默认值：编辑/换证取原值，新建取当前筛选的公司或第一家公司
    const defaultCompany = v.department_id
      || this.state.filters.company
      || (this.state.companies[0] ? this.state.companies[0].id : '');
    // 换证时清空有效期（新证有效期重新填写），编号也通常变化，保留可改
    const defValidFrom = isRenew ? '' : (v.valid_from || '');
    const defValidUntil = isRenew ? '' : (v.valid_until || '');

    const title = isRenew
      ? `换证登记：${v.cert_name}`
      : isEdit ? '编辑证照' : '新增证照';

    const typeOptions = this.typeOptionsFor(category, v.cert_type || null);
    const sel = (val, opt) => (String(val) === String(opt) ? 'selected' : '');

    const modalHTML = `
      <div class="modal-overlay" id="admin-cert-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-cert-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>${Utils.escapeHtml(title)}</h2>
            <button class="modal-close" onclick="CertAdmin.closeCertModal()">&times;</button>
          </div>
          <div class="modal-body">
            ${isRenew ? `
            <div class="alert alert-info" style="margin-bottom:16px;">
              换证提交后：<strong>${Utils.escapeHtml(v.cert_name)}</strong>（编号 ${Utils.escapeHtml(v.cert_no)}）将归档为「已换证」，并生成一条新证照记录，新记录将关联旧证形成换证历史。
            </div>` : ''}
            <form id="admin-cert-form" onsubmit="return false">
              <div class="form-grid">
                <div class="form-group">
                  <label>所属公司 <span class="required">*</span></label>
                  <select name="department_id" required>
                    <option value="">-- 请选择 --</option>
                    ${this.state.companies.map(d => `
                      <option value="${d.id}" ${sel(defaultCompany, d.id)}>${Utils.escapeHtml(d.name)}</option>
                    `).join('')}
                  </select>
                </div>
                <div class="form-group">
                  <label>证照大类 <span class="required">*</span></label>
                  <select name="cert_category" required onchange="CertAdmin.onCategoryChange()">
                    <option value="company" ${sel(category, 'company')}>公司证照</option>
                    <option value="personal" ${sel(category, 'personal')}>个人证照</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>证照类型 <span class="required">*</span></label>
                  <select name="cert_type" id="admin-cert-type-select" required onchange="CertAdmin.onTypeChange()">
                    <option value="">-- 请选择 --</option>
                    ${typeOptions.map(t => `<option value="${Utils.escapeHtml(t)}" ${sel(v.cert_type, t)}>${Utils.escapeHtml(t)}</option>`).join('')}
                  </select>
                </div>
                <!-- 子分类（跟随所选类型动态渲染，display:contents 使其成为网格直接子项） -->
                <div id="admin-cert-sub-fields" style="display:contents;"></div>
                <div class="form-group col-span-2">
                  <label>证照名称 <span class="required">*</span></label>
                  <input type="text" name="cert_name" required maxlength="100" placeholder="请输入证照全称" value="${Utils.escapeHtml(v.cert_name || '')}">
                </div>
                <div class="form-group">
                  <label>证照编号</label>
                  <input type="text" name="cert_no" maxlength="100" placeholder="（选填）可留空，后期补填" value="${Utils.escapeHtml(v.cert_no || '')}">
                </div>
                <div class="form-group">
                  <label>发证机关</label>
                  <input type="text" name="issuing_authority" maxlength="100" placeholder="（选填）发证机关" value="${Utils.escapeHtml(v.issuing_authority || '')}">
                </div>
                <div class="form-group">
                  <label>发证日期</label>
                  <input type="date" name="issue_date" value="${Utils.escapeHtml(v.issue_date || '')}">
                </div>
                <div class="form-group">
                  <label>有效期起</label>
                  <input type="date" name="valid_from" value="${Utils.escapeHtml(defValidFrom)}">
                </div>
                <div class="form-group">
                  <label>有效期止</label>
                  <input type="date" name="valid_until" id="admin-cert-valid-until" value="${Utils.escapeHtml(defValidUntil)}" ${v.is_long_term ? 'disabled' : ''}>
                </div>
                <div class="form-group cert-longterm-group">
                  <label class="checkbox-label">
                    <input type="checkbox" name="is_long_term" id="admin-cert-long-term" ${v.is_long_term ? 'checked' : ''} onchange="CertAdmin.onLongTermChange()">
                    长期有效（勾选后无需填写有效期止）
                  </label>
                </div>
                <!-- 个人证照专属 -->
                <div class="form-group cert-field-person" ${category === 'personal' ? '' : 'style="display:none;"'}>
                  <label>持证人姓名</label>
                  <input type="text" name="holder_name" maxlength="50" placeholder="（个人证照）持证人姓名" value="${Utils.escapeHtml(v.holder_name || '')}">
                </div>
                <div class="form-group cert-field-person" ${category === 'personal' ? '' : 'style="display:none;"'}>
                  <label>证件号</label>
                  <input type="text" name="holder_id_no" maxlength="30" placeholder="（个人证照）身份证 / 证件号" value="${Utils.escapeHtml(v.holder_id_no || '')}">
                  <p class="hint">列表脱敏展示，详情弹窗与管理员导出可见完整号码</p>
                </div>
                <div class="form-group cert-field-person" ${category === 'personal' ? '' : 'style="display:none;"'}>
                  <label>职务 / 岗位</label>
                  <input type="text" name="holder_position" maxlength="50" placeholder="（个人证照）职务或岗位" value="${Utils.escapeHtml(v.holder_position || '')}">
                </div>
                <div class="form-group">
                  <label>证照状态 <span class="required">*</span></label>
                  <select name="status" required ${isRenew ? 'disabled' : ''}>
                    <option value="active" ${sel(v.status || 'active', 'active')}>在用</option>
                    <option value="revoked" ${sel(v.status, 'revoked')}>已注销</option>
                    ${isEdit && v.status === 'replaced' ? '<option value="replaced" selected>已换证（归档）</option>' : ''}
                  </select>
                  ${isRenew ? '<p class="hint">换证生成的新记录状态为「在用」，旧证自动归档</p>' : ''}
                </div>
                <div class="form-group">
                  <label>当年培训状态</label>
                  <select name="training_status">
                    <option value="">-- 请选择 --</option>
                    <option value="已培训" ${sel(v.training_status, '已培训')}>已培训</option>
                    <option value="无需培训" ${sel(v.training_status, '无需培训')}>无需培训</option>
                    <option value="待培训" ${sel(v.training_status, '待培训')}>待培训</option>
                  </select>
                  <p class="hint">系统按证照类型自动默认（公司证照及无需年培的特定个人证照→无需培训；需年培个人证照→待培训），可手动调整</p>
                </div>
                <div class="form-group col-span-2">
                  <label>备注</label>
                  <textarea name="remark" rows="2" maxlength="500" placeholder="（选填）备注信息">${Utils.escapeHtml(v.remark || '')}</textarea>
                </div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="CertAdmin.closeCertModal()">取消</button>
            <button class="btn btn-primary" onclick="CertAdmin.handleSubmit()">${isRenew ? '提交换证' : isEdit ? '保存修改' : '新增证照'}</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('admin-cert-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
    // 按当前类型渲染子分类下拉（编辑/换证时回显已选值）
    this.renderSubFields(v.cert_type || '', { sub1: v.sub1_value || '', sub2: v.sub2_value || '' });
  },

  /**
   * 按所选类型渲染子分类下拉（无子分类维度时清空容器）
   * @param {string} typeName 类型名称
   * @param {{sub1: string, sub2: string}} values 已选值（编辑/换证回显）
   */
  renderSubFields(typeName, values) {
    const container = document.getElementById('admin-cert-sub-fields');
    if (!container) return;
    const def = this.typeDefFor(typeName);
    if (!def || !def.sub1_label) {
      container.innerHTML = '';
      return;
    }
    const mk = (label, options, name, val, onchange) => `
      <div class="form-group">
        <label>${Utils.escapeHtml(label)} <span class="required">*</span></label>
        <select name="${name}" required${onchange ? ` onchange="${onchange}"` : ''}>
          <option value="">-- 请选择 --</option>
          ${(options || []).map(o => `<option value="${Utils.escapeHtml(o)}" ${String(o) === String(val || '') ? 'selected' : ''}>${Utils.escapeHtml(o)}</option>`).join('')}
        </select>
      </div>
    `;
    let html = mk(def.sub1_label, def.sub1_options, 'sub1_value', values.sub1, 'CertAdmin.applyTrainingDefaultFromForm()');
    if (def.sub2_label) {
      html += mk(def.sub2_label, def.sub2_options, 'sub2_value', values.sub2);
    }
    container.innerHTML = html;
    // 子分类渲染后，依据当前大类/类型/子分类自动默认培训状态
    this.applyTrainingDefaultFromForm();
  },

  /**
   * 依据表单当前选择的大类 / 类型 / 子分类，自动填充「当年培训状态」默认值
   * （仅当该下拉当前为空时填充，避免覆盖用户/已保存的明确选择）
   */
  applyTrainingDefaultFromForm() {
    const form = document.getElementById('admin-cert-form');
    if (!form) return;
    const ts = form.elements['training_status'];
    if (!ts || ts.value) return; // 已选则不打扰
    const category = form.elements['cert_category'] ? form.elements['cert_category'].value : '';
    const type = form.elements['cert_type'] ? form.elements['cert_type'].value : '';
    const sub1 = form.elements['sub1_value'] ? form.elements['sub1_value'].value : '';
    ts.value = Utils.trainingDefaultStatus(category, type, sub1);
  },

  /**
   * 大类切换：联动类型下拉选项 + 子分类 + 个人证照专属字段显隐
   */
  onCategoryChange() {
    const form = document.getElementById('admin-cert-form');
    if (!form) return;
    const category = form.cert_category.value;
    const typeSelect = document.getElementById('admin-cert-type-select');
    if (typeSelect) {
      typeSelect.innerHTML = '<option value="">-- 请选择 --</option>' +
        this.typeOptionsFor(category)
          .map(t => `<option value="${Utils.escapeHtml(t)}">${Utils.escapeHtml(t)}</option>`)
          .join('');
      typeSelect.value = '';
    }
    // 大类变化后类型已重置，子分类一并清空
    this.renderSubFields('', { sub1: '', sub2: '' });
    form.querySelectorAll('.cert-field-person').forEach(el => {
      el.style.display = category === 'personal' ? '' : 'none';
    });
  },

  /**
   * 类型切换：按新类型的子分类维度重新渲染下拉（尽量保留已选值）
   */
  onTypeChange() {
    const typeSelect = document.getElementById('admin-cert-type-select');
    if (!typeSelect) return;
    const form = document.getElementById('admin-cert-form');
    const prev1 = form && form.elements['sub1_value'] ? form.elements['sub1_value'].value : '';
    const prev2 = form && form.elements['sub2_value'] ? form.elements['sub2_value'].value : '';
    this.renderSubFields(typeSelect.value, { sub1: prev1, sub2: prev2 });
  },

  /**
   * 长期有效切换：禁用/清空有效期止
   */
  onLongTermChange() {
    const chk = document.getElementById('admin-cert-long-term');
    const until = document.getElementById('admin-cert-valid-until');
    if (!chk || !until) return;
    if (chk.checked) {
      until.value = '';
      until.disabled = true;
    } else {
      until.disabled = false;
    }
  },

  /**
   * 表单校验（补充跨字段规则；必填项由原生 required 保证）
   */
  validateForm(data) {
    if (!data.department_id) {
      return { valid: false, message: '请选择所属公司' };
    }
    // 有效期止可留空（批量导入或新增后待后期编辑补全），仅校验填写后的先后关系
    if (data.valid_from && data.valid_until && data.valid_until < data.valid_from) {
      return { valid: false, message: '有效期止不能早于有效期起' };
    }
    if (data.cert_category === 'personal' && !data.holder_name) {
      return { valid: false, message: '个人证照请填写持证人姓名' };
    }
    return { valid: true };
  },

  /**
   * 收集表单数据
   */
  collectFormData() {
    const form = document.getElementById('admin-cert-form');
    const fd = new FormData(form);
    const str = (k) => {
      const v = fd.get(k);
      return v == null ? '' : String(v).trim();
    };
    return {
      department_id: str('department_id') || null,
      cert_category: str('cert_category') || 'company',
      cert_type: str('cert_type'),
      cert_name: str('cert_name'),
      cert_no: str('cert_no'),
      sub1_value: str('sub1_value') || null,
      sub2_value: str('sub2_value') || null,
      issuing_authority: str('issuing_authority') || null,
      issue_date: str('issue_date') || null,
      valid_from: str('valid_from') || null,
      valid_until: str('valid_until') || null,
      is_long_term: !!fd.get('is_long_term'),
      holder_name: str('holder_name') || null,
      holder_id_no: str('holder_id_no') || null,
      holder_position: str('holder_position') || null,
      status: ['revoked', 'replaced'].includes(str('status')) ? str('status') : 'active',
      training_status: str('training_status') || null,
      remark: str('remark') || null,
    };
  },

  /**
   * 提交表单（新增 / 编辑 / 换证）
   */
  async handleSubmit() {
    const form = document.getElementById('admin-cert-form');
    if (form && !form.reportValidity()) return;

    const data = this.collectFormData();
    const validation = this.validateForm(data);
    if (!validation.valid) {
      Utils.toast(validation.message, 'error');
      return;
    }

    // 提交按钮禁用
    const submitBtn = document.querySelector('#admin-cert-modal .modal-footer .btn-primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中...';
    }
    const resetBtn = (text) => {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = text; }
    };

    // ---- 换证模式：先归档旧证，再插入新证；插入失败回滚旧证状态 ----
    if (this.state.renewingFrom) {
      const oldId = this.state.renewingFrom;
      const { error: updError } = await sb
        .from('certificates')
        .update({ status: 'replaced', renewed_at: new Date().toISOString() })
        .eq('id', oldId);
      if (updError) {
        Utils.toast('归档旧证失败: ' + updError.message, 'error');
        resetBtn('提交换证');
        return;
      }
      const { error: insError } = await sb
        .from('certificates')
        .insert({
          ...data,
          renewed_from: oldId,
          created_by: Auth.currentUser.id,
        });
      if (insError) {
        Utils.toast('生成新证记录失败: ' + insError.message, 'error');
        // 回滚旧证归档
        await sb.from('certificates')
          .update({ status: 'active', renewed_at: null })
          .eq('id', oldId);
        resetBtn('提交换证');
        return;
      }
      Utils.toast('换证完成：旧证已归档，新证已登记', 'success');
      this.closeCertModal();
      await this.loadData();
      return;
    }

    // ---- 新增 / 编辑模式 ----
    if (this.state.editingId) {
      const { error } = await sb
        .from('certificates')
        .update({ ...data })
        .eq('id', this.state.editingId);
      if (error) {
        Utils.toast('保存失败: ' + error.message, 'error');
        resetBtn('保存修改');
        return;
      }
      Utils.toast('证照信息已更新', 'success');
    } else {
      const { error } = await sb
        .from('certificates')
        .insert({
          ...data,
          created_by: Auth.currentUser.id,
        });
      if (error) {
        Utils.toast('新增失败: ' + error.message, 'error');
        resetBtn('新增证照');
        return;
      }
      Utils.toast('证照已登记', 'success');
    }

    this.closeCertModal();
    await this.loadData();
  },

  /**
   * 删除证照（先删 Storage 附件对象，再删证照记录；附件记录随外键 CASCADE 删除）
   */
  async handleDelete(id) {
    const cert = this.state.certs.find(c => c.id === id);
    const name = cert ? cert.cert_name : '';
    if (!confirm(`确定要删除证照「${name}」吗？\n\n该证照的全部附件（扫描件）将一并删除，此操作不可撤销。`)) return;

    const errMsg = await this.deleteCertWithFiles(id);
    if (errMsg) {
      Utils.toast('删除失败: ' + errMsg, 'error');
      return;
    }
    Utils.toast('证照已删除', 'success');
    await this.loadData();
  },

  /**
   * 删除证照核心流程：先通过 Storage API 删除该证照全部附件对象，
   * 再调用 delete_certificate RPC 删除证照记录（附件记录由外键 CASCADE 删除）。
   * 返回 null 表示成功，否则返回可读错误信息。
   * 说明：不能直接在数据库里 DELETE storage.objects（Supabase 禁止直接删除 storage 表）。
   */
  async deleteCertWithFiles(certId) {
    // 1. 查询该证照全部附件路径
    const { data: files, error: listErr } = await sb
      .from('certificate_files')
      .select('storage_path')
      .eq('certificate_id', certId);

    // 2. Storage API 删除附件对象（列出失败不阻断，文件可能本就不存在，忽略该步错误）
    if (!listErr && files && files.length) {
      const paths = files.map(f => f.storage_path).filter(Boolean);
      if (paths.length) {
        await sb.storage.from(CERT_STORAGE_BUCKET).remove(paths);
      }
    }

    // 3. RPC 删除证照记录（附件记录由外键 ON DELETE CASCADE 删除）
    const { error } = await sb.rpc('delete_certificate', { p_cert_id: certId });
    return error ? Auth.extractRpcMessage(error) : null;
  },

  // ========================================================================
  // 去重清理（查找信息完全相同的重复证照，仅保留最早的一条）
  // ========================================================================

  /**
   * 打开去重弹窗：查询全量证照 → 按业务字段分组 → 展示重复组
   */
  async openDedupeModal() {
    const existing = document.getElementById('admin-dedupe-modal');
    if (existing) existing.remove();
    this.state.dedupeGroups = null;
    this.state.dedupeDeleting = false;
    this.state.dedupeFailed = [];
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="admin-dedupe-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-dedupe-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>清理重复证照</h2>
            <button class="modal-close" onclick="CertAdmin.closeDedupeModal()">&times;</button>
          </div>
          <div class="modal-body" id="admin-dedupe-body"></div>
          <div class="modal-footer" id="admin-dedupe-footer"></div>
        </div>
      </div>
    `);
    this.renderDedupeModal('scanning');

    const { data, error } = await sb
      .from('certificates')
      .select('*, departments(name, code)')
      .order('created_at', { ascending: true });
    if (error) {
      this.renderDedupeModal('error', error);
      return;
    }
    this.state.dedupeGroups = this.findDuplicateGroups(data || []);
    this.renderDedupeModal();
  },

  /**
   * 构造证照去重键：全部业务字段参与比较（空值统一归一为空串，视为相同）
   * 系统字段（id/created_by/created_at/updated_at/renewed_*）不参与比较
   */
  dedupeKeyOf(c) {
    return [
      c.department_id, c.cert_category, c.cert_type, c.cert_name, c.cert_no,
      c.sub1_value, c.sub2_value, c.issuing_authority, c.issue_date,
      c.valid_from, c.valid_until, String(c.is_long_term),
      c.holder_name, c.holder_id_no, c.holder_position, c.status, c.remark,
    ].map(v => (v == null ? '' : String(v))).join('¦');
  },

  /**
   * 按去重键分组，返回 [{ keep, remove: [] }]；每组保留 created_at 最早的一条
   */
  findDuplicateGroups(certs) {
    const map = new Map();
    for (const c of certs) {
      const key = this.dedupeKeyOf(c);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    const groups = [];
    for (const list of map.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => {
        const t = String(a.created_at || '').localeCompare(String(b.created_at || ''));
        if (t !== 0) return t;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      groups.push({ keep: list[0], remove: list.slice(1) });
    }
    groups.sort((a, b) => String(a.keep.cert_name || '').localeCompare(String(b.keep.cert_name || ''), 'zh'));
    return groups;
  },

  /**
   * 渲染去重弹窗：mode = 'scanning' 扫描中 | 'error' 查询失败 | 默认结果
   */
  renderDedupeModal(mode, error) {
    const body = document.getElementById('admin-dedupe-body');
    const footer = document.getElementById('admin-dedupe-footer');
    if (!body || !footer) return;

    if (mode === 'scanning') {
      body.innerHTML = `<p class="text-muted">正在扫描全部证照，查找信息完全相同的重复记录…</p>`;
      footer.innerHTML = `<button class="btn btn-secondary" onclick="CertAdmin.closeDedupeModal()">关闭</button>`;
      return;
    }
    if (mode === 'error') {
      body.innerHTML = `<p class="import-err-text">证照数据读取失败：${Utils.escapeHtml(Auth.extractRpcMessage(error))}</p>`;
      footer.innerHTML = `<button class="btn btn-secondary" onclick="CertAdmin.closeDedupeModal()">关闭</button>`;
      return;
    }

    const groups = this.state.dedupeGroups || [];
    if (groups.length === 0) {
      body.innerHTML = `
        <div class="alert alert-success">
          未发现信息完全相同的重复证照 ✅<br>
          <span class="text-muted">判定范围：所属公司、大类、类型、名称、编号、子分类1/2、发证机关、发证日期、有效期起/止、长期有效、持证人、证件号、职务/岗位、状态、备注——全部一致才算重复。</span>
        </div>`;
      footer.innerHTML = `<button class="btn btn-secondary" onclick="CertAdmin.closeDedupeModal()">关闭</button>`;
      return;
    }

    const removeCount = groups.reduce((n, g) => n + g.remove.length, 0);
    body.innerHTML = `
      <div class="alert alert-warning">
        共发现 <strong>${groups.length}</strong> 组重复证照，将删除 <strong>${removeCount}</strong> 条（每组保留最早录入的一条）。
        删除操作不可撤销，被删记录的全部附件（扫描件）将一并删除。
      </div>
      ${groups.map((g, gi) => `
        <div class="dedupe-group">
          <div class="dedupe-group-title">第 ${gi + 1} 组 · ${Utils.escapeHtml(g.keep.cert_name)}（${Utils.categoryLabel(g.keep.cert_category)} / ${Utils.escapeHtml(g.keep.cert_type)}${g.keep.cert_no ? ' / ' + Utils.escapeHtml(g.keep.cert_no) : ''}）</div>
          ${[g.keep, ...g.remove].map(c => this.renderDedupeRow(c, c.id === g.keep.id)).join('')}
        </div>
      `).join('')}`;
    footer.innerHTML = `
      <button class="btn btn-secondary" onclick="CertAdmin.closeDedupeModal()">取消</button>
      <button class="btn btn-danger" id="dedupe-confirm-btn" onclick="CertAdmin.confirmDedupe()">确认删除 ${removeCount} 条重复记录</button>`;
  },

  /**
   * 去重结果中的单条证照行
   */
  renderDedupeRow(cert, isKeep) {
    const companyName = cert.departments ? cert.departments.name : '未分配';
    const validUntil = cert.is_long_term
      ? '长期'
      : (cert.valid_until ? Utils.formatDate(cert.valid_until) : '—');
    const created = cert.created_at ? Utils.formatDate(cert.created_at) : '';
    return `
      <div class="dedupe-item ${isKeep ? 'dedupe-keep' : 'dedupe-remove'}">
        <span class="badge ${isKeep ? 'badge-success' : 'badge-danger'}">${isKeep ? '保留' : '删除'}</span>
        <span>${Utils.escapeHtml(companyName)}</span>
        <span>${Utils.escapeHtml(cert.cert_name)}</span>
        ${cert.holder_name ? `<span>持证人：${Utils.escapeHtml(cert.holder_name)}</span>` : ''}
        ${cert.sub1_value || cert.sub2_value ? `<span>子分类：${Utils.escapeHtml([cert.sub1_value, cert.sub2_value].filter(Boolean).join(' / '))}</span>` : ''}
        <span>编号：${Utils.escapeHtml(cert.cert_no || '—')}</span>
        <span>有效期至：${validUntil}</span>
        <span class="text-muted">录入：${created}</span>
      </div>`;
  },

  /**
   * 确认执行去重删除（逐条走 delete_certificate RPC，连带清理附件）
   * 失败项记录原因并留在弹窗内展示，不再自动重开弹窗（避免循环弹出）；
   * 再次点击则只重试上次失败项。
   */
  async confirmDedupe() {
    if (this.state.dedupeDeleting) return;
    // 优先重试上次失败项；否则取全部待删 id
    const pending = this.state.dedupeFailed.length
      ? this.state.dedupeFailed
      : (this.state.dedupeGroups || []).flatMap(g => g.remove.map(c => ({ id: c.id, name: c.cert_name })));
    if (pending.length === 0) return;

    const btn = document.getElementById('dedupe-confirm-btn');
    if (btn) btn.disabled = true;
    this.state.dedupeDeleting = true;

    let ok = 0;
    const failed = [];
    let systemError = null;
    for (let i = 0; i < pending.length; i++) {
      if (systemError) {
        // 已命中系统性错误（函数缺失/权限不足等），剩余项不再逐个调用，直接以相同原因标记
        failed.push({ id: pending[i].id, name: pending[i].name, message: systemError });
        continue;
      }
      const errMsg = await this.deleteCertWithFiles(pending[i].id);
      if (errMsg) {
        failed.push({ id: pending[i].id, name: pending[i].name, message: errMsg });
        if (this.isSystemDeleteError(errMsg)) systemError = errMsg;
      } else {
        ok++;
      }
      if (btn) btn.textContent = `正在删除 ${i + 1} / ${pending.length} …`;
    }
    this.state.dedupeDeleting = false;
    this.state.dedupeFailed = failed;

    if (failed.length === 0) {
      Utils.toast(`已清理 ${ok} 条重复证照`, 'success');
      this.closeDedupeModal();
      await this.loadData();
      return;
    }

    Utils.toast(`清理完成：成功 ${ok} 条，失败 ${failed.length} 条`, failed.length === pending.length ? 'error' : 'info');
    this.renderDedupeFailed(ok, failed);
  },

  /**
   * 判断删除错误是否属于「系统性错误」（函数缺失 / 权限不足 / 表不存在等）。
   * 命中后剩余记录无需再逐个调用 RPC，避免大量无意义请求。
   */
  isSystemDeleteError(msg) {
    return /could not find the function|does not exist|permission denied|只有管理员|权限|函数不存在|relation .* does not exist|not found/i.test(String(msg || ''));
  },

  /**
   * 渲染去重删除失败结果（留在弹窗内，按失败原因聚合展示，提供重试/关闭）
   */
  renderDedupeFailed(ok, failed) {
    const body = document.getElementById('admin-dedupe-body');
    const footer = document.getElementById('admin-dedupe-footer');
    if (!body || !footer) return;

    // 按失败原因聚合，一眼看出是系统性问题还是个别数据问题
    const byMsg = new Map();
    for (const f of failed) {
      const m = f.message || '未知错误';
      if (!byMsg.has(m)) byMsg.set(m, []);
      byMsg.get(m).push(f.name);
    }
    const reasons = [...byMsg.entries()].map(([msg, names]) => ({ msg, names }));

    body.innerHTML = `
      <div class="alert ${failed.length ? 'alert-warning' : 'alert-success'}">
        删除完成：成功 <strong>${ok}</strong> 条，失败 <strong>${failed.length}</strong> 条。
        ${failed.length ? '失败原因已按类型汇总，请将下方「失败原因」文字反馈以便定位。' : ''}
      </div>
      ${reasons.map((r, i) => `
        <div class="dedupe-group">
          <div class="dedupe-group-title">失败原因 ${i + 1}（影响 ${r.names.length} 条）：<span class="import-err-text">${Utils.escapeHtml(r.msg)}</span></div>
          <div class="dedupe-item dedupe-remove">
            <span class="badge badge-danger">失败</span>
            <span>${Utils.escapeHtml(r.names.slice(0, 8).join('、'))}${r.names.length > 8 ? ` 等 ${r.names.length} 条` : ''}</span>
          </div>
        </div>
      `).join('')}
      ${failed.length ? '<div class="text-muted" style="margin-top:8px;">若失败原因提示函数 / 权限 / 不存在，请确认数据库已执行最新版 <code>schema.sql</code> 后再试。</div>' : ''}`;
    footer.innerHTML = `
      ${failed.length ? `<button class="btn btn-danger" id="dedupe-confirm-btn" onclick="CertAdmin.confirmDedupe()">重试失败记录（${failed.length} 条）</button>` : ''}
      <button class="btn btn-secondary" onclick="CertAdmin.closeDedupeModal()">关闭</button>`;
  },

  /**
   * 关闭去重弹窗
   */
  closeDedupeModal() {
    const modal = document.getElementById('admin-dedupe-modal');
    if (modal) modal.remove();
    this.state.dedupeGroups = null;
    this.state.dedupeDeleting = false;
    this.state.dedupeFailed = [];
  },

  /**
   * 关闭证照表单弹窗
   */
  closeCertModal() {
    const modal = document.getElementById('admin-cert-modal');
    if (modal) modal.remove();
    this.state.editingId = null;
    this.state.renewingFrom = null;
  },

  // ========================================================================
  // 证照类型字典维护
  // ========================================================================

  /**
   * 渲染类型字典视图
   */
  async renderTypesView() {
    const el = document.getElementById('admin-types-content');
    if (!el) return;

    // 重新加载类型（保持最新）
    const { data, error } = await sb.from('certificate_types').select('*').order('category, sort_order');
    if (error) {
      el.innerHTML = `<div class="card"><div class="card-body has-padding"><div class="alert alert-danger">加载失败：${Utils.escapeHtml(error.message)}（若提示表不存在，请先执行 sql/schema.sql）</div></div></div>`;
      return;
    }
    this.state.types = data || [];

    // 统计各类型被引用次数（防止误删提示）
    const usedCount = {};
    for (const c of this.state.certs) {
      usedCount[c.cert_type] = (usedCount[c.cert_type] || 0) + 1;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>证照类型字典</h2>
          <div class="card-header-actions">
            <span class="toolbar-hint">新增证照时「证照类型」下拉的选项来源；个人证照可配置子分类维度</span>
            <button class="btn btn-primary btn-sm" onclick="CertAdmin.showTypeForm()">+ 新增类型</button>
          </div>
        </div>
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  <th>大类</th>
                  <th>类型名称</th>
                  <th>子分类</th>
                  <th>排序</th>
                  <th>状态</th>
                  <th>已用记录数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${this.state.types.map(t => `
                  <tr>
                    <td>${Utils.categoryLabel(t.category)}</td>
                    <td><strong>${Utils.escapeHtml(t.name)}</strong></td>
                    <td>${this.typeSubInfo(t)}</td>
                    <td>${t.sort_order}</td>
                    <td>${t.is_active !== false ? '<span class="badge badge-success">启用</span>' : '<span class="badge badge-muted">停用</span>'}</td>
                    <td>${usedCount[t.name] || 0}</td>
                    <td style="white-space:nowrap;">
                      <button class="btn btn-secondary btn-sm" onclick="CertAdmin.showTypeForm('${t.id}')">编辑</button>
                      <button class="btn btn-danger btn-sm" onclick="CertAdmin.handleTypeDelete('${t.id}')">删除</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 类型子分类维度摘要（如「证书类别(2) / 学习地点(2)」）
   */
  typeSubInfo(t) {
    const parts = [];
    if (t.sub1_label) parts.push(`${t.sub1_label}(${(t.sub1_options || []).length})`);
    if (t.sub2_label) parts.push(`${t.sub2_label}(${(t.sub2_options || []).length})`);
    return parts.length ? Utils.escapeHtml(parts.join(' / ')) : '<span class="text-muted">—</span>';
  },

  /**
   * 显示类型表单（新增 / 编辑；含子分类维度维护）
   */
  showTypeForm(typeId = null) {
    this.state.editingTypeId = typeId;
    const t = typeId ? this.state.types.find(x => x.id === typeId) : null;
    const sel = (val, opt) => (String(val) === String(opt) ? 'selected' : '');
    const category = t ? t.category : 'company';

    const modalHTML = `
      <div class="modal-overlay" id="type-modal" onclick="CertAdmin.onModalOverlayClick(event, 'type-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>${t ? '编辑证照类型' : '新增证照类型'}</h2>
            <button class="modal-close" onclick="CertAdmin.closeTypeModal()">&times;</button>
          </div>
          <div class="modal-body">
            <form id="type-form" onsubmit="return false">
              <div class="form-grid">
                <div class="form-group">
                  <label>所属大类 <span class="required">*</span></label>
                  <select name="category" required>
                    <option value="company" ${sel(category, 'company')}>公司证照</option>
                    <option value="personal" ${sel(category, 'personal')}>个人证照</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>类型名称 <span class="required">*</span></label>
                  <input type="text" name="name" required maxlength="50" placeholder="如：安全生产许可证" value="${Utils.escapeHtml(t ? t.name : '')}">
                </div>
                <div class="form-group">
                  <label>排序号</label>
                  <input type="number" name="sort_order" min="0" max="999" value="${t ? t.sort_order : ''}" placeholder="越小越靠前，留空自动排最后">
                </div>
                <div class="form-group">
                  <label>启用状态</label>
                  <select name="is_active">
                    <option value="true" ${!t || t.is_active !== false ? 'selected' : ''}>启用</option>
                    <option value="false" ${t && t.is_active === false ? 'selected' : ''}>停用（不出现在表单下拉中）</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>子分类1名称</label>
                  <input type="text" name="sub1_label" maxlength="30" placeholder="（选填）如：人员类别" value="${Utils.escapeHtml(t && t.sub1_label ? t.sub1_label : '')}">
                </div>
                <div class="form-group">
                  <label>子分类1选项</label>
                  <textarea name="sub1_options" rows="4" maxlength="500" placeholder="（选填）每行一个选项，如：&#10;爆破员&#10;保管员&#10;安全员">${Utils.escapeHtml(t && t.sub1_options ? t.sub1_options.join('\n') : '')}</textarea>
                </div>
                <div class="form-group">
                  <label>子分类2名称</label>
                  <input type="text" name="sub2_label" maxlength="30" placeholder="（选填）如：学习地点" value="${Utils.escapeHtml(t && t.sub2_label ? t.sub2_label : '')}">
                </div>
                <div class="form-group">
                  <label>子分类2选项</label>
                  <textarea name="sub2_options" rows="4" maxlength="500" placeholder="（选填）每行一个选项，如：&#10;太原&#10;运城">${Utils.escapeHtml(t && t.sub2_options ? t.sub2_options.join('\n') : '')}</textarea>
                </div>
                <div class="form-group col-span-2">
                  <p class="hint">子分类用于同一类型下的进一步区分（如「爆破作业人员许可证」按人员类别细分）。名称与选项须成对填写，两者都留空表示该类型无子分类。</p>
                </div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="CertAdmin.closeTypeModal()">取消</button>
            <button class="btn btn-primary" onclick="CertAdmin.handleTypeSubmit()">${t ? '保存修改' : '新增'}</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('type-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 提交类型表单
   */
  async handleTypeSubmit() {
    const form = document.getElementById('type-form');
    if (!form || !form.reportValidity()) return;

    const fd = new FormData(form);
    const parseOptions = (raw) => String(raw || '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    const sub1Label = String(fd.get('sub1_label') || '').trim();
    const sub2Label = String(fd.get('sub2_label') || '').trim();
    const sub1Options = parseOptions(fd.get('sub1_options'));
    const sub2Options = parseOptions(fd.get('sub2_options'));

    // 名称与选项成对校验
    if (sub1Label && sub1Options.length === 0) {
      Utils.toast('子分类1已填写名称，请至少填写一个选项', 'error');
      return;
    }
    if (!sub1Label && sub1Options.length > 0) {
      Utils.toast('子分类1已填写选项，请补充名称', 'error');
      return;
    }
    if (sub2Label && sub2Options.length === 0) {
      Utils.toast('子分类2已填写名称，请至少填写一个选项', 'error');
      return;
    }
    if (!sub2Label && sub2Options.length > 0) {
      Utils.toast('子分类2已填写选项，请补充名称', 'error');
      return;
    }

    const payload = {
      name: String(fd.get('name') || '').trim(),
      category: fd.get('category'),
      sort_order: fd.get('sort_order') === '' || fd.get('sort_order') == null ? null : parseInt(fd.get('sort_order')),
      is_active: fd.get('is_active') === 'true',
      sub1_label: sub1Label || null,
      sub1_options: sub1Options.length ? sub1Options : null,
      sub2_label: sub2Label || null,
      sub2_options: sub2Options.length ? sub2Options : null,
    };

    const btn = document.querySelector('#type-modal .modal-footer .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '提交中...'; }

    const { error } = this.state.editingTypeId
      ? await sb.rpc('update_certificate_type', {
          p_type_id: this.state.editingTypeId,
          p_name: payload.name,
          p_category: payload.category,
          p_sort_order: payload.sort_order,
          p_is_active: payload.is_active,
          p_sub1_label: payload.sub1_label,
          p_sub1_options: payload.sub1_options,
          p_sub2_label: payload.sub2_label,
          p_sub2_options: payload.sub2_options,
        })
      : await sb.rpc('create_certificate_type', {
          p_name: payload.name,
          p_category: payload.category,
          p_sort_order: payload.sort_order,
          p_sub1_label: payload.sub1_label,
          p_sub1_options: payload.sub1_options,
          p_sub2_label: payload.sub2_label,
          p_sub2_options: payload.sub2_options,
        });

    if (error) {
      Utils.toast('保存失败: ' + Auth.extractRpcMessage(error), 'error');
      if (btn) { btn.disabled = false; btn.textContent = this.state.editingTypeId ? '保存修改' : '新增'; }
      return;
    }

    Utils.toast(this.state.editingTypeId ? '类型已更新' : '类型已新增', 'success');
    this.closeTypeModal();
    await this.renderTypesView();
    // 台账的类型筛选下拉同步刷新
    this.fillTypeFilter(this.state.filters.category);
  },

  /**
   * 删除类型
   */
  async handleTypeDelete(typeId) {
    const t = this.state.types.find(x => x.id === typeId);
    if (!t) return;
    if (!confirm(`确定要删除证照类型「${t.name}」吗？`)) return;

    const { error } = await sb.rpc('delete_certificate_type', { p_type_id: typeId });
    if (error) {
      Utils.toast('删除失败: ' + Auth.extractRpcMessage(error), 'error');
      return;
    }
    Utils.toast('类型已删除', 'success');
    await this.renderTypesView();
    this.fillTypeFilter(this.state.filters.category);
  },

  /**
   * 关闭类型表单弹窗
   */
  closeTypeModal() {
    const modal = document.getElementById('type-modal');
    if (modal) modal.remove();
    this.state.editingTypeId = null;
  },

  // ========================================================================
  // 系统设置（预警天数）
  // ========================================================================

  /**
   * 渲染设置视图
   */
  async renderSettingsView() {
    const el = document.getElementById('admin-settings-content');
    if (!el) return;

    // 读取最新设置
    const { data, error } = await sb.from('cert_settings').select('warn_days, updated_at').eq('id', 1).limit(1);
    if (error) {
      el.innerHTML = `<div class="card"><div class="card-body has-padding"><div class="alert alert-danger">设置加载失败：${Utils.escapeHtml(error.message)}（若提示表不存在，请先执行 sql/schema.sql）</div></div></div>`;
      return;
    }
    const settings = data && data[0] ? data[0] : { warn_days: 90, updated_at: null };
    this.state.warnDays = settings.warn_days;

    el.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>到期预警设置</h2></div>
        <div class="card-body has-padding">
          <div class="form-grid" style="max-width:520px;">
            <div class="form-group">
              <label>预警提前天数 <span class="required">*</span></label>
              <input type="number" id="setting-warn-days" min="1" max="365" value="${settings.warn_days}">
              <p class="hint">证照在到期前多少天开始标记为「即将到期」（黄色高亮）。当前：${settings.warn_days} 天${settings.updated_at ? `，上次修改：${Utils.formatDateTime(settings.updated_at)}` : ''}</p>
            </div>
            <div class="form-group">
              <button class="btn btn-primary" onclick="CertAdmin.handleSaveSettings()">保存设置</button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 保存预警天数
   */
  async handleSaveSettings() {
    const input = document.getElementById('setting-warn-days');
    if (!input) return;
    const days = parseInt(input.value);
    if (!days || days < 1 || days > 365) {
      Utils.toast('预警天数须在 1 - 365 之间', 'error');
      return;
    }
    const { error } = await sb.rpc('update_cert_settings', { p_warn_days: days });
    if (error) {
      Utils.toast('保存失败: ' + Auth.extractRpcMessage(error), 'error');
      return;
    }
    this.state.warnDays = days;
    Utils.toast(`预警天数已设置为 ${days} 天`, 'success');
    this.renderCerts();
  },

  // ========================================================================
  // 弹窗通用
  // ========================================================================

  /**
   * 模态框遮罩点击关闭
   */
  onModalOverlayClick(event, modalId) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      if (modalId === 'admin-cert-detail-modal') {
        this.closeDetailModal();
      } else if (modalId === 'admin-file-preview-modal') {
        this.closePreviewModal();
      } else if (modalId === 'admin-cert-modal') {
        this.closeCertModal();
      } else if (modalId === 'type-modal') {
        this.closeTypeModal();
      } else if (modalId === 'admin-dedupe-modal') {
        this.closeDedupeModal();
      } else if (modalId === 'admin-training-modal') {
        this.closeTrainingModal();
      } else if (modalId === 'admin-batch-training-modal') {
        this.closeBatchTrainingModal();
      }
    }
  },

  // ========================================================================
  // 历年培训记录（管理员：增 / 改 / 删；详情页集中展示）
  // ========================================================================

  /**
   * 加载某证照的历年培训记录，渲染到详情弹窗列表
   */
  async loadDetailTrainings(certId) {
    const listEl = document.getElementById('admin-cert-trainings-list');
    if (!listEl || this.state.detailId !== certId) return;

    const { data, error } = await sb
      .from('certificate_trainings')
      .select('*')
      .eq('certificate_id', certId)
      .order('training_year', { ascending: false })
      .order('training_date', { ascending: false });

    if (error) {
      listEl.innerHTML = `<div class="alert alert-danger">培训记录加载失败：${Utils.escapeHtml(error.message)}</div>`;
      return;
    }
    this.state.detailTrainings = data || [];
    this.renderDetailTrainings(this.state.detailTrainings, true);
  },

  /**
   * 渲染培训记录列表（管理员：含编辑 / 删除按钮）
   */
  renderDetailTrainings(list, isAdmin) {
    const listEl = document.getElementById('admin-cert-trainings-list');
    if (!listEl) return;

    if (!list || list.length === 0) {
      listEl.innerHTML = `<p class="text-muted" style="padding:8px 0;">该证照暂无培训记录，可点击下方按钮添加历年培训情况。</p>`;
      return;
    }

    listEl.innerHTML = `<div class="training-cards">` + list.map((t, i) => `
      <div class="training-card">
        <div class="training-card-head">
          <span class="training-year-badge">${t.training_year} 年</span>
          ${t.training_result ? `<span class="badge badge-success">${Utils.escapeHtml(t.training_result)}</span>` : ''}
          ${isAdmin ? `
          <span class="training-card-ops">
            <button class="btn btn-secondary btn-sm" onclick="CertAdmin.openTrainingForm('${t.certificate_id}', '${t.id}')">编辑</button>
            <button class="btn btn-danger btn-sm" onclick="CertAdmin.deleteTrainingRecord('${t.id}')">删除</button>
          </span>` : ''}
        </div>
        <div class="training-content">${Utils.escapeHtml(t.training_content)}</div>
        <div class="training-meta">
          ${t.training_date ? `<span>日期：${Utils.escapeHtml(Utils.formatDate(t.training_date))}</span>` : ''}
          ${t.training_org ? `<span>机构：${Utils.escapeHtml(t.training_org)}</span>` : ''}
          ${t.hours != null ? `<span>学时：${Utils.escapeHtml(String(t.hours))}</span>` : ''}
        </div>
        ${t.remark ? `<div class="training-remark" title="${Utils.escapeHtml(t.remark)}">备注：${Utils.escapeHtml(t.remark)}</div>` : ''}
      </div>
    `).join('') + `</div>`;
  },

  /**
   * 打开培训记录表单（新增或编辑）
   */
  async openTrainingForm(certId, trainingId) {
    if (!certId) return;
    let t = { certificate_id: certId, training_year: new Date().getFullYear(), training_date: '', training_content: '', training_org: '', hours: '', training_result: '', remark: '' };
    if (trainingId) {
      const { data, error } = await sb
        .from('certificate_trainings')
        .select('*')
        .eq('id', trainingId)
        .single();
      if (error || !data) {
        Utils.toast('未找到该培训记录', 'error');
        return;
      }
      t = data;
    }

    const val = (k) => Utils.escapeHtml((t[k] == null ? '' : t[k]) + '');
    const modalHTML = `
      <div class="modal-overlay" id="admin-training-modal" onclick="CertAdmin.onModalOverlayClick(event, 'admin-training-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>${trainingId ? '编辑培训记录' : '添加培训记录'}</h2>
            <button class="modal-close" onclick="CertAdmin.closeTrainingModal()">&times;</button>
          </div>
          <div class="modal-body">
            <form id="admin-training-form" onsubmit="return false">
              <input type="hidden" name="certificate_id" value="${Utils.escapeHtml(certId)}">
              <input type="hidden" name="training_id" value="${trainingId ? Utils.escapeHtml(trainingId) : ''}">
              <div class="form-grid">
                <div class="form-group">
                  <label>培训年份 <span class="required">*</span></label>
                  <input type="number" name="training_year" required min="2000" max="9999" value="${val('training_year')}">
                </div>
                <div class="form-group">
                  <label>培训日期</label>
                  <input type="date" name="training_date" value="${val('training_date')}">
                </div>
                <div class="form-group col-span-2">
                  <label>培训内容 <span class="required">*</span></label>
                  <input type="text" name="training_content" required maxlength="200" placeholder="如：安全生产法规年度培训" value="${val('training_content')}">
                </div>
                <div class="form-group">
                  <label>培训机构 / 组织</label>
                  <input type="text" name="training_org" maxlength="100" placeholder="（选填）" value="${val('training_org')}">
                </div>
                <div class="form-group">
                  <label>培训学时</label>
                  <input type="number" name="hours" min="0" step="0.5" placeholder="（选填）" value="${val('hours')}">
                </div>
                <div class="form-group">
                  <label>培训结果 / 考核</label>
                  <input type="text" name="training_result" maxlength="50" placeholder="（选填）如：合格" value="${val('training_result')}">
                </div>
                <div class="form-group col-span-2">
                  <label>备注</label>
                  <textarea name="remark" rows="2" maxlength="500" placeholder="（选填）">${val('remark')}</textarea>
                </div>
              </div>
            </form>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="CertAdmin.closeTrainingModal()">取消</button>
            <button class="btn btn-primary" onclick="CertAdmin.submitTrainingForm()">${trainingId ? '保存修改' : '添加记录'}</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('admin-training-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);
  },

  /**
   * 提交培训记录（新增 / 编辑）
   */
  async submitTrainingForm() {
    const form = document.getElementById('admin-training-form');
    if (!form) return;
    if (!form.reportValidity()) return;

    const fd = new FormData(form);
    const str = (k) => {
      const v = fd.get(k);
      return v == null ? '' : String(v).trim();
    };
    const yearRaw = str('training_year');
    const year = parseInt(yearRaw, 10);
    if (!yearRaw || isNaN(year) || year < 2000 || year > 9999) {
      Utils.toast('请填写有效的培训年份（2000-9999）', 'error');
      return;
    }
    const trainingId = str('training_id');
    const payload = {
      certificate_id: str('certificate_id'),
      training_year: year,
      training_date: str('training_date') || null,
      training_content: str('training_content'),
      training_org: str('training_org') || null,
      hours: str('hours') ? Number(str('hours')) : null,
      training_result: str('training_result') || null,
      remark: str('remark') || null,
    };

    const btn = document.querySelector('#admin-training-modal .modal-footer .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '提交中...'; }

    let error;
    if (trainingId) {
      const r = await sb.from('certificate_trainings').update(payload).eq('id', trainingId);
      error = r.error;
    } else {
      const r = await sb.from('certificate_trainings').insert({ ...payload, created_by: Auth.currentUser.id });
      error = r.error;
    }
    if (error) {
      Utils.toast('保存失败: ' + error.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = trainingId ? '保存修改' : '添加记录'; }
      return;
    }

    Utils.toast(trainingId ? '培训记录已更新' : '培训记录已添加', 'success');
    this.closeTrainingModal();
    this.loadDetailTrainings(this.state.detailId);
  },

  /**
   * 删除培训记录
   */
  async deleteTrainingRecord(trainingId) {
    if (!trainingId) return;
    if (!confirm('确定删除这条培训记录吗？此操作不可撤销。')) return;
    const { error } = await sb.from('certificate_trainings').delete().eq('id', trainingId);
    if (error) {
      Utils.toast('删除失败: ' + error.message, 'error');
      return;
    }
    Utils.toast('培训记录已删除', 'success');
    this.loadDetailTrainings(this.state.detailId);
  },

  /**
   * 关闭培训记录表单弹窗
   */
  closeTrainingModal() {
    const modal = document.getElementById('admin-training-modal');
    if (modal) modal.remove();
  },
};

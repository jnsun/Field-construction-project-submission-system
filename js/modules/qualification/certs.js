/**
 * certs.js - 公司用户模块（资质证照台账 · 只读）
 * 负责本公司证照的查询筛选、详情查看、附件预览下载、到期预警高亮
 *
 * v3 权限模型：证照的登记、编辑、删除、换证、附件上传删除均由管理员操作，
 * 公司账号（reporter）对本公司证照与附件只读；写入口已全部移除，
 * 与 sql/schema.sql 中「写仅管理员」的 RLS 策略保持一致。
 *
 * 依赖（沿用月报系统约定）：
 *   - 全局 sb（config.js 创建的 Supabase 客户端）
 *   - Auth.currentProfile（profiles 表记录，含 departments 关联；
 *     公司账号 = department_id 指向 is_company 部门行的账号）
 *   - Utils（toast / escapeHtml / certDisplayStatus 等）
 */

const Certs = {

  state: {
    departmentId: null,   // 归属公司 ID（departments 表中 is_company 的行）
    departmentName: '',   // 公司名称
    fullName: '',
    email: '',
    certs: [],           // 本公司全部证照
    types: [],           // 证照类型字典（certificate_types 表，含子分类维度，用于详情展示子分类名称）
    warnDays: 90,        // 到期预警天数（cert_settings 表，读取失败用默认值）
    filters: {
      keyword: '',
      category: '',      // '' 全部 | 'company' | 'personal'
      status: '',        // '' 全部 | 'valid' | 'expiring' | 'expired' | 'revoked' | 'replaced'
    },
    detailId: null,      // 详情弹窗当前证照 ID
    detailFiles: [],     // 详情弹窗当前附件列表
    trainingsByCert: null, // Map<certificate_id, training[]> 预载培训记录，供动态培训状态判定
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
   * 渲染公司用户仪表盘
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

    this.state.filters = { keyword: '', category: '', status: '', training: '' };

    container.innerHTML = this.buildHTML();
    Utils.bindBackToTop('certs-back-top');
    await this.loadConfig();
    await this.loadCerts();
  },

  /**
   * 加载配置（证照类型字典 + 预警天数；查询失败自动降级到默认值）
   */
  async loadConfig() {
    try {
      const [typesRes, settingsRes] = await Promise.all([
        sb.from('certificate_types').select('*').order('sort_order'),
        sb.from('cert_settings').select('warn_days').eq('id', 1).limit(1),
      ]);
      if (!typesRes.error && typesRes.data && typesRes.data.length > 0) {
        this.state.types = typesRes.data;
      }
      if (!settingsRes.error && settingsRes.data && settingsRes.data.length) {
        this.state.warnDays = settingsRes.data[0].warn_days || 90;
      }
    } catch (e) {
      console.warn('加载证照配置失败，使用默认配置:', e);
    }
  },

  /**
   * 加载本公司全部证照
   */
  async loadCerts() {
    const section = document.getElementById('certs-section');
    if (!section) return;

    section.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>证照台账</h2></div>
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;

    const { data, error } = await sb
      .from('certificates')
      .select('*')
      .eq('department_id', this.state.departmentId)
      .order('created_at', { ascending: false });

    if (error) {
      Utils.toast('加载证照失败: ' + error.message, 'error');
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>证照台账</h2></div>
          <div class="card-body"><div class="alert alert-danger">加载失败：${Utils.escapeHtml(error.message)}<br>若提示表不存在，请先在 Supabase 中执行 sql/schema.sql。</div></div>
        </div>
      `;
      return;
    }

    this.state.certs = data || [];
    // 预载本公司培训记录，按证照 id 建立索引，供「注册安全工程师有效期内需培训 2 次」等动态判定
    this.state.trainingsByCert = new Map();
    const ids = this.state.certs.map(c => c.id);
    if (ids.length) {
      const { data: trData } = await sb
        .from('certificate_trainings')
        .select('*')
        .in('certificate_id', ids);
      if (trData) {
        for (const t of trData) {
          if (!this.state.trainingsByCert.has(t.certificate_id)) this.state.trainingsByCert.set(t.certificate_id, []);
          this.state.trainingsByCert.get(t.certificate_id).push(t);
        }
      }
    }
    this.renderCerts();
  },

  /**
   * 构建 HTML 结构
   */
  buildHTML() {
    return `
      <div class="dashboard">
        <button class="back-to-top" id="certs-back-top" title="回到顶部" aria-label="回到顶部">↑</button>
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildToolbar()}
          <div id="certs-section"></div>
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
        <div class="dashboard-header-inner">
          <div class="header-left">
            <button class="btn btn-back" onclick="App.openDashboard()">← 返回上级菜单</button>
          </div>
          <div class="header-center">
            <h1 class="page-title">资质证照管理</h1>
          </div>
          <div class="header-right">
            <span class="badge badge-muted">${Utils.escapeHtml(this.state.departmentName)}</span>
            <span class="badge badge-muted" title="证照登记与维护由管理员操作">只读</span>
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

  /**
   * 工具栏：大类选项卡 + 状态筛选 + 搜索，全部放到一行（只读视图）
   */
  buildToolbar() {
    const cat = this.state.filters.category || '';
    return `
      <div class="cat-tabs cert-cat-row" id="cat-tabs">
        <button type="button" class="cat-tab${cat === '' ? ' active' : ''}" data-cat="" onclick="Certs.setCategory('')">全部</button>
        <button type="button" class="cat-tab${cat === 'company' ? ' active' : ''}" data-cat="company" onclick="Certs.setCategory('company')">公司证照</button>
        <button type="button" class="cat-tab${cat === 'personal' ? ' active' : ''}" data-cat="personal" onclick="Certs.setCategory('personal')">个人证照</button>
      </div>
      <div class="toolbar cert-toolbar">
        <div class="toolbar-left cert-toolbar-left">
          <label>状态：</label>
          <select id="filter-status" class="filter-select-sm" onchange="Certs.onFilterChange()">
            <option value="">全部</option>
            <option value="valid">有效</option>
            <option value="expiring">即将到期</option>
            <option value="expired">已过期</option>
            <option value="replaced">已换证</option>
            <option value="revoked">已注销</option>
          </select>
        </div>
        <div class="toolbar-right cert-toolbar-right">
          <input type="search" id="cert-search" class="toolbar-search cert-search-sm" placeholder="搜索证照名称/编号/持证人/类型/子分类" oninput="Certs.onSearch()">
        </div>
      </div>
    `;
  },

  /**
   * 大类选项卡切换
   */
  setCategory(cat) {
    this.state.filters.category = cat;
    const tabs = document.getElementById('cat-tabs');
    if (tabs) {
      tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    }
    this.renderCerts();
  },

  /**
   * 筛选条件变化（大类由选项卡管理，此处只读状态下拉）
   */
  onFilterChange() {
    this.state.filters.status = document.getElementById('filter-status').value;
    this.state.filters.training = '';
    this.renderCerts();
  },

  /**
   * 点击统计卡片：按 大类+状态/培训 快速筛选台账
   * filterKey 形如 'company|expired' / 'personal|trained' / 'company|all'
   */
  applyQuickFilter(key) {
    const [cat, kind] = (key || '|').split('|');
    const f = this.state.filters;
    f.category = cat;
    f.status = ['valid', 'expiring', 'expired'].includes(kind) ? kind : '';
    f.training = ['trained', 'untrained'].includes(kind) ? kind : '';
    // 同步大类选项卡高亮
    const tabs = document.getElementById('cat-tabs');
    if (tabs) {
      tabs.querySelectorAll('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    }
    // 同步状态下拉
    const sel = document.getElementById('filter-status');
    if (sel) sel.value = f.status;
    this.renderCerts();
  },

  /**
   * 搜索框输入
   */
  onSearch() {
    const el = document.getElementById('cert-search');
    this.state.filters.keyword = el ? el.value.trim().toLowerCase() : '';
    this.renderCerts();
  },

  /**
   * 读取搜索关键字
   */
  getSearchKeyword() {
    const el = document.getElementById('cert-search');
    return el ? el.value.trim().toLowerCase() : '';
  },

  /**
   * 判断证照是否匹配搜索关键字
   */
  matchKeyword(c, kw) {
    if (!kw) return true;
    return ['cert_name', 'cert_type', 'cert_no', 'holder_name', 'sub1_value', 'sub2_value', 'issuing_authority']
      .some(k => c[k] != null && String(c[k]).toLowerCase().includes(kw));
  },

  /**
   * 获取证照展示状态（自动带当前预警天数）
   */
  statusOf(cert) {
    return Utils.certDisplayStatus(cert, this.state.warnDays);
  },

  /**
   * 渲染证照列表（统计卡片 + 表格）
   * 排序：已过期 / 即将到期 优先（预警置顶），其余按有效期止升序，无有效期排最后
   */
  renderCerts() {
    const section = document.getElementById('certs-section');
    if (!section) return;

    const kw = this.getSearchKeyword();
    const { category, status, training } = this.state.filters;
    const all = this.state.certs;
    const tb = this.state.trainingsByCert;

    // 计算每条状态并过滤
    const enriched = all.map(c => ({ cert: c, st: this.statusOf(c) }));
    const filtered = enriched.filter(({ cert, st }) =>
      (!category || cert.cert_category === category)
      && (!status || st.key === status)
      && (!training || (cert.cert_category === 'personal' && (() => {
        // 与统计卡片一致：使用动态培训状态（注册安全工程师按有效期内次数判定，无需培训类型置「无需培训」）
        const ti = Utils.certTrainingInfo(cert, (tb && tb.get(cert.id)) || []);
        return training === 'trained' ? ti.status === '已培训' : ti.status === '待培训';
      })()))
      && this.matchKeyword(cert, kw)
    );

    // 统计（不受筛选影响，基于全部证照）：拆分为公司资质 / 个人证照两大板块
    const companyListStats = enriched.filter(e => e.cert.cert_category === 'company');
    const personalListStats = enriched.filter(e => e.cert.cert_category === 'personal');

    const warnHint = this.state.warnDays;

    const statCard = (label, value, mod = '', filterKey = '', active = false) => `
      <div class="stat-card ${mod} ${filterKey ? 'clickable' : ''} ${active ? 'active' : ''}" ${filterKey ? `onclick="Certs.applyQuickFilter('${filterKey}')"` : ''} title="${filterKey ? '点击查看对应台账' : ''}">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
      </div>`;
    const trOf = (cert) => (tb && tb.get(cert.id)) || [];
    const calcStats = (list) => {
      let total = 0, valid = 0, expiring = 0, expired = 0, trained = 0, untrained = 0;
      for (const e of list) {
        total++;
        if (e.st.key === 'valid') valid++;
        else if (e.st.key === 'expiring') expiring++;
        else if (e.st.key === 'expired') expired++;
        if (e.cert.cert_category === 'personal') {
          const ts = Utils.certTrainingInfo(e.cert, trOf(e.cert)).status;
          if (ts === '已培训') trained++;
          else if (ts === '待培训') untrained++;
        }
      }
      return { total, valid, expiring, expired, trained, untrained };
    };
    const c = calcStats(companyListStats);
    const p = calcStats(personalListStats);
    const cur = this.state.filters;
    const isActive = (cat, kind) => {
      if (cur.category !== cat) return false;
      if (kind === 'all') return !cur.status && !cur.training;
      if (['valid', 'expiring', 'expired'].includes(kind)) return cur.status === kind && !cur.training;
      if (['trained', 'untrained'].includes(kind)) return cur.training === kind && !cur.status;
      return false;
    };

    const statsHTML = `
      <div class="cert-stats-block">
        <div class="cert-stats-section">
          <div class="cert-stats-section-title">公司资质</div>
          <div class="stats-grid">
            ${statCard('资质总计', c.total, 'total', 'company|all', isActive('company', 'all'))}
            ${statCard('有效资质', c.valid, 'success', 'company|valid', isActive('company', 'valid'))}
            ${statCard('临期资质', c.expiring, 'warning', 'company|expiring', isActive('company', 'expiring'))}
            ${statCard('过期资质', c.expired, 'danger', 'company|expired', isActive('company', 'expired'))}
          </div>
        </div>
        <div class="cert-stats-section">
          <div class="cert-stats-section-title">个人证照</div>
          <div class="stats-grid">
            ${statCard('证照总计', p.total, 'total', 'personal|all', isActive('personal', 'all'))}
            ${statCard('有效证照', p.valid, 'success', 'personal|valid', isActive('personal', 'valid'))}
            ${statCard('临期证照', p.expiring, 'warning', 'personal|expiring', isActive('personal', 'expiring'))}
            ${statCard('过期证照', p.expired, 'danger', 'personal|expired', isActive('personal', 'expired'))}
            ${statCard('本年度已培训', p.trained, 'success', 'personal|trained', isActive('personal', 'trained'))}
            ${statCard('本年度未培训', p.untrained, 'info', 'personal|untrained', isActive('personal', 'untrained'))}
          </div>
        </div>
      </div>
    `;

    // 空状态
    if (all.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>证照台账</h2></div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📋</div>
              <p>本公司暂无证照记录</p>
              <p class="text-muted" style="margin-top:8px;">如需登记证照，请联系管理员</p>
            </div>
          </div>
        </div>
      `;
      return;
    }
    if (filtered.length === 0) {
      section.innerHTML = statsHTML + `
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

    section.innerHTML = statsHTML + `
      <div class="card">
        <div class="card-header">
          <h2>证照台账</h2>
          <span class="toolbar-hint">共 ${filtered.length} 条${all.length !== filtered.length ? `（全部 ${all.length} 条）` : ''}${kw ? `，匹配「${Utils.escapeHtml(kw)}」` : ''}</span>
        </div>
        <div class="card-body">
          <div class="table-wrapper">
            <table class="data-table">
              <thead>
                <tr>
                  ${category ? '' : '<th>大类</th>'}
                  <th>类型</th>
                  ${category === 'company' ? '' : '<th>子分类</th>'}
                  ${category === 'company' ? '' : '<th>持证人</th>'}
                  <th>有效期至</th>
                  <th>状态</th>
                  ${category === 'company' ? '' : '<th>培训情况</th>'}
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
  },

  /**
   * 渲染单行证照（只读视图，仅提供查看）
   */
  renderCertRow(cert, st) {
    const cat = this.state.filters.category;
    const compactCompanyView = cat === 'company';
    const hideCategoryCol = !!cat;            // 公司/个人视图均隐藏「大类」，仅「全部」显示
    const rowCls = st.key === 'expired' ? 'row-danger'
      : st.key === 'expiring' ? 'row-warning' : '';
    const subCol = Utils.subText(cert)
      ? Utils.escapeHtml(Utils.subText(cert))
      : '<span class="text-muted">—</span>';
    const ownerCol = cert.cert_category === 'personal'
      ? Utils.escapeHtml(cert.holder_name || '-')
      : '<span class="text-muted">—</span>';
    const validUntil = cert.is_long_term
      ? '<span class="text-muted">长期</span>'
      : Utils.formatDate(cert.valid_until);
    const trainingCol = Utils.trainingColHTML(cert, this.state.trainingsByCert ? (this.state.trainingsByCert.get(cert.id) || []) : []);
    return `
      <tr class="${rowCls}">
        ${hideCategoryCol ? '' : `<td>${Utils.categoryLabel(cert.cert_category)}</td>`}
        <td><a href="javascript:void(0)" class="cert-cell-link" onclick="Certs.showCertDetail('${cert.id}')" title="点击查看证照详情">${Utils.typeChip(cert.cert_type)}</a></td>
        ${compactCompanyView ? '' : `<td>${subCol}</td>`}
        ${compactCompanyView ? '' : `<td>${ownerCol}</td>`}
        <td style="white-space:nowrap;">${validUntil}</td>
        <td><span class="badge ${st.badge}">${st.label}</span></td>
        ${compactCompanyView ? '' : `<td>${trainingCol}</td>`}
      </tr>
    `;
  },

  // ========================================================================
  // 详情弹窗（只读：基本信息 + 换证历史 + 附件预览/下载）
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
  async showCertDetail(id) {
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
      : `${text(cert.valid_until)}${days != null && cert.status === 'active' && !cert.is_long_term
          ? (days < 0 ? ` <span class="badge badge-danger">已过期 ${Math.abs(days)} 天</span>`
            : ` <span class="badge ${days <= this.state.warnDays ? 'badge-warning' : 'badge-success'}">剩余 ${days} 天</span>`)
          : ''}`;

    // 换证历史链（沿 renewed_from 向上追溯 + 向下找新证）
    const chain = this.buildRenewalChain(cert);

    // 公司证照无需培训：详情中不展示「培训状态」与「历年培训情况」
    const trInfo = Utils.certTrainingInfo(cert, this.state.trainingsByCert ? (this.state.trainingsByCert.get(cert.id) || []) : []);
    const trainingNote = trInfo.need > 0
      ? `<p class="training-note ${trInfo.count >= trInfo.need ? 'ok' : 'warn'}">${Utils.escapeHtml(cert.cert_type)}：有效期内需培训 ${trInfo.need} 次，已培训 ${trInfo.count} 次${trInfo.count >= trInfo.need ? '（已达标）' : '（未达标，请尽快安排培训）'}</p>`
      : '';
    const trainingSection = cert.cert_category === 'company' ? '' : `
            <div class="detail-section">
              <h3>历年培训情况</h3>
              <div id="cert-trainings-list" class="trainings-list">
                <div class="empty-state" style="padding:16px;"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;">培训记录加载中...</p></div>
              </div>
              ${trainingNote}
            </div>`;

    const modalHTML = `
      <div class="modal-overlay" id="cert-detail-modal" onclick="Certs.onModalOverlayClick(event, 'cert-detail-modal')">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>证照详情：${Utils.escapeHtml(cert.cert_name)}</h2>
            <button class="modal-close" onclick="Certs.closeDetailModal()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              ${item('所属公司', text(this.state.departmentName))}
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
              ${item('换证要求', Utils.reCertRequirement(cert.cert_type))}
              ${cert.cert_category === 'personal' ? item('持证人', text(cert.holder_name)) : ''}
              ${cert.cert_category === 'personal' ? item('证件号', text(cert.holder_id_no)) : ''}
              ${cert.cert_category === 'personal' ? item('职务 / 岗位', text(cert.holder_position)) : ''}
              ${item('备注', text(cert.remark))}
              ${cert.cert_category === 'company' ? '' : item('培训状态', Utils.trainingColHTML(cert, this.state.trainingsByCert ? (this.state.trainingsByCert.get(cert.id) || []) : []))}
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
              <div id="cert-files-list" class="cert-files-list">
                <div class="empty-state" style="padding:16px;"><div class="spinner" style="margin:0 auto;"></div><p style="margin-top:8px;">附件加载中...</p></div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="Certs.closeDetailModal()">关闭</button>
          </div>
        </div>
      </div>
    `;

    const existing = document.getElementById('cert-detail-modal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', modalHTML);

    await this.loadDetailFiles(id);
    this.loadDetailTrainings(id);
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
   * 关闭详情弹窗
   */
  closeDetailModal() {
    const modal = document.getElementById('cert-detail-modal');
    if (modal) modal.remove();
    this.state.detailId = null;
    this.state.detailFiles = [];
    this.state.detailTrainings = [];
  },

  /**
   * 加载详情弹窗的附件列表
   */
  async loadDetailFiles(certId) {
    const listEl = document.getElementById('cert-files-list');
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
    this.renderDetailFiles();
  },

  /**
   * 渲染附件列表（只读：仅预览 / 下载）
   */
  renderDetailFiles() {
    const listEl = document.getElementById('cert-files-list');
    if (!listEl) return;
    const files = this.state.detailFiles;

    if (files.length === 0) {
      listEl.innerHTML = `<p class="text-muted" style="padding:8px 0;">该证照暂无附件。</p>`;
      return;
    }

    listEl.innerHTML = files.map((f, i) => `
      <div class="cert-file-item">
        <span class="cert-file-icon">${Utils.isImageFile(f.content_type, f.file_name) ? '🖼️' : '📄'}</span>
        <div class="cert-file-info">
          <div class="cert-file-name" title="${Utils.escapeHtml(f.file_name)}">${Utils.escapeHtml(f.file_name)}</div>
          <div class="cert-file-meta">${Utils.formatFileSize(f.file_size)} · ${Utils.formatDateTime(f.created_at)}</div>
        </div>
        <div class="cert-file-actions">
          <button class="btn btn-secondary btn-sm" onclick="Certs.previewFile(${i})">预览</button>
          <button class="btn btn-secondary btn-sm" onclick="Certs.downloadFile(${i})">下载</button>
        </div>
      </div>
    `).join('');
  },

  /**
   * 加载某证照的历年培训记录（只读），渲染到详情弹窗列表
   */
  async loadDetailTrainings(certId) {
    const listEl = document.getElementById('cert-trainings-list');
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

    if (!data || data.length === 0) {
      listEl.innerHTML = `<p class="text-muted" style="padding:8px 0;">该证照暂无培训记录。</p>`;
      return;
    }

    listEl.innerHTML = `<div class="training-cards">` + data.map((t) => `
      <div class="training-card">
        <div class="training-card-head">
          <span class="training-year-badge">${t.training_year} 年</span>
          ${t.training_result ? `<span class="badge badge-success">${Utils.escapeHtml(t.training_result)}</span>` : ''}
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
   * 生成附件签名 URL（私有桶下载/预览）
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
   * 预览附件（图片在弹窗内预览，PDF 新窗口打开）
   */
  async previewFile(index) {
    const file = this.state.detailFiles[index];
    if (!file) return;
    const url = await this.signedUrl(file);
    if (!url) return;

    if (Utils.isImageFile(file.content_type, file.file_name)) {
      const existing = document.getElementById('file-preview-modal');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', `
        <div class="modal-overlay" id="file-preview-modal" onclick="Certs.onModalOverlayClick(event, 'file-preview-modal')">
          <div class="modal-card modal-lg file-preview-card">
            <div class="modal-header">
              <h2>${Utils.escapeHtml(file.file_name)}</h2>
              <button class="modal-close" onclick="Certs.closePreviewModal()">&times;</button>
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
    const modal = document.getElementById('file-preview-modal');
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

  // ========================================================================
  // 弹窗通用
  // ========================================================================

  /**
   * 模态框遮罩点击关闭（区分详情 / 预览弹窗）
   */
  onModalOverlayClick(event, modalId) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      if (modalId === 'cert-detail-modal') {
        this.closeDetailModal();
      } else {
        this.closePreviewModal();
      }
    }
  },
};

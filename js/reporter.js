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
   * 任何一步失败都回退到默认值（内置字段用 Utils.DEFAULT_REPORT_FIELDS 兜底），不影响主流程
   */
  async loadFormConfig() {
    try {
      const [typesRes, fieldsRes] = await Promise.all([
        sb.from('project_types').select('*').order('sort_order'),
        sb.from('report_fields').select('*').order('sort_order')
      ]);
      if (!typesRes.error) {
        this.state.projectTypes = (typesRes.data || []).filter(t => t.is_active !== false);
      }
      if (!fieldsRes.error) {
        // 新库：report_fields 已含内置字段种子；旧库：内置字段用静态定义兜底
        this.state.formFields = Utils.normalizeReportFields(fieldsRes.data || []);
      }
    } catch (e) {
      console.warn('加载报送表单配置失败，使用默认配置:', e);
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
    this.state.email = profile.email || '';

    const ym = Utils.getCurrentYearMonth();
    this.state.year = ym.year;
    this.state.month = ym.month;

    container.innerHTML = this.buildHTML();
    this.bindEvents(container);
    await this.loadFormConfig();
    await this.loadReports();
  },

  /**
   * 构建 HTML 结构
   */
  buildHTML() {
    return `
      <div class="dashboard">
        ${this.buildHeader()}
        <div class="dashboard-content">
          ${this.buildToolbar()}
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
          <h1>施工项目月报管理系统</h1>
          <span class="badge badge-muted">${Utils.escapeHtml(this.state.departmentName)}</span>
        </div>
        <div class="header-right">
          <div class="user-info">
            <span class="user-name">${Utils.escapeHtml(name)}</span>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="AccountSettings.open()">账户设置</button>
          <button class="btn btn-secondary btn-sm" onclick="Auth.logout()">退出登录</button>
        </div>
      </div>
    `;
  },

  /**
   * 工具栏：月份选择 + 新建按钮
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
            ${months.map(m => `<option value="${m}" ${m === this.state.month ? 'selected' : ''}>${m}月</option>`).join('')}
          </select>
        </div>
        <div class="toolbar-right">
          <button class="btn btn-primary" onclick="Reporter.showReportForm()">+ 新建项目报送</button>
        </div>
      </div>
    `;
  },

  /**
   * 月份切换
   */
  onMonthChange() {
    this.state.year = parseInt(document.getElementById('filter-year').value);
    this.state.month = parseInt(document.getElementById('filter-month').value);
    this.loadReports();
  },

  /**
   * 加载报送记录
   */
  async loadReports() {
    const section = document.getElementById('reports-section');
    if (!section) return;

    section.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>本月报送记录</h2></div>
        <div class="card-body">
          <div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div><p style="margin-top:12px;">加载中...</p></div>
        </div>
      </div>
    `;

    const { data, error } = await sb
      .from('project_reports')
      .select('*')
      .eq('department_id', this.state.departmentId)
      .eq('reporting_year', this.state.year)
      .eq('reporting_month', this.state.month)
      .order('submitted_at', { ascending: false });

    if (error) {
      Utils.toast('加载报送记录失败: ' + error.message, 'error');
      section.innerHTML = `
        <div class="card">
          <div class="card-header"><h2>本月报送记录</h2></div>
          <div class="card-body"><div class="alert alert-danger">加载失败：${Utils.escapeHtml(error.message)}</div></div>
        </div>
      `;
      return;
    }

    this.state.reports = data || [];
    this.renderReportsTable();
  },

  /**
   * 渲染报送记录表格
   */
  renderReportsTable() {
    const section = document.getElementById('reports-section');
    if (!section) return;

    const reports = this.state.reports;

    if (reports.length === 0) {
      section.innerHTML = `
        <div class="card">
          <div class="card-header">
            <h2>${this.state.year}年${this.state.month}月报送记录</h2>
          </div>
          <div class="card-body">
            <div class="empty-state">
              <div class="empty-icon">📝</div>
              <p>本月暂无报送记录</p>
              <p style="margin-top:8px;">
                <button class="btn btn-primary" onclick="Reporter.showReportForm()">+ 新建项目报送</button>
              </p>
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

    section.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">本月报送项目数</div>
          <div class="stat-value">${reports.length}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">合同总额（万元）</div>
          <div class="stat-value">${totalAmount.toLocaleString('zh-CN', {maximumFractionDigits: 2})}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">现场总人数</div>
          <div class="stat-value">${totalPersonnel}</div>
        </div>
        <div class="stat-card ${hasHazards > 0 ? 'danger' : 'success'}">
          <div class="stat-label">安全隐患项目</div>
          <div class="stat-value">${hasHazards}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-header">
          <h2>${this.state.year}年${this.state.month}月报送记录</h2>
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
                  <th>工期(月)</th>
                  <th>负责人</th>
                  <th>现场人数</th>
                  <th>车辆数</th>
                  <th>安全自检</th>
                  <th>安全隐患</th>
                  <th>报送时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${reports.map(r => this.renderReportRow(r)).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 渲染单行报送记录
   */
  renderReportRow(r) {
    return `
      <tr>
        <td>${Utils.escapeHtml(r.project_name)}</td>
        <td>${Utils.escapeHtml(r.project_type)}</td>
        <td>${Utils.escapeHtml(r.construction_location)}</td>
        <td>${Utils.formatAmount(r.contract_amount)}</td>
        <td>${r.duration_months}</td>
        <td>${Utils.escapeHtml(r.project_manager)}</td>
        <td>${r.on_site_personnel}</td>
        <td>${r.on_site_vehicles}</td>
        <td>${r.safety_inspection ? '<span class="badge badge-success">已自检</span>' : '<span class="badge badge-danger">未自检</span>'}</td>
        <td>${r.safety_hazards ? '<span class="badge badge-danger">存在隐患</span>' : '<span class="badge badge-success">无</span>'}</td>
        <td style="white-space:nowrap;">${Utils.formatDateTime(r.submitted_at)}</td>
        <td style="white-space:nowrap;">
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
    const fields = this.state.formFields;
    const builtinFields = fields.filter(f => f.is_builtin);
    const customFields = fields.filter(f => !f.is_builtin);

    // 表单默认值
    const v = report || {};
    const ym = Utils.getCurrentYearMonth();
    const defYear = v.reporting_year || ym.year;
    const defMonth = v.reporting_month || ym.month;

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
      <div class="modal-overlay" id="report-modal" onclick="Reporter.onModalOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>${reportId ? '编辑项目报送' : '新建项目报送'}</h2>
            <button class="modal-close" onclick="Reporter.closeModal()">&times;</button>
          </div>
          <div class="modal-body">
            <form id="report-form" onsubmit="return false">
              <div class="form-grid">
                ${builtinHTML}
                ${customHTML}
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
   * 模态框遮罩点击关闭
   */
  onModalOverlayClick(event) {
    if (event.target === event.currentTarget) {
      this.closeModal();
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
    }

    this.closeModal();
    // 更新筛选月份为报送的月份
    this.state.year = data.reporting_year;
    this.state.month = data.reporting_month;
    const yearSelect = document.getElementById('filter-year');
    const monthSelect = document.getElementById('filter-month');
    if (yearSelect) yearSelect.value = String(this.state.year);
    if (monthSelect) monthSelect.value = String(this.state.month);

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

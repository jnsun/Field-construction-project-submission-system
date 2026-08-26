/**
 * utils.js - 通用工具函数
 */

const Utils = {

  /**
   * 显示 Toast 通知
   * @param {string} message - 消息内容
   * @param {'success'|'error'|'info'} type - 类型
   * @param {number} duration - 显示时长(毫秒)
   */
  toast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  /**
   * 格式化日期时间
   * @param {string|Date} date - 日期
   * @returns {string} 格式化后的字符串，如 "2026-08-24 14:30"
   */
  formatDateTime(date) {
    if (!date) return '-';
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  /**
   * 格式化日期
   * @param {string|Date} date - 日期
   * @returns {string} 如 "2026-08-24"
   */
  formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  /**
   * 获取当前年份和月份
   * @returns {{year: number, month: number}}
   */
  getCurrentYearMonth() {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  },

  /**
   * 格式化合同额
   * @param {number} amount - 金额（万元）
   * @returns {string}
   */
  formatAmount(amount) {
    if (amount == null) return '-';
    return Number(amount).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' 万元';
  },

  /**
   * 转义 HTML，防止 XSS
   */
  escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  },

  /**
   * 导出数据为 CSV 文件
   * @param {Array<Object>} data - 数据数组
   * @param {string} filename - 文件名
   * @param {Array<{key: string, label: string}>} columns - 列定义
   */
  exportCSV(data, filename, columns) {
    // 构建表头
    const headers = columns.map(c => c.label);
    const rows = [headers.join(',')];

    // 构建数据行
    for (const item of data) {
      const row = columns.map(c => {
        let val = item[c.key];
        if (typeof val === 'boolean') val = val ? '是' : '否';
        if (val == null) val = '';
        // CSV 转义：包含逗号、引号、换行的字段用双引号包裹
        val = String(val).replace(/"/g, '""');
        if (/[",\n\r]/.test(val)) val = `"${val}"`;
        return val;
      });
      rows.push(row.join(','));
    }

    // 添加 BOM 头确保 Excel 正确识别中文
    const csv = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  },

  /**
   * 构建年份选项列表（当前年份往前 3 年，往后 1 年）
   */
  getYearOptions() {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = currentYear - 3; y <= currentYear + 1; y++) {
      years.push(y);
    }
    return years;
  },

  /**
   * 生成月份选项
   */
  getMonthOptions() {
    return Array.from({ length: 12 }, (_, i) => i + 1);
  },

  /**
   * 创建选择器的 HTML
   */
  buildSelectHTML(name, options, selected, attrs = '') {
    const opts = options.map(opt => {
      const val = typeof opt === 'object' ? opt.value : opt;
      const label = typeof opt === 'object' ? opt.label : opt;
      const isSel = String(val) === String(selected) ? ' selected' : '';
      return `<option value="${Utils.escapeHtml(val)}"${isSel}>${Utils.escapeHtml(label)}</option>`;
    }).join('');
    return `<select name="${name}" ${attrs}>${opts}</select>`;
  },

  /**
   * 系统内置报送字段（"默认项目报送表格"的静态定义）
   * 与 project_reports 表固定列一一对应；当数据库 report_fields 表
   * 尚未包含 is_builtin 标记（旧版配置库）时，前端用它作为默认字段的兜底定义；
   * 新版配置库则由 form-config.sql 中的种子数据提供（is_builtin = true）。
   *
   * 注意：
   *  - field_type 只决定表单控件外观；内置字段的数据类型由数据库列类型决定，
   *    管理员在「报送配置」中不可修改（SQL 层同样锁定）
   *  - project_type 特殊：选项来自 project_types 表，不取 options
   *  - safety_inspection / safety_hazards 在数据库中为 boolean 列，控件用"是/否"下拉
   */
  DEFAULT_REPORT_FIELDS: [
    { field_key: 'project_name', label: '项目名称', field_type: 'text', options: null, is_required: true, sort_order: 1, is_active: true, is_builtin: true },
    { field_key: 'project_type', label: '项目类型', field_type: 'select', options: [], is_required: true, sort_order: 2, is_active: true, is_builtin: true },
    { field_key: 'construction_location', label: '施工地点', field_type: 'text', options: null, is_required: true, sort_order: 3, is_active: true, is_builtin: true },
    { field_key: 'contract_amount', label: '合同额（万元）', field_type: 'number', options: null, is_required: true, sort_order: 4, is_active: true, is_builtin: true },
    { field_key: 'duration_months', label: '工期（月）', field_type: 'number', options: null, is_required: true, sort_order: 5, is_active: true, is_builtin: true },
    { field_key: 'department_entity', label: '项目归属部门或实体', field_type: 'text', options: null, is_required: true, sort_order: 6, is_active: true, is_builtin: true },
    { field_key: 'project_manager', label: '项目负责人', field_type: 'text', options: null, is_required: true, sort_order: 7, is_active: true, is_builtin: true },
    { field_key: 'contact_info', label: '联系方式', field_type: 'text', options: null, is_required: true, sort_order: 8, is_active: true, is_builtin: true },
    { field_key: 'overall_progress', label: '项目整体进度情况', field_type: 'textarea', options: null, is_required: true, sort_order: 9, is_active: true, is_builtin: true },
    { field_key: 'monthly_construction_status', label: '本月项目施工情况', field_type: 'textarea', options: null, is_required: true, sort_order: 10, is_active: true, is_builtin: true },
    { field_key: 'equipment_models', label: '设备型号及数量', field_type: 'textarea', options: null, is_required: true, sort_order: 11, is_active: true, is_builtin: true },
    { field_key: 'on_site_personnel', label: '现场人数', field_type: 'number', options: null, is_required: true, sort_order: 12, is_active: true, is_builtin: true },
    { field_key: 'on_site_vehicles', label: '现场车辆数', field_type: 'number', options: null, is_required: true, sort_order: 13, is_active: true, is_builtin: true },
    { field_key: 'safety_inspection', label: '是否进行安全自检', field_type: 'select', options: ['是', '否'], is_required: true, sort_order: 14, is_active: true, is_builtin: true },
    { field_key: 'safety_hazards', label: '是否存在安全隐患', field_type: 'select', options: ['是', '否'], is_required: true, sort_order: 15, is_active: true, is_builtin: true },
    { field_key: 'safety_hazard_detail', label: '安全隐患详情', field_type: 'textarea', options: null, is_required: true, sort_order: 16, is_active: true, is_builtin: true },
  ],

  /**
   * 归一化报送字段配置列表（兼容新/旧配置库）
   * @param {Array} raw report_fields 表查询结果（可能为空/报错时传 []）
   * @returns {Array} 启用中的完整字段列表（含内置字段）
   */
  normalizeReportFields(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const hasBuiltinFlag = list.some(f => f && Object.prototype.hasOwnProperty.call(f, 'is_builtin'));
    const active = list.filter(f => f && f.is_active !== false);
    // 旧库（report_fields 无 is_builtin 列）：内置字段用静态定义兜底，库中字段视为自定义字段。
    // 静态副本带 builtin_ 伪 id（仅前端识别用），数据库升级后由真实记录替代
    if (!hasBuiltinFlag) {
      const builtins = Utils.DEFAULT_REPORT_FIELDS.map(f => ({ ...f, id: `builtin_${f.field_key}` }));
      return [...builtins, ...active];
    }
    return active;
  },
};

/**
 * 修复「在弹窗内框选文本并划出弹窗后松开鼠标，弹窗被误关闭」的问题。
 * 原理：只有 mousedown 与 松开(mouseup 触发的 click) 都发生在遮罩 .modal-overlay 本身时，
 *       才视为「点击遮罩关闭」。在卡片内按下、拖动到遮罩上松开时，mousedown 起点不在遮罩，
 *       因此不会被判定为点击遮罩，弹窗保持打开。
 * 用法：各弹窗的 onXxxOverlayClick 需额外判断 event.currentTarget.dataset.dismissArmed === '1'
 */
(function setupModalOverlayDismiss() {
  if (window.__modalOverlayDismissReady) return;
  window.__modalOverlayDismissReady = true;
  document.addEventListener('mousedown', (e) => {
    const overlays = document.querySelectorAll('.modal-overlay');
    overlays.forEach((o) => { o.dataset.dismissArmed = ''; });
    const overlay = e.target && e.target.closest ? e.target.closest('.modal-overlay') : null;
    if (overlay && e.target === overlay) {
      overlay.dataset.dismissArmed = '1';
    }
  });
})();

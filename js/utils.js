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

  // ==========================================================================
  // 资质证照模块专用工具（由 license-management 合并而来）
  // ==========================================================================

  /**
   * 转义单引号与反斜杠（用于拼接到 HTML 内联 onclick 参数中）
   */
  esc(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  },

  /**
   * 证件号脱敏（保留前 4 后 4 位）
   * @returns {string} 如 "3301**********1234"
   */
  maskIdNumber(no) {
    const s = String(no || '').trim();
    if (!s) return '';
    if (s.length <= 8) return s;
    return s.slice(0, 4) + '*'.repeat(Math.max(s.length - 8, 0)) + s.slice(-4);
  },

  /**
   * 计算距今天数（正数 = 未来，负数 = 已过去）
   * @param {string} dateStr - 日期字符串（YYYY-MM-DD）
   */
  daysUntil(dateStr) {
    if (!dateStr) return null;
    const target = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  },

  /**
   * 计算证照展示状态（综合生命周期标记 + 有效期）
   * @param {Object} cert - certificates 表记录
   * @param {number} warnDays - 预警天数阈值
   * @returns {{key: string, label: string, badge: string}} badge 为 CSS 类名
   */
  certDisplayStatus(cert, warnDays = 90) {
    if (!cert) return { key: 'unknown', label: '未知', badge: 'badge-muted' };
    // 生命周期优先：已注销 / 已换证归档
    if (cert.status === 'revoked') {
      return { key: 'revoked', label: '已注销', badge: 'badge-muted' };
    }
    if (cert.status === 'replaced') {
      return { key: 'replaced', label: '已换证', badge: 'badge-info' };
    }
    // 在用证照：按有效期计算
    if (cert.is_long_term || !cert.valid_until) {
      return { key: 'valid', label: '长期有效', badge: 'badge-success' };
    }
    const days = this.daysUntil(cert.valid_until);
    if (days == null) return { key: 'valid', label: '有效', badge: 'badge-success' };
    if (days < 0) {
      return { key: 'expired', label: '已过期', badge: 'badge-danger' };
    }
    if (days <= warnDays) {
      return { key: 'expiring', label: `即将到期(${days}天)`, badge: 'badge-warning' };
    }
    return { key: 'valid', label: '有效', badge: 'badge-success' };
  },

  /**
   * 证照大类显示名（简称：公司 / 个人；v1 旧值 enterprise/person 兼容映射）
   */
  categoryLabel(category) {
    const map = {
      company: '公司',
      personal: '个人',
      enterprise: '公司',
      person: '个人',
    };
    return map[category] || '公司';
  },

  /**
   * 公司简称（物化院有限公司 → 物化院，六勘院有限公司 → 六勘院）
   * 未匹配的长名称原样返回，避免影响其它公司
   */
  shortCompany(name) {
    const map = {
      '物化院有限公司': '物化院',
      '六勘院有限公司': '六勘院',
    };
    return map[String(name || '').trim()] || (name || '');
  },

  /**
   * 证照子分类展示文本（sub1 / sub2 以「 / 」连接，如「主要负责人 / 太原」）
   */
  subText(cert) {
    if (!cert) return '';
    return [cert.sub1_value, cert.sub2_value].filter(Boolean).join(' / ');
  },

  /**
   * 证照类型底色（按类型名称稳定映射一种柔和底色，便于人眼区分不同证照类型）
   * 返回 { bg, fg }，bg 为底色、fg 为文字色（均为深底浅字对比）
   */
  typeColor(type) {
    const t = String(type || '').trim();
    const palette = {
      '营业执照':                 { bg: '#dbeafe', fg: '#1e40af' },
      '安全生产许可证':           { bg: '#dcfce7', fg: '#166534' },
      '采矿许可证':               { bg: '#fef9c3', fg: '#854d0e' },
      '爆破作业人员许可证':       { bg: '#fee2e2', fg: '#991b1b' },
      '非煤矿山安全管理人员证书': { bg: '#ede9fe', fg: '#5b21b6' },
      '特种作业人员资格证':       { bg: '#cffafe', fg: '#155e75' },
      '安全生产考核合格证书':     { bg: '#fed7aa', fg: '#9a3412' },
      '注册安全工程师':           { bg: '#fce7f3', fg: '#9d174d' },
      '职业卫生许可证':           { bg: '#e0f2fe', fg: '#075985' },
      '排污许可证':               { bg: '#d9f99d', fg: '#3f6212' },
      '食品经营许可证':           { bg: '#fae8ff', fg: '#86198f' },
      '危险化学品经营许可证':     { bg: '#ffedd5', fg: '#9a3412' },
    };
    if (palette[t]) return palette[t];
    // 兜底：基于名称哈希生成稳定的柔色（HSL 高亮度低饱和，文字用同色系深色）
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return { bg: `hsl(${hue} 65% 90%)`, fg: `hsl(${hue} 55% 28%)` };
  },

  /**
   * 生成「类型」单元格的彩色标签（仅改类型内容的底色，方便区分）
   * @returns {string} HTML
   */
  typeChip(type) {
    const c = this.typeColor(type);
    return `<span class="type-chip" style="background:${c.bg};color:${c.fg};">${Utils.escapeHtml(type)}</span>`;
  },

  /**
   * 子分类排序名次（用于「安全生产考核合格证书」按 A→B→C 排序）
   * 取子分类首字母 A/B/C 映射为 0/1/2；无字母则排最后。
   * @returns {number}
   */
  subCategoryRank(sub1) {
    const s = String(sub1 || '').toUpperCase();
    const m = s.match(/([A-Z])/);
    if (m) return m[1].charCodeAt(0) - 65; // A=0, B=1, C=2, ...
    return 999; // 无字母排最后
  },

  /**
   * 当年培训状态徽章（已培训：绿 / 无需培训：灰 / 待培训：橙；空：—）
   * @returns {string} HTML
   */
  trainingStatusBadge(status) {
    const map = {
      '已培训':   { cls: 'badge-success', text: '已培训' },
      '无需培训': { cls: 'badge-secondary', text: '无需培训' },
      '待培训':   { cls: 'badge-warning', text: '待培训' },
    };
    const m = map[status];
    if (!m) return '<span class="text-muted">—</span>';
    return `<span class="badge ${m.cls}">${m.text}</span>`;
  },

  /**
   * 根据证照大类 / 类型 / 子分类判断培训要求
   * @param {string} category 'company' | 'personal'
   * @param {string} certType 证照类型名称
   * @param {string} [sub1] 子分类1（如培训机构）
   * @returns {'none'|'annual'|'period2'|null}
   *   - none    ：无需每年培训（公司证照、特种作业、安全生产考核合格）
   *   - annual  ：每年需培训，取证当年豁免（爆破作业、非煤矿山安管等其余个人证照）
   *   - period2 ：按有效期窗口计，有效期内需培训 2 次（注册安全工程师）
   *   - null    ：规则未覆盖，沿用存储值
   */
  trainingRequirement(category, certType, sub1) {
    if (category === 'company') return 'none';
    if (category !== 'personal') return null;
    const t = String(certType || '').trim();
    // 无需每年培训（到期前换证即可）
    if (t === '特种作业人员资格证') return 'none';
    if (t === '安全生产考核合格证书') return 'none';
    // 注册安全工程师：有效期内需培训 2 次
    if (t === '注册安全工程师') return 'period2';
    // 其余个人证照（含爆破作业人员许可证、非煤矿山安全管理人员证书等）每年需培训，取证当年豁免
    return 'annual';
  },

  /**
   * 统计某证照在「有效期窗口」内的培训次数（注册安全工程师用）
   * 以 valid_from（缺省取 issue_date）为起点、valid_until 为终点，闭区间统计培训日期落在区间内的记录数。
   * 起止日期缺失时，退化为统计全部培训记录数。
   */
  certTrainingCountInPeriod(cert, trainings) {
    if (!trainings || !trainings.length) return 0;
    const from = cert.valid_from || cert.issue_date;
    const to = cert.valid_until;
    if (from && to) {
      let n = 0;
      for (const t of trainings) {
        const d = t.training_date;
        if (d && d >= from && d <= to) n++;
      }
      return n;
    }
    return trainings.length;
  },

  /**
   * 计算某证照的「有效培训状态」与培训进度，用于台账徽章与统计卡片
   * @returns {{status:string, count:number, need:number}}
   *   - need>0 表示按有效期窗口计（注册安全工程师），count 为窗口内已培训次数，status 由达标情况决定
   *   - need=0 表示按年计或无需培训，沿用存储的 training_status
   */
  certTrainingInfo(cert, trainings) {
    const req = this.trainingRequirement(cert.cert_category, cert.cert_type, cert.sub1_value);
    if (req === 'none') return { status: '无需培训', count: 0, need: 0 };
    if (req === 'period2') {
      const count = this.certTrainingCountInPeriod(cert, trainings);
      const need = 2;
      return { status: count >= need ? '已培训' : '待培训', count, need };
    }
    // annual：每年需培训；取证当年（发证日期所在年 = 当前年）豁免，当年无需培训
    const obtainYear = String(cert.issue_date || cert.valid_from || '').slice(0, 4);
    const curYear = String(new Date().getFullYear());
    if (obtainYear && obtainYear === curYear) {
      return { status: '无需培训', count: 0, need: 0 };
    }
    // 非取证当年：需每年培训，沿用存储状态，未明确「已培训」的视为待培训
    const ts = cert.training_status;
    return { status: ts === '已培训' ? '已培训' : '待培训', count: 0, need: 0 };
  },

  /**
   * 换证（到期前再取证）要求说明，用于详情提示
   *  - 非煤矿山安全管理人员证书：到期前需培训 6 天并换证
   *  - 其余证照：到期前换证
   */
  reCertRequirement(certType) {
    const t = String(certType || '').trim();
    if (t === '非煤矿山安全管理人员证书') return '到期前需培训 6 天并换证';
    return '到期前换证';
  },

  /**
   * 生成台账「培训情况」单元格 HTML：
   *  - period2（注册安全工程师）：已培训 (n/2) / 待培训 (n/2)
   *  - 其它：沿用原 trainingStatusBadge（已培训 / 待培训 / 无需培训 / —）
   */
  trainingColHTML(cert, trainings) {
    const info = this.certTrainingInfo(cert, trainings);
    if (info.need > 0) {
      const done = info.count >= info.need;
      return `<span class="badge ${done ? 'badge-success' : 'badge-warning'}">${info.status} (${info.count}/${info.need})</span>`;
    }
    return this.trainingStatusBadge(info.status);
  },

  /**
   * 将培训需求映射为默认「当年培训状态」值
   * @returns {'无需培训'|'待培训'|''}
   */
  trainingDefaultStatus(category, certType, sub1) {
    const req = this.trainingRequirement(category, certType, sub1);
    if (req === 'annual') return '待培训';
    if (req === 'none') return '无需培训';
    return '';
  },

  /**
   * 附件文件大小格式化
   */
  formatFileSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  },

  /**
   * 附件是否为可预览图片类型
   */
  isImageFile(contentType, fileName) {
    const ct = String(contentType || '');
    if (ct.startsWith('image/')) return true;
    return /\.(png|jpe?g|webp|gif)$/i.test(String(fileName || ''));
  },

  /**
   * 绑定「回到顶部」悬浮按钮：滚动超过阈值时显现，点击平滑回到顶部。
   * 同一页面多次调用 render 不会重复绑定滚动监听；按钮 click 仅绑定一次。
   * @param {string} btnId 按钮元素 id
   */
  bindBackToTop(btnId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    if (!btn.dataset.bound) {
      btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
      btn.dataset.bound = '1';
    }
    if (!window.__backToTopBound) {
      window.__backToTopBound = true;
      const onScroll = () => {
        const y = window.scrollY || document.documentElement.scrollTop || 0;
        document.querySelectorAll('.back-to-top').forEach(b => b.classList.toggle('show', y > 320));
      };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
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

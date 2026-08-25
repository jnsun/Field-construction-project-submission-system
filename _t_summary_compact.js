'use strict';
const fs = require('fs');

// ---- mock environment ----
const toasts = [];
const rpcCalls = [];

const sb = {
  from: (t) => ({
    select: () => ({
      eq: () => ({ eq: () => ({ order: () => ({ order: () => ({ data: [], error: null }) }) }) }),
      order: () => ({ data: [], error: null }),
    }),
    rpc: (fn, params) => { rpcCalls.push({ fn, params }); return Promise.resolve({ data: null, error: null }); },
  }),
};

const Utils = {
  toast: (msg, type) => toasts.push({ msg, type }),
  escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  formatDateTime: (d) => d ? d.slice(0, 19).replace('T', ' ') : '-',
  formatAmount: (a) => a == null ? '-' : Number(a).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 万元',
  normalizeReportFields: (raw) => raw.length > 0 ? raw : [
    { field_key: 'project_name', label: '项目名称', field_type: 'text', is_required: true, sort_order: 1, is_active: true, is_builtin: true },
    { field_key: 'project_type', label: '项目类型', field_type: 'select', options: [], is_required: true, sort_order: 2, is_active: true, is_builtin: true },
    { field_key: 'construction_location', label: '施工地点', field_type: 'text', is_required: true, sort_order: 3, is_active: true, is_builtin: true },
    { field_key: 'contract_amount', label: '合同额（万元）', field_type: 'number', is_required: true, sort_order: 4, is_active: true, is_builtin: true },
    { field_key: 'duration_months', label: '工期（月）', field_type: 'number', is_required: true, sort_order: 5, is_active: true, is_builtin: true },
    { field_key: 'department_entity', label: '项目归属部门或实体', field_type: 'text', is_required: true, sort_order: 6, is_active: true, is_builtin: true },
    { field_key: 'project_manager', label: '项目负责人', field_type: 'text', is_required: true, sort_order: 7, is_active: true, is_builtin: true },
    { field_key: 'contact_info', label: '联系方式', field_type: 'text', is_required: true, sort_order: 8, is_active: true, is_builtin: true },
    { field_key: 'overall_progress', label: '项目整体进度情况', field_type: 'textarea', is_required: true, sort_order: 9, is_active: true, is_builtin: true },
    { field_key: 'monthly_construction_status', label: '本月项目施工情况', field_type: 'textarea', is_required: true, sort_order: 10, is_active: true, is_builtin: true },
    { field_key: 'equipment_models', label: '设备型号及数量', field_type: 'textarea', is_required: true, sort_order: 11, is_active: true, is_builtin: true },
    { field_key: 'on_site_personnel', label: '现场人数', field_type: 'number', is_required: true, sort_order: 12, is_active: true, is_builtin: true },
    { field_key: 'on_site_vehicles', label: '现场车辆数', field_type: 'number', is_required: true, sort_order: 13, is_active: true, is_builtin: true },
    { field_key: 'safety_inspection', label: '是否进行安全自检', field_type: 'select', options: ['是', '否'], is_required: true, sort_order: 14, is_active: true, is_builtin: true },
    { field_key: 'safety_hazards', label: '是否存在安全隐患', field_type: 'select', options: ['是', '否'], is_required: true, sort_order: 15, is_active: true, is_builtin: true },
    { field_key: 'safety_hazard_detail', label: '安全隐患详情', field_type: 'textarea', is_required: true, sort_order: 16, is_active: true, is_builtin: true },
  ].map(f => ({ ...f, id: `builtin_${f.field_key}` })),
};

const Auth = {
  isSuperAdmin: () => true,
  isAdmin: () => true,
  currentProfile: { id: 'u1', email: 'admin@test.com', role: 'admin', is_super_admin: true, full_name: '超管' },
  changePhone: () => Promise.resolve({ error: null }),
};

function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    _html: '',
    _children: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    _listeners: {},
    addEventListener(ev, cb) { this._listeners[ev] = cb; },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(c) { this._children.push(c); return c; },
    remove() {},
    insertAdjacentHTML(pos, html) { this._html += html; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._html = v; },
    get textContent() { return this._html; },
    set value(v) { this._val = v; },
    get value() { return this._val || ''; },
    focus() {},
  };
  return el;
}

function getEl(id) {
  if (!getEl._cache) getEl._cache = {};
  if (!getEl._cache[id]) getEl._cache[id] = makeElement('div');
  return getEl._cache[id];
}

const document = {
  getElementById: (id) => getEl(id),
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: (tag) => {
    const el = makeElement(tag);
    el.setAttribute = () => {};
    el.appendChild = (c) => { el._children.push(c); return c; };
    return el;
  },
  body: { insertAdjacentHTML: () => {} },
  addEventListener() {},
};

const FormData = function() {};
FormData.prototype.get = function(k) { return this._data && this._data[k] || ''; };
FormData.prototype.set = function(k, v) { this._data = this._data || {}; this._data[k] = v; };

const window = {};

// ---- load real admin.js ----
const code = fs.readFileSync('js/admin.js', 'utf8');
const Admin = new Function(
  'window', 'document', 'Utils', 'Auth', 'sb', 'FormData', 'setTimeout', 'console', 'fetch',
  code + '\n; return Admin;'
)(window, document, Utils, Auth, sb, FormData, setTimeout, console, () => {});

// ---- assertions ----
let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + label); }
}

// Setup state with default fields
Admin.state = {
  reports: [
    { id: 'r1', department_id: 'd1', departments: { name: '工程一部' },
      project_name: '测试项目A', project_type: '新建', construction_location: '北京',
      contract_amount: 500, duration_months: 12, department_entity: '工程一部',
      project_manager: '张三', contact_info: '13800000000',
      overall_progress: '项目整体进度情况描述文字', monthly_construction_status: '本月施工情况描述',
      equipment_models: '挖掘机2台', on_site_personnel: 20, on_site_vehicles: 5,
      safety_inspection: true, safety_hazards: false, safety_hazard_detail: '',
      custom_data: {}, submitted_at: '2026-08-25T10:00:00', reporting_year: 2026, reporting_month: 8 },
  ],
  reportFields: Utils.normalizeReportFields([]),
  year: 2026, month: 8, loading: false,
  departments: [{ id: 'd1', name: '工程一部', sort_order: 1 }],
  noFieldStatus: {},
  statusFilter: 'all',
  hasStatusColumn: true, hasPhoneColumn: true,
};

// Render summary
const summaryContainer = getEl('admin-summary');
Admin.renderSummary();
const html = summaryContainer.innerHTML;

// T1: table has summary-table class
assert(html.includes('class="data-table summary-table"'), 'T1 table has summary-table class');

// T2: wrapper has summary-wrapper class
assert(html.includes('table-wrapper summary-wrapper'), 'T2 wrapper has summary-wrapper class');

// T3: safety_hazard_detail column NOT in summary table header
assert(!html.includes('安全隐患详情'), 'T3 safety_hazard_detail header absent from summary');

// T4: safety_hazard_detail still in reportFields (not removed from state)
assert(Admin.state.reportFields.some(f => f.field_key === 'safety_hazard_detail'), 'T4 safety_hazard_detail still in reportFields state');

// T5: compact field headers have th-compact class
assert(html.includes('th-compact'), 'T5 th-compact class present');

// T6: duration_months header has th-compact
const durTh = html.match(/<th class="th-compact">\s*工期（月）/);
assert(durTh !== null, 'T6 duration_months th has th-compact');

// T7: on_site_personnel header has th-compact
const personnelTh = html.match(/<th class="th-compact">\s*现场人数/);
assert(personnelTh !== null, 'T7 on_site_personnel th has th-compact');

// T8: safety_inspection header has th-compact
const inspectTh = html.match(/<th class="th-compact">\s*是否进行安全自检/);
assert(inspectTh !== null, 'T8 safety_inspection th has th-compact');

// T9: safety_hazards header has th-compact
const hazardsTh = html.match(/<th class="th-compact">\s*是否存在安全隐患/);
assert(hazardsTh !== null, 'T9 safety_hazards th has th-compact');

// T10: project_name header does NOT have th-compact (has cell-project-name)
const pnTh = html.match(/<th class="cell-project-name">\s*项目名称/);
assert(pnTh !== null, 'T10 project_name th has cell-project-name not th-compact');

// T11: compact cells have cell-compact class
assert(html.includes('cell-compact'), 'T11 cell-compact class present in rows');

// T12: SUMMARY_HIDDEN_KEYS is a Set containing safety_hazard_detail
assert(Admin.SUMMARY_HIDDEN_KEYS instanceof Set && Admin.SUMMARY_HIDDEN_KEYS.has('safety_hazard_detail'), 'T12 SUMMARY_HIDDEN_KEYS set correct');

// T13: COMPACT_KEYS is a Set with 6 entries
assert(Admin.COMPACT_KEYS instanceof Set && Admin.COMPACT_KEYS.size === 6, 'T13 COMPACT_KEYS has 6 entries');

// T14: COMPACT_KEYS includes all expected fields
assert(Admin.COMPACT_KEYS.has('duration_months') && Admin.COMPACT_KEYS.has('contract_amount') &&
       Admin.COMPACT_KEYS.has('on_site_personnel') && Admin.COMPACT_KEYS.has('on_site_vehicles') &&
       Admin.COMPACT_KEYS.has('safety_inspection') && Admin.COMPACT_KEYS.has('safety_hazards'),
       'T14 COMPACT_KEYS contains all 6 expected fields');

// T15: number of th elements (should be 2 + 15 fields = 17, since safety_hazard_detail is hidden)
// Original 16 fields - 1 hidden = 15 field columns + 序号 + 报送部门 + 报送时间 = 18
const thCount = (html.match(/<th/g) || []).length;
assert(thCount === 18, 'T15 total th count = 18 (got ' + thCount + ')');

// T16: number of compact th = 6
const compactThCount = (html.match(/class="th-compact"/g) || []).length;
assert(compactThCount === 6, 'T16 compact th count = 6 (got ' + compactThCount + ')');

// T17: overall_progress header does NOT have th-compact (it's a medium-width truncated field)
const progressTh = html.match(/<th class="">\s*项目整体进度情况/);
assert(progressTh !== null, 'T17 overall_progress th has no compact class');

// T18: renderSummaryRow can be called with fields param
const rowHtml = Admin.renderSummaryRow(Admin.state.reports[0], 0, Admin.state.reportFields.filter(f => !Admin.SUMMARY_HIDDEN_KEYS.has(f.field_key)));
assert(!rowHtml.includes('安全隐患详情'), 'T18 renderSummaryRow does not include safety_hazard_detail');

// T19: showCompletedDetail still includes safety_hazard_detail (detail popup not filtered)
Admin.state.completedProjects = Admin.state.reports;
const detailHtml = Admin.showCompletedDetail ? '' : '';
// showCompletedDetail writes to body via insertAdjacentHTML; we can't easily test without a deeper mock
// Instead verify the fields used in showCompletedDetail are unfiltered
assert(Admin.state.reportFields.some(f => f.field_key === 'safety_hazard_detail'), 'T19 reportFields still has safety_hazard_detail for detail view');

// T20: contract_amount header has th-compact
const amountTh = html.match(/<th class="th-compact">\s*合同额（万元）/);
assert(amountTh !== null, 'T20 contract_amount th has th-compact');

// T21: on_site_vehicles header has th-compact
const vehiclesTh = html.match(/<th class="th-compact">\s*现场车辆数/);
assert(vehiclesTh !== null, 'T21 on_site_vehicles th has th-compact');

// T22: compact cell values are centered (cell-compact class in row)
assert(rowHtml.includes('class="cell-compact"'), 'T22 cell-compact present in rendered row');

console.log(`\n${pass} passed, ${fail} failed (${pass + fail} total)`);
process.exit(fail > 0 ? 1 : 0);

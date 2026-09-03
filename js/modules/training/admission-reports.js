// =============================================================
// js/modules/training/admission-reports.js —— 准入固定报表
// =============================================================
const TrainingAdmissionReports = {
  state: { projects: [], report: 'ledger', rows: [], year: new Date().getFullYear() },
  labels: { ledger: '三级教育台账', cards: '三级安全教育记录卡', signatures: '培训签到表', exam: '考试成绩单', annual: '年度培训统计' },

  async render(box) {
    box.innerHTML = `<div class="toolbar"><div class="toolbar-left"><label>报表：</label><select id="admission-report-type" onchange="TrainingAdmissionReports.changeType()">${Object.entries(this.labels).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><label>年度：</label><input id="admission-report-year" type="number" min="2020" max="2100" value="${this.state.year}" style="width:88px" onchange="TrainingAdmissionReports.changeYear()"><label>项目：</label><select id="admission-report-project" onchange="TrainingAdmissionReports.loadReport()"><option value="">全部项目</option></select></div><div class="toolbar-right"><button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionReports.loadReport()">刷新</button><button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionReports.printReport()">打印 / 保存 PDF</button><button class="btn btn-primary btn-sm" onclick="TrainingAdmissionReports.exportCsv()">导出 CSV</button></div></div><div id="admission-report-body"></div>`;
    const { data, error } = await sb.from('site_projects').select('id, project_code, name').order('created_at', { ascending: false });
    if (error) throw error;
    this.state.projects = data || [];
    const sel = document.getElementById('admission-report-project');
    if (sel) sel.innerHTML += this.state.projects.map(p => `<option value="${p.id}">${Utils.escapeHtml(p.project_code)} · ${Utils.escapeHtml(p.name)}</option>`).join('');
    await this.loadReport();
  },

  changeType() { this.loadReport(); },
  changeYear() { this.state.year = Number(document.getElementById('admission-report-year')?.value) || new Date().getFullYear(); this.loadReport(); },

  async loadReport() {
    const type = (document.getElementById('admission-report-type') || {}).value || 'ledger';
    const projectId = (document.getElementById('admission-report-project') || {}).value || null;
    const rpc = type === 'signatures' ? 'training_admission_signature_report' : (type === 'cards' ? 'training_admission_record_cards' : (type === 'annual' ? 'training_admission_annual_stats' : 'training_admission_report'));
    const result = await sb.rpc(rpc, type === 'annual' ? { p_year: this.state.year, p_project_id: projectId } : { p_project_id: projectId });
    if (result.error) { const body = document.getElementById('admission-report-body'); if (body) body.innerHTML = `<div class="alert alert-danger">${Utils.escapeHtml(result.error.message)}</div>`; return; }
    this.state.report = type; this.state.rows = result.data || [];
    this.renderReport();
  },

  renderReport() {
    const box = document.getElementById('admission-report-body'); if (!box) return;
    const type = this.state.report;
    if (type === 'annual') { this.renderAnnual(box); return; }
    if (type === 'cards') { this.renderCards(box); return; }
    if (type === 'signatures') {
      box.innerHTML = `<div class="card"><div class="card-header"><h2>培训签到表（${this.state.rows.length}）</h2></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr><th>项目</th><th>人员</th><th>培训层级</th><th>签署角色</th><th>签署时间</th><th>记录哈希</th></tr></thead><tbody>${this.state.rows.length ? this.state.rows.map(r => `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td>${Utils.escapeHtml(r.employee_name)}</td><td>${Utils.escapeHtml(r.level_name)}</td><td>${Utils.escapeHtml(r.signer_role)}</td><td>${Utils.escapeHtml((r.signed_at || '').slice(0, 16).replace('T', ' '))}</td><td>${Utils.escapeHtml(r.record_hash || '')}</td></tr>`).join('') : TrainingModule.emptyRow(6, '暂无电子签到记录')}</tbody></table></div></div>`;
      return;
    }
    const rows = this.state.rows;
    box.innerHTML = `<div class="card"><div class="card-header"><h2>${type === 'exam' ? '考试成绩单' : '三级教育台账'}（${rows.length}）</h2></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:1050px"><thead><tr><th>项目</th><th>人员 / 工种</th><th>外协单位</th><th>公司级</th><th>经营实体级</th><th>项目级</th><th>专项</th><th>考试成绩</th><th>上岗状态</th><th>凭证有效至</th></tr></thead><tbody>${rows.length ? rows.map(r => `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td>${Utils.escapeHtml(r.employee_name)}<br><span class="text-muted">${Utils.escapeHtml(r.work_position || '')}</span></td><td>${Utils.escapeHtml(r.contractor_name || '内部员工')}</td><td>${r.company_done || 0}</td><td>${r.entity_done || 0}</td><td>${r.project_done || 0}</td><td>${r.special_done || 0}</td><td>${r.exam_score == null ? '—' : r.exam_score}</td><td>${this.status(r.admission_status)}</td><td>${Utils.escapeHtml(r.valid_until || '—')}</td></tr>`).join('') : TrainingModule.emptyRow(10, '暂无准入记录')}</tbody></table></div></div>`;
  },

  renderCards(box) {
    const rows = this.state.rows;
    box.innerHTML = `<div class="card"><div class="card-header"><h2>三级安全教育记录卡（${rows.length}）</h2><span class="text-muted">打印时按人员逐页生成，培训内容取自实际课件</span></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:920px"><thead><tr><th>项目</th><th>人员</th><th>公司级</th><th>经营实体级</th><th>项目级/专项</th><th>完整签字</th><th>现场确认</th><th>状态</th></tr></thead><tbody>${rows.length ? rows.map(r => { const levels = Array.isArray(r.levels) ? r.levels : []; const text = level => levels.filter(x => x.level === level).map(x => `${x.plan_title || '未命名'}${x.completed_at ? '（已完成）' : '（未完成）'}`).join('<br>') || '—'; return `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td><b>${Utils.escapeHtml(r.employee_name)}</b><br><span class="text-muted">${Utils.escapeHtml(r.work_position || '')}</span></td><td>${text('company')}</td><td>${text('entity')}</td><td>${text('project')}${text('special') !== '—' ? `<br>${text('special')}` : ''}</td><td>${r.final_signed_at ? Utils.escapeHtml(String(r.final_signed_at).slice(0, 16).replace('T', ' ')) : '未签署'}</td><td>${r.site_confirmed_at ? Utils.escapeHtml(String(r.site_confirmed_at).slice(0, 16).replace('T', ' ')) : '未确认'}</td><td>${this.status(r.admission_status)}</td></tr>`; }).join('') : TrainingModule.emptyRow(8, '暂无可打印的三级教育记录卡')}</tbody></table></div></div>`;
  },

  status(s) { const map = { eligible: ['可上岗', 'badge-success'], blocked: ['禁止上岗', 'badge-danger'], project_closed: ['项目已关闭', 'badge-muted'], expired: ['已过期', 'badge-danger'], pending: ['待完成', 'badge-warning'], learning: ['学习中', 'badge-info'], exam_pending: ['待考试', 'badge-warning'], pending_sign: ['待签字', 'badge-warning'], pending_site_confirm: ['待现场确认', 'badge-warning'] }; const x = map[s] || [s || '待处理', 'badge-muted']; return `<span class="badge ${x[1]}">${x[0]}</span>`; },

  renderAnnual(box) {
    const rows = this.state.rows;
    const sum = key => rows.reduce((n, x) => n + Number(x[key] || 0), 0);
    const total = sum('admission_total'), eligible = sum('eligible_total'), passed = sum('exam_passed_total');
    box.innerHTML = `<div class="stats-grid">${this.card('准入记录', total, 'total')}${this.card('当前可上岗', eligible, 'success')}${this.card('综合考试通过', passed, 'info')}${this.card('累计有效学时', sum('effective_hours'), 'warning')}</div><div class="card"><div class="card-header"><h2>${this.state.year}年度项目培训统计</h2></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:980px"><thead><tr><th>项目</th><th>准入人数</th><th>可上岗</th><th>公司级</th><th>经营实体级</th><th>项目级</th><th>专项</th><th>有效学时</th><th>考试通过/次数</th><th>禁止/失效</th></tr></thead><tbody>${rows.length ? rows.map(r => `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td>${r.admission_total}</td><td>${r.eligible_total}</td><td>${r.company_completed}</td><td>${r.entity_completed}</td><td>${r.project_completed}</td><td>${r.special_completed}</td><td>${r.effective_hours}</td><td>${r.exam_passed_total} / ${r.exam_attempts_total}</td><td>${r.blocked_total}</td></tr>`).join('') : TrainingModule.emptyRow(10, '本年度暂无项目准入记录')}</tbody></table></div></div>`;
  },

  card(label, value, cls) { return `<div class="stat-card ${cls}"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`; },

  exportCsv() {
    if (!this.state.rows.length) { Utils.toast('暂无数据可导出', 'info'); return; }
    const type = this.state.report;
    const columns = type === 'annual'
      ? [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'admission_total', label: '准入人数' }, { key: 'eligible_total', label: '可上岗人数' }, { key: 'company_completed', label: '公司级完成' }, { key: 'entity_completed', label: '经营实体级完成' }, { key: 'project_completed', label: '项目级完成' }, { key: 'special_completed', label: '专项完成' }, { key: 'effective_hours', label: '有效学时' }, { key: 'exam_passed_total', label: '考试通过' }, { key: 'exam_attempts_total', label: '考试次数' }, { key: 'blocked_total', label: '禁止或失效' }]
      : type === 'cards'
      ? [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'employee_name', label: '人员' }, { key: 'employee_no', label: '工号' }, { key: 'department_name', label: '部门' }, { key: 'work_position', label: '工种' }, { key: 'phone', label: '联系电话' }, { key: 'id_number', label: '身份证号' }, { key: 'contractor_name', label: '外协单位' }, { key: 'admission_status', label: '状态' }, { key: 'valid_until', label: '有效至' }]
      : type === 'signatures'
      ? [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'employee_name', label: '人员' }, { key: 'level_name', label: '培训层级' }, { key: 'signer_role', label: '签署角色' }, { key: 'signed_at', label: '签署时间' }, { key: 'record_hash', label: '记录哈希' }]
      : [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'employee_name', label: '人员' }, { key: 'phone', label: '手机号' }, { key: 'work_position', label: '工种' }, { key: 'contractor_name', label: '外协单位' }, { key: 'company_done', label: '公司级完成数' }, { key: 'entity_done', label: '经营实体级完成数' }, { key: 'project_done', label: '项目级完成数' }, { key: 'special_done', label: '专项完成数' }, { key: 'exam_score', label: '考试成绩' }, { key: 'admission_status', label: '状态' }, { key: 'valid_until', label: '凭证有效至' }];
    Utils.exportCSV(this.state.rows, `培训准入${this.labels[type] || '报表'}_${Utils.formatDate(new Date())}.csv`, columns);
  },

  printReport() {
    const rows = this.state.rows;
    if (!rows.length) { Utils.toast('暂无数据可打印', 'info'); return; }
    const type = this.state.report;
    const projectId = (document.getElementById('admission-report-project') || {}).value;
    const project = this.state.projects.find(p => p.id === projectId);
    const title = this.labels[type] || '培训准入报表';
    const esc = v => Utils.escapeHtml(v == null ? '' : String(v));
    if (type === 'cards') { this.printRecordCards(rows, project); return; }
    let head = '', body = '';
    if (type === 'annual') {
      head = '<tr><th>序号</th><th>项目</th><th>准入人数</th><th>可上岗</th><th>公司级</th><th>经营实体级</th><th>项目级</th><th>专项</th><th>有效学时</th><th>考试通过/次数</th><th>禁止/失效</th></tr>';
      body = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.project_code)} ${esc(r.project_name)}</td><td>${r.admission_total}</td><td>${r.eligible_total}</td><td>${r.company_completed}</td><td>${r.entity_completed}</td><td>${r.project_completed}</td><td>${r.special_completed}</td><td>${esc(r.effective_hours)}</td><td>${r.exam_passed_total} / ${r.exam_attempts_total}</td><td>${r.blocked_total}</td></tr>`).join('');
    } else if (type === 'signatures') {
      head = '<tr><th>序号</th><th>项目</th><th>人员</th><th>培训层级</th><th>签署角色</th><th>签署时间</th><th>记录哈希</th></tr>';
      body = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.project_code)} ${esc(r.project_name)}</td><td>${esc(r.employee_name)}</td><td>${esc(r.level_name)}</td><td>${esc(r.signer_role)}</td><td>${esc((r.signed_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.record_hash || '')}</td></tr>`).join('');
    } else {
      head = '<tr><th>序号</th><th>项目</th><th>人员</th><th>工种</th><th>外协单位</th><th>公司级</th><th>经营实体级</th><th>项目级</th><th>专项</th><th>考试成绩</th><th>上岗状态</th><th>有效至</th></tr>';
      body = rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.project_code)} ${esc(r.project_name)}</td><td>${esc(r.employee_name)}</td><td>${esc(r.work_position || '')}</td><td>${esc(r.contractor_name || '内部员工')}</td><td>${r.company_done || 0}</td><td>${r.entity_done || 0}</td><td>${r.project_done || 0}</td><td>${r.special_done || 0}</td><td>${r.exam_score == null ? '—' : esc(r.exam_score)}</td><td>${esc(this.statusText(r.admission_status))}</td><td>${esc(r.valid_until || '—')}</td></tr>`).join('');
    }
    const w = window.open('', '_blank'); if (!w) { Utils.toast('浏览器阻止了打印窗口，请允许弹窗后重试', 'error'); return; }
    w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page{size:A4 landscape;margin:12mm}body{font-family:"Microsoft YaHei",sans-serif;color:#111;font-size:11px}h1{text-align:center;font-size:19px;margin:0 0 10px}p{margin:4px 0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #222;padding:5px;vertical-align:top}th{text-align:center;background:#eee}td:first-child{text-align:center;width:30px}.footer{margin-top:18px;display:flex;justify-content:space-between}@media print{body{font-size:10px}}</style></head><body><h1>${esc(title)}</h1><p>项目范围：${esc(project ? `${project.project_code} ${project.name}` : '全部可见项目')}</p><p>生成时间：${esc(new Date().toLocaleString())}</p><table><thead>${head}</thead><tbody>${body}</tbody></table><div class="footer"><span>制表：________________</span><span>审核：________________</span><span>日期：________年____月____日</span></div></body></html>`);
    w.document.close(); w.focus(); w.print();
  },

  printRecordCards(rows, project) {
    const esc = v => Utils.escapeHtml(v == null ? '' : String(v));
    const label = { company: '公司级教育', entity: '经营实体级教育', project: '项目级教育', special: '专项培训' };
    const date = v => v ? esc(String(v).slice(0, 16).replace('T', ' ')) : '未完成';
    const pages = rows.map(r => {
      const levels = Array.isArray(r.levels) ? r.levels : [];
      const blocks = ['company', 'entity', 'project', 'special'].map(level => levels.filter(x => x.level === level).map(x => `<section><h2>${label[level]}</h2><p><b>培训计划：</b>${esc(x.plan_title || '—')}　<b>计划学时：</b>${esc(x.required_hours || '未设置')} 小时　<b>完成时间：</b>${date(x.completed_at)}</p><p><b>实际学习课件：</b>${(Array.isArray(x.courses) ? x.courses : []).map(esc).join('；') || '未配置课件'}</p><p><b>员工电子签字：</b>${date(x.employee_signed_at)}</p></section>`).join('')).join('') || '<section><p>尚未配置或完成对应层级培训。</p></section>';
      const signs = r.signatures || {};
      return `<article class="card-page"><h1>三级安全教育记录卡</h1><p class="subtitle">${esc(project ? `${project.project_code} ${project.name}` : `${r.project_code} ${r.project_name}`)}</p><table class="info"><tr><th>姓名</th><td>${esc(r.employee_name)}</td><th>工号</th><td>${esc(r.employee_no || '—')}</td><th>工种/岗位</th><td>${esc(r.work_position || '—')}</td></tr><tr><th>所属部门</th><td>${esc(r.department_name || '—')}</td><th>外协单位</th><td>${esc(r.contractor_name || '内部员工')}</td><th>联系电话</th><td>${esc(r.phone || '—')}</td></tr><tr><th>身份证号</th><td colspan="5">${esc(r.id_number || '—')}</td></tr></table>${blocks}<div class="sign-grid"><p>员工完整记录签字：${date(r.final_signed_at)}</p><p>安全生产部部长：${date(signs.company_safety_head)}</p><p>经营实体负责人：${date(signs.entity_head)}</p><p>项目负责人/安全员：${date(signs.project_manager || signs.safety_officer)}</p><p>现场确认：${date(r.site_confirmed_at)}</p><p>当前状态：${esc(this.statusText(r.admission_status))}</p></div><p class="note">本记录由系统根据实际学习课件、考试、电子签字和现场确认自动生成；原始电子档案永久保留。</p></article>`;
    }).join('');
    const w = window.open('', '_blank'); if (!w) { Utils.toast('浏览器阻止了打印窗口，请允许弹窗后重试', 'error'); return; }
    w.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>三级安全教育记录卡</title><style>@page{size:A4 portrait;margin:12mm}body{font-family:"Microsoft YaHei",sans-serif;color:#111;font-size:11px}.card-page{page-break-after:always}.card-page:last-child{page-break-after:auto}h1{text-align:center;font-size:20px;margin:0 0 5px}.subtitle{text-align:center;margin:0 0 12px}.info{width:100%;border-collapse:collapse}.info th,.info td{border:1px solid #222;padding:6px}.info th{background:#eee;width:13%;white-space:nowrap}section{border:1px solid #222;border-top:0;padding:8px;min-height:68px}section h2{font-size:13px;margin:0 0 7px}section p{margin:4px 0;line-height:1.55}.sign-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid #222;border-top:0}.sign-grid p{margin:0;padding:9px;border-right:1px solid #222;border-bottom:1px solid #222}.sign-grid p:nth-child(even){border-right:0}.sign-grid p:nth-last-child(-n+2){border-bottom:0}.note{font-size:9px;color:#555;margin-top:10px;line-height:1.5}</style></head><body>${pages}</body></html>`);
    w.document.close(); w.focus(); w.print();
  },

  statusText(s) { const map = { eligible: '可上岗', blocked: '禁止上岗', project_closed: '项目已关闭', expired: '已过期', pending: '待完成', learning: '学习中', exam_pending: '待考试', pending_sign: '待签字', pending_site_confirm: '待现场确认' }; return map[s] || s || '待处理'; },
};

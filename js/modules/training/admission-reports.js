// =============================================================
// js/modules/training/admission-reports.js —— 准入固定报表
// =============================================================
const TrainingAdmissionReports = {
  state: { projects: [], report: 'ledger', rows: [] },
  labels: { ledger: '三级教育台账', signatures: '培训签到表', exam: '考试成绩单', annual: '年度培训统计' },

  async render(box) {
    box.innerHTML = `<div class="toolbar"><div class="toolbar-left"><label>报表：</label><select id="admission-report-type" onchange="TrainingAdmissionReports.changeType()">${Object.entries(this.labels).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><label>项目：</label><select id="admission-report-project" onchange="TrainingAdmissionReports.loadReport()"><option value="">全部项目</option></select></div><div class="toolbar-right"><button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionReports.loadReport()">刷新</button><button class="btn btn-primary btn-sm" onclick="TrainingAdmissionReports.exportCsv()">导出 CSV</button></div></div><div id="admission-report-body"></div>`;
    const { data, error } = await sb.from('site_projects').select('id, project_code, name').order('created_at', { ascending: false });
    if (error) throw error;
    this.state.projects = data || [];
    const sel = document.getElementById('admission-report-project');
    if (sel) sel.innerHTML += this.state.projects.map(p => `<option value="${p.id}">${Utils.escapeHtml(p.project_code)} · ${Utils.escapeHtml(p.name)}</option>`).join('');
    await this.loadReport();
  },

  changeType() { this.loadReport(); },

  async loadReport() {
    const type = (document.getElementById('admission-report-type') || {}).value || 'ledger';
    const projectId = (document.getElementById('admission-report-project') || {}).value || null;
    const rpc = type === 'signatures' ? 'training_admission_signature_report' : 'training_admission_report';
    const result = await sb.rpc(rpc, { p_project_id: projectId });
    if (result.error) { const body = document.getElementById('admission-report-body'); if (body) body.innerHTML = `<div class="alert alert-danger">${Utils.escapeHtml(result.error.message)}</div>`; return; }
    this.state.report = type; this.state.rows = result.data || [];
    this.renderReport();
  },

  renderReport() {
    const box = document.getElementById('admission-report-body'); if (!box) return;
    const type = this.state.report;
    if (type === 'annual') { this.renderAnnual(box); return; }
    if (type === 'signatures') {
      box.innerHTML = `<div class="card"><div class="card-header"><h2>培训签到表（${this.state.rows.length}）</h2></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr><th>项目</th><th>人员</th><th>培训层级</th><th>签署角色</th><th>签署时间</th><th>记录哈希</th></tr></thead><tbody>${this.state.rows.length ? this.state.rows.map(r => `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td>${Utils.escapeHtml(r.employee_name)}</td><td>${Utils.escapeHtml(r.level_name)}</td><td>${Utils.escapeHtml(r.signer_role)}</td><td>${Utils.escapeHtml((r.signed_at || '').slice(0, 16).replace('T', ' '))}</td><td>${Utils.escapeHtml(r.record_hash || '')}</td></tr>`).join('') : TrainingModule.emptyRow(6, '暂无电子签到记录')}</tbody></table></div></div>`;
      return;
    }
    const rows = this.state.rows;
    box.innerHTML = `<div class="card"><div class="card-header"><h2>${type === 'exam' ? '考试成绩单' : '三级教育台账'}（${rows.length}）</h2></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:1050px"><thead><tr><th>项目</th><th>人员 / 工种</th><th>外协单位</th><th>公司级</th><th>经营实体级</th><th>项目级</th><th>专项</th><th>考试成绩</th><th>上岗状态</th><th>凭证有效至</th></tr></thead><tbody>${rows.length ? rows.map(r => `<tr><td>${Utils.escapeHtml(r.project_code)} · ${Utils.escapeHtml(r.project_name)}</td><td>${Utils.escapeHtml(r.employee_name)}<br><span class="text-muted">${Utils.escapeHtml(r.work_position || '')}</span></td><td>${Utils.escapeHtml(r.contractor_name || '内部员工')}</td><td>${r.company_done || 0}</td><td>${r.entity_done || 0}</td><td>${r.project_done || 0}</td><td>${r.special_done || 0}</td><td>${r.exam_score == null ? '—' : r.exam_score}</td><td>${this.status(r.admission_status)}</td><td>${Utils.escapeHtml(r.valid_until || '—')}</td></tr>`).join('') : TrainingModule.emptyRow(10, '暂无准入记录')}</tbody></table></div></div>`;
  },

  status(s) { const map = { eligible: ['可上岗', 'badge-success'], blocked: ['禁止上岗', 'badge-danger'], project_closed: ['项目已关闭', 'badge-muted'], expired: ['已过期', 'badge-danger'], pending: ['待完成', 'badge-warning'], learning: ['学习中', 'badge-info'], exam_pending: ['待考试', 'badge-warning'], pending_sign: ['待签字', 'badge-warning'], pending_site_confirm: ['待现场确认', 'badge-warning'] }; const x = map[s] || [s || '待处理', 'badge-muted']; return `<span class="badge ${x[1]}">${x[0]}</span>`; },

  renderAnnual(box) {
    const rows = this.state.rows;
    const total = rows.length, eligible = rows.filter(r => r.admission_status === 'eligible').length, passed = rows.filter(r => r.exam_score != null && Number(r.exam_score) >= 80).length;
    box.innerHTML = `<div class="stats-grid">${this.card('准入记录', total, 'total')}${this.card('当前可上岗', eligible, 'success')}${this.card('考试有成绩', passed, 'info')}${this.card('禁止/失效', total - eligible, total - eligible ? 'warning' : 'success')}</div><div class="card"><div class="card-header"><h2>年度培训统计口径</h2></div><div class="card-body"><p>统计范围：当前账号可查看的项目准入记录。正式年度报表将继续补充公司级、经营实体级和项目级课件学时、签到人数、考试通过率。</p></div></div>`;
  },

  card(label, value, cls) { return `<div class="stat-card ${cls}"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`; },

  exportCsv() {
    if (!this.state.rows.length) { Utils.toast('暂无数据可导出', 'info'); return; }
    const type = this.state.report;
    const columns = type === 'signatures'
      ? [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'employee_name', label: '人员' }, { key: 'level_name', label: '培训层级' }, { key: 'signer_role', label: '签署角色' }, { key: 'signed_at', label: '签署时间' }, { key: 'record_hash', label: '记录哈希' }]
      : [{ key: 'project_code', label: '项目编号' }, { key: 'project_name', label: '项目名称' }, { key: 'employee_name', label: '人员' }, { key: 'phone', label: '手机号' }, { key: 'work_position', label: '工种' }, { key: 'contractor_name', label: '外协单位' }, { key: 'company_done', label: '公司级完成数' }, { key: 'entity_done', label: '经营实体级完成数' }, { key: 'project_done', label: '项目级完成数' }, { key: 'special_done', label: '专项完成数' }, { key: 'exam_score', label: '考试成绩' }, { key: 'admission_status', label: '状态' }, { key: 'valid_until', label: '凭证有效至' }];
    Utils.exportCSV(this.state.rows, `培训准入${this.labels[type] || '报表'}_${Utils.formatDate(new Date())}.csv`, columns);
  },
};

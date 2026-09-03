// =============================================================
// js/modules/training/contractors.js —— 外协单位与入场资料台账
// v1 先支持后台人工建档/审核；自助扫码申请将在小程序登录接入后复用同一张表。
// =============================================================
const TrainingContractors = {

  state: { companies: [], contracts: [], documents: [], members: [], employees: [], projects: [] },
  DOC_LABEL: { qualification: '单位资质', special_certificate: '特种作业证', other: '其他资料' },
  CERT_TYPES: ['爆破', '钻探', '电工', '焊工'],

  async render(box) {
    box.innerHTML = `
      <div class="toolbar"><div class="toolbar-left"><span class="toolbar-hint">外协资料人工审核台账</span></div>
        <div class="toolbar-right">
          <button class="btn btn-secondary btn-sm" onclick="TrainingContractors.load()">刷新</button>
          ${TrainingModule.canEdit() ? `<button class="btn btn-secondary btn-sm" onclick="TrainingContractors.downloadMemberTemplate()">导入模板</button><button class="btn btn-secondary btn-sm" onclick="TrainingContractors.openMemberImport()">批量导入人员</button><button class="btn btn-secondary btn-sm" onclick="TrainingContractors.openDocumentForm()">+ 登记资质/证照</button>
            <button class="btn btn-secondary btn-sm" onclick="TrainingContractors.openContractForm()">+ 登记合同</button>
            <button class="btn btn-primary btn-sm" onclick="TrainingContractors.openCompanyForm()">+ 新建外协单位</button>` : ''}
        </div>
      </div>
      <div id="contractor-summary"></div>
      <div id="contractor-companies"></div>
      <div id="contractor-contracts" style="margin-top:16px"></div>
      <div id="contractor-members" style="margin-top:16px"></div>
      <div id="contractor-documents" style="margin-top:16px"></div>`;
    await this.load();
  },

  async load() {
    const [companies, contracts, documents, members, employees, projects] = await Promise.all([
      sb.from('contractor_companies').select('id, name, unified_code, legal_representative, contact_name, contact_phone, status, review_note, created_at').order('name'),
      sb.from('contractor_contracts').select('id, project_id, contractor_id, contract_no, contract_name, start_date, end_date, status, storage_path, review_note').order('created_at', { ascending: false }),
      sb.from('contractor_documents').select('id, contractor_id, employee_id, project_id, document_type, certificate_type, certificate_no, valid_from, valid_until, storage_path, review_status, review_note, created_at').order('created_at', { ascending: false }),
      sb.from('site_project_members').select('id, project_id, employee_id, contractor_id, membership_type, status, joined_at').order('joined_at', { ascending: false }),
      sb.from('training_employees').select('id, name, phone, position, department_id').order('name'),
      sb.from('site_projects').select('id, project_code, name, lead_entity_id, status').order('created_at', { ascending: false }),
    ]);
    const error = [companies, contracts, documents, members, employees, projects].find(r => r.error);
    if (error) throw error.error;
    this.state.companies = companies.data || [];
    this.state.contracts = contracts.data || [];
    this.state.documents = documents.data || [];
    this.state.members = members.data || [];
    this.state.employees = employees.data || [];
    this.state.projects = projects.data || [];
    this.renderContent();
  },

  renderContent() {
    const by = (rows, key) => rows.reduce((m, r) => { m[r[key]] = (m[r[key]] || 0) + 1; return m; }, {});
    const pendingDocs = this.state.documents.filter(d => d.review_status === 'pending').length;
    const activeMembers = this.state.members.filter(m => m.status === 'active' && m.membership_type !== 'internal').length;
    const summary = document.getElementById('contractor-summary');
    if (summary) summary.innerHTML = `<div class="stats-grid" style="margin-bottom:12px">
      ${this.stat('外协单位', this.state.companies.length, 'total')}
      ${this.stat('有效合同', this.state.contracts.filter(c => c.status === 'valid').length, 'success')}
      ${this.stat('在场外协人员', activeMembers, 'info')}
      ${this.stat('待审核资料', pendingDocs, pendingDocs ? 'warning' : 'success')}
    </div>`;
    this.renderCompanies(); this.renderContracts(); this.renderMembers(); this.renderDocuments();
  },

  stat(label, value, cls) { return `<div class="stat-card ${cls}"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`; },
  company(id) { return this.state.companies.find(x => x.id === id) || {}; },
  project(id) { return this.state.projects.find(x => x.id === id) || {}; },
  employee(id) { return this.state.employees.find(x => x.id === id) || {}; },
  companyName(id) { return this.company(id).name || '—'; },
  projectName(id) { const p = this.project(id); return p.project_code ? `${p.project_code} · ${p.name}` : '—'; },
  status(label, cls = 'badge-muted') { return `<span class="badge ${cls}">${Utils.escapeHtml(label)}</span>`; },

  renderCompanies() {
    const box = document.getElementById('contractor-companies'); if (!box) return;
    const canEdit = TrainingModule.canEdit();
    box.innerHTML = `<div class="card"><div class="card-header"><h2>外协单位台账（${this.state.companies.length}）</h2></div>
      <div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr>
      <th>单位名称</th><th>统一社会信用代码</th><th>负责人 / 联系电话</th><th>状态</th><th>登记时间</th><th>操作</th></tr></thead><tbody>
      ${this.state.companies.length ? this.state.companies.map(c => `<tr><td><b>${Utils.escapeHtml(c.name)}</b></td>
        <td>${Utils.escapeHtml(c.unified_code || '—')}</td><td>${Utils.escapeHtml(c.contact_name || c.legal_representative || '—')}<br>${Utils.escapeHtml(c.contact_phone || '—')}</td>
        <td>${this.companyStatus(c.status)}</td><td>${Utils.escapeHtml((c.created_at || '').slice(0, 10))}</td>
        <td>${canEdit ? `<button class="btn btn-sm btn-secondary" onclick="TrainingContractors.openCompanyForm('${c.id}')">编辑</button>
          ${c.status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="TrainingContractors.reviewCompany('${c.id}','active')">通过</button><button class="btn btn-sm btn-danger" onclick="TrainingContractors.reviewCompany('${c.id}','rejected')">驳回</button>` : ''}` : ''}</td></tr>`).join('')
        : TrainingModule.emptyRow(6, '暂无外协单位')}</tbody></table></div></div>`;
  },

  companyStatus(s) {
    const map = { pending: ['待审核', 'badge-warning'], active: ['有效', 'badge-success'], rejected: ['驳回', 'badge-danger'], inactive: ['停用', 'badge-muted'] };
    const v = map[s] || [s || '未知', 'badge-muted']; return this.status(v[0], v[1]);
  },

  renderContracts() {
    const box = document.getElementById('contractor-contracts'); if (!box) return;
    const canEdit = TrainingModule.canEdit();
    box.innerHTML = `<div class="card"><div class="card-header"><h2>项目合同台账（${this.state.contracts.length}）</h2></div>
      <div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr>
      <th>项目</th><th>外协单位</th><th>合同编号 / 名称</th><th>有效期</th><th>状态</th><th>附件路径</th><th>操作</th></tr></thead><tbody>
      ${this.state.contracts.length ? this.state.contracts.map(c => `<tr><td>${Utils.escapeHtml(this.projectName(c.project_id))}</td><td>${Utils.escapeHtml(this.companyName(c.contractor_id))}</td>
        <td>${Utils.escapeHtml(c.contract_no || '—')}<br>${Utils.escapeHtml(c.contract_name || '—')}</td><td>${Utils.escapeHtml([c.start_date, c.end_date].filter(Boolean).join(' ~ ') || '—')}</td>
        <td>${this.contractStatus(c.status)}</td><td>${Utils.escapeHtml(c.storage_path || '—')}</td><td>${canEdit && c.status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="TrainingContractors.reviewContract('${c.id}','valid')">通过</button><button class="btn btn-sm btn-danger" onclick="TrainingContractors.reviewContract('${c.id}','terminated')">驳回</button>` : ''}</td></tr>`).join('')
        : TrainingModule.emptyRow(7, '暂无合同记录')}</tbody></table></div></div>`;
  },

  contractStatus(s) {
    const map = { pending: ['待审核', 'badge-warning'], valid: ['有效', 'badge-success'], expired: ['已过期', 'badge-danger'], terminated: ['已终止', 'badge-muted'] };
    const v = map[s] || [s || '未知', 'badge-muted']; return this.status(v[0], v[1]);
  },

  renderMembers() {
    const box = document.getElementById('contractor-members'); if (!box) return;
    box.innerHTML = `<div class="card"><div class="card-header"><h2>项目外协人员台账（${this.state.members.filter(m => m.membership_type !== 'internal').length}）</h2>
      ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingContractors.openMemberForm()">+ 建立人员并加入项目</button>' : ''}</div>
      <div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr>
      <th>姓名</th><th>手机号</th><th>工种</th><th>项目</th><th>外协单位</th><th>状态</th><th>入场时间</th></tr></thead><tbody>
      ${this.state.members.filter(m => m.membership_type !== 'internal').length ? this.state.members.filter(m => m.membership_type !== 'internal').map(m => { const e = this.employee(m.employee_id); return `<tr>
        <td>${Utils.escapeHtml(e.name || '—')}</td><td>${Utils.escapeHtml(e.phone || '—')}</td><td>${Utils.escapeHtml(e.position || '—')}</td>
        <td>${Utils.escapeHtml(this.projectName(m.project_id))}</td><td>${Utils.escapeHtml(this.companyName(m.contractor_id))}</td>
        <td>${m.status === 'active' ? this.status('在场', 'badge-success') : this.status(m.status === 'left' ? '已离场' : '已撤销')}</td><td>${Utils.escapeHtml((m.joined_at || '').slice(0, 10))}</td></tr>`; }).join('')
        : TrainingModule.emptyRow(7, '暂无项目外协人员')}</tbody></table></div></div>`;
  },

  renderDocuments() {
    const box = document.getElementById('contractor-documents'); if (!box) return;
    const canEdit = TrainingModule.canEdit();
    box.innerHTML = `<div class="card"><div class="card-header"><h2>资质与特种作业证（${this.state.documents.length}）</h2></div>
      <div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:980px"><thead><tr>
      <th>资料类型</th><th>单位 / 人员</th><th>项目</th><th>证书编号</th><th>有效期</th><th>审核</th><th>附件</th><th>操作</th></tr></thead><tbody>
      ${this.state.documents.length ? this.state.documents.map(d => { const e = this.employee(d.employee_id); return `<tr>
        <td>${Utils.escapeHtml(this.DOC_LABEL[d.document_type] || d.document_type)}${d.certificate_type ? `<br><span class="text-muted">${Utils.escapeHtml(d.certificate_type)}</span>` : ''}</td>
        <td>${Utils.escapeHtml(this.companyName(d.contractor_id))}${e.name ? `<br>${Utils.escapeHtml(e.name)}` : ''}</td><td>${Utils.escapeHtml(this.projectName(d.project_id))}</td>
        <td>${Utils.escapeHtml(d.certificate_no || '—')}</td><td>${Utils.escapeHtml([d.valid_from, d.valid_until].filter(Boolean).join(' ~ ') || '长期/未填')}</td>
        <td>${d.review_status === 'approved' ? this.status('已通过', 'badge-success') : d.review_status === 'rejected' ? this.status('已驳回', 'badge-danger') : this.status('待审核', 'badge-warning')}</td>
        <td>${Utils.escapeHtml(d.storage_path || '—')}</td><td>${canEdit && d.review_status === 'pending' ? `<button class="btn btn-sm btn-primary" onclick="TrainingContractors.reviewDocument('${d.id}','approved')">通过</button>
          <button class="btn btn-sm btn-danger" onclick="TrainingContractors.reviewDocument('${d.id}','rejected')">驳回</button>` : ''}</td></tr>`; }).join('')
        : TrainingModule.emptyRow(8, '暂无资质或证照')}</tbody></table></div></div>`;
  },

  host() { return document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })(); },
  close() { const h = document.getElementById('training-modal-host'); if (h) h.innerHTML = ''; },
  projectOptions(selected = '') { return this.state.projects.filter(p => p.status !== 'closed').map(p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${Utils.escapeHtml(this.projectName(p.id))}</option>`).join(''); },
  companyOptions(selected = '') { return this.state.companies.filter(c => ['pending', 'active'].includes(c.status)).map(c => `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${Utils.escapeHtml(c.name)}</option>`).join(''); },
  employeeOptions() { return this.state.employees.filter(e => e.status !== 'left').map(e => `<option value="${e.id}">${Utils.escapeHtml(e.name)} · ${Utils.escapeHtml(e.position || '未填工种')}</option>`).join(''); },
  modal(title, body, submit) { this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingContractors.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:650px"><div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="TrainingContractors.close()">×</button></div><div class="modal-body">${body}</div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingContractors.close()">取消</button><button class="btn btn-primary" onclick="${submit}">保存</button></div></div></div>`; },

  openCompanyForm(id) {
    const c = id ? this.company(id) : {};
    this.modal(id ? '编辑外协单位' : '新建外协单位', `<div class="form-group"><label>单位名称 <span class="required">*</span></label><input id="co-name" class="form-control" value="${Utils.escapeHtml(c.name || '')}"></div>
      <div class="form-group"><label>统一社会信用代码</label><input id="co-code" class="form-control" value="${Utils.escapeHtml(c.unified_code || '')}"></div>
      <div class="form-row"><div class="form-group"><label>法定代表人</label><input id="co-legal" class="form-control" value="${Utils.escapeHtml(c.legal_representative || '')}"></div><div class="form-group"><label>负责人</label><input id="co-contact" class="form-control" value="${Utils.escapeHtml(c.contact_name || '')}"></div></div>
      <div class="form-group"><label>联系电话</label><input id="co-phone" class="form-control" value="${Utils.escapeHtml(c.contact_phone || '')}"></div>`, `TrainingContractors.submitCompany('${id || ''}')`);
  },

  async submitCompany(id) {
    const val = id => (document.getElementById(id) || {}).value || '';
    const payload = { name: val('co-name').trim(), unified_code: val('co-code').trim() || null, legal_representative: val('co-legal').trim() || null, contact_name: val('co-contact').trim() || null, contact_phone: val('co-phone').trim() || null, updated_at: new Date().toISOString() };
    if (!payload.name) { Utils.toast('请填写单位名称', 'error'); return; }
    const result = id ? await sb.from('contractor_companies').update(payload).eq('id', id) : await sb.from('contractor_companies').insert({ ...payload, created_by: (Auth.currentUser || {}).id });
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    this.close(); Utils.toast(id ? '外协单位已更新' : '外协单位已建立', 'success'); await this.load();
  },

  openContractForm() {
    this.modal('登记项目合同', `<div class="form-group"><label>项目 <span class="required">*</span></label><select id="ct-project" class="form-control">${this.projectOptions()}</select></div>
      <div class="form-group"><label>外协单位 <span class="required">*</span></label><select id="ct-company" class="form-control">${this.companyOptions()}</select></div>
      <div class="form-row"><div class="form-group"><label>合同编号</label><input id="ct-no" class="form-control"></div><div class="form-group"><label>合同名称</label><input id="ct-name" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>开始日期</label><input id="ct-start" type="date" class="form-control"></div><div class="form-group"><label>结束日期</label><input id="ct-end" type="date" class="form-control"></div></div>
      <div class="form-group"><label>合同附件</label><input id="ct-file" type="file" class="form-control" accept=".pdf,image/png,image/jpeg,image/webp"><p class="text-muted" style="font-size:12px;margin:4px 0 0">支持 PDF、PNG、JPG、WEBP，单个文件不超过 10MB；也可以填写已有 Storage 路径。</p></div>
      <div class="form-group"><label>已有 Storage 路径</label><input id="ct-path" class="form-control" placeholder="contractor-documents/..."></div>`, 'TrainingContractors.submitContract()');
  },

  async submitContract() {
    const v = id => (document.getElementById(id) || {}).value || '';
    const file = (document.getElementById('ct-file') || {}).files?.[0] || null;
    const payload = { project_id: v('ct-project'), contractor_id: v('ct-company'), contract_no: v('ct-no').trim() || null, contract_name: v('ct-name').trim() || null, start_date: v('ct-start') || null, end_date: v('ct-end') || null, storage_path: v('ct-path').trim() || null };
    if (!payload.project_id || !payload.contractor_id) { Utils.toast('项目和外协单位不能为空', 'error'); return; }
    if (payload.start_date && payload.end_date && payload.end_date < payload.start_date) { Utils.toast('合同结束日期不能早于开始日期', 'error'); return; }
    payload.storage_path = await this.uploadAttachment(file, 'contractor-contracts', payload.project_id);
    if (!payload.storage_path) { Utils.toast('请上传合同附件或填写已有 Storage 路径', 'error'); return; }
    const result = await sb.from('contractor_contracts').insert(payload);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    this.close(); Utils.toast('合同已登记', 'success'); await this.load();
  },

  openMemberForm() {
    this.modal('建立外协人员档案并加入项目', `<p class="hint">第一版后台可代为建档；外协人员通过邀请码自助申请的流程将在小程序登录接入后启用。</p>
      <div class="form-row"><div class="form-group"><label>姓名 <span class="required">*</span></label><input id="me-name" class="form-control"></div><div class="form-group"><label>手机号 <span class="required">*</span></label><input id="me-phone" class="form-control"></div></div>
      <div class="form-row"><div class="form-group"><label>工种</label><input id="me-position" class="form-control" placeholder="如：钻探工 / 电工"></div><div class="form-group"><label>项目 <span class="required">*</span></label><select id="me-project" class="form-control">${this.projectOptions()}</select></div></div>
      <div class="form-group"><label>外协单位 <span class="required">*</span></label><select id="me-company" class="form-control">${this.companyOptions()}</select></div>`, 'TrainingContractors.submitMember()');
  },

  async submitMember() {
    const v = id => (document.getElementById(id) || {}).value || '';
    const project = this.project(v('me-project'));
    const name = v('me-name').trim(), phone = v('me-phone').trim();
    if (!name || !phone || !project.id || !v('me-company')) { Utils.toast('姓名、手机号、项目和外协单位不能为空', 'error'); return; }
    const emp = await sb.from('training_employees').insert({ name, phone, position: v('me-position').trim() || null, department_id: project.lead_entity_id, emp_type: 'employee', status: 'active', remark: '外协人员', created_by: (Auth.currentUser || {}).id }).select('id').single();
    if (emp.error) { Utils.toast(emp.error.message, 'error'); return; }
    const member = await sb.from('site_project_members').insert({ project_id: project.id, employee_id: emp.data.id, contractor_id: v('me-company'), membership_type: 'external', created_by: (Auth.currentUser || {}).id });
    if (member.error) { Utils.toast(member.error.message, 'error'); return; }
    this.close(); Utils.toast('外协人员已建档并加入项目', 'success'); await this.load();
  },

  MEMBER_IMPORT_HEADERS: ['姓名*', '手机号*', '工种/岗位*'],
  downloadMemberTemplate() {
    if (typeof XLSX === 'undefined') { Utils.toast('Excel 组件未加载，请刷新页面后重试', 'error'); return; }
    const data = [this.MEMBER_IMPORT_HEADERS, ['张三', '13800138000', '钻探工']];
    const sheet = XLSX.utils.aoa_to_sheet(data); sheet['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 18 }];
    const help = XLSX.utils.aoa_to_sheet([['填写说明'], ['1. 姓名、手机号、工种/岗位均为必填项。'], ['2. 项目和外协单位在导入页面选择，不要写在表格内。'], ['3. 本模板不收集身份证号、合同、资质和证照附件；这些资料仍在外协台账中人工登记和审核。'], ['4. 同一手机号只能对应同一姓名；与其他外协单位存在有效归属冲突时，该行会导入失败。']]); help['!cols'] = [{ wch: 72 }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '外协人员导入'); XLSX.utils.book_append_sheet(book, help, '填写说明');
    XLSX.writeFile(book, `项目外协人员导入模板_${Utils.formatDate(new Date())}.xlsx`);
  },
  openMemberImport() {
    this.state.memberImportRows = null; this.state.memberImportResult = null;
    this.state.memberImportProject = this.state.projects.find(p => p.status === 'active')?.id || '';
    this.state.memberImportCompany = this.state.companies.find(c => c.status !== 'inactive')?.id || '';
    this.renderMemberImport();
  },
  renderMemberImport() {
    const rows = this.state.memberImportRows || []; const result = this.state.memberImportResult;
    const valid = rows.filter(r => !r.errors.length); const invalid = rows.filter(r => r.errors.length);
    const preview = result ? `<p>导入完成：新建 <b>${result.filter(r => r.result_code === 'created').length}</b> 人，复用档案 <b>${result.filter(r => r.result_code === 'reused').length}</b> 人，失败 <b style="color:#b91c1c">${result.filter(r => r.result_code === 'failed').length}</b> 人。</p><div style="max-height:260px;overflow:auto"><table class="data-table"><thead><tr><th>行号</th><th>结果</th><th>说明</th></tr></thead><tbody>${result.map(r => `<tr><td>${r.row_no}</td><td>${Utils.escapeHtml(r.result_code)}</td><td>${Utils.escapeHtml(r.result_message)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="hint">表格仅导入人员基本信息。导入成功后会自动加入项目，但不会自动下发培训；请在“准入执行”页批量下发。</p><div class="form-row"><div class="form-group"><label>项目 <span class="required">*</span></label><select id="contractor-import-project" class="form-control">${this.projectOptions(this.state.memberImportProject)}</select></div><div class="form-group"><label>外协单位 <span class="required">*</span></label><select id="contractor-import-company" class="form-control">${this.companyOptions(this.state.memberImportCompany)}</select></div></div><div class="form-group"><label>Excel 文件</label><input id="contractor-import-file" type="file" accept=".xlsx,.xls" class="form-control"></div>${rows.length ? `<p>可导入 <b>${valid.length}</b> 行；需修正 <b style="color:#b91c1c">${invalid.length}</b> 行。</p><div style="max-height:220px;overflow:auto"><table class="data-table"><thead><tr><th>行号</th><th>姓名</th><th>手机号</th><th>工种</th><th>检查结果</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.rowNo}</td><td>${Utils.escapeHtml(r.name)}</td><td>${Utils.escapeHtml(r.phone)}</td><td>${Utils.escapeHtml(r.position)}</td><td>${r.errors.length ? `<span style="color:#b91c1c">${Utils.escapeHtml(r.errors.join('；'))}</span>` : '<span style="color:#15803d">可导入</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingContractors.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:760px"><div class="modal-header"><h3>批量导入项目外协人员</h3><button class="modal-close" onclick="TrainingContractors.close()">×</button></div><div class="modal-body">${preview}</div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingContractors.close()">${result ? '关闭' : '取消'}</button>${result ? '' : `<button class="btn btn-secondary" onclick="TrainingContractors.parseMemberImport()">解析文件</button>${rows.length && valid.length ? '<button class="btn btn-primary" onclick="TrainingContractors.submitMemberImport()">确认导入</button>' : ''}`}</div></div></div>`;
  },
  async parseMemberImport() {
    const project = document.getElementById('contractor-import-project')?.value || ''; const company = document.getElementById('contractor-import-company')?.value || '';
    const file = document.getElementById('contractor-import-file')?.files?.[0];
    if (!project || !company || !file) { Utils.toast('请选择项目、外协单位和 Excel 文件', 'error'); return; }
    if (typeof XLSX === 'undefined') { Utils.toast('Excel 组件未加载，请刷新页面后重试', 'error'); return; }
    if (!/\.(xlsx|xls)$/i.test(file.name)) { Utils.toast('请选择 .xlsx 或 .xls 文件', 'error'); return; }
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array' }); const sheet = book.Sheets[book.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
    if (raw.length < 2) { Utils.toast('表格中没有人员数据', 'error'); return; }
    const phones = new Set(); const rows = [];
    raw.slice(1).forEach((line, index) => {
      const name = String(line[0] || '').trim(), phone = String(line[1] || '').trim(), position = String(line[2] || '').trim();
      if (!name && !phone && !position) return;
      const errors = []; if (!name || !phone || !position) errors.push('姓名、手机号和工种均必填');
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) errors.push('手机号格式不正确');
      if (phone && phones.has(phone)) errors.push('本表手机号重复'); if (phone) phones.add(phone);
      rows.push({ rowNo: index + 2, name, phone, position, errors });
    });
    if (rows.length > 300) { Utils.toast('单次最多导入 300 人，请分批处理', 'error'); return; }
    this.state.memberImportProject = project; this.state.memberImportCompany = company; this.state.memberImportRows = rows; this.renderMemberImport();
  },
  async submitMemberImport() {
    const rows = (this.state.memberImportRows || []).filter(r => !r.errors.length); if (!rows.length) { Utils.toast('没有可导入的人员', 'error'); return; }
    if (!confirm(`确认将 ${rows.length} 名外协人员加入项目？`)) return;
    const { data, error } = await sb.rpc('training_batch_add_contractor_members', { p_project_id: this.state.memberImportProject, p_contractor_id: this.state.memberImportCompany, p_people: rows.map(r => ({ name: r.name, phone: r.phone, position: r.position })) });
    if (error) { Utils.toast(error.message, 'error'); return; }
    this.state.memberImportResult = data || []; this.renderMemberImport(); await this.load();
  },

  openDocumentForm() {
    this.modal('登记资质或特种作业证', `<div class="form-row"><div class="form-group"><label>项目 <span class="required">*</span></label><select id="dc-project" class="form-control">${this.projectOptions()}</select></div><div class="form-group"><label>外协单位</label><select id="dc-company" class="form-control"><option value="">不指定单位</option>${this.companyOptions()}</select></div></div>
      <div class="form-group"><label>关联人员（特种作业证必填）</label><select id="dc-employee" class="form-control"><option value="">不指定人员</option>${this.employeeOptions()}</select></div>
      <div class="form-row"><div class="form-group"><label>资料类型</label><select id="dc-type" class="form-control">${Object.entries(this.DOC_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div><div class="form-group"><label>证书类型</label><select id="dc-cert" class="form-control"><option value="">—</option>${this.CERT_TYPES.map(x => `<option>${x}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-group"><label>证书编号</label><input id="dc-no" class="form-control"></div><div class="form-group"><label>有效至</label><input id="dc-until" type="date" class="form-control"></div></div>
      <div class="form-group"><label>上传附件</label><input id="dc-file" type="file" class="form-control" accept=".pdf,image/png,image/jpeg,image/webp"><p class="text-muted" style="font-size:12px;margin:4px 0 0">支持 PDF、PNG、JPG、WEBP，单个文件不超过 10MB；也可以填写已有 Storage 路径。</p></div>
      <div class="form-group"><label>已有 Storage 路径</label><input id="dc-path" class="form-control" placeholder="contractor-documents/..."></div>`, 'TrainingContractors.submitDocument()');
  },

  async submitDocument() {
    const v = id => (document.getElementById(id) || {}).value || '';
    const file = (document.getElementById('dc-file') || {}).files?.[0] || null;
    const payload = { project_id: v('dc-project'), contractor_id: v('dc-company') || null, employee_id: v('dc-employee') || null, document_type: v('dc-type'), certificate_type: v('dc-cert') || null, certificate_no: v('dc-no').trim() || null, valid_until: v('dc-until') || null, storage_path: v('dc-path').trim() };
    if (!payload.project_id) { Utils.toast('项目不能为空', 'error'); return; }
    if (payload.document_type === 'special_certificate' && (!payload.employee_id || !payload.certificate_type || !payload.valid_until)) { Utils.toast('特种作业证必须关联人员、证书类型和有效期', 'error'); return; }
    payload.storage_path = await this.uploadAttachment(file, 'contractor-documents', payload.project_id);
    if (!payload.storage_path) { Utils.toast('请上传附件或填写已有 Storage 路径', 'error'); return; }
    const result = await sb.from('contractor_documents').insert(payload);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    this.close(); Utils.toast('资料已登记，等待人工审核', 'success'); await this.load();
  },

  async uploadAttachment(file, folder, projectId) {
    const existing = (document.getElementById(folder === 'contractor-contracts' ? 'ct-path' : 'dc-path') || {}).value || '';
    if (!file) return existing.trim();
    const maxSize = typeof CERT_FILE_MAX_SIZE === 'number' ? CERT_FILE_MAX_SIZE : 10 * 1024 * 1024;
    const allowed = Array.isArray(CERT_FILE_TYPES) ? CERT_FILE_TYPES : ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (file.size > maxSize) { Utils.toast('附件不能超过 10MB', 'error'); return ''; }
    if (file.type && !allowed.includes(file.type)) { Utils.toast('附件类型仅支持 PDF、PNG、JPG 或 WEBP', 'error'); return ''; }
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const randomId = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2);
    const path = `training-admission/${folder}/${projectId}/${Date.now()}-${randomId}.${ext}`;
    const upload = await sb.storage.from(typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (upload.error) { Utils.toast(`附件上传失败：${upload.error.message}`, 'error'); return ''; }
    return path;
  },

  async reviewDocument(id, status) {
    const note = status === 'rejected' ? prompt('请填写驳回原因') : '';
    if (status === 'rejected' && !note) return;
    const result = await sb.from('contractor_documents').update({ review_status: status, reviewed_by: (Auth.currentUser || {}).id, reviewed_at: new Date().toISOString(), review_note: note || null }).eq('id', id);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    const doc = this.state.documents.find(x => x.id === id);
    if (doc?.project_id) await sb.rpc('training_refresh_external_admissions', { p_project_id: doc.project_id, p_contractor_id: doc.contractor_id || null });
    Utils.toast(status === 'approved' ? '资料已审核通过' : '资料已驳回', 'success'); await this.load();
  },

  async reviewCompany(id, status) {
    const note = status === 'rejected' ? prompt('请填写驳回原因') : '';
    if (status === 'rejected' && !note) return;
    const result = await sb.from('contractor_companies').update({ status, reviewed_by: (Auth.currentUser || {}).id, reviewed_at: new Date().toISOString(), review_note: note || null }).eq('id', id);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    await sb.rpc('training_refresh_external_admissions', { p_project_id: null, p_contractor_id: id });
    Utils.toast(status === 'active' ? '外协单位已审核通过' : '外协单位已驳回', 'success'); await this.load();
  },

  async reviewContract(id, status) {
    const note = status === 'terminated' ? prompt('请填写合同驳回/终止原因') : '';
    if (status === 'terminated' && !note) return;
    const result = await sb.from('contractor_contracts').update({ status, reviewed_by: (Auth.currentUser || {}).id, reviewed_at: new Date().toISOString(), review_note: note || null }).eq('id', id);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    const contract = this.state.contracts.find(x => x.id === id);
    if (contract?.project_id) await sb.rpc('training_refresh_external_admissions', { p_project_id: contract.project_id, p_contractor_id: contract.contractor_id || null });
    Utils.toast(status === 'valid' ? '合同已审核通过' : '合同已终止', 'success'); await this.load();
  },
};

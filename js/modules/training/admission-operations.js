// =============================================================
// 准入执行台：项目人员、培训包、现场确认和资格状态。
// 学习、考试和员工签字仍复用现有「我的培训」流程。
// =============================================================
const TrainingAdmissionOperations = {
  state: { projects: [], members: [], employees: [], packages: [], admissions: [], signatures: [], roles: [], accesses: [], filter: '' },
  STATUS: {
    pending: ['待学习', 'badge-warning'], learning: ['学习中', 'badge-info'],
    exam_pending: ['待考试', 'badge-warning'], exam_failed: ['考试未通过', 'badge-danger'],
    pending_sign: ['待签字', 'badge-warning'], pending_site_confirm: ['待现场确认', 'badge-warning'],
    eligible: ['可上岗', 'badge-success'], blocked: ['禁止上岗', 'badge-danger'],
    expired: ['已失效', 'badge-danger'], project_closed: ['项目已关闭', 'badge-muted'],
  },

  async render(box) {
    box.innerHTML = `<div class="toolbar"><div class="toolbar-left"><span class="toolbar-hint">项目准入执行与资格核验</span></div>
      <div class="toolbar-right"><select id="admission-op-project" onchange="TrainingAdmissionOperations.onFilter()"><option value="">全部项目</option></select>
        <button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionOperations.printBlocked()">打印禁止上岗名单</button>
        <button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionOperations.openBatchRemind()">批量催办</button>
        <button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionOperations.load()">刷新</button>
        ${TrainingModule.canManageAdmission() ? '<button class="btn btn-primary btn-sm" onclick="TrainingAdmissionOperations.openStartForm()">+ 发起准入</button>' : ''}</div></div>
      <div id="admission-op-summary"></div><div id="admission-op-table"></div>`;
    await this.load();
  },

  async load() {
    const results = await Promise.all([
      sb.from('site_projects').select('id, project_code, name, status').order('created_at', { ascending: false }),
      sb.from('site_project_members').select('id, project_id, employee_id, contractor_id, membership_type, status, joined_at').order('joined_at', { ascending: false }),
      sb.from('training_employees').select('id, name, phone, position, photo_path').order('name'),
      sb.from('training_admission_packages').select('id, project_id, title, version_no, status, validity_years').eq('status', 'published').order('title'),
      sb.from('training_admissions').select('id, project_id, employee_id, package_id, status, exam_score, exam_attempts, final_signed_at, site_confirmed_at, valid_until, blocked_reason, created_at').order('created_at', { ascending: false }),
      sb.from('training_admission_signatures').select('admission_id, task_id, signer_role, signer_user_id'),
      sb.from('site_project_roles').select('project_id, user_id, role, active').eq('user_id', Auth.currentUser?.id || '').eq('active', true),
      sb.from('training_temporary_access').select('id, admission_id, employee_id, project_id, reason, starts_at, expires_at, revoked_at, pass_code, training_employees(name, position)').order('starts_at', { ascending: false }),
    ]);
    const error = results.find(r => r.error);
    if (error) throw error.error;
    [this.state.projects, this.state.members, this.state.employees, this.state.packages, this.state.admissions, this.state.signatures, this.state.roles, this.state.accesses] = results.map(r => r.data || []);
    this.renderTable();
  },

  onFilter() { this.state.filter = document.getElementById('admission-op-project')?.value || ''; this.renderTable(); },
  project(id) { return this.state.projects.find(x => x.id === id) || {}; },
  employee(id) { return this.state.employees.find(x => x.id === id) || {}; },
  package(id) { return this.state.packages.find(x => x.id === id) || {}; },
  projectName(id) { const p = this.project(id); return p.project_code ? `${p.project_code} · ${p.name}` : '—'; },
  esc(v) { return Utils.escapeHtml(v == null ? '' : String(v)); },
  status(s) { const v = this.STATUS[s] || [s || '未知', 'badge-muted']; return `<span class="badge ${v[1]}">${v[0]}</span>`; },
  myProjectRole(projectId) { const rs = this.state.roles.filter(r => r.project_id === projectId && r.active); return rs.some(r => r.role === 'project_manager') ? 'project_manager' : (rs.some(r => r.role === 'safety_officer') ? 'safety_officer' : ''); },
  hasOwnManagerSign(admissionId, role) { return this.state.signatures.some(s => s.admission_id === admissionId && !s.task_id && s.signer_role === role && s.signer_user_id === Auth.currentUser?.id); },
  activeAccess(admissionId) { return this.state.accesses.find(x => x.admission_id === admissionId && !x.revoked_at && new Date(x.expires_at) > new Date()); },

  renderTable() {
    const filter = document.getElementById('admission-op-project');
    if (filter) filter.innerHTML = `<option value="">全部项目</option>${this.state.projects.map(p => `<option value="${p.id}"${p.id === this.state.filter ? ' selected' : ''}>${this.esc(this.projectName(p.id))}</option>`).join('')}`;
    const rows = this.state.members.filter(m => m.status === 'active' && (!this.state.filter || m.project_id === this.state.filter)).map(m => {
      const e = this.employee(m.employee_id);
      const a = this.state.admissions.find(x => x.project_id === m.project_id && x.employee_id === m.employee_id);
      return { m, e, a };
    });
    const eligible = rows.filter(r => r.a?.status === 'eligible').length;
    const blocked = rows.filter(r => !r.a || ['blocked', 'expired', 'project_closed'].includes(r.a.status)).length;
    const summary = document.getElementById('admission-op-summary');
    if (summary) summary.innerHTML = `<div class="stats-grid" style="margin-bottom:12px"><div class="stat-card total"><div class="stat-value">${rows.length}</div><div class="stat-label">项目在场人员</div></div><div class="stat-card success"><div class="stat-value">${eligible}</div><div class="stat-label">可上岗</div></div><div class="stat-card danger"><div class="stat-value">${blocked}</div><div class="stat-label">禁止上岗/未发起</div></div></div>`;
    const table = document.getElementById('admission-op-table'); if (!table) return;
    const tempRows = this.state.accesses.filter(x => !x.revoked_at && (!this.state.filter || x.project_id === this.state.filter));
    table.innerHTML = `<div class="card"><div class="card-header"><h2>项目准入状态（${rows.length}）</h2><span class="text-muted">资格由学习、考试、签字、现场确认和项目状态共同决定</span></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:980px"><thead><tr><th>人员</th><th>项目</th><th>外协/工种</th><th>培训包</th><th>状态</th><th>考试</th><th>有效至</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map(r => this.row(r)).join('') : TrainingModule.emptyRow(8, '暂无项目在场人员')}</tbody></table></div></div><div class="card" style="margin-top:14px;border-left:4px solid #dc2626"><div class="card-header"><h2>临时通行台账（${tempRows.length}）</h2><span style="color:#b91c1c">仅限短时例外，禁止替代正常准入</span></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr><th>人员</th><th>项目</th><th>原因</th><th>通行编号</th><th>截止时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${tempRows.length ? tempRows.map(x => this.tempRow(x)).join('') : TrainingModule.emptyRow(7, '当前没有未撤销的临时通行')}</tbody></table></div></div>`;
  },

  row({ m, e, a }) {
    const p = this.package(a?.package_id);
    const role = a ? this.myProjectRole(m.project_id) : '';
    const managerSign = a?.final_signed_at && role && !this.hasOwnManagerSign(a.id, role)
      ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionOperations.openManagerSign('${a.id}','${role}')">项目签署</button>` : '';
    const temp = a && this.activeAccess(a.id);
    const actions = !a ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionOperations.openStartForm('${m.project_id}','${m.employee_id}')">发起准入</button>` : `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionOperations.recompute('${a.id}')">刷新资格</button>${['pending_site_confirm', 'blocked'].includes(a.status) ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionOperations.openConfirm('${a.id}')">现场确认</button>` : ''}${a.status !== 'eligible' && !temp ? `<button class="btn btn-sm btn-danger" onclick="TrainingAdmissionOperations.openTemporary('${a.id}')">临时通行</button>` : ''}${managerSign}${a.status === 'eligible' ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionOperations.issue('${a.id}')">签发凭证</button>` : ''}`;
    return `<tr><td><b>${this.esc(e.name)}</b><br><span class="text-muted">${this.esc(e.phone || '—')}</span></td><td>${this.esc(this.projectName(m.project_id))}</td><td>${this.esc(e.position || '—')}<br>${m.membership_type === 'external' ? '<span class="badge badge-warning">外协</span>' : '<span class="badge badge-muted">内部</span>'}</td><td>${a ? `${this.esc(p.title)} v${p.version_no || 1}` : '—'}</td><td>${a ? this.status(a.status) : this.status('blocked')}${temp ? '<br><span class="badge badge-danger">临时通行中</span>' : ''}<br><span class="text-muted">${this.esc(a?.blocked_reason || '')}</span></td><td>${a?.exam_score != null ? `${a.exam_score} 分 / ${a.exam_attempts || 0} 次` : '—'}</td><td>${this.esc(a?.valid_until || '—')}</td><td>${TrainingModule.canManageAdmission() ? actions : '<span class="text-muted">只读</span>'}</td></tr>`;
  },

  tempRow(x) { const expired = new Date(x.expires_at) <= new Date(); const person = x.training_employees || {}; return `<tr style="${expired ? 'color:#9ca3af' : 'background:#fff1f2'}"><td><b>${this.esc(person.name || '—')}</b><br><span class="text-muted">${this.esc(person.position || '')}</span></td><td>${this.esc(this.projectName(x.project_id))}</td><td>${this.esc(x.reason)}</td><td><b>${this.esc(x.pass_code || '—')}</b></td><td>${this.esc((x.expires_at || '').slice(0, 16).replace('T', ' '))}</td><td>${expired ? '<span class="badge badge-muted">已到期</span>' : '<span class="badge badge-danger">临时通行</span>'}</td><td>${!expired ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionOperations.showTemporaryQr('${this.esc(x.pass_code || '')}')">二维码</button> <button class="btn btn-sm btn-danger" onclick="TrainingAdmissionOperations.revokeTemporary('${x.id}')">撤销</button>` : '—'}</td></tr>`; },

  host() { return document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })(); },
  close() { this.host().innerHTML = ''; },
  modal(title, body, submit) { this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingAdmissionOperations.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:620px"><div class="modal-header"><h3>${title}</h3><button class="modal-close" onclick="TrainingAdmissionOperations.close()">×</button></div><div class="modal-body">${body}</div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionOperations.close()">取消</button><button class="btn btn-primary" onclick="${submit}">保存</button></div></div></div>`; },
  projectOptions(selected) { return this.state.projects.filter(p => p.status === 'active').map(p => `<option value="${p.id}"${p.id === selected ? ' selected' : ''}>${this.esc(this.projectName(p.id))}</option>`).join(''); },
  memberOptions(projectId, employeeId) { return this.state.members.filter(m => m.status === 'active' && (!projectId || m.project_id === projectId)).map(m => { const e = this.employee(m.employee_id); return `<option value="${m.employee_id}" data-project="${m.project_id}"${m.employee_id === employeeId ? ' selected' : ''}>${this.esc(e.name)} · ${this.esc(e.position || '未填工种')} · ${this.esc(this.projectName(m.project_id))}</option>`; }).join(''); },
  packageOptions(projectId) { return this.state.packages.filter(p => !p.project_id || p.project_id === projectId).map(p => `<option value="${p.id}">${this.esc(p.title)} v${p.version_no || 1}${p.project_id ? '（项目包）' : '（通用包）'}</option>`).join(''); },

  openStartForm(projectId = '', employeeId = '') {
    this.modal('发起项目准入培训', `<p class="hint">发起后会建立准入记录，并把培训包中的计划同步到员工端。</p><div class="form-group"><label>项目 <span class="required">*</span></label><select id="ad-start-project" class="form-control" onchange="TrainingAdmissionOperations.refreshStartMembers()">${this.projectOptions(projectId)}</select></div><div class="form-group"><label>人员 <span class="required">*</span></label><select id="ad-start-employee" class="form-control">${this.memberOptions(projectId, employeeId)}</select></div><div class="form-group"><label>已发布培训包 <span class="required">*</span></label><select id="ad-start-package" class="form-control">${this.packageOptions(projectId)}</select></div>`, 'TrainingAdmissionOperations.submitStart()');
  },
  refreshStartMembers() { const project = document.getElementById('ad-start-project')?.value || ''; const el = document.getElementById('ad-start-employee'); if (el) el.innerHTML = this.memberOptions(project); const pack = document.getElementById('ad-start-package'); if (pack) pack.innerHTML = this.packageOptions(project); },
  async submitStart() { const project = document.getElementById('ad-start-project')?.value; const employee = document.getElementById('ad-start-employee')?.value; const pack = document.getElementById('ad-start-package')?.value; if (!project || !employee || !pack) { Utils.toast('项目、人员和培训包不能为空', 'error'); return; } const r = await sb.rpc('training_start_admission', { p_project_id: project, p_employee_id: employee, p_package_id: pack }); if (r.error) { Utils.toast(r.error.message, 'error'); return; } this.close(); Utils.toast('准入培训已发起，员工可进入我的培训学习', 'success'); await this.load(); },

  openConfirm(id) { this.modal('现场确认', `<p class="hint">现场确认后仍需满足培训、考试和签字条件，系统才会显示“可上岗”。</p><div class="form-group"><label>现场照片（必传）</label><input id="ad-confirm-file" type="file" class="form-control" accept="image/png,image/jpeg,image/webp"><p class="text-muted" style="font-size:12px">支持 PNG、JPG、WEBP，单个文件不超过 10MB；也可填写已有 Storage 路径。</p></div><div class="form-group"><label>已有照片 Storage 路径</label><input id="ad-confirm-path" class="form-control"></div><div class="form-group"><label>备注</label><textarea id="ad-confirm-note" class="form-control" rows="2"></textarea></div>`, `TrainingAdmissionOperations.submitConfirm('${id}')`); },
  async submitConfirm(id) { const file = document.getElementById('ad-confirm-file')?.files?.[0]; let path = document.getElementById('ad-confirm-path')?.value.trim() || ''; if (file) { const max = typeof CERT_FILE_MAX_SIZE === 'number' ? CERT_FILE_MAX_SIZE : 10 * 1024 * 1024; if (file.size > max || (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { Utils.toast('现场照片仅支持 PNG、JPG、WEBP，且不能超过 10MB', 'error'); return; } const a = this.state.admissions.find(x => x.id === id); const random = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2); path = `training-admission/site-confirmations/${a?.project_id || 'unknown'}/${Date.now()}-${random}.${(file.name.split('.').pop() || 'jpg').toLowerCase()}`; const up = await sb.storage.from(typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates').upload(path, file, { contentType: file.type, upsert: false }); if (up.error) { Utils.toast(`照片上传失败：${up.error.message}`, 'error'); return; } } if (!path) { Utils.toast('请上传现场照片或填写 Storage 路径', 'error'); return; } let coords = {}; if (navigator.geolocation) { try { coords = await new Promise(resolve => navigator.geolocation.getCurrentPosition(p => resolve({ p_latitude: p.coords.latitude, p_longitude: p.coords.longitude }), () => resolve({}), { enableHighAccuracy: false, timeout: 4000 })); } catch (_) {} } const r = await sb.rpc('training_confirm_site', { p_admission_id: id, p_photo_path: path, p_latitude: coords.p_latitude || null, p_longitude: coords.p_longitude || null, p_note: document.getElementById('ad-confirm-note')?.value.trim() || null, p_record_hash: null }); if (r.error) { Utils.toast(r.error.message, 'error'); return; } this.close(); Utils.toast('现场确认已记录', 'success'); await this.load(); },
  async recompute(id) { const r = await sb.rpc('training_recompute_admission', { p_admission_id: id }); if (r.error) { Utils.toast(r.error.message, 'error'); return; } Utils.toast('资格状态已刷新', 'success'); await this.load(); },
  async issue(id) { if (!confirm('确认签发该人员的电子记录凭证？')) return; const r = await sb.rpc('training_issue_certificate', { p_admission_id: id }); if (r.error) { Utils.toast(r.error.message, 'error'); return; } const d = Array.isArray(r.data) ? r.data[0] : r.data; alert(`已签发：${d?.certificate_no || '电子记录凭证'}\n核验码仅在本次返回，请妥善留存。`); await this.load(); },

  openTemporary(admissionId) {
    const max = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const value = new Date(Date.now() + 4 * 60 * 60 * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const maxValue = new Date(max.getTime() - max.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    this.modal('授予临时通行', `<div class="alert alert-danger" style="margin-bottom:12px">仅用于临时例外。最长 24 小时；爆破、钻探、电工、焊工等高风险岗位在系统层面禁止授予。</div><div class="form-group"><label>截止时间 <span class="required">*</span></label><input id="temp-access-expires" type="datetime-local" class="form-control" value="${value}" max="${maxValue}"></div><div class="form-group"><label>通行原因 <span class="required">*</span></label><textarea id="temp-access-reason" class="form-control" rows="4" placeholder="请如实填写需要临时通行的现场原因、工作内容和补办安排"></textarea></div>`, `TrainingAdmissionOperations.submitTemporary('${admissionId}')`);
  },

  async submitTemporary(admissionId) {
    const reason = document.getElementById('temp-access-reason')?.value.trim() || '';
    const raw = document.getElementById('temp-access-expires')?.value;
    if (!reason || !raw) { Utils.toast('请填写截止时间和通行原因', 'error'); return; }
    const { data, error } = await sb.rpc('training_grant_temporary_access', { p_admission_id: admissionId, p_reason: reason, p_expires_at: new Date(raw).toISOString() });
    if (error) { Utils.toast(error.message, 'error'); return; }
    const d = Array.isArray(data) ? data[0] : data;
    this.close();
    alert(`临时通行已授予\n编号：${d?.pass_code || '—'}\n截止：${String(d?.expires_at || '').replace('T', ' ').slice(0, 16)}\n\n请在临时通行台账中打开二维码；该记录已标红显示。`);
    await this.load();
  },

  showTemporaryQr(passCode) {
    if (!passCode || typeof qrcode !== 'function') { Utils.toast('二维码组件尚未加载，请刷新后重试', 'error'); return; }
    this.modal('临时通行二维码', `<div class="alert alert-danger" style="margin-bottom:12px">临时通行不是正常上岗凭证。现场必须实时核验，到期、撤销或项目暂停后立即失效。</div><div id="temporary-access-qr" style="width:200px;min-height:200px;padding:10px;background:#fff;border:1px solid #fecaca;border-radius:6px;margin:0 auto"></div><p style="text-align:center;margin:12px 0 0"><b>${this.esc(passCode)}</b></p>`, 'TrainingAdmissionOperations.close()');
    const box = document.getElementById('temporary-access-qr');
    try { const qr = qrcode(0, 'M'); qr.addData(passCode); qr.make(); box.innerHTML = qr.createImgTag(5, 0); } catch (_) { box.textContent = passCode; }
  },

  async revokeTemporary(id) {
    if (!confirm('确认撤销此临时通行？撤销后立即禁止凭此例外进入现场。')) return;
    const { error } = await sb.rpc('training_revoke_temporary_access', { p_access_id: id });
    if (error) { Utils.toast(error.message, 'error'); return; }
    Utils.toast('临时通行已撤销', 'success'); await this.load();
  },

  pendingRows() {
    return this.state.members.filter(m => m.status === 'active' && (!this.state.filter || m.project_id === this.state.filter)).map(m => ({ m, e: this.employee(m.employee_id), a: this.state.admissions.find(a => a.project_id === m.project_id && a.employee_id === m.employee_id) })).filter(x => !x.a || x.a.status !== 'eligible');
  },

  openBatchRemind() {
    if (!this.state.filter) { Utils.toast('请先选择一个项目，再进行批量催办', 'info'); return; }
    const rows = this.pendingRows().filter(x => x.a);
    if (!rows.length) { Utils.toast('该项目暂无需要催办的已发起准入人员', 'info'); return; }
    this.modal('批量催办未完成培训', `<p class="hint">将向 ${rows.length} 名人员的系统内“我的培训”写入待办提醒，并保留催办记录。微信订阅消息接入后会复用此名单。</p><div class="form-group"><label>催办内容 <span class="required">*</span></label><textarea id="batch-remind-message" class="form-control" rows="4">请尽快完成项目三级安全教育、考试和电子签字。未完成前禁止入场、禁止上岗。</textarea></div>`, 'TrainingAdmissionOperations.submitBatchRemind()');
  },

  async submitBatchRemind() {
    const rows = this.pendingRows().filter(x => x.a);
    const message = document.getElementById('batch-remind-message')?.value.trim() || '';
    const { data, error } = await sb.rpc('training_batch_remind', { p_project_id: this.state.filter, p_admission_ids: rows.map(x => x.a.id), p_message: message });
    if (error) { Utils.toast(error.message, 'error'); return; }
    this.close(); Utils.toast(`已生成 ${data || 0} 条系统内催办提醒`, 'success');
  },

  printBlocked() {
    if (!this.state.filter) { Utils.toast('请先选择一个项目，再打印禁止上岗名单', 'info'); return; }
    const rows = this.pendingRows(); const project = this.project(this.state.filter);
    const body = rows.map((x, i) => `<tr><td>${i + 1}</td><td>${this.esc(x.e.name)}</td><td>${this.esc(x.e.position || '—')}</td><td>${this.esc(x.a?.blocked_reason || (x.a ? '培训准入尚未完成' : '尚未发起准入培训'))}</td><td>禁止入场 / 禁止上岗</td></tr>`).join('');
    const w = window.open('', '_blank'); if (!w) { Utils.toast('浏览器阻止了打印窗口，请允许弹窗后重试', 'error'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>禁止上岗名单</title><style>body{font-family:Microsoft YaHei,sans-serif;padding:24px;color:#111}h1{text-align:center;font-size:20px}p{font-size:13px}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{border:1px solid #222;padding:8px;text-align:left}th{background:#eee}@media print{body{padding:0}}</style></head><body><h1>项目禁止入场 / 禁止上岗人员名单</h1><p>项目：${this.esc(this.projectName(project.id))}</p><p>打印时间：${new Date().toLocaleString()}</p><table><thead><tr><th>序号</th><th>姓名</th><th>工种</th><th>限制原因</th><th>当前要求</th></tr></thead><tbody>${body || '<tr><td colspan="5">暂无人员</td></tr>'}</tbody></table></body></html>`);
    w.document.close(); w.focus(); w.print();
  },

  openManagerSign(admissionId, role) {
    const label = role === 'project_manager' ? '项目经理' : '安全员';
    this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingAdmissionOperations.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:640px"><div class="modal-header"><h3>${label}项目准入签署</h3><button class="modal-close" onclick="TrainingAdmissionOperations.close()">×</button></div><div class="modal-body"><p class="hint">确认员工已完成完整准入记录后，请手写签字。该记录将进入培训签到表和检查台账。</p><canvas id="admission-manager-sign-canvas" width="600" height="220" style="width:100%;border:1.5px dashed #c7d0dc;border-radius:8px;touch-action:none;background:#fff;cursor:crosshair"></canvas><div style="margin-top:10px"><button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionOperations.clearManagerCanvas()">清除重写</button></div></div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionOperations.close()">取消</button><button class="btn btn-primary" onclick="TrainingAdmissionOperations.saveManagerSign('${admissionId}','${role}')">确认签署</button></div></div></div>`;
    this.initManagerCanvas();
  },

  initManagerCanvas() {
    const cv = document.getElementById('admission-manager-sign-canvas'); if (!cv) return;
    const ctx = cv.getContext('2d'); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
    this.managerSignDrawn = false; let down = false; let last = null;
    const point = e => { const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: (p.clientX - r.left) * cv.width / r.width, y: (p.clientY - r.top) * cv.height / r.height }; };
    const start = e => { e.preventDefault(); down = true; last = point(e); this.managerSignDrawn = true; };
    const move = e => { if (!down) return; e.preventDefault(); const next = point(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(next.x, next.y); ctx.stroke(); last = next; };
    const end = () => { down = false; last = null; };
    cv.addEventListener('pointerdown', start); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', end); cv.addEventListener('pointerleave', end);
  },

  clearManagerCanvas() { const cv = document.getElementById('admission-manager-sign-canvas'); if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); this.managerSignDrawn = false; },

  async saveManagerSign(admissionId, role) {
    if (!this.managerSignDrawn) { Utils.toast('请先在签字框中签字', 'error'); return; }
    const cv = document.getElementById('admission-manager-sign-canvas');
    const blob = await (await fetch(cv.toDataURL('image/png'))).blob();
    const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const path = `training-admission/signatures/${admissionId}/${Date.now()}-${random}.png`;
    const bucket = typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates';
    const { error: uploadError } = await sb.storage.from(bucket).upload(path, blob, { contentType: 'image/png', upsert: false });
    if (uploadError) { Utils.toast(`签字上传失败：${uploadError.message}`, 'error'); return; }
    const bytes = new TextEncoder().encode(`${admissionId}|${role}|${Date.now()}|${navigator.userAgent || ''}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
    const { error } = await sb.rpc('training_admission_sign', { p_admission_id: admissionId, p_task_id: null, p_signer_role: role, p_storage_path: path, p_record_hash: hash, p_device_info: (navigator.userAgent || '').slice(0, 200) });
    if (error) { Utils.toast(error.message, 'error'); return; }
    this.close(); Utils.toast('项目签署已保存', 'success'); await this.load();
  },
};

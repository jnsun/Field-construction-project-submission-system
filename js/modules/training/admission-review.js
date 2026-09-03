// =============================================================
// 外协入场审核与项目角色任命。
// 自助申请入口会在微信/手机号登录接入后复用 project_join_applications。
// =============================================================
const TrainingAdmissionReview = {
  state: { projects: [], applications: [], attachments: [], companies: [], profiles: [], roles: [] },
  APP_STATUS: {
    pending_project_review: ['待项目审核', 'badge-warning'],
    pending_entity_review: ['待经营实体复核', 'badge-info'],
    approved: ['已通过', 'badge-success'], rejected: ['已驳回', 'badge-danger'], cancelled: ['已取消', 'badge-muted'],
  },

  async render(box) {
    box.innerHTML = `<div class="toolbar"><div class="toolbar-left"><span class="toolbar-hint">外协人员入场审核与项目经理、安全员任命</span></div><div class="toolbar-right"><button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionReview.load()">刷新</button></div></div><div id="admission-review-summary"></div><div id="admission-applications"></div><div id="admission-roles" style="margin-top:16px"></div>`;
    await this.load();
  },

  async load() {
    const results = await Promise.all([
      sb.from('site_projects').select('id, project_code, name, status, lead_entity_id').order('created_at', { ascending: false }),
      sb.from('project_join_applications').select('id, project_id, employee_id, name, phone, position, contractor_id, contractor_name_input, status, review_note, created_at, project_reviewed_at, entity_reviewed_at').order('created_at', { ascending: false }),
      sb.from('project_join_application_attachments').select('id, application_id, attachment_type, original_name, storage_path').order('created_at'),
      sb.from('contractor_companies').select('id, name, status').order('name'),
      sb.from('profiles').select('id, full_name, email, department_id, role, admin_level').order('full_name'),
      sb.from('site_project_roles').select('id, project_id, user_id, role, active').eq('active', true),
    ]);
    const error = results.find(r => r.error); if (error) throw error.error;
    [this.state.projects, this.state.applications, this.state.attachments, this.state.companies, this.state.profiles, this.state.roles] = results.map(r => r.data || []);
    this.renderContent();
  },

  project(id) { return this.state.projects.find(x => x.id === id) || {}; },
  company(id) { return this.state.companies.find(x => x.id === id) || {}; },
  profile(id) { return this.state.profiles.find(x => x.id === id) || {}; },
  projectName(id) { const p = this.project(id); return p.project_code ? `${p.project_code} · ${p.name}` : '—'; },
  profileName(id) { const p = this.profile(id); return p.full_name || p.email || (id ? id.slice(0, 8) : '—'); },
  badge(status) { const v = this.APP_STATUS[status] || [status || '未知', 'badge-muted']; return `<span class="badge ${v[1]}">${v[0]}</span>`; },
  attachments(id) { return this.state.attachments.filter(x => x.application_id === id); },

  async openAttachment(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    const bucket = typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates';
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 300);
    if (error || !data?.signedUrl) { Utils.toast(error?.message || '附件暂时无法打开', 'error'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  },

  renderContent() {
    const pending = this.state.applications.filter(a => a.status === 'pending_project_review').length;
    const cross = this.state.applications.filter(a => a.status === 'pending_entity_review').length;
    const summary = document.getElementById('admission-review-summary');
    if (summary) summary.innerHTML = `<div class="stats-grid" style="margin-bottom:12px"><div class="stat-card warning"><div class="stat-value">${pending}</div><div class="stat-label">待项目审核</div></div><div class="stat-card info"><div class="stat-value">${cross}</div><div class="stat-label">待跨项目复核</div></div><div class="stat-card total"><div class="stat-value">${this.state.roles.length}</div><div class="stat-label">已任命项目角色</div></div></div>`;
    this.renderApplications(); this.renderRoles();
  },

  renderApplications() {
    const box = document.getElementById('admission-applications'); if (!box) return;
    const rows = this.state.applications;
    box.innerHTML = `<div class="card"><div class="card-header"><h2>外协入场申请（${rows.length}）</h2><span class="text-muted">首次申请经项目审核；人员已有其他项目在场记录时，自动转经营实体复核。</span></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:1040px"><thead><tr><th>申请人员</th><th>项目</th><th>外协单位 / 工种</th><th>附件</th><th>提交时间</th><th>状态</th><th>审核说明</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map(a => { const files = this.attachments(a.id); return `<tr><td><b>${Utils.escapeHtml(a.name)}</b><br><span class="text-muted">${Utils.escapeHtml(a.phone)}</span></td><td>${Utils.escapeHtml(this.projectName(a.project_id))}</td><td>${Utils.escapeHtml(this.company(a.contractor_id).name || a.contractor_name_input || '—')}<br><span class="text-muted">${Utils.escapeHtml(a.position || '未填工种')}</span></td><td>${files.length ? files.map(x => `${Utils.escapeHtml({ qualification: '单位资质', contract: '合同', special_certificate: '特种作业证' }[x.attachment_type] || '附件')}<br><span class="text-muted">${Utils.escapeHtml(x.original_name || x.storage_path)}</span><br><button class="btn btn-sm btn-secondary" style="margin-top:4px" onclick="TrainingAdmissionReview.openAttachment('${encodeURIComponent(x.storage_path)}')">查看</button>`).join('<hr style="border:0;border-top:1px solid #eee">') : '未提交'}</td><td>${Utils.escapeHtml((a.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${this.badge(a.status)}</td><td>${Utils.escapeHtml(a.review_note || '—')}</td><td>${this.actionButtons(a)}</td></tr>`; }).join('') : TrainingModule.emptyRow(8, '暂无外协入场申请')}</tbody></table></div></div>`;
  },

  actionButtons(app) {
    if (!TrainingModule.canEdit()) return '<span class="text-muted">只读</span>';
    if (app.status === 'pending_project_review' || app.status === 'pending_entity_review') return `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionReview.review('${app.id}','approve')">通过</button><button class="btn btn-sm btn-danger" onclick="TrainingAdmissionReview.review('${app.id}','reject')">驳回</button>`;
    return '<span class="text-muted">已处理</span>';
  },

  renderRoles() {
    const box = document.getElementById('admission-roles'); if (!box) return;
    const active = this.state.projects.filter(p => ['planning', 'active', 'paused'].includes(p.status));
    box.innerHTML = `<div class="card"><div class="card-header"><h2>项目经理与安全员</h2><span class="text-muted">项目经理最多 2 人；安全员数量不限。</span></div><div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:820px"><thead><tr><th>项目</th><th>状态</th><th>项目经理</th><th>安全员</th><th>操作</th></tr></thead><tbody>${active.length ? active.map(p => { const rs = this.state.roles.filter(r => r.project_id === p.id); const managers = rs.filter(r => r.role === 'project_manager').map(r => this.profileName(r.user_id)).join('、') || '未指定'; const safety = rs.filter(r => r.role === 'safety_officer').map(r => this.profileName(r.user_id)).join('、') || '未指定'; return `<tr><td><b>${Utils.escapeHtml(this.projectName(p.id))}</b></td><td>${Utils.escapeHtml(p.status)}</td><td>${Utils.escapeHtml(managers)}</td><td>${Utils.escapeHtml(safety)}</td><td>${TrainingModule.canEdit() ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionReview.openRoles('${p.id}')">设置角色</button>` : '—'}</td></tr>`; }).join('') : TrainingModule.emptyRow(5, '暂无可任命角色的项目')}</tbody></table></div></div>`;
  },

  host() { return document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })(); },
  close() { this.host().innerHTML = ''; },

  openRoles(projectId) {
    const project = this.project(projectId); if (!project) return;
    const current = this.state.roles.filter(r => r.project_id === projectId);
    const users = this.state.profiles.filter(p => p.role === 'admin' || p.role === 'employee');
    const rows = users.map(p => { const manager = current.some(r => r.user_id === p.id && r.role === 'project_manager'); const safety = current.some(r => r.user_id === p.id && r.role === 'safety_officer'); const label = Utils.escapeHtml(`${p.full_name || p.email || p.id.slice(0, 8)} · ${TrainingModule.deptName(p.department_id)}`); return `<tr><td>${label}</td><td><input class="ad-role-manager" type="checkbox" value="${p.id}"${manager ? ' checked' : ''}></td><td><input class="ad-role-safety" type="checkbox" value="${p.id}"${safety ? ' checked' : ''}></td></tr>`; }).join('');
    this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingAdmissionReview.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:700px"><div class="modal-header"><h3>设置项目角色</h3><button class="modal-close" onclick="TrainingAdmissionReview.close()">×</button></div><div class="modal-body"><p class="hint">项目：<b>${Utils.escapeHtml(this.projectName(projectId))}</b>。同一账号可同时兼任项目经理和安全员；项目经理最多两人。</p><div style="max-height:360px;overflow:auto"><table class="data-table"><thead><tr><th>账号</th><th>项目经理</th><th>安全员</th></tr></thead><tbody>${rows || TrainingModule.emptyRow(3, '当前权限范围内没有可任命账号')}</tbody></table></div></div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionReview.close()">取消</button><button class="btn btn-primary" onclick="TrainingAdmissionReview.saveRoles('${projectId}')">保存</button></div></div></div>`;
  },

  async saveRoles(projectId) {
    const managers = Array.from(document.querySelectorAll('.ad-role-manager:checked')).map(x => x.value);
    if (managers.length > 2) { Utils.toast('每个项目最多指定 2 名项目经理', 'error'); return; }
    const roles = [
      ...managers.map(user_id => ({ user_id, role: 'project_manager' })),
      ...Array.from(document.querySelectorAll('.ad-role-safety:checked')).map(x => ({ user_id: x.value, role: 'safety_officer' })),
    ];
    const result = await sb.rpc('site_project_set_roles', { p_project_id: projectId, p_roles: roles });
    if (result.error) { Utils.toast(result.error.message || '项目角色保存失败', 'error'); return; }
    this.close(); Utils.toast('项目角色已保存', 'success'); await this.load();
  },

  async review(applicationId, action) {
    const note = action === 'reject' ? prompt('请填写驳回原因') : prompt('可填写审核备注（可留空）', '');
    if (note === null || (action === 'reject' && !note)) return;
    if (action === 'approve' && !confirm('确认通过该入场申请？系统将按规则建档并加入项目。')) return;
    const result = await sb.rpc('site_project_review_application', { p_application_id: applicationId, p_action: action, p_note: note || null });
    if (result.error) { Utils.toast(result.error.message || '审核失败', 'error'); return; }
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    Utils.toast(data?.status === 'pending_entity_review' ? '项目审核已通过，已转经营实体复核' : (action === 'approve' ? '入场申请已通过' : '申请已驳回'), 'success');
    await this.load();
  },
};

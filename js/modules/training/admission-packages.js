// =============================================================
// js/modules/training/admission-packages.js —— 三级准入培训包
// 把现有培训计划组合成一个可审核、可发布、可追溯版本的入场培训包。
// =============================================================
const TrainingAdmissionPackages = {

  state: { packages: [], items: {}, projects: [], plans: [] },
  STATUS: { draft: '草稿', pending_review: '待审核', published: '已发布', archived: '已归档' },
  LEVEL: { company: '公司级', dept: '经营实体级', project: '项目级', special: '专项' },

  async render(box) {
    box.innerHTML = `<div class="toolbar"><div class="toolbar-left"><span class="toolbar-hint">三级教育 + 项目专项培训的版本化配置</span></div>
      <div class="toolbar-right"><button class="btn btn-secondary btn-sm" onclick="TrainingAdmissionPackages.load()">刷新</button>
      ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingAdmissionPackages.openForm()">+ 新建培训包</button>' : ''}</div></div>
      <div id="admission-packages-table"></div>`;
    await this.load();
  },

  async load() {
    const [packages, items, projects, plans] = await Promise.all([
      sb.from('training_admission_packages').select('id, project_id, title, version_no, validity_years, pause_retrain_days, status, source_document_path, review_note, created_at').order('created_at', { ascending: false }),
      sb.from('training_admission_package_items').select('package_id, plan_id, level, required, sort_order'),
      sb.from('site_projects').select('id, project_code, name, status').order('created_at', { ascending: false }),
      sb.from('training_plans').select('id, title, level, category, plan_year, publish_status, status').order('plan_year', { ascending: false }).order('created_at', { ascending: false }),
    ]);
    const error = [packages, items, projects, plans].find(r => r.error);
    if (error) throw error.error;
    this.state.packages = packages.data || [];
    this.state.items = {};
    (items.data || []).forEach(i => { (this.state.items[i.package_id] = this.state.items[i.package_id] || []).push(i); });
    this.state.projects = projects.data || [];
    this.state.plans = plans.data || [];
    this.renderTable();
  },

  projectName(id) { const p = this.state.projects.find(x => x.id === id); return p ? `${p.project_code} · ${p.name}` : '公司通用包'; },
  planName(id) { const p = this.state.plans.find(x => x.id === id); return p ? p.title : '已删除计划'; },
  badge(s) { const cls = s === 'published' ? 'badge-success' : s === 'pending_review' ? 'badge-warning' : s === 'archived' ? 'badge-muted' : 'badge-info'; return `<span class="badge ${cls}">${this.STATUS[s] || s}</span>`; },

  renderTable() {
    const box = document.getElementById('admission-packages-table'); if (!box) return;
    const canEdit = TrainingModule.canEdit();
    box.innerHTML = `<div class="card"><div class="card-header"><h2>准入培训包（${this.state.packages.length}）</h2></div>
      <div class="card-body" style="padding:0;overflow-x:auto"><table class="data-table" style="min-width:900px"><thead><tr>
      <th>培训包 / 版本</th><th>适用项目</th><th>包含内容</th><th>凭证有效期</th><th>停工复训</th><th>状态</th><th>操作</th></tr></thead><tbody>
      ${this.state.packages.length ? this.state.packages.map(p => { const items = this.state.items[p.id] || []; return `<tr><td><b>${Utils.escapeHtml(p.title)}</b><br><span class="text-muted">v${p.version_no}</span></td>
        <td>${Utils.escapeHtml(this.projectName(p.project_id))}</td><td>${items.length ? items.map(i => `${this.LEVEL[i.level] || i.level}：${Utils.escapeHtml(this.planName(i.plan_id))}`).join('<br>') : '—'}</td>
        <td>${Utils.escapeHtml(String(p.validity_years || 1))} 年</td><td>${p.pause_retrain_days || 0} 天</td><td>${this.badge(p.status)}</td>
        <td>${canEdit ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionPackages.openForm('${p.id}')">编辑</button>
          ${p.status === 'draft' ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionPackages.submitReview('${p.id}')">提交审核</button>` : ''}` : ''}</td></tr>`; }).join('')
        : TrainingModule.emptyRow(7, '暂无准入培训包，请先创建公司级/经营实体级/项目级培训计划')}</tbody></table></div></div>`;
  },

  host() { return document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })(); },
  close() { const h = document.getElementById('training-modal-host'); if (h) h.innerHTML = ''; },

  openForm(id) {
    const p = id ? this.state.packages.find(x => x.id === id) : null;
    if (p && p.status === 'published') {
      Utils.toast('已发布培训包不能直接修改，请按新版本重新建立', 'info');
      return;
    }
    const chosen = new Set((p ? (this.state.items[p.id] || []) : []).map(i => i.plan_id));
    const projects = this.state.projects.filter(x => x.status !== 'closed').map(x => `<option value="${x.id}"${p && p.project_id === x.id ? ' selected' : ''}>${Utils.escapeHtml(this.projectName(x.id))}</option>`).join('');
    const planRows = this.state.plans.filter(x => x.status !== 'cancelled').map(x => `<label style="display:block;font-weight:400;margin:4px 0"><input type="checkbox" class="admission-plan-cb" value="${x.id}" data-level="${x.level === 'dept' ? 'entity' : x.level}" ${chosen.has(x.id) ? 'checked' : ''}> ${this.LEVEL[x.level === 'dept' ? 'dept' : x.level] || x.level} · ${Utils.escapeHtml(x.title)}（${x.plan_year}）</label>`).join('');
    this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingAdmissionPackages.close()"><div class="modal" onclick="event.stopPropagation()" style="max-width:700px"><div class="modal-header"><h3>${p ? '编辑准入培训包' : '新建准入培训包'}</h3><button class="modal-close" onclick="TrainingAdmissionPackages.close()">×</button></div>
      <div class="modal-body"><div class="form-group"><label>培训包名称 <span class="required">*</span></label><input id="ap-title" class="form-control" value="${Utils.escapeHtml(p ? p.title : '三级安全教育准入培训包')}"></div>
      <div class="form-row"><div class="form-group"><label>适用项目</label><select id="ap-project" class="form-control"><option value="">公司通用包（仅公司级管理员）</option>${projects}</select></div><div class="form-group"><label>版本号</label><input id="ap-version" type="number" min="1" class="form-control" value="${p ? p.version_no : 1}"></div></div>
      <div class="form-row"><div class="form-group"><label>合格凭证有效期（年）</label><input id="ap-validity" type="number" min="0.5" step="0.5" class="form-control" value="${p ? p.validity_years : 1}"></div><div class="form-group"><label>停工超过多少天需复训</label><input id="ap-pause" type="number" min="0" class="form-control" value="${p ? p.pause_retrain_days : 180}"></div></div>
      <div class="form-group"><label>选择必修培训内容</label><div style="max-height:260px;overflow:auto;border:1px solid var(--color-border);border-radius:6px;padding:8px">${planRows || '<span class="text-muted">暂无培训计划</span>'}</div><p class="text-muted" style="font-size:12px;margin-top:4px">专项培训仍建议单独建立计划，例如野外作业、交通安全、爆破、钻探、用电、有限空间等。</p></div>
      <div class="form-group"><label>导入原始资料路径（选填）</label><input id="ap-source" class="form-control" value="${Utils.escapeHtml(p ? (p.source_document_path || '') : '')}" placeholder="Word/PDF 导入后初稿的存档路径"></div></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionPackages.close()">取消</button><button class="btn btn-primary" onclick="TrainingAdmissionPackages.submit('${p ? p.id : ''}')">保存草稿</button></div></div></div>`;
  },

  async submit(id) {
    const v = key => (document.getElementById(key) || {}).value || '';
    const title = v('ap-title').trim();
    const selected = Array.from(document.querySelectorAll('.admission-plan-cb:checked')).map(cb => ({ plan_id: cb.value, level: cb.dataset.level, required: true }));
    if (!title || !selected.length) { Utils.toast('请填写培训包名称并至少选择一项必修培训', 'error'); return; }
    const payload = { title, project_id: v('ap-project') || null, version_no: parseInt(v('ap-version'), 10) || 1, validity_years: parseFloat(v('ap-validity')) || 1, pause_retrain_days: parseInt(v('ap-pause'), 10) || 0, source_document_path: v('ap-source').trim() || null, status: 'draft' };
    if (!id) payload.created_by = (Auth.currentUser || {}).id;
    const result = id ? await sb.from('training_admission_packages').update(payload).eq('id', id).select('id').single() : await sb.from('training_admission_packages').insert(payload).select('id').single();
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    const packageId = id || result.data.id;
    if (id) { const removed = await sb.from('training_admission_package_items').delete().eq('package_id', id); if (removed.error) { Utils.toast(removed.error.message, 'error'); return; } }
    const items = await sb.from('training_admission_package_items').insert(selected.map((x, i) => ({ ...x, package_id: packageId, sort_order: i })));
    if (items.error) { Utils.toast(items.error.message, 'error'); return; }
    this.close(); Utils.toast('培训包草稿已保存', 'success'); await this.load();
  },

  async submitReview(id) {
    const result = await sb.from('training_admission_packages').update({ status: 'pending_review', updated_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { Utils.toast(result.error.message, 'error'); return; }
    Utils.toast('已提交审核', 'success'); await this.load();
  },
};

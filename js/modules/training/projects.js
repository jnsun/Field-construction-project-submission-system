// =============================================================
// js/modules/training/projects.js —— 正式项目台账
//
// 项目台账与 project_reports 保持两套事实来源：月报只提供候选，
// 管理员确认后才通过 RPC 批量关联，避免月报误填自动改变正式项目。
// =============================================================
const TrainingProjects = {

  state: {
    list: [],
    candidates: [],
    entityLinks: {},
    reportHints: {},
    filters: { status: '', keyword: '' },
  },

  STATUS_LABEL: {
    planning: '筹备中',
    active: '在建',
    paused: '暂停',
    pending_close: '待确认关闭',
    closed: '已关闭',
  },

  STATUS_CLASS: {
    planning: 'badge-muted',
    active: 'badge-success',
    paused: 'badge-warning',
    pending_close: 'badge-danger',
    closed: 'badge-muted',
  },

  async render(box) {
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>状态：</label>
          <select id="site-project-filter-status" onchange="TrainingProjects.onFilterChange()">
            <option value="">全部</option>
            ${Object.entries(this.STATUS_LABEL).map(([key, label]) =>
              `<option value="${key}"${this.state.filters.status === key ? ' selected' : ''}>${label}</option>`
            ).join('')}
        </select>
        </div>
        <div class="toolbar-right">
          <input type="search" id="site-project-filter-keyword" class="toolbar-search"
            placeholder="搜索项目编号/名称/地点"
            value="${Utils.escapeHtml(this.state.filters.keyword)}"
            oninput="TrainingProjects.onSearch()">
          <button class="btn btn-secondary btn-sm" onclick="TrainingProjects.load()">刷新</button>
          ${TrainingModule.canEdit()
            ? '<button class="btn btn-primary btn-sm" onclick="TrainingProjects.openForm()">+ 新建正式项目</button>' : ''}
        </div>
      </div>
      <div id="site-project-summary"></div>
      <div id="site-project-table"></div>
      <div id="site-project-candidates" style="margin-top:16px"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    const el = document.getElementById('site-project-filter-status');
    this.state.filters.status = el ? el.value : '';
    this.renderTable();
  },

  onSearch() {
    const el = document.getElementById('site-project-filter-keyword');
    this.state.filters.keyword = el ? el.value.trim() : '';
    this.renderTable();
  },

  async load() {
    const [projects, candidates, links, hints] = await Promise.all([
      sb.from('site_projects')
        .select('id, project_code, name, project_type, location, status, start_date, expected_end_date, actual_end_date, lead_entity_id, pause_reason, close_reason, created_at, updated_at')
        .order('created_at', { ascending: false }),
      sb.from('site_project_report_candidates')
        .select('department_id, project_name, construction_location, latest_reporting_month, latest_status, report_count')
        .order('latest_reporting_month', { ascending: false }),
      sb.from('site_project_entities').select('project_id, entity_id, is_lead'),
      sb.rpc('site_project_report_status_hints'),
    ]);
    if (projects.error) throw projects.error;
    if (candidates.error) throw candidates.error;
    if (links.error) throw links.error;
    if (hints.error) throw hints.error;
    this.state.list = projects.data || [];
    this.state.candidates = candidates.data || [];
    this.state.entityLinks = {};
    (links.data || []).forEach(row => {
      (this.state.entityLinks[row.project_id] = this.state.entityLinks[row.project_id] || []).push(row.entity_id);
    });
    this.state.reportHints = {};
    (hints.data || []).forEach(row => { this.state.reportHints[row.project_id] = row; });
    this.renderTable();
  },

  filtered() {
    const { status, keyword } = this.state.filters;
    const kw = (keyword || '').toLowerCase();
    return this.state.list.filter(p => {
      if (status && p.status !== status) return false;
      if (kw && ![p.project_code, p.name, p.location, p.project_type]
        .filter(Boolean).join(' ').toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  statusBadge(status) {
    return `<span class="badge ${this.STATUS_CLASS[status] || 'badge-muted'}">${this.STATUS_LABEL[status] || Utils.escapeHtml(status || '未知')}</span>`;
  },

  dateRange(project) {
    if (project.start_date && project.expected_end_date) {
      return `${Utils.escapeHtml(project.start_date)} ~ ${Utils.escapeHtml(project.expected_end_date)}`;
    }
    return Utils.escapeHtml(project.start_date || project.expected_end_date || '—');
  },

  renderTable() {
    const table = document.getElementById('site-project-table');
    const summary = document.getElementById('site-project-summary');
    const candidates = document.getElementById('site-project-candidates');
    if (!table || !summary || !candidates) return;

    const rows = this.filtered();
    const active = this.state.list.filter(p => p.status === 'active').length;
    const blocked = this.state.list.filter(p => ['paused', 'pending_close'].includes(p.status)).length;
    summary.innerHTML = `
      <div class="stats-grid" style="margin-bottom:12px">
        ${this.statCard('正式项目', this.state.list.length, 'total')}
        ${this.statCard('在建项目', active, 'success')}
        ${this.statCard('需处理项目', blocked, 'warning')}
        ${this.statCard('待关联月报组', this.state.candidates.length, 'info')}
      </div>`;

    const canEdit = TrainingModule.canEdit();
    table.innerHTML = `
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <h2>正式项目台账（${rows.length}）</h2>
          <span class="text-muted" style="font-size:12px">月报变更只提示，不会自动覆盖项目台账</span>
        </div>
        <div class="card-body" style="padding:0;overflow-x:auto">
          <table class="data-table" style="min-width:900px">
            <thead><tr>
              <th>项目编号</th><th>项目名称</th><th>类型 / 地点</th>
              <th>主责经营实体</th><th>开工 / 预计完工</th><th>状态</th>
              <th style="width:150px">操作</th>
            </tr></thead>
            <tbody>
              ${rows.length ? rows.map(p => `
                <tr>
                  <td><b>${Utils.escapeHtml(p.project_code)}</b></td>
                  <td>${Utils.escapeHtml(p.name)}</td>
                  <td>${Utils.escapeHtml(p.project_type || '—')}<br><span class="text-muted">${Utils.escapeHtml(p.location || '—')}</span></td>
                  <td>${Utils.escapeHtml(TrainingModule.deptName(p.lead_entity_id))}</td>
                  <td>${this.dateRange(p)}</td>
                  <td>${this.statusBadge(p.status)}${this.reportHint(p)}${p.status === 'paused' && p.pause_reason
                    ? `<div class="text-muted" style="font-size:12px;margin-top:4px">${Utils.escapeHtml(p.pause_reason)}</div>` : ''}</td>
                  <td>${canEdit
                    ? `<button class="btn btn-sm btn-secondary" onclick="TrainingProjects.openForm('${p.id}')">编辑</button>
                       ${p.status === 'active' ? `<button class="btn btn-sm btn-primary" onclick="TrainingProjects.createInvite('${p.id}')">邀请码</button>` : ''}
                       ${p.status === 'active' && this.reportHints[p.id]?.latest_status === 'completed' ? `<button class="btn btn-sm btn-danger" onclick="TrainingProjects.openForm('${p.id}')">确认关闭</button>` : ''}` : ''}
                    <button class="btn btn-sm btn-secondary" onclick="TrainingProjects.showDetail('${p.id}')">详情</button>
                  </td>
                </tr>`).join('')
                : TrainingModule.emptyRow(canEdit ? 7 : 6, '暂无正式项目，请先新建或从月报候选中建立台账')}
            </tbody>
          </table>
        </div>
      </div>`;

    candidates.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>月报项目候选（${this.state.candidates.length}）</h2></div>
        <div class="card-body" style="padding:0;overflow-x:auto">
          <table class="data-table" style="min-width:760px">
            <thead><tr><th>经营实体</th><th>月报项目名称</th><th>施工地点</th><th>最近报送</th><th>历史条数</th><th>操作</th></tr></thead>
            <tbody>
              ${this.state.candidates.length ? this.state.candidates.map(c => `
                <tr>
                  <td>${Utils.escapeHtml(TrainingModule.deptName(c.department_id))}</td>
                  <td>${Utils.escapeHtml(c.project_name)}</td>
                  <td>${Utils.escapeHtml(c.construction_location)}</td>
                  <td>${Utils.escapeHtml(this.reportMonth(c.latest_reporting_month))}</td>
                  <td>${c.report_count || 0}</td>
                  <td>${canEdit
                    ? `<button class="btn btn-sm btn-primary" onclick="TrainingProjects.openLinkForm(${this.jsonArg(c)})">关联正式项目</button>`
                    : '<span class="text-muted">只读</span>'}</td>
                </tr>`).join('')
                : TrainingModule.emptyRow(6, '暂无未关联的月报项目候选')}
            </tbody>
          </table>
        </div>
      </div>`;
  },

  reportHint(project) {
    const hint = this.state.reportHints[project.id];
    if (!hint) return '';
    const month = this.reportMonth(hint.latest_reporting_month);
    if (hint.latest_status === 'completed' && project.status === 'active') return `<div style="color:#b45309;font-size:12px;margin-top:4px">月报 ${Utils.escapeHtml(month)} 标记已完工，请人工确认是否关闭</div>`;
    return `<div class="text-muted" style="font-size:11px;margin-top:4px">最近月报：${Utils.escapeHtml(month)} · ${hint.latest_status === 'completed' ? '已完工' : '在建'}</div>`;
  },

  statCard(label, value, cls) {
    return `<div class="stat-card ${cls}"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
  },

  reportMonth(value) {
    if (!value) return '—';
    const text = String(value);
    return text.length === 6 ? `${text.slice(0, 4)}-${text.slice(4)}` : text;
  },

  jsonArg(candidate) {
    return JSON.stringify(candidate)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  entityOptions(selected) {
    const list = (TrainingModule.visibleDepts ? TrainingModule.visibleDepts() : TrainingModule.state.depts)
      .filter(d => d.dept_type === 'entity')
      .sort((a, b) => (a.code || a.name || '').localeCompare(b.code || b.name || '', 'zh'));
    return list.map(d => `<option value="${d.id}"${d.id === selected ? ' selected' : ''}>${Utils.escapeHtml(d.name)}</option>`).join('');
  },

  entityChecks(project) {
    const selected = project ? (this.state.entityLinks[project.id] || []) : [];
    const lead = project ? project.lead_entity_id : '';
    const list = (TrainingModule.visibleDepts ? TrainingModule.visibleDepts() : TrainingModule.state.depts)
      .filter(d => d.dept_type === 'entity')
      .sort((a, b) => (a.code || a.name || '').localeCompare(b.code || b.name || '', 'zh'));
    return list.map(d => `<label style="display:inline-block;min-width:190px;font-weight:400;margin:0 12px 6px 0">
      <input type="checkbox" class="site-project-entity-cb" value="${d.id}"
        ${d.id === lead || selected.includes(d.id) ? ' checked' : ''}>
      ${Utils.escapeHtml(d.name)}${d.id === lead ? '（主责）' : ''}</label>`).join('');
  },

  host() {
    return document.getElementById('training-modal-host') || (() => {
      const host = document.createElement('div');
      host.id = 'training-modal-host';
      document.body.appendChild(host);
      return host;
    })();
  },

  openForm(id) {
    const p = id ? this.state.list.find(x => x.id === id) : null;
    if (id && !p) return;
    const status = p ? p.status : 'planning';
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingProjects.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:680px">
          <div class="modal-header"><h3>${p ? '编辑正式项目' : '新建正式项目'}</h3>
            <button class="modal-close" onclick="TrainingProjects.closeForm()">×</button></div>
          <div class="modal-body">
            ${p ? `<p class="hint" style="margin-bottom:12px">项目编号：<b>${Utils.escapeHtml(p.project_code)}</b></p>` : ''}
            <div class="form-group"><label>项目名称 <span class="required">*</span></label>
              <input id="site-project-name" class="form-control" value="${Utils.escapeHtml(p ? p.name : '')}" placeholder="填写正式项目名称"></div>
            <div class="form-row"><div class="form-group"><label>项目类型</label>
              <input id="site-project-type" class="form-control" value="${Utils.escapeHtml(p ? (p.project_type || '') : '')}" placeholder="如：地质勘查 / 钻探"></div>
              <div class="form-group"><label>主责经营实体 <span class="required">*</span></label>
                <select id="site-project-entity" class="form-control">${this.entityOptions(p ? p.lead_entity_id : '')}</select></div></div>
            <div class="form-group"><label>参与经营实体</label>
              <div style="max-height:120px;overflow:auto;border:1px solid var(--color-border);border-radius:6px;padding:8px">
                ${this.entityChecks(p)}
              </div>
              <p class="text-muted" style="font-size:12px;margin:4px 0 0">多经营实体项目可勾选多个单位，主责单位必须保留。</p>
            </div>
            <div class="form-group"><label>施工地点</label>
              <input id="site-project-location" class="form-control" value="${Utils.escapeHtml(p ? (p.location || '') : '')}" placeholder="省、市、县及现场位置"></div>
            <div class="form-row"><div class="form-group"><label>开工日期</label>
              <input id="site-project-start" type="date" class="form-control" value="${Utils.escapeHtml(p ? (p.start_date || '') : '')}"></div>
              <div class="form-group"><label>预计完工日期</label>
                <input id="site-project-end" type="date" class="form-control" value="${Utils.escapeHtml(p ? (p.expected_end_date || '') : '')}"></div></div>
            ${p ? `<div class="form-row"><div class="form-group"><label>实际完工日期</label>
              <input id="site-project-actual-end" type="date" class="form-control" value="${Utils.escapeHtml(p.actual_end_date || '')}"></div>
              <div class="form-group"><label>项目状态</label><select id="site-project-status" class="form-control">
                ${Object.entries(this.STATUS_LABEL).map(([key, label]) => `<option value="${key}"${status === key ? ' selected' : ''}>${label}</option>`).join('')}
              </select></div></div>` : '<input type="hidden" id="site-project-status" value="planning">'}
            ${p ? '<p class="alert alert-danger" style="font-size:12px">项目从暂停、待关闭或关闭恢复为在建后，所有人员必须重新完成现场确认；停工前的确认将自动失效。</p>' : ''}
            <div class="form-group"><label>${p ? '变更原因（暂停、待关闭、关闭和重新开启必填）' : '备注'}</label>
              <textarea id="site-project-reason" class="form-control" rows="3" placeholder="填写项目状态或台账变更原因">${Utils.escapeHtml(p ? (p.pause_reason || p.close_reason || '') : '')}</textarea></div>
          </div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingProjects.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingProjects.submit('${p ? p.id : ''}')">保存</button></div>
        </div>
      </div>`;
  },

  closeForm() {
    const host = document.getElementById('training-modal-host');
    if (host) host.innerHTML = '';
  },

  async submit(id) {
    const val = key => (document.getElementById(key) || {}).value || '';
    const name = val('site-project-name').trim();
    const entity = val('site-project-entity') || null;
    if (!name || !entity) { Utils.toast('项目名称和主责经营实体不能为空', 'error'); return; }
    const btn = document.querySelector('#training-modal-host .modal-footer .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }
    try {
      let result;
      if (id) {
        result = await sb.rpc('site_project_update', {
          p_project_id: id,
          p_name: name,
          p_project_type: val('site-project-type').trim() || null,
          p_location: val('site-project-location').trim() || null,
          p_status: val('site-project-status') || 'planning',
          p_start_date: val('site-project-start') || null,
          p_expected_end_date: val('site-project-end') || null,
          p_actual_end_date: val('site-project-actual-end') || null,
          p_lead_entity_id: entity,
          p_reason: val('site-project-reason').trim() || null,
        });
      } else {
        result = await sb.rpc('site_project_create', {
          p_name: name,
          p_project_type: val('site-project-type').trim() || null,
          p_location: val('site-project-location').trim() || null,
          p_start_date: val('site-project-start') || null,
          p_expected_end_date: val('site-project-end') || null,
          p_lead_entity_id: entity,
          p_report_notes: val('site-project-reason').trim() || null,
        });
      }
      if (result.error) throw result.error;
      const project = Array.isArray(result.data) ? result.data[0] : result.data;
      const entityIds = Array.from(document.querySelectorAll('.site-project-entity-cb:checked')).map(cb => cb.value);
      if (!entityIds.includes(entity)) entityIds.push(entity);
      const links = await sb.rpc('site_project_set_entities', {
        p_project_id: id || (project && project.id),
        p_entity_ids: entityIds,
      });
      if (links.error) throw links.error;
      this.closeForm();
      Utils.toast(id ? '正式项目已更新' : '正式项目已建立', 'success');
      await this.load();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      Utils.toast((Auth.mapDbError ? Auth.mapDbError(e) : e.message) || '保存失败', 'error');
    }
  },

  showDetail(id) {
    const p = this.state.list.find(x => x.id === id);
    if (!p) return;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingProjects.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:620px">
          <div class="modal-header"><h3>项目详情</h3><button class="modal-close" onclick="TrainingProjects.closeForm()">×</button></div>
          <div class="modal-body"><div class="detail-grid">
            ${this.detail('项目编号', p.project_code)}${this.detail('项目名称', p.name)}
            ${this.detail('项目类型', p.project_type)}${this.detail('主责经营实体', TrainingModule.deptName(p.lead_entity_id))}
            ${this.detail('施工地点', p.location)}${this.detail('状态', this.STATUS_LABEL[p.status] || p.status)}
            ${this.detail('开工日期', p.start_date)}${this.detail('预计完工', p.expected_end_date)}
            ${this.detail('实际完工', p.actual_end_date)}${this.detail('创建时间', p.created_at ? p.created_at.slice(0, 16).replace('T', ' ') : '')}
          </div></div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingProjects.closeForm()">关闭</button></div>
        </div>
      </div>`;
  },

  detail(label, value) {
    return `<div class="detail-item"><div class="detail-label">${label}</div><div class="detail-value">${Utils.escapeHtml(value || '—')}</div></div>`;
  },

  openLinkForm(candidate) {
    if (!candidate) return;
    const options = this.state.list.filter(p => p.status !== 'closed')
      .map(p => `<option value="${p.id}">${Utils.escapeHtml(p.project_code)} · ${Utils.escapeHtml(p.name)}</option>`).join('');
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingProjects.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:620px">
          <div class="modal-header"><h3>关联历史月报</h3><button class="modal-close" onclick="TrainingProjects.closeForm()">×</button></div>
          <div class="modal-body">
            <p class="hint">将把同一经营实体、项目名称和施工地点下的 <b>${candidate.report_count || 0}</b> 条未关联月报挂到所选正式项目。此操作需要人工确认。</p>
            <div class="form-group"><label>月报候选</label><div class="detail-text">${Utils.escapeHtml(candidate.project_name)}<br>${Utils.escapeHtml(candidate.construction_location)}</div></div>
            <div class="form-group"><label>正式项目 <span class="required">*</span></label><select id="site-project-link-id" class="form-control">${options}</select></div>
          </div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingProjects.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingProjects.linkReports(${this.jsonArg(candidate)})">确认关联</button></div>
        </div>
      </div>`;
  },

  async linkReports(candidate) {
    const projectId = (document.getElementById('site-project-link-id') || {}).value;
    if (!projectId) return;
    const result = await sb.rpc('site_project_link_reports', {
      p_project_id: projectId,
      p_department_id: candidate.department_id,
      p_project_name: candidate.project_name,
      p_location: candidate.construction_location,
    });
    if (result.error) { Utils.toast(result.error.message || '关联失败', 'error'); return; }
    this.closeForm();
    Utils.toast(`已关联 ${result.data || 0} 条历史月报`, 'success');
    await this.load();
  },

  async createInvite(projectId) {
    if (!confirm('刷新邀请码后，旧邀请码会立即失效。确定继续吗？')) return;
    const result = await sb.rpc('site_project_refresh_invite', { p_project_id: projectId });
    if (result.error) { Utils.toast(result.error.message || '邀请码生成失败', 'error'); return; }
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    const token = data && data.token;
    if (!token) { Utils.toast('邀请码生成成功，但没有返回可展示的邀请码', 'error'); return; }
    this.host().innerHTML = `<div class="modal-overlay" onclick="TrainingProjects.closeForm()"><div class="modal" onclick="event.stopPropagation()" style="max-width:520px">
      <div class="modal-header"><h3>项目邀请码已生成</h3><button class="modal-close" onclick="TrainingProjects.closeForm()">×</button></div>
      <div class="modal-body"><p class="hint">该邀请码仅在本次显示，过期时间：${Utils.escapeHtml(data.expires_at || '')}。刷新后旧码立即失效。</p>
        <div class="detail-text" style="font-size:20px;letter-spacing:1px;text-align:center;word-break:break-all">${Utils.escapeHtml(token)}</div>
        <p class="text-muted" style="font-size:12px;margin-top:8px">请将邀请码转换为项目二维码后提供给外协人员，后续小程序端会直接支持扫码加入。</p></div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingProjects.copyInvite('${Utils.esc(token)}')">复制邀请码</button><button class="btn btn-primary" onclick="TrainingProjects.closeForm()">完成</button></div>
    </div></div>`;
  },

  async copyInvite(token) {
    try {
      await navigator.clipboard.writeText(token);
      Utils.toast('邀请码已复制', 'success');
    } catch (_) { Utils.toast('浏览器未允许自动复制，请手动选中邀请码', 'info'); }
  },
};

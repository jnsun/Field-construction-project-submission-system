// =============================================================
// js/modules/training/courses.js —— 课件管理（管理员端）
// 一个培训计划下挂若干课件；必修课件全部达到 90% 才算完成培训
// =============================================================
const TrainingCourses = {

  state: {
    planId: '',
    planTitle: '',
    list: [],
  },

  TYPE_LABEL: {
    pdf: 'PDF 文档',
    video: '视频',
    image: '图片',
    text: '图文',
    link: '外链',
  },

  BUCKET: 'training-courses',

  async open(planId) {
    const p = (TrainingPlans.state.list || []).find(x => x.id === planId);
    this.state.planId = planId;
    this.state.planTitle = p ? p.title : '';
    await this.load();
    this.renderModal();
  },

  async load() {
    const { data, error } = await sb.from('training_courses')
      .select('id, plan_id, title, course_type, file_path, file_url, content, page_count, duration_sec, required, sort_order')
      .eq('plan_id', this.state.planId)
      .order('sort_order');
    if (error) { alert('加载课件失败：' + error.message); return; }
    this.state.list = data || [];
  },

  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  close() {
    const d = document.getElementById('training-modal-host');
    if (d) d.innerHTML = '';
  },

  publicUrl(path) {
    if (!path) return '';
    const { data } = sb.storage.from(this.BUCKET).getPublicUrl(path);
    return data ? data.publicUrl : '';
  },

  renderModal() {
    const rows = this.state.list;
    const requiredCount = rows.filter(r => r.required).length;

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingCourses.close()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:820px">
          <div class="modal-header">
            <h3>课件管理 — ${Utils.escapeHtml(this.state.planTitle)}</h3>
            <button class="modal-close" onclick="TrainingCourses.close()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              共 ${rows.length} 个课件，其中必修 ${requiredCount} 个。
              员工必须把<b>全部必修课件</b>学到 90% 以上，系统才会自动记录为「已完成」。
            </p>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:50px">序</th>
                  <th>课件名称</th>
                  <th style="width:90px">类型</th>
                  <th style="width:80px">页数/秒</th>
                  <th style="width:70px">必修</th>
                  <th style="width:130px">操作</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? TrainingModule.emptyRow(6, '还没有课件，点下方「+ 添加课件」')
                  : rows.map(c => `
                    <tr>
                      <td>${c.sort_order}</td>
                      <td title="${Utils.escapeHtml(c.title)}">${Utils.escapeHtml(c.title)}</td>
                      <td>${this.TYPE_LABEL[c.course_type] || c.course_type}</td>
                      <td>${c.page_count != null ? c.page_count + ' 页' : (c.duration_sec != null ? c.duration_sec + ' 秒' : '—')}</td>
                      <td>${c.required
                          ? '<span class="badge badge-danger">必修</span>'
                          : '<span class="badge badge-muted">选修</span>'}</td>
                      <td>
                        <button class="btn btn-sm btn-secondary" onclick="TrainingCourses.openForm('${c.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingCourses.remove('${c.id}')">删除</button>
                      </td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="TrainingCourses.openForm()">+ 添加课件</button>
            <button class="btn btn-secondary" onclick="TrainingCourses.close()">关闭</button>
          </div>
        </div>
      </div>
    `;
  },

  openForm(id) {
    const c = id ? this.state.list.find(x => x.id === id) : null;
    const nextOrder = this.state.list.length
      ? Math.max(...this.state.list.map(x => x.sort_order || 0)) + 1 : 1;

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingCourses.close()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:600px">
          <div class="modal-header">
            <h3>${c ? '编辑课件' : '添加课件'}</h3>
            <button class="modal-close" onclick="TrainingCourses.close()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>课件名称 <span class="required">*</span></label>
              <input id="cs-title" class="form-control" value="${Utils.escapeHtml(c ? c.title : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>类型</label>
                <select id="cs-type" class="form-control" onchange="TrainingCourses.onTypeChange()">
                  ${Object.entries(this.TYPE_LABEL).map(([k, v]) =>
                    `<option value="${k}"${c && c.course_type === k ? ' selected' : ''}>${v}</option>`).join('')}
                </select>
              </div>
              <div class="form-group">
                <label>排序</label>
                <input id="cs-order" type="number" class="form-control" value="${c ? c.sort_order : nextOrder}">
              </div>
            </div>

            <div class="form-group" id="cs-file-wrap">
              <label>课件文件</label>
              <input id="cs-file" type="file" class="form-control"
                accept="${c && c.course_type === 'video' ? 'video/*' : (c && c.course_type === 'image' ? 'image/*' : '.pdf,.ppt,.pptx,.doc,.docx')}">
              ${c && c.file_path ? `<p class="text-muted" style="font-size:12px;margin-top:4px">已上传：${Utils.escapeHtml(c.file_path.split('/').pop())}（不重选则保持不变）</p>` : ''}
            </div>

            <div class="form-group" id="cs-url-wrap" style="display:none">
              <label>外链地址</label>
              <input id="cs-url" class="form-control" placeholder="https://..."
                value="${Utils.escapeHtml(c ? (c.file_url || '') : '')}">
            </div>

            <div class="form-group" id="cs-content-wrap" style="display:none">
              <label>图文正文</label>
              <textarea id="cs-content" class="form-control" rows="6">${Utils.escapeHtml(c ? (c.content || '') : '')}</textarea>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label>PDF 页数（选填，用于计算进度）</label>
                <input id="cs-pages" type="number" class="form-control" value="${c && c.page_count != null ? c.page_count : ''}">
              </div>
              <div class="form-group">
                <label>视频秒数（选填，用于计算进度）</label>
                <input id="cs-duration" type="number" class="form-control" value="${c && c.duration_sec != null ? c.duration_sec : ''}">
              </div>
            </div>

            <div class="form-group" style="display:flex;align-items:center;gap:8px">
              <input id="cs-required" type="checkbox" ${!c || c.required ? 'checked' : ''}>
              <label for="cs-required" style="margin:0">必修课件（计入完成条件）</label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingCourses.renderModal()">返回列表</button>
            <button class="btn btn-primary" onclick="TrainingCourses.submit('${c ? c.id : ''}')">保存</button>
          </div>
        </div>
      </div>
    `;
    this.onTypeChange();
  },

  onTypeChange() {
    const t = document.getElementById('cs-type').value;
    const show = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.style.display = on ? '' : 'none';
    };
    show('cs-file-wrap', t === 'pdf' || t === 'video' || t === 'image');
    show('cs-url-wrap', t === 'link');
    show('cs-content-wrap', t === 'text');
  },

  async submit(id) {
    const type = document.getElementById('cs-type').value;
    const payload = {
      plan_id: this.state.planId,
      title: document.getElementById('cs-title').value.trim(),
      course_type: type,
      sort_order: parseInt(document.getElementById('cs-order').value, 10) || 0,
      required: document.getElementById('cs-required').checked,
      file_url: type === 'link' ? (document.getElementById('cs-url').value.trim() || null) : null,
      content: type === 'text' ? (document.getElementById('cs-content').value.trim() || null) : null,
      page_count: document.getElementById('cs-pages').value
        ? parseInt(document.getElementById('cs-pages').value, 10) : null,
      duration_sec: document.getElementById('cs-duration').value
        ? parseInt(document.getElementById('cs-duration').value, 10) : null,
    };
    if (!payload.title) { alert('请填写课件名称'); return; }
    if (type === 'link' && !payload.file_url) { alert('请填写外链地址'); return; }

    // 上传文件
    const fileInput = document.getElementById('cs-file');
    if ((type === 'pdf' || type === 'video' || type === 'image')
        && fileInput && fileInput.files.length) {
      const file = fileInput.files[0];
      // Storage key 白名单不含中文等非 ASCII 字符（否则报 Invalid key），
      // key 一律用 时间戳_随机串.后缀，原文件名展示走 title 字段（与证照模块同模式）
      const ext = (file.name.match(/\.([A-Za-z0-9]{1,8})$/) || [null, 'bin'])[1].toLowerCase();
      const path = `${this.state.planId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await sb.storage.from(this.BUCKET).upload(path, file, {
        cacheControl: '3600',
        upsert: false,
      });
      if (upErr) { alert('文件上传失败：' + upErr.message); return; }
      payload.file_path = path;
    }

    let error;
    if (id) {
      ({ error } = await sb.from('training_courses').update(payload).eq('id', id));
    } else {
      ({ error } = await sb.from('training_courses').insert(payload));
    }
    if (error) { alert('保存失败：' + error.message); return; }

    await this.load();
    this.renderModal();
    if (Utils.toast) Utils.toast('课件已保存');
  },

  async remove(id) {
    const c = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除课件「${c ? c.title : ''}」？已学过的进度会一并清除。`)) return;
    const { error } = await sb.from('training_courses').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    this.renderModal();
    if (Utils.toast) Utils.toast('已删除');
  },
};

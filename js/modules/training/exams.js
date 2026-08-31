// =============================================================
// js/modules/training/exams.js —— 考试登记
// v1：只登记成绩（考试名称/日期/参考人数/合格人数/合格线），合格率前端计算
//     v2 再升级为在线答题（题库 + 组卷 + 自动判分）
// =============================================================
const TrainingExams = {

  state: {
    list: [],
    filters: { year: String(new Date().getFullYear()), dept: '' },
  },

  async render(box) {
    const years = Utils.getYearOptions ? Utils.getYearOptions() : [new Date().getFullYear()];
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>年度：</label>
          <select id="exam-filter-year" onchange="TrainingExams.onFilterChange()">
            <option value="">全部</option>
            ${years.map(y => `<option value="${y}"${String(y) === this.state.filters.year ? ' selected' : ''}>${y}年</option>`).join('')}
          </select>
          <label>部门：</label>
          <select id="exam-filter-dept" onchange="TrainingExams.onFilterChange()">
            ${TrainingModule.deptOptions(this.state.filters.dept, true)}
          </select>
        </div>
        <div class="toolbar-right">
          ${TrainingModule.canEdit() ? '<button class="btn btn-primary btn-sm" onclick="TrainingExams.openForm()">+ 登记考试</button>' : ''}
        </div>
      </div>
      <div id="exam-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.year = document.getElementById('exam-filter-year').value;
    this.state.filters.dept = document.getElementById('exam-filter-dept').value;
    this.renderTable();
  },

  async load() {
    const { data, error } = await sb.from('training_exams')
      .select('id, record_id, exam_name, exam_date, department_id, participant_count, pass_count, pass_line, remark, training_records(title)')
      .order('exam_date', { ascending: false });
    if (error) throw error;
    this.state.list = data || [];
    this.renderTable();
  },

  filtered() {
    const { year, dept } = this.state.filters;
    return this.state.list.filter(x => {
      if (year && !(x.exam_date || '').startsWith(String(year))) return false;
      if (dept && x.department_id !== dept) return false;
      return true;
    });
  },

  rate(x) {
    if (!x.participant_count) return 0;
    return x.pass_count / x.participant_count * 100;
  },

  renderTable() {
    const box = document.getElementById('exam-table');
    if (!box) return;
    const rows = this.filtered();
    const canEdit = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>考试登记（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:110px">考试日期</th>
                <th>考试名称</th>
                <th style="width:180px">关联培训</th>
                <th style="width:130px">部门</th>
                <th style="width:90px">参考人数</th>
                <th style="width:90px">合格人数</th>
                <th style="width:90px">合格线</th>
                <th style="width:100px">合格率</th>
                ${canEdit ? '<th style="width:120px">操作</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(canEdit ? 9 : 8,
                    '暂无考试记录。考试由「培训计划 → 执行 → 上报完成」自动生成（上报时勾选「本次组织了考试」），也可点右上角「+ 登记考试」手工补录。')
                : rows.map(x => {
                    const r = this.rate(x);
                    const cls = r >= 80 ? '#22c55e' : (r >= 60 ? '#f59e0b' : '#ef4444');
                    return `
                    <tr>
                      <td>${Utils.escapeHtml(x.exam_date || '')}</td>
                      <td title="${Utils.escapeHtml(x.exam_name)}">${Utils.escapeHtml(x.exam_name)}</td>
                      <td>${Utils.escapeHtml(x.training_records ? x.training_records.title : '—')}</td>
                      <td>${Utils.escapeHtml(TrainingModule.deptName(x.department_id))}</td>
                      <td>${x.participant_count || 0}</td>
                      <td>${x.pass_count || 0}</td>
                      <td>${x.pass_line != null ? x.pass_line : '—'}</td>
                      <td style="color:${cls};font-weight:600">${r.toFixed(1)}%</td>
                      ${canEdit ? `<td>
                        <button class="btn btn-sm btn-secondary" onclick="TrainingExams.openForm('${x.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingExams.remove('${x.id}')">删除</button>
                      </td>` : ''}
                    </tr>`;
                  }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  openForm(id) {
    const x = id ? this.state.list.find(v => v.id === id) : null;
    const myDept = (Auth.currentProfile || {}).department_id || '';

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingExams.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>${x ? '编辑考试登记' : '登记考试'}</h3>
            <button class="modal-close" onclick="TrainingExams.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>考试名称 <span class="required">*</span></label>
              <input id="exam-name" class="form-control" value="${Utils.escapeHtml(x ? x.exam_name : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>考试日期 <span class="required">*</span></label>
                <input id="exam-date" type="date" class="form-control" value="${x ? x.exam_date : new Date().toISOString().slice(0, 10)}">
              </div>
              <div class="form-group">
                <label>所属部门</label>
                <select id="exam-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(x ? x.department_id : myDept, false)}
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>关联培训记录</label>
              <select id="exam-record" class="form-control">
                <option value="">不关联</option>
                ${(TrainingRecords.state.list || []).map(r =>
                  `<option value="${r.id}"${x && x.record_id === r.id ? ' selected' : ''}>${Utils.escapeHtml(r.train_date || '')} ${Utils.escapeHtml(r.title)}</option>`).join('')}
              </select>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>参考人数</label>
                <input id="exam-participants" type="number" class="form-control" value="${x ? x.participant_count : 0}">
              </div>
              <div class="form-group">
                <label>合格人数</label>
                <input id="exam-pass" type="number" class="form-control" value="${x ? x.pass_count : 0}">
              </div>
            </div>
            <div class="form-group">
              <label>合格线</label>
              <input id="exam-line" type="number" step="0.5" class="form-control" value="${x && x.pass_line != null ? x.pass_line : 60}">
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea id="exam-remark" class="form-control" rows="2">${Utils.escapeHtml(x ? (x.remark || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingExams.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingExams.submit('${x ? x.id : ''}')">保存</button>
          </div>
        </div>
      </div>
    `;
  },

  closeForm() {
    const d = document.getElementById('training-modal-host');
    if (d) d.innerHTML = '';
  },

  async submit(id) {
    const payload = {
      exam_name: document.getElementById('exam-name').value.trim(),
      exam_date: document.getElementById('exam-date').value,
      department_id: document.getElementById('exam-dept').value || null,
      record_id: document.getElementById('exam-record').value || null,
      participant_count: parseInt(document.getElementById('exam-participants').value, 10) || 0,
      pass_count: parseInt(document.getElementById('exam-pass').value, 10) || 0,
      pass_line: document.getElementById('exam-line').value ? parseFloat(document.getElementById('exam-line').value) : 60,
      remark: document.getElementById('exam-remark').value.trim() || null,
    };
    if (!payload.exam_name || !payload.exam_date) { alert('请填写考试名称与日期'); return; }
    if (payload.pass_count > payload.participant_count) { alert('合格人数不能大于参考人数'); return; }

    let error;
    if (id) {
      ({ error } = await sb.from('training_exams').update(payload).eq('id', id));
    } else {
      payload.created_by = Auth.currentUser ? Auth.currentUser.id : null;
      ({ error } = await sb.from('training_exams').insert(payload));
    }
    if (error) { alert('保存失败：' + error.message); return; }
    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(id ? '已保存' : '已登记');
  },

  async remove(id) {
    const x = this.state.list.find(v => v.id === id);
    if (!confirm(`确定删除考试登记「${x ? x.exam_name : ''}」？`)) return;
    const { error } = await sb.from('training_exams').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },
};

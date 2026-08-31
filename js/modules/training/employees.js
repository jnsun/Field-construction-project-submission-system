// =============================================================
// js/modules/training/employees.js —— 员工档案（一人一档）
// v1：员工本人不登录，由管理员录入与维护
// =============================================================
const TrainingEmployees = {

  state: {
    list: [],
    filters: { dept: '', status: '', keyword: '' },
  },

  async render(box) {
    box.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <label>部门：</label>
          <select id="emp-filter-dept" onchange="TrainingEmployees.onFilterChange()">
            ${TrainingModule.deptOptions(this.state.filters.dept, true)}
          </select>
          <label>状态：</label>
          <select id="emp-filter-status" onchange="TrainingEmployees.onFilterChange()">
            <option value="">全部</option>
            <option value="active"${this.state.filters.status === 'active' ? ' selected' : ''}>在职</option>
            <option value="left"${this.state.filters.status === 'left' ? ' selected' : ''}>离职</option>
          </select>
        </div>
        <div class="toolbar-right">
          <input type="search" id="emp-search" class="toolbar-search" placeholder="搜索姓名/工号/岗位/手机号"
            value="${Utils.escapeHtml(this.state.filters.keyword)}" oninput="TrainingEmployees.onSearch()">
          ${TrainingModule.canEdit() ? `
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.downloadTemplate()">导入模板</button>
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.openImport()">Excel 导入</button>
            <button class="btn btn-secondary btn-sm" onclick="TrainingEmployees.provisionAll()">批量开通账号</button>
            <button class="btn btn-primary btn-sm" onclick="TrainingEmployees.openForm()">+ 新增员工</button>` : ''}
        </div>
      </div>
      <div id="emp-table"></div>
    `;
    await this.load();
  },

  onFilterChange() {
    this.state.filters.dept = document.getElementById('emp-filter-dept').value;
    this.state.filters.status = document.getElementById('emp-filter-status').value;
    this.renderTable();
  },

  onSearch() {
    this.state.filters.keyword = document.getElementById('emp-search').value.trim();
    this.renderTable();
  },

  async load() {
    const { data, error } = await sb
      .from('training_employees')
      .select('id, name, employee_no, department_id, position, id_number, phone, hire_date, emp_type, status, remark, user_id')
      .order('name');
    if (error) throw error;
    this.state.list = data || [];
    this.renderTable();
  },

  filtered() {
    const { dept, status, keyword } = this.state.filters;
    const kw = (keyword || '').toLowerCase();
    return this.state.list.filter(e => {
      if (dept && e.department_id !== dept) return false;
      if (status && e.status !== status) return false;
      if (kw && ![e.name, e.employee_no, e.position, e.phone].join(' ').toLowerCase().includes(kw)) return false;
      return true;
    });
  },

  renderTable() {
    const box = document.getElementById('emp-table');
    if (!box) return;
    const rows = this.filtered();
    const canEdit = TrainingModule.canEdit();

    box.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>员工档案（${rows.length}）</h2></div>
        <div class="card-body" style="padding:0">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:110px">姓名</th>
                <th style="width:100px">工号</th>
                <th style="width:150px">所属部门</th>
                <th style="width:130px">岗位/工种</th>
                <th style="width:150px">身份证号</th>
                <th style="width:120px">手机号</th>
                <th style="width:110px">入职日期</th>
                <th style="width:80px">类型</th>
                <th style="width:70px">状态</th>
                <th style="width:100px">登录账号</th>
                <th style="width:${canEdit ? '240px' : '90px'}">操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0
                ? TrainingModule.emptyRow(canEdit ? 11 : 10, '暂无员工档案，可用上方「Excel 导入」批量建档')
                : rows.map(e => `
                  <tr>
                    <td>${Utils.escapeHtml(e.name)}</td>
                    <td>${Utils.escapeHtml(e.employee_no || '')}</td>
                    <td>${Utils.escapeHtml(TrainingModule.deptName(e.department_id))}</td>
                    <td>${Utils.escapeHtml(e.position || '')}</td>
                    <td>${Utils.escapeHtml(Utils.maskIdNumber ? Utils.maskIdNumber(e.id_number) : (e.id_number || ''))}</td>
                    <td>${Utils.escapeHtml(e.phone || '')}</td>
                    <td>${Utils.escapeHtml(e.hire_date || '')}</td>
                    <td>${this.typeLabel(e.emp_type)}</td>
                    <td>${e.status === 'left'
                        ? '<span class="badge badge-muted">离职</span>'
                        : '<span class="badge badge-success">在职</span>'}</td>
                    <td>${e.user_id
                        ? '<span class="badge badge-success">已开通</span>'
                        : '<span class="badge badge-muted">未开通</span>'}</td>
                    <td>
                      <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openHistory('${e.id}')">培训档案</button>
                      ${canEdit ? `
                        ${e.user_id
                          ? `<button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.provision('${e.id}', true)" title="重置为身份证后6位">重置密码</button>`
                          : `<button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.provision('${e.id}')">开通账号</button>`}
                        <button class="btn btn-sm btn-secondary" onclick="TrainingEmployees.openForm('${e.id}')">编辑</button>
                        <button class="btn btn-sm btn-danger" onclick="TrainingEmployees.remove('${e.id}')">删除</button>` : ''}
                    </td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  typeLabel(t) {
    return { employee: '普通员工', special: '特种作业', manager: '管理人员' }[t] || '普通员工';
  },

  /** 个人培训档案（一人一档）：列出该员工历年培训与成绩 */
  async openHistory(empId) {
    const emp = this.state.list.find(x => x.id === empId);
    if (!emp) return;
    const { data, error } = await sb.rpc('training_employee_history', { p_employee_id: empId });
    if (error) { alert('加载培训档案失败：' + error.message); return; }
    const rows = data || [];

    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:720px">
          <div class="modal-header">
            <h3>个人培训档案 — ${Utils.escapeHtml(emp.name)}</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              ${Utils.escapeHtml(TrainingModule.deptName(emp.department_id))} ｜
              ${Utils.escapeHtml(emp.position || '')} ｜ 累计参训 ${rows.length} 次
            </p>
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:110px">培训日期</th>
                  <th>培训名称</th>
                  <th style="width:70px">学时</th>
                  <th style="width:80px">签到</th>
                  <th style="width:80px">成绩</th>
                  <th style="width:90px">结果</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? TrainingModule.emptyRow(6, '暂无参训记录')
                  : rows.map(r => `
                    <tr>
                      <td>${Utils.escapeHtml(r.train_date || '')}</td>
                      <td>${Utils.escapeHtml(r.title || '')}</td>
                      <td>${r.hours != null ? r.hours : '—'}</td>
                      <td>${r.signed ? '<span class="badge badge-success">已签到</span>' : '<span class="badge badge-muted">未签到</span>'}</td>
                      <td>${r.score != null ? r.score : '—'}</td>
                      <td>${TrainingRecords.resultBadge(r.result)}</td>
                    </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">关闭</button>
          </div>
        </div>
      </div>
    `;
  },

  // ---------------------------------------------------------------- 表单
  host() {
    return document.getElementById('training-modal-host') || (() => {
      const h = document.createElement('div');
      h.id = 'training-modal-host';
      document.body.appendChild(h);
      return h;
    })();
  },

  openForm(id) {
    const e = id ? this.state.list.find(x => x.id === id) : null;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:560px">
          <div class="modal-header">
            <h3>${e ? '编辑员工' : '新增员工'}</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>姓名 <span class="required">*</span></label>
              <input id="emp-name" class="form-control" value="${Utils.escapeHtml(e ? e.name : '')}">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>工号</label>
                <input id="emp-no" class="form-control" value="${Utils.escapeHtml(e ? (e.employee_no || '') : '')}">
              </div>
              <div class="form-group">
                <label>所属部门</label>
                <select id="emp-dept" class="form-control">
                  <option value="">未指定</option>
                  ${TrainingModule.deptOptions(e ? e.department_id : '', false)}
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>岗位/工种</label>
                <input id="emp-position" class="form-control" value="${Utils.escapeHtml(e ? (e.position || '') : '')}">
              </div>
              <div class="form-group">
                <label>人员类型</label>
                <select id="emp-type" class="form-control">
                  <option value="employee"${e && e.emp_type === 'employee' ? ' selected' : ''}>普通员工</option>
                  <option value="special"${e && e.emp_type === 'special' ? ' selected' : ''}>特种作业</option>
                  <option value="manager"${e && e.emp_type === 'manager' ? ' selected' : ''}>管理人员</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>身份证号</label>
                <input id="emp-idnumber" class="form-control" value="${Utils.escapeHtml(e ? (e.id_number || '') : '')}">
              </div>
              <div class="form-group">
                <label>手机号</label>
                <input id="emp-phone" class="form-control" value="${Utils.escapeHtml(e ? (e.phone || '') : '')}">
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>入职日期</label>
                <input id="emp-hire" type="date" class="form-control" value="${e ? (e.hire_date || '') : ''}">
              </div>
              <div class="form-group">
                <label>状态</label>
                <select id="emp-status" class="form-control">
                  <option value="active"${e && e.status === 'active' ? ' selected' : ''}>在职</option>
                  <option value="left"${e && e.status === 'left' ? ' selected' : ''}>离职</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea id="emp-remark" class="form-control" rows="2">${Utils.escapeHtml(e ? (e.remark || '') : '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingEmployees.submit('${e ? e.id : ''}')">保存</button>
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
      name: document.getElementById('emp-name').value.trim(),
      employee_no: document.getElementById('emp-no').value.trim() || null,
      department_id: document.getElementById('emp-dept').value || null,
      position: document.getElementById('emp-position').value.trim() || null,
      emp_type: document.getElementById('emp-type').value,
      id_number: document.getElementById('emp-idnumber').value.trim() || null,
      phone: document.getElementById('emp-phone').value.trim() || null,
      hire_date: document.getElementById('emp-hire').value || null,
      status: document.getElementById('emp-status').value,
      remark: document.getElementById('emp-remark').value.trim() || null,
    };
    if (!payload.name) { alert('请填写姓名'); return; }

    let error;
    if (id) {
      ({ error } = await sb.from('training_employees').update(payload).eq('id', id));
    } else {
      payload.created_by = Auth.currentUser ? Auth.currentUser.id : null;
      ({ error } = await sb.from('training_employees').insert(payload));
    }
    if (error) { alert('保存失败：' + error.message); return; }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(id ? '已保存' : '已新增');
  },

  async remove(id) {
    const e = this.state.list.find(x => x.id === id);
    if (!confirm(`确定删除员工「${e ? e.name : ''}」？该员工的参训记录会保留姓名快照，不受影响。`)) return;
    const { error } = await sb.from('training_employees').delete().eq('id', id);
    if (error) { alert('删除失败：' + error.message); return; }
    await this.load();
    if (Utils.toast) Utils.toast('已删除');
  },

  // ------------------------------------------------------------ 账号开通
  /** 开通 / 重置员工登录账号（登录名=手机号，初始密码=身份证后6位） */
  async provision(id, isReset) {
    const e = this.state.list.find(x => x.id === id);
    if (!e) return;
    if (isReset && !confirm(`确定把「${e.name}」的密码重置为身份证后 6 位？`)) return;

    const { data, error } = await sb.rpc('training_staff_reset', { p_employee_id: id });
    if (error) { alert('操作失败：' + (error.message || '')); return; }

    await this.load();
    alert(`已${isReset ? '重置' : '开通'}：\n登录名（手机号）：${e.phone}\n初始密码：身份证后 6 位`);
    if (Utils.toast) Utils.toast(isReset ? '密码已重置' : '账号已开通');
  },

  /** 批量为所有在职员工开通账号 */
  async provisionAll() {
    const todo = this.state.list.filter(e => e.status === 'active' && !e.user_id);
    if (!todo.length) { alert('在职员工都已开通账号，无需重复操作。'); return; }
    if (!confirm(`将为 ${todo.length} 名在职员工开通登录账号（登录名=手机号，初始密码=身份证后6位）。\n缺少手机号或身份证号的员工会被跳过。\n\n确定继续？`)) return;

    let ok = 0;
    const failed = [];
    for (const e of todo) {
      const { error } = await sb.rpc('training_staff_reset', { p_employee_id: e.id });
      if (error) failed.push(`${e.name}：${error.message}`);
      else ok += 1;
    }
    await this.load();

    let msg = `成功开通 ${ok} 个账号。`;
    if (failed.length) msg += `\n\n以下 ${failed.length} 个失败（多半是缺手机号或身份证号）：\n` + failed.slice(0, 10).join('\n');
    alert(msg);
  },

  // ------------------------------------------------------------ Excel 导入
  HEADERS: ['姓名*', '工号', '所属部门', '岗位/工种', '身份证号', '手机号', '入职日期', '人员类型', '状态', '备注'],

  downloadTemplate() {
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请刷新页面重试'); return; }
    const sample = [['张三', 'GY001', '工程物探所', '物探工程师', '110101199001011234', '13800138000', '2024-01-15', '普通员工', '在职', '']];
    const ws = XLSX.utils.aoa_to_sheet([this.HEADERS, ...sample]);
    ws['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];

    const help = XLSX.utils.aoa_to_sheet([
      ['填写说明'],
      [''],
      ['1. 姓名必填；带 * 的为必填列'],
      ['2. 所属部门要和系统里的部门名称完全一致，填错或留空会归为「未指定」'],
      ['3. 身份证号与手机号用于员工登录：登录名=手机号，初始密码=身份证后6位'],
      ['4. 身份证号 / 手机号必须唯一，重复的整行会被跳过'],
      ['5. 入职日期格式 YYYY-MM-DD，例如 2024-01-15'],
      ['6. 人员类型：普通员工 / 特种作业 / 管理人员（留空按普通员工）'],
      ['7. 状态：在职 / 离职（留空按在职）'],
      ['8. 第一行是表头，请勿删除；不要修改列名'],
    ]);
    help['!cols'] = [{ wch: 60 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '员工导入');
    XLSX.utils.book_append_sheet(wb, help, '填写说明');
    XLSX.writeFile(wb, `员工档案批量导入模板_${Utils.formatDate(new Date())}.xlsx`);
  },

  openImport() {
    this.state.importRows = null;
    this.host().innerHTML = `
      <div class="modal-overlay" onclick="TrainingEmployees.closeForm()">
        <div class="modal" onclick="event.stopPropagation()" style="max-width:640px">
          <div class="modal-header">
            <h3>Excel 批量导入员工</h3>
            <button class="modal-close" onclick="TrainingEmployees.closeForm()">×</button>
          </div>
          <div class="modal-body">
            <p class="text-muted" style="margin-bottom:8px">
              先点「导入模板」下载表格，按说明填好后在这里选择文件。
              身份证号与手机号用于员工登录，请务必填写准确。
            </p>
            <div class="form-group">
              <input type="file" id="emp-file" accept=".xlsx,.xls" class="form-control">
            </div>
            <div id="emp-import-preview"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="TrainingEmployees.closeForm()">取消</button>
            <button class="btn btn-primary" onclick="TrainingEmployees.parseFile()">解析文件</button>
          </div>
        </div>
      </div>
    `;
  },

  async parseFile() {
    const input = document.getElementById('emp-file');
    if (!input || !input.files.length) { alert('请先选择 Excel 文件'); return; }
    if (typeof XLSX === 'undefined') { alert('Excel 组件未加载，请刷新页面重试'); return; }

    const buf = await input.files[0].arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    if (rows.length < 2) { alert('表格里没有数据行'); return; }

    const deptByName = {};
    TrainingModule.state.depts.forEach(d => { deptByName[(d.name || '').trim()] = d.id; });

    const seenPhone = {};
    const seenIdNo = {};
    this.state.list.forEach(e => {
      if (e.phone) seenPhone[String(e.phone).trim()] = true;
      if (e.id_number) seenIdNo[String(e.id_number).trim()] = true;
    });

    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = String(r[0] == null ? '' : r[0]).trim();
      if (!name) continue;

      const phone = String(r[5] == null ? '' : r[5]).trim();
      const idNo = String(r[4] == null ? '' : r[4]).trim();
      const deptName = String(r[2] == null ? '' : r[2]).trim();
      const errors = [];

      if (phone && seenPhone[phone]) errors.push('手机号重复');
      if (idNo && seenIdNo[idNo]) errors.push('身份证号重复');
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) errors.push('手机号格式不对');
      if (idNo && idNo.length < 15) errors.push('身份证号太短');
      if (deptName && !deptByName[deptName]) errors.push('部门名称不匹配');

      if (phone) seenPhone[phone] = true;
      if (idNo) seenIdNo[idNo] = true;

      parsed.push({
        name,
        employee_no: String(r[1] == null ? '' : r[1]).trim() || null,
        department_id: deptByName[deptName] || null,
        dept_raw: deptName,
        position: String(r[3] == null ? '' : r[3]).trim() || null,
        id_number: idNo || null,
        phone: phone || null,
        hire_date: this.toDateStr(r[6]),
        emp_type: { 特种作业: 'special', 管理人员: 'manager' }[String(r[7] == null ? '' : r[7]).trim()] || 'employee',
        status: String(r[8] == null ? '' : r[8]).trim() === '离职' ? 'left' : 'active',
        remark: String(r[9] == null ? '' : r[9]).trim() || null,
        errors,
      });
    }

    this.state.importRows = parsed;
    this.renderImportPreview();
  },

  toDateStr(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const s = String(v).trim().replace(/\//g, '-');
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return null;
  },

  renderImportPreview() {
    const rows = this.state.importRows || [];
    const bad = rows.filter(r => r.errors.length);
    const good = rows.filter(r => !r.errors.length);
    const box = document.getElementById('emp-import-preview');
    if (!box) return;

    box.innerHTML = `
      <p style="margin:8px 0">
        共解析 ${rows.length} 行：
        <b style="color:#22c55e">可导入 ${good.length}</b>
        ${bad.length ? `｜<b style="color:#ef4444">有问题的 ${bad.length}</b>` : ''}
      </p>
      ${rows.length ? `
      <div style="max-height:280px;overflow:auto;border:1px solid #e5e7eb;border-radius:6px">
        <table class="data-table">
          <thead><tr>
            <th style="width:90px">姓名</th><th style="width:130px">部门</th>
            <th style="width:120px">手机号</th><th>校验结果</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${Utils.escapeHtml(r.name)}</td>
                <td>${Utils.escapeHtml(r.dept_raw || '未指定')}</td>
                <td>${Utils.escapeHtml(r.phone || '')}</td>
                <td style="color:${r.errors.length ? '#ef4444' : '#22c55e'}">
                  ${r.errors.length ? Utils.escapeHtml(r.errors.join('；')) : '通过'}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
      ${good.length ? `
      <div class="modal-footer" style="padding:12px 0 0;border:none">
        <button class="btn btn-primary" onclick="TrainingEmployees.saveImport()">确认导入 ${good.length} 条</button>
      </div>` : ''}
    `;
  },

  async saveImport() {
    const rows = (this.state.importRows || []).filter(r => !r.errors.length);
    if (!rows.length) return;

    const payload = rows.map(r => ({
      name: r.name,
      employee_no: r.employee_no,
      department_id: r.department_id,
      position: r.position,
      id_number: r.id_number,
      phone: r.phone,
      hire_date: r.hire_date,
      emp_type: r.emp_type,
      status: r.status,
      remark: r.remark,
      created_by: Auth.currentUser ? Auth.currentUser.id : null,
    }));

    const { error } = await sb.from('training_employees').insert(payload);
    if (error) { alert('导入失败：' + error.message); return; }

    this.closeForm();
    await this.load();
    if (Utils.toast) Utils.toast(`已导入 ${payload.length} 名员工`);
    alert(`已导入 ${payload.length} 名员工。\n\n记得点「批量开通账号」，员工才能登录参加在线培训。`);
  },
};

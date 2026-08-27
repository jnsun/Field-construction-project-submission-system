/**
 * import.js - 证照批量导入模块（仅管理员）
 * 通过 Excel（.xlsx / .xls）批量登记公司证照与个人证照：
 *   下载模板 -> 选择文件 -> 自动逐行校验预览 -> 分块写入 -> 结果报告
 *
 * 依赖：
 *   - SheetJS  vendor/xlsx.full.min.js（本地引入，全局 XLSX）
 *   - sb / Utils / Auth（config.js / utils.js / auth.js）
 *   - CertAdmin（admin.js 的 state.companies / state.types / DEFAULT_CERT_TYPES）
 *
 * 权限：写入走 certificates 的 INSERT，RLS 已限定仅管理员（v3 权限模型），
 *       入口按钮也只出现在管理员视图，公司账号（只读）不可见。
 *
 * 导入策略：
 *   - 客户端先做全量校验（公司 / 大类 / 类型 / 子分类 / 日期 / 持证人 / 文件内重复），
 *     只有校验通过的行才会写入
 *   - 宽松校验：仅「所属公司 / 证照大类 / 证照类型 / 证照名称」（个人证照另需持证人）必填，
 *     证照编号、有效期、日期等可留空，导入后在证照详情中编辑补全（发证日期留空自动取有效期起）
 *   - 按批（20 行/请求）插入；某批整体失败时回退为逐行插入，精确定位问题行
 *   - 导入的证照状态一律为「在用」（active），附件需导入后在详情中单独上传
 */

const CertImport = {

  MAX_ROWS: 1000,          // 单次导入行数上限
  CHUNK_SIZE: 20,          // 每批插入行数（PostgREST 单请求）
  IMPORT_MODAL_ID: 'cert-import-modal',

  /** 模板数据表列名（顺序即模板列顺序；校验按列名匹配，不依赖顺序） */
  HEADERS: [
    '所属公司', '证照大类', '证照类型', '子分类1', '子分类2',
    '证照名称', '证照编号', '发证机关', '发证日期', '有效期起', '有效期止',
    '是否长期有效', '持证人', '证件号', '职务/岗位', '备注',
  ],

  /** 必须存在的列（缺失时整个文件无法校验） */
  REQUIRED_HEADERS: ['所属公司', '证照大类', '证照类型', '证照名称', '证照编号'],

  state: {
    phase: 'choose',       // choose | preview | importing | result
    fileName: '',
    rows: [],              // [{ rowNo, data, disp, errors }]
    result: null,          // { total, attempted, ok, failed, skipped }
    importing: false,
    unknownHeaders: [],    // Excel 中未被识别的表头列（不会导入，预览阶段提醒）
  },

  // ========================================================================
  // 弹窗骨架与阶段渲染
  // ========================================================================

  /**
   * 打开批量导入弹窗（入口仅管理员视图可见）
   */
  openModal() {
    if (typeof XLSX === 'undefined') {
      Utils.toast('Excel 组件未加载（vendor/xlsx.full.min.js 缺失），请刷新页面重试', 'error');
      return;
    }
    if (!Auth.currentUser) {
      Utils.toast('登录信息失效，请重新登录', 'error');
      return;
    }
    if (!(CertAdmin.state.companies || []).length) {
      Utils.toast('公司列表尚未加载完成，请稍后重试', 'error');
      return;
    }

    const existing = document.getElementById(this.IMPORT_MODAL_ID);
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="${this.IMPORT_MODAL_ID}" onclick="CertImport.onOverlayClick(event)">
        <div class="modal-card modal-lg">
          <div class="modal-header">
            <h2>批量导入证照（Excel）</h2>
            <button class="modal-close" onclick="CertImport.closeModal()">&times;</button>
          </div>
          <!-- 文件选择 input 常驻卡片（body 各阶段重渲染不影响它） -->
          <input type="file" id="cert-import-file-input" accept=".xlsx,.xls"
                 style="display:none;" onchange="CertImport.onFileSelected(event)">
          <div class="modal-body" id="cert-import-body"></div>
          <div class="modal-footer" id="cert-import-footer"></div>
        </div>
      </div>
    `);

    this.state.phase = 'choose';
    this.state.fileName = '';
    this.state.rows = [];
    this.state.result = null;
    this.renderModal();
  },

  /**
   * 按当前阶段渲染弹窗主体与底部按钮
   */
  renderModal() {
    const body = document.getElementById('cert-import-body');
    const footer = document.getElementById('cert-import-footer');
    if (!body || !footer) return;

    if (this.state.phase === 'choose') {
      body.innerHTML = this.buildChooseBody();
      footer.innerHTML = `<button class="btn btn-secondary" onclick="CertImport.closeModal()">关闭</button>`;

    } else if (this.state.phase === 'preview') {
      body.innerHTML = this.buildPreviewBody();
      const validCount = this.state.rows.filter(r => r.errors.length === 0).length;
      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="document.getElementById('cert-import-file-input').click()">重新选择文件</button>
        <button class="btn btn-primary" ${validCount === 0 ? 'disabled' : ''}
                onclick="CertImport.startImport()">开始导入（${validCount} 条）</button>
      `;

    } else if (this.state.phase === 'importing') {
      const total = this.state.rows.filter(r => r.errors.length === 0).length;
      body.innerHTML = `
        <div class="import-progress">
          <div class="import-progress-fill" id="import-progress-fill"></div>
        </div>
        <p class="import-progress-text" id="import-progress-text">正在导入 0 / ${total} ...</p>
      `;
      footer.innerHTML = '';

    } else if (this.state.phase === 'result') {
      body.innerHTML = this.buildResultBody();
      footer.innerHTML = `
        <button class="btn btn-secondary" onclick="CertImport.openModal()">导入另一个文件</button>
        <button class="btn btn-primary" onclick="CertImport.closeModal()">完成</button>
      `;
    }
  },

  /**
   * 阶段一：说明 + 下载模板 / 选择文件
   */
  buildChooseBody() {
    const companies = (CertAdmin.state.companies || []).map(c => c.name).join(' / ');
    return `
      <div class="import-steps">
        <div class="import-step"><span class="import-step-num">1</span><div>下载导入模板（Excel），按模板列名逐行填写证照信息</div></div>
        <div class="import-step"><span class="import-step-num">2</span><div>选择填写好的文件，系统自动逐行校验并给出预览</div></div>
        <div class="import-step"><span class="import-step-num">3</span><div>确认无误后开始导入，仅校验通过的行会写入系统</div></div>
      </div>
      <div class="alert alert-info">
        支持公司证照与个人证照混排导入。所属公司：${Utils.escapeHtml(companies)}；
        证照类型须与系统「证照类型」字典一致（模板说明页含完整清单）。
        必填仅「所属公司 / 证照大类 / 证照类型 / 证照名称」（个人证照另需持证人），
        证照编号、发证日期、有效期等均可留空，导入后在证照详情中编辑补全（发证日期留空时自动取「有效期起」）。
        单次最多 ${this.MAX_ROWS} 行；导入的证照状态均为「在用」，附件（扫描件）需导入后在详情中单独上传。
      </div>
      <div class="import-actions">
        <button class="btn btn-secondary" onclick="CertImport.downloadTemplate()">⬇ 下载导入模板</button>
        <button class="btn btn-primary" onclick="document.getElementById('cert-import-file-input').click()">选择 Excel 文件</button>
      </div>
    `;
  },

  /**
   * 阶段二：校验结果预览
   */
  buildPreviewBody() {
    const rows = this.state.rows;
    const validCount = rows.filter(r => r.errors.length === 0).length;
    const errorCount = rows.length - validCount;

    const trs = rows.map(r => {
      const ok = r.errors.length === 0;
      const esc = Utils.escapeHtml;
      return `
        <tr class="${ok ? '' : 'import-row-error'}">
          <td>${r.rowNo}</td>
          <td>${esc(r.disp.company)}</td>
          <td>${esc(r.disp.category)}</td>
          <td>${esc(r.disp.type)}</td>
          <td>${esc(r.disp.sub)}</td>
          <td>${esc(r.disp.name)}</td>
          <td>${esc(r.disp.holder)}</td>
          <td>${esc(r.disp.until)}</td>
          <td>${ok
            ? '<span class="badge badge-success">可导入</span>'
            : `<span class="import-err-text">${r.errors.map(e => Utils.escapeHtml(e)).join('；')}</span>`}
          </td>
        </tr>
      `;
    }).join('');

    const unknown = this.state.unknownHeaders || [];
    return `
      ${unknown.length ? `
        <div class="alert alert-warning" style="margin-bottom:10px;">
          以下表头列未被系统识别，<strong>不会导入</strong>：${unknown.map(Utils.escapeHtml).join('、')}
          （如需导入请改用模板列名；「备注」列填写时请保证表头为「备注」或包含「备注」二字）
        </div>
      ` : ''}
      <div class="import-file-name">📄 ${Utils.escapeHtml(this.state.fileName)}</div>
      <p style="margin-top:8px;font-size:0.875rem;">
        共读取 <strong>${rows.length}</strong> 行：
        <span class="badge badge-success">可导入 ${validCount} 行</span>
        ${errorCount ? `<span class="badge badge-danger">有错误 ${errorCount} 行（不会导入）</span>` : ''}
      </p>
      <div class="import-preview-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>行号</th><th>公司</th><th>大类</th><th>类型</th><th>子分类</th>
              <th>证照名称</th><th>持证人</th><th>有效期止</th><th>校验结果</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
      <p class="toolbar-hint" style="margin-top:10px;">
        行号为 Excel 中的实际行号，便于对照修改；修正后重新选择文件即可。
      </p>
    `;
  },

  /**
   * 阶段四：导入结果报告
   */
  buildResultBody() {
    const res = this.state.result || { total: 0, attempted: 0, ok: 0, failed: [], skipped: 0 };
    const failRows = (res.failed || []).map(f => `
      <tr>
        <td>${f.rowNo}</td>
        <td>${Utils.escapeHtml(f.name || '')}</td>
        <td><span class="import-err-text">${Utils.escapeHtml(f.reason)}</span></td>
      </tr>
    `).join('');

    return `
      <div class="import-result-grid">
        <div class="import-result-item import-result-ok">
          <div class="num">${res.ok}</div>
          <div class="lbl">导入成功</div>
        </div>
        <div class="import-result-item import-result-fail">
          <div class="num">${(res.failed || []).length}</div>
          <div class="lbl">写入失败</div>
        </div>
        <div class="import-result-item import-result-skip">
          <div class="num">${res.skipped || 0}</div>
          <div class="lbl">校验未通过（已跳过）</div>
        </div>
      </div>
      ${(res.failed || []).length ? `
        <div class="detail-section">
          <h3>失败明细</h3>
          <div class="import-preview-wrap" style="max-height:220px;">
            <table class="data-table">
              <thead><tr><th>行号</th><th>证照名称</th><th>失败原因</th></tr></thead>
              <tbody>${failRows}</tbody>
            </table>
          </div>
        </div>
      ` : ''}
      ${res.skipped ? `
        <div class="alert alert-warning" style="margin-top:14px;">
          有 ${res.skipped} 行因校验未通过被跳过（错误原因见导入前的预览），修正后可再次导入。
        </div>
      ` : ''}
    `;
  },

  /**
   * 模态框遮罩点击关闭（导入中禁止关闭）
   */
  onOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') {
      if (this.state.importing) {
        Utils.toast('正在导入中，请等待完成后再关闭', 'info');
        return;
      }
      this.closeModal();
    }
  },

  /**
   * 关闭弹窗并重置状态
   */
  closeModal() {
    if (this.state.importing) {
      Utils.toast('正在导入中，请等待完成后再关闭', 'info');
      return;
    }
    const modal = document.getElementById(this.IMPORT_MODAL_ID);
    if (modal) modal.remove();
    this.state.phase = 'choose';
    this.state.fileName = '';
    this.state.rows = [];
    this.state.result = null;
  },

  // ========================================================================
  // 模板下载（按当前公司 + 类型字典动态生成）
  // ========================================================================

  /**
   * 生成并下载导入模板（数据表 + 填写说明表）
   */
  downloadTemplate() {
    if (typeof XLSX === 'undefined') {
      Utils.toast('Excel 组件未加载，请刷新页面重试', 'error');
      return;
    }
    const types = ((CertAdmin.state.types && CertAdmin.state.types.length)
      ? CertAdmin.state.types
      : CertAdmin.DEFAULT_CERT_TYPES
    ).filter(t => t.is_active !== false);

    // 数据表：仅表头（示例请参考「填写说明」页，避免示例行被误导入）
    const wsData = XLSX.utils.aoa_to_sheet([this.HEADERS]);
    wsData['!cols'] = [
      { wch: 18 }, { wch: 12 }, { wch: 24 }, { wch: 22 }, { wch: 22 },
      { wch: 30 }, { wch: 24 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 14 }, { wch: 26 },
    ];

    // 说明表
    const wsHelp = XLSX.utils.aoa_to_sheet(this.buildHelpSheetRows(types));
    wsHelp['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 46 }, { wch: 46 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsData, '证照导入');
    XLSX.utils.book_append_sheet(wb, wsHelp, '填写说明');
    XLSX.writeFile(wb, `证照批量导入模板_${Utils.formatDate(new Date())}.xlsx`);
    Utils.toast('模板已下载，请按「填写说明」页填写', 'success');
  },

  /**
   * 说明表内容（含当前公司 / 类型字典 / 子分类可选值清单）
   */
  buildHelpSheetRows(types) {
    const companies = (CertAdmin.state.companies || []).map(c => `${c.name}（编码 ${c.code || '—'}）`).join('；');
    const rows = [
      ['证照批量导入模板 · 填写说明'],
      [],
      ['一、使用步骤'],
      ['1. 在「证照导入」工作表按第一行列名逐行填写，一行一条证照，请勿修改表头行'],
      ['2. 保存文件后回到系统，点击「选择 Excel 文件」上传'],
      ['3. 系统自动逐行校验并展示预览（可导入 / 错误原因）'],
      ['4. 点击「开始导入」，仅校验通过的行会写入系统'],
      [],
      ['二、必填列（仅以下 4 项；个人证照另需持证人）'],
      ['所属公司', companies || '（公司列表未加载，请刷新页面后重新下载模板）'],
      ['证照大类', '公司证照 / 个人证照'],
      ['证照类型', '须与系统「证照类型」字典完全一致（见下方清单）'],
      ['证照名称', '证照全称（不超过 100 字）'],
      ['持证人', '证照大类为「个人证照」时必填'],
      [],
      ['三、选填列（留空亦可，导入后在证照详情中编辑补全）'],
      ['证照编号', '证书编号（不超过 100 字）；留空则导入后补填'],
      ['子分类1 / 子分类2', '有子分类维度的类型可填写可选值（见下方清单），留空亦可；该类型无子分类时请留空'],
      ['发证日期', '格式如 2026-08-25 或 2026/8/25；留空时自动取「有效期起」的日期'],
      ['有效期起 / 有效期止', '格式同上；可留空待后期编辑。若两者都填，有效期止不得早于有效期起'],
      ['是否长期有效', '填 是 / 否，留空视为「否」；填「是」时有效期止可不填'],
      ['发证机关 / 证件号 / 职务/岗位 / 备注', '按实际情况填写'],
      [],
      ['四、当前证照类型清单'],
      ['证照类型', '大类', '子分类1', '子分类2'],
    ];

    if (types.length === 0) {
      rows.push(['（类型字典为空，请先在系统「证照类型」页签维护类型）', '', '', '']);
    } else {
      types.forEach(t => {
        const sub1 = t.sub1_label ? `${t.sub1_label}：${(t.sub1_options || []).join(' / ')}` : '—';
        const sub2 = t.sub2_label ? `${t.sub2_label}：${(t.sub2_options || []).join(' / ')}` : '—';
        rows.push([t.name, Utils.categoryLabel(t.category), sub1, sub2]);
      });
    }

    rows.push(
      [],
      ['五、注意事项'],
      ['1. 导入的证照状态一律为「在用」；旧证归档请在导入后于详情中使用「换证」功能'],
      [`2. 单次最多导入 ${this.MAX_ROWS} 行，超出请拆分文件`],
      ['3. 请勿重复导入同一文件，否则会产生重复记录'],
      ['4. 证照扫描件（附件）需导入完成后在证照详情中单独上传'],
      ['5. 模板按当前公司列表与类型字典动态生成，建议每次导入前重新下载'],
      ['6. 子分类（子分类1 / 子分类2）不同的两行，即使其他字段完全一致，也视为不同证照，不会被判重拦截'],
    );
    return rows;
  },

  // ========================================================================
  // 文件解析与逐行校验
  // ========================================================================

  /**
   * 文件选择回调
   */
  async onFileSelected(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = ''; // 清空以保证同名文件可再次触发 onchange
    if (!file) return;

    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      Utils.toast('请选择 .xlsx 或 .xls 格式的 Excel 文件', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      Utils.toast('文件超过 10MB，请确认选择的是正确的导入文件', 'error');
      return;
    }

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('文件中没有工作表');

      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
      this.parseAndValidate(rows, file.name);
    } catch (e) {
      console.error('解析 Excel 失败:', e);
      Utils.toast('文件解析失败：' + (e.message || '无法识别的 Excel 文件'), 'error');
    }
  },

  /**
   * 定位表头行 -> 建立列名映射 -> 逐行校验 -> 进入预览
   * @param {Array<Array>} rows sheet_to_json(header:1) 的二维数组
   * @param {string} fileName
   */
  parseAndValidate(rows, fileName) {
    // 1. 定位表头行（前 10 行内找同时含「所属公司」「证照类型」的行）
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const cells = (rows[i] || []).map(c => String(c == null ? '' : c).trim());
      if (cells.includes('所属公司') && cells.includes('证照类型')) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) {
      Utils.toast('未找到表头行：第一行应包含「所属公司、证照大类、证照类型…」等列名（请使用系统提供的模板）', 'error');
      return;
    }

    // 2. 列名 -> 列号映射
    const colMap = {};
    (rows[headerIdx] || []).forEach((c, idx) => {
      const name = String(c == null ? '' : c).trim();
      if (name && colMap[name] === undefined) colMap[name] = idx;
    });
    // 备注列兼容常见别名（如「备注信息」「备注说明」）：精确未命中时取第一个含「备注」的表头
    if (colMap['备注'] === undefined) {
      (rows[headerIdx] || []).forEach((c, idx) => {
        const name = String(c == null ? '' : c).trim();
        if (name.includes('备注') && colMap['备注'] === undefined) colMap['备注'] = idx;
      });
    }

    // 未被识别的表头列（非模板列名且未被任何映射使用），预览阶段提醒，避免选填列被静默忽略
    const usedIdx = Object.values(colMap);
    this.state.unknownHeaders = (rows[headerIdx] || [])
      .map((c, idx) => String(c == null ? '' : c).trim())
      .filter((name, idx, arr) => name && !this.HEADERS.includes(name) && !usedIdx.includes(idx) && arr.indexOf(name) === idx);

    const missing = this.REQUIRED_HEADERS.filter(h => colMap[h] === undefined);
    if (missing.length) {
      Utils.toast(`缺少必填列：${missing.join('、')}（请勿删除模板表头列）`, 'error');
      return;
    }

    // 3. 数据行（跳过整行为空的行）
    const dataRows = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const empty = r.every(c => c == null || String(c).trim() === '');
      if (!empty) dataRows.push({ rowNo: i + 1, cells: r }); // Excel 实际行号（1 起）
    }

    if (dataRows.length === 0) {
      Utils.toast('未读取到数据行，请检查文件内容', 'error');
      return;
    }
    if (dataRows.length > this.MAX_ROWS) {
      Utils.toast(`数据共 ${dataRows.length} 行，超过单次上限 ${this.MAX_ROWS} 行，请拆分文件后分批导入`, 'error');
      return;
    }

    // 4. 逐行校验（含文件内重复检测）
    const seen = new Map();
    this.state.rows = dataRows.map(r => this.validateRow(r, colMap, seen));
    this.state.fileName = fileName;
    this.state.phase = 'preview';
    this.state.result = null;
    this.renderModal();

    const errorCount = this.state.rows.filter(r => r.errors.length > 0).length;
    if (errorCount === 0) {
      Utils.toast(`校验通过：${this.state.rows.length} 行全部可导入`, 'success');
    }
  },

  /**
   * 单元格取文本（trim）
   */
  cell(cells, colMap, header) {
    const idx = colMap[header];
    if (idx === undefined) return '';
    const v = cells[idx];
    if (v == null) return '';
    return String(v).trim();
  },

  /**
   * 单元格取原始值（日期列专用：可能为 Date / 数字序列 / 文本）
   */
  rawCell(cells, colMap, header) {
    const idx = colMap[header];
    if (idx === undefined) return null;
    const v = cells[idx];
    return (v == null || v === '') ? null : v;
  },

  /**
   * 日期解析：Date 对象 / Excel 序列数字 / 常见文本格式 -> YYYY-MM-DD
   * @returns {{value: string|null, error: boolean}}
   */
  parseDate(v) {
    const pad = (n) => String(n).padStart(2, '0');
    if (v === null || v === undefined || v === '') return { value: null, error: false };
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return { value: null, error: true };
      return { value: `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`, error: false };
    }
    if (typeof v === 'number' && isFinite(v)) {
      if (v >= 10000 && v <= 80000) { // Excel 1900 日期序列（1927 ~ 2119 年）
        const d = new Date(Math.round((v - 25569) * 86400000));
        return { value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, error: false };
      }
      return { value: null, error: true };
    }
    const s = String(v).trim();
    if (!s) return { value: null, error: false };
    const m = s.match(/^(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})\s*日?$/);
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      if (y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        return { value: `${y}-${pad(mo)}-${pad(da)}`, error: false };
      }
    }
    return { value: null, error: true };
  },

  /**
   * 是否长期有效解析：是/否 -> true/false，无法识别 -> null
   */
  parseLongTerm(v) {
    if (v === null || v === undefined || String(v).trim() === '') return false;
    const s = String(v).trim().toLowerCase();
    if (['是', 'y', 'yes', 'true', '1', '长期', '长期有效'].includes(s)) return true;
    if (['否', 'n', 'no', 'false', '0', '无'].includes(s)) return false;
    return null;
  },

  /**
   * 按名称或编码匹配公司
   */
  findCompany(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const list = CertAdmin.state.companies || [];
    let c = list.find(x => x.name === s);
    if (c) return c;
    const lower = s.toLowerCase();
    return list.find(x => String(x.code || '').toLowerCase() === lower) || null;
  },

  /**
   * 大类文本 -> company / personal（兼容公司/个人等简写与旧值）
   */
  resolveCategory(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (['公司证照', '公司', 'company', 'enterprise'].includes(s)) return 'company';
    if (['个人证照', '个人', 'personal', 'person'].includes(s)) return 'personal';
    return null;
  },

  /**
   * 校验单行并生成待插入数据
   * @param {{rowNo:number, cells:Array}} r
   * @param {Object} colMap
   * @param {Map<string, number>} seen 文件内重复检测（key -> 首次出现的行号）
   */
  validateRow(r, colMap, seen) {
    const errors = [];
    const g = (h) => this.cell(r.cells, colMap, h);

    // ---- 公司 ----
    const companyName = g('所属公司');
    const company = this.findCompany(companyName);
    if (!company) {
      const names = (CertAdmin.state.companies || []).map(c => c.name).join(' / ');
      errors.push(`所属公司「${companyName || '空'}」无效（应为：${names}）`);
    }

    // ---- 大类 ----
    const category = this.resolveCategory(g('证照大类'));
    if (!category) errors.push(`证照大类「${g('证照大类') || '空'}」无效（应为：公司证照 / 个人证照）`);

    // ---- 类型 ----
    const typeName = g('证照类型');
    const typeDef = typeName ? CertAdmin.typeDefFor(typeName) : null;
    if (!typeDef) {
      errors.push(`证照类型「${typeName || '空'}」不在类型字典中（可用类型见模板说明页）`);
    } else {
      if (typeDef.is_active === false) errors.push(`证照类型「${typeName}」已停用，请启用后再导入`);
      if (category && typeDef.category !== category) {
        errors.push(`类型「${typeName}」属于「${Utils.categoryLabel(typeDef.category)}」，与所填证照大类不符`);
      }
    }

    // ---- 子分类（有维度时选填，但填写须在可选值内；无维度时须留空） ----
    const sub1 = g('子分类1');
    const sub2 = g('子分类2');
    if (typeDef) {
      if (typeDef.sub1_label) {
        if (sub1 && !(typeDef.sub1_options || []).map(String).includes(sub1)) {
          errors.push(`子分类1「${sub1}」不在「${typeDef.sub1_label}」可选值内（${(typeDef.sub1_options || []).join(' / ')}）`);
        }
      } else if (sub1) {
        errors.push(`类型「${typeName}」没有子分类1维度，该列请留空`);
      }
      if (typeDef.sub2_label) {
        if (sub2 && !(typeDef.sub2_options || []).map(String).includes(sub2)) {
          errors.push(`子分类2「${sub2}」不在「${typeDef.sub2_label}」可选值内（${(typeDef.sub2_options || []).join(' / ')}）`);
        }
      } else if (sub2) {
        errors.push(`类型「${typeName}」没有子分类2维度，该列请留空`);
      }
    }

    // ---- 名称 / 编号 ----
    const certName = g('证照名称');
    if (!certName) errors.push('证照名称未填写');
    else if (certName.length > 100) errors.push('证照名称超过 100 字');
    const certNo = g('证照编号');
    if (certNo.length > 100) errors.push('证照编号超过 100 字');

    // ---- 日期 ----
    const issueDate = this.parseDate(this.rawCell(r.cells, colMap, '发证日期'));
    const validFrom = this.parseDate(this.rawCell(r.cells, colMap, '有效期起'));
    const validUntil = this.parseDate(this.rawCell(r.cells, colMap, '有效期止'));
    if (issueDate.error) errors.push('发证日期格式无法识别（应为 2026-08-25 或 2026/8/25）');
    if (validFrom.error) errors.push('有效期起格式无法识别');
    if (validUntil.error) errors.push('有效期止格式无法识别');

    // ---- 长期有效（有效期可留空待后期编辑；两者都填时校验先后） ----
    const ltRaw = this.rawCell(r.cells, colMap, '是否长期有效');
    const isLong = this.parseLongTerm(ltRaw);
    if (isLong === null) {
      errors.push(`是否长期有效「${g('是否长期有效')}」无法识别（填 是 / 否，或留空）`);
    }
    if (validFrom.value && validUntil.value && validUntil.value < validFrom.value) {
      errors.push('有效期止早于有效期起');
    }

    // ---- 个人证照必填持证人 ----
    const holderName = g('持证人');
    if (category === 'personal' && !holderName) errors.push('个人证照必须填写持证人');

    // ---- 长度限制（与手工表单一致） ----
    if (holderName.length > 50) errors.push('持证人姓名超过 50 字');
    const holderIdNo = g('证件号');
    if (holderIdNo.length > 30) errors.push('证件号超过 30 字');
    const holderPosition = g('职务/岗位');
    if (holderPosition.length > 50) errors.push('职务/岗位超过 50 字');
    const authority = g('发证机关');
    if (authority.length > 100) errors.push('发证机关超过 100 字');
    const remark = g('备注');
    if (remark.length > 500) errors.push('备注超过 500 字');

    // ---- 文件内重复检测（子分类不同视为不同证照，不判重） ----
    const dupKey = [
      company ? company.id : companyName,
      category || g('证照大类'),
      typeName, sub1, sub2, certName, holderName, certNo,
    ].join('¦');
    if (seen.has(dupKey)) {
      errors.push(`与第 ${seen.get(dupKey)} 行重复（公司/类型/子分类/名称/持证人/编号完全一致）`);
    } else {
      seen.set(dupKey, r.rowNo);
    }

    // ---- 组装待插入数据 ----
    const data = {
      department_id: company ? company.id : null,
      cert_category: category,
      cert_type: typeName || null,
      sub1_value: (typeDef && typeDef.sub1_label && sub1) || null,
      sub2_value: (typeDef && typeDef.sub2_label && sub2) || null,
      cert_name: certName || null,
      cert_no: certNo || null,
      issuing_authority: authority || null,
      issue_date: issueDate.value || validFrom.value,  // 发证日期留空时自动取有效期起
      valid_from: validFrom.value,
      valid_until: isLong ? null : (validUntil.value || null),
      is_long_term: isLong === true,
      holder_name: holderName || null,
      holder_id_no: holderIdNo || null,
      holder_position: holderPosition || null,
      remark: remark || null,
      status: 'active',
    };

    return {
      rowNo: r.rowNo,
      data,
      errors,
      disp: {
        company: companyName,
        category: category ? Utils.categoryLabel(category) : g('证照大类'),
        type: typeName,
        sub: [sub1, sub2].filter(Boolean).join(' / '),
        name: certName,
        holder: holderName,
        until: isLong ? '长期' : (validUntil.value || ''),
      },
    };
  },

  // ========================================================================
  // 执行导入（分批写入 + 失败回退逐行）
  // ========================================================================

  /**
   * 开始导入（仅写入校验通过的行）
   */
  async startImport() {
    const validRows = this.state.rows.filter(r => r.errors.length === 0);
    if (validRows.length === 0 || this.state.importing) return;

    this.state.importing = true;
    this.state.phase = 'importing';
    this.renderModal();

    const failed = [];
    let done = 0;

    for (let i = 0; i < validRows.length; i += this.CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + this.CHUNK_SIZE);
      try {
        const { error } = await sb.from('certificates')
          .insert(chunk.map(r => ({ ...r.data, created_by: Auth.currentUser.id })));
        if (error) throw error;
        done += chunk.length;
      } catch (e) {
        // 整批失败：逐行重试，定位具体问题行
        console.warn('批量插入失败，回退逐行插入:', e);
        for (const r of chunk) {
          try {
            const { error } = await sb.from('certificates')
              .insert([{ ...r.data, created_by: Auth.currentUser.id }]);
            if (error) throw error;
            done++;
          } catch (e2) {
            failed.push({ rowNo: r.rowNo, name: r.disp.name, reason: this.errText(e2) });
          }
        }
      }
      this.updateProgress(done, validRows.length, failed.length);
    }

    this.state.importing = false;
    this.state.result = {
      total: this.state.rows.length,
      attempted: validRows.length,
      ok: done,
      failed,
      skipped: this.state.rows.length - validRows.length,
    };
    this.state.phase = 'result';
    this.renderModal();

    Utils.toast(
      failed.length ? `导入完成：成功 ${done} 条，失败 ${failed.length} 条，详情见弹窗` : `导入完成：成功写入 ${done} 条证照`,
      failed.length ? 'info' : 'success'
    );

    // 后台刷新管理员台账（弹窗保持打开展示结果）
    if (done > 0) CertAdmin.loadData();
  },

  /**
   * 更新进度条（不重渲染，避免滚动位置跳动）
   */
  updateProgress(done, total, failedCount) {
    const fill = document.getElementById('import-progress-fill');
    const text = document.getElementById('import-progress-text');
    if (fill) fill.style.width = total > 0 ? `${Math.round((done / total) * 100)}%` : '0%';
    if (text) {
      text.textContent = `正在导入 ${done} / ${total} ...` + (failedCount ? `（已失败 ${failedCount} 条）` : '');
    }
  },

  /**
   * 提取错误信息（截断过长文本）
   */
  errText(e) {
    let msg = '';
    if (e) msg = e.message || (e.error && e.error.message) || e.hint || '';
    msg = String(msg || e || '未知错误');
    return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
  },
};

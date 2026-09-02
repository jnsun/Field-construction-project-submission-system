// ============================================================================
// 项目准入凭证核验。仅供已经登录且具备项目管理权限的人员使用。
// 目前支持扫码枪/小程序扫码后填入凭证编号；二维码图形在小程序接入时复用该接口。
// ============================================================================
const TrainingAdmissionVerify = {
  STATUS: {
    eligible: ['可上岗', 'badge-success'], blocked: ['禁止上岗', 'badge-danger'],
    expired: ['凭证已过期', 'badge-danger'], project_closed: ['项目已关闭', 'badge-muted'],
    pending: ['待完成培训', 'badge-warning'], learning: ['培训进行中', 'badge-info'],
    exam_pending: ['待考试', 'badge-warning'], pending_sign: ['待签字', 'badge-warning'],
    pending_site_confirm: ['待现场确认', 'badge-warning'],
    temporary_access: ['临时通行', 'badge-danger'],
    visitor_notice: ['访客安全告知有效', 'badge-info'],
  },

  async render(box) {
    box.innerHTML = `<div class="card"><div class="card-header"><h2>二维码核验</h2><span class="text-muted">仅显示现场核验所需信息</span></div>
      <div class="card-body"><div style="display:flex;gap:8px;max-width:560px;flex-wrap:wrap">
        <input id="admission-verify-code" class="form-control" style="flex:1;min-width:220px" placeholder="扫描或输入电子凭证/临时通行编号">
        <button class="btn btn-primary" onclick="TrainingAdmissionVerify.verify()">核验</button>
      </div><p class="text-muted" style="font-size:12px;margin-top:8px">核验结果实时判断项目状态、培训有效期和特种作业证状态。临时通行仅为短时例外，不以截图为准。</p>
      <div id="admission-verify-result" style="margin-top:16px"></div></div></div>`;
    const input = document.getElementById('admission-verify-code');
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') this.verify(); });
    input?.focus();
  },

  async verify() {
    const input = document.getElementById('admission-verify-code');
    const code = input?.value.trim();
    if (!code) { Utils.toast('请扫描或输入凭证编号', 'error'); return; }
    const result = document.getElementById('admission-verify-result');
    if (result) result.innerHTML = '<span class="text-muted">正在核验…</span>';
    const { data, error } = await sb.rpc('training_verify_certificate', { p_certificate_no: code });
    if (error) { if (result) result.innerHTML = `<span style="color:#b91c1c">核验失败：${Utils.escapeHtml(error.message)}</span>`; return; }
    let row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      const temporary = await sb.rpc('training_verify_temporary_access', { p_pass_code: code });
      if (temporary.error) { if (result) result.innerHTML = `<span style="color:#b91c1c">核验失败：${Utils.escapeHtml(temporary.error.message)}</span>`; return; }
      const temp = Array.isArray(temporary.data) ? temporary.data[0] : temporary.data;
      if (temp) row = {
        ...temp,
        certificate_no: temp.pass_code,
        admission_status: temp.access_status,
        valid_until: temp.expires_at ? new Date(temp.expires_at).toLocaleString() : null,
        blocked_reason: temp.reason,
      };
    }
    if (!row) {
      const visitor = await sb.rpc('training_verify_visitor_notice', { p_pass_code: code });
      if (visitor.error) { if (result) result.innerHTML = `<span style="color:#b91c1c">核验失败：${Utils.escapeHtml(visitor.error.message)}</span>`; return; }
      const v = Array.isArray(visitor.data) ? visitor.data[0] : visitor.data;
      if (v) row = { ...v, certificate_no: v.pass_code, admission_status: v.access_status, valid_until: v.expires_at ? new Date(v.expires_at).toLocaleString() : null, blocked_reason: v.notice_content };
    }
    if (!row) { if (result) result.innerHTML = '<div class="alert alert-danger">未找到可由您核验的有效项目凭证、临时通行或访客安全告知。请核对编号或确认您已被任命为该项目经理/安全员。</div>'; return; }
    this.show(row);
  },

  async image(path) {
    if (!path) return '';
    const bucket = typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates';
    const { data } = await sb.storage.from(bucket).createSignedUrl(path, 300);
    return data?.signedUrl || '';
  },

  async show(row) {
    const target = document.getElementById('admission-verify-result');
    if (!target) return;
    const [label, cls] = this.STATUS[row.admission_status] || [row.admission_status || '未知', 'badge-muted'];
    const temporary = row.admission_status === 'temporary_access';
    const visitor = row.admission_status === 'visitor_notice';
    const ok = row.admission_status === 'eligible';
    const photo = await this.image(row.photo_path);
    target.innerHTML = `<div style="border:1px solid ${ok ? '#86efac' : visitor ? '#93c5fd' : '#fca5a5'};border-left:5px solid ${ok ? '#16a34a' : visitor ? '#2563eb' : '#dc2626'};border-radius:8px;padding:16px;background:${temporary ? '#fff1f2' : visitor ? '#eff6ff' : '#fff'}">
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        ${photo ? `<img src="${Utils.escapeHtml(photo)}" alt="人员照片" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb">` : ''}
        <div style="flex:1;min-width:200px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:18px">${Utils.escapeHtml(row.employee_name || '—')}</b><span class="badge ${cls}">${label}</span></div>
          <div class="text-muted" style="font-size:13px;margin-top:8px">工种：${Utils.escapeHtml(row.work_position || '未填写')}</div>
          <div class="text-muted" style="font-size:13px;margin-top:4px">项目：${Utils.escapeHtml(row.project_code || '')} ${Utils.escapeHtml(row.project_name || '')}</div>
          <div class="text-muted" style="font-size:13px;margin-top:4px">有效至：${Utils.escapeHtml(row.valid_until || '—')}</div>
          ${row.blocked_reason ? `<div style="color:${visitor ? '#1d4ed8' : '#b91c1c'};font-size:13px;margin-top:8px">${temporary ? '临时通行原因' : visitor ? '安全告知' : '限制原因'}：${Utils.escapeHtml(row.blocked_reason)}</div>` : ''}
          ${temporary ? '<div style="color:#b91c1c;font-size:12px;margin-top:10px;font-weight:600">仅限本次临时例外；到期、撤销或项目暂停后立即禁止入场。</div>' : ''}
          ${visitor ? '<div style="color:#1d4ed8;font-size:12px;margin-top:10px;font-weight:600">仅表示访客安全告知有效，不代表具备作业上岗资格。</div>' : ''}
          <div class="text-muted" style="font-size:12px;margin-top:10px">${temporary ? '通行编号' : '凭证编号'}：${Utils.escapeHtml(row.certificate_no || '')}</div>
        </div></div></div>`;
  },
};

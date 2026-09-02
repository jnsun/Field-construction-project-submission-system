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
  },

  async render(box) {
    box.innerHTML = `<div class="card"><div class="card-header"><h2>二维码核验</h2><span class="text-muted">仅显示现场核验所需信息</span></div>
      <div class="card-body"><div style="display:flex;gap:8px;max-width:560px;flex-wrap:wrap">
        <input id="admission-verify-code" class="form-control" style="flex:1;min-width:220px" placeholder="扫描或输入电子记录凭证编号">
        <button class="btn btn-primary" onclick="TrainingAdmissionVerify.verify()">核验</button>
      </div><p class="text-muted" style="font-size:12px;margin-top:8px">核验结果实时判断项目状态、培训有效期和特种作业证状态，不以截图为准。</p>
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
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { if (result) result.innerHTML = '<div class="alert alert-danger">未找到可由您核验的有效项目凭证。请核对编号或确认您已被任命为该项目经理/安全员。</div>'; return; }
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
    const ok = row.admission_status === 'eligible';
    const photo = await this.image(row.photo_path);
    target.innerHTML = `<div style="border:1px solid ${ok ? '#86efac' : '#fca5a5'};border-left:5px solid ${ok ? '#16a34a' : '#dc2626'};border-radius:8px;padding:16px;background:#fff">
      <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        ${photo ? `<img src="${Utils.escapeHtml(photo)}" alt="人员照片" style="width:72px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb">` : ''}
        <div style="flex:1;min-width:200px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:18px">${Utils.escapeHtml(row.employee_name || '—')}</b><span class="badge ${cls}">${label}</span></div>
          <div class="text-muted" style="font-size:13px;margin-top:8px">工种：${Utils.escapeHtml(row.work_position || '未填写')}</div>
          <div class="text-muted" style="font-size:13px;margin-top:4px">项目：${Utils.escapeHtml(row.project_code || '')} ${Utils.escapeHtml(row.project_name || '')}</div>
          <div class="text-muted" style="font-size:13px;margin-top:4px">有效至：${Utils.escapeHtml(row.valid_until || '—')}</div>
          ${row.blocked_reason ? `<div style="color:#b91c1c;font-size:13px;margin-top:8px">限制原因：${Utils.escapeHtml(row.blocked_reason)}</div>` : ''}
          <div class="text-muted" style="font-size:12px;margin-top:10px">凭证编号：${Utils.escapeHtml(row.certificate_no || '')}</div>
        </div></div></div>`;
  },
};

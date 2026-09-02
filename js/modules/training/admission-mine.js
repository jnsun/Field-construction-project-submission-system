// =============================================================
// js/modules/training/admission-mine.js —— 员工手机端项目准入状态
// 只读展示动态资格；学习、考试、签字仍沿用 TrainingMine 的现有流程。
// =============================================================
const TrainingAdmissionMine = {

  STATUS: {
    eligible: ['可上岗', 'badge-success'],
    blocked: ['禁止上岗', 'badge-danger'],
    project_closed: ['项目已关闭', 'badge-muted'],
    expired: ['凭证已过期', 'badge-danger'],
    pending: ['待完成培训', 'badge-warning'],
    learning: ['培训进行中', 'badge-info'],
    exam_pending: ['待考试', 'badge-warning'],
    pending_sign: ['待签字', 'badge-warning'],
    pending_site_confirm: ['待现场确认', 'badge-warning'],
  },

  async mount(box) {
    try {
      const { data, error } = await sb.rpc('training_my_admission_status');
      if (error || !data || !data.length) return;
      const host = document.createElement('div');
      host.id = 'training-admission-mine';
      host.innerHTML = this.render(data);
      box.insertBefore(host, box.firstChild);
    } catch (_) {
      // 迁移尚未执行时不影响原有我的培训页面。
    }
  },

  render(rows) {
    const blocked = rows.filter(r => ['blocked', 'expired', 'project_closed'].includes(r.status));
    return `<div class="card" style="border-left:4px solid ${blocked.length ? '#ef4444' : '#22c55e'};margin-bottom:16px">
      <div class="card-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h2>我的项目准入状态</h2>
        ${blocked.length ? '<span class="badge badge-danger">存在禁止上岗项目</span>' : '<span class="badge badge-success">请按当前项目状态执行</span>'}
      </div>
      <div class="card-body" style="display:grid;gap:10px">
        ${rows.map(r => this.row(r)).join('')}
      </div>
    </div>`;
  },

  row(r) {
    const [label, cls] = this.STATUS[r.status] || [r.status || '待处理', 'badge-muted'];
    const reason = r.blocked_reason ? `<div style="color:#b91c1c;font-size:12px;margin-top:4px">${Utils.escapeHtml(r.blocked_reason)}</div>` : '';
    return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;background:#fff">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div><b>${Utils.escapeHtml(r.project_name || '未命名项目')}</b><div class="text-muted" style="font-size:12px;margin-top:3px">
          ${Utils.escapeHtml(r.project_code || '')}${r.project_location ? ` · ${Utils.escapeHtml(r.project_location)}` : ''}
        </div></div>
        <span class="badge ${cls}">${label}</span>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#64748b;margin-top:8px">
        <span>工种：${Utils.escapeHtml(r.work_position || '未填写')}</span>
        <span>培训：${r.task_done || 0}/${r.task_total || 0} 项完成</span>
        <span>有效至：${Utils.escapeHtml(r.valid_until || '待生成')}</span>
      </div>${reason}
      ${r.certificate_no ? `<div style="margin-top:10px"><button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.openCredential('${r.admission_id}')">查看电子记录凭证</button></div>` : ''}
    </div>`;
  },

  async openCredential(admissionId) {
    const { data, error } = await sb.rpc('training_my_certificate', { p_admission_id: admissionId });
    if (error) { Utils.toast(error.message, 'error'); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { Utils.toast('当前没有可展示的电子记录凭证', 'error'); return; }
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    const [label, cls] = this.STATUS[row.admission_status] || [row.admission_status || '未知', 'badge-muted'];
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''\"><div class="modal" onclick="event.stopPropagation()" style="max-width:520px"><div class="modal-header"><h3>电子记录凭证</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:190px"><p style="font-size:18px;font-weight:600">${Utils.escapeHtml(row.employee_name || '')}</p><p class="text-muted">${Utils.escapeHtml(row.project_code || '')} ${Utils.escapeHtml(row.project_name || '')}</p><p style="margin-top:12px"><span class="badge ${cls}">${label}</span></p><p style="margin-top:12px">工种：${Utils.escapeHtml(row.work_position || '未填写')}</p><p>有效至：${Utils.escapeHtml(row.valid_until || '—')}</p>${row.blocked_reason ? `<p style="color:#b91c1c">限制原因：${Utils.escapeHtml(row.blocked_reason)}</p>` : ''}</div><div id="admission-credential-qr" style="width:144px;min-height:144px;padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:6px"></div></div><p class="text-muted" style="font-size:12px;margin-top:16px">凭证编号：${Utils.escapeHtml(row.certificate_no || '')}</p><p class="text-muted" style="font-size:12px">请由项目经理或安全员扫码核验；扫码结果会按当前项目、证照和有效期实时判断。</p></div></div></div>`;
    this.renderQr(row.certificate_no);
  },

  renderQr(certificateNo) {
    const box = document.getElementById('admission-credential-qr');
    if (!box || !certificateNo || typeof qrcode !== 'function') {
      if (box) box.textContent = certificateNo || '二维码加载失败';
      return;
    }
    try {
      const qr = qrcode(0, 'M');
      // 二维码仅保存不可读的业务编号，不嵌入身份证、电话或人员资料。
      qr.addData(certificateNo);
      qr.make();
      box.innerHTML = qr.createImgTag(4, 0, '电子记录凭证二维码');
      const img = box.querySelector('img');
      if (img) { img.style.cssText = 'display:block;width:128px;height:128px'; }
    } catch (_) {
      box.textContent = certificateNo;
    }
  },
};

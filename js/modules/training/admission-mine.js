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
      host.innerHTML = this.render(data) + await this.renderReminders();
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

  async renderReminders() {
    try {
      const { data, error } = await sb.from('training_admission_reminders').select('message, created_at, site_projects(project_code, name)').is('read_at', null).order('created_at', { ascending: false }).limit(10);
      if (error || !data?.length) return '';
      return `<div class="card" style="border-left:4px solid #f59e0b;margin-bottom:16px"><div class="card-header"><h2>待办提醒</h2></div><div class="card-body" style="display:grid;gap:8px">${data.map(x => `<div><b>${Utils.escapeHtml(x.site_projects?.project_code || '')} ${Utils.escapeHtml(x.site_projects?.name || '')}</b><div style="margin-top:3px">${Utils.escapeHtml(x.message)}</div><div class="text-muted" style="font-size:12px;margin-top:3px">${Utils.escapeHtml((x.created_at || '').slice(0, 16).replace('T', ' '))}</div></div>`).join('')}</div></div>`;
    } catch (_) { return ''; }
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
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.openSigning('${r.admission_id}')">三级教育签字</button>${r.certificate_no ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.openCredential('${r.admission_id}')">查看电子记录凭证</button>` : ''}</div>
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

  async openSigning(admissionId) {
    const [tasks, signatures] = await Promise.all([
      sb.from('training_admission_tasks').select('id, level, status, training_plans(title)').eq('admission_id', admissionId).order('level'),
      sb.from('training_admission_signatures').select('task_id, signer_role').eq('admission_id', admissionId),
    ]);
    if (tasks.error || signatures.error) { Utils.toast((tasks.error || signatures.error).message, 'error'); return; }
    const list = tasks.data || [];
    const sigs = signatures.data || [];
    const employeeSigned = id => sigs.some(s => s.task_id === id && s.signer_role === 'employee');
    const labels = { company: '公司级教育', entity: '经营实体级教育', project: '项目级教育', special: '专项培训' };
    const allReady = list.length > 0 && list.every(t => t.status === 'completed' && employeeSigned(t.id));
    const finalSigned = sigs.some(s => !s.task_id && s.signer_role === 'employee');
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''\"><div class="modal" onclick="event.stopPropagation()" style="max-width:650px"><div class="modal-header"><h3>三级教育电子签字</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><p class="hint">每个已完成层级均需本人手写签字；全部逐级签完后，方可签署完整准入记录。</p><div style="display:grid;gap:8px;margin-top:12px">${list.map(t => { const done = t.status === 'completed'; const signed = employeeSigned(t.id); return `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div><b>${Utils.escapeHtml(labels[t.level] || t.level)}</b><div class="text-muted" style="font-size:12px;margin-top:3px">${Utils.escapeHtml(t.training_plans?.title || '')}</div></div>${signed ? '<span class="badge badge-success">已签字</span>' : done ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionMine.openSignCanvas('${admissionId}','${t.id}','${Utils.escapeHtml(labels[t.level] || t.level)}')">本人签字</button>` : '<span class="badge badge-warning">待完成学习</span>'}</div>`; }).join('')}</div><div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:14px;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div><b>完整准入记录</b><div class="text-muted" style="font-size:12px;margin-top:3px">签署后等待项目现场确认</div></div>${finalSigned ? '<span class="badge badge-success">已签署</span>' : allReady ? `<button class="btn btn-primary" onclick="TrainingAdmissionMine.openSignCanvas('${admissionId}','','完整准入记录')">签署完整记录</button>` : '<span class="badge badge-warning">请先完成逐级签字</span>'}</div></div></div></div>`;
  },

  openSignCanvas(admissionId, taskId, title) {
    const host = document.getElementById('training-modal-host');
    if (!host) return;
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''\"><div class="modal" onclick="event.stopPropagation()" style="max-width:640px"><div class="modal-header"><h3>${Utils.escapeHtml(title)} - 本人签字</h3><button class="modal-close" onclick="TrainingAdmissionMine.openSigning('${admissionId}')">×</button></div><div class="modal-body"><p class="hint">请用手指或鼠标在下方签字，签字将作为电子培训档案的一部分永久留存。</p><canvas id="admission-sign-canvas" width="600" height="220" style="width:100%;border:1.5px dashed #c7d0dc;border-radius:8px;touch-action:none;background:#fff;cursor:crosshair"></canvas><div style="margin-top:10px"><button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.clearCanvas()">清除重写</button></div></div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionMine.openSigning('${admissionId}')">返回</button><button class="btn btn-primary" onclick="TrainingAdmissionMine.saveAdmissionSign('${admissionId}','${taskId || ''}')">确认签字</button></div></div></div>`;
    this.initCanvas();
  },

  initCanvas() {
    const cv = document.getElementById('admission-sign-canvas'); if (!cv) return;
    const ctx = cv.getContext('2d'); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
    this.signDrawn = false; let down = false; let last = null;
    const point = e => { const r = cv.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: (p.clientX - r.left) * cv.width / r.width, y: (p.clientY - r.top) * cv.height / r.height }; };
    const start = e => { e.preventDefault(); down = true; last = point(e); this.signDrawn = true; };
    const move = e => { if (!down) return; e.preventDefault(); const next = point(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(next.x, next.y); ctx.stroke(); last = next; };
    const end = () => { down = false; last = null; };
    cv.addEventListener('pointerdown', start); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', end); cv.addEventListener('pointerleave', end);
  },

  clearCanvas() { const cv = document.getElementById('admission-sign-canvas'); if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); this.signDrawn = false; },

  async saveAdmissionSign(admissionId, taskId) {
    if (!this.signDrawn) { Utils.toast('请先在签字框中签字', 'error'); return; }
    const cv = document.getElementById('admission-sign-canvas');
    const dataUrl = cv.toDataURL('image/png');
    const blob = await (await fetch(dataUrl)).blob();
    const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const path = `training-admission/signatures/${admissionId}/${Date.now()}-${random}.png`;
    const bucket = typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates';
    const { error: uploadError } = await sb.storage.from(bucket).upload(path, blob, { contentType: 'image/png', upsert: false });
    if (uploadError) { Utils.toast(`签字上传失败：${uploadError.message}`, 'error'); return; }
    const bytes = new TextEncoder().encode(`${admissionId}|${taskId || 'final'}|${Date.now()}|${navigator.userAgent || ''}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map(x => x.toString(16).padStart(2, '0')).join('');
    const { error } = await sb.rpc('training_admission_sign', { p_admission_id: admissionId, p_task_id: taskId || null, p_signer_role: 'employee', p_storage_path: path, p_record_hash: hash, p_device_info: (navigator.userAgent || '').slice(0, 200) });
    if (error) { Utils.toast(error.message, 'error'); return; }
    Utils.toast('电子签字已保存', 'success');
    await this.openSigning(admissionId);
  },
};

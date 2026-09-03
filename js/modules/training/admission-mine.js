// =============================================================
// js/modules/training/admission-mine.js —— 员工手机端项目准入状态
// 只读展示动态资格；学习、考试、签字仍沿用 TrainingMine 的现有流程。
// =============================================================
const TrainingAdmissionMine = {

  state: { autoInvite: '' },

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
      if (error) return;
      const visitor = await this.renderVisitorNotices();
      const reminders = await this.renderReminders();
      const applications = await this.renderJoinApplications();
      const host = document.createElement('div');
      host.id = 'training-admission-mine';
      host.innerHTML = this.renderJoinEntry() + applications + (data?.length ? this.render(data) : '') + visitor + reminders;
      box.insertBefore(host, box.firstChild);
      const invite = this.inviteToken();
      if (invite && this.state.autoInvite !== invite) {
        this.state.autoInvite = invite;
        setTimeout(() => this.openJoinApplication(), 0);
      }
    } catch (_) {
      // 迁移尚未执行时不影响原有我的培训页面。
    }
  },

  renderJoinEntry() {
    return `<div class="card" style="margin-bottom:16px"><div class="card-header"><h2>加入项目</h2></div><div class="card-body" style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><span class="text-muted">外协或临时人员请扫描项目二维码，或输入项目邀请码后提交入场申请。</span><button class="btn btn-primary btn-sm" onclick="TrainingAdmissionMine.openJoinApplication()">申请加入项目</button></div></div>`;
  },

  async renderJoinApplications() {
    try {
      const { data, error } = await sb.from('project_join_applications').select('id, status, review_note, created_at, site_projects(project_code, name)').eq('applicant_user_id', Auth.currentUser?.id || '').order('created_at', { ascending: false }).limit(10);
      if (error || !data?.length) return '';
      const label = { pending_project_review: ['等待项目经理审核', 'badge-warning'], pending_entity_review: ['等待经营实体复核', 'badge-warning'], approved: ['已获准加入项目', 'badge-success'], rejected: ['申请被驳回', 'badge-danger'], cancelled: ['申请已取消', 'badge-muted'] };
      return `<div class="card" style="margin-bottom:16px"><div class="card-header"><h2>我的入场申请</h2></div><div class="card-body" style="display:grid;gap:9px">${data.map(x => { const v = label[x.status] || [x.status, 'badge-muted']; return `<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap"><div><b>${Utils.escapeHtml(x.site_projects?.project_code || '')} ${Utils.escapeHtml(x.site_projects?.name || '项目')}</b><div class="text-muted" style="font-size:12px;margin-top:3px">提交时间：${Utils.escapeHtml((x.created_at || '').slice(0, 16).replace('T', ' '))}${x.review_note ? `　审核说明：${Utils.escapeHtml(x.review_note)}` : ''}</div></div><span class="badge ${v[1]}">${v[0]}</span></div>`; }).join('')}</div></div>`;
    } catch (_) { return ''; }
  },

  inviteToken() { return new URLSearchParams(location.search).get('invite') || ''; },

  clearInviteToken() {
    const url = new URL(location.href);
    url.searchParams.delete('invite');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    this.state.autoInvite = '';
  },

  async inviteInfo(token) {
    const { data, error } = await sb.rpc('site_project_invite_summary', { p_token: token });
    if (error || !data?.[0]) {
      Utils.toast(error?.message || '邀请码无效或已过期，请联系项目经理获取新二维码', 'error');
      return null;
    }
    return data[0];
  },

  async openJoinApplication() {
    const token = this.inviteToken();
    const profile = Auth.currentProfile || {};
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    host.innerHTML = `<div class="modal-overlay"><div class="modal" style="max-width:620px"><div class="modal-header"><h3>项目入场申请</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><span class="text-muted">正在核对项目邀请码…</span></div></div></div>`;
    const invite = token ? await this.inviteInfo(token) : null;
    if (token && !invite) { host.innerHTML = ''; this.clearInviteToken(); return; }
    const projectHint = invite ? `<div class="alert alert-success" style="margin-bottom:12px"><b>${Utils.escapeHtml(invite.project_code || '')} ${Utils.escapeHtml(invite.project_name || '')}</b><br><span style="font-size:12px">项目邀请码有效至：${Utils.escapeHtml(String(invite.expires_at || '').slice(0, 16).replace('T', ' '))}</span></div>` : '';
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''"><div class="modal" onclick="event.stopPropagation()" style="max-width:620px"><div class="modal-header"><h3>项目入场申请</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><p class="hint">提交后由项目经理审核；跨项目申请会自动转经营实体复核。审核通过后仍需完成培训、签字和现场确认，才可上岗。</p>${projectHint}<div class="form-group"><label>项目邀请码 <span class="required">*</span></label><input id="join-token" class="form-control" value="${Utils.escapeHtml(token)}" autocomplete="off"></div><div class="form-row"><div class="form-group"><label>姓名 <span class="required">*</span></label><input id="join-name" class="form-control" value="${Utils.escapeHtml(profile.full_name || '')}"></div><div class="form-group"><label>手机号 <span class="required">*</span></label><input id="join-phone" class="form-control" inputmode="numeric" value="${Utils.escapeHtml(profile.phone || '')}"></div></div><div class="form-row"><div class="form-group"><label>工种/岗位 <span class="required">*</span></label><input id="join-position" class="form-control" placeholder="如：钻探工 / 电工"></div><div class="form-group"><label>外协单位名称 <span class="required">*</span></label><input id="join-company" class="form-control"></div></div><div class="form-group"><label>统一社会信用代码</label><input id="join-company-code" class="form-control"></div><div class="form-group"><label>本人现场照片 <span class="required">*</span></label><input id="join-photo" type="file" class="form-control" accept="image/png,image/jpeg,image/webp" capture="user"></div><div class="form-row"><div class="form-group"><label>单位资质附件</label><input id="join-qualification" type="file" class="form-control" accept=".pdf,image/png,image/jpeg,image/webp"></div><div class="form-group"><label>项目合同附件</label><input id="join-contract" type="file" class="form-control" accept=".pdf,image/png,image/jpeg,image/webp"></div></div><div class="form-group"><label>特种作业证附件（爆破、钻探、电工、焊工必传）</label><input id="join-special-certificate" type="file" class="form-control" accept=".pdf,image/png,image/jpeg,image/webp"><p class="text-muted" style="font-size:12px;margin:4px 0 0">附件仅供人工审核，不代表自动合格；单个文件不超过 10MB。</p></div></div><div class="modal-footer"><button class="btn btn-secondary" onclick="document.getElementById('training-modal-host').innerHTML=''">取消</button><button class="btn btn-primary" onclick="TrainingAdmissionMine.submitJoinApplication()">提交申请</button></div></div></div>`;
  },

  async submitJoinApplication() {
    const value = id => document.getElementById(id)?.value.trim() || '';
    const token = value('join-token'), name = value('join-name'), phone = value('join-phone'), position = value('join-position'), company = value('join-company');
    const file = document.getElementById('join-photo')?.files?.[0];
    if (!token || !name || !phone || !position || !company || !file) { Utils.toast('请完整填写必填信息并上传本人现场照片', 'error'); return; }
    if (!/^1[3-9]\d{9}$/.test(phone)) { Utils.toast('手机号格式不正确', 'error'); return; }
    if (file.size > 10 * 1024 * 1024 || (file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) { Utils.toast('现场照片仅支持 JPG、PNG、WEBP，且不能超过 10MB', 'error'); return; }
    if (!await this.inviteInfo(token)) return;
    const highRisk = /(爆破|钻探|电工|焊工)/.test(position);
    const special = document.getElementById('join-special-certificate')?.files?.[0];
    if (highRisk && !special) { Utils.toast('高风险工种必须上传特种作业证附件', 'error'); return; }
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'; const random = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const path = `training-admission/join-applications/${Date.now()}-${random}.${ext}`; const bucket = typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates';
    const upload = await sb.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
    if (upload.error) { Utils.toast(`照片上传失败：${upload.error.message}`, 'error'); return; }
    const attachments = [];
    for (const [type, id] of [['qualification', 'join-qualification'], ['contract', 'join-contract'], ['special_certificate', 'join-special-certificate']]) {
      const attachment = document.getElementById(id)?.files?.[0];
      if (!attachment) continue;
      if (attachment.size > 10 * 1024 * 1024 || (attachment.type && !['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(attachment.type))) { Utils.toast('附件仅支持 PDF、PNG、JPG、WEBP，且不能超过 10MB', 'error'); return; }
      const aext = (attachment.name.split('.').pop() || 'bin').replace(/[^a-z0-9]/ig, '') || 'bin'; const apath = `training-admission/join-applications/${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}.${aext}`;
      const up = await sb.storage.from(typeof CERT_STORAGE_BUCKET === 'string' ? CERT_STORAGE_BUCKET : 'certificates').upload(apath, attachment, { contentType: attachment.type || 'application/octet-stream', upsert: false });
      if (up.error) { Utils.toast(`附件上传失败：${up.error.message}`, 'error'); return; }
      attachments.push({ type, path: apath, name: attachment.name.slice(0, 160) });
    }
    const { error } = await sb.rpc('site_project_apply', { p_token: token, p_name: name, p_phone: phone, p_position: position, p_contractor_name: company, p_contractor_code: value('join-company-code') || null, p_photo_path: path, p_attachments: attachments });
    if (error) { Utils.toast(error.message, 'error'); return; }
    const host = document.getElementById('training-modal-host'); if (host) host.innerHTML = '';
    this.clearInviteToken();
    Utils.toast('申请已提交，请等待项目经理审核', 'success'); await TrainingModule.renderView();
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

  async renderVisitorNotices() {
    try { const { data, error } = await sb.rpc('training_my_visitor_notices'); if (error || !data?.length) return ''; return `<div class="card" style="border-left:4px solid #2563eb;margin-bottom:16px"><div class="card-header"><h2>访客安全告知</h2></div><div class="card-body" style="display:grid;gap:10px">${data.map(x => `<div><b>${Utils.escapeHtml(x.project_code)} ${Utils.escapeHtml(x.project_name)}</b><div style="margin-top:5px">${Utils.escapeHtml(x.notice_content)}</div><div class="text-muted" style="font-size:12px;margin-top:5px">有效至：${Utils.escapeHtml(String(x.expires_at).slice(0,16).replace('T',' '))}</div>${x.acknowledged_at ? '<span class="badge badge-success" style="margin-top:8px">已确认安全告知</span>' : `<button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="TrainingAdmissionMine.acknowledgeVisitor('${x.id}')">本人确认已知悉</button>`}</div>`).join('')}</div></div>`; } catch (_) { return ''; }
  },

  async acknowledgeVisitor(id) { if (!confirm('确认已阅读并知悉本项目现场安全告知？')) return; const { error } = await sb.rpc('training_acknowledge_visitor_notice', { p_notice_id: id }); if (error) { Utils.toast(error.message, 'error'); return; } Utils.toast('安全告知已确认，请由项目管理人员扫码核验', 'success'); await TrainingModule.renderView(); },

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
        ${r.due_at ? `<span style="color:${r.status !== 'eligible' && new Date(r.due_at) < new Date() ? '#b91c1c' : '#64748b'}">${r.urgent ? '当天加急 · ' : ''}截止：${Utils.escapeHtml(new Date(r.due_at).toLocaleString().replace(/:\d{2}$/, ''))}</span>` : ''}
        <span>有效至：${Utils.escapeHtml(r.valid_until || '待生成')}</span>
      </div>${reason}
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">${r.status === 'exam_pending' ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionMine.startAdmissionExam('${r.admission_id}')">开始综合考试</button>` : ''}<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.openSigning('${r.admission_id}')">三级教育签字</button>${r.certificate_no ? `<button class="btn btn-sm btn-secondary" onclick="TrainingAdmissionMine.openCredential('${r.admission_id}')">查看电子记录凭证</button>` : ''}</div>
    </div>`;
  },

  async openCredential(admissionId) {
    const { data, error } = await sb.rpc('training_my_certificate', { p_admission_id: admissionId });
    if (error) { Utils.toast(error.message, 'error'); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { Utils.toast('当前没有可展示的电子记录凭证', 'error'); return; }
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    const [label, cls] = this.STATUS[row.admission_status] || [row.admission_status || '未知', 'badge-muted'];
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''\"><div class="modal" onclick="event.stopPropagation()" style="max-width:520px"><div class="modal-header"><h3>电子记录凭证</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap"><div style="flex:1;min-width:190px"><p style="font-size:18px;font-weight:600">${Utils.escapeHtml(row.employee_name || '')}</p><p class="text-muted">${Utils.escapeHtml(row.project_code || '')} ${Utils.escapeHtml(row.project_name || '')}</p><p style="margin-top:12px"><span class="badge ${cls}">${label}</span></p><p style="margin-top:12px">工种：${Utils.escapeHtml(row.work_position || '未填写')}</p><p>有效至：${Utils.escapeHtml(row.valid_until || '—')}</p>${row.blocked_reason ? `<p style="color:#b91c1c">限制原因：${Utils.escapeHtml(row.blocked_reason)}</p>` : ''}</div><div id="admission-credential-qr" style="width:144px;min-height:144px;padding:8px;background:#fff;border:1px solid #e5e7eb;border-radius:6px"></div></div><p class="text-muted" style="font-size:12px;margin-top:16px">凭证编号：${Utils.escapeHtml(row.certificate_no || '')}</p><p class="text-muted" style="font-size:12px">请由项目经理或安全员扫码核验；扫码结果会按当前项目、证照和有效期实时判断。</p></div><div class="modal-footer"><button class="btn btn-secondary" onclick="TrainingAdmissionMine.downloadCredentialPdf(${JSON.stringify(row).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')})">下载 PDF 凭证</button><button class="btn btn-primary" onclick="document.getElementById('training-modal-host').innerHTML=''">关闭</button></div></div></div>`;
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

  downloadCredentialPdf(row) {
    if (!globalThis.jspdf?.jsPDF || typeof qrcode !== 'function') { Utils.toast('PDF 组件尚未加载，请刷新后重试', 'error'); return; }
    try {
      const canvas = document.createElement('canvas'); canvas.width = 1240; canvas.height = 1754;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 10; ctx.strokeRect(42, 42, 1156, 1670);
      ctx.fillStyle = '#0f172a'; ctx.textAlign = 'center'; ctx.font = 'bold 52px Microsoft YaHei, sans-serif'; ctx.fillText('安全生产培训电子记录凭证', 620, 150);
      ctx.font = '28px Microsoft YaHei, sans-serif'; ctx.fillStyle = '#475569'; ctx.fillText('物化院有限公司安全教育平台', 620, 205);
      const status = row.admission_status === 'eligible' ? '可上岗' : '当前不可上岗';
      ctx.fillStyle = row.admission_status === 'eligible' ? '#15803d' : '#b91c1c'; ctx.font = 'bold 38px Microsoft YaHei, sans-serif'; ctx.fillText(status, 620, 300);
      const lines = [['姓名', row.employee_name], ['工种', row.work_position || '未填写'], ['项目', `${row.project_code || ''} ${row.project_name || ''}`.trim()], ['有效至', row.valid_until || '—'], ['凭证编号', row.certificate_no || '—']];
      ctx.textAlign = 'left'; ctx.font = '30px Microsoft YaHei, sans-serif'; let y = 430;
      lines.forEach(([label, value]) => { ctx.fillStyle = '#64748b'; ctx.fillText(label, 130, y); ctx.fillStyle = '#111827'; const text = String(value || '—'); ctx.fillText(text.length > 28 ? `${text.slice(0, 28)}...` : text, 350, y); y += 105; });
      if (row.blocked_reason) { ctx.fillStyle = '#b91c1c'; ctx.font = '26px Microsoft YaHei, sans-serif'; ctx.fillText(`限制原因：${row.blocked_reason}`, 130, y + 15); }
      const qr = qrcode(0, 'M'); qr.addData(row.certificate_no || ''); qr.make();
      const qrImage = new Image(); qrImage.onload = () => { ctx.drawImage(qrImage, 430, 1030, 380, 380); finish(); }; qrImage.src = qr.createDataURL(8, 0);
      const finish = () => { ctx.textAlign = 'center'; ctx.fillStyle = '#64748b'; ctx.font = '24px Microsoft YaHei, sans-serif'; ctx.fillText('扫码或输入凭证编号进行实时核验；截图不作为上岗依据。', 620, 1490); ctx.fillText(`生成时间：${new Date().toLocaleString()}`, 620, 1540); const doc = new globalThis.jspdf.jsPDF({ orientation: 'portrait', unit: 'px', format: [1240, 1754] }); doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, 1240, 1754); doc.save(`electronic-record-${row.certificate_no || 'credential'}.pdf`); };
    } catch (e) { Utils.toast(`生成 PDF 失败：${e.message || e}`, 'error'); }
  },

  async openSigning(admissionId) {
    const [tasks, signatures, admission] = await Promise.all([
      sb.from('training_admission_tasks').select('id, level, status, training_plans(title)').eq('admission_id', admissionId).order('level'),
      sb.from('training_admission_signatures').select('task_id, signer_role, cycle_no').eq('admission_id', admissionId),
      sb.from('training_admissions').select('training_cycle_no').eq('id', admissionId).single(),
    ]);
    if (tasks.error || signatures.error || admission.error) { Utils.toast((tasks.error || signatures.error || admission.error).message, 'error'); return; }
    const list = tasks.data || [];
    const sigs = signatures.data || [];
    const employeeSigned = id => sigs.some(s => s.task_id === id && s.signer_role === 'employee');
    const labels = { company: '公司级教育', entity: '经营实体级教育', project: '项目级教育', special: '专项培训' };
    const allReady = list.length > 0 && list.every(t => t.status === 'completed' && employeeSigned(t.id));
    const finalSigned = sigs.some(s => !s.task_id && s.signer_role === 'employee' && s.cycle_no === admission.data.training_cycle_no);
    const host = document.getElementById('training-modal-host') || (() => { const h = document.createElement('div'); h.id = 'training-modal-host'; document.body.appendChild(h); return h; })();
    host.innerHTML = `<div class="modal-overlay" onclick="document.getElementById('training-modal-host').innerHTML=''\"><div class="modal" onclick="event.stopPropagation()" style="max-width:650px"><div class="modal-header"><h3>三级教育电子签字</h3><button class="modal-close" onclick="document.getElementById('training-modal-host').innerHTML=''">×</button></div><div class="modal-body"><p class="hint">每个已完成层级均需本人手写签字；全部逐级签完后，方可签署完整准入记录。</p><div style="display:grid;gap:8px;margin-top:12px">${list.map(t => { const done = t.status === 'completed'; const signed = employeeSigned(t.id); return `<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div><b>${Utils.escapeHtml(labels[t.level] || t.level)}</b><div class="text-muted" style="font-size:12px;margin-top:3px">${Utils.escapeHtml(t.training_plans?.title || '')}</div></div>${signed ? '<span class="badge badge-success">已签字</span>' : done ? `<button class="btn btn-sm btn-primary" onclick="TrainingAdmissionMine.openSignCanvas('${admissionId}','${t.id}','${Utils.escapeHtml(labels[t.level] || t.level)}')">本人签字</button>` : '<span class="badge badge-warning">待完成学习</span>'}</div>`; }).join('')}</div><div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:14px;display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap"><div><b>完整准入记录</b><div class="text-muted" style="font-size:12px;margin-top:3px">签署后等待项目现场确认</div></div>${finalSigned ? '<span class="badge badge-success">已签署</span>' : allReady ? `<button class="btn btn-primary" onclick="TrainingAdmissionMine.openSignCanvas('${admissionId}','','完整准入记录')">签署完整记录</button>` : '<span class="badge badge-warning">请先完成逐级签字</span>'}</div></div></div></div>`;
  },

  async startAdmissionExam(admissionId) {
    const { data, error } = await sb.rpc('training_prepare_admission_exam', { p_admission_id: admissionId });
    if (error) { Utils.toast(error.message, 'error'); return; }
    const exam = Array.isArray(data) ? data[0] : data;
    if (!exam?.plan_id) { Utils.toast('未找到综合考试配置', 'error'); return; }
    await TrainingMine.openExam(exam.plan_id);
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

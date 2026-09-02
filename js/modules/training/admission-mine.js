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
    </div>`;
  },
};

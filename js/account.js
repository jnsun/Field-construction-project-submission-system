/**
 * account.js - 账户设置模块
 * 部门账号（及管理员）自助修改登录邮箱与密码
 * 入口：页面头部「账户设置」按钮 → AccountSettings.open()
 */

const AccountSettings = {

  /**
   * 打开账户设置模态框
   */
  open() {
    const rawEmail = Auth.currentProfile ? (Auth.currentProfile.email || '') : '';
    const isPlaceholderEmail = typeof rawEmail === 'string' && rawEmail.endsWith('@login.local');
    const email = isPlaceholderEmail
      ? (Auth.currentProfile.phone ? (Auth.currentProfile.phone + '（手机号登录）') : '（手机号登录）')
      : rawEmail;
    const name = Auth.currentProfile ? (Auth.currentProfile.full_name || email || '') : '';
    const phone = Auth.currentProfile ? (Auth.currentProfile.phone || '') : '';
    // 旧库（未执行 sql/phone-login.sql）profiles 无 phone 列，隐藏手机号区块
    const hasPhoneField = !!Auth.currentProfile && ('phone' in Auth.currentProfile);

    const modalHTML = `
      <div class="modal-overlay" id="account-modal" onclick="AccountSettings.onOverlayClick(event)">
        <div class="modal-card">
          <div class="modal-header">
            <h2>账户设置</h2>
            <button class="modal-close" onclick="AccountSettings.close()">&times;</button>
          </div>
          <div class="modal-body">
            <div class="account-section">
              <h3 class="account-section-title">修改登录邮箱</h3>
              <p class="account-section-desc">当前账号：${Utils.escapeHtml(name)}（${Utils.escapeHtml(email)}）。修改后需使用新邮箱重新登录。</p>
              <div class="form-grid">
                <div class="form-group col-span-2">
                  <label>新邮箱 <span class="required">*</span></label>
                  <input type="email" id="account-new-email" placeholder="请输入新的登录邮箱" required>
                </div>
              </div>
              <button class="btn btn-primary btn-sm" id="account-email-btn" onclick="AccountSettings.changeEmail()">保存新邮箱</button>
            </div>

            ${hasPhoneField ? `
            <hr class="account-divider">

            <div class="account-section">
              <h3 class="account-section-title">修改手机号</h3>
              <p class="account-section-desc">当前手机号：${phone ? Utils.escapeHtml(phone) : '未设置'}。手机号可直接用于登录，修改后立即生效、无需重新登录。</p>
              <div class="form-grid">
                <div class="form-group col-span-2">
                  <label>新手机号</label>
                  <input type="tel" id="account-new-phone" placeholder="请输入新的手机号（1 开头 11 位），留空提交可清除" maxlength="11">
                </div>
              </div>
              <button class="btn btn-primary btn-sm" id="account-phone-btn" onclick="AccountSettings.changePhone()">保存手机号</button>
            </div>
            ` : ''}

            <hr class="account-divider">

            <div class="account-section">
              <h3 class="account-section-title">修改密码</h3>
              <p class="account-section-desc">修改后其他登录设备将退出，下次登录请使用新密码。</p>
              <div class="form-grid">
                <div class="form-group">
                  <label>新密码 <span class="required">*</span></label>
                  <input type="password" id="account-new-password" placeholder="至少 6 位" required autocomplete="new-password">
                </div>
                <div class="form-group">
                  <label>确认新密码 <span class="required">*</span></label>
                  <input type="password" id="account-confirm-password" placeholder="再次输入新密码" required autocomplete="new-password">
                </div>
              </div>
              <button class="btn btn-primary btn-sm" id="account-pwd-btn" onclick="AccountSettings.changePassword()">修改密码</button>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" onclick="AccountSettings.close()">关闭</button>
          </div>
        </div>
      </div>
    `;

    // 移除已有模态框
    const existing = document.getElementById('account-modal');
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    // 绑定回车提交
    const emailInput = document.getElementById('account-new-email');
    if (emailInput) {
      emailInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.changeEmail(); });
    }
    const phoneInput = document.getElementById('account-new-phone');
    if (phoneInput) {
      phoneInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.changePhone(); });
    }
    const pwdInput = document.getElementById('account-new-password');
    const confirmInput = document.getElementById('account-confirm-password');
    if (pwdInput && confirmInput) {
      confirmInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.changePassword(); });
    }
  },

  /**
   * 关闭模态框
   */
  close() {
    const modal = document.getElementById('account-modal');
    if (modal) modal.remove();
  },

  /**
   * 模态框遮罩点击关闭
   */
  onOverlayClick(event) {
    const overlay = event.currentTarget;
    if (event.target === overlay && overlay.dataset.dismissArmed === '1') this.close();
  },

  /**
   * 修改登录邮箱
   */
  async changeEmail() {
    const emailEl = document.getElementById('account-new-email');
    const btn = document.getElementById('account-email-btn');
    if (!emailEl || !btn) return;

    const newEmail = emailEl.value.trim();
    if (!newEmail) {
      Utils.toast('请输入新邮箱', 'error');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) {
      Utils.toast('请输入有效的邮箱地址', 'error');
      return;
    }
    if (!confirm(`确认将登录邮箱修改为「${newEmail}」吗？\n\n修改后需要重新登录。`)) return;

    btn.disabled = true;
    btn.textContent = '保存中...';

    const result = await Auth.changeEmail(newEmail);

    if (!result.success) {
      Utils.toast(result.error, 'error');
      btn.disabled = false;
      btn.textContent = '保存新邮箱';
      return;
    }

    Utils.toast(`邮箱已修改为 ${result.email}，请重新登录`, 'success');
    // 稍后自动登出，返回登录页
    setTimeout(() => {
      this.close();
      Auth.logout();
    }, 1500);
  },

  /**
   * 修改手机号（自助，立即生效无需重新登录）
   */
  async changePhone() {
    const phoneEl = document.getElementById('account-new-phone');
    const btn = document.getElementById('account-phone-btn');
    if (!phoneEl || !btn) return;

    const newPhone = phoneEl.value.trim();
    if (newPhone && !/^1[0-9]{10}$/.test(newPhone)) {
      Utils.toast('请输入有效的手机号（1 开头的 11 位数字）', 'error');
      return;
    }
    if (newPhone && !confirm(`确认将手机号修改为「${newPhone}」吗？\n\n修改后可使用该手机号登录。`)) return;
    if (!newPhone && !confirm('确认清除当前手机号吗？\n\n清除后将无法使用手机号登录。')) return;

    btn.disabled = true;
    btn.textContent = '保存中...';

    const result = await Auth.changePhone(newPhone);

    if (!result.success) {
      Utils.toast(result.error, 'error');
      btn.disabled = false;
      btn.textContent = '保存手机号';
      return;
    }

    if (result.cleared || !result.phone) {
      Utils.toast('手机号已清除', 'success');
    } else {
      Utils.toast(`手机号已设置为 ${result.phone}，可用其登录`, 'success');
    }
    phoneEl.value = '';
    // 重新打开弹窗以刷新"当前手机号"显示
    this.open();
  },

  /**
   * 修改密码
   */
  async changePassword() {
    const pwdEl = document.getElementById('account-new-password');
    const confirmEl = document.getElementById('account-confirm-password');
    const btn = document.getElementById('account-pwd-btn');
    if (!pwdEl || !confirmEl || !btn) return;

    const pwd = pwdEl.value;
    if (!pwd) {
      Utils.toast('请输入新密码', 'error');
      return;
    }
    if (pwd.length < 6) {
      Utils.toast('密码长度至少 6 位', 'error');
      return;
    }
    if (pwd !== confirmEl.value) {
      Utils.toast('两次输入的密码不一致', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = '修改中...';

    const result = await Auth.changePassword(pwd);

    if (!result.success) {
      Utils.toast(result.error, 'error');
      btn.disabled = false;
      btn.textContent = '修改密码';
      return;
    }

    Utils.toast('密码修改成功，下次登录请使用新密码', 'success');
    // 清空输入框并关闭
    pwdEl.value = '';
    confirmEl.value = '';
    this.close();
  },
};

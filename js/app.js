/**
 * app.js - 应用主入口
 * 负责初始化、路由、登录页渲染
 */

const App = {

  /**
   * 应用初始化
   */
  async init() {
    try {
      // 1. 先检查 Supabase 是否已配置
      //    （占位符配置会让 createClient 抛异常导致 sb 为 null，所以必须先检查配置）
      if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
        this.renderConfigWarning();
        return;
      }

      // 2. 检查 Supabase SDK 是否加载成功
      if (!sb) {
        this.renderError('Supabase SDK 加载失败，请检查 vendor/supabase.min.js 文件是否存在。');
        return;
      }

      // 3. 检查是否已有登录会话（带超时保护，防止网络问题导致卡死）
      const authTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('连接 Supabase 服务超时，请检查网络连接或项目配置')), 10000)
      );
      const authResult = await Promise.race([Auth.init(), authTimeout]);
      // Auth.init() 在无会话时返回 null，需先判空再解构
      const user = authResult ? authResult.user : null;
      const profile = authResult ? authResult.profile : null;

      if (user && profile) {
        this.routeTo(profile);
      } else {
        this.renderLogin();
      }

      // 4. 监听认证状态变化（如 token 过期自动登出）
      Auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
          Auth.currentUser = null;
          Auth.currentProfile = null;
          this.renderLogin();
        }
      });

    } catch (e) {
      console.error('应用初始化失败:', e);
      this.renderError('系统初始化失败：' + (e.message || e));
    }
  },

  /**
   * 隐藏加载动画
   */
  hideLoading() {
    const ls = document.getElementById('loading-screen');
    if (ls) ls.style.display = 'none';
  },

  /**
   * 品牌标志（5 段彩色环形 logo，取自公司 logo 配色）
   */
  BRAND_LOGO_SVG: `<svg class="brand-mark" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M60 4 A56 56 0 0 1 110.3 35.5 L92.4 44.2 A36 36 0 0 0 60 24 Z" fill="#B5D44B"/>
    <path d="M113.3 42.7 A56 56 0 0 1 98.9 100.3 L85.0 83.9 A36 36 0 0 0 94.2 48.9 Z" fill="#E87A3D"/>
    <path d="M92.9 105.3 A56 56 0 0 1 33.7 109.4 L43.1 91.8 A36 36 0 0 0 81.2 89.1 Z" fill="#4A4A4A"/>
    <path d="M27.1 105.3 A56 56 0 0 1 4.8 50.3 L24.5 53.8 A36 36 0 0 0 38.8 89.1 Z" fill="#2D5A8B"/>
    <path d="M6.7 42.7 A56 56 0 0 1 52.2 4.5 L55.0 24.4 A36 36 0 0 0 25.8 48.9 Z" fill="#2A9D8F"/>
  </svg>`,

  /**
   * 渲染 Supabase 配置提醒
   */
  renderConfigWarning() {
    this.hideLoading();
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="logo">
            <h1>安全生产管理系统</h1>
            <p class="logo-en">Safety Production Management System</p>
            <p class="logo-hint">系统未配置</p>
          </div>
          <div class="alert alert-warning">
            <p style="font-weight:600;margin-bottom:8px;">请先配置 Supabase 连接信息</p>
            <p>打开 <code>js/config.js</code> 文件，将 <code>SUPABASE_URL</code> 和 <code>SUPABASE_ANON_KEY</code> 替换为您 Supabase 项目的凭据。</p>
            <p style="margin-top:8px;">获取方式：Supabase 控制台 → Settings → API</p>
          </div>
        </div>
      </div>
    `;
  },

  /**
   * 渲染系统错误
   */
  renderError(message) {
    this.hideLoading();
    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="logo">
            <h1>安全生产管理系统</h1>
            <p class="logo-en">Safety Production Management System</p>
            <p class="logo-hint">系统提示</p>
          </div>
          <div class="alert alert-danger">
            <p>${Utils.escapeHtml(message)}</p>
          </div>
          <button class="btn btn-primary btn-block" onclick="location.reload()" style="margin-top:12px;">刷新重试</button>
        </div>
      </div>
    `;
  },

  /**
   * 渲染登录页
   */
  renderLogin() {
    this.hideLoading();

    const app = document.getElementById('app');
    app.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="logo">
            <h1>安全生产管理系统</h1>
            <p class="logo-en">Safety Production Management System</p>
            <p class="logo-hint">请使用您的账号登录</p>
          </div>
          <div class="login-error" id="login-error"></div>
          <form id="login-form" onsubmit="return false">
            <div class="form-group">
              <label for="login-email">登录邮箱或手机号</label>
              <input type="text" id="login-email" placeholder="请输入登录邮箱或 11 位手机号" required autocomplete="username" inputmode="email">
            </div>
            <div class="form-group">
              <label for="login-password">密码</label>
              <input type="password" id="login-password" placeholder="请输入密码" required autocomplete="current-password">
            </div>
            <button type="submit" class="btn btn-primary btn-block" id="login-btn" onclick="App.handleLogin()">
              登录
            </button>
          </form>
        </div>
      </div>
    `;

    // 绑定回车键提交
    const form = document.getElementById('login-form');
    if (form) {
      form.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') this.handleLogin();
      });
    }
  },

  /**
   * 处理登录
   */
  async handleLogin() {
    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    const errorEl = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    if (!emailEl || !passEl) return;

    const identifier = emailEl.value.trim();
    const password = passEl.value;

    if (!identifier || !password) {
      errorEl.textContent = '请输入登录邮箱或手机号和密码';
      errorEl.classList.add('show');
      return;
    }

    errorEl.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '登录中...';

    try {
      const result = await Auth.login(identifier, password);

      if (!result.success) {
        errorEl.textContent = result.error;
        errorEl.classList.add('show');
        btn.disabled = false;
        btn.textContent = '登录';
        return;
      }

      btn.textContent = '登录成功';
      // 路由到对应仪表盘
      this.routeTo(Auth.currentProfile);
    } catch (e) {
      console.error('登录失败:', e);
      errorEl.textContent = '登录失败：' + (e.message || '未知错误');
      errorEl.classList.add('show');
      btn.disabled = false;
      btn.textContent = '登录';
    }
  },

  /**
   * 登录成功后进入工作台首页
   */
  routeTo(profile) {
    this.hideLoading();
    this.openDashboard();
  },

  /**
   * 渲染工作台首页（个人待办 + 九宫格导航）
   */
  openDashboard() {
    const app = document.getElementById('app');
    app.innerHTML = '';
    Dashboard.render(app);
  },

  /**
   * 进入指定模块（按模块 id 查注册表渲染），无 id 时默认进入「野外施工项目报送」
   */
  openModule(moduleId) {
    const app = document.getElementById('app');
    if (!moduleId) moduleId = 'report';
    const mod = ModuleRegistry.get(moduleId);
    if (!mod) {
      Utils.toast && Utils.toast('模块不存在');
      this.openDashboard();
      return;
    }
    app.innerHTML = '';
    mod.renderer(app);
  },
};

// ---------------------------------------------------------------------------
// 全局错误捕获：防止加载动画卡住
// ---------------------------------------------------------------------------
window.addEventListener('error', (e) => {
  console.error('全局错误:', e.message || e.error);
});

// 超时保护：5 秒后若加载动画仍在，显示错误信息（防止某些异常导致白屏）
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const ls = document.getElementById('loading-screen');
    if (ls && ls.style.display !== 'none') {
      console.warn('应用初始化超时，显示错误提示');
      const app = document.getElementById('app');
      if (app && app.querySelector('#loading-screen')) {
        app.innerHTML = `
          <div class="login-page">
            <div class="login-card">
              <div class="logo">
                <h1>安全生产管理系统</h1>
                <p class="logo-en">Safety Production Management System</p>
                <p class="logo-hint">系统提示</p>
              </div>
              <div class="alert alert-danger">
                <p>系统加载超时，请尝试刷新页面。</p>
                <p style="margin-top:8px;">如果问题持续存在，请检查 js 文件夹下的脚本文件是否完整。</p>
              </div>
              <button class="btn btn-primary btn-block" onclick="location.reload()" style="margin-top:12px;">刷新重试</button>
            </div>
          </div>
        `;
      }
    }
  }, 5000);
});

// ---------------------------------------------------------------------------
// 启动应用
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

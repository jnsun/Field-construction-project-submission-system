/**
 * auth.js - 认证模块（登录 / 登出 / 会话管理）
 */

const Auth = {

  /**
   * 当前用户缓存
   */
  currentUser: null,
  currentProfile: null,

  /**
   * 初始化：检查是否已有登录会话
   * @returns {Promise<{user, profile}|null>}
   */
  async init() {
    const result = await sb.auth.getSession();
    const session = result && result.data ? result.data.session : null;
    if (!session) return null;

    this.currentUser = session.user;
    const { profile, error } = await this.fetchProfile();
    if (error) {
      console.error('获取用户信息失败:', error);
      this.currentProfile = null;
    } else {
      this.currentProfile = profile;
    }
    return { user: this.currentUser, profile: this.currentProfile };
  },

  /**
   * 获取当前用户的 profile
   * @returns {Promise<{profile: Object|null, error: string|null}>}
   */
  async fetchProfile() {
    if (!this.currentUser) return { profile: null, error: '未获取到当前用户' };

    const { data, error } = await sb
      .from('profiles')
      .select('*, departments(*)')
      .eq('id', this.currentUser.id)
      .single();

    if (error) {
      return { profile: null, error: this.mapDbError(error) };
    }
    return { profile: data, error: null };
  },

  /**
   * 登录（仅支持邮箱，避免在登录前暴露手机号和部门账号关联关系）
   * @param {string} identifier 登录邮箱
   * @param {string} password
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async login(identifier, password) {
    const email = String(identifier || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { success: false, error: '请使用登录邮箱登录。如忘记邮箱，请联系管理员查询。' };
    }

    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return { success: false, error: this.mapAuthError(error.message) };
    }

    this.currentUser = data.user;
    const { profile, error: profileError } = await this.fetchProfile();
    this.currentProfile = profile;

    if (profileError) {
      return { success: false, error: '用户信息获取失败：' + profileError };
    }
    if (!this.currentProfile) {
      return { success: false, error: '用户信息获取失败，请联系管理员。' };
    }

    // 检查是否已分配部门（管理员除外）
    if (this.currentProfile.role !== 'admin' && !this.currentProfile.department_id) {
      return {
        success: false,
        error: '您的账号尚未分配部门，请联系管理员分配部门后再登录。',
      };
    }

    return { success: true };
  },

  /**
   * 兼容保留：不再调用登录前标识解析接口。
   * @param {string} identifier
   * @returns {Promise<string|null>} 非邮箱返回 null
   */
  async resolveLoginEmail(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;

    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(id)) {
      return id.toLowerCase();
    }
    return null;
  },

  /**
   * 修改当前用户密码
   * @param {string} newPassword
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async changePassword(newPassword) {
    const pwd = String(newPassword || '');
    if (pwd.length < 6) {
      return { success: false, error: '新密码长度至少 6 位' };
    }
    const { error } = await sb.auth.updateUser({ password: pwd });
    if (error) {
      return { success: false, error: this.mapAuthError(error.message) };
    }
    return { success: true };
  },

  /**
   * 修改当前用户邮箱（登录名）
   * @param {string} newEmail
   * @returns {Promise<{success: boolean, error?: string, email?: string}>}
   */
  async changeEmail(newEmail) {
    const email = String(newEmail || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { success: false, error: '请输入有效的邮箱地址' };
    }
    const { data, error } = await sb.rpc('change_own_email', { p_new_email: email });
    if (error) {
      return { success: false, error: this.extractRpcMessage(error) };
    }
    return { success: true, email: (data && data.email) || email };
  },

  /**
   * 修改当前用户手机号（自助，仅改 profiles.phone，无需重新登录）
   * @param {string} newPhone 新手机号（空串表示清空）
   * @returns {Promise<{success: boolean, error?: string, phone?: string|null}>}
   */
  async changePhone(newPhone) {
    const phone = String(newPhone || '').trim();
    if (phone && !/^1[0-9]{10}$/.test(phone)) {
      return { success: false, error: '请输入有效的手机号（1 开头的 11 位数字）' };
    }
    const { data, error } = await sb.rpc('change_own_phone', { p_new_phone: phone });
    if (error) {
      return { success: false, error: this.extractRpcMessage(error) };
    }
    // 同步本地缓存
    if (this.currentProfile) {
      this.currentProfile.phone = (data && data.phone) || null;
    }
    return { success: true, phone: (data && data.phone) || null, cleared: !!(data && data.cleared) };
  },

  /**
   * 提取 RPC 函数抛出的异常消息（error.message 为 JSON 字符串）
   */
  extractRpcMessage(err) {
    const raw = err && err.message ? err.message : String(err);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.message) return parsed.message;
    } catch (e) { /* 非 JSON 格式，走下方逻辑 */ }
    return raw.replace(/^PGRST\d+: /, '').replace(/^server message: /i, '') || '操作失败';
  },

  /**
   * 登出
   */
  async logout() {
    await sb.auth.signOut();
    this.currentUser = null;
    this.currentProfile = null;
    App.renderLogin();
  },

  /**
   * 监听认证状态变化
   */
  onAuthStateChange(callback) {
    sb.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
  },

  /**
   * 将 PostgREST/数据库错误码映射为中文提示
   */
  mapDbError(err) {
    const code = err && err.code;
    const msg = err && err.message ? err.message : String(err);
    const map = {
      PGRST116: '数据库中没有找到该用户的配置记录（profiles 表无此账号，请执行 sql/fix.sql 修复）',
      PGRST301: 'profiles 表不存在，请先执行 sql/schema.sql',
      '42P01': '数据表不存在，请先执行 sql/schema.sql',
      '42501': '权限不足，RLS 行级安全策略未正确配置，请重新执行 sql/schema.sql',
      '28P01': '数据库密码错误',
      '3F000': '数据库连接失败，请检查 SUPABASE_URL 配置',
    };
    if (code && map[code]) return map[code];
    if (msg.includes('Could not find the table') || msg.includes('relation') && msg.includes('does not exist')) {
      return 'profiles 表不存在，请先执行 sql/schema.sql';
    }
    if (msg.includes('permission denied') || msg.includes('row-level security')) {
      return '权限不足，RLS 策略未正确配置，请重新执行 sql/schema.sql';
    }
    // 附带原始错误信息便于排查
    return (map[code] || msg) + '（错误码: ' + (code || '未知') + '）';
  },

  /**
   * 将 Supabase 错误消息映射为中文提示
   */
  mapAuthError(msg) {
    const map = {
      'Invalid login credentials': '邮箱或密码错误。请排查：① 该账号是否已在 Supabase 控制台 Authentication → Users 中创建；② 密码是否正确（可在 Users 页面重置密码）；③ 若开启了邮箱确认，需先点击确认邮件后才能登录；④ config.js 中的 Project URL 是否为当前项目的地址',
      'Email not confirmed': '邮箱未验证，请到邮箱中点击确认链接后再登录',
      'Email rate limit exceeded': '尝试次数过多，请稍后再试',
      'User already registered': '该邮箱已注册',
      'Signups not allowed for this instance': '该邮箱尚未创建账号，请先在 Supabase 控制台 Authentication → Users 中添加',
      'Password should be at least 6 characters': '密码长度至少 6 位',
      'New password should be different from the old password': '新密码不能与旧密码相同',
      'User not found': '账号不存在',
    };
    for (const [en, zh] of Object.entries(map)) {
      if (msg.includes(en)) return zh;
    }
    return msg;
  },

  /**
   * 判断当前用户是否为管理员
   */
  isAdmin() {
    return this.currentProfile && this.currentProfile.role === 'admin';
  },

  /**
   * 是否被授予野外施工项目报送权限
   * can_report 独立于角色：部门管理员 / 项目管理员 / 员工账号均可在账号管理中勾选；
   * 超级管理员恒不可报送（数据库触发器兜底）。
   * 旧库未执行 sql/report-permission.sql 时字段为 undefined → false（不影响登录）。
   */
  canReport() {
    return !!(this.currentProfile && this.currentProfile.can_report === true);
  },

  /**
   * 判断当前用户能否查看「管理员界面」（后台）
   * 规则：管理员始终可看；非管理员部门用户根据部门权限决定。
   * 部门权限 can_view_admin 为 null 时，按 needs_report 反推：
   *   - 需要报送月报（needs_report=true）→ 不可看
   *   - 不需要报送（needs_report=false）→ 可看（只读）
   * 显式 true/false 优先于默认规则。
   * @returns {boolean}
   */
  canViewAdmin() {
    if (this.isAdmin()) return true;
    if (!this.currentProfile) return false;
    const d = this.currentProfile.departments;
    if (!d) return false;
    if (d.can_view_admin === true) return true;
    if (  d.can_view_admin === false) return false;
    // 默认跟随 needs_report 反向：不报送的部门默认可看（只读）
    return d.needs_report === false;
  },

  /**
   * 判断当前用户是否为超级管理员
   * 超级管理员 = 管理员角色 + is_super_admin 标记（可创建/删除管理员账号）
   * 旧库未执行 super-admin.sql 时该字段不存在，返回 false（不报错）
   */
  isSuperAdmin() {
    return this.isAdmin() && this.currentProfile.is_super_admin === true;
  },

  /** 当前账号层级：company / dept / project / null（未设置） */
  adminLevel() {
    return (this.currentProfile || {}).admin_level || null;
  },

  /** 公司级（安全生产部 / 超级管理员） */
  isCompanyAdmin() {
    if (!this.isAdmin()) return false;
    if (this.isSuperAdmin()) return true;
    return this.adminLevel() === 'company';
  },

  /**
   * 判断当前用户是否为「经营实体管理员」
   * 经营实体管理员 = 管理员账号，所属部门 dept_type = 'entity'，且层级不是 company。
   * （安全生产部设为 company 级后不会被误判为经营实体）
   * 具备在本部门下新建 / 编辑 / 删除「项目部」、并指定「项目部管理员」的权限。
   * 旧库未执行 department-tree.sql 时 departments 无 dept_type 列 → 返回 false。
   * @returns {boolean}
   */
  isEntityManager() {
    if (!this.isAdmin()) return false;
    if (this.isCompanyAdmin()) return false;
    const d = this.currentProfile && this.currentProfile.departments;
    return !!(d && d.dept_type === 'entity');
  },

  /**
   * 获取当前用户的部门名称
   */
  getDepartmentName() {
    if (this.currentProfile && this.currentProfile.departments) {
      return this.currentProfile.departments.name;
    }
    return '未分配';
  },
};

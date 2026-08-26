-- ==========================================================================
-- 施工项目月报管理系统 - 账号管理 RPC 函数
-- ==========================================================================
-- 功能：管理员在页面上 增/改/删 部门账号
--   create_dept_user()  创建部门账号（auth 用户 + profile）
--   update_dept_user()  修改账号（邮箱/姓名/部门/角色/密码）
--   delete_dept_user()  删除账号
--
-- 安全设计：
--   1. 三个函数均为 SECURITY DEFINER（以定义者=postgres 权限执行，可操作 auth 表）
--   2. 函数体内用 public.is_admin() 校验调用者必须是管理员，否则拒绝
--   3. 前端使用 anon key 调用 RPC 即可，无需暴露 service_role key
--   4. 禁止修改/删除当前登录的管理员账号（防止把自己锁在系统外）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 创建部门账号
--    参数：
--      p_email          登录邮箱（必填）
--      p_password       初始密码（必填，至少 6 位）
--      p_full_name      账号名称/姓名（可选，可后续修改）
--      p_department_id  所属部门 ID（部门账号必填；管理员可不填）
--      p_role           'reporter'（部门账号）或 'admin'（管理员），默认 reporter
--    返回：{"success": true, "user_id": "..."} 或抛出中文异常
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_dept_user(
  p_email          TEXT,
  p_password       TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 输入校验
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION '邮箱不能为空';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION '密码长度至少 6 位';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'reporter') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_role = 'reporter' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '部门账号必须分配部门';
  END IF;

  -- 创建 auth 用户（bcrypt 密码哈希，邮箱确认置为已完成）
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    lower(trim(p_email)),
    crypt(p_password, gen_salt('bf', 10)),
    now(),
    '', '',
    '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(), now()
  )
  RETURNING id INTO v_user_id;

  -- 创建/补全对应 profile：
  -- 触发器 on_auth_user_created 在插入 auth.users 后会自动建一条 profile（仅 id+email），
  -- 此处用 ON CONFLICT (id) DO UPDATE 覆盖字段，避免与触发器重复插入同 id 触发主键冲突
  -- （否则会被 unique_violation 通用异常误报"邮箱已被其他账号使用"）。
  INSERT INTO public.profiles (id, email, department_id, role, full_name)
  VALUES (v_user_id, lower(trim(p_email)), p_department_id, p_role, p_full_name)
  ON CONFLICT (id) DO UPDATE SET
    email         = EXCLUDED.email,
    department_id = EXCLUDED.department_id,
    role          = EXCLUDED.role,
    full_name     = EXCLUDED.full_name;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
END;
$$;

-- --------------------------------------------------------------------------
-- 2. 修改账号（邮箱 / 姓名 / 部门 / 角色 / 密码）
--    参数：
--      p_user_id       要修改的用户 ID（必填）
--      p_email         新登录邮箱（必填）
--      p_full_name     新姓名（可选）
--      p_department_id 新部门 ID（部门账号必填）
--      p_role          新角色 'reporter' | 'admin'
--      p_password      新密码（可选；传 NULL 或空串则不修改密码）
--    返回：{"success": true}
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_dept_user(
  p_user_id        UUID,
  p_email          TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter',
  p_password       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_email TEXT;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 禁止修改当前登录的管理员（防止把自己降级/改锁在系统外）
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能修改当前登录的管理员账号';
  END IF;

  -- 校验输入
  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION '邮箱不能为空';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'reporter') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_role = 'reporter' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '部门账号必须分配部门';
  END IF;

  v_email := lower(trim(p_email));

  -- 更新 auth 用户（邮箱；密码仅在传入时更新）
  UPDATE auth.users
  SET email = v_email,
      encrypted_password = CASE
        WHEN p_password IS NOT NULL AND p_password <> '' THEN crypt(p_password, gen_salt('bf', 10))
        ELSE encrypted_password
      END,
      updated_at = now()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 更新 profile（姓名 / 部门 / 角色 / 邮箱）
  UPDATE public.profiles
  SET email = v_email,
      full_name = p_full_name,
      department_id = p_department_id,
      role = p_role,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
END;
$$;

-- --------------------------------------------------------------------------
-- 3. 删除部门账号
--    参数：
--      p_user_id  要删除的用户 ID（必填）
--    返回：{"success": true}
--    注意：会级联删除该账号的 profile；其历史报送记录保留（报送人置空）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_dept_user(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 禁止删除自己
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能删除当前登录的管理员账号';
  END IF;

  -- 历史报送记录的"报送人"置空（submitted_by 外键无 ON DELETE，需先解除引用）
  UPDATE public.project_reports
  SET submitted_by = NULL
  WHERE submitted_by = p_user_id;

  -- 删除 auth 用户（profiles 表 ON DELETE CASCADE 自动级联删除）
  DELETE FROM auth.users WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 4. 授权：允许已登录用户（authenticated）调用 RPC
--    实际权限由函数体内的 is_admin() 校验控制
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_dept_user(TEXT, TEXT, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_dept_user(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dept_user(UUID) TO authenticated;

-- ==========================================================================
-- 验证：执行以下查询确认三个函数已创建
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--          AND proname IN ('create_dept_user', 'update_dept_user', 'delete_dept_user');
-- ==========================================================================

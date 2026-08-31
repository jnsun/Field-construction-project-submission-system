-- ==========================================================================
-- 施工项目月报管理系统 - 超级管理员（Super Admin）
-- ==========================================================================
-- 功能：
--   1. profiles 表新增 is_super_admin 列（BOOLEAN，默认 false）
--      角色体系变为三层：
--        'admin' + is_super_admin=true  → 超级管理员（可创建/删除/修改管理员账号）
--        'admin' + is_super_admin=false → 普通管理员（仅可管理部门账号与报送配置等）
--        'reporter'                      → 部门账号
--   2. 新增 public.is_super_admin() 权限判断函数（SECURITY DEFINER）
--   3. 收紧账号管理 RPC（create/update/delete_dept_user）：
--      - 创建管理员账号          → 仅超级管理员
--      - 修改管理员账号          → 仅超级管理员
--      - 把普通账号提升为管理员  → 仅超级管理员
--      - 删除管理员账号          → 仅超级管理员
--      - 禁止删除最后一个超级管理员
--   4. 移除 profiles 表的"用户可更新自己的 profile"策略：
--      原策略无 WITH CHECK 限制，任意用户可自行 UPDATE 自己的
--      role / is_super_admin 列实现提权，必须移除。
--      （自助修改邮箱走 change_own_email RPC，SECURITY DEFINER，不受影响）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行。
--
-- 如何设置第一个超级管理员（将某管理员提升为超级管理员）：
--   UPDATE public.profiles
--   SET is_super_admin = true
--   WHERE email = 'admin@company.com';
--
-- 如何撤销超级管理员：
--   UPDATE public.profiles
--   SET is_super_admin = false
--   WHERE email = 'admin@company.com';
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. is_super_admin 列（幂等）
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- 历史数据兜底：NULL 视为普通管理员
UPDATE public.profiles
SET is_super_admin = false
WHERE is_super_admin IS NULL;

-- --------------------------------------------------------------------------
-- 2. 超级管理员判断函数（SECURITY DEFINER 绕过 RLS，避免策略递归）
--    仅当账号角色为管理员且被标记为超级管理员时才返回 true
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND is_super_admin = true
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 3. 收紧账号管理 RPC 函数
-- --------------------------------------------------------------------------

-- 3.1 创建账号
--     仅超级管理员可创建管理员账号；新创建的管理员默认是普通管理员
CREATE OR REPLACE FUNCTION public.create_dept_user(
  p_email          TEXT,
  p_password       TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter',
  p_admin_level    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id   UUID;
  v_my_dept   UUID;
  v_my_level  TEXT;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 解析当前账号的部门与级别
  SELECT department_id, COALESCE(admin_level, 'company')
    INTO v_my_dept, v_my_level
  FROM public.profiles WHERE id = auth.uid();

  -- 权限判定
  IF public.is_super_admin() THEN
    NULL; -- 超级管理员：任意账号
  ELSIF public.is_entity_manager() THEN
    -- 经营实体：只能建本部门/项目部下的部门账号，或本部门下项目部的项目部管理员
    IF p_role = 'admin' THEN
      IF p_admin_level IS DISTINCT FROM 'project' THEN
        RAISE EXCEPTION '经营实体只能指定「项目部管理员」';
      END IF;
      IF p_department_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.departments
        WHERE id = p_department_id AND dept_type = 'project' AND parent_id = v_my_dept
      ) THEN
        RAISE EXCEPTION '项目部管理员必须归属您本部门下的项目部';
      END IF;
    ELSE
      IF p_department_id IS NULL OR NOT (
        p_department_id = v_my_dept
        OR EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id AND parent_id = v_my_dept)
      ) THEN
        RAISE EXCEPTION '部门账号必须归属您本部门或本部门下的项目部';
      END IF;
    END IF;
  ELSE
    -- 普通管理员（非经营实体）：仍只能建部门账号
    IF p_role = 'admin' THEN
      RAISE EXCEPTION '只有超级管理员才能创建管理员账号';
    END IF;
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
  -- 新创建的管理员默认 is_super_admin = false（普通管理员）
  INSERT INTO public.profiles (id, email, department_id, role, full_name, is_super_admin, admin_level)
  VALUES (v_user_id, lower(trim(p_email)), p_department_id, p_role, p_full_name, false,
          CASE WHEN p_role = 'admin' THEN p_admin_level ELSE NULL END)
  ON CONFLICT (id) DO UPDATE SET
    email          = EXCLUDED.email,
    department_id  = EXCLUDED.department_id,
    role           = EXCLUDED.role,
    full_name      = EXCLUDED.full_name,
    is_super_admin = EXCLUDED.is_super_admin,
    admin_level    = EXCLUDED.admin_level;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
END;
$$;

-- 3.2 修改账号
--     目标账号是管理员（当前为 admin 或改为 admin）时，仅超级管理员可操作
CREATE OR REPLACE FUNCTION public.update_dept_user(
  p_user_id        UUID,
  p_email          TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter',
  p_password       TEXT DEFAULT NULL,
  p_admin_level    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_email        TEXT;
  v_cur_role     TEXT;
  v_cur_admin    TEXT;
  v_is_super     BOOLEAN;
  v_super_count  INTEGER;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 禁止修改当前登录的管理员（防止把自己降级/改锁在系统外）
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能修改当前登录的管理员账号';
  END IF;

  -- 读取目标账号当前角色与超级管理员标记
  SELECT role, coalesce(admin_level, 'project'), coalesce(is_super_admin, false)
    INTO v_cur_role, v_cur_admin, v_is_super
  FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 涉及管理员账号（当前是管理员，或将改为管理员）时的权限
  IF (v_cur_role = 'admin' OR p_role = 'admin') THEN
    IF public.is_super_admin() THEN
      NULL;
    ELSIF public.is_entity_manager() THEN
      -- 经营实体只能改「本部门下项目部的项目部管理员」
      IF p_role = 'admin' AND p_admin_level IS DISTINCT FROM 'project' THEN
        RAISE EXCEPTION '经营实体只能指定「项目部管理员」';
      END IF;
      IF p_department_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.departments d
        WHERE d.id = p_department_id
          AND d.dept_type = 'project'
          AND d.parent_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
      ) THEN
        RAISE EXCEPTION '项目部管理员必须归属您本部门下的项目部';
      END IF;
      IF v_cur_role = 'admin' AND v_cur_admin <> 'project' THEN
        RAISE EXCEPTION '您只能修改本部门下项目部的项目部管理员';
      END IF;
    ELSE
      RAISE EXCEPTION '只有超级管理员才能修改管理员账号';
    END IF;
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

  -- 保护：不能把最后一个超级管理员降级为部门账号（否则系统将失去超级管理员）
  IF v_is_super AND p_role <> 'admin' THEN
    SELECT count(*) INTO v_super_count
    FROM public.profiles
    WHERE role = 'admin' AND is_super_admin = true;
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '不能降级最后一个超级管理员，请先设置其他超级管理员';
    END IF;
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

  -- 更新 profile（姓名 / 部门 / 角色 / 邮箱）
  -- 降级为部门账号时同步清除超级管理员标记（防止残留提升权限）
  UPDATE public.profiles
  SET email = v_email,
      full_name = p_full_name,
      department_id = p_department_id,
      role = p_role,
      is_super_admin = CASE WHEN p_role <> 'admin' THEN false ELSE is_super_admin END,
      admin_level = CASE WHEN p_role <> 'admin' THEN NULL ELSE COALESCE(p_admin_level, admin_level) END,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
END;
$$;

-- 3.3 删除账号
--     删除管理员账号时，仅超级管理员可操作
CREATE OR REPLACE FUNCTION public.delete_dept_user(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_cur_role     TEXT;
  v_is_super     BOOLEAN;
  v_super_count  INTEGER;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 禁止删除自己
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能删除当前登录的管理员账号';
  END IF;

  -- 读取目标账号角色
  SELECT role, coalesce(is_super_admin, false) INTO v_cur_role, v_is_super
  FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 删除管理员账号：仅超级管理员可操作
  IF v_cur_role = 'admin' AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION '只有超级管理员才能删除管理员账号';
  END IF;

  -- 保护：不能删除最后一个超级管理员
  IF v_is_super THEN
    SELECT count(*) INTO v_super_count
    FROM public.profiles
    WHERE role = 'admin' AND is_super_admin = true;
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '不能删除最后一个超级管理员，请先设置其他超级管理员';
    END IF;
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
-- 4. 移除"用户可更新自己的 profile"策略（防提权漏洞）
--    - 原策略无 WITH CHECK：任意用户可 UPDATE 自己的 role / is_super_admin
--      自行提升为管理员甚至超级管理员
--    - 自助修改邮箱走 public.change_own_email()（SECURITY DEFINER），
--      自助修改密码走 auth API，均不依赖该策略，移除后功能不受影响
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;

-- --------------------------------------------------------------------------
-- 5. 授权（函数签名未变，权限授予保持与 user-management.sql 一致）
--    实际权限由函数体内的 is_admin() / is_super_admin() 校验控制
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_dept_user(TEXT, TEXT, TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_dept_user(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dept_user(UUID) TO authenticated;

-- ==========================================================================
-- 验证：执行以下查询确认列与函数已就绪
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'profiles'
--     AND column_name = 'is_super_admin';
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('is_super_admin', 'create_dept_user', 'update_dept_user', 'delete_dept_user');
-- ==========================================================================

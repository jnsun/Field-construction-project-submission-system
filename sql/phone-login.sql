-- ==========================================================================
-- 施工项目月报管理系统 - 手机号登录 + 自助修改手机号
-- ==========================================================================
-- 功能：
--   1. profiles 表新增 phone 列（TEXT，手机号，可选）
--      并建立部分唯一索引（非空手机号全系统唯一）
--   2. resolve_login_identifier() 升级：登录支持 邮箱 / 手机号 / 部门名称 /
--      部门编码 四种标识符（手机号 → 解析为对应账号的登录邮箱）
--   3. change_own_phone()：已登录用户自助修改自己的手机号
--      （校验格式 + 唯一性）
--   4. create_dept_user / update_dept_user 增加 p_phone 参数：
--      管理员创建/编辑账号时可一并填写手机号
--      同时优化"邮箱已被使用"提示 —— 明确告知被哪个账号占用及处理方式
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行。
--
-- 注意：
--   1. 本脚本会重建 create_dept_user / update_dept_user（签名增加 p_phone），
--      已包含 super-admin.sql 的全部权限收紧逻辑，请在 super-admin.sql
--      之后执行（或直接代替其执行，效果一致）
--   2. 未执行本脚本时，手机号登录不可用、账号管理中不显示手机号字段，
--      其余功能不受影响（旧函数仍按旧签名工作）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. phone 列（幂等）+ 唯一索引
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- 非空手机号唯一（部分唯一索引，NULL/空串不参与唯一性约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_phone
  ON public.profiles (phone)
  WHERE phone IS NOT NULL AND btrim(phone) <> '';

COMMENT ON COLUMN public.profiles.phone IS '手机号（可选，可用于登录）';

-- --------------------------------------------------------------------------
-- 2. 登录标识符解析函数升级：支持 手机号 / 邮箱 / 部门名称 / 部门编码
--    解析顺序：邮箱格式 → 手机号 → 部门编码 → 部门名称
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_login_identifier(p_identifier TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id    TEXT;
  v_dept  TEXT;
  v_email TEXT;
  v_phone TEXT;
BEGIN
  v_id := btrim(coalesce(p_identifier, ''));
  IF v_id = '' THEN
    RAISE EXCEPTION '请输入邮箱、手机号、部门名称或部门编码';
  END IF;

  -- 1) 邮箱格式：直接返回
  IF v_id LIKE '%@%' THEN
    RETURN jsonb_build_object('email', lower(v_id), 'identifier_type', 'email');
  END IF;

  -- 2) 手机号（11 位数字，1 开头）：精确匹配 profiles.phone
  IF v_id ~ '^1[0-9]{10}$' THEN
    SELECT p.email, p.phone INTO v_email, v_phone
    FROM public.profiles p
    WHERE p.phone = v_id
    LIMIT 1;

    IF v_email IS NOT NULL THEN
      RETURN jsonb_build_object(
        'email',           lower(v_email),
        'identifier_type', 'phone',
        'phone',           v_phone
      );
    END IF;

    RAISE EXCEPTION '未找到使用该手机号的账号，请核对手机号，或使用邮箱/部门名称登录';
  END IF;

  -- 3) 部门编码精确匹配（不区分大小写）
  SELECT d.name INTO v_dept
  FROM public.departments d
  WHERE lower(d.code) = lower(v_id)
  LIMIT 1;

  -- 4) 部门名称精确匹配（不区分大小写）
  IF v_dept IS NULL THEN
    SELECT d.name INTO v_dept
    FROM public.departments d
    WHERE lower(d.name) = lower(v_id)
    LIMIT 1;
  END IF;

  IF v_dept IS NULL THEN
    RAISE EXCEPTION '未找到该部门，请核对部门名称或部门编码，或直接使用邮箱/手机号登录';
  END IF;

  -- 5) 取该部门下第一个报送账号的邮箱
  SELECT p.email INTO v_email
  FROM public.profiles p
  WHERE p.department_id = (SELECT id FROM public.departments WHERE name = v_dept)
    AND p.role = 'reporter'
  ORDER BY p.created_at ASC
  LIMIT 1;

  IF v_email IS NULL THEN
    RAISE EXCEPTION '部门「%」下没有可用账号，请联系管理员分配账号', v_dept;
  END IF;

  RETURN jsonb_build_object(
    'email',           lower(v_email),
    'identifier_type', 'department',
    'department_name', v_dept
  );
END;
$$;

-- --------------------------------------------------------------------------
-- 3. 用户自助修改手机号
--    调用者必须是已登录用户本人；校验格式与唯一性后更新 profiles.phone
--    （手机号仅用于登录标识，不改动 auth 登录凭据，无需重新登录）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_own_phone(p_new_phone TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_phone  TEXT;
  v_count  INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '请先登录后再修改手机号';
  END IF;

  v_phone := btrim(coalesce(p_new_phone, ''));

  -- 允许传空串表示清空手机号
  IF v_phone = '' THEN
    UPDATE public.profiles
    SET phone = NULL, updated_at = now()
    WHERE id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION '账号不存在，请联系管理员';
    END IF;
    RETURN jsonb_build_object('success', true, 'phone', NULL, 'cleared', true);
  END IF;

  -- 格式校验（中国大陆手机号：1 开头 11 位）
  IF v_phone !~ '^1[0-9]{10}$' THEN
    RAISE EXCEPTION '请输入有效的手机号（1 开头的 11 位数字）';
  END IF;

  -- 唯一性校验：不能与其他账号的手机号重复
  SELECT count(*) INTO v_count
  FROM public.profiles
  WHERE phone = v_phone AND id <> v_uid;
  IF v_count > 0 THEN
    RAISE EXCEPTION '该手机号已被其他账号使用';
  END IF;

  -- 手机号未变化时直接返回
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND phone = v_phone) THEN
    RETURN jsonb_build_object('success', true, 'phone', v_phone, 'unchanged', true);
  END IF;

  UPDATE public.profiles
  SET phone = v_phone, updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在，请联系管理员';
  END IF;

  RETURN jsonb_build_object('success', true, 'phone', v_phone);
END;
$$;

-- --------------------------------------------------------------------------
-- 4. 重建账号管理 RPC（签名增加 p_phone，默认 NULL = 不设置/不修改）
--    包含 super-admin.sql 的全部权限收紧逻辑；
--    优化"邮箱已被使用"提示：明确告知占用账号的名称/角色/部门及处理方式
--
--    注意：CREATE OR REPLACE 不允许修改函数签名，必须先 DROP 旧签名再重建
-- --------------------------------------------------------------------------

-- 4.0 删除旧签名（幂等）
DROP FUNCTION IF EXISTS public.create_dept_user(TEXT, TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.update_dept_user(UUID, TEXT, TEXT, UUID, TEXT, TEXT);

-- 4.1 创建账号（增加 p_phone）
--    登录邮箱 p_email 改为选填；账号名称 p_full_name 为必填。
--    未填邮箱且填写了手机号时，自动生成占位邮箱（手机号@login.local）以保证底层邮箱登录链路可用，
--    登录方式统一收敛为"邮箱"，前端用手机号即可解析到该占位邮箱完成登录。
CREATE OR REPLACE FUNCTION public.create_dept_user(
  p_email          TEXT,
  p_password       TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter',
  p_phone          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_id     UUID;
  v_phone       TEXT;
  v_email       TEXT;
  v_login_email TEXT;
  v_owner       TEXT;
  v_count       INTEGER;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 创建管理员账号：仅超级管理员可操作
  IF p_role = 'admin' AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION '只有超级管理员才能创建管理员账号';
  END IF;

  -- 输入校验：账号名称（姓名）为必填项；登录邮箱改为选填
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION '账号名称不能为空';
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

  -- 手机号校验（可选）：格式 + 唯一性
  v_phone := NULLIF(btrim(coalesce(p_phone, '')), '');
  IF v_phone IS NOT NULL THEN
    IF v_phone !~ '^1[0-9]{10}$' THEN
      RAISE EXCEPTION '请输入有效的手机号（1 开头的 11 位数字）';
    END IF;
    SELECT count(*) INTO v_count FROM public.profiles WHERE phone = v_phone;
    IF v_count > 0 THEN
      RAISE EXCEPTION '该手机号已被其他账号使用';
    END IF;
  END IF;

  -- 解析登录邮箱：未填写邮箱时，用手机号生成占位邮箱（保证底层邮箱登录链路可用）
  v_email := NULLIF(lower(btrim(coalesce(p_email, ''))), '');
  IF v_email IS NOT NULL THEN
    v_login_email := v_email;
  ELSIF v_phone IS NOT NULL THEN
    v_login_email := v_phone || '@login.local';
  ELSE
    RAISE EXCEPTION '请至少填写登录邮箱或手机号，以便账号登录';
  END IF;

  -- 邮箱占用预检查（仅当用户填写了真实邮箱时校验）
  IF v_email IS NOT NULL THEN
    SELECT coalesce(p.full_name, '') || '（' ||
           CASE p.role WHEN 'admin' THEN '管理员' ELSE '部门账号-' || coalesce(d.name, '未分配部门') END ||
           '）' INTO v_owner
    FROM public.profiles p
    LEFT JOIN public.departments d ON d.id = p.department_id
    WHERE lower(p.email) = v_email
    LIMIT 1;

    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION '邮箱「%」已被账号 % 使用。如需调整该账号角色，请在账号管理中「编辑」该账号；如需新建账号请更换邮箱',
        v_email, v_owner;
    END IF;

    -- auth.users 中已有该邮箱（残留数据：无 profile 的孤儿用户）时单独提示
    SELECT count(*) INTO v_count FROM auth.users WHERE lower(email) = v_email;
    IF v_count > 0 THEN
      RAISE EXCEPTION '邮箱「%」在认证系统中已存在但没有对应账号（可能是残留数据）。请到 Supabase 控制台 Authentication → Users 删除该邮箱的旧记录后重试',
        v_email;
    END IF;
  END IF;

  -- 创建 auth 用户（bcrypt 密码哈希，邮箱/手机号确认置为已完成）
  -- 未填邮箱时 email 使用占位邮箱（v_login_email），providers 相应设为 phone
  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, phone,
    encrypted_password,
    email_confirmed_at, phone_confirmed_at,
    confirmation_token, recovery_token,
    email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    v_login_email,
    v_phone,
    crypt(p_password, gen_salt('bf', 10)),
    now(),
    CASE WHEN v_phone IS NOT NULL THEN now() ELSE NULL END,
    '', '',
    '', '',
    CASE WHEN v_email IS NOT NULL
         THEN '{"provider":"email","providers":["email"]}'::jsonb
         ELSE '{"provider":"phone","providers":["phone"]}'::jsonb
    END,
    '{}'::jsonb,
    now(), now()
  )
  RETURNING id INTO v_user_id;

  -- 创建/补全对应 profile：
  -- 注意：触发器 on_auth_user_created 在插入 auth.users 后会自动建一条 profile（仅 id+email），
  -- 若此处再显式 INSERT 同 id 会触发主键冲突（unique_violation）被通用异常误报"邮箱或手机号已占用"。
  -- 因此用 ON CONFLICT (id) DO UPDATE：触发器已建则覆盖部门/角色/姓名/手机号，未建则插入，
  -- 两种情况下都不冲突，且幂等安全。
  -- 新创建的管理员默认 is_super_admin = false（普通管理员）
  INSERT INTO public.profiles (id, email, department_id, role, full_name, is_super_admin, phone)
  VALUES (v_user_id, v_login_email, p_department_id, p_role, p_full_name, false, v_phone)
  ON CONFLICT (id) DO UPDATE SET
    email          = EXCLUDED.email,
    department_id  = EXCLUDED.department_id,
    role           = EXCLUDED.role,
    full_name      = EXCLUDED.full_name,
    is_super_admin = EXCLUDED.is_super_admin,
    phone          = EXCLUDED.phone;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱或手机号已被其他账号使用';
END;
$$;

-- 4.2 修改账号（增加 p_phone；NULL = 保持原手机号不变，空串 = 清空）
CREATE OR REPLACE FUNCTION public.update_dept_user(
  p_user_id        UUID,
  p_email          TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'reporter',
  p_password       TEXT DEFAULT NULL,
  p_phone          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_email        TEXT;
  v_login_email  TEXT;
  v_cur_role     TEXT;
  v_is_super     BOOLEAN;
  v_super_count  INTEGER;
  v_phone        TEXT;
  v_owner        TEXT;
  v_count        INTEGER;
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
  SELECT role, coalesce(is_super_admin, false) INTO v_cur_role, v_is_super
  FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 涉及管理员账号（当前是管理员，或将改为管理员）时，仅超级管理员可操作
  IF (v_cur_role = 'admin' OR p_role = 'admin') AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION '只有超级管理员才能修改管理员账号';
  END IF;

  -- 校验输入：账号名称必填；登录邮箱改为选填
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION '账号名称不能为空';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'reporter') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_role = 'reporter' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '部门账号必须分配部门';
  END IF;

  -- 保护：不能把最后一个超级管理员降级为部门账号
  IF v_is_super AND p_role <> 'admin' THEN
    SELECT count(*) INTO v_super_count
    FROM public.profiles
    WHERE role = 'admin' AND is_super_admin = true;
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '不能降级最后一个超级管理员，请先设置其他超级管理员';
    END IF;
  END IF;

  -- 手机号校验（p_phone 为 NULL 表示不修改；空串表示清空）
  IF p_phone IS NULL THEN
    SELECT phone INTO v_phone FROM public.profiles WHERE id = p_user_id;
  ELSE
    v_phone := NULLIF(btrim(p_phone), '');
    IF v_phone IS NOT NULL THEN
      IF v_phone !~ '^1[0-9]{10}$' THEN
        RAISE EXCEPTION '请输入有效的手机号（1 开头的 11 位数字）';
      END IF;
      SELECT count(*) INTO v_count
      FROM public.profiles
      WHERE phone = v_phone AND id <> p_user_id;
      IF v_count > 0 THEN
        RAISE EXCEPTION '该手机号已被其他账号使用';
      END IF;
    END IF;
  END IF;

  -- 解析登录邮箱：未填写邮箱时，用手机号生成占位邮箱（保证底层邮箱登录链路可用）
  v_email := NULLIF(lower(btrim(coalesce(p_email, ''))), '');
  IF v_email IS NOT NULL THEN
    v_login_email := v_email;
  ELSIF v_phone IS NOT NULL THEN
    v_login_email := v_phone || '@login.local';
  ELSE
    RAISE EXCEPTION '请至少保留一种登录方式（邮箱或手机号）';
  END IF;

  -- 邮箱占用预检查（仅当用户填写了真实邮箱时校验）
  IF v_email IS NOT NULL THEN
    SELECT coalesce(p.full_name, '') || '（' ||
           CASE p.role WHEN 'admin' THEN '管理员' ELSE '部门账号-' || coalesce(d.name, '未分配部门') END ||
           '）' INTO v_owner
    FROM public.profiles p
    LEFT JOIN public.departments d ON d.id = p.department_id
    WHERE lower(p.email) = v_email
      AND p.id <> p_user_id
    LIMIT 1;

    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION '邮箱「%」已被账号 % 使用，请更换邮箱',
        v_email, v_owner;
    END IF;
  END IF;

  -- 更新 auth 用户（邮箱 / 手机号；密码仅在传入时更新）
  UPDATE auth.users
  SET email = v_login_email,
      phone = v_phone,
      phone_confirmed_at = CASE WHEN v_phone IS NOT NULL THEN now() ELSE NULL END,
      encrypted_password = CASE
        WHEN p_password IS NOT NULL AND p_password <> '' THEN crypt(p_password, gen_salt('bf', 10))
        ELSE encrypted_password
      END,
      updated_at = now()
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 更新 profile（姓名 / 部门 / 角色 / 邮箱 / 手机号）
  -- 降级为部门账号时同步清除超级管理员标记（防止残留提升权限）
  UPDATE public.profiles
  SET email = v_login_email,
      full_name = p_full_name,
      department_id = p_department_id,
      role = p_role,
      is_super_admin = CASE WHEN p_role <> 'admin' THEN false ELSE is_super_admin END,
      phone = v_phone,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱或手机号已被其他账号使用';
END;
$$;

-- 4.3 删除账号（签名未变，重建一次确保最新逻辑存在）
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
-- 5. 权限授予（新签名）
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.resolve_login_identifier(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_own_phone(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_own_email(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_dept_user(TEXT, TEXT, TEXT, UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_dept_user(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dept_user(UUID) TO authenticated;

-- ==========================================================================
-- 验证：执行以下查询确认就绪
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'profiles'
--     AND column_name = 'phone';
--   SELECT proname, pg_get_function_identity_arguments(oid)
--   FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('resolve_login_identifier', 'change_own_phone',
--                     'create_dept_user', 'update_dept_user');
-- ==========================================================================

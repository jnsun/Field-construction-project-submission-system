-- ============================================================================
-- login-account.sql
-- 登录标识符解析 + 用户自助修改邮箱
-- ----------------------------------------------------------------------------
-- 功能：
--   1. resolve_login_identifier()：登录时支持 邮箱 / 部门名称 / 部门编码
--      三种标识符，函数将其解析为实际登录邮箱（部门账号）
--   2. change_own_email()：已登录用户修改自己的登录邮箱（同步 auth.users
--      与 profiles，并校验邮箱唯一性）
-- ----------------------------------------------------------------------------
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴全部内容执行（幂等可重复执行）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 登录标识符解析函数
--    前端登录时输入任意一种标识符，该函数返回对应的邮箱用于密码认证
-- ----------------------------------------------------------------------------
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
BEGIN
  v_id := btrim(coalesce(p_identifier, ''));
  IF v_id = '' THEN
    RAISE EXCEPTION '请输入邮箱、部门名称或部门编码';
  END IF;

  -- 1) 邮箱格式：直接返回
  IF v_id LIKE '%@%' THEN
    RETURN jsonb_build_object('email', lower(v_id), 'identifier_type', 'email');
  END IF;

  -- 2) 部门编码精确匹配（不区分大小写）
  SELECT d.name INTO v_dept
  FROM public.departments d
  WHERE lower(d.code) = lower(v_id)
  LIMIT 1;

  -- 3) 部门名称精确匹配（不区分大小写）
  IF v_dept IS NULL THEN
    SELECT d.name INTO v_dept
    FROM public.departments d
    WHERE lower(d.name) = lower(v_id)
    LIMIT 1;
  END IF;

  IF v_dept IS NULL THEN
    RAISE EXCEPTION '未找到该部门，请核对部门名称或部门编码，或直接使用邮箱登录';
  END IF;

  -- 4) 取该部门下第一个报送账号的邮箱
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

-- ----------------------------------------------------------------------------
-- 2. 用户自助修改邮箱（登录名）
--    调用者必须是已登录用户本人；校验新邮箱唯一性后同步更新
--    auth.users（登录凭据）与 public.profiles（用户资料）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_own_email(p_new_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_email  TEXT;
  v_count  INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '请先登录后再修改邮箱';
  END IF;

  v_email := lower(btrim(coalesce(p_new_email, '')));

  -- 格式校验
  IF v_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
    RAISE EXCEPTION '请输入有效的邮箱地址';
  END IF;

  -- 唯一性校验：auth.users 中的其他账号
  SELECT count(*) INTO v_count
  FROM auth.users
  WHERE lower(email) = v_email AND id <> v_uid;
  IF v_count > 0 THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
  END IF;

  -- 唯一性校验：profiles 中的其他账号
  SELECT count(*) INTO v_count
  FROM public.profiles
  WHERE lower(coalesce(email, '')) = v_email AND id <> v_uid;
  IF v_count > 0 THEN
    RAISE EXCEPTION '该邮箱已被其他账号使用';
  END IF;

  -- 邮箱未变化时直接返回
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND lower(email) = v_email) THEN
    RETURN jsonb_build_object('success', true, 'email', v_email, 'unchanged', true);
  END IF;

  -- 更新登录凭据（auth.users）
  UPDATE auth.users
  SET email = v_email,
      raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                           || jsonb_build_object('email', v_email),
      updated_at = now()
  WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在，请联系管理员';
  END IF;

  -- 同步用户资料（profiles）
  UPDATE public.profiles
  SET email = v_email, updated_at = now()
  WHERE id = v_uid;

  RETURN jsonb_build_object('success', true, 'email', v_email);
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. 权限授予
--    resolve_login_identifier：已停用，统一使用邮箱登录，避免匿名枚举账号
--    change_own_email：仅限已登录用户
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.resolve_login_identifier(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_login_identifier(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_own_email(TEXT) TO authenticated;

-- ==========================================================================
-- 账号管理 RPC 最终版（v2）：手机号登录 + 三级管理员级别 + 经营实体授权
-- ==========================================================================
-- 【为什么需要这个文件】
--   历史上账号 RPC 被三个脚本先后改过，签名互相冲突：
--     user-management.sql : create_dept_user(email,password,name,dept,role)          5 参
--     phone-login.sql     : create_dept_user(... , p_phone)                          6 参
--     super-admin.sql     : create_dept_user(... , p_admin_level)                    6 参  ← 与上一行同参数个数、参数名不同
--   PostgreSQL 的 CREATE OR REPLACE 不允许改参数名，于是报：
--     ERROR 42P13 cannot change name of input parameter "p_phone"
--   若直接 DROP 后跑 super-admin.sql，会把手机号登录（p_phone）逻辑整体丢掉。
--
--   本文件是唯一权威版本：把 p_phone 与 p_admin_level 合并进同一套签名，
--   同时包含 phone-login.sql 的全部手机号/占位邮箱逻辑 + 超级管理员权限收紧
--   + 经营实体管理员可指定项目部管理员。
--
--   最终签名：
--     create_dept_user(p_email, p_password, p_full_name, p_department_id,
--                      p_role, p_phone, p_admin_level)                       7 参
--     update_dept_user(p_user_id, p_email, p_full_name, p_department_id,
--                      p_role, p_password, p_phone, p_admin_level)           8 参
--     delete_dept_user(p_user_id)                                            1 参
--
-- 【执行顺序（依赖）】
--   1) user-management.sql / phone-login.sql   —— 基础表与手机号列
--   2) super-admin.sql                          —— is_super_admin 列与函数
--   3) training-management.sql                  —— profiles.admin_level 列
--   4) department-tree.sql                      —— departments.parent_id / dept_type
--   5) department-entity-permissions.sql        —— is_company_admin() / is_entity_manager()
--   6) ★ 本文件（account-rpc-v2.sql）           —— 最后执行，覆盖账号 RPC
--
-- 执行方法：Supabase SQL Editor -> 粘贴全部 -> Run。幂等，可重复执行。
-- 云端库与服务器自建库都要各跑一次。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 前置依赖自检：缺依赖时明确报错，避免建出跑不通的函数
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION '缺少 public.is_admin()，请先执行 sql/user-management.sql';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '缺少 public.is_super_admin()，请先执行 sql/super-admin.sql';
  END IF;
  IF to_regprocedure('public.is_entity_manager()') IS NULL
     OR to_regprocedure('public.is_company_admin()') IS NULL THEN
    RAISE EXCEPTION '缺少 public.is_entity_manager() / public.is_company_admin()，请先执行 sql/department-entity-permissions.sql';
  END IF;
END $$;

-- 兜底补列（正常应由 training-management.sql / phone-login.sql 建好）
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'admin_level'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN admin_level TEXT CHECK (admin_level IN ('company', 'dept', 'project'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1. 清除全部历史重载（按实际签名动态 DROP，不用猜）
--    CREATE OR REPLACE 无法改参数名/参数个数，必须先 DROP
-- --------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('create_dept_user', 'update_dept_user', 'delete_dept_user')
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig::text || ' CASCADE';
  END LOOP;
END $$;

-- --------------------------------------------------------------------------
-- 1.5 可管理部门范围（本部门 + 全部下级，递归 parent_id 树）
--     部门管理员（经营实体 / 内设机构 / 项目部）管理账号只能落在这个范围内；
--     公司级管理员 / 超级管理员不使用本函数（不受限）。
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_visible_dept_ids()
RETURNS SETOF UUID AS $$
  WITH RECURSIVE tree AS (
    SELECT department_id AS id
    FROM public.profiles
    WHERE id = auth.uid() AND department_id IS NOT NULL
    UNION ALL
    SELECT d.id
    FROM public.departments d
    JOIN tree t ON d.parent_id = t.id
  )
  SELECT id FROM tree
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.account_visible_dept_ids() TO authenticated;

-- --------------------------------------------------------------------------
-- 2. 创建账号
--    权限矩阵：
--      超级管理员        → 任意账号、任意 admin_level
--      经营实体管理员    → 本部门/本部门下项目部的部门账号；
--                          本部门下项目部的「项目部管理员」(admin_level='project')
--      其他部门管理员    → 仅本部门及下级部门的「部门账号」（不能建管理员）
-- --------------------------------------------------------------------------
CREATE FUNCTION public.create_dept_user(
  p_email          TEXT,
  p_password       TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'employee',
  p_phone          TEXT DEFAULT NULL,
  p_admin_level    TEXT DEFAULT NULL
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
  v_my_dept     UUID;
  v_level       TEXT;
BEGIN
  -- 2.1 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();

  -- 2.2 权限判定
  IF public.is_super_admin() OR public.is_company_admin() THEN
    NULL;  -- 公司级：不限
  ELSIF public.is_entity_manager() THEN
    IF p_role = 'admin' THEN
      IF COALESCE(p_admin_level, '') <> 'project' THEN
        RAISE EXCEPTION '经营实体只能指定「项目部管理员」';
      END IF;
      IF p_department_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.departments
        WHERE id = p_department_id
          AND dept_type = 'project'
          AND parent_id = v_my_dept
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
    -- 部门管理员（经营实体以外）：只能为本部门及下级部门创建「部门账号」
    IF p_role = 'admin' THEN
      RAISE EXCEPTION '只有超级管理员才能创建管理员账号';
    END IF;
    IF p_department_id IS NULL OR p_department_id NOT IN (
      SELECT public.account_visible_dept_ids()
    ) THEN
      RAISE EXCEPTION '只能为本部门或本部门下级部门创建账号';
    END IF;
  END IF;

  -- 2.3 输入校验：账号名称必填，登录邮箱选填
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION '账号名称不能为空';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION '密码长度至少 6 位';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'employee') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_role = 'employee' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '员工账号必须分配部门';
  END IF;

  -- 管理员级别：admin 必须给出合法级别（缺省按公司级）；非 admin 一律置空
  IF p_role = 'admin' THEN
    v_level := COALESCE(NULLIF(btrim(coalesce(p_admin_level, '')), ''), 'company');
    IF v_level NOT IN ('company', 'dept', 'project') THEN
      RAISE EXCEPTION '管理员级别不合法（应为 company / dept / project）';
    END IF;
    IF v_level IN ('dept', 'project') AND p_department_id IS NULL THEN
      RAISE EXCEPTION '部门级 / 项目部级管理员必须指定所属部门';
    END IF;
  ELSE
    v_level := NULL;
  END IF;

  -- 2.4 手机号校验（可选）：格式 + 唯一性
  v_phone := NULLIF(btrim(coalesce(p_phone, '')), '');
  IF v_phone IS NOT NULL THEN
    IF v_phone !~ '^1[0-9]{10}$' THEN
      RAISE EXCEPTION '请输入有效的手机号（1 开头的 11 位数字）';
    END IF;
    -- 手机号已被账号档案占用：给出占用人，提示走「编辑」而不是重复开通
    SELECT coalesce(p.full_name, '') || '（' ||
           CASE p.role
             WHEN 'admin' THEN '管理员'
             WHEN 'employee' THEN '员工（培训自助开通）'
             ELSE '部门账号-' || coalesce(d.name, '未分配部门')
           END || '）'
      INTO v_owner
      FROM public.profiles p
      LEFT JOIN public.departments d ON d.id = p.department_id
      WHERE p.phone = v_phone
      LIMIT 1;
    IF v_owner IS NOT NULL THEN
      RAISE EXCEPTION '手机号「%」已被账号 % 使用，不能重复开通。如该账号是本人（例如培训模块自助开通的），请在账号管理列表中「编辑」该账号调整角色/部门；如为他人误填，请更换手机号',
        v_phone, v_owner;
    END IF;
    -- 手机号已被认证系统占用但无档案（残留数据）：明确提示
    SELECT count(*) INTO v_count FROM auth.users WHERE phone = v_phone;
    IF v_count > 0 THEN
      RAISE EXCEPTION '手机号「%」在认证系统中已存在但没有对应账号（可能是残留数据）。请到 Supabase 控制台 Authentication → Users 删除该手机号的旧记录后重试', v_phone;
    END IF;
  END IF;

  -- 2.5 解析登录邮箱：未填邮箱时用手机号生成占位邮箱，保证底层邮箱登录链路可用
  v_email := NULLIF(lower(btrim(coalesce(p_email, ''))), '');
  IF v_email IS NOT NULL THEN
    v_login_email := v_email;
  ELSIF v_phone IS NOT NULL THEN
    v_login_email := v_phone || '@login.local';
  ELSE
    RAISE EXCEPTION '请至少填写登录邮箱或手机号，以便账号登录';
  END IF;

  -- 2.6 邮箱占用预检查（仅当填写了真实邮箱）
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

    SELECT count(*) INTO v_count FROM auth.users WHERE lower(email) = v_email;
    IF v_count > 0 THEN
      RAISE EXCEPTION '邮箱「%」在认证系统中已存在但没有对应账号（可能是残留数据）。请到 Supabase 控制台 Authentication → Users 删除该邮箱的旧记录后重试',
        v_email;
    END IF;
  END IF;

  -- 2.7 创建 auth 用户
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

  -- 2.8 创建/补全 profile
  --     触发器 on_auth_user_created 可能已插入仅含 id+email 的行，
  --     用 ON CONFLICT (id) DO UPDATE 覆盖，避免被误报为"邮箱已占用"
  INSERT INTO public.profiles (
    id, email, department_id, role, full_name, is_super_admin, phone, admin_level
  )
  VALUES (
    v_user_id, v_login_email, p_department_id, p_role, p_full_name, false, v_phone, v_level
  )
  ON CONFLICT (id) DO UPDATE SET
    email          = EXCLUDED.email,
    department_id  = EXCLUDED.department_id,
    role           = EXCLUDED.role,
    full_name      = EXCLUDED.full_name,
    is_super_admin = EXCLUDED.is_super_admin,
    phone          = EXCLUDED.phone,
    admin_level    = EXCLUDED.admin_level;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱或手机号已被其他账号使用';
END;
$$;

-- --------------------------------------------------------------------------
-- 3. 修改账号
--    p_phone       : NULL = 不修改，空串 = 清空
--    p_admin_level : NULL = 保持原级别（角色降为部门账号时自动清空）
-- --------------------------------------------------------------------------
CREATE FUNCTION public.update_dept_user(
  p_user_id        UUID,
  p_email          TEXT,
  p_full_name      TEXT DEFAULT NULL,
  p_department_id  UUID DEFAULT NULL,
  p_role           TEXT DEFAULT 'employee',
  p_password       TEXT DEFAULT NULL,
  p_phone          TEXT DEFAULT NULL,
  p_admin_level    TEXT DEFAULT NULL
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
  v_cur_level    TEXT;
  v_cur_dept     UUID;
  v_is_super     BOOLEAN;
  v_super_count  INTEGER;
  v_phone        TEXT;
  v_owner        TEXT;
  v_count        INTEGER;
  v_my_dept      UUID;
  v_level        TEXT;
BEGIN
  -- 3.1 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 3.2 禁止修改当前登录账号（防止把自己降级/锁在系统外）
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能修改当前登录的管理员账号';
  END IF;

  SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();

  -- 3.3 读取目标账号现状
  SELECT role, admin_level, department_id, coalesce(is_super_admin, false)
    INTO v_cur_role, v_cur_level, v_cur_dept, v_is_super
  FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 3.4 权限判定
  IF public.is_super_admin() OR public.is_company_admin() THEN
    NULL;  -- 公司级：不限
  ELSIF public.is_entity_manager() THEN
    -- 目标必须落在「本部门 + 本部门下项目部」范围内（改前/改后都要满足）
    IF NOT (
      COALESCE(v_cur_dept, '00000000-0000-0000-0000-000000000000'::uuid) = v_my_dept
      OR EXISTS (SELECT 1 FROM public.departments WHERE id = v_cur_dept AND parent_id = v_my_dept)
    ) THEN
      RAISE EXCEPTION '只能修改本部门或本部门下项目部的账号';
    END IF;
    IF p_department_id IS NULL OR NOT (
      p_department_id = v_my_dept
      OR EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id AND parent_id = v_my_dept)
    ) THEN
      RAISE EXCEPTION '账号所属部门必须是本部门或本部门下的项目部';
    END IF;
    -- 涉及管理员账号时，只允许「项目部管理员」这一种
    IF v_cur_role = 'admin' AND COALESCE(v_cur_level, 'company') <> 'project' THEN
      RAISE EXCEPTION '您只能修改本部门下项目部的项目部管理员';
    END IF;
    IF p_role = 'admin' THEN
      IF COALESCE(p_admin_level, v_cur_level, '') <> 'project' THEN
        RAISE EXCEPTION '经营实体只能指定「项目部管理员」';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.departments
        WHERE id = p_department_id AND dept_type = 'project' AND parent_id = v_my_dept
      ) THEN
        RAISE EXCEPTION '项目部管理员必须归属您本部门下的项目部';
      END IF;
    END IF;
  ELSE
    -- 部门管理员（经营实体以外）：只能修改本部门及下级部门的非管理员账号
    -- （含培训自助开通的「员工」账号——编辑升级为部门账号即完成认领）
    IF v_cur_role = 'admin' OR p_role = 'admin' THEN
      RAISE EXCEPTION '只有超级管理员才能修改管理员账号';
    END IF;
    IF COALESCE(v_cur_dept, '00000000-0000-0000-0000-000000000000'::uuid) NOT IN (
      SELECT public.account_visible_dept_ids()
    ) THEN
      RAISE EXCEPTION '只能修改本部门或本部门下级部门的账号';
    END IF;
    IF p_department_id IS NULL OR p_department_id NOT IN (
      SELECT public.account_visible_dept_ids()
    ) THEN
      RAISE EXCEPTION '账号所属部门必须是本部门或本部门下级部门';
    END IF;
  END IF;

  -- 3.5 输入校验
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION '账号名称不能为空';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'employee') THEN
    RAISE EXCEPTION '角色不合法';
  END IF;
  IF p_role = 'employee' AND p_department_id IS NULL THEN
    RAISE EXCEPTION '员工账号必须分配部门';
  END IF;

  -- 管理员级别：未传则沿用原级别，仍为空按公司级
  IF p_role = 'admin' THEN
    v_level := COALESCE(NULLIF(btrim(coalesce(p_admin_level, '')), ''), v_cur_level, 'company');
    IF v_level NOT IN ('company', 'dept', 'project') THEN
      RAISE EXCEPTION '管理员级别不合法（应为 company / dept / project）';
    END IF;
    IF v_level IN ('dept', 'project') AND p_department_id IS NULL THEN
      RAISE EXCEPTION '部门级 / 项目部级管理员必须指定所属部门';
    END IF;
  ELSE
    v_level := NULL;
  END IF;

  -- 3.6 保护：不能把最后一个超级管理员降级
  IF v_is_super AND p_role <> 'admin' THEN
    SELECT count(*) INTO v_super_count
    FROM public.profiles
    WHERE role = 'admin' AND is_super_admin = true;
    IF v_super_count <= 1 THEN
      RAISE EXCEPTION '不能降级最后一个超级管理员，请先设置其他超级管理员';
    END IF;
  END IF;

  -- 3.7 手机号（NULL = 不修改；空串 = 清空）
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

  -- 3.8 解析登录邮箱
  v_email := NULLIF(lower(btrim(coalesce(p_email, ''))), '');
  IF v_email IS NOT NULL THEN
    v_login_email := v_email;
  ELSIF v_phone IS NOT NULL THEN
    v_login_email := v_phone || '@login.local';
  ELSE
    RAISE EXCEPTION '请至少保留一种登录方式（邮箱或手机号）';
  END IF;

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
      RAISE EXCEPTION '邮箱「%」已被账号 % 使用，请更换邮箱', v_email, v_owner;
    END IF;
  END IF;

  -- 3.9 更新 auth 用户
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

  -- 3.10 更新 profile（降级为部门账号时同步清除超管标记与管理员级别）
  UPDATE public.profiles
  SET email = v_login_email,
      full_name = p_full_name,
      department_id = p_department_id,
      role = p_role,
      is_super_admin = CASE WHEN p_role <> 'admin' THEN false ELSE is_super_admin END,
      admin_level = v_level,
      phone = v_phone,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该邮箱或手机号已被其他账号使用';
END;
$$;

-- --------------------------------------------------------------------------
-- 4. 删除账号
--    经营实体管理员：可删本部门 / 本部门下项目部的部门账号与项目部管理员
-- --------------------------------------------------------------------------
CREATE FUNCTION public.delete_dept_user(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_cur_role     TEXT;
  v_cur_level    TEXT;
  v_cur_dept     UUID;
  v_is_super     BOOLEAN;
  v_super_count  INTEGER;
  v_my_dept      UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION '不能删除当前登录的管理员账号';
  END IF;

  SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();

  SELECT role, admin_level, department_id, coalesce(is_super_admin, false)
    INTO v_cur_role, v_cur_level, v_cur_dept, v_is_super
  FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '账号不存在';
  END IF;

  -- 权限判定
  IF public.is_super_admin() OR public.is_company_admin() THEN
    NULL;
  ELSIF public.is_entity_manager() THEN
    IF NOT (
      COALESCE(v_cur_dept, '00000000-0000-0000-0000-000000000000'::uuid) = v_my_dept
      OR EXISTS (SELECT 1 FROM public.departments WHERE id = v_cur_dept AND parent_id = v_my_dept)
    ) THEN
      RAISE EXCEPTION '只能删除本部门或本部门下项目部的账号';
    END IF;
    IF v_cur_role = 'admin' AND COALESCE(v_cur_level, 'company') <> 'project' THEN
      RAISE EXCEPTION '您只能删除本部门下项目部的项目部管理员';
    END IF;
  ELSE
    -- 部门管理员（经营实体以外）：只能删除本部门及下级部门的非管理员账号
    IF v_cur_role = 'admin' THEN
      RAISE EXCEPTION '只有超级管理员才能删除管理员账号';
    END IF;
    IF COALESCE(v_cur_dept, '00000000-0000-0000-0000-000000000000'::uuid) NOT IN (
      SELECT public.account_visible_dept_ids()
    ) THEN
      RAISE EXCEPTION '只能删除本部门或本部门下级部门的账号';
    END IF;
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

  -- 历史报送记录的"报送人"置空（submitted_by 外键无 ON DELETE）
  UPDATE public.project_reports
  SET submitted_by = NULL
  WHERE submitted_by = p_user_id;

  DELETE FROM auth.users WHERE id = p_user_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 5. 授权（新签名）
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_dept_user(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_dept_user(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_dept_user(UUID) TO authenticated;

-- ==========================================================================
-- 验证：确认只剩一份签名，且参数正确
--   SELECT proname, pg_get_function_identity_arguments(oid) AS args
--   FROM pg_proc
--   WHERE pronamespace = 'public'::regnamespace
--     AND proname IN ('create_dept_user','update_dept_user','delete_dept_user')
--   ORDER BY proname;
--
-- 预期输出：
--   create_dept_user | text, text, text, uuid, text, text, text
--   delete_dept_user | uuid
--   update_dept_user | uuid, text, text, uuid, text, text, text, text
-- ==========================================================================

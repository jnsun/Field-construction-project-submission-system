-- ==========================================================================
-- 施工项目月报管理系统 - 部门管理 RPC 函数
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 部门表新增「是否报送野外施工月报」字段（默认报送；非报送部门如子公司/职能部）
-- --------------------------------------------------------------------------
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS needs_report BOOLEAN NOT NULL DEFAULT TRUE;

-- 0.1 部门表新增「可否查看管理员界面」字段
--     NULL = 跟随默认规则（需要报送的部门看不到；不需要报送的部门默认可看）
--     显式 TRUE/FALSE 可覆盖默认规则
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS can_view_admin BOOLEAN DEFAULT NULL;

-- 已有数据中，非报送部门置为 false（子公司 / 管理部门）
UPDATE public.departments
SET needs_report = FALSE
WHERE name IN ('安全生产部', '物化院有限公司', '六勘院有限公司');
-- 功能：管理员在页面上 增/改/删 公司部门
--   create_department()  新增部门（名称 + 排序，编码自动生成）
--   update_department()  修改部门（名称 / 排序）
--   delete_department()  删除部门（有账号或报送记录时阻止，防止数据丢失）
--
-- 安全设计：
--   1. 三个函数均为 SECURITY DEFINER（以定义者=postgres 权限执行）
--   2. 函数体内用 public.is_admin() 校验调用者必须是管理员，否则拒绝
--   3. 前端使用 anon key 调用 RPC 即可，无需暴露 service_role key
--   4. 删除部门前严格检查关联数据：
--        - 该部门下存在账号（profiles）          -> 阻止，提示先转移/删除账号
--        - 该部门下存在报送记录（project_reports）-> 阻止，提示会丢失历史数据
--        （因为 project_reports.department_id 外键是 ON DELETE CASCADE，
--          直接删除会连带删除所有历史报送数据，必须拦截）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 新增部门
--    参数：
--      p_name         部门名称（必填，全局唯一）
--      p_sort_order   排序序号（可选；不传则自动排到最后）
--    返回：{"success": true, "department_id": "..."} 或抛出中文异常
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_department(
  p_name           TEXT,
  p_sort_order     INTEGER DEFAULT NULL,
  p_needs_report   BOOLEAN DEFAULT TRUE,
  p_can_view_admin BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_dept_id   UUID;
  v_sort      INTEGER;
  v_code      TEXT;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 输入校验
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;

  -- 名称去首尾空格
  p_name := trim(p_name);

  -- 排序号：未传则排到当前最后
  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.departments;
  END IF;

  -- 部门编码自动生成（保证唯一）：DEPT- , 前缀 + 随机 6 位大写十六进制
  v_code := 'DEPT-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.departments (name, code, sort_order, needs_report, can_view_admin)
  VALUES (p_name, v_code, v_sort, p_needs_report, p_can_view_admin)
  RETURNING id INTO v_dept_id;

  RETURN jsonb_build_object('success', true, 'department_id', v_dept_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该部门名称已存在';
END;
$$;

-- --------------------------------------------------------------------------
-- 2. 修改部门（名称 / 排序）
--    参数：
--      p_department_id  要修改的部门 ID（必填）
--      p_name           新部门名称（必填，全局唯一）
--      p_sort_order     新排序号（可选；传 NULL 保持原值）
--    返回：{"success": true} 或抛出中文异常
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_department(
  p_department_id   UUID,
  p_name            TEXT,
  p_sort_order      INTEGER DEFAULT NULL,
  p_needs_report    BOOLEAN DEFAULT NULL,
  p_can_view_admin  BOOLEAN DEFAULT NULL
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

  -- 输入校验
  IF p_department_id IS NULL THEN
    RAISE EXCEPTION '部门 ID 不能为空';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;

  UPDATE public.departments
  SET name = trim(p_name),
      sort_order = COALESCE(p_sort_order, sort_order),
      needs_report = COALESCE(p_needs_report, needs_report),
      can_view_admin = COALESCE(p_can_view_admin, can_view_admin)
  WHERE id = p_department_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该部门名称已存在';
END;
$$;

-- --------------------------------------------------------------------------
-- 3. 删除部门
--    参数：
--      p_department_id  要删除的部门 ID（必填）
--    返回：{"success": true} 或抛出中文异常
--    注意：删除前检查关联数据，有任何账号或报送记录都会阻止删除
--          （报送记录外键 ON DELETE CASCADE，直接删除将永久丢失历史数据）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_department(
  p_department_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_user_count   INTEGER;
  v_report_count INTEGER;
BEGIN
  -- 仅管理员可调用
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  -- 部门是否存在
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id) THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  -- 检查该部门下是否有账号
  SELECT COUNT(*) INTO v_user_count
  FROM public.profiles
  WHERE department_id = p_department_id;

  IF v_user_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 个账号，请先在「账号管理」中将账号转移或删除后再删除部门', v_user_count;
  END IF;

  -- 检查该部门下是否有报送记录（外键 ON DELETE CASCADE，删除将丢失历史数据）
  SELECT COUNT(*) INTO v_report_count
  FROM public.project_reports
  WHERE department_id = p_department_id;

  IF v_report_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 条报送记录，删除部门将永久删除这些历史数据。若确需删除，请先联系管理员备份数据', v_report_count;
  END IF;

  DELETE FROM public.departments WHERE id = p_department_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 4. 授权：允许已登录用户（authenticated）调用 RPC
--    实际权限由函数体内的 is_admin() 校验控制
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department(UUID) TO authenticated;

-- ==========================================================================
-- 验证：执行以下查询确认三个函数已创建
--   SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
--          AND proname IN ('create_department', 'update_department', 'delete_department');
-- ==========================================================================

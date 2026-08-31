-- ==========================================================================
-- 部门管理权限（经营实体管理员模型）
-- ==========================================================================
-- 依赖：department-tree.sql（已建 parent_id / dept_type / 三个 RPC 旧签名）
--       training-fix-v13.sql（profiles.admin_level 列已存在）
-- 作用：把「经营实体」从「非管理员部门账号」升级为「管理员」，
--       并让部门 RPC 按两级权限收敛：
--         公司级（安全生产部 / 超级管理员）= 全量
--         经营实体管理员（admin_level='dept'）= 仅本部门下的项目部
-- 执行：Supabase 控制台 → SQL Editor → 粘贴全部 → Run（可重复，幂等）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 公司级判定（与培训 training_is_company_admin 一致：未配 admin_level 兜底公司级）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_company_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND (is_super_admin IS TRUE OR COALESCE(admin_level, 'company') = 'company')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 1. 经营实体管理员判定
--    当前账号是管理员，且所属部门 dept_type='entity'，且级别不是 company
--    （安全生产部设为 company 级后不会被误判为经营实体）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.is_entity_manager();
CREATE OR REPLACE FUNCTION public.is_entity_manager()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND d.dept_type = 'entity'
      AND COALESCE(p.admin_level, 'dept') <> 'company'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 2. create_department：公司级全量；经营实体仅限本部门下项目部
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.create_department(
  p_name           TEXT,
  p_sort_order     INTEGER DEFAULT NULL,
  p_needs_report   BOOLEAN DEFAULT TRUE,
  p_can_view_admin BOOLEAN DEFAULT NULL,
  p_parent_id      UUID DEFAULT NULL,
  p_dept_type      TEXT DEFAULT 'entity'
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
  v_my_dept   UUID;
  v_my_level  TEXT;
BEGIN
  p_dept_type := COALESCE(p_dept_type, 'entity');

  -- 解析当前账号的部门与级别
  SELECT department_id, COALESCE(admin_level, 'company')
    INTO v_my_dept, v_my_level
  FROM public.profiles WHERE id = auth.uid();

  -- 权限判定
  IF public.is_company_admin() THEN
    NULL; -- 公司级：任意类型 / 任意上级
  ELSIF public.is_entity_manager() THEN
    IF v_my_dept IS NULL THEN
      RAISE EXCEPTION '未找到您的所属部门';
    END IF;
    IF p_dept_type IS DISTINCT FROM 'project' THEN
      RAISE EXCEPTION '经营实体只能新建「项目部」';
    END IF;
    IF p_parent_id IS DISTINCT FROM v_my_dept THEN
      RAISE EXCEPTION '项目部必须建在您本部门之下';
    END IF;
  ELSE
    RAISE EXCEPTION '只有管理员或经营实体才能新建部门';
  END IF;

  -- 输入与一致性校验
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;
  p_name := trim(p_name);

  IF p_dept_type NOT IN ('company', 'entity', 'project') THEN
    RAISE EXCEPTION '部门类型无效（应为 company / entity / project）';
  END IF;

  IF p_dept_type = 'company' AND EXISTS (SELECT 1 FROM public.departments WHERE dept_type = 'company') THEN
    RAISE EXCEPTION '公司已存在，不能再新建公司节点';
  END IF;

  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_parent_id) THEN
    RAISE EXCEPTION '上级部门不存在';
  END IF;

  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.departments;
  END IF;

  v_code := 'DEPT-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));

  INSERT INTO public.departments (name, code, sort_order, needs_report, can_view_admin, parent_id, dept_type)
  VALUES (p_name, v_code, v_sort, p_needs_report, p_can_view_admin, p_parent_id, p_dept_type)
  RETURNING id INTO v_dept_id;

  RETURN jsonb_build_object('success', true, 'department_id', v_dept_id);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该部门名称已存在';
END;
$$;

-- --------------------------------------------------------------------------
-- 3. update_department：公司级全量；经营实体仅限本部门下的项目部
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT);

CREATE OR REPLACE FUNCTION public.update_department(
  p_department_id   UUID,
  p_name            TEXT,
  p_sort_order      INTEGER DEFAULT NULL,
  p_needs_report    BOOLEAN DEFAULT NULL,
  p_can_view_admin  BOOLEAN DEFAULT NULL,
  p_parent_id       UUID DEFAULT NULL,
  p_dept_type       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_my_dept     UUID;
  v_cur_type    TEXT;
  v_cur_parent  UUID;
  v_is_company  BOOLEAN;
BEGIN
  IF p_department_id IS NULL THEN
    RAISE EXCEPTION '部门 ID 不能为空';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;

  SELECT dept_type, parent_id, (dept_type = 'company')
    INTO v_cur_type, v_cur_parent, v_is_company
  FROM public.departments WHERE id = p_department_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  IF public.is_company_admin() THEN
    NULL;
  ELSIF public.is_entity_manager() THEN
    SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();
    IF v_cur_type <> 'project' OR v_cur_parent IS DISTINCT FROM v_my_dept THEN
      RAISE EXCEPTION '您只能修改本部门下的项目部';
    END IF;
    IF p_dept_type IS NOT NULL AND p_dept_type IS DISTINCT FROM v_cur_type THEN
      RAISE EXCEPTION '项目部类型不可更改';
    END IF;
    IF p_parent_id IS NOT NULL AND p_parent_id IS DISTINCT FROM v_cur_parent THEN
      RAISE EXCEPTION '项目部的上级部门不可更改';
    END IF;
  ELSE
    RAISE EXCEPTION '只有管理员或经营实体才能修改部门';
  END IF;

  IF v_is_company THEN
    p_parent_id := NULL;
    p_dept_type := 'company';
  END IF;

  IF p_dept_type IS NOT NULL AND p_dept_type NOT IN ('company', 'entity', 'project') THEN
    RAISE EXCEPTION '部门类型无效';
  END IF;
  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_parent_id) THEN
    RAISE EXCEPTION '上级部门不存在';
  END IF;
  IF p_parent_id IS NOT NULL AND p_parent_id = p_department_id THEN
    RAISE EXCEPTION '上级部门不能选择自身';
  END IF;

  UPDATE public.departments
  SET name = trim(p_name),
      sort_order = COALESCE(p_sort_order, sort_order),
      needs_report = COALESCE(p_needs_report, needs_report),
      can_view_admin = COALESCE(p_can_view_admin, can_view_admin),
      parent_id = COALESCE(p_parent_id, parent_id),
      dept_type = COALESCE(p_dept_type, dept_type)
  WHERE id = p_department_id;

  RETURN jsonb_build_object('success', true);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该部门名称已存在';
END;
$$;

-- --------------------------------------------------------------------------
-- 4. delete_department：公司级全量（公司根/有下级除外）；经营实体仅限本部门下的项目部
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.delete_department(UUID);
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
  v_child_count  INTEGER;
  v_my_dept      UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id) THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  IF public.is_company_admin() THEN
    NULL;
  ELSIF public.is_entity_manager() THEN
    SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();
    IF NOT EXISTS (
      SELECT 1 FROM public.departments
      WHERE id = p_department_id
        AND dept_type = 'project'
        AND parent_id = v_my_dept
    ) THEN
      RAISE EXCEPTION '您只能删除本部门下的项目部';
    END IF;
  ELSE
    RAISE EXCEPTION '只有管理员或经营实体才能删除部门';
  END IF;

  IF EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id AND dept_type = 'company') THEN
    RAISE EXCEPTION '公司根节点不可删除';
  END IF;

  SELECT COUNT(*) INTO v_child_count FROM public.departments WHERE parent_id = p_department_id;
  IF v_child_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 个下级部门，请先删除下级部门后再删除', v_child_count;
  END IF;

  SELECT COUNT(*) INTO v_user_count FROM public.profiles WHERE department_id = p_department_id;
  IF v_user_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 个账号，请先在「账号管理」中将账号转移或删除后再删除部门', v_user_count;
  END IF;

  SELECT COUNT(*) INTO v_report_count FROM public.project_reports WHERE department_id = p_department_id;
  IF v_report_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 条报送记录，删除部门将永久删除这些历史数据。若确需删除，请先联系管理员备份数据', v_report_count;
  END IF;

  DELETE FROM public.departments WHERE id = p_department_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 5. 授权
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_company_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_entity_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department(UUID) TO authenticated;

-- ==========================================================================
-- 验证（经营实体账号登录后执行）：
--   SELECT public.is_company_admin(), public.is_entity_manager();
--   期望：经营实体管理员 → false / true；安全生产部(company级) → true / false
-- ==========================================================================

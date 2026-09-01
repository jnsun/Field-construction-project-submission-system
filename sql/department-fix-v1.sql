-- ==========================================================================
-- 部门 RPC 重载合并 + profiles RLS 收紧 补丁（v1）
-- ==========================================================================
-- 背景（2026-09-01 测试 D3 发现）：
--   ① 界面建部门报 PGRST203 could not choose best candidate：
--      库里同时存在 create_department / update_department 的多个历史重载
--      （旧 4 参版来自 department-management.sql，重跑会再次引入），PostgREST 无法选候选。
--   ② RLS 过宽：任何 admin（含经营实体 dept 级管理员）REST 直连可读取
--      全部 370 条 profiles（姓名/手机号）。
--
-- 本补丁做两件事：
--   Part 1  动态删除 create_department / update_department 的所有重载，
--           重建唯一权威版（公司级全量 / 经营实体仅本部门下项目部），
--           并顺带重建 delete_department，防止旧文件重跑把实现降级。
--   Part 2  收紧 profiles 的 SELECT 策略：
--           自己 → 可见；公司级管理员 → 全部；
--           dept/project 级管理员 → 仅本部门及下级的账号；其他角色 → 仅自己。
--
-- 依赖：profiles.admin_level / departments.parent_id / departments.dept_type 已存在
--      （department-tree.sql、training-fix-v13.sql 已执行）。
-- 执行：Supabase 控制台 → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- 自托管服务器：/opt/supabase/docker 下 psql 或控制台均可。
-- 执行后：department-management.sql 已标记废弃，请勿再执行（会重新引入旧重载）。
-- ==========================================================================


-- ==========================================================================
-- Part 1. 部门 RPC 重载合并（修复 PGRST203）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1.1 动态删除 create_department / update_department 的所有历史重载
--     规则与 account-rpc-v2.sql 一致：遍历 pg_proc 精确 DROP，
--     不能只写一条 DROP FUNCTION IF EXISTS（签名对不上会静默跳过）。
-- --------------------------------------------------------------------------
DO $patch$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('create_department', 'update_department')
  LOOP
    EXECUTE format('DROP FUNCTION public.%I(%s)', r.proname, r.args);
    RAISE NOTICE '已删除重载：public.%(%)', r.proname, r.args;
  END LOOP;
END;
$patch$;

-- --------------------------------------------------------------------------
-- 1.2 权限判定函数（与 department-entity-permissions.sql 保持一致）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_company_admin()
RETURNS BOOLEAN AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND (is_super_admin IS TRUE OR COALESCE(admin_level, 'company') = 'company')
  );
$fn$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.is_entity_manager();
CREATE OR REPLACE FUNCTION public.is_entity_manager()
RETURNS BOOLEAN AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid()
      AND p.role = 'admin'
      AND d.dept_type = 'entity'
      AND COALESCE(p.admin_level, 'dept') <> 'company'
  );
$fn$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 1.3 create_department：唯一权威版（6 参）
--     公司级管理员：任意类型 / 任意上级
--     经营实体管理员：仅可在本部门下创建「项目部」
-- --------------------------------------------------------------------------
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
AS $fn$
DECLARE
  v_dept_id   UUID;
  v_sort      INTEGER;
  v_code      TEXT;
  v_my_dept   UUID;
BEGIN
  p_dept_type := COALESCE(p_dept_type, 'entity');

  -- 权限校验
  IF public.is_company_admin() THEN
    NULL; -- 公司级：任意类型 / 任意上级
  ELSIF public.is_entity_manager() THEN
    SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();
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
$fn$;

-- --------------------------------------------------------------------------
-- 1.4 update_department：唯一权威版（7 参）
--     公司级全量；经营实体仅限本部门下的项目部（类型与上级锁定）
-- --------------------------------------------------------------------------
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
AS $fn$
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
$fn$;

-- --------------------------------------------------------------------------
-- 1.5 delete_department：重建为最新实现（单签名无重载问题，
--     但 department-management.sql 若被重跑会用旧版覆盖，这里统一恢复）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_department(
  p_department_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
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
$fn$;

-- --------------------------------------------------------------------------
-- 1.6 授权
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_company_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_entity_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department(UUID) TO authenticated;


-- ==========================================================================
-- Part 2. profiles RLS SELECT 收紧（修复：dept 级管理员 REST 直连可读全部账号）
-- ==========================================================================
-- 可见性模型：
--   自己                             → 可见（原有 profiles_select_self）
--   公司级管理员                     → 全部可见
--   dept / project 级管理员          → 仅本部门及全部下级部门的账号
--   其他角色（部门账号 / 员工）      → 仅自己
-- 注意：helper 必须 SECURITY DEFINER（策略查 profiles 自身，否则无限递归）。
-- --------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 2.1 可见性判定 helper
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_visible(p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles me
    WHERE me.id = auth.uid()
      AND (
        -- 1) 自己
        me.id = p_profile_id
        OR (
          -- 2) 公司级管理员：全量
          me.role = 'admin'
          AND (me.is_super_admin IS TRUE OR COALESCE(me.admin_level, 'company') = 'company')
        )
        OR (
          -- 3) dept / project 级管理员：本部门及下级子树
          me.role = 'admin'
          AND me.is_super_admin IS NOT TRUE
          AND COALESCE(me.admin_level, 'company') <> 'company'
          AND me.department_id IS NOT NULL
          AND EXISTS (
            WITH RECURSIVE sub AS (
              SELECT me.department_id AS id
              UNION ALL
              SELECT d.id
              FROM public.departments d
              JOIN sub s ON d.parent_id = s.id
            )
            SELECT 1
            FROM sub s
            JOIN public.profiles t ON t.department_id = s.id
            WHERE t.id = p_profile_id
          )
        )
      )
  );
$fn$;

GRANT EXECUTE ON FUNCTION public.profile_visible(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 2.2 重写两条 SELECT 策略
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_self" ON public.profiles;
CREATE POLICY "profiles_select_self" ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_select_admin" ON public.profiles;
CREATE POLICY "profiles_select_admin" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.profile_visible(id));

-- --------------------------------------------------------------------------
-- 2.3 departments 说明（保持现状，不收紧）
--     部门名（组织架构名称）不是敏感信息，且培训任务下发、报送表单、
--     各类 embed 都要显示目标/上级部门的名称（可能是祖先部门，不在自己子树内），
--     收紧会导致这些地方显示空白，因此 departments 维持「已登录可读」。
--     如确需收紧，再单独评估前端 embed 影响后处理。
-- --------------------------------------------------------------------------


-- ==========================================================================
-- Part 3. 执行后验证
-- ==========================================================================
-- ① 以下查询应只返回 3 行（每个函数各 1 行，无多余重载）：
--
--    SELECT p.proname,
--           pg_get_function_identity_arguments(p.oid) AS args
--    FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('create_department', 'update_department', 'delete_department');
--
-- ② 用公司级管理员登录，界面「部门管理 → 新增部门」应正常（不再 PGRST203）；
--    用经营实体管理员（如 13835938299）登录，新建项目部也应正常。
--
-- ③ 用经营实体管理员 token 直连 REST 验证收紧效果：
--    GET /rest/v1/profiles?select=id,department_id
--    期望：只返回其本部门及下级（项目部）的账号，不再是全部 370 条；
--    公司级管理员仍返回全部。
-- ==========================================================================

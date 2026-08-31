-- ==========================================================================
-- 施工项目月报管理系统 - 部门三级组织树（公司 → 经营实体 → 项目部）
-- ==========================================================================
-- 目标：
--   1. departments 表新增 parent_id（上级部门）与 dept_type（公司/经营实体/项目部）
--   2. 建立公司根节点「物化院有限公司」，其余无上级部门挂到公司根下、设为经营实体
--   3. 经营实体账号可在「本部门账号下」自行新建 / 编辑 / 删除项目部
--   4. 管理员可在部门管理弹窗设置任意上级与部门类型
--
-- 部署：Supabase 控制台 → SQL Editor → 粘贴全部 → Run。可重复执行（幂等）。
-- 注意：本文件必须在 sql/department-management.sql 之后执行（create/update/delete_department
--       原函数已存在，这里 DROP 旧签名后重建为新签名）。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 新增列：上级部门 + 部门类型
-- --------------------------------------------------------------------------
ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS parent_id UUID
  REFERENCES public.departments(id) ON DELETE RESTRICT;

ALTER TABLE public.departments ADD COLUMN IF NOT EXISTS dept_type TEXT NOT NULL DEFAULT 'entity';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_dept_type_check') THEN
    ALTER TABLE public.departments
      ADD CONSTRAINT departments_dept_type_check
      CHECK (dept_type IN ('company', 'entity', 'project'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1. 建立/修正公司根节点「物化院有限公司」
--    需处理两类历史脏数据（都会触发 departments_code_key 唯一约束，报错 23505）：
--      (a) code='COMPANY' 但 dept_type 不是 company 的孤立行
--      (b) 旧建根 SQL 留下的占位名「XX公司全称」company 根，与用户指定的
--          「物化院有限公司」并存 → 以「物化院有限公司」为公司根，占位行降级为 entity
--    全部按名称/类型匹配，不写死 UUID，可跨库（云库 / 服务器库）复用；整段幂等。
-- --------------------------------------------------------------------------

-- 1-pre. 任何 code='COMPANY' 但非 company 的行，先把编码让出来，避免后续升级冲突
UPDATE public.departments SET code = 'COMPANY-LEGACY'
WHERE code = 'COMPANY' AND dept_type <> 'company';

DO $$
DECLARE v_new_root UUID; v_old_root UUID;
BEGIN
  -- 现有 company 根（可能是占位名 XX公司全称）
  SELECT id INTO v_old_root FROM public.departments WHERE dept_type = 'company' ORDER BY sort_order LIMIT 1;
  -- 用户指定的公司名
  SELECT id INTO v_new_root FROM public.departments WHERE name = '物化院有限公司' LIMIT 1;

  IF v_new_root IS NULL THEN
    -- 库里没有「物化院有限公司」→ 直接把现有 company 根改名为它
    IF v_old_root IS NOT NULL THEN
      UPDATE public.departments SET name = '物化院有限公司' WHERE id = v_old_root;
    END IF;
  ELSE
    -- 让「物化院有限公司」成为公司根；若另有占位 company 根则降级为经营实体
    IF v_old_root IS NOT NULL AND v_old_root <> v_new_root THEN
      -- 占位根降级为 entity，挂到新根之下
      UPDATE public.departments
      SET dept_type = 'entity',
          parent_id = v_new_root,
          sort_order = (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.departments WHERE id <> v_old_root)
      WHERE id = v_old_root;
      -- 占位根的子部门（不含新根自身，避免自引用）改挂新根
      UPDATE public.departments SET parent_id = v_new_root WHERE parent_id = v_old_root AND id <> v_new_root;
      -- 占位根若仍占着 COMPANY 编码则让出
      UPDATE public.departments SET code = 'COMPANY-LEGACY' WHERE id = v_old_root AND code = 'COMPANY';
    END IF;
    -- 升级「物化院有限公司」为公司根
    UPDATE public.departments
    SET dept_type = 'company',
        parent_id = NULL,
        code = 'COMPANY',
        sort_order = 0,
        needs_report = FALSE,
        can_view_admin = TRUE
    WHERE id = v_new_root;
  END IF;
END $$;

-- 1-final. 若经过上面处理仍无 company 根（如全新空库），则新建
INSERT INTO public.departments (name, code, sort_order, dept_type, parent_id, needs_report, can_view_admin)
SELECT '物化院有限公司', 'COMPANY', 0, 'company', NULL, FALSE, TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.departments WHERE dept_type = 'company')
  AND NOT EXISTS (SELECT 1 FROM public.departments WHERE code = 'COMPANY')
  AND NOT EXISTS (SELECT 1 FROM public.departments WHERE name = '物化院有限公司');

-- --------------------------------------------------------------------------
-- 2. 将现有所有「无上级部门」的部门挂到公司根下，设为经营实体
--    （安全生产部、六勘院有限公司、各工程部等全部作为经营实体纳入三级树）
-- --------------------------------------------------------------------------
UPDATE public.departments d
SET parent_id = (SELECT id FROM public.departments WHERE dept_type = 'company' ORDER BY sort_order LIMIT 1),
    dept_type = 'entity'
WHERE parent_id IS NULL
  AND id <> (SELECT id FROM public.departments WHERE dept_type = 'company' ORDER BY sort_order LIMIT 1);

-- --------------------------------------------------------------------------
-- 3. 经营实体判定函数（SECURITY DEFINER 绕过 RLS，避免递归）
--    当前账号是其所属部门 dept_type='entity' 的部门账号（非管理员）时返回 true
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_entity_manager()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.departments d ON d.id = p.department_id
    WHERE p.id = auth.uid() AND d.dept_type = 'entity'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 4. 改造 create_department：新增 p_parent_id 与 p_dept_type
--    权限：
--      管理员            → 可创建任意类型 / 任意上级
--      经营实体          → 仅可在本部门下创建「项目部」
--      其他（普通部门）  → 拒绝
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN);

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
BEGIN
  p_dept_type := COALESCE(p_dept_type, 'entity');

  -- 权限校验
  IF public.is_admin() THEN
    NULL;
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

  -- 输入校验
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;
  p_name := trim(p_name);

  IF p_dept_type NOT IN ('company', 'entity', 'project') THEN
    RAISE EXCEPTION '部门类型无效（应为 company / entity / project）';
  END IF;

  -- 公司唯一
  IF p_dept_type = 'company' AND EXISTS (SELECT 1 FROM public.departments WHERE dept_type = 'company') THEN
    RAISE EXCEPTION '公司已存在，不能再新建公司节点';
  END IF;

  -- 上级部门存在性
  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_parent_id) THEN
    RAISE EXCEPTION '上级部门不存在';
  END IF;

  -- 排序号：未传则排到当前最后
  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.departments;
  END IF;

  -- 部门编码自动生成（保证唯一）
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
-- 5. 改造 update_department：新增 p_parent_id 与 p_dept_type
--    权限：
--      管理员            → 可改任意字段（公司根节点的上级/类型锁定）
--      经营实体          → 仅可改本部门下的项目部（名称/排序/报送开关），类型与上级锁定
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN);

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
  -- 输入校验
  IF p_department_id IS NULL THEN
    RAISE EXCEPTION '部门 ID 不能为空';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '部门名称不能为空';
  END IF;

  -- 当前部门信息
  SELECT dept_type, parent_id, (dept_type = 'company')
    INTO v_cur_type, v_cur_parent, v_is_company
  FROM public.departments WHERE id = p_department_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  -- 权限校验
  IF public.is_admin() THEN
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

  -- 公司根节点：上级与类型锁定
  IF v_is_company THEN
    p_parent_id := NULL;
    p_dept_type := 'company';
  END IF;

  -- 类型取值校验
  IF p_dept_type IS NOT NULL AND p_dept_type NOT IN ('company', 'entity', 'project') THEN
    RAISE EXCEPTION '部门类型无效';
  END IF;
  -- 上级部门存在性
  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_parent_id) THEN
    RAISE EXCEPTION '上级部门不存在';
  END IF;
  -- 防止挂到自己
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
-- 6. 改造 delete_department：新增经营实体权限
--    权限：
--      管理员            → 可删除任意部门（公司根节点除外；有下级部门时禁止）
--      经营实体          → 仅可删除本部门下的项目部
--    删除前安全校验（保留）：有账号 / 有报送记录 / 有下级部门 均阻止
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
  v_child_count  INTEGER;
BEGIN
  -- 部门是否存在
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id) THEN
    RAISE EXCEPTION '部门不存在或已被删除';
  END IF;

  -- 权限校验
  IF public.is_admin() THEN
    NULL;
  ELSIF public.is_entity_manager() THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.departments
      WHERE id = p_department_id
        AND dept_type = 'project'
        AND parent_id = (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    ) THEN
      RAISE EXCEPTION '您只能删除本部门下的项目部';
    END IF;
  ELSE
    RAISE EXCEPTION '只有管理员或经营实体才能删除部门';
  END IF;

  -- 禁止删除公司根节点
  IF EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id AND dept_type = 'company') THEN
    RAISE EXCEPTION '公司根节点不可删除';
  END IF;

  -- 检查该部门下是否有下级部门（外键 ON DELETE RESTRICT，提前给出友好提示）
  SELECT COUNT(*) INTO v_child_count
  FROM public.departments
  WHERE parent_id = p_department_id;
  IF v_child_count > 0 THEN
    RAISE EXCEPTION '该部门下还有 % 个下级部门，请先删除下级部门后再删除', v_child_count;
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
-- 7. 授权：允许已登录用户调用（实际权限由函数体内 is_admin()/is_entity_manager() 校验）
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_department(TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_department(UUID, TEXT, INTEGER, BOOLEAN, BOOLEAN, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_department(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_entity_manager() TO authenticated;

-- ==========================================================================
-- 验证：
--   SELECT id, name, dept_type, parent_id, sort_order
--   FROM public.departments ORDER BY sort_order;
--   应看到：物化院有限公司(company, parent=null) 在最前，其余 dept_type=entity 且 parent=公司根。
-- ==========================================================================

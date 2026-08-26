-- ==========================================================================
-- 只读「可看管理界面」用户（内设机构，如财务资产部等无需报送的部门）
-- 的报表数据访问策略
-- --------------------------------------------------------------------------
-- 用途：系统设计中，「可看管理界面」（can_view_admin）的内设机构需在
--      「报送管理 / 完工项目」页看到与管理员一致的聚合数据。但现有 RLS 仅允许
--      普通部门账号读取「本部门」报送记录；内设机构无本部门报送，导致汇总表为空、
--      统计全为 0、与管理员页面不一致。
--      本脚本在不影响「普通报送部门只能看本部门」的前提下，额外放开只读全量读取。
-- 执行方式：在 Supabase 控制台 SQL Editor 中执行本文件（幂等，可重复执行）。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 判定「可看管理界面」的数据库函数（SECURITY DEFINER 避免递归）
--    逻辑与前端 Auth.canViewAdmin() 保持一致：
--      - 管理员：恒 true
--      - 部门 can_view_admin 显式 true/false 优先
--      - 为 NULL 时按 needs_report 反推：不报送(false) → 可看；需报送 → 不可看
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_view_admin_data()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT
       CASE
         WHEN p.role = 'admin' THEN TRUE
         WHEN d.can_view_admin IS NOT NULL THEN d.can_view_admin
         ELSE (d.needs_report IS FALSE)
       END
     FROM public.profiles p
     LEFT JOIN public.departments d ON d.id = p.department_id
     WHERE p.id = auth.uid()),
    FALSE);
$$;

-- --------------------------------------------------------------------------
-- 2. project_reports：为「可看管理界面」用户开放只读全量（与现有本部门策略并存，OR 生效）
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "reports_select_viewer" ON public.project_reports;
CREATE POLICY "reports_select_viewer" ON public.project_reports
  FOR SELECT TO authenticated
  USING (public.can_view_admin_data());

-- --------------------------------------------------------------------------
-- 3. department_month_status：为「可看管理界面」用户开放只读全量（无野外施工确认状态）
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "dms_select_viewer" ON public.department_month_status;
CREATE POLICY "dms_select_viewer" ON public.department_month_status
  FOR SELECT TO authenticated
  USING (public.can_view_admin_data());

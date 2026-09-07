-- D07：角色权限矩阵收口。
-- 公司级管理员保留公司范围读取和正式项目管理权限，但不再自动获得项目日常操作权限。
-- 普通员工、外协和访客的员工档案读取仅限本人；项目经理和安全员仅可读取所管项目成员。

CREATE OR REPLACE FUNCTION public.site_project_can_manage(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
        SELECT 1
        FROM public.site_projects p
        WHERE p.id = p_project_id
          AND public.is_entity_manager()
          AND p.lead_entity_id = public.training_my_dept_id()
      )
      OR EXISTS (
        SELECT 1
        FROM public.site_project_roles r
        WHERE r.project_id = p_project_id
          AND r.user_id = auth.uid()
          AND r.active
          AND r.role IN ('project_manager', 'safety_officer')
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_can_manage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_can_manage(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_employee_can_read(
  p_employee_id UUID,
  p_department_id UUID
)
RETURNS BOOLEAN AS $$
  SELECT p_employee_id = public.training_my_employee_id()
      OR (
        public.is_admin()
        AND public.training_can_read(p_department_id)
      )
      OR EXISTS (
      SELECT 1
      FROM public.site_project_members m
      JOIN public.site_project_roles r
        ON r.project_id = m.project_id
       AND r.user_id = auth.uid()
       AND r.active
       AND r.role IN ('project_manager', 'safety_officer')
      WHERE m.employee_id = p_employee_id
        AND m.status = 'active'
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_employee_can_read(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_employee_can_read(UUID, UUID) TO authenticated;

DROP POLICY IF EXISTS "tr_emp_select" ON public.training_employees;
CREATE POLICY "tr_emp_select" ON public.training_employees
  FOR SELECT TO authenticated
  USING (public.training_employee_can_read(id, department_id));

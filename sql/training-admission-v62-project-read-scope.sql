-- D07：普通项目角色和员工只能读取自己明确关联的项目，不能按经营实体范围横向读取。
-- 公司/经营实体管理员继续按组织范围读取；项目经理、安全员和成员按项目关系读取。

CREATE OR REPLACE FUNCTION public.site_project_can_read(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR (
        public.is_admin()
        AND EXISTS (
          SELECT 1 FROM public.site_projects p
          WHERE p.id = p_project_id
            AND public.training_can_read(p.lead_entity_id)
        )
      )
      OR (
        public.is_admin()
        AND EXISTS (
          SELECT 1 FROM public.site_project_entities pe
          WHERE pe.project_id = p_project_id
            AND public.training_can_read(pe.entity_id)
        )
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_roles r
        WHERE r.project_id = p_project_id
          AND r.user_id = auth.uid()
          AND r.active
          AND r.role IN ('project_manager', 'safety_officer')
      )
      OR EXISTS (
        SELECT 1
        FROM public.site_project_members m
        JOIN public.profiles pr ON pr.employee_id = m.employee_id
        WHERE m.project_id = p_project_id
          AND m.status = 'active'
          AND pr.id = auth.uid()
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_can_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_can_read(UUID) TO authenticated;

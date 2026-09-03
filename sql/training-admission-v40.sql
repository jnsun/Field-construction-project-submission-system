-- ============================================================================
-- 培训准入第四十批：项目检查档案的完整身份证号权限修正
-- 前置：training-admission-v1.sql 至 v39.sql 已执行。
-- 项目经理/安全员仅能在本人可管理项目的固定记录卡中查看完整号码；
-- 二维码核验、员工凭证等对外场景仍使用脱敏信息。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_admission_record_cards(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  admission_id UUID,
  project_code TEXT,
  project_name TEXT,
  employee_name TEXT,
  employee_no TEXT,
  department_name TEXT,
  work_position TEXT,
  phone TEXT,
  id_number TEXT,
  contractor_name TEXT,
  admission_status TEXT,
  levels JSONB,
  signatures JSONB,
  final_signed_at TIMESTAMPTZ,
  site_confirmed_at TIMESTAMPTZ,
  valid_until DATE
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '汇总记录卡查询需要公司级权限';
  END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id)
     AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '您无权查询该项目记录卡';
  END IF;

  RETURN QUERY
  SELECT a.id, p.project_code, p.name, e.name, e.employee_no, d.name, e.position, e.phone,
         CASE WHEN public.training_is_company_admin()
                   OR public.training_can_write(p.lead_entity_id)
                   OR public.site_project_can_manage(p.id)
              THEN e.id_number
              WHEN e.id_number IS NULL THEN NULL
              ELSE regexp_replace(e.id_number, '^(.{3}).*(.{4})$', '\1***********\2') END,
         cc.name,
         a.status,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'level', t.level,
             'plan_title', tp.title,
             'required_hours', tp.required_hours,
             'completed_at', t.completed_at,
             'employee_signed_at', (
               SELECT s.signed_at FROM public.training_admission_signatures s
               WHERE s.admission_id = a.id AND s.task_id = t.id AND s.signer_role = 'employee'
               ORDER BY s.signed_at DESC LIMIT 1
             ),
             'courses', COALESCE((
               SELECT jsonb_agg(c.title ORDER BY c.sort_order, c.created_at)
               FROM public.training_courses c WHERE c.plan_id = t.plan_id
             ), '[]'::jsonb)
           ) ORDER BY CASE t.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 WHEN 'project' THEN 3 ELSE 4 END, t.created_at)
           FROM public.training_admission_tasks t
           JOIN public.training_plans tp ON tp.id = t.plan_id
           WHERE t.admission_id = a.id
         ), '[]'::jsonb),
         COALESCE((
           SELECT jsonb_object_agg(x.signer_role, x.signed_at)
           FROM (
             SELECT DISTINCT ON (s.signer_role) s.signer_role, s.signed_at
             FROM public.training_admission_signatures s
             WHERE s.admission_id = a.id AND s.task_id IS NULL
             ORDER BY s.signer_role, s.signed_at DESC
           ) x
         ), '{}'::jsonb),
         a.final_signed_at, a.site_confirmed_at, a.valid_until
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.departments d ON d.id = e.department_id
  LEFT JOIN public.site_project_members m ON m.id = a.member_id
  LEFT JOIN public.contractor_companies cc ON cc.id = m.contractor_id
  WHERE (p_project_id IS NULL OR a.project_id = p_project_id)
  ORDER BY p.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_admission_record_cards(UUID) TO authenticated;

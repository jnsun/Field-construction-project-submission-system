-- ============================================================================
-- 培训准入第二十二批：复训档案纳入记录卡与检查报表
-- 前置：training-admission-v1.sql 至 training-admission-v21.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_admission_record_cards(UUID);
CREATE FUNCTION public.training_admission_record_cards(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  admission_id UUID, project_code TEXT, project_name TEXT, employee_name TEXT, employee_no TEXT,
  department_name TEXT, work_position TEXT, phone TEXT, id_number TEXT, contractor_name TEXT,
  admission_status TEXT, training_cycle_no INT, levels JSONB, signatures JSONB, retraining_cycles JSONB,
  final_signed_at TIMESTAMPTZ, site_confirmed_at TIMESTAMPTZ, valid_until DATE
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '汇总记录卡查询需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目记录卡'; END IF;
  RETURN QUERY
  SELECT a.id, p.project_code, p.name, e.name, e.employee_no, d.name, e.position, e.phone,
         CASE WHEN public.training_is_company_admin() OR public.training_can_write(p.lead_entity_id) THEN e.id_number
              WHEN e.id_number IS NULL THEN NULL ELSE regexp_replace(e.id_number, '^(.{3}).*(.{4})$', '\\1***********\\2') END,
         cc.name, a.status, a.training_cycle_no,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('level', t.level, 'cycle_no', t.cycle_no, 'plan_title', tp.title,
           'required_hours', tp.required_hours, 'completed_at', t.completed_at,
           'employee_signed_at', (SELECT s.signed_at FROM public.training_admission_signatures s WHERE s.admission_id = a.id AND s.task_id = t.id AND s.signer_role = 'employee' ORDER BY s.signed_at DESC LIMIT 1),
           'courses', COALESCE((SELECT jsonb_agg(c.title ORDER BY c.sort_order, c.created_at) FROM public.training_courses c WHERE c.plan_id = t.plan_id), '[]'::jsonb))
           ORDER BY t.cycle_no, CASE t.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 WHEN 'project' THEN 3 ELSE 4 END, t.created_at)
           FROM public.training_admission_tasks t JOIN public.training_plans tp ON tp.id = t.plan_id WHERE t.admission_id = a.id), '[]'::jsonb),
         COALESCE((SELECT jsonb_object_agg(x.signer_role, x.signed_at) FROM (
           SELECT DISTINCT ON (s.signer_role) s.signer_role, s.signed_at FROM public.training_admission_signatures s
           WHERE s.admission_id = a.id AND s.task_id IS NULL AND s.cycle_no = a.training_cycle_no
           ORDER BY s.signer_role, s.signed_at DESC) x), '{}'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('cycle_no', rc.cycle_no, 'trigger_type', rc.trigger_type, 'reason', rc.reason,
             'started_at', rc.started_at, 'old_package_title', oldp.title, 'new_package_title', newp.title) ORDER BY rc.cycle_no)
           FROM public.training_admission_retraining_cycles rc
           LEFT JOIN public.training_admission_packages oldp ON oldp.id = rc.old_package_id
           JOIN public.training_admission_packages newp ON newp.id = rc.new_package_id
           WHERE rc.admission_id = a.id), '[]'::jsonb),
         a.final_signed_at, a.site_confirmed_at, a.valid_until
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.departments d ON d.id = e.department_id
  LEFT JOIN public.site_project_members m ON m.id = a.member_id
  LEFT JOIN public.contractor_companies cc ON cc.id = m.contractor_id
  WHERE p_project_id IS NULL OR a.project_id = p_project_id
  ORDER BY p.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_record_cards(UUID) TO authenticated;

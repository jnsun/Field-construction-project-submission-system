-- ============================================================================
-- 培训准入第十八批：年度培训统计
-- 前置：training-admission-v1.sql 至 training-admission-v17.sql 已执行。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_admission_annual_stats(
  p_year INT DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INT,
  p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, admission_total INT, eligible_total INT,
  company_completed INT, entity_completed INT, project_completed INT, special_completed INT,
  effective_hours NUMERIC, exam_passed_total INT, exam_attempts_total INT, blocked_total INT
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '年度汇总查询需要公司级权限';
  END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id)
     AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '您无权查询该项目年度统计';
  END IF;
  RETURN QUERY
  SELECT p.project_code, p.name,
    COUNT(a.id)::INT,
    COUNT(a.id) FILTER (WHERE a.status = 'eligible')::INT,
    COUNT(t.id) FILTER (WHERE t.level = 'company' AND t.status = 'completed')::INT,
    COUNT(t.id) FILTER (WHERE t.level = 'entity' AND t.status = 'completed')::INT,
    COUNT(t.id) FILTER (WHERE t.level = 'project' AND t.status = 'completed')::INT,
    COUNT(t.id) FILTER (WHERE t.level = 'special' AND t.status = 'completed')::INT,
    COALESCE(SUM(t.effective_hours), 0),
    COUNT(a.id) FILTER (WHERE a.exam_passed)::INT,
    COALESCE(SUM(a.exam_attempts), 0)::INT,
    COUNT(a.id) FILTER (WHERE a.status IN ('blocked', 'expired', 'project_closed'))::INT
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  LEFT JOIN public.training_admission_tasks t ON t.admission_id = a.id
  WHERE EXTRACT(YEAR FROM a.created_at) = p_year
    AND (p_project_id IS NULL OR a.project_id = p_project_id)
  GROUP BY p.id, p.project_code, p.name
  ORDER BY p.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_admission_annual_stats(INT, UUID) TO authenticated;

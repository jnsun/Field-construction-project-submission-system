-- ============================================================================
-- 培训准入第十六批：月报完工提示，不自动关闭正式项目
-- 前置：training-admission-v1.sql 至 training-admission-v15.sql 已执行。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.site_project_report_status_hints()
RETURNS TABLE(project_id UUID, latest_reporting_month INT, latest_status TEXT, latest_reported_at TIMESTAMPTZ) AS $$
  SELECT DISTINCT ON (pr.site_project_id)
    pr.site_project_id,
    pr.reporting_year * 100 + pr.reporting_month,
    pr.project_status,
    pr.updated_at
  FROM public.project_reports pr
  JOIN public.site_projects p ON p.id = pr.site_project_id
  WHERE pr.site_project_id IS NOT NULL AND public.site_project_can_read(p.id)
  ORDER BY pr.site_project_id, pr.reporting_year DESC, pr.reporting_month DESC, pr.updated_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.site_project_report_status_hints() TO authenticated;

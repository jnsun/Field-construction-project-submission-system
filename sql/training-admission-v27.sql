-- ============================================================================
-- 培训准入第二十七批：年度统计修正、提醒设置和公司级汇总提醒
-- 前置：training-admission-v1.sql 至 training-admission-v26.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_admission_annual_stats(INT, UUID);
CREATE FUNCTION public.training_admission_annual_stats(
  p_year INT DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::INT, p_project_id UUID DEFAULT NULL
)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, admission_total INT, eligible_total INT,
  company_completed INT, entity_completed INT, project_completed INT, special_completed INT,
  effective_hours NUMERIC, exam_passed_total INT, exam_attempts_total INT, blocked_total INT,
  retraining_total INT, annual_retraining_total INT, credential_due_total INT, expired_total INT
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '年度汇总查询需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目年度统计'; END IF;
  RETURN QUERY
  WITH annual_admissions AS (
    SELECT a.* FROM public.training_admissions a WHERE EXTRACT(YEAR FROM a.created_at) = p_year
  )
  SELECT p.project_code, p.name,
    COUNT(a.id)::INT, COUNT(a.id) FILTER (WHERE a.status = 'eligible')::INT,
    COALESCE(SUM(t.company_completed), 0)::INT, COALESCE(SUM(t.entity_completed), 0)::INT,
    COALESCE(SUM(t.project_completed), 0)::INT, COALESCE(SUM(t.special_completed), 0)::INT,
    COALESCE(SUM(t.effective_hours), 0), COUNT(a.id) FILTER (WHERE a.exam_passed)::INT,
    COALESCE(SUM(a.exam_attempts), 0)::INT, COUNT(a.id) FILTER (WHERE a.status IN ('blocked', 'expired', 'project_closed'))::INT,
    COALESCE(rc.retraining_total, 0)::INT, COALESCE(rc.annual_retraining_total, 0)::INT,
    COALESCE(dues.credential_due_total, 0)::INT, COALESCE(expired.expired_total, 0)::INT
  FROM public.site_projects p
  LEFT JOIN annual_admissions a ON a.project_id = p.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE x.level = 'company' AND x.status = 'completed') AS company_completed,
      COUNT(*) FILTER (WHERE x.level = 'entity' AND x.status = 'completed') AS entity_completed,
      COUNT(*) FILTER (WHERE x.level = 'project' AND x.status = 'completed') AS project_completed,
      COUNT(*) FILTER (WHERE x.level = 'special' AND x.status = 'completed') AS special_completed,
      COALESCE(SUM(x.effective_hours), 0) AS effective_hours
    FROM public.training_admission_tasks x WHERE x.admission_id = a.id
  ) t ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS retraining_total, COUNT(*) FILTER (WHERE x.trigger_type = 'annual_expiry') AS annual_retraining_total
    FROM public.training_admission_retraining_cycles x JOIN public.training_admissions ra ON ra.id = x.admission_id
    WHERE ra.project_id = p.id AND EXTRACT(YEAR FROM x.started_at) = p_year
  ) rc ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS credential_due_total FROM public.training_admissions x
    WHERE x.project_id = p.id AND x.status = 'eligible'
      AND x.valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + COALESCE((SELECT credential_due_days FROM public.training_admission_notification_settings WHERE id = TRUE), 30)
  ) dues ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS expired_total FROM public.training_admissions x WHERE x.project_id = p.id AND x.status = 'expired'
  ) expired ON TRUE
  WHERE (p_project_id IS NULL OR p.id = p_project_id)
  GROUP BY p.id, p.project_code, p.name, rc.retraining_total, rc.annual_retraining_total, dues.credential_due_total, expired.expired_total
  ORDER BY p.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_annual_stats(INT, UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.training_get_notification_settings();
CREATE FUNCTION public.training_get_notification_settings()
RETURNS TABLE (due_soon_days INT, credential_due_days INT, daily_run_hour INT) AS $$
BEGIN
  IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司安全生产部可查看提醒设置'; END IF;
  RETURN QUERY SELECT s.due_soon_days, s.credential_due_days, s.daily_run_hour FROM public.training_admission_notification_settings s WHERE s.id = TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_update_notification_settings(INT, INT, INT);
CREATE FUNCTION public.training_update_notification_settings(p_due_days INT, p_credential_due_days INT, p_daily_hour INT)
RETURNS VOID AS $$
BEGIN
  IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司安全生产部可修改提醒设置'; END IF;
  IF p_due_days NOT BETWEEN 0 AND 30 OR p_credential_due_days NOT BETWEEN 0 AND 180 OR p_daily_hour NOT BETWEEN 0 AND 23 THEN RAISE EXCEPTION '提醒参数超出允许范围'; END IF;
  UPDATE public.training_admission_notification_settings
  SET due_soon_days = p_due_days, credential_due_days = p_credential_due_days, daily_run_hour = p_daily_hour, updated_at = NOW(), updated_by = auth.uid()
  WHERE id = TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_generate_all_project_reminders();
CREATE FUNCTION public.training_generate_all_project_reminders()
RETURNS INT AS $$
DECLARE v_project UUID; v_total INT := 0;
BEGIN
  IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司安全生产部可汇总生成提醒'; END IF;
  FOR v_project IN SELECT id FROM public.site_projects WHERE status IN ('planning', 'active') LOOP
    v_total := v_total + public.training_generate_due_reminders(v_project) + public.training_generate_credential_expiry_reminders(v_project);
  END LOOP;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_get_notification_settings(), public.training_update_notification_settings(INT, INT, INT), public.training_generate_all_project_reminders() TO authenticated;

-- 项目现场可直接使用的凭证临期与年度复训名单；不暴露身份证、附件等敏感信息。
DROP FUNCTION IF EXISTS public.training_admission_credential_expiry_report(UUID);
CREATE FUNCTION public.training_admission_credential_expiry_report(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, phone TEXT, work_position TEXT,
  contractor_name TEXT, valid_until DATE, credential_state TEXT, admission_status TEXT,
  retraining_cycle TEXT, days_remaining INT
) AS $$
DECLARE v_days INT;
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '汇总临期名单需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目临期名单'; END IF;
  SELECT credential_due_days INTO v_days FROM public.training_admission_notification_settings WHERE id = TRUE;
  v_days := COALESCE(v_days, 30);
  RETURN QUERY
  SELECT p.project_code, p.name, e.name, e.phone, COALESCE(m.work_type, e.position), c.name,
         a.valid_until,
         CASE
           WHEN a.status = 'expired' THEN '凭证已失效'
           WHEN rc.cycle_type = 'annual_expiry' AND a.status <> 'eligible' THEN '年度复训进行中'
           WHEN a.valid_until < CURRENT_DATE THEN '凭证已失效'
           ELSE '凭证临期'
         END,
         a.status,
         CASE WHEN rc.cycle_type = 'annual_expiry' THEN '年度复训' WHEN rc.id IS NOT NULL THEN '其他复训' ELSE '待发起年度复训' END,
         CASE WHEN a.valid_until IS NULL THEN NULL ELSE (a.valid_until - CURRENT_DATE)::INT END
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  JOIN public.site_project_members m ON m.id = a.member_id
  LEFT JOIN public.contractor_companies c ON c.id = m.contractor_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.trigger_type AS cycle_type
    FROM public.training_admission_retraining_cycles x
    WHERE x.admission_id = a.id AND x.cycle_no = a.training_cycle_no
    LIMIT 1
  ) rc ON TRUE
  WHERE (p_project_id IS NULL OR a.project_id = p_project_id)
    AND (
      (a.status = 'eligible' AND a.valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + v_days)
      OR a.status = 'expired'
      OR (rc.cycle_type = 'annual_expiry' AND a.status <> 'eligible')
    )
  ORDER BY CASE WHEN a.status = 'expired' THEN 0 WHEN rc.cycle_type = 'annual_expiry' THEN 1 ELSE 2 END,
           a.valid_until NULLS LAST, p.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_credential_expiry_report(UUID) TO authenticated;

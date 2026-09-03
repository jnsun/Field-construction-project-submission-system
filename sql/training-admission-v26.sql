-- ============================================================================
-- 培训准入第二十六批：年度凭证临期提醒
-- 前置：training-admission-v1.sql 至 training-admission-v25.sql 已执行。
-- ============================================================================

ALTER TABLE public.training_admission_notification_settings
  ADD COLUMN IF NOT EXISTS credential_due_days INT NOT NULL DEFAULT 30 CHECK (credential_due_days BETWEEN 0 AND 180);

DROP FUNCTION IF EXISTS public.training_generate_credential_expiry_reminders(UUID);
CREATE FUNCTION public.training_generate_credential_expiry_reminders(p_project_id UUID)
RETURNS INT AS $$
DECLARE v_days INT; v_count INT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权生成该项目提醒'; END IF;
  SELECT credential_due_days INTO v_days FROM public.training_admission_notification_settings WHERE id = TRUE;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by, event_key)
  SELECT a.project_id, a.id, a.employee_id,
         '您的项目培训合格凭证将于 ' || to_char(a.valid_until, 'YYYY-MM-DD') || ' 到期，请配合完成年度复训。到期后系统将自动禁止上岗。',
         auth.uid(), 'credential-due:' || a.id::TEXT || ':' || a.valid_until::TEXT
  FROM public.training_admissions a
  WHERE a.project_id = p_project_id AND a.status = 'eligible'
    AND a.valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + v_days
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_generate_credential_expiry_reminders(UUID) TO authenticated;

-- ============================================================================
-- 培训准入第十五批：任务下发、临期与逾期提醒
-- 前置：training-admission-v1.sql 至 training-admission-v14.sql 已执行。
-- ============================================================================

ALTER TABLE public.training_admission_reminders ADD COLUMN IF NOT EXISTS event_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_admission_reminder_event
  ON public.training_admission_reminders(event_key) WHERE event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.training_admission_notification_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  due_soon_days INT NOT NULL DEFAULT 3 CHECK (due_soon_days BETWEEN 0 AND 30),
  daily_run_hour INT NOT NULL DEFAULT 9 CHECK (daily_run_hour BETWEEN 0 AND 23),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);
INSERT INTO public.training_admission_notification_settings(id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.training_send_admission_start_notice(p_admission_id UUID)
RETURNS VOID AS $$
DECLARE v_a public.training_admissions%ROWTYPE;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '准入记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id) THEN RAISE EXCEPTION '您无权发送该准入任务提醒'; END IF;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by, event_key)
  VALUES (v_a.project_id, v_a.id, v_a.employee_id, '已为您下发项目三级安全教育任务。完成学习、考试、电子签字和现场确认前，禁止入场、禁止上岗。', auth.uid(), 'start:' || v_a.id::TEXT)
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_generate_due_reminders(p_project_id UUID)
RETURNS INT AS $$
DECLARE v_days INT; v_count INT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权生成该项目提醒'; END IF;
  SELECT due_soon_days INTO v_days FROM public.training_admission_notification_settings WHERE id = TRUE;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by, event_key)
  SELECT a.project_id, a.id, a.employee_id,
    CASE WHEN MIN(tp.deadline) < CURRENT_DATE
      THEN '您的项目准入培训已逾期，请立即完成。未完成前禁止入场、禁止上岗。'
      ELSE '您的项目准入培训即将于 ' || to_char(MIN(tp.deadline), 'YYYY-MM-DD') || ' 截止，请尽快完成。' END,
    auth.uid(),
    CASE WHEN MIN(tp.deadline) < CURRENT_DATE THEN 'overdue:' || a.id::TEXT || ':' || CURRENT_DATE::TEXT
         ELSE 'due:' || a.id::TEXT || ':' || MIN(tp.deadline)::TEXT END
  FROM public.training_admissions a
  JOIN public.training_admission_tasks t ON t.admission_id = a.id AND t.status <> 'completed'
  JOIN public.training_plans tp ON tp.id = t.plan_id AND tp.deadline IS NOT NULL
  WHERE a.project_id = p_project_id AND a.status <> 'eligible'
  GROUP BY a.project_id, a.id, a.employee_id
  HAVING MIN(tp.deadline) < CURRENT_DATE OR MIN(tp.deadline) BETWEEN CURRENT_DATE AND CURRENT_DATE + v_days
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_send_admission_start_notice(UUID), public.training_generate_due_reminders(UUID) TO authenticated;

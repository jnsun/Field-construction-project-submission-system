-- ============================================================================
-- 培训准入第八批：系统内批量催办与员工待办提醒
-- 前置：training-admission-v1.sql 至 training-admission-v7.sql 已执行。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.training_admission_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_training_admission_reminders_employee
  ON public.training_admission_reminders(employee_id, created_at DESC);
ALTER TABLE public.training_admission_reminders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_admission_reminders_read ON public.training_admission_reminders;
CREATE POLICY training_admission_reminders_read ON public.training_admission_reminders
  FOR SELECT TO authenticated USING (
    employee_id = public.training_my_employee_id() OR public.site_project_can_manage(project_id)
  );

DROP FUNCTION IF EXISTS public.training_batch_remind(UUID, UUID[], TEXT);
CREATE FUNCTION public.training_batch_remind(p_project_id UUID, p_admission_ids UUID[], p_message TEXT)
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权催办该项目人员'; END IF;
  IF COALESCE(array_length(p_admission_ids, 1), 0) = 0 THEN RAISE EXCEPTION '请选择至少一名待催办人员'; END IF;
  IF NULLIF(btrim(p_message), '') IS NULL THEN RAISE EXCEPTION '催办内容不能为空'; END IF;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by)
  SELECT a.project_id, a.id, a.employee_id, btrim(p_message), auth.uid()
  FROM public.training_admissions a
  WHERE a.project_id = p_project_id AND a.id = ANY(p_admission_ids)
    AND a.status <> 'eligible';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_batch_remind(UUID, UUID[], TEXT) TO authenticated;

-- 验证：SELECT to_regclass('public.training_admission_reminders');

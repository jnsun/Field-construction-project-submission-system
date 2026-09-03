-- ============================================================================
-- 培训准入第十九批：培训计划版本复制
-- 前置：training-admission-v1.sql 至 training-admission-v18.sql 已执行。
-- ============================================================================

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1 CHECK (version_no > 0),
  ADD COLUMN IF NOT EXISTS supersedes_plan_id UUID REFERENCES public.training_plans(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.training_clone_plan_version(p_plan_id UUID)
RETURNS UUID AS $$
DECLARE v_old public.training_plans%ROWTYPE; v_new UUID; v_version INT;
BEGIN
  SELECT * INTO v_old FROM public.training_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF NOT ((v_old.level = 'company' AND public.training_is_company_admin()) OR public.training_can_write(v_old.department_id)) THEN
    RAISE EXCEPTION '您无权复制该培训计划版本';
  END IF;
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.training_plans WHERE id = p_plan_id OR supersedes_plan_id = p_plan_id;
  INSERT INTO public.training_plans(
    title, category, level, department_id, parent_plan_id, plan_year, plan_month, start_date, end_date,
    hours, trainer, location, target_desc, content, require_exam, status, remark, deadline, required_hours,
    publish_status, exam_mode, approval_status, created_by, version_no, supersedes_plan_id
  ) VALUES (
    v_old.title || '（v' || v_version || '）', v_old.category, v_old.level, v_old.department_id, v_old.parent_plan_id,
    EXTRACT(YEAR FROM CURRENT_DATE)::INT, NULL, NULL, NULL, v_old.hours, v_old.trainer, v_old.location,
    v_old.target_desc, v_old.content, v_old.require_exam, 'planned', v_old.remark, NULL, v_old.required_hours,
    'draft', v_old.exam_mode, 'draft', auth.uid(), v_version, p_plan_id
  ) RETURNING id INTO v_new;
  INSERT INTO public.training_plan_targets(plan_id, department_id, due_date)
  SELECT v_new, department_id, NULL FROM public.training_plan_targets WHERE plan_id = p_plan_id
  ON CONFLICT (plan_id, department_id) DO NOTHING;
  INSERT INTO public.training_courses(plan_id, title, course_type, file_path, file_url, content, page_count, duration_sec, required, sort_order)
  SELECT v_new, title, course_type, file_path, file_url, content, page_count, duration_sec, required, sort_order
  FROM public.training_courses WHERE plan_id = p_plan_id;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_clone_plan_version(UUID) TO authenticated;

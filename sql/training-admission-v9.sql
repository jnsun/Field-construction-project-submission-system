-- ============================================================================
-- 培训准入第九批：综合准入考试自动联动
-- 前置：training-admission-v1.sql 至 training-admission-v8.sql 已执行。
-- 管理员需在现有“试卷管理”中发布一套 20 题、30 分钟的综合准入试卷，
-- 并在培训包中选择其对应培训计划。
-- ============================================================================

ALTER TABLE public.training_admission_packages
  ADD COLUMN IF NOT EXISTS exam_plan_id UUID REFERENCES public.training_plans(id) ON DELETE RESTRICT;
ALTER TABLE public.training_admissions
  ADD COLUMN IF NOT EXISTS exam_assignment_id UUID REFERENCES public.training_assignments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_training_admissions_exam_assignment ON public.training_admissions(exam_assignment_id);

-- 员工在全部三级/专项学习完成后，创建或复用综合考试任务。
DROP FUNCTION IF EXISTS public.training_prepare_admission_exam(UUID);
CREATE FUNCTION public.training_prepare_admission_exam(p_admission_id UUID)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_plan UUID; v_assignment UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND OR v_a.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '准入记录不存在或无权操作'; END IF;
  IF EXISTS (SELECT 1 FROM public.training_admission_tasks WHERE admission_id = p_admission_id AND status <> 'completed') THEN
    RAISE EXCEPTION '请先完成全部三级教育和专项培训';
  END IF;
  SELECT exam_plan_id INTO v_plan FROM public.training_admission_packages WHERE id = v_a.package_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION '该培训包尚未配置综合准入考试'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exam_papers WHERE plan_id = v_plan AND status = 'published') THEN
    RAISE EXCEPTION '综合准入考试尚未发布试卷';
  END IF;
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id, exam_status)
  SELECT v_plan, e.id, pr.id, e.department_id, 'pending'
  FROM public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id = e.id
  WHERE e.id = v_a.employee_id
  ON CONFLICT (plan_id, employee_id) DO UPDATE SET user_id = EXCLUDED.user_id, department_id = EXCLUDED.department_id
  RETURNING id INTO v_assignment;
  UPDATE public.training_admissions SET exam_assignment_id = v_assignment, exam_required = TRUE, updated_at = NOW()
  WHERE id = p_admission_id;
  RETURN jsonb_build_object('plan_id', v_plan, 'assignment_id', v_assignment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_prepare_admission_exam(UUID) TO authenticated;

-- 复用通用考试引擎的判分结果，自动回写对应项目准入记录。
DROP FUNCTION IF EXISTS public.training_sync_admission_exam();
CREATE FUNCTION public.training_sync_admission_exam()
RETURNS TRIGGER AS $$
DECLARE v_admission UUID;
BEGIN
  FOR v_admission IN SELECT id FROM public.training_admissions WHERE exam_assignment_id = NEW.id LOOP
    UPDATE public.training_admissions
    SET exam_passed = NEW.exam_status = 'passed', exam_score = NEW.exam_score,
        exam_attempts = COALESCE(NEW.exam_attempts, 0), updated_at = NOW()
    WHERE id = v_admission;
    PERFORM public.training_recompute_admission(v_admission);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_training_assignment_sync_admission_exam ON public.training_assignments;
CREATE TRIGGER trg_training_assignment_sync_admission_exam
  AFTER UPDATE OF exam_status, exam_score, exam_attempts ON public.training_assignments
  FOR EACH ROW EXECUTE FUNCTION public.training_sync_admission_exam();

-- 验证：SELECT proname FROM pg_proc WHERE proname = 'training_prepare_admission_exam';

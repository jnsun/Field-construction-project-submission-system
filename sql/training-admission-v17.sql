-- ============================================================================
-- 培训准入第十七批：学习过程随机确认题
-- 前置：training-admission-v1.sql 至 training-admission-v16.sql、exam-module.sql 已执行。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_study_quiz_for_course(p_course_id UUID)
RETURNS JSONB AS $$
DECLARE v_emp UUID; v_q public.exam_questions%ROWTYPE;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_courses c
    JOIN public.training_assignments a ON a.plan_id = c.plan_id AND a.employee_id = v_emp
    WHERE c.id = p_course_id
  ) THEN RAISE EXCEPTION '您无权学习该课件'; END IF;

  -- 仅采用单选和判断题，适合作为不中断太久的学习确认题。
  SELECT * INTO v_q FROM public.exam_questions
  WHERE course_id = p_course_id AND status = 'published' AND question_type IN ('single', 'judge')
  ORDER BY random() LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO v_q FROM public.exam_questions
    WHERE scope = 'company' AND status = 'published' AND question_type IN ('single', 'judge')
    ORDER BY random() LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('question', NULL); END IF;
  RETURN jsonb_build_object('question', jsonb_build_object('id', v_q.id, 'type', v_q.question_type, 'stem', v_q.stem, 'options', v_q.options));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_study_quiz_answer(p_course_id UUID, p_question_id UUID, p_answer TEXT)
RETURNS JSONB AS $$
DECLARE v_emp UUID; v_q public.exam_questions%ROWTYPE; v_ok BOOLEAN;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.training_courses c
    JOIN public.training_assignments a ON a.plan_id = c.plan_id AND a.employee_id = v_emp
    WHERE c.id = p_course_id
  ) THEN RAISE EXCEPTION '您无权提交该课件确认题'; END IF;
  SELECT * INTO v_q FROM public.exam_questions WHERE id = p_question_id AND status = 'published';
  IF NOT FOUND OR v_q.question_type NOT IN ('single', 'judge') THEN RAISE EXCEPTION '确认题不存在或不可用'; END IF;
  v_ok := upper(btrim(COALESCE(p_answer, ''))) = upper(btrim(COALESCE(v_q.answer, '')));
  INSERT INTO public.training_quiz_checks(employee_id, course_id, question_id, my_answer, correct)
  VALUES (v_emp, p_course_id, p_question_id, p_answer, v_ok);
  RETURN jsonb_build_object('correct', v_ok, 'analysis', v_q.analysis);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_study_quiz_for_course(UUID), public.training_study_quiz_answer(UUID, UUID, TEXT) TO authenticated;

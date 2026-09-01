-- ============================================================
-- exam-fix-v1.sql  在线考试模块 P0/P1 缺陷修复补丁
-- 修复内容：
--   1. [P0] exam_submit：v_qid 由 UUID 改为 TEXT，
--      修复 `operator does not exist: jsonb ->> uuid`（42883）——
--      原版交卷必失败，考试链路完全不通。
--   2. [P1] exam_start：原版对进行中的答卷先 RAISE 拦截，
--      续考 RETURN 成死代码 → 员工中途退出后「继续考试」永远报错。
--      现调整顺序为：已通过 → 续考（单会话锁）→ 次数用完检查；
--      续考返回补上 total_score（原缺，前端会显示"共 undefined 题"）。
-- 执行方式：Supabase SQL Editor 整文件执行一次（幂等，可重复执行）。
-- ============================================================

DROP FUNCTION IF EXISTS public.exam_start(UUID);
CREATE FUNCTION public.exam_start(p_plan_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_emp   UUID;
  v_dept  UUID;
  v_asg   public.training_assignments%ROWTYPE;
  v_paper public.exam_papers%ROWTYPE;
  v_r     public.exam_paper_rules%ROWTYPE;
  v_qs    JSONB;
  v_part  JSONB;
  v_att   public.exam_attempts%ROWTYPE;
  v_total NUMERIC;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;

  SELECT * INTO v_asg FROM public.training_assignments
  WHERE plan_id = p_plan_id AND employee_id = v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION '您不在该培训的参训范围内'; END IF;
  IF v_asg.exam_status = 'passed' THEN RAISE EXCEPTION '您已通过该培训考试'; END IF;

  SELECT department_id INTO v_dept FROM public.training_employees WHERE id = v_emp;

  SELECT * INTO v_paper FROM public.exam_papers
  WHERE plan_id = p_plan_id AND status = 'published'
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION '该培训尚未配置试卷'; END IF;

  -- 单会话锁：已有进行中的答卷则续考（必须在次数检查之前，进行中的答卷不计新次数）
  SELECT * INTO v_att FROM public.exam_attempts
  WHERE assignment_id = v_asg.id AND status = 'ongoing';
  IF FOUND THEN
    SELECT COALESCE(SUM((q->>'score')::numeric), 0) INTO v_total
    FROM jsonb_array_elements(v_att.questions) q;
    RETURN jsonb_build_object('attempt_id', v_att.id, 'deadline_at', v_att.deadline_at,
                              'total_score', v_total, 'questions', v_att.questions);
  END IF;

  IF v_asg.exam_attempts >= v_paper.retry_limit THEN
    RAISE EXCEPTION '考试次数已用完（共 % 次）', v_paper.retry_limit;
  END IF;

  -- 组卷快照（固定 / 随机）
  v_qs := '[]'::jsonb;
  IF v_paper.mode = 'fixed' THEN
    SELECT jsonb_agg(x ORDER BY random()) INTO v_qs FROM (
      SELECT jsonb_build_object('id', q.id, 'type', q.question_type, 'stem', q.stem,
             'options', q.options, 'sub_questions', q.sub_questions, 'score', pq.score) AS x
      FROM public.exam_paper_questions pq
      JOIN public.exam_questions q ON q.id = pq.question_id
      WHERE pq.paper_id = v_paper.id AND q.status = 'published'
    ) t;
  ELSE
    FOR v_r IN SELECT * FROM public.exam_paper_rules WHERE paper_id = v_paper.id LOOP
      SELECT jsonb_agg(x ORDER BY random()) INTO v_part FROM (
        SELECT jsonb_build_object('id', q.id, 'type', q.question_type, 'stem', q.stem,
               'options', q.options, 'sub_questions', q.sub_questions, 'score', v_r.score_each) AS x
        FROM public.exam_questions q
        WHERE q.status = 'published'
          AND q.question_type = v_r.question_type
          AND (v_r.category IS NULL OR q.category = v_r.category)
          AND (q.scope = 'company' OR q.department_id = v_dept)
        ORDER BY random() LIMIT v_r.count
      ) t;
      v_qs := v_qs || COALESCE(v_part, '[]'::jsonb);
    END LOOP;
  END IF;

  IF v_qs IS NULL OR jsonb_array_length(v_qs) = 0 THEN
    RAISE EXCEPTION '题库题量不足，无法组卷，请联系管理员';
  END IF;

  SELECT COALESCE(SUM((q->>'score')::numeric), 0) INTO v_total
  FROM jsonb_array_elements(v_qs) q;

  INSERT INTO public.exam_attempts (paper_id, assignment_id, employee_id, attempt_no, questions, deadline_at)
  VALUES (v_paper.id, v_asg.id, v_emp, v_asg.exam_attempts + 1, v_qs,
          NOW() + make_interval(mins => v_paper.duration_min))
  RETURNING * INTO v_att;

  UPDATE public.training_assignments
  SET exam_status = 'ongoing', exam_attempts = v_att.attempt_no, updated_at = NOW()
  WHERE id = v_asg.id;

  RETURN jsonb_build_object('attempt_id', v_att.id, 'deadline_at', v_att.deadline_at,
                            'total_score', v_total, 'questions', v_qs);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_start(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 7. RPC：交卷判分（服务端唯一判分口；答案不存于快照）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exam_submit(UUID, JSONB);
CREATE FUNCTION public.exam_submit(p_attempt_id UUID, p_answers JSONB)
RETURNS JSONB AS $$
DECLARE
  v_emp    UUID;
  v_att    public.exam_attempts%ROWTYPE;
  v_paper  public.exam_papers%ROWTYPE;
  v_q      JSONB;
  v_qid    TEXT;
  v_type   TEXT;
  v_score  NUMERIC;
  v_my     TEXT;
  v_ans    TEXT;
  v_orig   public.exam_questions%ROWTYPE;
  v_ok     BOOLEAN;
  v_total  NUMERIC := 0;
  v_pass   BOOLEAN;
  v_status TEXT := 'submitted';
  v_subs   JSONB;
  v_i      INT;
  v_sub_score NUMERIC;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;

  SELECT * INTO v_att FROM public.exam_attempts
  WHERE id = p_attempt_id AND employee_id = v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION '答卷不存在'; END IF;
  IF v_att.status <> 'ongoing' THEN
    RETURN jsonb_build_object('score', v_att.score, 'result', v_att.result, 'already', true);
  END IF;

  SELECT * INTO v_paper FROM public.exam_papers WHERE id = v_att.paper_id;
  IF NOW() > v_att.deadline_at + INTERVAL '120 seconds' THEN
    v_status := 'timeout';   -- 超时仍按已答内容判分
  END IF;

  FOR v_q IN SELECT * FROM jsonb_array_elements(v_att.questions) LOOP
    v_qid   := v_q->>'id';
    v_type  := v_q->>'type';
    v_score := COALESCE((v_q->>'score')::numeric, 1);
    SELECT * INTO v_orig FROM public.exam_questions WHERE id = v_qid::uuid;

    IF v_type = 'case' THEN
      -- 案例分析：逐子题判分；子题得分默认均分
      v_subs := COALESCE(v_orig.sub_questions, '[]'::jsonb);
      v_sub_score := CASE WHEN jsonb_array_length(v_subs) > 0
                          THEN v_score / jsonb_array_length(v_subs) ELSE v_score END;
      v_ok := TRUE;
      FOR v_i IN 0 .. jsonb_array_length(v_subs) - 1 LOOP
        v_ans := upper(btrim(COALESCE(v_subs->v_i->>'answer','')));
        v_my  := upper(btrim(COALESCE(p_answers->v_qid->>v_i, '')));
        IF v_my IS DISTINCT FROM v_ans THEN v_ok := FALSE; END IF;
      END LOOP;
      IF v_ok THEN v_total := v_total + v_score; END IF;
    ELSE
      v_my  := upper(btrim(COALESCE(p_answers->>v_qid, '')));
      v_ans := upper(btrim(COALESCE(v_orig.answer, '')));
      IF v_type = 'multi' THEN
        -- 多选全对才得分（字符集排序后比较，容忍顺序差异）
        v_ok := v_my <> '' AND (
          (SELECT string_agg(c, '' ORDER BY c) FROM regexp_split_to_table(v_my, '') c) =
          (SELECT string_agg(c, '' ORDER BY c) FROM regexp_split_to_table(v_ans, '') c)
        );
      ELSE
        v_ok := v_my <> '' AND v_my = v_ans;
      END IF;
      IF v_ok THEN v_total := v_total + v_score; END IF;
    END IF;

    -- 错题入本
    IF NOT v_ok THEN
      INSERT INTO public.exam_wrong_book (employee_id, question_id, attempt_id, my_answer, correct_answer)
      VALUES (v_emp, v_qid::uuid, v_att.id, COALESCE(p_answers->>v_qid, ''), v_orig.answer);
    END IF;
  END LOOP;

  v_pass := v_total >= v_paper.pass_score;

  UPDATE public.exam_attempts SET
    answers = p_answers, score = v_total,
    result = CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
    submitted_at = NOW(), status = v_status
  WHERE id = v_att.id;

  UPDATE public.training_assignments SET
    exam_status = CASE WHEN v_pass THEN 'passed' ELSE 'failed' END,
    exam_score  = v_total,
    updated_at  = NOW()
  WHERE id = v_att.assignment_id;

  RETURN jsonb_build_object('score', v_total, 'pass_line', v_paper.pass_score,
                            'result', CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
                            'timeout', v_status = 'timeout');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_submit(UUID, JSONB) TO authenticated;

-- ============================================================
-- 3. 附带修复：training_my_trainings 返回值增加 exam_mode 字段，
--    员工端学完课件后可按考试模式显示正确提示（去考试 vs 自动记录）。
-- ============================================================

DROP FUNCTION IF EXISTS public.training_my_trainings();
CREATE FUNCTION public.training_my_trainings()
RETURNS TABLE (
  plan_id        UUID,
  title          TEXT,
  category       TEXT,
  deadline       DATE,
  required_hours NUMERIC,
  status         TEXT,
  progress       NUMERIC,
  course_total   INT,
  course_done    INT,
  completed_at   TIMESTAMPTZ,
  exam_mode      TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.title, p.category, p.deadline, p.required_hours,
         CASE WHEN a.status <> 'completed' AND p.deadline IS NOT NULL AND p.deadline < CURRENT_DATE
              THEN 'overdue' ELSE a.status END,
         a.progress,
         (SELECT COUNT(*)::INT FROM public.training_courses c
           WHERE c.plan_id = p.id AND c.required),
         (SELECT COUNT(*)::INT FROM public.training_courses c
            JOIN public.training_course_progress cp ON cp.course_id = c.id
           WHERE c.plan_id = p.id AND c.required
             AND cp.employee_id = a.employee_id AND cp.finished),
         a.completed_at,
         p.exam_mode
  FROM public.training_assignments a
  JOIN public.training_plans p ON p.id = a.plan_id
  WHERE (a.user_id = auth.uid()
         OR a.employee_id = public.training_my_employee_id())
    AND p.publish_status = 'published'
  ORDER BY (a.status = 'completed'), p.deadline NULLS LAST, p.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.training_my_trainings() TO authenticated;

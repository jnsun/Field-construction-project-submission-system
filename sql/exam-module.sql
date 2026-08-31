-- ==========================================================================
-- 培训 v2：考核考试模块（三级题库 / 组卷 / 答卷判分 / 错题本 / 弹窗校验 / 签字）
--
-- 依赖：sql/training-online-v2.sql（新版：含 plans.exam_mode 与 assignments 考试字段）
--       sql/training-management.sql + training-fix-v13.sql（更早底座）
--
-- 判分口径（2026-08-31 用户确认）：
--   · 多选全对才得分；单选/判断精确匹配
--   · 案例分析 = 材料 + 子选择题，逐子题判分（自由文本无法自动判分，不做）
--   · 离线只记进度不算时长；补考次数默认 3（含首考），试卷可配
--   · 防作弊：答案永不下发 / 服务端限时惰性结算 / 单会话锁 / 切屏计数（不上摄像头）
--
-- 执行：云 Supabase → SQL Editor → 粘贴全部 → Run（幂等）
-- ==========================================================================

-- 0. 前置校验
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='training_plans' AND column_name='exam_mode'
  ) THEN
    RAISE EXCEPTION '请先执行新版 sql/training-online-v2.sql（含 plans.exam_mode）';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1. 三级试题库
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company','dept','project')),
  department_id UUID REFERENCES public.departments(id) ON DELETE CASCADE,
  category      TEXT,                    -- 知识点分类（组卷抽题维度）
  question_type TEXT NOT NULL CHECK (question_type IN ('single','multi','judge','case')),
  stem          TEXT NOT NULL,           -- 题干（case 题为材料）
  options       JSONB,                   -- [{key:'A',text:'…'}]
  sub_questions JSONB,                   -- case 子题：[{stem,options,answer,score}]
  answer        TEXT,                    -- 'A' / 'ABD'（多选）
  score_default NUMERIC(4,1) DEFAULT 1,
  analysis      TEXT,                    -- 解析（错题本展示）
  course_id     UUID REFERENCES public.training_courses(id) ON DELETE SET NULL, -- 关联课件（错题回看/弹窗抽题）
  status        TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exam_q_scope CHECK (
    (scope = 'company' AND department_id IS NULL)
    OR (scope IN ('dept','project') AND department_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_exam_q_scope ON public.exam_questions(scope, department_id, status);
CREATE INDEX IF NOT EXISTS idx_exam_q_course ON public.exam_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_exam_q_type ON public.exam_questions(question_type, category);

DROP TRIGGER IF EXISTS trg_exam_q_updated ON public.exam_questions;
CREATE TRIGGER trg_exam_q_updated BEFORE UPDATE ON public.exam_questions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 2. 试卷（固定 / 随机）及其题目与抽题规则
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_papers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      UUID REFERENCES public.training_plans(id) ON DELETE CASCADE,  -- 挂接计划（可空=备用卷）
  title        TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'fixed' CHECK (mode IN ('fixed','random')),
  duration_min INT NOT NULL DEFAULT 30,
  pass_score   NUMERIC(5,1) NOT NULL DEFAULT 60,
  retry_limit  INT NOT NULL DEFAULT 3,      -- 含首考
  shuffle      BOOLEAN NOT NULL DEFAULT TRUE,   -- 题序乱序（选项不乱序，保证 key 对应）
  total_score  NUMERIC(5,1),                -- 固定卷自动汇总；随机卷由快照求和
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.exam_paper_questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id   UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.exam_questions(id) ON DELETE CASCADE,
  score      NUMERIC(4,1),
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (paper_id, question_id)
);

CREATE TABLE IF NOT EXISTS public.exam_paper_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  question_type TEXT NOT NULL CHECK (question_type IN ('single','multi','judge','case')),
  category      TEXT,                      -- NULL=不限
  count         INT NOT NULL DEFAULT 5,
  score_each    NUMERIC(4,1) NOT NULL DEFAULT 1
);

-- --------------------------------------------------------------------------
-- 3. 答卷（题目快照落库，复查/申诉/错题本有据可查）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_attempts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      UUID NOT NULL REFERENCES public.exam_papers(id) ON DELETE CASCADE,
  assignment_id UUID NOT NULL REFERENCES public.training_assignments(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  attempt_no    INT NOT NULL DEFAULT 1,
  questions     JSONB NOT NULL,            -- 快照：[{id,type,stem,options,sub_questions,score}] 无答案
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at   TIMESTAMPTZ NOT NULL,
  submitted_at  TIMESTAMPTZ,
  answers       JSONB,                     -- {qid:'A'} ；case 题 {qid:['A','C',…]}
  score         NUMERIC(5,1),
  result        TEXT CHECK (result IN ('pass','fail')),
  switch_count  INT NOT NULL DEFAULT 0,    -- 切屏次数（防作弊观察项）
  status        TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','submitted','timeout')),
  UNIQUE (assignment_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_exam_att_emp ON public.exam_attempts(employee_id);

-- --------------------------------------------------------------------------
-- 4. 错题本 / 学习弹窗校验记录 / 签字
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exam_wrong_book (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  question_id     UUID REFERENCES public.exam_questions(id) ON DELETE CASCADE,
  attempt_id      UUID REFERENCES public.exam_attempts(id) ON DELETE SET NULL,
  my_answer       TEXT,
  correct_answer  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved        BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_exam_wb_emp ON public.exam_wrong_book(employee_id, resolved);

CREATE TABLE IF NOT EXISTS public.training_quiz_checks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  course_id   UUID REFERENCES public.training_courses(id) ON DELETE CASCADE,
  question_id UUID REFERENCES public.exam_questions(id) ON DELETE SET NULL,
  my_answer   TEXT,
  correct     BOOLEAN NOT NULL DEFAULT FALSE,
  asked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_chk_emp ON public.training_quiz_checks(employee_id, asked_at);

CREATE TABLE IF NOT EXISTS public.training_signatures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID UNIQUE REFERENCES public.training_assignments(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  storage_path  TEXT NOT NULL,             -- training-courses/signatures/{assignmentId}_{ts}.png
  signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_info   TEXT
);

-- --------------------------------------------------------------------------
-- 5. RLS
-- --------------------------------------------------------------------------
ALTER TABLE public.exam_questions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_papers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_paper_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_paper_rules     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_wrong_book      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_quiz_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signatures  ENABLE ROW LEVEL SECURITY;

-- 题库：与 training_library 同款三级可见/可写
DROP POLICY IF EXISTS "exam_q_select" ON public.exam_questions;
CREATE POLICY "exam_q_select" ON public.exam_questions
  FOR SELECT TO authenticated
  USING (
    scope = 'company'
    OR (department_id IS NOT NULL AND public.training_can_read(department_id))
  );

DROP POLICY IF EXISTS "exam_q_write" ON public.exam_questions;
CREATE POLICY "exam_q_write" ON public.exam_questions
  FOR ALL TO authenticated
  USING (
    public.is_admin()
    AND (
      (scope = 'company' AND public.training_is_company_admin())
      OR (department_id IS NOT NULL AND public.training_can_write(department_id))
    )
  )
  WITH CHECK (
    public.is_admin()
    AND (
      (scope = 'company' AND public.training_is_company_admin())
      OR (department_id IS NOT NULL AND public.training_can_write(department_id))
    )
  );

-- 试卷/规则：管理端经 RLS 直接管；员工答题信息一律走 SECURITY DEFINER RPC
DROP POLICY IF EXISTS "exam_paper_admin" ON public.exam_papers;
CREATE POLICY "exam_paper_admin" ON public.exam_papers
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "exam_pq_admin" ON public.exam_paper_questions;
CREATE POLICY "exam_pq_admin" ON public.exam_paper_questions
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "exam_rule_admin" ON public.exam_paper_rules;
CREATE POLICY "exam_rule_admin" ON public.exam_paper_rules
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 答卷：本人读写 + 管理员可查
DROP POLICY IF EXISTS "exam_att_select" ON public.exam_attempts;
CREATE POLICY "exam_att_select" ON public.exam_attempts
  FOR SELECT TO authenticated
  USING (employee_id = public.training_my_employee_id() OR public.is_admin());
DROP POLICY IF EXISTS "exam_att_write" ON public.exam_attempts;
CREATE POLICY "exam_att_write" ON public.exam_attempts
  FOR ALL TO authenticated
  USING (employee_id = public.training_my_employee_id())
  WITH CHECK (employee_id = public.training_my_employee_id());

-- 错题本 / 弹窗校验 / 签字：本人读写 + 管理员可查
DROP POLICY IF EXISTS "exam_wb_me" ON public.exam_wrong_book;
CREATE POLICY "exam_wb_me" ON public.exam_wrong_book
  FOR ALL TO authenticated
  USING (employee_id = public.training_my_employee_id() OR public.is_admin())
  WITH CHECK (employee_id = public.training_my_employee_id());
DROP POLICY IF EXISTS "quiz_chk_me" ON public.training_quiz_checks;
CREATE POLICY "quiz_chk_me" ON public.training_quiz_checks
  FOR ALL TO authenticated
  USING (employee_id = public.training_my_employee_id() OR public.is_admin())
  WITH CHECK (employee_id = public.training_my_employee_id());
DROP POLICY IF EXISTS "sig_me" ON public.training_signatures;
CREATE POLICY "sig_me" ON public.training_signatures
  FOR ALL TO authenticated
  USING (employee_id = public.training_my_employee_id() OR public.is_admin())
  WITH CHECK (employee_id = public.training_my_employee_id());

-- --------------------------------------------------------------------------
-- 6. RPC：开考（组卷快照）
-- --------------------------------------------------------------------------
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

  IF v_asg.exam_status = 'ongoing' OR v_asg.exam_attempts >= v_paper.retry_limit THEN
    IF v_asg.exam_status = 'ongoing' THEN
      RAISE EXCEPTION '您有一场进行中的考试，请先完成或等待超时结算';
    END IF;
    RAISE EXCEPTION '考试次数已用完（共 % 次）', v_paper.retry_limit;
  END IF;

  -- 单会话锁：已有进行中的答卷则续考
  SELECT * INTO v_att FROM public.exam_attempts
  WHERE assignment_id = v_asg.id AND status = 'ongoing';
  IF FOUND THEN
    RETURN jsonb_build_object('attempt_id', v_att.id, 'deadline_at', v_att.deadline_at,
                              'questions', v_att.questions);
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
  v_qid    UUID;
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
    v_qid   := (v_q->>'id')::uuid;
    v_type  := v_q->>'type';
    v_score := COALESCE((v_q->>'score')::numeric, 1);
    SELECT * INTO v_orig FROM public.exam_questions WHERE id = v_qid;

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
      VALUES (v_emp, v_qid, v_att.id, COALESCE(p_answers->>v_qid, ''), v_orig.answer);
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

-- 切屏计数
DROP FUNCTION IF EXISTS public.exam_report_switch(UUID);
CREATE FUNCTION public.exam_report_switch(p_attempt_id UUID)
RETURNS VOID AS $$
  UPDATE public.exam_attempts SET switch_count = switch_count + 1
  WHERE id = p_attempt_id AND employee_id = public.training_my_employee_id() AND status = 'ongoing';
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_report_switch(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 8. RPC：错题本
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exam_my_wrong_book(BOOLEAN);
CREATE FUNCTION public.exam_my_wrong_book(p_unresolved_only BOOLEAN DEFAULT FALSE)
RETURNS TABLE (
  wrong_id UUID, question_id UUID, question_type TEXT, stem TEXT,
  options JSONB, my_answer TEXT, correct_answer TEXT, analysis TEXT,
  course_title TEXT, created_at TIMESTAMPTZ, resolved BOOLEAN
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.id, q.id, q.question_type, q.stem, q.options,
         w.my_answer, w.correct_answer, q.analysis,
         c.title, w.created_at, w.resolved
  FROM public.exam_wrong_book w
  JOIN public.exam_questions q ON q.id = w.question_id
  LEFT JOIN public.training_courses c ON c.id = q.course_id
  WHERE w.employee_id = public.training_my_employee_id()
    AND (NOT p_unresolved_only OR NOT w.resolved)
  ORDER BY w.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.exam_my_wrong_book(BOOLEAN) TO authenticated;

DROP FUNCTION IF EXISTS public.exam_wrong_resolve(UUID);
CREATE FUNCTION public.exam_wrong_resolve(p_question_id UUID)
RETURNS VOID AS $$
  UPDATE public.exam_wrong_book SET resolved = TRUE
  WHERE employee_id = public.training_my_employee_id()
    AND question_id = p_question_id AND resolved = FALSE;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_wrong_resolve(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 9. RPC：学习过程弹窗校验（题源=课件关联题，回退公司通用库）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.exam_quiz_for_course(UUID);
CREATE FUNCTION public.exam_quiz_for_course(p_course_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_emp UUID;
  v_q   public.exam_questions%ROWTYPE;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RETURN jsonb_build_object('question', NULL); END IF;

  SELECT * INTO v_q FROM public.exam_questions
  WHERE course_id = p_course_id AND status = 'published'
  ORDER BY random() LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_q FROM public.exam_questions
    WHERE scope = 'company' AND status = 'published'
    ORDER BY random() LIMIT 1;
  END IF;

  IF NOT FOUND THEN RETURN jsonb_build_object('question', NULL); END IF;

  RETURN jsonb_build_object('question', jsonb_build_object(
    'id', v_q.id, 'type', v_q.question_type, 'stem', v_q.stem,
    'options', v_q.options, 'sub_questions', v_q.sub_questions));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_quiz_for_course(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.exam_quiz_answer(UUID, TEXT);
CREATE FUNCTION public.exam_quiz_answer(p_question_id UUID, p_answer TEXT)
RETURNS JSONB AS $$
DECLARE
  v_emp UUID;
  v_q   public.exam_questions%ROWTYPE;
  v_ok  BOOLEAN;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;
  SELECT * INTO v_q FROM public.exam_questions WHERE id = p_question_id;
  IF NOT FOUND THEN RAISE EXCEPTION '题目不存在'; END IF;

  v_ok := upper(btrim(COALESCE(p_answer,''))) = upper(btrim(COALESCE(v_q.answer,'')));

  INSERT INTO public.training_quiz_checks (employee_id, course_id, question_id, my_answer, correct)
  VALUES (v_emp, v_q.course_id, p_question_id, p_answer, v_ok);

  RETURN jsonb_build_object('correct', v_ok, 'analysis', v_q.analysis);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.exam_quiz_answer(UUID, TEXT) TO authenticated;

-- --------------------------------------------------------------------------
-- 10. RPC：培训完成手写签字（签字后任务才最终完成）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_submit_signature(UUID, TEXT, TEXT);
CREATE FUNCTION public.training_submit_signature(p_assignment_id UUID, p_path TEXT, p_device TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_emp  UUID;
  v_asg  public.training_assignments%ROWTYPE;
  v_mode TEXT;
  v_record_id UUID;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案'; END IF;
  IF COALESCE(p_path,'') = '' THEN RAISE EXCEPTION '缺少签字文件'; END IF;

  SELECT * INTO v_asg FROM public.training_assignments
  WHERE id = p_assignment_id AND employee_id = v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION '任务不存在'; END IF;

  SELECT COALESCE(exam_mode,'none') INTO v_mode
  FROM public.training_plans WHERE id = v_asg.plan_id;

  IF v_mode <> 'none' AND v_asg.exam_status IS DISTINCT FROM 'passed' THEN
    RAISE EXCEPTION '需先通过考试后再签字确认';
  END IF;
  IF v_asg.progress < 90 THEN
    RAISE EXCEPTION '请先完成全部必修课件后再签字确认';
  END IF;

  INSERT INTO public.training_signatures (assignment_id, employee_id, storage_path, device_info)
  VALUES (v_asg.id, v_emp, p_path, p_device)
  ON CONFLICT (assignment_id) DO UPDATE
    SET storage_path = EXCLUDED.storage_path, signed_at = NOW(), device_info = EXCLUDED.device_info;

  UPDATE public.training_assignments SET
    status = 'completed',
    completed_at = COALESCE(completed_at, NOW()),
    hours_earned = COALESCE(hours_earned,
      (SELECT required_hours FROM public.training_plans WHERE id = v_asg.plan_id)),
    updated_at = NOW()
  WHERE id = v_asg.id;

  -- 参训明细归档（有考试的计划此前未写入，此处兜底）
  SELECT id INTO v_record_id FROM public.training_records
  WHERE plan_id = v_asg.plan_id AND source = 'auto' LIMIT 1;
  IF v_record_id IS NOT NULL THEN
    INSERT INTO public.training_participants (record_id, employee_id, employee_name, department_id, signed, score, result)
    SELECT v_record_id, e.id, e.name, e.department_id, TRUE, v_asg.exam_score, 'pass'
    FROM public.training_employees e WHERE e.id = v_emp
    ON CONFLICT DO NOTHING;

    UPDATE public.training_participants
    SET score = COALESCE(score, v_asg.exam_score), result = 'pass'
    WHERE record_id = v_record_id AND employee_id = v_emp;

    UPDATE public.training_records
    SET participant_count = (SELECT COUNT(*) FROM public.training_participants WHERE record_id = v_record_id)
    WHERE id = v_record_id;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_submit_signature(UUID, TEXT, TEXT) TO authenticated;

-- ==========================================================================
-- 执行完成后验证：
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('exam_start','exam_submit','exam_report_switch','exam_my_wrong_book',
--      'exam_wrong_resolve','exam_quiz_for_course','exam_quiz_answer',
--      'training_submit_signature');                       -- 8 个 RPC 已建
--   SELECT COUNT(*) FROM information_schema.tables
--    WHERE table_schema='public' AND table_name IN
--    ('exam_questions','exam_papers','exam_attempts','exam_wrong_book',
--     'training_quiz_checks','training_signatures');      -- = 6
-- ==========================================================================

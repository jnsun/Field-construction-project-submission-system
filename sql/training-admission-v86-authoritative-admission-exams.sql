-- D13：综合准入考试与专项考试服务端权威状态机。
BEGIN;

ALTER TABLE public.exam_papers
  ADD COLUMN IF NOT EXISTS exam_type TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS special_type TEXT,
  ADD COLUMN IF NOT EXISTS question_count INTEGER NOT NULL DEFAULT 20;
ALTER TABLE public.exam_papers ALTER COLUMN pass_score SET DEFAULT 80;
ALTER TABLE public.exam_papers DROP CONSTRAINT IF EXISTS exam_papers_d13_config_check;
ALTER TABLE public.exam_papers ADD CONSTRAINT exam_papers_d13_config_check CHECK (
  exam_type IN ('general','admission','special')
  AND ((exam_type='special' AND special_type IN ('blasting','electrical','welding','drilling')) OR (exam_type<>'special' AND special_type IS NULL))
  AND question_count BETWEEN 1 AND 200 AND duration_min BETWEEN 1 AND 240
  AND pass_score BETWEEN 0 AND 100 AND retry_limit BETWEEN 1 AND 10
) NOT VALID;

ALTER TABLE public.exam_attempts
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS admission_id UUID REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS exam_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS special_type TEXT,
  ADD COLUMN IF NOT EXISTS rule_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_d13_context_check;
ALTER TABLE public.exam_attempts ADD CONSTRAINT exam_attempts_d13_context_check CHECK (
  exam_type='legacy'
  OR (exam_type='admission' AND project_id IS NOT NULL AND admission_id IS NOT NULL AND special_type IS NULL)
  OR (exam_type='special' AND project_id IS NOT NULL AND admission_id IS NOT NULL AND special_type IN ('blasting','electrical','welding','drilling'))
) NOT VALID;
ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_assignment_id_attempt_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_legacy_assignment_attempt_idx
  ON public.exam_attempts(assignment_id,attempt_no) WHERE exam_type='legacy';
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_d13_requirement_attempt_idx
  ON public.exam_attempts(employee_id,admission_id,exam_type,COALESCE(special_type,''),attempt_no)
  WHERE admission_id IS NOT NULL AND exam_type IN ('admission','special');
DROP INDEX IF EXISTS exam_attempts_one_ongoing_assignment_idx;
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_one_ongoing_requirement_idx
  ON public.exam_attempts(employee_id,admission_id,exam_type,COALESCE(special_type,'')) WHERE status='ongoing';
CREATE UNIQUE INDEX IF NOT EXISTS exam_attempts_idempotency_idx
  ON public.exam_attempts(employee_id,admission_id,exam_type,COALESCE(special_type,''),idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS exam_attempts_project_summary_idx
  ON public.exam_attempts(project_id,employee_id,exam_type,special_type,attempt_no DESC);

CREATE TABLE IF NOT EXISTS public.exam_attempt_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES public.exam_attempts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('started','resumed','submitted','timed_out')),
  actor_subject_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS exam_attempt_events_attempt_idx ON public.exam_attempt_events(attempt_id,occurred_at);
ALTER TABLE public.exam_attempt_events ENABLE ROW LEVEL SECURITY;

-- 普通客户端只能走 RPC；不能读取题库答案、直写答卷或破坏考试权威表。
DROP POLICY IF EXISTS "exam_q_select" ON public.exam_questions;
CREATE POLICY "exam_q_select" ON public.exam_questions FOR SELECT TO authenticated USING (
  public.is_admin() AND (scope='company' OR (department_id IS NOT NULL AND public.training_can_read(department_id)))
);
DROP POLICY IF EXISTS "exam_att_write" ON public.exam_attempts;
DROP POLICY IF EXISTS "exam_att_select" ON public.exam_attempts;
REVOKE ALL ON TABLE public.exam_attempts,public.exam_attempt_events FROM PUBLIC,anon,authenticated;
REVOKE TRUNCATE,REFERENCES,TRIGGER ON TABLE public.exam_questions,public.exam_papers,
  public.exam_paper_questions,public.exam_paper_rules FROM anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_paper_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.exam_type NOT IN ('general','admission','special')
     OR NEW.question_count NOT BETWEEN 1 AND 200 OR NEW.duration_min NOT BETWEEN 1 AND 240
     OR NEW.pass_score NOT BETWEEN 0 AND 100 OR NEW.retry_limit NOT BETWEEN 1 AND 10
     OR (NEW.exam_type='special' AND public.training_special_type_code(NEW.special_type) IS NULL)
     OR (NEW.exam_type<>'special' AND NEW.special_type IS NOT NULL) THEN
    RAISE EXCEPTION '[D13:invalid_exam_configuration] 考试类型、题数、时长、及格线或次数配置不合法';
  END IF;
  IF NEW.exam_type='special' THEN NEW.special_type:=public.training_special_type_code(NEW.special_type); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_paper_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_exam_paper_guard ON public.exam_papers;
CREATE TRIGGER trg_training_exam_paper_guard BEFORE INSERT OR UPDATE OF exam_type,special_type,question_count,duration_min,pass_score,retry_limit
  ON public.exam_papers FOR EACH ROW EXECUTE FUNCTION public.training_exam_paper_guard();

CREATE OR REPLACE FUNCTION public.training_exam_attempt_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' AND current_setting('app.exam_attempt_mutation',TRUE)='rpc' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='ongoing' AND current_setting('app.exam_attempt_mutation',TRUE)='rpc' THEN
    NEW.updated_at:=NOW(); RETURN NEW;
  END IF;
  RAISE EXCEPTION '[D13:exam_history_locked] 考试答卷及正式结果不可直接修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_attempt_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_exam_attempt_admission_gate ON public.exam_attempts;
DROP TRIGGER IF EXISTS trg_training_exam_attempt_guard ON public.exam_attempts;
CREATE TRIGGER trg_training_exam_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.exam_attempts
  FOR EACH ROW EXECUTE FUNCTION public.training_exam_attempt_guard();

CREATE OR REPLACE FUNCTION public.training_exam_shuffle_options(p_options JSONB)
RETURNS JSONB AS $$
  SELECT CASE WHEN jsonb_typeof(p_options)<>'array' THEN COALESCE(p_options,'[]'::jsonb)
    ELSE COALESCE((SELECT jsonb_agg(value ORDER BY random()) FROM jsonb_array_elements(p_options)),'[]'::jsonb) END;
$$ LANGUAGE sql VOLATILE SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_shuffle_options(JSONB) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_public_questions(p_questions JSONB)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(
    (q.value-'correct_answer'-'analysis') || jsonb_build_object('sub_questions',
      CASE WHEN jsonb_typeof(q.value->'sub_questions')='array' THEN
        COALESCE((SELECT jsonb_agg(s.value-'answer') FROM jsonb_array_elements(q.value->'sub_questions') s),'[]'::jsonb)
      ELSE COALESCE(q.value->'sub_questions','[]'::jsonb) END)
    ORDER BY q.ordinality),'[]'::jsonb)
  FROM jsonb_array_elements(COALESCE(p_questions,'[]'::jsonb)) WITH ORDINALITY q(value,ordinality);
$$ LANGUAGE sql IMMUTABLE SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_public_questions(JSONB) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_response_internal(p_attempt_id UUID,p_include_questions BOOLEAN DEFAULT TRUE)
RETURNS JSONB AS $$
DECLARE v public.exam_attempts; v_limit INTEGER; v_remaining INTEGER;
BEGIN
  SELECT * INTO v FROM public.exam_attempts WHERE id=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 考试不存在'; END IF;
  v_limit:=COALESCE((v.rule_snapshot->>'max_attempts')::INTEGER,v.attempt_no);
  v_remaining:=GREATEST(v_limit-v.attempt_no,0);
  RETURN jsonb_build_object('attempt_id',v.id,'admission_id',v.admission_id,'project_id',v.project_id,
    'exam_type',v.exam_type,'special_type',v.special_type,'attempt_no',v.attempt_no,
    'status',CASE WHEN v.status='ongoing' THEN 'in_progress' WHEN v.status='timeout' THEN 'timed_out' ELSE v.status END,
    'started_at',v.started_at,'deadline_at',v.deadline_at,'server_now',clock_timestamp(),
    'submitted_at',v.submitted_at,'score',v.score,'result',v.result,
    'pass_line',(v.rule_snapshot->>'pass_score')::NUMERIC,'max_attempts',v_limit,
    'remaining_attempts',v_remaining,'questions',CASE WHEN p_include_questions AND v.status='ongoing' THEN public.training_exam_public_questions(v.questions) ELSE '[]'::jsonb END,
    'question_count',jsonb_array_length(v.questions),'rule_version',v.rule_snapshot->>'rule_version');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_response_internal(UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_context_internal(p_admission_id UUID,p_exam_type TEXT,p_special_type TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_three JSONB; v_special JSONB; v_req JSONB; v_plan UUID; v_assignment UUID; v_type TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 准入记录不存在'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.site_project_members WHERE id=v_a.member_id AND status='active') THEN
    RAISE EXCEPTION '[D13:project_not_accessible] 当前人员已不在项目 active 范围';
  END IF;
  IF p_exam_type='admission' THEN
    v_three:=public.training_three_level_status(v_a.project_id,v_a.employee_id);
    IF v_three->>'person_category'='visitor' THEN RAISE EXCEPTION '[D13:prerequisite_not_met] visitor_safety_briefing_required'; END IF;
    IF v_three->>'person_category'='formal_internal' THEN
      IF NOT COALESCE((v_three->>'exam_allowed')::BOOLEAN,FALSE) THEN
        RAISE EXCEPTION '[D13:three_level_training_required] %',v_three->>'reason_code';
      END IF;
    ELSE
      IF NOT EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=v_a.id AND level='project' AND requirement_active)
         OR EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=v_a.id AND level='project' AND requirement_active AND status<>'completed') THEN
        RAISE EXCEPTION '[D13:project_admission_training_required] 外协或临时个人须先完成项目准入培训';
      END IF;
    END IF;
    SELECT exam_plan_id INTO v_plan FROM public.training_admission_packages WHERE id=v_a.package_id;
    IF v_plan IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published' AND exam_type='admission' AND special_type IS NULL) THEN
      RAISE EXCEPTION '[D13:exam_not_configured] 综合准入考试尚未正确配置';
    END IF;
  ELSIF p_exam_type='special' THEN
    v_type:=public.training_special_type_code(p_special_type);
    IF v_type IS NULL THEN RAISE EXCEPTION '[D13:special_exam_not_configured] 专项类型不合法'; END IF;
    v_special:=public.training_special_requirements_internal(v_a.project_id,v_a.employee_id);
    SELECT value INTO v_req FROM jsonb_array_elements(COALESCE(v_special->'requirements','[]'::jsonb)) WHERE value->>'special_type'=v_type;
    IF v_req IS NULL THEN RAISE EXCEPTION '[D13:special_requirement_not_met] 当前项目人员没有该专项考试要求'; END IF;
    IF v_req->>'training_status'<>'completed' OR v_req->'certificate'->>'state' NOT IN ('valid','not_required') THEN
      RAISE EXCEPTION '[D13:special_requirement_not_met] D12 专项证照或培训前置未满足';
    END IF;
    v_plan:=NULLIF(v_req->>'exam_plan_id','')::UUID;
    IF v_plan IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published' AND exam_type='special' AND special_type=v_type) THEN
      RAISE EXCEPTION '[D13:special_exam_not_configured] 专项考试配置缺失或类型不匹配';
    END IF;
  ELSE RAISE EXCEPTION '[D13:exam_not_configured] 考试类型不合法'; END IF;
  INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,exam_status)
  SELECT v_plan,e.id,pr.id,e.department_id,'pending' FROM public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id=e.id WHERE e.id=v_a.employee_id
  ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id RETURNING id INTO v_assignment;
  IF p_exam_type='admission' THEN
    -- assignment 可按计划+人员复用；D13 的项目隔离由 attempt.admission_id 保证，不能再写入旧的一对一绑定字段。
    UPDATE public.training_admissions SET exam_required=TRUE,updated_at=NOW() WHERE id=v_a.id;
  END IF;
  RETURN jsonb_build_object('admission_id',v_a.id,'project_id',v_a.project_id,'employee_id',v_a.employee_id,
    'plan_id',v_plan,'assignment_id',v_assignment,'exam_type',p_exam_type,'special_type',v_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_context_internal(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_start(p_admission_id UUID,p_exam_type TEXT DEFAULT 'admission',p_special_type TEXT DEFAULT NULL,p_idempotency_key TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_ctx JSONB; v_paper public.exam_papers; v_assignment public.training_assignments;
  v_att public.exam_attempts; v_qs JSONB:='[]'::jsonb; v_part JSONB; v_rule public.exam_paper_rules; v_no INTEGER; v_now TIMESTAMPTZ:=clock_timestamp();
  v_key TEXT:=NULLIF(btrim(p_idempotency_key),'');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D13:forbidden] 请先登录'; END IF;
  IF v_key IS NOT NULL AND length(v_key)>120 THEN RAISE EXCEPTION '[D13:invalid_idempotency_key] 幂等键过长'; END IF;
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND OR v_a.employee_id IS DISTINCT FROM public.training_my_employee_id() THEN RAISE EXCEPTION '[D13:forbidden] 只能参加本人的考试'; END IF;
  v_ctx:=public.training_exam_context_internal(p_admission_id,p_exam_type,p_special_type);
  SELECT * INTO v_assignment FROM public.training_assignments WHERE id=(v_ctx->>'assignment_id')::UUID FOR UPDATE;
  SELECT * INTO v_att FROM public.exam_attempts WHERE employee_id=v_a.employee_id AND admission_id=v_a.id
    AND exam_type=p_exam_type AND special_type IS NOT DISTINCT FROM CASE WHEN p_exam_type='special' THEN public.training_special_type_code(p_special_type) ELSE NULL END
    AND status='ongoing' ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_now<v_att.deadline_at THEN
      INSERT INTO public.exam_attempt_events(attempt_id,event_type,actor_subject_id,detail) VALUES(v_att.id,'resumed',auth.uid(),'{}');
      RETURN public.training_exam_response_internal(v_att.id,TRUE)||jsonb_build_object('idempotent',TRUE);
    END IF;
    PERFORM set_config('app.exam_attempt_mutation','rpc',TRUE);
    UPDATE public.exam_attempts SET status='timeout',result='fail',score=0,submitted_at=v_att.deadline_at WHERE id=v_att.id;
    UPDATE public.training_assignments SET exam_status='failed',exam_score=0,updated_at=NOW() WHERE id=v_assignment.id;
    INSERT INTO public.exam_attempt_events(attempt_id,event_type,actor_subject_id,detail) VALUES(v_att.id,'timed_out',auth.uid(),jsonb_build_object('deadline_at',v_att.deadline_at));
  END IF;
  IF v_key IS NOT NULL THEN
    SELECT * INTO v_att FROM public.exam_attempts WHERE employee_id=v_a.employee_id AND admission_id=v_a.id
      AND exam_type=p_exam_type AND special_type IS NOT DISTINCT FROM NULLIF(public.training_special_type_code(p_special_type),'') AND idempotency_key=v_key;
    IF FOUND THEN RETURN public.training_exam_response_internal(v_att.id,v_att.status='ongoing')||jsonb_build_object('idempotent',TRUE); END IF;
  END IF;
  SELECT * INTO v_paper FROM public.exam_papers WHERE plan_id=(v_ctx->>'plan_id')::UUID AND status='published'
    AND exam_type=p_exam_type AND special_type IS NOT DISTINCT FROM CASE WHEN p_exam_type='special' THEN public.training_special_type_code(p_special_type) ELSE NULL END
    ORDER BY updated_at DESC,id DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_configured] 找不到匹配的已发布试卷'; END IF;
  SELECT COALESCE(MAX(attempt_no),0)+1 INTO v_no FROM public.exam_attempts WHERE employee_id=v_a.employee_id AND admission_id=v_a.id
    AND exam_type=p_exam_type AND special_type IS NOT DISTINCT FROM CASE WHEN p_exam_type='special' THEN public.training_special_type_code(p_special_type) ELSE NULL END;
  IF v_no>v_paper.retry_limit THEN RAISE EXCEPTION '[D13:attempt_limit_reached] 考试次数已用完'; END IF;
  IF v_paper.mode='fixed' THEN
    SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) INTO v_qs FROM (
      SELECT jsonb_build_object('id',q.id,'type',q.question_type,'stem',q.stem,
        'options',CASE WHEN v_paper.shuffle THEN public.training_exam_shuffle_options(q.options) ELSE q.options END,
        'sub_questions',q.sub_questions,'score',COALESCE(pq.score,q.score_default,1),'correct_answer',q.answer,'analysis',q.analysis) item
      FROM public.exam_paper_questions pq JOIN public.exam_questions q ON q.id=pq.question_id
      WHERE pq.paper_id=v_paper.id AND q.status='published'
      ORDER BY CASE WHEN v_paper.shuffle THEN random() ELSE pq.sort_order::DOUBLE PRECISION END LIMIT v_paper.question_count
    ) picked;
  ELSE
    FOR v_rule IN SELECT * FROM public.exam_paper_rules WHERE paper_id=v_paper.id ORDER BY id LOOP
      SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) INTO v_part FROM (
        SELECT jsonb_build_object('id',q.id,'type',q.question_type,'stem',q.stem,
          'options',public.training_exam_shuffle_options(q.options),'sub_questions',q.sub_questions,
          'score',v_rule.score_each,'correct_answer',q.answer,'analysis',q.analysis) item
        FROM public.exam_questions q WHERE q.status='published' AND q.question_type=v_rule.question_type
          AND (v_rule.category IS NULL OR q.category=v_rule.category)
          AND (q.scope='company' OR q.department_id=(SELECT department_id FROM public.training_employees WHERE id=v_a.employee_id))
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_qs) old WHERE old->>'id'=q.id::TEXT)
        ORDER BY random() LIMIT v_rule.count
      ) picked;
      v_qs:=v_qs||v_part;
    END LOOP;
  END IF;
  IF jsonb_array_length(v_qs)<>v_paper.question_count THEN RAISE EXCEPTION '[D13:question_pool_insufficient] 题库题量或分类规则不足'; END IF;
  PERFORM set_config('app.exam_attempt_mutation','rpc',TRUE);
  INSERT INTO public.exam_attempts(paper_id,assignment_id,employee_id,project_id,admission_id,exam_type,special_type,
    attempt_no,questions,started_at,deadline_at,rule_snapshot,idempotency_key,status)
  VALUES(v_paper.id,v_assignment.id,v_a.employee_id,v_a.project_id,v_a.id,p_exam_type,
    CASE WHEN p_exam_type='special' THEN public.training_special_type_code(p_special_type) ELSE NULL END,
    v_no,v_qs,v_now,v_now+make_interval(mins=>v_paper.duration_min),
    jsonb_build_object('rule_version','D13-v1','paper_id',v_paper.id,'paper_updated_at',v_paper.updated_at,
      'question_count',v_paper.question_count,'duration_min',v_paper.duration_min,'pass_score',v_paper.pass_score,'max_attempts',v_paper.retry_limit),v_key,'ongoing') RETURNING * INTO v_att;
  UPDATE public.training_assignments SET exam_status='ongoing',exam_attempts=v_no,updated_at=NOW() WHERE id=v_assignment.id;
  INSERT INTO public.exam_attempt_events(attempt_id,event_type,actor_subject_id,detail)
    VALUES(v_att.id,'started',auth.uid(),jsonb_build_object('attempt_no',v_no,'exam_type',p_exam_type,'special_type',v_att.special_type));
  RETURN public.training_exam_response_internal(v_att.id,TRUE)||jsonb_build_object('idempotent',FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_start(UUID,TEXT,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_start(UUID,TEXT,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_get(p_attempt_id UUID)
RETURNS JSONB AS $$
DECLARE v public.exam_attempts; v_self BOOLEAN;
BEGIN
  SELECT * INTO v FROM public.exam_attempts WHERE id=p_attempt_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 考试不存在'; END IF;
  v_self:=v.employee_id=public.training_my_employee_id();
  IF NOT v_self AND NOT public.site_project_can_read_management_data(v.project_id) THEN RAISE EXCEPTION '[D13:forbidden] 无权查看该考试'; END IF;
  RETURN public.training_exam_response_internal(v.id,v_self);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_get(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_get(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_submit(p_attempt_id UUID,p_answers JSONB)
RETURNS JSONB AS $$
DECLARE v public.exam_attempts; v_q JSONB; v_id TEXT; v_my TEXT; v_right TEXT; v_ok BOOLEAN;
  v_earned NUMERIC:=0; v_possible NUMERIC:=0; v_points NUMERIC; v_score NUMERIC; v_pass BOOLEAN; v_now TIMESTAMPTZ:=clock_timestamp();
  v_subs JSONB; v_i INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D13:forbidden] 请先登录'; END IF;
  SELECT * INTO v FROM public.exam_attempts WHERE id=p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 考试不存在'; END IF;
  IF v.employee_id IS DISTINCT FROM public.training_my_employee_id() THEN RAISE EXCEPTION '[D13:forbidden] 不能替他人交卷'; END IF;
  IF v.status<>'ongoing' THEN RETURN public.training_exam_response_internal(v.id,FALSE)||jsonb_build_object('idempotent',TRUE,'reason_code','exam_already_submitted'); END IF;
  PERFORM set_config('app.exam_attempt_mutation','rpc',TRUE);
  IF v_now>=v.deadline_at THEN
    UPDATE public.exam_attempts SET status='timeout',result='fail',score=0,answers='{}'::jsonb,submitted_at=v.deadline_at WHERE id=v.id;
    UPDATE public.training_assignments SET exam_status='failed',exam_score=0,updated_at=NOW() WHERE id=v.assignment_id;
    IF v.exam_type='admission' THEN UPDATE public.training_admissions SET exam_passed=FALSE,exam_score=0,exam_attempts=v.attempt_no,updated_at=NOW() WHERE id=v.admission_id; END IF;
    INSERT INTO public.exam_attempt_events(attempt_id,event_type,actor_subject_id,detail) VALUES(v.id,'timed_out',auth.uid(),jsonb_build_object('deadline_at',v.deadline_at));
    RETURN public.training_exam_response_internal(v.id,FALSE)||jsonb_build_object('idempotent',FALSE,'reason_code','exam_timed_out');
  END IF;
  IF jsonb_typeof(COALESCE(p_answers,'{}'::jsonb))<>'object' THEN RAISE EXCEPTION '[D13:invalid_answers] 答案必须是对象'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(p_answers,'{}'::jsonb)) key WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.questions) q WHERE q->>'id'=key)) THEN
    RAISE EXCEPTION '[D13:invalid_answers] 提交了不属于本试卷的题目';
  END IF;
  FOR v_q IN SELECT * FROM jsonb_array_elements(v.questions) LOOP
    v_id:=v_q->>'id'; v_points:=COALESCE((v_q->>'score')::NUMERIC,1); v_possible:=v_possible+v_points; v_ok:=TRUE;
    IF v_q->>'type'='case' THEN
      v_subs:=COALESCE(v_q->'sub_questions','[]'::jsonb);
      IF jsonb_array_length(v_subs)=0 THEN v_ok:=FALSE; ELSE
        FOR v_i IN 0..jsonb_array_length(v_subs)-1 LOOP
          v_my:=upper(btrim(COALESCE(p_answers->v_id->>v_i,''))); v_right:=upper(btrim(COALESCE(v_subs->v_i->>'answer','')));
          IF v_my='' OR v_my IS DISTINCT FROM v_right THEN v_ok:=FALSE; END IF;
        END LOOP;
      END IF;
    ELSE
      v_my:=upper(btrim(COALESCE(p_answers->>v_id,''))); v_right:=upper(btrim(COALESCE(v_q->>'correct_answer','')));
      IF v_q->>'type'='multi' THEN
        v_ok:=v_my<>'' AND (SELECT string_agg(c,'' ORDER BY c) FROM regexp_split_to_table(v_my,'') c)=(SELECT string_agg(c,'' ORDER BY c) FROM regexp_split_to_table(v_right,'') c);
      ELSE v_ok:=v_my<>'' AND v_my=v_right; END IF;
    END IF;
    IF v_ok THEN v_earned:=v_earned+v_points; END IF;
  END LOOP;
  v_score:=CASE WHEN v_possible>0 THEN round(v_earned*100/v_possible,2) ELSE 0 END;
  v_pass:=v_score>=COALESCE((v.rule_snapshot->>'pass_score')::NUMERIC,80);
  UPDATE public.exam_attempts SET answers=COALESCE(p_answers,'{}'::jsonb),score=v_score,result=CASE WHEN v_pass THEN 'pass' ELSE 'fail' END,
    submitted_at=v_now,status='submitted' WHERE id=v.id;
  UPDATE public.training_assignments SET exam_status=CASE WHEN v_pass THEN 'passed' ELSE 'failed' END,exam_score=v_score,exam_attempts=v.attempt_no,updated_at=NOW() WHERE id=v.assignment_id;
  IF v.exam_type='admission' THEN UPDATE public.training_admissions SET exam_passed=v_pass,exam_score=v_score,exam_attempts=v.attempt_no,updated_at=NOW() WHERE id=v.admission_id; END IF;
  INSERT INTO public.exam_attempt_events(attempt_id,event_type,actor_subject_id,detail)
    VALUES(v.id,'submitted',auth.uid(),jsonb_build_object('score',v_score,'result',CASE WHEN v_pass THEN 'pass' ELSE 'fail' END));
  RETURN public.training_exam_response_internal(v.id,FALSE)||jsonb_build_object('idempotent',FALSE,'reason_code',CASE WHEN v_pass THEN 'exam_passed' ELSE 'exam_failed' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_submit(UUID,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_submit(UUID,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_report_switch(p_attempt_id UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.exam_attempt_mutation','rpc',TRUE);
  UPDATE public.exam_attempts SET switch_count=switch_count+1 WHERE id=p_attempt_id AND employee_id=public.training_my_employee_id() AND status='ongoing';
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:forbidden] 无权记录该考试'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_report_switch(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_report_switch(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_project_summary(p_project_id UUID)
RETURNS TABLE(attempt_id UUID,employee_id UUID,employee_name TEXT,exam_type TEXT,special_type TEXT,attempt_no INTEGER,status TEXT,score NUMERIC,result TEXT,started_at TIMESTAMPTZ,submitted_at TIMESTAMPTZ) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN RAISE EXCEPTION '[D13:forbidden] 无权查看本项目考试摘要'; END IF;
  RETURN QUERY SELECT a.id,a.employee_id,e.name,a.exam_type,a.special_type,a.attempt_no,
    CASE WHEN a.status='ongoing' AND clock_timestamp()>=a.deadline_at THEN 'timed_out' ELSE a.status END,a.score,a.result,a.started_at,a.submitted_at
    FROM public.exam_attempts a JOIN public.training_employees e ON e.id=a.employee_id WHERE a.project_id=p_project_id ORDER BY a.started_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_project_summary(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_project_summary(UUID) TO authenticated;

-- 旧入口不再对客户端开放，避免绕过 project/admission/D11/D12 上下文。
REVOKE EXECUTE ON FUNCTION public.exam_start(UUID),public.exam_submit(UUID,JSONB) FROM authenticated;

COMMIT;

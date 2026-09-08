-- D11 R02：综合考试必须明确绑定 admission；复用资格在每次状态/考试判断时实时复核。
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_admissions_exam_assignment
  ON public.training_admissions(exam_assignment_id)
  WHERE exam_assignment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.training_reuse_task_invalid_reason(
  p_task_id UUID, p_current_entity_id UUID
) RETURNS TEXT AS $$
  SELECT CASE
    WHEN t.fulfillment_kind <> 'reused' THEN NULL
    WHEN s.id IS NULL OR s.fulfillment_kind <> 'original' OR s.status <> 'completed'
      OR s.completed_at IS NULL THEN 'reused_source_invalid'
    WHEN sa.employee_id IS DISTINCT FROM ta.employee_id OR s.level IS DISTINCT FROM t.level
      OR s.plan_version_root_id IS DISTINCT FROM t.plan_version_root_id
      OR COALESCE(s.effective_hours,0) < COALESCE(s.required_hours,s.planned_hours,0)
      THEN 'reused_source_invalid'
    WHEN sp.id IS NULL OR s.completed_at + (sp.validity_years::TEXT || ' years')::INTERVAL <= NOW()
      THEN 'reused_source_expired'
    WHEN cp.reuse_policy = 'retrain' THEN 'retraining_required'
    WHEN t.level = 'entity' AND s.source_entity_id IS DISTINCT FROM p_current_entity_id
      THEN 'entity_training_reuse_invalid'
    WHEN t.level NOT IN ('company','entity') THEN 'reused_source_invalid'
    ELSE NULL END
  FROM public.training_admission_tasks t
  JOIN public.training_admissions ta ON ta.id=t.admission_id
  JOIN public.training_plans cp ON cp.id=t.plan_id
  LEFT JOIN public.training_admission_tasks s ON s.id=t.reused_from_task_id
  LEFT JOIN public.training_admissions sa ON sa.id=s.admission_id
  LEFT JOIN public.training_admission_packages sp ON sp.id=sa.package_id
  WHERE t.id=p_task_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_reuse_task_invalid_reason(UUID,UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_status(p_project_id UUID,p_employee_id UUID DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id()); v_admission UUID;
  v_entity UUID; v_is_leader BOOLEAN; v_levels JSONB; v_reason TEXT; v_allowed BOOLEAN;
BEGIN
  IF v_employee IS NULL OR NOT (v_employee=public.training_my_employee_id() OR public.site_project_can_read(p_project_id)) THEN
    RAISE EXCEPTION '[D11:forbidden] 无权查看该人员的三级教育状态';
  END IF;
  v_is_leader:=public.training_employee_uses_visitor_path(v_employee);
  IF v_is_leader THEN
    RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','visitor',
      'exam_allowed',FALSE,'reason_code','visitor_safety_briefing_required','levels','[]'::JSONB);
  END IF;
  SELECT id INTO v_admission FROM public.training_admissions
    WHERE project_id=p_project_id AND employee_id=v_employee;
  v_entity:=public.training_member_effective_entity(p_project_id,v_employee);
  IF v_admission IS NULL THEN v_reason:='missing_assignment';
  ELSIF v_entity IS NULL THEN v_reason:='missing_effective_entity';
  ELSIF EXISTS(SELECT 1 FROM (VALUES('company'),('entity'),('project')) q(level)
    WHERE NOT EXISTS(SELECT 1 FROM public.training_admission_package_items i
      JOIN public.training_admissions a ON a.package_id=i.package_id
      WHERE a.id=v_admission AND i.required AND i.level=q.level)) THEN v_reason:='missing_training_plan';
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_package_items i
    JOIN public.training_admissions a ON a.package_id=i.package_id
    WHERE a.id=v_admission AND i.required AND i.level IN('company','entity','project')
      AND NOT EXISTS(SELECT 1 FROM public.training_admission_tasks t
        WHERE t.admission_id=v_admission AND t.plan_id=i.plan_id)) THEN v_reason:='missing_assignment';
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id=v_admission
    AND t.fulfillment_kind='reused' AND public.training_reuse_task_invalid_reason(t.id,v_entity) IS NOT NULL) THEN
    SELECT public.training_reuse_task_invalid_reason(t.id,v_entity) INTO v_reason
    FROM public.training_admission_tasks t WHERE t.admission_id=v_admission AND t.fulfillment_kind='reused'
      AND public.training_reuse_task_invalid_reason(t.id,v_entity) IS NOT NULL
    ORDER BY CASE t.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END,t.id LIMIT 1;
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id=v_admission
    AND t.level='company' AND t.status<>'completed') THEN v_reason:='missing_company_training';
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id=v_admission
    AND t.level='entity' AND t.status<>'completed') THEN v_reason:='missing_entity_training';
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id=v_admission
    AND t.level='project' AND t.status<>'completed') THEN v_reason:='missing_project_training';
  ELSIF EXISTS(SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id=v_admission
    AND t.level IN('company','entity','project') AND t.fulfillment_kind<>'reused'
    AND COALESCE(t.effective_hours,0)<COALESCE(t.required_hours,t.planned_hours,0)) THEN v_reason:='incomplete_effective_hours';
  ELSE v_reason:='ready'; END IF;
  v_allowed:=v_reason='ready';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('level',q.level,'state',COALESCE(x.state,'missing'),
    'reason_code',COALESCE(x.reason_code,'missing_training_plan'),'items',COALESCE(x.items,'[]'::JSONB)) ORDER BY q.ord),'[]'::JSONB)
  INTO v_levels FROM (VALUES('company',1),('entity',2),('project',3)) q(level,ord)
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN bool_or(public.training_reuse_task_invalid_reason(t.id,v_entity) IS NOT NULL) THEN 'required'
      WHEN bool_and(t.status='completed') THEN CASE WHEN bool_and(t.fulfillment_kind='reused') THEN 'reused' ELSE 'completed' END
      WHEN bool_or(t.status='learning') THEN 'learning' ELSE 'required' END state,
      COALESCE(min(public.training_reuse_task_invalid_reason(t.id,v_entity)) FILTER
        (WHERE public.training_reuse_task_invalid_reason(t.id,v_entity) IS NOT NULL),
        CASE WHEN bool_and(t.status='completed') THEN 'satisfied' ELSE 'incomplete_effective_hours' END) reason_code,
      jsonb_agg(jsonb_build_object('task_id',t.id,'plan_id',t.plan_id,'plan_title',tp.title,
        'version_root_id',t.plan_version_root_id,'version_no',t.plan_version_no,'status',t.status,
        'fulfillment_kind',t.fulfillment_kind,'reused_from_task_id',t.reused_from_task_id,
        'source_entity_id',t.source_entity_id,'source_project_id',t.source_project_id,'planned_hours',t.planned_hours,
        'required_hours',t.required_hours,'effective_hours',t.effective_hours,'started_at',t.started_at,
        'completed_at',t.completed_at,'evaluated_at',t.evaluated_at,'decision_code',t.decision_code,
        'reuse_valid',public.training_reuse_task_invalid_reason(t.id,v_entity) IS NULL,
        'reuse_invalid_reason',public.training_reuse_task_invalid_reason(t.id,v_entity),'courses',t.course_snapshot,
        'reuse_source',CASE WHEN t.reused_from_task_id IS NULL THEN NULL ELSE (
          SELECT jsonb_build_object('task_id',s.id,'package_id',sa.package_id,'plan_id',s.plan_id,'plan_title',sp.title,
            'version_root_id',s.plan_version_root_id,'version_no',s.plan_version_no,'source_entity_id',s.source_entity_id,
            'source_project_id',s.source_project_id,'effective_hours',s.effective_hours,'completed_at',s.completed_at,
            'courses',s.course_snapshot)
          FROM public.training_admission_tasks s JOIN public.training_admissions sa ON sa.id=s.admission_id
          JOIN public.training_plans sp ON sp.id=s.plan_id WHERE s.id=t.reused_from_task_id) END) ORDER BY t.id) items
    FROM public.training_admission_tasks t JOIN public.training_plans tp ON tp.id=t.plan_id
    WHERE t.admission_id=v_admission AND t.level=q.level HAVING count(*)>0
  ) x ON TRUE;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'admission_id',v_admission,
    'effective_entity_id',v_entity,'path','training','exam_allowed',v_allowed,'reason_code',v_reason,'levels',v_levels);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_three_level_status(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_status(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_prepare_admission_exam(p_admission_id UUID)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_plan UUID; v_assignment UUID; v_gate JSONB;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND OR v_a.employee_id IS DISTINCT FROM public.training_my_employee_id() THEN RAISE EXCEPTION '[D11:forbidden] 准入记录不存在或无权操作'; END IF;
  v_gate:=public.training_three_level_exam_gate_internal(p_admission_id);
  IF NOT (v_gate->>'allowed')::BOOLEAN THEN
    RAISE EXCEPTION '[D11:%] 三级安全教育未满足综合考试前置条件',v_gate->>'reason_code';
  END IF;
  IF EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=p_admission_id AND status<>'completed') THEN
    RAISE EXCEPTION '[D11:incomplete_required_training] 请先完成全部必修培训'; END IF;
  SELECT exam_plan_id INTO v_plan FROM public.training_admission_packages WHERE id=v_a.package_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION '[D11:missing_exam_plan] 培训包尚未配置综合准入考试'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published') THEN
    RAISE EXCEPTION '[D11:missing_exam_paper] 综合准入考试尚未发布试卷'; END IF;
  INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,exam_status)
  SELECT v_plan,e.id,pr.id,e.department_id,'pending' FROM public.training_employees e
  LEFT JOIN public.profiles pr ON pr.employee_id=e.id WHERE e.id=v_a.employee_id
  ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id
  RETURNING id INTO v_assignment;
  BEGIN
    UPDATE public.training_admissions SET exam_assignment_id=v_assignment,exam_required=TRUE,updated_at=NOW() WHERE id=p_admission_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '[D11:ambiguous_admission_exam_binding] 综合考试任务已绑定其他准入记录';
  END;
  RETURN jsonb_build_object('plan_id',v_plan,'assignment_id',v_assignment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_prepare_admission_exam(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_prepare_admission_exam(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_attempt_admission_gate()
RETURNS TRIGGER AS $$
DECLARE v_plan UUID; v_employee UUID; v_admission UUID; v_bindings INT; v_gate JSONB;
BEGIN
  SELECT plan_id,employee_id INTO v_plan,v_employee FROM public.training_assignments WHERE id=NEW.assignment_id;
  IF NOT EXISTS(SELECT 1 FROM public.training_admission_packages
    WHERE exam_plan_id=v_plan AND status='published') THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_bindings
  FROM public.training_admissions a JOIN public.training_admission_packages p ON p.id=a.package_id
  WHERE a.exam_assignment_id=NEW.assignment_id AND a.employee_id=v_employee
    AND p.exam_plan_id=v_plan AND p.status='published';
  IF v_bindings=0 THEN
    RAISE EXCEPTION '[D11:admission_exam_not_prepared] 综合准入考试必须先由对应准入记录准备并绑定';
  ELSIF v_bindings<>1 THEN
    RAISE EXCEPTION '[D11:ambiguous_admission_exam_binding] 综合考试任务存在歧义绑定';
  END IF;
  SELECT a.id INTO v_admission
  FROM public.training_admissions a JOIN public.training_admission_packages p ON p.id=a.package_id
  WHERE a.exam_assignment_id=NEW.assignment_id AND a.employee_id=v_employee
    AND p.exam_plan_id=v_plan AND p.status='published';
  v_gate:=public.training_three_level_exam_gate_internal(v_admission);
  IF NOT (v_gate->>'allowed')::BOOLEAN THEN
    RAISE EXCEPTION '[D11:%] 未完成三级安全教育，禁止开始综合准入考试',v_gate->>'reason_code';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_exam_attempt_admission_gate() FROM PUBLIC,anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;

-- D11：三级安全教育任务、跨项目复用和综合准入考试门禁。
BEGIN;

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS reuse_policy TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_reuse_policy_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_reuse_policy_check
  CHECK (reuse_policy IN ('allow', 'retrain'));

ALTER TABLE public.training_admission_tasks
  ADD COLUMN IF NOT EXISTS fulfillment_kind TEXT NOT NULL DEFAULT 'required',
  ADD COLUMN IF NOT EXISTS reused_from_task_id UUID REFERENCES public.training_admission_tasks(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decision_code TEXT,
  ADD COLUMN IF NOT EXISTS plan_version_root_id UUID,
  ADD COLUMN IF NOT EXISTS plan_version_no INT,
  ADD COLUMN IF NOT EXISTS planned_hours NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS required_hours NUMERIC(7,2),
  ADD COLUMN IF NOT EXISTS course_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE public.training_admission_tasks DROP CONSTRAINT IF EXISTS training_admission_tasks_fulfillment_check;
ALTER TABLE public.training_admission_tasks ADD CONSTRAINT training_admission_tasks_fulfillment_check CHECK (
  (fulfillment_kind = 'reused' AND reused_from_task_id IS NOT NULL AND assignment_id IS NULL
    AND status = 'completed' AND completed_at IS NULL AND effective_hours = 0)
  OR (fulfillment_kind IN ('required', 'original') AND reused_from_task_id IS NULL)
);
ALTER TABLE public.training_admission_tasks DROP CONSTRAINT IF EXISTS training_admission_tasks_hours_snapshot_check;
ALTER TABLE public.training_admission_tasks ADD CONSTRAINT training_admission_tasks_hours_snapshot_check
  CHECK ((planned_hours IS NULL OR planned_hours > 0)
    AND (required_hours IS NULL OR required_hours > 0)
    AND (required_hours IS NULL OR planned_hours IS NULL OR required_hours <= planned_hours));

CREATE INDEX IF NOT EXISTS idx_training_admission_tasks_reuse_source
  ON public.training_admission_tasks(reused_from_task_id) WHERE reused_from_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_training_admission_tasks_reuse_lookup
  ON public.training_admission_tasks(plan_version_root_id, level, source_entity_id, completed_at)
  WHERE fulfillment_kind = 'original' AND status = 'completed';

UPDATE public.training_admission_tasks t SET
  fulfillment_kind = CASE WHEN t.status = 'completed' THEN 'original' ELSE 'required' END,
  source_entity_id = CASE WHEN t.level='entity' THEN p.department_id
    ELSE (SELECT sp.lead_entity_id FROM public.site_projects sp WHERE sp.id=a.project_id) END,
  source_project_id = a.project_id,
  plan_version_root_id = COALESCE(p.version_root_id, p.id),
  plan_version_no = COALESCE(p.version_no, 1),
  planned_hours = p.hours,
  required_hours = COALESCE(p.required_hours, p.hours),
  course_snapshot = COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'type',c.course_type,
      'required',c.required,'sort_order',c.sort_order) ORDER BY c.sort_order,c.id)
    FROM public.training_courses c WHERE c.plan_id=t.plan_id
  ), '[]'::JSONB),
  evaluated_at = COALESCE(t.completed_at, a.created_at),
  decision_code = CASE WHEN t.status='completed' THEN 'original_completed' ELSE 'assigned' END
FROM public.training_admissions a, public.training_plans p
WHERE a.id=t.admission_id AND p.id=t.plan_id
  AND (t.plan_version_root_id IS NULL OR t.evaluated_at IS NULL);

CREATE OR REPLACE FUNCTION public.training_employee_uses_visitor_path(p_employee_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE((SELECT btrim(position) = '公司领导'
    FROM public.training_employees WHERE id=p_employee_id), FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_employee_uses_visitor_path(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_department_entity(p_department_id UUID)
RETURNS UUID AS $$
  WITH RECURSIVE chain AS (
    SELECT d.id,d.parent_id,d.dept_type,0 AS depth FROM public.departments d WHERE d.id=p_department_id
    UNION ALL
    SELECT d.id,d.parent_id,d.dept_type,c.depth+1
    FROM public.departments d JOIN chain c ON c.parent_id=d.id WHERE c.depth<32
  )
  SELECT id FROM chain WHERE dept_type='entity' ORDER BY depth LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_department_entity(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_member_effective_entity(
  p_project_id UUID, p_employee_id UUID
) RETURNS UUID AS $$
  SELECT CASE WHEN m.membership_type='external'
    THEN public.contractor_company_effective_entity(m.contractor_id)
    ELSE public.training_department_entity(e.department_id) END
  FROM public.site_project_members m
  JOIN public.training_employees e ON e.id=m.employee_id
  WHERE m.project_id=p_project_id AND m.employee_id=p_employee_id AND m.status='active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_member_effective_entity(UUID,UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_find_reuse_source(
  p_employee_id UUID, p_level TEXT, p_entity_id UUID, p_plan_id UUID
) RETURNS UUID AS $$
  SELECT t.id
  FROM public.training_admission_tasks t
  JOIN public.training_admissions a ON a.id=t.admission_id
  JOIN public.training_admission_packages pkg ON pkg.id=a.package_id
  JOIN public.training_plans old_plan ON old_plan.id=t.plan_id
  JOIN public.training_plans current_plan ON current_plan.id=p_plan_id
  WHERE a.employee_id=p_employee_id
    AND p_level IN ('company','entity')
    AND t.level=p_level AND t.fulfillment_kind='original' AND t.status='completed'
    AND t.completed_at IS NOT NULL
    AND COALESCE(t.plan_version_root_id,old_plan.version_root_id,old_plan.id)
        = COALESCE(current_plan.version_root_id,current_plan.id)
    AND current_plan.reuse_policy='allow'
    AND (p_level='company' OR t.source_entity_id=p_entity_id)
    AND t.completed_at + (pkg.validity_years::TEXT || ' years')::INTERVAL > NOW()
  ORDER BY t.completed_at DESC,t.id
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_find_reuse_source(UUID,TEXT,UUID,UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_three_level_tasks_internal(p_admission_id UUID)
RETURNS VOID AS $$
DECLARE
  v_a public.training_admissions; v_member public.site_project_members; v_entity UUID;
  v_item RECORD; v_source UUID; v_assignment UUID; v_user UUID; v_courses JSONB;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D11:admission_not_found] 准入记录不存在'; END IF;
  SELECT * INTO v_member FROM public.site_project_members
    WHERE id=v_a.member_id AND project_id=v_a.project_id AND employee_id=v_a.employee_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION '[D11:missing_assignment] 人员不是该项目的有效成员'; END IF;
  IF public.training_employee_uses_visitor_path(v_a.employee_id) THEN
    RAISE EXCEPTION '[D11:visitor_safety_briefing_required] 公司领导应进入访客安全告知流程';
  END IF;
  v_entity := public.training_member_effective_entity(v_a.project_id,v_a.employee_id);
  IF v_entity IS NULL THEN
    RAISE EXCEPTION '[D11:missing_effective_entity] 无法确定人员的权威经营实体归属';
  END IF;
  SELECT id INTO v_user FROM public.profiles WHERE employee_id=v_a.employee_id ORDER BY id LIMIT 1;

  FOR v_item IN
    SELECT i.plan_id,i.level,p.level plan_level,p.department_id,p.site_project_id,p.publish_status,p.hours,p.required_hours,
      COALESCE(p.version_root_id,p.id) version_root_id,COALESCE(p.version_no,1) version_no
    FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id=i.plan_id
    WHERE i.package_id=v_a.package_id AND i.required ORDER BY i.sort_order,i.id
  LOOP
    IF v_item.publish_status <> 'published' THEN
      RAISE EXCEPTION '[D11:missing_training_plan] 培训包包含未发布计划';
    END IF;
    IF v_item.plan_level<>v_item.level THEN
      RAISE EXCEPTION '[D11:plan_scope_mismatch] 培训包层级与培训计划权威范围不一致';
    END IF;
    IF (v_item.level='company')
      OR (v_item.level='entity' AND v_item.department_id=v_entity)
      OR (v_item.level='project' AND v_item.site_project_id=v_a.project_id)
      OR (v_item.level='special' AND (v_item.site_project_id=v_a.project_id OR v_item.department_id=v_entity)) THEN NULL;
    ELSE RAISE EXCEPTION '[D11:plan_scope_mismatch] 培训计划范围与人员或项目不一致'; END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'type',c.course_type,
      'required',c.required,'sort_order',c.sort_order) ORDER BY c.sort_order,c.id),'[]'::JSONB)
      INTO v_courses FROM public.training_courses c WHERE c.plan_id=v_item.plan_id;

    v_source := public.training_find_reuse_source(v_a.employee_id,v_item.level,v_entity,v_item.plan_id);
    IF v_source IS NOT NULL THEN
      INSERT INTO public.training_admission_tasks(admission_id,plan_id,level,status,progress,effective_hours,
        fulfillment_kind,reused_from_task_id,source_entity_id,source_project_id,evaluated_at,decision_code,
        plan_version_root_id,plan_version_no,planned_hours,required_hours,course_snapshot)
      VALUES(v_a.id,v_item.plan_id,v_item.level,'completed',100,0,'reused',v_source,v_entity,v_a.project_id,NOW(),
        CASE WHEN v_item.level='company' THEN 'company_reused' ELSE 'entity_reused' END,
        v_item.version_root_id,v_item.version_no,v_item.hours,COALESCE(v_item.required_hours,v_item.hours),v_courses)
      ON CONFLICT (admission_id,plan_id) DO NOTHING;
    ELSE
      INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
      VALUES(v_item.plan_id,v_a.employee_id,v_user,(SELECT department_id FROM public.training_employees WHERE id=v_a.employee_id))
      ON CONFLICT (plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id
      RETURNING id INTO v_assignment;
      INSERT INTO public.training_admission_tasks(admission_id,plan_id,level,assignment_id,fulfillment_kind,
        source_entity_id,source_project_id,evaluated_at,decision_code,plan_version_root_id,plan_version_no,
        planned_hours,required_hours,course_snapshot)
      VALUES(v_a.id,v_item.plan_id,v_item.level,v_assignment,'required',v_entity,v_a.project_id,NOW(),
        CASE WHEN v_item.level='project' THEN 'project_assignment' ELSE 'assignment_required' END,
        v_item.version_root_id,v_item.version_no,v_item.hours,COALESCE(v_item.required_hours,v_item.hours),v_courses)
      ON CONFLICT (admission_id,plan_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id;
    END IF;
  END LOOP;
  PERFORM public.training_recompute_admission_internal(v_a.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_sync_three_level_tasks_internal(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_three_level_tasks(p_admission_id UUID)
RETURNS VOID AS $$
DECLARE v_project UUID;
BEGIN
  SELECT project_id INTO v_project FROM public.training_admissions WHERE id=p_admission_id;
  IF v_project IS NULL OR NOT public.site_project_can_manage(v_project) THEN
    RAISE EXCEPTION '[D11:forbidden] 您无权同步该准入培训任务';
  END IF;
  PERFORM public.training_sync_three_level_tasks_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_sync_three_level_tasks(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_sync_three_level_tasks(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN);
CREATE FUNCTION public.training_start_admission(
  p_project_id UUID,p_employee_id UUID,p_package_id UUID,
  p_due_at TIMESTAMPTZ DEFAULT NULL,p_urgent BOOLEAN DEFAULT FALSE
) RETURNS UUID AS $$
DECLARE v_admission UUID; v_member UUID; v_old_package UUID; v_due TIMESTAMPTZ;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '[D11:forbidden] 您无权发起该项目入场培训'; END IF;
  IF public.training_employee_uses_visitor_path(p_employee_id) THEN
    RAISE EXCEPTION '[D11:visitor_safety_briefing_required] 公司领导应进入访客安全告知流程';
  END IF;
  v_due:=COALESCE(p_due_at,date_trunc('day',NOW())+INTERVAL '3 days 18 hours');
  IF v_due<=NOW() THEN RAISE EXCEPTION '[D11:invalid_due_at] 完成截止时间必须晚于当前时间'; END IF;
  IF p_urgent AND v_due>date_trunc('day',NOW())+INTERVAL '1 day' THEN RAISE EXCEPTION '[D11:invalid_urgent_due_at] 当天加急截止时间不能晚于明天零点'; END IF;
  SELECT id INTO v_member FROM public.site_project_members
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND status='active';
  IF v_member IS NULL THEN RAISE EXCEPTION '[D11:missing_assignment] 该人员不是项目有效成员'; END IF;
  IF public.training_member_effective_entity(p_project_id,p_employee_id) IS NULL THEN
    RAISE EXCEPTION '[D11:missing_effective_entity] 无法确定人员的权威经营实体归属'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.training_admission_packages
    WHERE id=p_package_id AND status='published' AND (project_id IS NULL OR project_id=p_project_id)) THEN
    RAISE EXCEPTION '[D11:missing_training_package] 培训包不存在、未发布或不适用于该项目';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::TEXT||':'||p_employee_id::TEXT,81));
  SELECT id,package_id INTO v_admission,v_old_package FROM public.training_admissions
    WHERE project_id=p_project_id AND employee_id=p_employee_id FOR UPDATE;
  IF v_admission IS NOT NULL AND v_old_package<>p_package_id THEN
    RAISE EXCEPTION '[D11:admission_history_locked] 已有准入记录，不能覆盖为其他培训包';
  END IF;
  IF v_admission IS NULL THEN
    INSERT INTO public.training_admissions(project_id,member_id,employee_id,package_id,due_at,urgent)
    VALUES(p_project_id,v_member,p_employee_id,p_package_id,v_due,COALESCE(p_urgent,FALSE)) RETURNING id INTO v_admission;
  ELSE
    UPDATE public.training_admissions SET member_id=v_member,due_at=v_due,urgent=COALESCE(p_urgent,FALSE),updated_at=NOW()
    WHERE id=v_admission;
  END IF;
  PERFORM public.training_sync_three_level_tasks_internal(v_admission);
  RETURN v_admission;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN) TO authenticated;

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
    SELECT CASE WHEN bool_and(t.status='completed') THEN
      CASE WHEN bool_and(t.fulfillment_kind='reused') THEN 'reused' ELSE 'completed' END
      WHEN bool_or(t.status='learning') THEN 'learning' ELSE 'required' END state,
      CASE WHEN bool_and(t.status='completed') THEN 'satisfied' ELSE 'incomplete_effective_hours' END reason_code,
      jsonb_agg(jsonb_build_object('task_id',t.id,'plan_id',t.plan_id,'version_root_id',t.plan_version_root_id,
        'version_no',t.plan_version_no,'fulfillment_kind',t.fulfillment_kind,'reused_from_task_id',t.reused_from_task_id,
        'source_entity_id',t.source_entity_id,'source_project_id',t.source_project_id,'planned_hours',t.planned_hours,
        'required_hours',t.required_hours,'effective_hours',t.effective_hours,'completed_at',t.completed_at,
        'evaluated_at',t.evaluated_at,'decision_code',t.decision_code,'courses',t.course_snapshot,
        'reuse_source',CASE WHEN t.reused_from_task_id IS NULL THEN NULL ELSE (
          SELECT jsonb_build_object('task_id',s.id,'package_id',sa.package_id,'plan_id',s.plan_id,
            'version_root_id',s.plan_version_root_id,'version_no',s.plan_version_no,'source_entity_id',s.source_entity_id,
            'source_project_id',s.source_project_id,'effective_hours',s.effective_hours,'completed_at',s.completed_at,
            'courses',s.course_snapshot)
          FROM public.training_admission_tasks s JOIN public.training_admissions sa ON sa.id=s.admission_id
          WHERE s.id=t.reused_from_task_id) END) ORDER BY t.id) items
    FROM public.training_admission_tasks t WHERE t.admission_id=v_admission AND t.level=q.level
    HAVING count(*)>0
  ) x ON TRUE;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'admission_id',v_admission,
    'effective_entity_id',v_entity,'path','training','exam_allowed',v_allowed,'reason_code',v_reason,'levels',v_levels);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_three_level_status(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_status(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_exam_gate_internal(p_admission_id UUID)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_status JSONB;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D11:admission_not_found] 准入记录不存在'; END IF;
  v_status:=public.training_three_level_status(v_a.project_id,v_a.employee_id);
  RETURN jsonb_build_object('allowed',COALESCE((v_status->>'exam_allowed')::BOOLEAN,FALSE),
    'reason_code',v_status->>'reason_code','status',v_status);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_three_level_exam_gate_internal(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_exam_gate(p_admission_id UUID)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND OR NOT (v_a.employee_id=public.training_my_employee_id() OR public.site_project_can_read(v_a.project_id)) THEN
    RAISE EXCEPTION '[D11:forbidden] 无权检查该准入考试条件';
  END IF;
  RETURN public.training_three_level_exam_gate_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_three_level_exam_gate(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_exam_gate(UUID) TO authenticated;

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
  UPDATE public.training_admissions SET exam_assignment_id=v_assignment,exam_required=TRUE,updated_at=NOW() WHERE id=p_admission_id;
  RETURN jsonb_build_object('plan_id',v_plan,'assignment_id',v_assignment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_prepare_admission_exam(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_prepare_admission_exam(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_attempt_admission_gate()
RETURNS TRIGGER AS $$
DECLARE v_admission UUID; v_gate JSONB;
BEGIN
  SELECT id INTO v_admission FROM public.training_admissions WHERE exam_assignment_id=NEW.assignment_id;
  IF v_admission IS NULL THEN RETURN NEW; END IF;
  v_gate:=public.training_three_level_exam_gate_internal(v_admission);
  IF NOT (v_gate->>'allowed')::BOOLEAN THEN
    RAISE EXCEPTION '[D11:%] 未完成三级安全教育，禁止开始综合准入考试',v_gate->>'reason_code';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_exam_attempt_admission_gate() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_exam_attempt_admission_gate ON public.exam_attempts;
CREATE TRIGGER trg_training_exam_attempt_admission_gate BEFORE INSERT ON public.exam_attempts
  FOR EACH ROW EXECUTE FUNCTION public.training_exam_attempt_admission_gate();

CREATE OR REPLACE FUNCTION public.training_sync_admission_assignment()
RETURNS TRIGGER AS $$
DECLARE v_admission_id UUID;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.progress IS NOT DISTINCT FROM OLD.progress AND NEW.hours_earned IS NOT DISTINCT FROM OLD.hours_earned THEN RETURN NEW; END IF;
  FOR v_admission_id IN SELECT admission_id FROM public.training_admission_tasks WHERE assignment_id=NEW.id LOOP
    UPDATE public.training_admission_tasks SET
      status=CASE WHEN NEW.status='completed' THEN 'completed' WHEN NEW.status='learning' OR COALESCE(NEW.progress,0)>0 THEN 'learning' ELSE 'pending' END,
      progress=LEAST(100,GREATEST(0,COALESCE(NEW.progress,0))),
      effective_hours=COALESCE(NEW.hours_earned,effective_hours),
      fulfillment_kind=CASE WHEN NEW.status='completed' THEN 'original' ELSE fulfillment_kind END,
      started_at=CASE WHEN NEW.status IN('learning','completed') OR COALESCE(NEW.progress,0)>0 THEN COALESCE(started_at,NOW()) ELSE started_at END,
      completed_at=CASE WHEN NEW.status='completed' THEN COALESCE(completed_at,NEW.completed_at,NOW()) ELSE completed_at END,
      decision_code=CASE WHEN NEW.status='completed' THEN 'original_completed' ELSE decision_code END,
      evaluated_at=NOW()
    WHERE admission_id=v_admission_id AND assignment_id=NEW.id;
    PERFORM public.training_recompute_admission_internal(v_admission_id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_sync_admission_assignment() FROM PUBLIC,anon,authenticated;

REVOKE INSERT,UPDATE,DELETE ON TABLE public.training_admission_tasks FROM authenticated;
REVOKE INSERT,UPDATE,DELETE ON TABLE public.training_admissions FROM authenticated;

COMMENT ON COLUMN public.training_admission_tasks.reused_from_task_id IS
  'D11 explicit reuse source; reused rows never copy completion time, effective hours, or signatures.';
COMMENT ON COLUMN public.training_plans.reuse_policy IS
  'allow permits valid same-lineage company/entity reuse; retrain forces a new original assignment.';

NOTIFY pgrst,'reload schema';
COMMIT;

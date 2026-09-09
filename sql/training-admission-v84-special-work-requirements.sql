-- D12：项目人员实际专项作业、钻探全员范围与实时专项门禁。
BEGIN;

ALTER TABLE public.training_admission_special_rules
  ADD COLUMN IF NOT EXISTS special_type TEXT,
  ADD COLUMN IF NOT EXISTS exam_plan_id UUID REFERENCES public.training_plans(id) ON DELETE RESTRICT;

UPDATE public.training_admission_special_rules
SET special_type = CASE position_keyword
  WHEN '爆破' THEN 'blasting' WHEN '电工' THEN 'electrical'
  WHEN '焊工' THEN 'welding' WHEN '钻探' THEN 'drilling' END
WHERE special_type IS NULL;

ALTER TABLE public.training_admission_special_rules
  ALTER COLUMN special_type SET NOT NULL;
ALTER TABLE public.training_admission_special_rules
  DROP CONSTRAINT IF EXISTS training_admission_special_rules_special_type_check;
ALTER TABLE public.training_admission_special_rules
  ADD CONSTRAINT training_admission_special_rules_special_type_check
  CHECK (special_type IN ('blasting','electrical','welding','drilling'));
CREATE UNIQUE INDEX IF NOT EXISTS training_admission_special_rules_package_type_uidx
  ON public.training_admission_special_rules(package_id,special_type);

ALTER TABLE public.training_admission_tasks
  ADD COLUMN IF NOT EXISTS special_type TEXT,
  ADD COLUMN IF NOT EXISTS requirement_active BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE public.training_admission_tasks t SET
  special_type=r.special_type,
  requirement_active=FALSE
FROM public.training_admissions a
JOIN public.training_admission_special_rules r ON r.package_id=a.package_id
WHERE t.admission_id=a.id AND t.level='special' AND r.plan_id=t.plan_id;
UPDATE public.training_admission_tasks SET requirement_active=FALSE
WHERE level='special' AND special_type IS NULL;
ALTER TABLE public.training_admission_tasks
  DROP CONSTRAINT IF EXISTS training_admission_tasks_special_type_check;
ALTER TABLE public.training_admission_tasks
  ADD CONSTRAINT training_admission_tasks_special_type_check CHECK (
    (level='special' AND special_type IN ('blasting','electrical','welding','drilling'))
    OR (level='special' AND special_type IS NULL AND requirement_active=FALSE)
    OR (level<>'special' AND special_type IS NULL)
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.training_special_work_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.site_project_members(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  special_type TEXT NOT NULL CHECK (special_type IN ('blasting','electrical','welding')),
  old_active BOOLEAN NOT NULL,
  new_active BOOLEAN NOT NULL,
  operator_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  operator_role TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (btrim(reason)<>'' AND length(reason)<=1000),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (old_active<>new_active)
);
CREATE INDEX IF NOT EXISTS training_special_work_audit_member_idx
  ON public.training_special_work_audit_logs(member_id,changed_at DESC);
ALTER TABLE public.training_special_work_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_special_work_audit_read ON public.training_special_work_audit_logs;
CREATE POLICY training_special_work_audit_read ON public.training_special_work_audit_logs
  FOR SELECT TO authenticated USING (
    employee_id=public.training_my_employee_id()
    OR public.site_project_can_read_management_data(project_id)
  );
REVOKE ALL ON TABLE public.training_special_work_audit_logs FROM PUBLIC,anon,authenticated;
GRANT SELECT ON TABLE public.training_special_work_audit_logs TO authenticated;

CREATE OR REPLACE FUNCTION public.training_special_work_audit_immutable()
RETURNS TRIGGER AS $$ BEGIN
  RAISE EXCEPTION '[D12:special_work_history_locked] 实际专项作业历史不可修改或删除';
END; $$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_work_audit_immutable() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_special_work_audit_immutable ON public.training_special_work_audit_logs;
CREATE TRIGGER trg_training_special_work_audit_immutable
  BEFORE UPDATE OR DELETE ON public.training_special_work_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.training_special_work_audit_immutable();

CREATE OR REPLACE FUNCTION public.training_special_type_code(p_value TEXT)
RETURNS TEXT AS $$
  SELECT CASE btrim(COALESCE(p_value,''))
    WHEN '爆破' THEN 'blasting' WHEN 'blasting' THEN 'blasting'
    WHEN '电工' THEN 'electrical' WHEN 'electrical' THEN 'electrical'
    WHEN '焊工' THEN 'welding' WHEN 'welding' THEN 'welding'
    WHEN '钻探' THEN 'drilling' WHEN 'drilling' THEN 'drilling'
    ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_type_code(TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_special_type_label(p_type TEXT)
RETURNS TEXT AS $$
  SELECT CASE p_type WHEN 'blasting' THEN '爆破' WHEN 'electrical' THEN '电工'
    WHEN 'welding' THEN '焊工' WHEN 'drilling' THEN '钻探' ELSE NULL END;
$$ LANGUAGE sql IMMUTABLE SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_type_label(TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_special_actor_role(p_project_id UUID)
RETURNS TEXT AS $$
DECLARE v_role TEXT;
BEGIN
  SELECT r.role INTO v_role FROM public.site_project_roles r
  WHERE r.project_id=p_project_id AND r.user_id=auth.uid() AND r.active
    AND r.role IN ('project_manager','safety_officer')
  ORDER BY CASE r.role WHEN 'project_manager' THEN 1 ELSE 2 END LIMIT 1;
  IF v_role IS NOT NULL THEN RETURN v_role; END IF;
  SELECT CASE WHEN p.role='admin' AND p.admin_level='dept' THEN 'entity_admin'
              WHEN p.role='admin' AND (p.is_super_admin OR COALESCE(p.admin_level,'company')='company') THEN 'company_read_only'
              ELSE COALESCE(p.role,'unknown') END INTO v_role
  FROM public.profiles p WHERE p.id=auth.uid();
  RETURN COALESCE(v_role,'unknown');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_actor_role(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_special_certificate_state_internal(
  p_project_id UUID,p_employee_id UUID,p_special_type TEXT
) RETURNS JSONB AS $$
DECLARE v_label TEXT:=public.training_special_type_label(p_special_type); v_row RECORD; v_state TEXT;
BEGIN
  IF p_special_type='drilling' THEN
    RETURN jsonb_build_object('required',FALSE,'state','not_required','certificate_type',NULL,'record_id',NULL);
  END IF;
  SELECT d.id,d.review_status,d.valid_from,d.valid_until,d.revoked_at INTO v_row
  FROM public.contractor_documents d
  WHERE d.employee_id=p_employee_id AND d.document_type='special_certificate'
    AND d.certificate_type=v_label AND (d.project_id=p_project_id OR d.project_id IS NULL)
  ORDER BY
    (d.review_status='approved' AND d.revoked_at IS NULL
      AND (d.valid_from IS NULL OR d.valid_from<=CURRENT_DATE)
      AND d.valid_until>=CURRENT_DATE) DESC,
    d.created_at DESC LIMIT 1;
  IF NOT FOUND THEN v_state:='missing';
  ELSIF v_row.revoked_at IS NOT NULL THEN v_state:='revoked';
  ELSIF v_row.review_status<>'approved' THEN v_state:='unapproved';
  ELSIF v_row.valid_from IS NOT NULL AND v_row.valid_from>CURRENT_DATE THEN v_state:='unapproved';
  ELSIF v_row.valid_until<CURRENT_DATE THEN v_state:='expired';
  ELSE v_state:='valid'; END IF;
  RETURN jsonb_build_object('required',TRUE,'state',v_state,'certificate_type',v_label,
    'record_id',CASE WHEN v_row IS NULL THEN NULL ELSE v_row.id END,
    'valid_from',CASE WHEN v_row IS NULL THEN NULL ELSE v_row.valid_from END,
    'valid_until',CASE WHEN v_row IS NULL THEN NULL ELSE v_row.valid_until END);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_certificate_state_internal(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_special_requirements_internal(
  p_project_id UUID,p_employee_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_member public.site_project_members; v_project public.site_projects; v_admission public.training_admissions;
  v_actual TEXT[]:=ARRAY[]::TEXT[]; v_required TEXT[]:=ARRAY[]::TEXT[]; v_type TEXT;
  v_rule public.training_admission_special_rules; v_cert JSONB; v_training TEXT; v_exam TEXT;
  v_assignment public.training_assignments; v_exam_assignment public.training_assignments;
  v_items JSONB:='[]'::jsonb; v_blocked JSONB:='[]'::jsonb; v_reason TEXT; v_type_reasons JSONB;
  v_all_satisfied BOOLEAN:=TRUE;
BEGIN
  SELECT * INTO v_member FROM public.site_project_members
    WHERE project_id=p_project_id AND employee_id=p_employee_id ORDER BY joined_at DESC LIMIT 1;
  SELECT * INTO v_project FROM public.site_projects WHERE id=p_project_id;
  IF v_project.id IS NULL THEN RAISE EXCEPTION '[D12:project_not_found] 项目不存在'; END IF;
  IF v_member.id IS NULL OR v_member.status<>'active' THEN
    RETURN jsonb_build_object('project_id',p_project_id,'employee_id',p_employee_id,'member_id',v_member.id,
      'membership_active',FALSE,'actual_special_work','[]'::jsonb,'required_special_types','[]'::jsonb,
      'drilling_required',FALSE,'requirements','[]'::jsonb,'blocked_reasons','[]'::jsonb,
      'overall_satisfied',TRUE,'reason_code','special_work_not_required');
  END IF;
  SELECT COALESCE(array_agg(public.training_special_type_code(x) ORDER BY public.training_special_type_code(x)),ARRAY[]::TEXT[])
    INTO v_actual FROM unnest(v_member.special_work_types) x;
  v_required:=v_actual;
  IF v_project.includes_drilling THEN v_required:=array_append(v_required,'drilling'); END IF;
  SELECT * INTO v_admission FROM public.training_admissions
    WHERE project_id=p_project_id AND employee_id=p_employee_id;
  FOREACH v_type IN ARRAY v_required LOOP
    v_type_reasons:='[]'::jsonb;
    v_cert:=public.training_special_certificate_state_internal(p_project_id,p_employee_id,v_type);
    IF v_cert->>'state'='missing' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_missing');
    ELSIF v_cert->>'state'='expired' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_expired');
    ELSIF v_cert->>'state'='revoked' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_revoked');
    ELSIF v_cert->>'state'='unapproved' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_unapproved'); END IF;
    v_rule:=NULL; v_assignment:=NULL; v_exam_assignment:=NULL;
    IF v_admission.id IS NOT NULL THEN
      SELECT * INTO v_rule FROM public.training_admission_special_rules r
        WHERE r.package_id=v_admission.package_id AND r.special_type=v_type;
    END IF;
    IF v_rule.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.training_plans p WHERE p.id=v_rule.plan_id AND p.level='special' AND p.publish_status='published' AND p.status<>'cancelled') THEN
      v_training:='plan_missing'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_plan_missing');
    ELSE
      SELECT * INTO v_assignment FROM public.training_assignments a WHERE a.plan_id=v_rule.plan_id AND a.employee_id=p_employee_id;
      IF v_assignment.id IS NULL THEN v_training:='required'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_required');
      ELSIF v_assignment.status<>'completed' OR COALESCE(v_assignment.hours_earned,0)<COALESCE((SELECT required_hours FROM public.training_plans WHERE id=v_rule.plan_id),0) THEN
        v_training:='incomplete'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_incomplete');
      ELSE v_training:='completed'; END IF;
    END IF;
    IF v_rule.id IS NULL OR v_rule.exam_plan_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.exam_papers ep JOIN public.training_plans p ON p.id=ep.plan_id
      WHERE ep.plan_id=v_rule.exam_plan_id AND ep.status='published' AND p.publish_status='published'
    ) THEN
      v_exam:='plan_missing'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_exam_plan_missing');
    ELSE
      SELECT * INTO v_exam_assignment FROM public.training_assignments a WHERE a.plan_id=v_rule.exam_plan_id AND a.employee_id=p_employee_id;
      IF v_exam_assignment.id IS NOT NULL AND v_exam_assignment.exam_status='passed' THEN v_exam:='passed';
      ELSE v_exam:='required'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_exam_required'); END IF;
    END IF;
    IF jsonb_array_length(v_type_reasons)>0 THEN v_all_satisfied:=FALSE; v_blocked:=v_blocked||v_type_reasons; END IF;
    v_items:=v_items||jsonb_build_array(jsonb_build_object(
      'special_type',v_type,'label',public.training_special_type_label(v_type),
      'source',CASE WHEN v_type='drilling' THEN 'project_includes_drilling' ELSE 'actual_special_work' END,
      'certificate',v_cert,'training_plan_id',v_rule.plan_id,'training_status',v_training,
      'exam_plan_id',v_rule.exam_plan_id,'exam_requirement',v_exam,'reason_codes',v_type_reasons));
  END LOOP;
  IF cardinality(v_required)=0 THEN v_reason:='special_work_not_required';
  ELSIF v_all_satisfied THEN v_reason:='special_requirements_satisfied';
  ELSE v_reason:=v_blocked->>0; END IF;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',p_employee_id,'member_id',v_member.id,
    'membership_type',v_member.membership_type,'membership_active',TRUE,
    'actual_special_work',to_jsonb(v_actual),'required_special_types',to_jsonb(v_required),
    'drilling_required',v_project.includes_drilling,'requirements',v_items,'blocked_reasons',v_blocked,
    'overall_satisfied',v_all_satisfied,'reason_code',v_reason);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_requirements_internal(UUID,UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_current_special_requirements(
  p_project_id UUID,p_employee_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id());
BEGIN
  IF v_employee IS NULL OR NOT (v_employee=public.training_my_employee_id() OR public.site_project_can_read_management_data(p_project_id)) THEN
    RAISE EXCEPTION '[D12:forbidden] 无权查看该人员当前专项要求';
  END IF;
  RETURN public.training_special_requirements_internal(p_project_id,v_employee);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_current_special_requirements(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_current_special_requirements(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_project_special_requirements(p_project_id UUID)
RETURNS JSONB AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN
    RAISE EXCEPTION '[D12:forbidden] 无权查看该项目专项要求';
  END IF;
  SELECT COALESCE(jsonb_agg(public.training_special_requirements_internal(m.project_id,m.employee_id) ORDER BY e.name),'[]'::jsonb)
    INTO v_result FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id
    WHERE m.project_id=p_project_id AND m.status='active';
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_project_special_requirements(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_project_special_requirements(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_special_tasks_internal(p_admission_id UUID)
RETURNS VOID AS $$
DECLARE v_a public.training_admissions; v_state JSONB; v_req JSONB; v_assignment UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:admission_not_found] 准入记录不存在'; END IF;
  v_state:=public.training_special_requirements_internal(v_a.project_id,v_a.employee_id);
  UPDATE public.training_admission_tasks SET requirement_active=FALSE
    WHERE admission_id=p_admission_id AND level='special';
  FOR v_req IN SELECT value FROM jsonb_array_elements(v_state->'requirements') LOOP
    IF v_req->>'training_plan_id' IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
      SELECT (v_req->>'training_plan_id')::uuid,e.id,p.id,e.department_id
      FROM public.training_employees e LEFT JOIN public.profiles p ON p.employee_id=e.id
      WHERE e.id=v_a.employee_id
      ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id
      RETURNING id INTO v_assignment;
    INSERT INTO public.training_admission_tasks(admission_id,plan_id,level,assignment_id,special_type,requirement_active)
      VALUES(p_admission_id,(v_req->>'training_plan_id')::uuid,'special',v_assignment,v_req->>'special_type',TRUE)
      ON CONFLICT(admission_id,plan_id) DO UPDATE SET assignment_id=EXCLUDED.assignment_id,
        special_type=EXCLUDED.special_type,requirement_active=TRUE;
  END LOOP;
  PERFORM public.training_recompute_admission_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_sync_special_tasks_internal(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_recompute_admission_internal(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE
  v_a public.training_admissions; v_p public.site_projects; v_pkg public.training_admission_packages;
  v_total INT; v_done INT; v_final_signed BOOLEAN; v_external_reason TEXT; v_special JSONB;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  SELECT * INTO v_p FROM public.site_projects WHERE id=v_a.project_id;
  SELECT * INTO v_pkg FROM public.training_admission_packages WHERE id=v_a.package_id;
  SELECT COUNT(*)::INT,COUNT(*) FILTER(WHERE status='completed')::INT INTO v_total,v_done
    FROM public.training_admission_tasks WHERE admission_id=p_admission_id AND requirement_active;
  v_special:=public.training_special_requirements_internal(v_a.project_id,v_a.employee_id);
  SELECT public.training_external_compliance_reason(v_a.project_id,v_a.employee_id,v_a.member_id) INTO v_external_reason;
  SELECT EXISTS(SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id=p_admission_id
    AND s.task_id IS NULL AND s.signer_role='employee' AND s.cycle_no=v_a.training_cycle_no) INTO v_final_signed;
  UPDATE public.training_admissions SET
    status=CASE
      WHEN v_p.status='closed' THEN 'project_closed'
      WHEN v_p.status IN('paused','pending_close') OR v_a.member_id IS NULL THEN 'blocked'
      WHEN v_a.retrain_required THEN 'blocked'
      WHEN EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.id=v_a.member_id AND m.status<>'active') THEN 'blocked'
      WHEN v_a.valid_until IS NOT NULL AND v_a.valid_until<CURRENT_DATE THEN 'expired'
      WHEN NOT COALESCE((v_special->>'overall_satisfied')::BOOLEAN,FALSE) THEN 'blocked'
      WHEN v_external_reason IS NOT NULL THEN 'blocked'
      WHEN v_total=0 OR v_done<v_total THEN CASE WHEN v_done>0 THEN 'learning' ELSE 'pending' END
      WHEN v_a.exam_required AND NOT v_a.exam_passed THEN 'exam_pending'
      WHEN NOT v_final_signed THEN 'pending_sign'
      WHEN v_a.site_confirmed_at IS NULL THEN 'pending_site_confirm'
      ELSE 'eligible' END,
    blocked_reason=CASE
      WHEN v_p.status IN('paused','pending_close') THEN '项目暂停或待关闭，须重新现场确认'
      WHEN v_p.status='closed' THEN '项目已关闭'
      WHEN v_a.retrain_required THEN COALESCE(v_a.retrain_reason,'须完成复训后方可上岗')
      WHEN EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.id=v_a.member_id AND m.status<>'active') THEN '人员已离开项目'
      WHEN v_a.valid_until IS NOT NULL AND v_a.valid_until<CURRENT_DATE THEN '培训合格凭证已过期，禁止上岗'
      WHEN NOT COALESCE((v_special->>'overall_satisfied')::BOOLEAN,FALSE) THEN '[D12:'||(v_special->>'reason_code')||'] 当前专项作业要求未满足'
      WHEN v_external_reason IS NOT NULL THEN v_external_reason ELSE NULL END,
    valid_until=CASE WHEN v_total>0 AND v_done=v_total AND COALESCE((v_special->>'overall_satisfied')::BOOLEAN,FALSE)
      AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL AND v_pkg.id IS NOT NULL
      AND NOT(v_a.valid_until IS NOT NULL AND v_a.valid_until<CURRENT_DATE)
      THEN (CURRENT_DATE+(v_pkg.validity_years::TEXT||' years')::INTERVAL)::DATE ELSE valid_until END,
    eligible_from=CASE WHEN v_total>0 AND v_done=v_total AND COALESCE((v_special->>'overall_satisfied')::BOOLEAN,FALSE)
      AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL
      THEN COALESCE(eligible_from,NOW()) ELSE eligible_from END,updated_at=NOW()
  WHERE id=p_admission_id RETURNING * INTO v_a;
  RETURN v_a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_recompute_admission_internal(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_set_member_special_work_types(
  p_member_id UUID,p_special_work_types TEXT[],p_reason TEXT
) RETURNS JSONB AS $$
DECLARE v_member public.site_project_members; v_types TEXT[]; v_reason TEXT:=NULLIF(btrim(p_reason),'');
  v_old TEXT; v_new TEXT; v_code TEXT; v_version INTEGER; v_admission UUID; v_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D12:unauthenticated] 请先登录'; END IF;
  SELECT * INTO v_member FROM public.site_project_members WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:member_not_found] 项目人员关系不存在'; END IF;
  IF v_member.status<>'active' THEN RAISE EXCEPTION '[D12:inactive_member] 只能维护当前在场人员的实际专项作业'; END IF;
  IF NOT public.site_project_can_manage(v_member.project_id) THEN RAISE EXCEPTION '[D12:forbidden] 您无权维护该项目人员实际专项作业'; END IF;
  IF v_reason IS NULL OR length(v_reason)>1000 THEN RAISE EXCEPTION '[D12:invalid_reason] 请填写不超过 1000 字的变更原因'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_special_work_types,ARRAY[]::TEXT[])) x
    WHERE public.training_special_type_code(x) IS NULL OR public.training_special_type_code(x)='drilling') THEN
    RAISE EXCEPTION '[D12:invalid_special_type] 仅可选择爆破、电工、焊工；钻探由项目属性决定';
  END IF;
  SELECT COALESCE(array_agg(public.training_special_type_label(code) ORDER BY code),ARRAY[]::TEXT[]) INTO v_types
  FROM (SELECT DISTINCT public.training_special_type_code(x) code FROM unnest(COALESCE(p_special_work_types,ARRAY[]::TEXT[])) x) s;
  IF v_member.special_work_types=v_types THEN
    SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id=p_member_id;
    RETURN jsonb_build_object('member_id',p_member_id,'changed',FALSE,'special_work_types',v_types,'version_no',v_version);
  END IF;
  v_role:=public.training_special_actor_role(v_member.project_id);
  FOREACH v_code IN ARRAY ARRAY['blasting','electrical','welding'] LOOP
    v_old:=public.training_special_type_label(v_code);
    IF (v_old=ANY(v_member.special_work_types)) IS DISTINCT FROM (v_old=ANY(v_types)) THEN
      INSERT INTO public.training_special_work_audit_logs(member_id,project_id,employee_id,special_type,old_active,new_active,operator_id,operator_role,reason)
      VALUES(p_member_id,v_member.project_id,v_member.employee_id,v_code,v_old=ANY(v_member.special_work_types),v_old=ANY(v_types),auth.uid(),v_role,v_reason);
    END IF;
  END LOOP;
  PERFORM set_config('app.special_work_assignment_source','rpc',true);
  PERFORM set_config('app.member_assignment_source','special_work_assignment_rpc',true);
  PERFORM set_config('app.member_assignment_reason',v_reason,true);
  UPDATE public.site_project_members SET special_work_types=v_types WHERE id=p_member_id;
  INSERT INTO public.site_project_audit_logs(project_id,actor_id,action,entity_type,entity_id,detail)
    VALUES(v_member.project_id,auth.uid(),'special_work_assignment_changed','site_project_member',p_member_id,
      jsonb_build_object('from',v_member.special_work_types,'to',v_types,'operator_role',v_role,'reason',v_reason));
  SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id=p_member_id;
  SELECT id INTO v_admission FROM public.training_admissions WHERE project_id=v_member.project_id AND employee_id=v_member.employee_id;
  IF v_admission IS NOT NULL THEN PERFORM public.training_sync_special_tasks_internal(v_admission); END IF;
  RETURN jsonb_build_object('member_id',p_member_id,'changed',TRUE,'special_work_types',v_types,'version_no',v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_member_special_work_types(UUID,TEXT[],TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_member_special_work_types(UUID,TEXT[],TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_set_package_special_requirements(p_package_id UUID,p_rules JSONB)
RETURNS JSONB AS $$
DECLARE v_package public.training_admission_packages; v_rule JSONB; v_type TEXT; v_plan UUID; v_exam UUID; v_count INTEGER:=0;
BEGIN
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id=p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:package_not_found] 培训包不存在'; END IF;
  IF v_package.status='published' THEN RAISE EXCEPTION '[D12:published_package_locked] 已发布培训包不可修改专项规则，请创建新版本'; END IF;
  IF NOT ((v_package.project_id IS NULL AND public.training_is_company_admin()) OR
    (v_package.project_id IS NOT NULL AND public.site_project_can_manage(v_package.project_id))) THEN
    RAISE EXCEPTION '[D12:forbidden] 您无权维护该培训包专项规则';
  END IF;
  IF jsonb_typeof(COALESCE(p_rules,'[]'::jsonb))<>'array' THEN RAISE EXCEPTION '[D12:invalid_rules] 专项规则必须是数组'; END IF;
  DELETE FROM public.training_admission_special_rules WHERE package_id=p_package_id;
  FOR v_rule IN SELECT value FROM jsonb_array_elements(COALESCE(p_rules,'[]'::jsonb)) LOOP
    v_type:=public.training_special_type_code(v_rule->>'special_type');
    v_plan:=NULLIF(v_rule->>'training_plan_id','')::uuid;
    v_exam:=NULLIF(v_rule->>'exam_plan_id','')::uuid;
    IF v_type IS NULL OR v_plan IS NULL OR v_exam IS NULL THEN RAISE EXCEPTION '[D12:invalid_rule] 专项类型、培训计划和考试计划不能为空'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id=i.plan_id
      WHERE i.package_id=p_package_id AND i.plan_id=v_plan AND i.level='special' AND p.level='special') THEN
      RAISE EXCEPTION '[D12:invalid_training_plan] 专项培训计划必须属于当前培训包';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.training_plans WHERE id=v_exam) THEN RAISE EXCEPTION '[D12:invalid_exam_plan] 专项考试计划不存在'; END IF;
    INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id)
      VALUES(p_package_id,public.training_special_type_label(v_type),v_plan,v_type,v_exam);
    v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('package_id',p_package_id,'configured_count',v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_package_special_requirements(UUID,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_package_special_requirements(UUID,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_set_package_special_rules(p_package_id UUID,p_rules JSONB)
RETURNS VOID AS $$
BEGIN
  PERFORM public.training_set_package_special_requirements(p_package_id,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'special_type',COALESCE(value->>'special_type',value->>'position_keyword'),
      'training_plan_id',COALESCE(value->>'training_plan_id',value->>'plan_id'),
      'exam_plan_id',COALESCE(value->>'exam_plan_id',value->>'plan_id'))),'[]'::jsonb)
     FROM jsonb_array_elements(COALESCE(p_rules,'[]'::jsonb))));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_package_special_rules(UUID,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_package_special_rules(UUID,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.site_project_set_drilling_operation(
  p_project_id UUID,p_enabled BOOLEAN,p_reason TEXT
) RETURNS JSONB AS $$
DECLARE v_project public.site_projects; v_reason TEXT:=NULLIF(btrim(p_reason),''); v_admission UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D12:unauthenticated] 请先登录'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:project_not_found] 正式项目不存在'; END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '[D12:forbidden] 您无权维护该项目钻探属性'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION '[D12:invalid_drilling_state] 请明确是否包含钻探作业'; END IF;
  IF v_project.includes_drilling=p_enabled THEN RETURN jsonb_build_object('project_id',p_project_id,'changed',FALSE,'includes_drilling',p_enabled); END IF;
  IF v_reason IS NULL OR length(v_reason)>1000 THEN RAISE EXCEPTION '[D12:invalid_reason] 请填写不超过 1000 字的变更原因'; END IF;
  PERFORM set_config('app.project_drilling_assignment_source','rpc',true);
  UPDATE public.site_projects SET includes_drilling=p_enabled,drilling_change_reason=v_reason,
    drilling_changed_by=auth.uid(),drilling_changed_at=NOW() WHERE id=p_project_id;
  INSERT INTO public.site_project_audit_logs(project_id,actor_id,action,entity_type,entity_id,detail)
    VALUES(p_project_id,auth.uid(),'drilling_operation_changed','site_project',p_project_id,
      jsonb_build_object('from',v_project.includes_drilling,'to',p_enabled,'operator_role',public.training_special_actor_role(p_project_id),'reason',v_reason));
  FOR v_admission IN SELECT id FROM public.training_admissions WHERE project_id=p_project_id LOOP
    PERFORM public.training_sync_special_tasks_internal(v_admission);
  END LOOP;
  RETURN jsonb_build_object('project_id',p_project_id,'changed',TRUE,'includes_drilling',p_enabled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.site_project_set_drilling_operation(UUID,BOOLEAN,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.site_project_set_drilling_operation(UUID,BOOLEAN,TEXT) TO authenticated;

-- D12 expands the existing certificate archive from external workers to every
-- project member who can be assigned actual blasting/electrical/welding work.
CREATE OR REPLACE FUNCTION public.contractor_document_create(
  p_project_id UUID,
  p_contractor_id UUID DEFAULT NULL,
  p_employee_id UUID DEFAULT NULL,
  p_document_type TEXT DEFAULT NULL,
  p_certificate_type TEXT DEFAULT NULL,
  p_certificate_no TEXT DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_storage_path TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_document public.contractor_documents;
  v_type TEXT:=lower(btrim(COALESCE(p_document_type,'')));
  v_certificate_type TEXT:=NULLIF(btrim(p_certificate_type),'');
  v_contractor_id UUID:=p_contractor_id;
  v_member public.site_project_members;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D12:unauthenticated] 请先登录'; END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '[D12:forbidden] 您无权维护该项目资质或证照'; END IF;
  IF v_type NOT IN ('qualification','special_certificate','other') THEN RAISE EXCEPTION '资料类型不合法'; END IF;
  IF v_type='qualification' AND v_contractor_id IS NULL THEN RAISE EXCEPTION '单位资质必须关联外协单位'; END IF;
  IF v_type='special_certificate' THEN
    IF p_employee_id IS NULL OR public.training_special_type_code(v_certificate_type) IS NULL
       OR public.training_special_type_code(v_certificate_type)='drilling'
       OR NULLIF(btrim(p_certificate_no),'') IS NULL OR p_valid_until IS NULL THEN
      RAISE EXCEPTION '[D12:invalid_certificate] 特种作业证必须关联项目人员，并填写爆破、电工或焊工证书类型、编号和有效期';
    END IF;
    v_certificate_type:=public.training_special_type_label(public.training_special_type_code(v_certificate_type));
    IF p_valid_until<CURRENT_DATE THEN RAISE EXCEPTION '特种作业证有效期不能早于今天'; END IF;
    SELECT * INTO v_member FROM public.site_project_members
      WHERE project_id=p_project_id AND employee_id=p_employee_id AND status IN ('active','left')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION '[D12:certificate_person_out_of_scope] 证照人员不属于该项目人员范围'; END IF;
    IF v_member.membership_type='external' THEN
      IF v_contractor_id IS NULL THEN v_contractor_id:=v_member.contractor_id;
      ELSIF v_contractor_id IS DISTINCT FROM v_member.contractor_id THEN
        RAISE EXCEPTION '证照所属单位与人员当前项目归属不一致';
      END IF;
    ELSIF v_contractor_id IS NOT NULL THEN
      RAISE EXCEPTION '[D12:internal_certificate_has_contractor] 内部或临时人员证照不得伪关联外协单位';
    END IF;
  END IF;
  IF v_contractor_id IS NULL AND p_employee_id IS NULL THEN RAISE EXCEPTION '资料必须关联外协单位或人员'; END IF;
  IF v_contractor_id IS NOT NULL AND NOT public.contractor_archive_project_company_allowed(p_project_id,v_contractor_id) THEN
    RAISE EXCEPTION '外协单位不属于该项目经营实体范围';
  END IF;
  IF p_valid_from IS NOT NULL AND p_valid_until IS NOT NULL AND p_valid_until<p_valid_from THEN RAISE EXCEPTION '资料有效期结束日期不能早于开始日期'; END IF;
  IF length(COALESCE(btrim(p_certificate_no),''))>160 THEN RAISE EXCEPTION '证书编号过长'; END IF;
  PERFORM public.contractor_archive_assert_storage(p_storage_path,'contractor-documents',p_project_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('contractor-document:'||p_storage_path,0));
  SELECT * INTO v_document FROM public.contractor_documents WHERE storage_path=p_storage_path LIMIT 1;
  IF FOUND THEN
    IF v_document.project_id<>p_project_id THEN RAISE EXCEPTION '该资料附件已归档到其他项目'; END IF;
    RETURN jsonb_build_object('document_id',v_document.id,'created',FALSE,'status',v_document.review_status);
  END IF;
  INSERT INTO public.contractor_documents(project_id,contractor_id,employee_id,document_type,certificate_type,
    certificate_no,valid_from,valid_until,storage_path,review_status)
  VALUES(p_project_id,v_contractor_id,p_employee_id,v_type,v_certificate_type,NULLIF(btrim(p_certificate_no),''),
    p_valid_from,p_valid_until,p_storage_path,'pending') RETURNING * INTO v_document;
  PERFORM public.training_refresh_external_admissions(p_project_id,v_contractor_id);
  RETURN jsonb_build_object('document_id',v_document.id,'created',TRUE,'status',v_document.review_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;
REVOKE ALL ON FUNCTION public.contractor_document_create(UUID,UUID,UUID,TEXT,TEXT,TEXT,DATE,DATE,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.contractor_document_create(UUID,UUID,UUID,TEXT,TEXT,TEXT,DATE,DATE,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_special_certificate_admission_refresh()
RETURNS TRIGGER AS $$
DECLARE v_admission UUID;
BEGIN
  IF NEW.document_type='special_certificate' AND NEW.project_id IS NOT NULL AND NEW.employee_id IS NOT NULL THEN
    SELECT id INTO v_admission FROM public.training_admissions
      WHERE project_id=NEW.project_id AND employee_id=NEW.employee_id;
    IF v_admission IS NOT NULL THEN PERFORM public.training_recompute_admission_internal(v_admission); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_certificate_admission_refresh() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_d12_special_certificate_admission_refresh ON public.contractor_documents;
CREATE TRIGGER trg_d12_special_certificate_admission_refresh
  AFTER INSERT OR UPDATE OF review_status,revoked_at,valid_from,valid_until,certificate_type ON public.contractor_documents
  FOR EACH ROW EXECUTE FUNCTION public.training_special_certificate_admission_refresh();

DROP FUNCTION IF EXISTS public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN);
CREATE FUNCTION public.training_start_admission(
  p_project_id UUID,p_employee_id UUID,p_package_id UUID,
  p_due_at TIMESTAMPTZ DEFAULT NULL,p_urgent BOOLEAN DEFAULT FALSE
) RETURNS UUID AS $$
DECLARE v_admission UUID; v_member UUID; v_old_package UUID; v_due TIMESTAMPTZ;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '[D11:forbidden] 您无权发起该项目入场培训'; END IF;
  IF public.training_employee_uses_visitor_path(p_employee_id) THEN RAISE EXCEPTION '[D11:visitor_safety_briefing_required] 公司领导应进入访客安全告知流程'; END IF;
  v_due:=COALESCE(p_due_at,date_trunc('day',NOW())+INTERVAL '3 days 18 hours');
  IF v_due<=NOW() THEN RAISE EXCEPTION '[D11:invalid_due_at] 完成截止时间必须晚于当前时间'; END IF;
  IF p_urgent AND v_due>date_trunc('day',NOW())+INTERVAL '1 day' THEN RAISE EXCEPTION '[D11:invalid_urgent_due_at] 当天加急截止时间不能晚于明天零点'; END IF;
  SELECT id INTO v_member FROM public.site_project_members WHERE project_id=p_project_id AND employee_id=p_employee_id AND status='active';
  IF v_member IS NULL THEN RAISE EXCEPTION '[D11:missing_assignment] 该人员不是项目有效成员'; END IF;
  IF public.training_member_effective_entity(p_project_id,p_employee_id) IS NULL THEN RAISE EXCEPTION '[D11:missing_effective_entity] 无法确定人员的权威经营实体归属'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.training_admission_packages WHERE id=p_package_id AND status='published' AND (project_id IS NULL OR project_id=p_project_id)) THEN
    RAISE EXCEPTION '[D11:missing_training_package] 培训包不存在、未发布或不适用于该项目'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project_id::TEXT||':'||p_employee_id::TEXT,81));
  SELECT id,package_id INTO v_admission,v_old_package FROM public.training_admissions WHERE project_id=p_project_id AND employee_id=p_employee_id FOR UPDATE;
  IF v_admission IS NOT NULL AND v_old_package<>p_package_id THEN RAISE EXCEPTION '[D11:admission_history_locked] 已有准入记录，不能覆盖为其他培训包'; END IF;
  IF v_admission IS NULL THEN
    INSERT INTO public.training_admissions(project_id,member_id,employee_id,package_id,due_at,urgent)
      VALUES(p_project_id,v_member,p_employee_id,p_package_id,v_due,COALESCE(p_urgent,FALSE)) RETURNING id INTO v_admission;
  ELSE UPDATE public.training_admissions SET member_id=v_member,due_at=v_due,urgent=COALESCE(p_urgent,FALSE),updated_at=NOW() WHERE id=v_admission; END IF;
  PERFORM public.training_sync_three_level_tasks_internal(v_admission);
  PERFORM public.training_sync_special_tasks_internal(v_admission);
  RETURN v_admission;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_start_admission(UUID,UUID,UUID,TIMESTAMPTZ,BOOLEAN) TO authenticated;

REVOKE INSERT,UPDATE,DELETE ON public.training_admission_special_rules FROM authenticated;
GRANT SELECT ON public.training_admission_special_rules TO authenticated;

COMMIT;

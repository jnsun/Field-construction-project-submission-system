-- D00-D13 V1.1 compatibility: data-driven specials, optional drilling exam and explicit exam semantics.
BEGIN;

ALTER TABLE public.training_admission_special_rules DROP CONSTRAINT IF EXISTS training_admission_special_rules_special_type_check;
ALTER TABLE public.training_admission_tasks DROP CONSTRAINT IF EXISTS training_admission_tasks_special_type_check;
ALTER TABLE public.training_special_work_audit_logs DROP CONSTRAINT IF EXISTS training_special_work_audit_logs_special_type_check;
ALTER TABLE public.exam_papers DROP CONSTRAINT IF EXISTS exam_papers_d13_config_check;
ALTER TABLE public.exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_d13_context_check;

ALTER TABLE public.training_admission_special_rules ADD CONSTRAINT training_special_rules_catalog_fk FOREIGN KEY(special_type) REFERENCES public.special_requirement_catalog(special_type) ON DELETE RESTRICT;
ALTER TABLE public.training_special_work_audit_logs ADD CONSTRAINT training_special_audit_catalog_fk FOREIGN KEY(special_type) REFERENCES public.special_requirement_catalog(special_type) ON DELETE RESTRICT;
ALTER TABLE public.training_admission_tasks ADD CONSTRAINT training_tasks_v11_special_check CHECK((level='special' AND (special_type IS NOT NULL OR requirement_active=FALSE)) OR (level<>'special' AND special_type IS NULL)) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_special_type_code(p_value TEXT)
RETURNS TEXT AS $$
  SELECT c.special_type FROM public.special_requirement_catalog c
  WHERE c.enabled AND (c.special_type=lower(btrim(COALESCE(p_value,''))) OR c.display_name=btrim(COALESCE(p_value,''))) LIMIT 1
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_type_code(TEXT) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.training_special_type_label(p_type TEXT)
RETURNS TEXT AS $$ SELECT display_name FROM public.special_requirement_catalog WHERE special_type=p_type AND enabled $$
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_type_label(TEXT) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_set_member_special_work_types(p_member_id UUID,p_special_work_types TEXT[],p_reason TEXT)
RETURNS JSONB AS $$
DECLARE v_member public.site_project_members; v_types TEXT[]; v_reason TEXT:=NULLIF(btrim(p_reason),''); v_old TEXT; v_new TEXT; v_code TEXT;
 v_version INTEGER; v_admission UUID; v_role TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '[D12:unauthenticated] 请先登录'; END IF;
  SELECT * INTO v_member FROM public.site_project_members WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:member_not_found] 项目人员关系不存在'; END IF;
  IF v_member.status<>'active' THEN RAISE EXCEPTION '[D12:inactive_member] 只能维护当前在场人员的实际专项作业'; END IF;
  IF NOT public.site_project_can_manage(v_member.project_id) THEN RAISE EXCEPTION '[D12:forbidden] 您无权维护该项目人员实际专项作业'; END IF;
  IF v_reason IS NULL OR length(v_reason)>1000 THEN RAISE EXCEPTION '[D12:invalid_reason] 请填写不超过 1000 字的变更原因'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_special_work_types,ARRAY[]::TEXT[])) x LEFT JOIN public.special_requirement_catalog c
    ON c.special_type=public.training_special_type_code(x) WHERE c.special_type IS NULL OR NOT c.enabled OR c.category<>'special_operation') THEN
    RAISE EXCEPTION '[D12:invalid_special_type] 只能选择已启用的个人持证专项；项目专项由项目风险属性决定';
  END IF;
  SELECT COALESCE(array_agg(c.display_name ORDER BY c.sort_order,c.special_type),ARRAY[]::TEXT[]) INTO v_types
  FROM (SELECT DISTINCT public.training_special_type_code(x) code FROM unnest(COALESCE(p_special_work_types,ARRAY[]::TEXT[])) x) s
  JOIN public.special_requirement_catalog c ON c.special_type=s.code;
  IF v_member.special_work_types=v_types THEN
    SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id=p_member_id;
    RETURN jsonb_build_object('member_id',p_member_id,'changed',FALSE,'special_work_types',v_types,'version_no',v_version);
  END IF;
  v_role:=public.training_special_actor_role(v_member.project_id);
  FOR v_code,v_new IN SELECT special_type,display_name FROM public.special_requirement_catalog WHERE enabled AND category='special_operation' LOOP
    v_old:=v_new;
    IF (v_old=ANY(v_member.special_work_types)) IS DISTINCT FROM (v_old=ANY(v_types)) THEN
      INSERT INTO public.training_special_work_audit_logs(member_id,project_id,employee_id,special_type,old_active,new_active,operator_id,operator_subject_id,operator_role,reason)
      VALUES(p_member_id,v_member.project_id,v_member.employee_id,v_code,v_old=ANY(v_member.special_work_types),v_old=ANY(v_types),auth.uid(),auth.uid(),v_role,v_reason);
    END IF;
  END LOOP;
  PERFORM set_config('app.special_work_assignment_source','rpc',true); PERFORM set_config('app.member_assignment_source','special_work_assignment_rpc',true);
  PERFORM set_config('app.member_assignment_reason',v_reason,true);
  UPDATE public.site_project_members SET special_work_types=v_types WHERE id=p_member_id;
  INSERT INTO public.site_project_audit_logs(project_id,actor_id,action,entity_type,entity_id,detail)
  VALUES(v_member.project_id,auth.uid(),'special_work_assignment_changed','site_project_member',p_member_id,jsonb_build_object('from',v_member.special_work_types,'to',v_types,'operator_role',v_role,'reason',v_reason));
  SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id=p_member_id;
  SELECT id INTO v_admission FROM public.training_admissions WHERE project_id=v_member.project_id AND employee_id=v_member.employee_id;
  IF v_admission IS NOT NULL THEN PERFORM public.training_sync_special_tasks_internal(v_admission); END IF;
  RETURN jsonb_build_object('member_id',p_member_id,'changed',TRUE,'special_work_types',v_types,'version_no',v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_member_special_work_types(UUID,TEXT[],TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_member_special_work_types(UUID,TEXT[],TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_special_requirements_internal(p_project_id UUID,p_employee_id UUID)
RETURNS JSONB AS $$
DECLARE v_member public.site_project_members; v_project public.site_projects; v_admission public.training_admissions;
 v_actual TEXT[]:=ARRAY[]::TEXT[]; v_required TEXT[]:=ARRAY[]::TEXT[]; v_type TEXT; v_rule public.training_admission_special_rules;
 v_cert JSONB; v_training TEXT; v_exam TEXT; v_assignment public.training_assignments; v_exam_assignment public.training_assignments;
 v_items JSONB:='[]'::jsonb; v_blocked JSONB:='[]'::jsonb; v_reason TEXT; v_type_reasons JSONB; v_all_satisfied BOOLEAN:=TRUE;
 v_catalog public.special_requirement_catalog; v_exam_required BOOLEAN;
BEGIN
  SELECT * INTO v_member FROM public.site_project_members WHERE project_id=p_project_id AND employee_id=p_employee_id ORDER BY joined_at DESC LIMIT 1;
  SELECT * INTO v_project FROM public.site_projects WHERE id=p_project_id;
  IF v_project.id IS NULL THEN RAISE EXCEPTION '[D12:project_not_found] 项目不存在'; END IF;
  IF v_member.id IS NULL OR v_member.status<>'active' THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',p_employee_id,'member_id',v_member.id,
    'membership_active',FALSE,'actual_special_work','[]','required_special_types','[]','drilling_required',FALSE,'requirements','[]','blocked_reasons','[]','overall_satisfied',TRUE,'reason_code','special_work_not_required'); END IF;
  SELECT COALESCE(array_agg(public.training_special_type_code(x) ORDER BY public.training_special_type_code(x)),ARRAY[]::TEXT[]) INTO v_actual FROM unnest(v_member.special_work_types) x;
  v_required:=v_actual;
  SELECT COALESCE(array_agg(DISTINCT c.special_type ORDER BY c.special_type),ARRAY[]::TEXT[]) INTO v_required
  FROM (SELECT unnest(v_required) special_type UNION ALL SELECT rc.special_type FROM public.site_project_risk_tags rt JOIN public.project_risk_catalog rc ON rc.risk_tag=rt.risk_tag
    WHERE rt.project_id=p_project_id AND rt.active) x JOIN public.special_requirement_catalog c ON c.special_type=x.special_type WHERE c.enabled;
  SELECT * INTO v_admission FROM public.training_admissions WHERE project_id=p_project_id AND employee_id=p_employee_id;
  FOREACH v_type IN ARRAY v_required LOOP
    SELECT * INTO v_catalog FROM public.special_requirement_catalog WHERE special_type=v_type AND enabled;
    v_type_reasons:='[]'; v_cert:=public.training_special_certificate_state_internal(p_project_id,p_employee_id,v_type);
    IF v_catalog.certificate_required THEN
      IF v_cert->>'state'='missing' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_missing');
      ELSIF v_cert->>'state'='expired' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_expired');
      ELSIF v_cert->>'state'='revoked' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_revoked');
      ELSIF v_cert->>'state'='unapproved' THEN v_type_reasons:=v_type_reasons||jsonb_build_array('special_certificate_unapproved'); END IF;
    END IF;
    v_rule:=NULL; v_assignment:=NULL; v_exam_assignment:=NULL;
    IF v_admission.id IS NOT NULL THEN SELECT r.* INTO v_rule FROM public.training_admission_special_rules r JOIN public.training_plans p ON p.id=r.plan_id
      WHERE r.package_id=v_admission.package_id AND r.special_type=v_type AND p.level='special' AND p.special_type=v_type; END IF;
    IF v_rule.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.training_plans p WHERE p.id=v_rule.plan_id AND p.publish_status='published' AND p.status<>'cancelled') THEN
      v_training:='plan_missing'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_plan_missing');
    ELSE SELECT * INTO v_assignment FROM public.training_assignments a WHERE a.plan_id=v_rule.plan_id AND a.employee_id=p_employee_id;
      IF v_assignment.id IS NULL THEN v_training:='required'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_required');
      ELSIF v_assignment.status<>'completed' OR COALESCE(v_assignment.hours_earned,0)<COALESCE((SELECT required_hours FROM public.training_plans WHERE id=v_rule.plan_id),0) THEN
        v_training:='incomplete'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_training_incomplete'); ELSE v_training:='completed'; END IF;
    END IF;
    v_exam_required:=v_catalog.exam_policy='required' OR (v_catalog.exam_policy='parameter' AND COALESCE((public.system_parameter_effective(v_catalog.exam_parameter_id,NULL,NOW())->>'value')::boolean,FALSE));
    IF NOT v_exam_required THEN v_exam:='not_required';
    ELSIF v_rule.id IS NULL OR v_rule.exam_plan_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_papers ep JOIN public.training_plans p ON p.id=ep.plan_id WHERE ep.plan_id=v_rule.exam_plan_id AND ep.status='published' AND p.publish_status='published') THEN
      v_exam:='plan_missing'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_exam_plan_missing');
    ELSE SELECT * INTO v_exam_assignment FROM public.training_assignments a WHERE a.plan_id=v_rule.exam_plan_id AND a.employee_id=p_employee_id;
      IF v_exam_assignment.id IS NOT NULL AND v_exam_assignment.exam_status='passed' THEN v_exam:='passed'; ELSE v_exam:='required'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_exam_required'); END IF;
    END IF;
    IF jsonb_array_length(v_type_reasons)>0 THEN v_all_satisfied:=FALSE; v_blocked:=v_blocked||v_type_reasons; END IF;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('special_type',v_type,'category',v_catalog.category,'label',v_catalog.display_name,
      'source',CASE WHEN v_catalog.category='project_special' THEN 'project_risk_tag' ELSE 'actual_special_work' END,'certificate',v_cert,
      'training_plan_id',v_rule.plan_id,'training_status',v_training,'exam_required',v_exam_required,'exam_plan_id',CASE WHEN v_exam_required THEN v_rule.exam_plan_id END,
      'exam_requirement',v_exam,'reason_codes',v_type_reasons));
  END LOOP;
  IF cardinality(v_required)=0 THEN v_reason:='special_work_not_required'; ELSIF v_all_satisfied THEN v_reason:='special_requirements_satisfied'; ELSE v_reason:=v_blocked->>0; END IF;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',p_employee_id,'member_id',v_member.id,'membership_type',v_member.membership_type,'membership_active',TRUE,
    'primary_admission_path',(public.training_primary_admission_path(p_project_id,p_employee_id)->>'primary_path'),'actual_special_work',to_jsonb(v_actual),'required_special_types',to_jsonb(v_required),
    'drilling_required',v_project.includes_drilling,'requirements',v_items,'blocked_reasons',v_blocked,'overall_satisfied',v_all_satisfied,'reason_code',v_reason);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_requirements_internal(UUID,UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_set_package_special_requirements(p_package_id UUID,p_rules JSONB)
RETURNS JSONB AS $$
DECLARE v_package public.training_admission_packages; v_rule JSONB; v_type TEXT; v_plan UUID; v_exam UUID; v_count INTEGER:=0; v_catalog public.special_requirement_catalog;
BEGIN
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id=p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D12:package_not_found] 培训包不存在'; END IF;
  IF v_package.status='published' THEN RAISE EXCEPTION '[D12:package_locked] 已发布培训包不可修改专项规则'; END IF;
  IF NOT ((v_package.project_id IS NULL AND public.training_is_company_admin()) OR (v_package.project_id IS NOT NULL AND public.site_project_can_manage(v_package.project_id))) THEN
    RAISE EXCEPTION '[D12:forbidden] 您无权维护该培训包专项规则'; END IF;
  IF jsonb_typeof(COALESCE(p_rules,'[]'::jsonb))<>'array' THEN RAISE EXCEPTION '[D12:invalid_special_rules] 专项规则必须是数组'; END IF;
  DELETE FROM public.training_admission_special_rules WHERE package_id=p_package_id;
  FOR v_rule IN SELECT value FROM jsonb_array_elements(COALESCE(p_rules,'[]'::jsonb)) LOOP
    v_type:=public.training_special_type_code(v_rule->>'special_type'); v_plan:=NULLIF(v_rule->>'training_plan_id','')::UUID; v_exam:=NULLIF(v_rule->>'exam_plan_id','')::UUID;
    SELECT * INTO v_catalog FROM public.special_requirement_catalog WHERE special_type=v_type AND enabled;
    IF v_catalog.special_type IS NULL OR v_plan IS NULL THEN RAISE EXCEPTION '[D12:invalid_special_rules] 专项类型或培训计划无效'; END IF;
    IF v_catalog.exam_policy='required' AND v_exam IS NULL THEN RAISE EXCEPTION '[D12:invalid_special_rules] 个人持证专项必须配置专项考试'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.training_plans WHERE id=v_plan AND level='special' AND special_type=v_type) THEN RAISE EXCEPTION '[D12:special_training_type_mismatch] 专项培训计划类型不匹配'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.training_admission_package_items WHERE package_id=p_package_id AND plan_id=v_plan AND level='special') THEN RAISE EXCEPTION '[D12:invalid_training_plan] 专项培训计划必须属于当前培训包'; END IF;
    IF v_exam IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.training_plans WHERE id=v_exam) THEN RAISE EXCEPTION '[D12:special_exam_plan_missing] 专项考试计划不存在'; END IF;
    INSERT INTO public.training_admission_special_rules(package_id,position_keyword,plan_id,special_type,exam_plan_id)
    VALUES(p_package_id,v_catalog.display_name,v_plan,v_type,v_exam); v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('package_id',p_package_id,'rule_count',v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_package_special_requirements(UUID,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_package_special_requirements(UUID,JSONB) TO authenticated;

ALTER TABLE public.exam_papers ADD COLUMN IF NOT EXISTS exam_semantic_type TEXT;
ALTER TABLE public.exam_attempts ADD COLUMN IF NOT EXISTS exam_semantic_type TEXT;
UPDATE public.exam_papers SET exam_semantic_type=CASE WHEN exam_type='special' THEN 'special_exam' WHEN exam_type='admission' THEN 'legacy_admission' ELSE 'general' END WHERE exam_semantic_type IS NULL;
UPDATE public.exam_attempts a SET exam_semantic_type=CASE WHEN a.exam_type='special' THEN 'special_exam' WHEN a.exam_type='admission' AND EXISTS(
 SELECT 1 FROM public.project_person_admission_paths p WHERE p.project_id=a.project_id AND p.employee_id=a.employee_id AND p.primary_path='employee') THEN 'employee_comprehensive_admission_exam'
 WHEN a.exam_type='admission' THEN 'project_induction_exam' ELSE 'general' END WHERE exam_semantic_type IS NULL;
ALTER TABLE public.exam_papers ALTER COLUMN exam_semantic_type SET DEFAULT 'employee_comprehensive_admission_exam';
ALTER TABLE public.exam_papers ALTER COLUMN exam_semantic_type SET NOT NULL;
ALTER TABLE public.exam_attempts ALTER COLUMN exam_semantic_type SET NOT NULL;
ALTER TABLE public.exam_papers ADD COLUMN IF NOT EXISTS config_rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.exam_papers ALTER COLUMN config_rules_version SET DEFAULT 2;
ALTER TABLE public.exam_papers ADD CONSTRAINT exam_papers_v11_config_check CHECK(config_rules_version=1 OR (question_count BETWEEN 10 AND 100 AND duration_min BETWEEN 10 AND 120 AND pass_score BETWEEN 60 AND 100 AND retry_limit BETWEEN 1 AND 10)) NOT VALID;
ALTER TABLE public.exam_papers ADD CONSTRAINT exam_papers_v11_semantic_check CHECK((exam_type='special' AND exam_semantic_type='special_exam') OR (exam_type='admission' AND exam_semantic_type IN('employee_comprehensive_admission_exam','project_induction_exam','legacy_admission')) OR (exam_type='general' AND exam_semantic_type='general')) NOT VALID;
ALTER TABLE public.exam_attempts ADD CONSTRAINT exam_attempts_v11_semantic_check CHECK(exam_semantic_type IN('employee_comprehensive_admission_exam','project_induction_exam','special_exam','legacy_admission','general','legacy')) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_exam_paper_guard() RETURNS TRIGGER AS $$
DECLARE qmin NUMERIC; qmax NUMERIC; dmin NUMERIC; dmax NUMERIC; pmin NUMERIC; pmax NUMERIC; tmin NUMERIC; tmax NUMERIC;
BEGIN
  IF TG_OP='INSERT' OR NEW.question_count IS DISTINCT FROM OLD.question_count OR NEW.duration_min IS DISTINCT FROM OLD.duration_min OR NEW.pass_score IS DISTINCT FROM OLD.pass_score OR NEW.retry_limit IS DISTINCT FROM OLD.retry_limit THEN NEW.config_rules_version:=2; END IF;
  SELECT min_value,max_value INTO qmin,qmax FROM public.system_parameter_definitions WHERE parameter_id='EXAM-QTY-001';
  SELECT min_value,max_value INTO dmin,dmax FROM public.system_parameter_definitions WHERE parameter_id='EXAM-DUR-001';
  SELECT min_value,max_value INTO pmin,pmax FROM public.system_parameter_definitions WHERE parameter_id='EXAM-PASS-001';
  SELECT min_value,max_value INTO tmin,tmax FROM public.system_parameter_definitions WHERE parameter_id='EXAM-TRY-001';
  IF NEW.config_rules_version=2 AND (NEW.question_count NOT BETWEEN qmin AND qmax OR NEW.duration_min NOT BETWEEN dmin AND dmax OR NEW.pass_score NOT BETWEEN pmin AND pmax OR NEW.retry_limit NOT BETWEEN tmin AND tmax) THEN
    RAISE EXCEPTION '[D13:invalid_exam_configuration] 考试参数超出 V1.1 允许范围'; END IF;
  IF NEW.exam_type='special' THEN NEW.special_type:=public.training_special_type_code(NEW.special_type); NEW.exam_semantic_type:='special_exam';
  ELSIF NEW.exam_type='admission' THEN NEW.special_type:=NULL; IF NEW.exam_semantic_type NOT IN('employee_comprehensive_admission_exam','project_induction_exam','legacy_admission') THEN NEW.exam_semantic_type:='employee_comprehensive_admission_exam'; END IF;
  ELSIF NEW.exam_type='general' THEN NEW.special_type:=NULL; NEW.exam_semantic_type:='general'; ELSE RAISE EXCEPTION '[D13:invalid_exam_configuration] 考试类型无效'; END IF;
  IF NEW.exam_type='special' AND NEW.special_type IS NULL THEN RAISE EXCEPTION '[D13:invalid_exam_configuration] 专项类型无效'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_paper_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_exam_paper_guard ON public.exam_papers;
CREATE TRIGGER trg_training_exam_paper_guard BEFORE INSERT OR UPDATE OF exam_type,exam_semantic_type,special_type,question_count,duration_min,pass_score,retry_limit ON public.exam_papers FOR EACH ROW EXECUTE FUNCTION public.training_exam_paper_guard();

CREATE OR REPLACE FUNCTION public.training_exam_attempt_semantic_guard() RETURNS TRIGGER AS $$
DECLARE v_path TEXT;
BEGIN
  IF NEW.exam_type='special' THEN NEW.exam_semantic_type:='special_exam';
  ELSIF NEW.exam_type='admission' THEN SELECT primary_path INTO v_path FROM public.project_person_admission_paths WHERE project_id=NEW.project_id AND employee_id=NEW.employee_id;
    NEW.exam_semantic_type:=CASE WHEN v_path='employee' THEN 'employee_comprehensive_admission_exam' ELSE 'project_induction_exam' END;
  ELSIF NEW.exam_type='legacy' THEN NEW.exam_semantic_type:='legacy'; ELSE NEW.exam_semantic_type:='general'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_attempt_semantic_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_exam_attempt_semantic_guard ON public.exam_attempts;
CREATE TRIGGER trg_training_exam_attempt_semantic_guard BEFORE INSERT ON public.exam_attempts FOR EACH ROW EXECUTE FUNCTION public.training_exam_attempt_semantic_guard();

CREATE OR REPLACE FUNCTION public.training_exam_requirement_context(p_admission_id UUID,p_exam_type TEXT,p_special_type TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v public.training_admissions; v_path TEXT; v_type TEXT;
BEGIN
  SELECT * INTO v FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 准入记录不存在'; END IF;
  v_path:=public.training_primary_admission_path(v.project_id,v.employee_id)->>'primary_path';
  v_type:=CASE WHEN p_exam_type='special' THEN 'special_exam' WHEN v_path='employee' THEN 'employee_comprehensive_admission_exam' ELSE 'project_induction_exam' END;
  RETURN jsonb_build_object('admission_id',v.id,'project_id',v.project_id,'employee_id',v.employee_id,'primary_admission_path',v_path,
    'exam_semantic_type',v_type,'legacy_exam_type',p_exam_type,'special_type',public.training_special_type_code(p_special_type));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_requirement_context(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_requirement_context(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_exam_context_internal(p_admission_id UUID,p_exam_type TEXT,p_special_type TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_three JSONB; v_special JSONB; v_req JSONB; v_plan UUID; v_assignment UUID; v_type TEXT; v_semantic TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 准入记录不存在'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.site_project_members WHERE id=v_a.member_id AND status='active') THEN RAISE EXCEPTION '[D13:project_not_accessible] 当前人员已不在项目 active 范围'; END IF;
  IF p_exam_type='admission' THEN
    v_three:=public.training_three_level_status(v_a.project_id,v_a.employee_id);
    IF v_three->>'person_category'='visitor' THEN RAISE EXCEPTION '[D13:prerequisite_not_met] visitor_safety_briefing_required'; END IF;
    IF public.training_primary_admission_path(v_a.project_id,v_a.employee_id)->>'primary_path'='employee' THEN
      v_semantic:='employee_comprehensive_admission_exam';
      IF NOT COALESCE((v_three->>'exam_allowed')::BOOLEAN,FALSE) THEN RAISE EXCEPTION '[D13:three_level_training_required] %',v_three->>'reason_code'; END IF;
    ELSE
      v_semantic:='project_induction_exam';
      IF NOT EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=v_a.id AND level='project' AND training_category='project_induction' AND requirement_active)
         OR EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=v_a.id AND level='project' AND training_category='project_induction' AND requirement_active AND status<>'completed') THEN
        RAISE EXCEPTION '[D13:project_admission_training_required] 项目准入人员须先完成项目入场教育'; END IF;
    END IF;
    SELECT exam_plan_id INTO v_plan FROM public.training_admission_packages WHERE id=v_a.package_id;
    IF v_plan IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published' AND exam_type='admission' AND special_type IS NULL
      AND exam_semantic_type IN(v_semantic,'legacy_admission')) THEN RAISE EXCEPTION '[D13:exam_not_configured] 对应准入考试尚未正确配置'; END IF;
  ELSIF p_exam_type='special' THEN
    v_semantic:='special_exam'; v_type:=public.training_special_type_code(p_special_type);
    IF v_type IS NULL THEN RAISE EXCEPTION '[D13:special_exam_not_configured] 专项类型不合法'; END IF;
    v_special:=public.training_special_requirements_internal(v_a.project_id,v_a.employee_id);
    SELECT value INTO v_req FROM jsonb_array_elements(COALESCE(v_special->'requirements','[]'::jsonb)) WHERE value->>'special_type'=v_type;
    IF v_req IS NULL OR NOT COALESCE((v_req->>'exam_required')::boolean,FALSE) THEN RAISE EXCEPTION '[D13:special_requirement_not_met] 当前项目人员没有该专项考试要求'; END IF;
    IF v_req->>'training_status'<>'completed' OR v_req->'certificate'->>'state' NOT IN('valid','not_required') THEN RAISE EXCEPTION '[D13:special_requirement_not_met] D12 专项证照或培训前置未满足'; END IF;
    v_plan:=NULLIF(v_req->>'exam_plan_id','')::UUID;
    IF v_plan IS NULL OR NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published' AND exam_type='special' AND special_type=v_type) THEN
      RAISE EXCEPTION '[D13:special_exam_not_configured] 专项考试配置缺失或类型不匹配'; END IF;
  ELSE RAISE EXCEPTION '[D13:exam_not_configured] 考试类型不合法'; END IF;
  INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,exam_status)
  SELECT v_plan,e.id,pr.id,e.department_id,'pending' FROM public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id=e.id WHERE e.id=v_a.employee_id
  ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id RETURNING id INTO v_assignment;
  IF p_exam_type='admission' THEN UPDATE public.training_admissions SET exam_required=TRUE,updated_at=NOW() WHERE id=v_a.id; END IF;
  RETURN jsonb_build_object('admission_id',v_a.id,'project_id',v_a.project_id,'employee_id',v_a.employee_id,'plan_id',v_plan,'assignment_id',v_assignment,
    'exam_type',p_exam_type,'exam_semantic_type',v_semantic,'special_type',v_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_context_internal(UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;

COMMIT;

-- D12 R02：关闭专项计划类型、TRUNCATE 权限和操作者快照三个 P1。
BEGIN;

-- P1-01：所有新配置必须把专项类型映射到同类型专项培训计划。
CREATE OR REPLACE FUNCTION public.training_special_rule_type_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id=NEW.plan_id AND p.level='special' AND p.special_type=NEW.special_type
  ) THEN
    RAISE EXCEPTION '[D12:special_training_type_mismatch] 专项要求必须匹配同类型专项培训计划';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_rule_type_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_special_rule_type_guard ON public.training_admission_special_rules;
CREATE TRIGGER trg_training_special_rule_type_guard
  BEFORE INSERT OR UPDATE OF plan_id,special_type ON public.training_admission_special_rules
  FOR EACH ROW EXECUTE FUNCTION public.training_special_rule_type_guard();

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
    IF NOT EXISTS(SELECT 1 FROM public.training_plans WHERE id=v_plan AND level='special' AND special_type=v_type) THEN
      RAISE EXCEPTION '[D12:special_training_type_mismatch] 专项要求必须匹配同类型专项培训计划';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.training_admission_package_items i
      WHERE i.package_id=p_package_id AND i.plan_id=v_plan AND i.level='special') THEN
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
      SELECT r.* INTO v_rule FROM public.training_admission_special_rules r
      JOIN public.training_plans p ON p.id=r.plan_id
      WHERE r.package_id=v_admission.package_id AND r.special_type=v_type
        AND p.level='special' AND p.special_type=v_type;
    END IF;
    IF v_rule.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.training_plans p WHERE p.id=v_rule.plan_id AND p.level='special' AND p.special_type=v_type AND p.publish_status='published' AND p.status<>'cancelled') THEN
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

-- P1-02：RLS 不保护 TRUNCATE，客户端角色不得持有核心数据表破坏权限。
REVOKE TRUNCATE ON TABLE public.site_projects,public.site_project_members,
  public.training_admissions,public.training_admission_tasks,
  public.training_admission_special_rules,public.training_assignments,public.training_plans
FROM anon,authenticated;

-- P1-03：保留可失联 live FK，同时保存不会随账号删除消失的稳定 UUID 快照。
ALTER TABLE public.training_special_work_audit_logs
  ADD COLUMN IF NOT EXISTS operator_subject_id UUID;
DROP TRIGGER IF EXISTS trg_training_special_work_audit_immutable ON public.training_special_work_audit_logs;
UPDATE public.training_special_work_audit_logs
SET operator_subject_id=operator_id
WHERE operator_subject_id IS NULL AND operator_id IS NOT NULL;
ALTER TABLE public.training_special_work_audit_logs
  DROP CONSTRAINT IF EXISTS training_special_work_audit_operator_snapshot_check;
ALTER TABLE public.training_special_work_audit_logs
  ADD CONSTRAINT training_special_work_audit_operator_snapshot_check
  CHECK (operator_subject_id IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_special_work_audit_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  NEW.operator_subject_id:=COALESCE(NEW.operator_subject_id,NEW.operator_id,auth.uid());
  IF NEW.operator_subject_id IS NULL THEN
    RAISE EXCEPTION '[D12:operator_snapshot_required] 实际专项作业审计必须保留操作者身份快照';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_work_audit_snapshot() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.training_special_work_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.operator_id IS NOT NULL AND NEW.operator_id IS NULL
     AND (to_jsonb(NEW)-'operator_id')=(to_jsonb(OLD)-'operator_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '[D12:special_work_history_locked] 实际专项作业历史不可修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_work_audit_immutable() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_special_work_audit_snapshot ON public.training_special_work_audit_logs;
CREATE TRIGGER trg_training_special_work_audit_snapshot
  BEFORE INSERT ON public.training_special_work_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.training_special_work_audit_snapshot();
CREATE TRIGGER trg_training_special_work_audit_immutable
  BEFORE UPDATE OR DELETE ON public.training_special_work_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.training_special_work_audit_immutable();

COMMIT;

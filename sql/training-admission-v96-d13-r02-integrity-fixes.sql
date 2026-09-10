-- D13 R02-2: immutable packages, effective parameter approvals, project-scoped special exams and ordered scheme versions.
BEGIN;

-- Published package versions are content snapshots. Only a draft may change its item set.
CREATE OR REPLACE FUNCTION public.training_package_item_draft_guard() RETURNS TRIGGER AS $$
DECLARE v_package_id UUID:=CASE WHEN TG_OP='DELETE' THEN OLD.package_id ELSE NEW.package_id END;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.training_admission_packages WHERE id=v_package_id AND status='draft') THEN
    RAISE EXCEPTION '[D13:published_package_immutable] 已发布培训包版本内容不可原地修改，请创建新版本';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_package_item_draft_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_package_item_draft_guard ON public.training_admission_package_items;
CREATE TRIGGER trg_training_package_item_draft_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.training_admission_package_items FOR EACH ROW EXECUTE FUNCTION public.training_package_item_draft_guard();

-- Approval is a server-side fact. Existing controlled defaults are grandfathered explicitly as migration facts.
DROP INDEX IF EXISTS public.system_parameter_one_active_idx;
CREATE TABLE public.system_parameter_version_approvals (
  version_id UUID PRIMARY KEY REFERENCES public.system_parameter_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN('pending','approved','rejected')),
  submitted_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  approval_comment TEXT,
  request_id TEXT,
  approval_origin TEXT NOT NULL DEFAULT 'rpc' CHECK(approval_origin IN('rpc','migration')),
  CHECK((status='pending' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN('approved','rejected') AND approved_at IS NOT NULL)),
  CHECK(approval_origin='migration' OR submitted_by IS NOT NULL)
);
INSERT INTO public.system_parameter_version_approvals(version_id,status,submitted_by,submitted_at,approved_by,approved_at,approval_comment,approval_origin)
SELECT v.id,'approved',v.changed_by,v.created_at,v.changed_by,v.created_at,'v96 grandfathered controlled parameter fact','migration'
FROM public.system_parameter_versions v JOIN public.system_parameter_definitions d ON d.parameter_id=v.parameter_id
WHERE d.requires_approval AND v.status='active' ON CONFLICT(version_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.system_parameter_approval_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN('UPDATE','DELETE') AND current_setting('app.system_parameter_approval','true')<>'rpc' THEN
    RAISE EXCEPTION '[V11:parameter_approval_immutable] 参数审批事实不可直接修改或删除';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_approval_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER trg_system_parameter_approval_guard BEFORE UPDATE OR DELETE
  ON public.system_parameter_version_approvals FOR EACH ROW EXECUTE FUNCTION public.system_parameter_approval_guard();
ALTER TABLE public.system_parameter_version_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_parameter_version_approvals FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.system_parameter_effective(p_parameter_id TEXT,p_scope_id UUID DEFAULT NULL,p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS JSONB AS $$
  SELECT jsonb_build_object('parameter_id',d.parameter_id,'value',COALESCE(v.value,d.default_value),'version_id',v.id,
    'version_no',COALESCE(v.version_no,0),'effective_at',v.effective_at)
  FROM public.system_parameter_definitions d LEFT JOIN LATERAL (
    SELECT x.* FROM public.system_parameter_versions x
    WHERE x.parameter_id=d.parameter_id AND x.status='active' AND x.effective_at<=p_at
      AND (x.scope_id=p_scope_id OR x.scope_id IS NULL)
      AND (NOT d.requires_approval OR EXISTS(SELECT 1 FROM public.system_parameter_version_approvals a WHERE a.version_id=x.id AND a.status='approved'))
    ORDER BY (x.scope_id IS NOT NULL) DESC,x.effective_at DESC,x.version_no DESC LIMIT 1
  ) v ON TRUE WHERE d.parameter_id=p_parameter_id AND d.enabled;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_effective(TEXT,UUID,TIMESTAMPTZ) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.system_parameter_effective(TEXT,UUID,TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.system_parameter_set(p_parameter_id TEXT,p_value JSONB,p_scope_id UUID,p_effective_at TIMESTAMPTZ,p_reason TEXT,p_approval JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB AS $$
DECLARE d public.system_parameter_definitions; v_old UUID; v_new UUID; v_no INTEGER; v_num NUMERIC; v_status TEXT; v_subject UUID;
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[V11:parameter_forbidden] 仅有效公司级管理员可修改参数'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[V11:parameter_reason_required] 必须填写修改原因'; END IF;
  IF COALESCE(p_approval,'{}'::jsonb) ?| ARRAY['approved_by','approved_at','status'] THEN
    RAISE EXCEPTION '[V11:parameter_approval_spoofed] 客户端不得声明参数已审批';
  END IF;
  SELECT * INTO d FROM public.system_parameter_definitions WHERE parameter_id=p_parameter_id AND enabled FOR UPDATE;
  IF d.parameter_id IS NULL THEN RAISE EXCEPTION '[V11:parameter_not_found] 参数不存在'; END IF;
  IF d.data_type IN('integer','number') THEN
    BEGIN v_num:=(p_value#>>'{}')::numeric; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是数字'; END;
    IF (d.min_value IS NOT NULL AND v_num<d.min_value) OR (d.max_value IS NOT NULL AND v_num>d.max_value) THEN RAISE EXCEPTION '[V11:parameter_out_of_range] 参数超出允许范围'; END IF;
    IF d.data_type='integer' AND trunc(v_num)<>v_num THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是整数'; END IF;
  ELSIF d.data_type='boolean' AND jsonb_typeof(p_value)<>'boolean' THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是布尔值';
  ELSIF d.allowed_values IS NOT NULL AND NOT d.allowed_values @> jsonb_build_array(p_value) THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数不在允许枚举中'; END IF;
  v_subject:=public.training_current_account_subject_id();
  IF v_subject IS NULL THEN RAISE EXCEPTION '[V11:parameter_forbidden] 当前账号缺少权威主体'; END IF;
  SELECT id INTO v_old FROM public.system_parameter_versions WHERE parameter_id=p_parameter_id AND scope_id IS NOT DISTINCT FROM p_scope_id
    AND status='active' AND effective_at<=NOW() ORDER BY effective_at DESC,version_no DESC LIMIT 1;
  SELECT COALESCE(MAX(version_no),0)+1 INTO v_no FROM public.system_parameter_versions WHERE parameter_id=p_parameter_id AND scope_id IS NOT DISTINCT FROM p_scope_id;
  v_status:=CASE WHEN d.requires_approval THEN 'draft' ELSE 'active' END;
  INSERT INTO public.system_parameter_versions(parameter_id,scope_id,value,version_no,status,effective_at,changed_by,change_reason,approval)
  VALUES(p_parameter_id,p_scope_id,p_value,v_no,v_status,COALESCE(p_effective_at,NOW()),v_subject,btrim(p_reason),'{}'::jsonb) RETURNING id INTO v_new;
  IF d.requires_approval THEN
    INSERT INTO public.system_parameter_version_approvals(version_id,status,submitted_by,request_id)
    VALUES(v_new,'pending',v_subject,NULLIF(btrim(p_approval->>'request_id'),''));
  END IF;
  INSERT INTO public.system_parameter_audit(parameter_id,scope_id,old_version_id,new_version_id,operator_subject_id,reason)
  VALUES(p_parameter_id,p_scope_id,v_old,v_new,v_subject,btrim(p_reason));
  RETURN jsonb_build_object('parameter_id',p_parameter_id,'version_id',v_new,'version_no',v_no,'value',p_value,
    'status',v_status,'approval_status',CASE WHEN d.requires_approval THEN 'pending' ELSE 'not_required' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_set(TEXT,JSONB,UUID,TIMESTAMPTZ,TEXT,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.system_parameter_set(TEXT,JSONB,UUID,TIMESTAMPTZ,TEXT,JSONB) TO authenticated;

CREATE FUNCTION public.system_parameter_approve(p_version_id UUID,p_approve BOOLEAN,p_comment TEXT,p_request_id TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_version public.system_parameter_versions; v_approval public.system_parameter_version_approvals; v_subject UUID; v_status TEXT;
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[V11:parameter_approval_forbidden] 仅有效公司级管理员可审批参数'; END IF;
  v_subject:=public.training_current_account_subject_id();
  SELECT * INTO v_version FROM public.system_parameter_versions WHERE id=p_version_id FOR UPDATE;
  SELECT * INTO v_approval FROM public.system_parameter_version_approvals WHERE version_id=p_version_id FOR UPDATE;
  IF v_version.id IS NULL OR v_approval.version_id IS NULL THEN RAISE EXCEPTION '[V11:parameter_version_not_found] 待审批参数版本不存在'; END IF;
  IF v_approval.status<>'pending' OR v_version.status<>'draft' THEN RAISE EXCEPTION '[V11:parameter_approval_not_pending] 参数版本不在待审批状态'; END IF;
  IF v_approval.submitted_by=v_subject THEN RAISE EXCEPTION '[V11:parameter_self_approval_forbidden] 参数提交人与审批人必须分离'; END IF;
  IF NULLIF(btrim(p_comment),'') IS NULL THEN RAISE EXCEPTION '[V11:parameter_approval_comment_required] 必须填写审批意见'; END IF;
  v_status:=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  PERFORM set_config('app.system_parameter_approval','rpc',TRUE);
  UPDATE public.system_parameter_version_approvals SET status=v_status,approved_by=v_subject,approved_at=NOW(),approval_comment=btrim(p_comment),
    request_id=COALESCE(NULLIF(btrim(p_request_id),''),request_id) WHERE version_id=p_version_id;
  UPDATE public.system_parameter_versions SET status=CASE WHEN p_approve THEN 'active' ELSE 'retired' END WHERE id=p_version_id;
  RETURN jsonb_build_object('version_id',p_version_id,'approval_status',v_status,'effective_at',v_version.effective_at,
    'effective_now',p_approve AND v_version.effective_at<=NOW());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_approve(UUID,BOOLEAN,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.system_parameter_approve(UUID,BOOLEAN,TEXT,TEXT) TO authenticated;

-- Special-exam completion belongs to the current admission/project, never to a global plan assignment.
CREATE OR REPLACE FUNCTION public.training_special_exam_passed(p_admission_id UUID,p_project_id UUID,p_employee_id UUID,p_special_type TEXT,p_exam_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM public.exam_attempts a JOIN public.exam_papers p ON p.id=a.paper_id
    WHERE a.admission_id=p_admission_id AND a.project_id=p_project_id AND a.employee_id=p_employee_id
      AND a.exam_type='special' AND a.special_type=p_special_type AND a.status='submitted' AND a.result='pass'
      AND p.plan_id=p_exam_plan_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_special_exam_passed(UUID,UUID,UUID,TEXT,UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_special_requirements_internal(p_project_id UUID,p_employee_id UUID)
RETURNS JSONB AS $$
DECLARE v_member public.site_project_members; v_project public.site_projects; v_admission public.training_admissions;
 v_actual TEXT[]:=ARRAY[]::TEXT[]; v_required TEXT[]:=ARRAY[]::TEXT[]; v_type TEXT; v_rule public.training_admission_special_rules;
 v_cert JSONB; v_training TEXT; v_exam TEXT; v_assignment public.training_assignments;
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
    v_rule:=NULL; v_assignment:=NULL;
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
    ELSIF v_admission.id IS NOT NULL AND public.training_special_exam_passed(v_admission.id,p_project_id,p_employee_id,v_type,v_rule.exam_plan_id) THEN v_exam:='passed';
    ELSE v_exam:='required'; v_type_reasons:=v_type_reasons||jsonb_build_array('special_exam_required'); END IF;
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

-- Keep the proven v93 validation and add one simple chronology rule around it.
ALTER FUNCTION public.training_scheme_validate_publish(UUID) RENAME TO training_scheme_validate_publish_v93;
REVOKE ALL ON FUNCTION public.training_scheme_validate_publish_v93(UUID) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.training_scheme_validate_publish(p_version_id UUID) RETURNS JSONB AS $$
DECLARE v_result JSONB; v public.three_level_training_scheme_versions;
BEGIN
  v_result:=public.training_scheme_validate_publish_v93(p_version_id);
  IF NOT COALESCE((v_result->>'valid')::boolean,FALSE) THEN RETURN v_result; END IF;
  SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id;
  IF EXISTS(SELECT 1 FROM public.three_level_training_scheme_versions x WHERE x.scheme_id=v.scheme_id
    AND x.status IN('published','superseded','retired') AND x.published_at IS NOT NULL AND x.effective_from>=v.effective_from) THEN
    RETURN v_result||jsonb_build_object('valid',FALSE,'reason_code','scheme_effective_order_invalid');
  END IF;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_scheme_validate_publish(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_scheme_validate_publish(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_scheme_publish(p_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.three_level_training_scheme_versions; v_before JSONB; v_after JSONB; v_validation JSONB;
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id;
  IF v.id IS NULL THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 方案版本不存在'; END IF;
  PERFORM 1 FROM public.three_level_training_schemes WHERE id=v.scheme_id FOR UPDATE;
  SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id FOR UPDATE;
  v_validation:=public.training_scheme_validate_publish(p_version_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    IF v_validation->>'reason_code'='applicability_rule_conflict' THEN RAISE EXCEPTION '[S3C:applicability_rule_conflict] 适用规则存在同层级同 priority 冲突'; END IF;
    IF v_validation->>'reason_code'='scheme_effective_order_invalid' THEN RAISE EXCEPTION '[S3C:scheme_effective_order_invalid] 新版本生效日期必须晚于已有最新发布版本'; END IF;
    RAISE EXCEPTION '[S3A:%] 方案发布校验失败',v_validation->>'reason_code';
  END IF;
  v_before:=to_jsonb(v); PERFORM set_config('app.training_scheme_lifecycle','on',TRUE);
  UPDATE public.three_level_training_scheme_versions SET status='superseded',effective_to=v.effective_from-1
    WHERE scheme_id=v.scheme_id AND status='published' AND effective_from<v.effective_from;
  UPDATE public.three_level_training_scheme_versions SET status='published',published_by=public.training_current_account_subject_id(),published_at=NOW() WHERE id=p_version_id;
  SELECT to_jsonb(x) INTO v_after FROM public.three_level_training_scheme_versions x WHERE id=p_version_id;
  PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'publish',v_before,v_after,p_reason,p_request_id);
  RETURN v_after;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

COMMENT ON TABLE public.system_parameter_version_approvals IS 'Server-authoritative maker-checker approval facts for controlled parameter versions.';
COMMENT ON FUNCTION public.system_parameter_approve(UUID,BOOLEAN,TEXT,TEXT) IS 'Company-admin maker-checker approval; actor is always derived from auth.uid().';
COMMENT ON FUNCTION public.training_special_exam_passed(UUID,UUID,UUID,TEXT,UUID) IS 'Exact admission/project/person/special-type/plan pass fact; never global assignment state.';

COMMIT;

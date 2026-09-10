-- D15 R02-2A: unified organization signers and authoritative full re-sign cycles.
BEGIN;

CREATE TABLE public.training_organization_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK(role_code='organization_responsible'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMPTZ,
  granted_by UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK((active AND revoked_at IS NULL) OR NOT active)
);
CREATE UNIQUE INDEX training_organization_roles_active_idx
  ON public.training_organization_roles(subject_id,organization_unit_id,role_code) WHERE active;

CREATE TABLE public.training_organization_role_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_role_id UUID NOT NULL REFERENCES public.training_organization_roles(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN('grant','revoke')),
  operator_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  before_state JSONB,
  after_state JSONB NOT NULL CHECK(jsonb_typeof(after_state)='object'),
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_organization_role_audit_request_idx
  ON public.training_organization_role_audit_logs(organization_role_id,request_id) WHERE request_id IS NOT NULL;

CREATE TABLE public.training_signature_cycles (
  id UUID PRIMARY KEY,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employee_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL,
  admission_id UUID REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  requirement_snapshot_id UUID NOT NULL REFERENCES public.training_requirement_snapshots(id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL REFERENCES public.training_signature_policies(id) ON DELETE RESTRICT,
  policy_version_id UUID NOT NULL REFERENCES public.training_signature_policy_versions(id) ON DELETE RESTRICT,
  previous_cycle_id UUID REFERENCES public.training_signature_cycles(id) ON DELETE RESTRICT,
  source_event_type TEXT NOT NULL CHECK(source_event_type IN(
    'initial_requirement','requirement_snapshot','training_record','exam_attempt','admission','legacy_requirement_cycle')),
  source_reference TEXT NOT NULL CHECK(btrim(source_reference)<>''),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','superseded','invalidated')),
  superseded_by_cycle_id UUID REFERENCES public.training_signature_cycles(id) ON DELETE RESTRICT,
  superseded_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  UNIQUE(employee_id,source_event_type,source_reference)
);
CREATE UNIQUE INDEX training_signature_cycle_successor_idx
  ON public.training_signature_cycles(previous_cycle_id) WHERE previous_cycle_id IS NOT NULL;

CREATE TABLE public.training_signature_cycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id UUID NOT NULL REFERENCES public.training_signature_cycles(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN('created','superseded','invalidated')),
  previous_cycle_id UUID REFERENCES public.training_signature_cycles(id) ON DELETE RESTRICT,
  actor_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  source_event_type TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_signature_cycle_event_request_idx
  ON public.training_signature_cycle_events(cycle_id,request_id) WHERE request_id IS NOT NULL;

INSERT INTO public.training_signature_cycles(id,employee_id,employee_subject_id,employment_relation_id,admission_id,
  requirement_snapshot_id,policy_id,policy_version_id,source_event_type,source_reference,created_by,created_at,reason)
SELECT r.requirement_cycle_id,min(r.employee_id::text)::uuid,min(r.employee_subject_id::text)::uuid,
  min(r.employment_relation_id::text)::uuid,min(r.admission_id::text)::uuid,min(r.requirement_snapshot_id::text)::uuid,
  min(r.policy_id::text)::uuid,min(r.policy_version_id::text)::uuid,'legacy_requirement_cycle',r.requirement_cycle_id::text,
  min(e.actor_subject_id::text)::uuid,min(r.created_at),'v104 existing requirement cycle'
FROM public.training_signature_requirements r
LEFT JOIN public.training_signature_requirement_events e ON e.requirement_id=r.id AND e.event_type='created'
GROUP BY r.requirement_cycle_id ON CONFLICT(id) DO NOTHING;

CREATE FUNCTION public.training_signature_cycle_immutable_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION '[D15:signature_history_immutable] 签字周期历史不可删除'; END IF;
  IF current_setting('app.training_signature_cycle_mutation',TRUE)<>'on' THEN
    RAISE EXCEPTION '[D15:signature_history_immutable] 签字周期只能经权威状态机变更';
  END IF;
  IF OLD.employee_id<>NEW.employee_id OR OLD.employment_relation_id<>NEW.employment_relation_id
    OR OLD.requirement_snapshot_id<>NEW.requirement_snapshot_id OR OLD.policy_version_id<>NEW.policy_version_id
    OR OLD.source_event_type<>NEW.source_event_type OR OLD.source_reference<>NEW.source_reference THEN
    RAISE EXCEPTION '[D15:signature_history_immutable] 签字周期权威事实不可改写';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_signature_cycle_immutable BEFORE UPDATE OR DELETE ON public.training_signature_cycles
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_cycle_immutable_guard();
CREATE TRIGGER trg_training_signature_cycle_event_immutable BEFORE UPDATE OR DELETE ON public.training_signature_cycle_events
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();
CREATE TRIGGER trg_training_organization_role_audit_immutable BEFORE UPDATE OR DELETE ON public.training_organization_role_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();

CREATE FUNCTION public.training_organization_signer_authority(
  p_subject_id UUID,p_organization_unit_id UUID,p_as_of TIMESTAMPTZ DEFAULT clock_timestamp()
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    EXISTS(SELECT 1 FROM public.training_organization_roles r
      WHERE r.subject_id=p_subject_id AND r.organization_unit_id=p_organization_unit_id
        AND r.role_code='organization_responsible' AND r.active
        AND r.effective_from<=p_as_of AND (r.effective_to IS NULL OR r.effective_to>p_as_of))
    OR EXISTS(SELECT 1 FROM public.account_subjects s
      JOIN public.profiles p ON p.id=s.auth_user_id
      JOIN public.organization_units u ON u.id=p.department_id
      WHERE s.id=p_subject_id AND u.id=p_organization_unit_id AND u.organization_type='operating_entity'
        AND p.role='admin' AND p.admin_level='dept'),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_organization_role_grant(
  p_subject_id UUID,p_organization_unit_id UUID,p_role_code TEXT,p_effective_from TIMESTAMPTZ,
  p_effective_to TIMESTAMPTZ,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_role public.training_organization_roles; v_operator UUID;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  v_operator:=public.training_current_account_subject_id();
  IF p_role_code<>'organization_responsible' OR NULLIF(btrim(p_reason),'') IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.organization_units WHERE id=p_organization_unit_id AND active)
    OR NOT EXISTS(SELECT 1 FROM public.account_subjects s JOIN public.account_lifecycle l ON l.subject_id=s.id WHERE s.id=p_subject_id AND l.status='active') THEN
    RAISE EXCEPTION '[D15:signature_policy_invalid] 组织角色授予参数无效';
  END IF;
  SELECT * INTO v_role FROM public.training_organization_roles
  WHERE subject_id=p_subject_id AND organization_unit_id=p_organization_unit_id AND role_code=p_role_code AND active FOR UPDATE;
  IF FOUND THEN RETURN to_jsonb(v_role)||jsonb_build_object('idempotent',TRUE); END IF;
  INSERT INTO public.training_organization_roles(subject_id,organization_unit_id,role_code,effective_from,effective_to,granted_by,reason)
  VALUES(p_subject_id,p_organization_unit_id,p_role_code,COALESCE(p_effective_from,clock_timestamp()),p_effective_to,v_operator,btrim(p_reason)) RETURNING * INTO v_role;
  INSERT INTO public.training_organization_role_audit_logs(organization_role_id,action,operator_subject_id,after_state,reason,request_id)
  VALUES(v_role.id,'grant',v_operator,to_jsonb(v_role),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v_role)||jsonb_build_object('idempotent',FALSE);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_role FROM public.training_organization_roles
  WHERE subject_id=p_subject_id AND organization_unit_id=p_organization_unit_id AND role_code=p_role_code AND active;
  IF FOUND THEN RETURN to_jsonb(v_role)||jsonb_build_object('idempotent',TRUE); END IF;
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_organization_role_revoke(
  p_organization_role_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_role public.training_organization_roles; v_before JSONB; v_operator UUID;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 撤销原因必填'; END IF;
  v_operator:=public.training_current_account_subject_id();
  SELECT * INTO v_role FROM public.training_organization_roles WHERE id=p_organization_role_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 组织角色不存在'; END IF;
  IF NOT v_role.active THEN RETURN to_jsonb(v_role)||jsonb_build_object('idempotent',TRUE); END IF;
  v_before:=to_jsonb(v_role);
  UPDATE public.training_organization_roles SET active=FALSE,effective_to=clock_timestamp(),revoked_by=v_operator,revoked_at=clock_timestamp()
  WHERE id=v_role.id RETURNING * INTO v_role;
  INSERT INTO public.training_organization_role_audit_logs(organization_role_id,action,operator_subject_id,before_state,after_state,reason,request_id)
  VALUES(v_role.id,'revoke',v_operator,v_before,to_jsonb(v_role),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v_role)||jsonb_build_object('idempotent',FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_signature_can_read_requirement_internal(
  p_requirement public.training_signature_requirements
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_requirement.employee_id=public.training_my_employee_id()
    OR public.training_scheme_is_company_admin()
    OR (p_requirement.organization_unit_id IS NOT NULL AND public.training_organization_signer_authority(
      public.training_current_account_subject_id(),p_requirement.organization_unit_id,clock_timestamp()))
    OR (p_requirement.project_id IS NOT NULL AND public.site_project_can_read_management_data(p_requirement.project_id))
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_signature_authority_internal(
  p_requirement public.training_signature_requirements
) RETURNS JSONB AS $$
DECLARE v_subject UUID; v_role TEXT; v_scope JSONB; v_roles JSONB;
BEGIN
  IF NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[D15:signature_forbidden] 当前账号不可签署' USING ERRCODE='42501'; END IF;
  v_subject:=public.training_current_account_subject_id(); v_roles:=public.training_account_roles(auth.uid());
  IF p_requirement.signer_roles_snapshot @> ARRAY['employee']::TEXT[] AND p_requirement.employee_id=public.training_my_employee_id() THEN
    v_role:='employee'; v_scope:=jsonb_build_object('scope','self','employee_id',p_requirement.employee_id);
  ELSIF p_requirement.signer_roles_snapshot @> ARRAY['organization_responsible']::TEXT[]
    AND public.training_organization_signer_authority(v_subject,p_requirement.organization_unit_id,clock_timestamp()) THEN
    v_role:='organization_responsible'; v_scope:=jsonb_build_object('scope','organization','scope_id',p_requirement.organization_unit_id);
  ELSIF p_requirement.project_id IS NOT NULL AND p_requirement.signer_roles_snapshot && ARRAY['project_manager','safety_officer']::TEXT[] THEN
    SELECT r->>'role',jsonb_build_object('scope','project','scope_id',p_requirement.project_id) INTO v_role,v_scope
    FROM jsonb_array_elements(v_roles) r WHERE r->>'scope'='project' AND r->>'scope_id'=p_requirement.project_id::text
      AND (r->>'role')=ANY(p_requirement.signer_roles_snapshot) ORDER BY r->>'role' LIMIT 1;
  END IF;
  IF v_role IS NULL THEN RAISE EXCEPTION '[D15:signature_forbidden] 当前人员没有该签字节点的有效角色范围' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('subject_id',v_subject,'role',v_role,'scope',v_scope,'roles',v_roles);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_cycle_register_trigger() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.training_signature_cycles(id,employee_id,employee_subject_id,employment_relation_id,admission_id,
    requirement_snapshot_id,policy_id,policy_version_id,source_event_type,source_reference,created_by,reason)
  VALUES(NEW.requirement_cycle_id,NEW.employee_id,NEW.employee_subject_id,NEW.employment_relation_id,NEW.admission_id,
    NEW.requirement_snapshot_id,NEW.policy_id,NEW.policy_version_id,'initial_requirement',
    NEW.requirement_snapshot_id::text||':'||COALESCE(NEW.admission_id::text,'none')||':'||NEW.policy_version_id::text,
    public.training_current_account_subject_id(),'initial policy resolution') ON CONFLICT(id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
CREATE TRIGGER trg_training_signature_cycle_register BEFORE INSERT ON public.training_signature_requirements
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_cycle_register_trigger();

CREATE FUNCTION public.training_signature_create_resign_cycle_internal(
  p_snapshot_id UUID,p_admission_id UUID,p_previous_cycle_id UUID,p_source_event_type TEXT,
  p_source_reference TEXT,p_reason TEXT,p_request_id TEXT
) RETURNS JSONB AS $$
DECLARE v_snapshot public.training_requirement_snapshots; v_admission public.training_admissions;
  v_policy public.training_signature_policies; v_version public.training_signature_policy_versions;
  v_node public.training_signature_policy_nodes; v_item UUID; v_snapshot_project UUID; v_project_count INTEGER;
  v_project UUID; v_cycle UUID:=gen_random_uuid(); v_count INTEGER:=0; v_req UUID; v_actor UUID:=public.training_current_account_subject_id();
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 权威 Requirement Snapshot 不存在'; END IF;
  SELECT count(DISTINCT site_project_id),min(site_project_id::text)::uuid INTO v_project_count,v_snapshot_project
  FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_type='actual_project';
  IF v_project_count>1 THEN RAISE EXCEPTION '[D15:signature_project_mismatch] Snapshot 项目来源不唯一'; END IF;
  IF p_admission_id IS NOT NULL THEN
    SELECT * INTO v_admission FROM public.training_admissions WHERE id=p_admission_id AND employee_id=v_snapshot.employee_id;
    IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_project_mismatch] admission 与人员不匹配'; END IF;
  END IF;
  IF v_snapshot_project IS NOT NULL AND (v_admission.id IS NULL OR v_admission.project_id<>v_snapshot_project) THEN
    RAISE EXCEPTION '[D15:signature_project_mismatch] admission 与 Snapshot 权威项目不匹配';
  END IF;
  SELECT * INTO v_policy FROM public.training_signature_policies WHERE scheme_id=v_snapshot.scheme_id;
  IF NOT FOUND THEN SELECT * INTO v_policy FROM public.training_signature_policies WHERE scheme_id IS NULL; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 新周期没有适用签字策略'; END IF;
  SELECT * INTO v_version FROM public.training_signature_policy_versions WHERE policy_id=v_policy.id AND status IN('published','superseded')
    AND effective_from<=v_snapshot.effective_as_of AND (effective_to IS NULL OR effective_to>=v_snapshot.effective_as_of)
    ORDER BY effective_from DESC,version_no DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 新周期没有唯一有效签字策略版本'; END IF;

  INSERT INTO public.training_signature_cycles(id,employee_id,employee_subject_id,employment_relation_id,admission_id,requirement_snapshot_id,
    policy_id,policy_version_id,previous_cycle_id,source_event_type,source_reference,created_by,reason)
  VALUES(v_cycle,v_snapshot.employee_id,v_snapshot.subject_id,v_snapshot.employment_relation_id,p_admission_id,v_snapshot.id,
    v_policy.id,v_version.id,p_previous_cycle_id,p_source_event_type,p_source_reference,v_actor,btrim(p_reason));
  FOR v_node IN SELECT * FROM public.training_signature_policy_nodes WHERE policy_version_id=v_version.id ORDER BY sequence_no LOOP
    v_item:=NULL; v_project:=NULL;
    IF v_node.stage_order IS NOT NULL THEN
      SELECT id INTO v_item FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_order=v_node.stage_order
        AND (v_node.applies_stage_type IS NULL OR stage_type=v_node.applies_stage_type);
      IF v_item IS NULL THEN CONTINUE; END IF;
    ELSIF v_node.applies_stage_type IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_type=v_node.applies_stage_type) THEN CONTINUE;
    END IF;
    IF v_node.node_type='project_manager_or_safety_confirmation' THEN
      IF v_snapshot_project IS NULL THEN RAISE EXCEPTION '[D15:signature_project_mismatch] 项目签字节点缺少 Snapshot 权威项目'; END IF;
      v_project:=v_snapshot_project;
    END IF;
    INSERT INTO public.training_signature_requirements(requirement_cycle_id,employee_id,employee_subject_id,employment_relation_id,admission_id,project_id,organization_unit_id,
      requirement_snapshot_id,requirement_snapshot_item_id,policy_id,policy_version_id,policy_node_id,node_code,node_type,stage_order,required,sequence_no,signer_mode,signer_roles_snapshot,requires_exam,due_at)
    VALUES(v_cycle,v_snapshot.employee_id,v_snapshot.subject_id,v_snapshot.employment_relation_id,p_admission_id,v_project,v_snapshot.organization_unit_id,
      v_snapshot.id,v_item,v_policy.id,v_version.id,v_node.id,v_node.node_code,v_node.node_type,v_node.stage_order,v_node.required,v_node.sequence_no,v_node.signer_mode,v_node.signer_roles,v_node.requires_exam,
      CASE WHEN v_node.due_days IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>v_node.due_days) END) RETURNING id INTO v_req;
    v_count:=v_count+1;
    INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_req,'created',v_actor,'authoritative_resign_cycle',jsonb_build_object('source_event_type',p_source_event_type,'source_reference',p_source_reference,'request_id',p_request_id));
  END LOOP;
  INSERT INTO public.training_signature_cycle_events(cycle_id,event_type,previous_cycle_id,actor_subject_id,source_event_type,source_reference,reason,request_id)
  VALUES(v_cycle,'created',p_previous_cycle_id,v_actor,p_source_event_type,p_source_reference,btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN jsonb_build_object('status','created','idempotent',FALSE,'previous_cycle_id',p_previous_cycle_id,'new_cycle_id',v_cycle,
    'requirement_snapshot_id',v_snapshot.id,'policy_version_id',v_version.id,'requirement_count',v_count,
    'requirements',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sequence_no) FROM public.training_signature_requirements r WHERE r.requirement_cycle_id=v_cycle));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_supersede_cycle(
  p_previous_cycle_id UUID,p_source_event_type TEXT,p_source_reference UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_old public.training_signature_cycles; v_existing public.training_signature_cycles;
  v_snapshot UUID; v_admission UUID; v_result JSONB; v_actor UUID;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  IF p_source_event_type NOT IN('requirement_snapshot','training_record','exam_attempt','admission')
    OR p_source_reference IS NULL OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION '[D15:signature_source_event_invalid] 重签来源事件、引用和原因无效';
  END IF;
  SELECT * INTO v_old FROM public.training_signature_cycles WHERE id=p_previous_cycle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 原签字周期不存在'; END IF;
  SELECT * INTO v_existing FROM public.training_signature_cycles
  WHERE employee_id=v_old.employee_id AND source_event_type=p_source_event_type AND source_reference=p_source_reference::text;
  IF FOUND THEN RETURN jsonb_build_object('status','reused','idempotent',TRUE,'previous_cycle_id',v_existing.previous_cycle_id,
    'new_cycle_id',v_existing.id,'requirement_snapshot_id',v_existing.requirement_snapshot_id,'policy_version_id',v_existing.policy_version_id,
    'requirement_count',(SELECT count(*) FROM public.training_signature_requirements WHERE requirement_cycle_id=v_existing.id)); END IF;
  IF v_old.status<>'active' THEN RAISE EXCEPTION '[D15:signature_superseded] 原签字周期已失效'; END IF;

  IF p_source_event_type='requirement_snapshot' THEN
    SELECT id INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_source_reference AND employee_id=v_old.employee_id;
  ELSIF p_source_event_type='training_record' THEN
    SELECT requirement_snapshot_id INTO v_snapshot FROM public.training_three_level_records
    WHERE id=p_source_reference AND employee_id=v_old.employee_id AND requirement_snapshot_id IS NOT NULL;
  ELSIF p_source_event_type='exam_attempt' THEN
    SELECT admission_id INTO v_admission FROM public.exam_attempts
    WHERE id=p_source_reference AND employee_id=v_old.employee_id AND status='submitted';
  ELSE
    SELECT id INTO v_admission FROM public.training_admissions WHERE id=p_source_reference AND employee_id=v_old.employee_id;
  END IF;
  IF v_snapshot IS NULL AND v_admission IS NOT NULL THEN
    SELECT s.id INTO v_snapshot FROM public.training_requirement_snapshots s
    WHERE s.employee_id=v_old.employee_id AND s.employment_relation_id=v_old.employment_relation_id
    ORDER BY s.effective_as_of DESC,s.generated_at DESC LIMIT 1;
  END IF;
  IF v_snapshot IS NULL THEN RAISE EXCEPTION '[D15:signature_source_event_invalid] 来源事件没有匹配的权威业务事实'; END IF;
  IF v_admission IS NULL THEN
    SELECT a.id INTO v_admission FROM public.training_requirement_snapshot_items i
    JOIN public.training_requirement_snapshots s ON s.id=i.snapshot_id
    JOIN public.training_admissions a ON a.employee_id=s.employee_id AND a.project_id=i.site_project_id
    WHERE i.snapshot_id=v_snapshot AND i.stage_type='actual_project' ORDER BY a.created_at DESC LIMIT 1;
    v_admission:=COALESCE(v_admission,v_old.admission_id);
  END IF;
  v_result:=public.training_signature_create_resign_cycle_internal(v_snapshot,v_admission,v_old.id,p_source_event_type,p_source_reference::text,p_reason,p_request_id);
  v_actor:=public.training_current_account_subject_id();
  PERFORM set_config('app.training_signature_cycle_mutation','on',TRUE);
  UPDATE public.training_signature_cycles SET status='superseded',superseded_by_cycle_id=(v_result->>'new_cycle_id')::uuid,superseded_at=clock_timestamp()
  WHERE id=v_old.id;
  PERFORM set_config('app.training_signature_mutation','on',TRUE);
  UPDATE public.training_signature_requirements old SET status='superseded',resolved_at=clock_timestamp(),status_reason=btrim(p_reason),
    superseded_by_requirement_id=(SELECT n.id FROM public.training_signature_requirements n
      WHERE n.requirement_cycle_id=(v_result->>'new_cycle_id')::uuid AND n.node_code=old.node_code LIMIT 1)
  WHERE old.requirement_cycle_id=v_old.id AND old.status<>'superseded';
  INSERT INTO public.training_signature_cycle_events(cycle_id,event_type,previous_cycle_id,actor_subject_id,source_event_type,source_reference,reason,request_id)
  VALUES(v_old.id,'superseded',NULL,v_actor,p_source_event_type,p_source_reference::text,btrim(p_reason),NULLIF(btrim(p_request_id),'')||'-old');
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

ALTER TABLE public.training_organization_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_organization_role_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_cycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_organization_roles,public.training_organization_role_audit_logs,
  public.training_signature_cycles,public.training_signature_cycle_events FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION public.training_organization_signer_authority(UUID,UUID,TIMESTAMPTZ),
  public.training_signature_cycle_register_trigger(),
  public.training_signature_create_resign_cycle_internal(UUID,UUID,UUID,TEXT,TEXT,TEXT,TEXT),
  public.training_signature_cycle_immutable_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.training_organization_role_grant(UUID,UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT),
  public.training_organization_role_revoke(UUID,TEXT,TEXT),
  public.training_signature_supersede_cycle(UUID,TEXT,UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_organization_role_grant(UUID,UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT),
  public.training_organization_role_revoke(UUID,TEXT,TEXT),
  public.training_signature_supersede_cycle(UUID,TEXT,UUID,TEXT,TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.training_signature_supersede(UUID,TEXT,TEXT) FROM authenticated;

COMMENT ON TABLE public.training_organization_roles IS 'Unified stable-subject organization_unit scoped signer authority; legacy operating-entity admins are resolved by the same helper.';
COMMENT ON FUNCTION public.training_signature_supersede_cycle(UUID,TEXT,UUID,TEXT,TEXT)
IS 'Idempotently supersede one complete cycle from a validated authoritative source event and rebuild all nodes from the target Snapshot and effective policy.';

COMMIT;

-- D15: configurable electronic handwritten-signature evidence chain.
-- The signature is an in-system business acknowledgement, not a claim of a
-- qualified/advanced electronic signature under any particular law.
BEGIN;

CREATE TABLE public.training_signature_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_code TEXT NOT NULL UNIQUE CHECK(btrim(policy_code)<>''),
  display_name TEXT NOT NULL CHECK(btrim(display_name)<>''),
  description TEXT,
  scheme_id UUID REFERENCES public.three_level_training_schemes(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_signature_policy_scheme_idx ON public.training_signature_policies(scheme_id) WHERE scheme_id IS NOT NULL;
CREATE UNIQUE INDEX training_signature_policy_company_default_idx ON public.training_signature_policies((scheme_id IS NULL)) WHERE scheme_id IS NULL;

CREATE TABLE public.training_signature_policy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES public.training_signature_policies(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','superseded','retired')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  change_summary TEXT NOT NULL CHECK(btrim(change_summary)<>''),
  created_by UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  published_by UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  retired_by UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(policy_id,version_no),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK((status='draft' AND published_at IS NULL) OR status<>'draft')
);

CREATE TABLE public.training_signature_policy_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version_id UUID NOT NULL REFERENCES public.training_signature_policy_versions(id) ON DELETE RESTRICT,
  node_code TEXT NOT NULL CHECK(btrim(node_code)<>''),
  node_type TEXT NOT NULL CHECK(node_type IN(
    'employee_stage_acknowledgement','employee_final_acknowledgement',
    'organization_responsible_confirmation','project_manager_or_safety_confirmation')),
  stage_order SMALLINT CHECK(stage_order BETWEEN 1 AND 3),
  applies_stage_type TEXT CHECK(applies_stage_type IS NULL OR applies_stage_type IN(
    'company','organization','department_position','logistics_position','entity_position','basic_project','actual_project')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  sequence_no SMALLINT NOT NULL CHECK(sequence_no>0),
  signer_mode TEXT NOT NULL DEFAULT 'SINGLE' CHECK(signer_mode IN('SINGLE','ANY_OF')),
  signer_roles TEXT[] NOT NULL,
  requires_exam BOOLEAN NOT NULL DEFAULT FALSE,
  due_days INTEGER CHECK(due_days IS NULL OR due_days BETWEEN 1 AND 3650),
  UNIQUE(policy_version_id,node_code),
  UNIQUE(policy_version_id,sequence_no),
  CHECK(cardinality(signer_roles)>0),
  CHECK((node_type='employee_stage_acknowledgement' AND stage_order IS NOT NULL AND signer_roles=ARRAY['employee']::TEXT[] AND signer_mode='SINGLE')
    OR (node_type='employee_final_acknowledgement' AND stage_order IS NULL AND signer_roles=ARRAY['employee']::TEXT[] AND signer_mode='SINGLE')
    OR (node_type='organization_responsible_confirmation' AND stage_order IS NULL AND signer_roles=ARRAY['organization_responsible']::TEXT[] AND signer_mode='SINGLE')
    OR (node_type='project_manager_or_safety_confirmation' AND stage_order IS NULL AND signer_mode='ANY_OF'
      AND signer_roles <@ ARRAY['project_manager','safety_officer']::TEXT[]
      AND signer_roles @> ARRAY['project_manager']::TEXT[] AND signer_roles @> ARRAY['safety_officer']::TEXT[]))
);

CREATE TABLE public.training_signature_policy_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES public.training_signature_policies(id) ON DELETE RESTRICT,
  policy_version_id UUID REFERENCES public.training_signature_policy_versions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  operator_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  operator_roles_snapshot JSONB NOT NULL CHECK(jsonb_typeof(operator_roles_snapshot)='array'),
  before_state JSONB,
  after_state JSONB,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_signature_policy_audit_request_idx
  ON public.training_signature_policy_audit_logs(policy_id,request_id) WHERE request_id IS NOT NULL;

CREATE TABLE public.training_signature_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_cycle_id UUID NOT NULL DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employee_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL,
  admission_id UUID REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  requirement_snapshot_id UUID NOT NULL REFERENCES public.training_requirement_snapshots(id) ON DELETE RESTRICT,
  requirement_snapshot_item_id UUID REFERENCES public.training_requirement_snapshot_items(id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL REFERENCES public.training_signature_policies(id) ON DELETE RESTRICT,
  policy_version_id UUID NOT NULL REFERENCES public.training_signature_policy_versions(id) ON DELETE RESTRICT,
  policy_node_id UUID NOT NULL REFERENCES public.training_signature_policy_nodes(id) ON DELETE RESTRICT,
  node_code TEXT NOT NULL,
  node_type TEXT NOT NULL,
  stage_order SMALLINT,
  required BOOLEAN NOT NULL,
  sequence_no SMALLINT NOT NULL,
  signer_mode TEXT NOT NULL CHECK(signer_mode IN('SINGLE','ANY_OF')),
  signer_roles_snapshot TEXT[] NOT NULL,
  requires_exam BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','signed','superseded','invalidated')),
  due_at TIMESTAMPTZ,
  superseded_by_requirement_id UUID REFERENCES public.training_signature_requirements(id) ON DELETE RESTRICT,
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(requirement_snapshot_id,policy_node_id,requirement_cycle_id),
  CHECK(cardinality(signer_roles_snapshot)>0)
);
CREATE INDEX training_signature_requirements_person_idx ON public.training_signature_requirements(employee_id,status,sequence_no);
CREATE INDEX training_signature_requirements_project_idx ON public.training_signature_requirements(project_id,status);

CREATE TABLE public.training_signature_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_signature_requirements(id) ON DELETE RESTRICT,
  signer_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  signer_authority_snapshot JSONB NOT NULL CHECK(jsonb_typeof(signer_authority_snapshot)='object'),
  nonce_hash TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_snapshot JSONB NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
  storage_bucket TEXT NOT NULL DEFAULT 'certificates' CHECK(storage_bucket='certificates'),
  storage_path TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX training_signature_challenges_requirement_idx ON public.training_signature_challenges(requirement_id,created_at DESC);

CREATE TABLE public.training_signature_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL UNIQUE REFERENCES public.training_signature_requirements(id) ON DELETE RESTRICT,
  challenge_id UUID NOT NULL UNIQUE REFERENCES public.training_signature_challenges(id) ON DELETE RESTRICT,
  signer_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  signer_auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  signer_role_snapshot TEXT NOT NULL,
  signer_scope_snapshot JSONB NOT NULL CHECK(jsonb_typeof(signer_scope_snapshot)='object'),
  signer_display_snapshot JSONB NOT NULL CHECK(jsonb_typeof(signer_display_snapshot)='object'),
  storage_bucket TEXT NOT NULL CHECK(storage_bucket='certificates'),
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN('image/png','image/jpeg')),
  file_size_bytes BIGINT NOT NULL CHECK(file_size_bytes BETWEEN 1 AND 2097152),
  image_width INTEGER NOT NULL CHECK(image_width BETWEEN 64 AND 4096),
  image_height INTEGER NOT NULL CHECK(image_height BETWEEN 32 AND 4096),
  evidence_digest TEXT NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_snapshot JSONB NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
  signed_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL,
  device_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(device_snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(signer_subject_id,idempotency_key)
);

CREATE TABLE public.training_signature_requirement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_signature_requirements(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN('created','prepared','signed','superseded','invalidated')),
  actor_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  reason TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX training_signature_requirement_events_idx ON public.training_signature_requirement_events(requirement_id,occurred_at);

CREATE FUNCTION public.training_signature_history_immutable_guard() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION '[D15:signature_history_immutable] 已签字证据和审计历史不可修改或删除'; END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_signature_result_immutable BEFORE UPDATE OR DELETE ON public.training_signature_results
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();
CREATE TRIGGER trg_training_signature_event_immutable BEFORE UPDATE OR DELETE ON public.training_signature_requirement_events
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();
CREATE TRIGGER trg_training_signature_policy_audit_immutable BEFORE UPDATE OR DELETE ON public.training_signature_policy_audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();

CREATE FUNCTION public.training_signature_requirement_mutation_guard() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.training_signature_mutation',TRUE)<>'on' THEN
    RAISE EXCEPTION '[D15:signature_history_immutable] 签字 requirement 只能经权威状态机变更';
  END IF;
  IF OLD.employee_id<>NEW.employee_id OR OLD.employment_relation_id<>NEW.employment_relation_id
    OR OLD.requirement_snapshot_id<>NEW.requirement_snapshot_id OR OLD.policy_version_id<>NEW.policy_version_id
    OR OLD.policy_node_id<>NEW.policy_node_id OR OLD.node_type<>NEW.node_type
    OR OLD.signer_roles_snapshot<>NEW.signer_roles_snapshot THEN
    RAISE EXCEPTION '[D15:signature_history_immutable] 签字 requirement 冻结事实不可改写';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_signature_requirement_mutation BEFORE UPDATE ON public.training_signature_requirements
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_requirement_mutation_guard();
CREATE TRIGGER trg_training_signature_requirement_delete BEFORE DELETE ON public.training_signature_requirements
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_history_immutable_guard();

CREATE FUNCTION public.training_signature_policy_immutable_guard() RETURNS TRIGGER AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_TABLE_NAME='training_signature_policy_nodes' THEN
    SELECT status INTO v_status FROM public.training_signature_policy_versions WHERE id=COALESCE(NEW.policy_version_id,OLD.policy_version_id);
    IF v_status<>'draft' THEN RAISE EXCEPTION '[D15:signature_policy_immutable] 已发布签字策略不可原地修改'; END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF OLD.status<>'draft' AND current_setting('app.training_signature_policy_lifecycle',TRUE)<>'on' THEN
    RAISE EXCEPTION '[D15:signature_policy_immutable] 已发布签字策略不可原地修改';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_signature_policy_version_immutable BEFORE UPDATE OR DELETE ON public.training_signature_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_policy_immutable_guard();
CREATE TRIGGER trg_training_signature_policy_node_immutable BEFORE UPDATE OR DELETE ON public.training_signature_policy_nodes
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_policy_immutable_guard();

CREATE FUNCTION public.training_signature_require_company_admin() RETURNS VOID AS $$
BEGIN
  IF NOT public.training_scheme_is_company_admin() THEN
    RAISE EXCEPTION '[D15:signature_forbidden] 仅有效公司级管理员可管理签字策略' USING ERRCODE='42501';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_list() RETURNS JSONB AS $$
BEGIN
  PERFORM public.training_signature_require_company_admin();
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',p.id,'policy_code',p.policy_code,'display_name',p.display_name,'description',p.description,'scheme_id',p.scheme_id,
    'versions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',v.id,'version_no',v.version_no,'status',v.status,
      'effective_from',v.effective_from,'effective_to',v.effective_to,'change_summary',v.change_summary,
      'nodes',(SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.sequence_no),'[]'::jsonb) FROM public.training_signature_policy_nodes n WHERE n.policy_version_id=v.id)) ORDER BY v.version_no DESC),'[]'::jsonb)
      FROM public.training_signature_policy_versions v WHERE v.policy_id=p.id)) ORDER BY p.policy_code) FROM public.training_signature_policies p),'[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_create(
  p_policy_code TEXT,p_display_name TEXT,p_scheme_id UUID,p_effective_from DATE,p_description TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_subject UUID; v_policy public.training_signature_policies; v_version public.training_signature_policy_versions;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  IF NULLIF(btrim(p_policy_code),'') IS NULL OR NULLIF(btrim(p_display_name),'') IS NULL OR p_effective_from IS NULL
    OR NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 策略编码、名称、生效日期和原因必填'; END IF;
  v_subject:=public.training_current_account_subject_id();
  INSERT INTO public.training_signature_policies(policy_code,display_name,description,scheme_id,created_by)
    VALUES(btrim(p_policy_code),btrim(p_display_name),NULLIF(btrim(p_description),''),p_scheme_id,v_subject) RETURNING * INTO v_policy;
  INSERT INTO public.training_signature_policy_versions(policy_id,version_no,effective_from,change_summary,created_by)
    VALUES(v_policy.id,1,p_effective_from,btrim(p_reason),v_subject) RETURNING * INTO v_version;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,after_state,reason,request_id)
    VALUES(v_policy.id,v_version.id,'create',v_subject,public.training_account_roles(auth.uid()),to_jsonb(v_version),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN jsonb_build_object('policy_id',v_policy.id,'policy_version_id',v_version.id,'version_no',1,'status','draft');
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 策略编码或适用方案已存在';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_save_draft(
  p_policy_version_id UUID,p_nodes JSONB,p_effective_from DATE,p_change_summary TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_version public.training_signature_policy_versions; v_node JSONB; v_before JSONB;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  SELECT * INTO v_version FROM public.training_signature_policy_versions WHERE id=p_policy_version_id FOR UPDATE;
  IF NOT FOUND OR v_version.status<>'draft' THEN RAISE EXCEPTION '[D15:signature_policy_immutable] 仅草稿策略可编辑'; END IF;
  IF jsonb_typeof(p_nodes)<>'array' OR jsonb_array_length(p_nodes)=0 OR p_effective_from IS NULL
    OR NULLIF(btrim(p_change_summary),'') IS NULL OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION '[D15:signature_policy_invalid] 策略节点、生效日期、摘要和原因无效';
  END IF;
  SELECT jsonb_build_object('version',to_jsonb(v_version),'nodes',COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.sequence_no),'[]'::jsonb)) INTO v_before
    FROM public.training_signature_policy_nodes n WHERE n.policy_version_id=v_version.id GROUP BY v_version.id,v_version.policy_id,v_version.version_no,v_version.status,v_version.effective_from,v_version.effective_to,v_version.change_summary,v_version.created_by,v_version.published_by,v_version.published_at,v_version.retired_by,v_version.retired_at,v_version.created_at;
  DELETE FROM public.training_signature_policy_nodes WHERE policy_version_id=v_version.id;
  FOR v_node IN SELECT value FROM jsonb_array_elements(p_nodes) LOOP
    INSERT INTO public.training_signature_policy_nodes(policy_version_id,node_code,node_type,stage_order,applies_stage_type,required,sequence_no,signer_mode,signer_roles,requires_exam,due_days)
    VALUES(v_version.id,btrim(v_node->>'node_code'),v_node->>'node_type',NULLIF(v_node->>'stage_order','')::smallint,NULLIF(v_node->>'applies_stage_type',''),
      COALESCE((v_node->>'required')::boolean,TRUE),(v_node->>'sequence_no')::smallint,COALESCE(NULLIF(v_node->>'signer_mode',''),'SINGLE'),
      ARRAY(SELECT jsonb_array_elements_text(v_node->'signer_roles')),COALESCE((v_node->>'requires_exam')::boolean,FALSE),NULLIF(v_node->>'due_days','')::integer);
  END LOOP;
  UPDATE public.training_signature_policy_versions SET effective_from=p_effective_from,change_summary=btrim(p_change_summary) WHERE id=v_version.id RETURNING * INTO v_version;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,before_state,after_state,reason,request_id)
    VALUES(v_version.policy_id,v_version.id,'save_draft',public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),v_before,
      jsonb_build_object('version',to_jsonb(v_version),'nodes',p_nodes),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN jsonb_build_object('policy_version_id',v_version.id,'status','draft','node_count',jsonb_array_length(p_nodes));
EXCEPTION WHEN check_violation OR invalid_text_representation OR not_null_violation OR unique_violation THEN
  RAISE EXCEPTION '[D15:signature_policy_invalid] 签字节点配置不符合受控规则';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_publish(p_policy_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.training_signature_policy_versions; v_latest DATE; v_count INTEGER;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  SELECT * INTO v FROM public.training_signature_policy_versions WHERE id=p_policy_version_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'draft' THEN RAISE EXCEPTION '[D15:signature_policy_immutable] 仅草稿版本可发布'; END IF;
  SELECT count(*) INTO v_count FROM public.training_signature_policy_nodes WHERE policy_version_id=v.id;
  IF v_count=0 OR NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 发布前必须配置节点并填写原因'; END IF;
  SELECT max(effective_from) INTO v_latest FROM public.training_signature_policy_versions WHERE policy_id=v.policy_id AND status IN('published','superseded','retired');
  IF v_latest IS NOT NULL AND v.effective_from<=v_latest THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 新版本生效日期必须晚于历史已发布版本'; END IF;
  PERFORM set_config('app.training_signature_policy_lifecycle','on',TRUE);
  UPDATE public.training_signature_policy_versions SET status='superseded',effective_to=v.effective_from-1
    WHERE policy_id=v.policy_id AND status='published';
  UPDATE public.training_signature_policy_versions SET status='published',published_by=public.training_current_account_subject_id(),published_at=clock_timestamp()
    WHERE id=v.id RETURNING * INTO v;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,after_state,reason,request_id)
    VALUES(v.policy_id,v.id,'publish',public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),to_jsonb(v),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_create_version(
  p_policy_id UUID,p_source_version_id UUID,p_effective_from DATE,p_change_summary TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_source public.training_signature_policy_versions; v_new public.training_signature_policy_versions; v_no INTEGER;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  IF NULLIF(btrim(p_change_summary),'') IS NULL OR NULLIF(btrim(p_reason),'') IS NULL OR p_effective_from IS NULL THEN
    RAISE EXCEPTION '[D15:signature_policy_invalid] 新版本日期、摘要和原因必填'; END IF;
  SELECT * INTO v_source FROM public.training_signature_policy_versions WHERE id=p_source_version_id AND policy_id=p_policy_id;
  IF NOT FOUND OR v_source.status='draft' THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 只能从已发布历史版本复制'; END IF;
  SELECT COALESCE(max(version_no),0)+1 INTO v_no FROM public.training_signature_policy_versions WHERE policy_id=p_policy_id;
  INSERT INTO public.training_signature_policy_versions(policy_id,version_no,effective_from,change_summary,created_by)
    VALUES(p_policy_id,v_no,p_effective_from,btrim(p_change_summary),public.training_current_account_subject_id()) RETURNING * INTO v_new;
  INSERT INTO public.training_signature_policy_nodes(policy_version_id,node_code,node_type,stage_order,applies_stage_type,required,sequence_no,signer_mode,signer_roles,requires_exam,due_days)
    SELECT v_new.id,node_code,node_type,stage_order,applies_stage_type,required,sequence_no,signer_mode,signer_roles,requires_exam,due_days
    FROM public.training_signature_policy_nodes WHERE policy_version_id=v_source.id;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,after_state,reason,request_id)
    VALUES(p_policy_id,v_new.id,'create_version',public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),to_jsonb(v_new),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_policy_retire(p_policy_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.training_signature_policy_versions;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  SELECT * INTO v FROM public.training_signature_policy_versions WHERE id=p_policy_version_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'published' OR NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 只能停用已发布版本且必须填写原因'; END IF;
  PERFORM set_config('app.training_signature_policy_lifecycle','on',TRUE);
  UPDATE public.training_signature_policy_versions SET status='retired',effective_to=GREATEST(CURRENT_DATE,effective_from),retired_by=public.training_current_account_subject_id(),retired_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,after_state,reason,request_id)
    VALUES(v.policy_id,v.id,'retire',public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),to_jsonb(v),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_can_read_requirement_internal(p_requirement public.training_signature_requirements) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_requirement.employee_id=public.training_my_employee_id()
    OR public.training_scheme_is_company_admin()
    OR (p_requirement.organization_unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(public.training_account_roles(auth.uid())) r
      WHERE r->>'role'='entity_admin' AND r->>'scope_id'=p_requirement.organization_unit_id::text))
    OR (p_requirement.project_id IS NOT NULL AND public.site_project_can_read_management_data(p_requirement.project_id))
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_authority_internal(p_requirement public.training_signature_requirements) RETURNS JSONB AS $$
DECLARE v_subject UUID; v_role TEXT; v_scope JSONB; v_roles JSONB;
BEGIN
  IF NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[D15:signature_forbidden] 当前账号不可签署' USING ERRCODE='42501'; END IF;
  v_subject:=public.training_current_account_subject_id(); v_roles:=public.training_account_roles(auth.uid());
  IF p_requirement.signer_roles_snapshot @> ARRAY['employee']::TEXT[] AND p_requirement.employee_id=public.training_my_employee_id() THEN
    v_role:='employee'; v_scope:=jsonb_build_object('scope','self','employee_id',p_requirement.employee_id);
  ELSIF p_requirement.signer_roles_snapshot @> ARRAY['organization_responsible']::TEXT[] AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_roles) r WHERE r->>'role'='entity_admin' AND r->>'scope_id'=p_requirement.organization_unit_id::text) THEN
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

CREATE FUNCTION public.training_signature_prerequisite_internal(p_requirement public.training_signature_requirements) RETURNS TEXT AS $$
BEGIN
  IF p_requirement.status='signed' THEN RETURN 'signature_already_completed'; END IF;
  IF p_requirement.status IN('superseded','invalidated') THEN RETURN 'signature_superseded'; END IF;
  IF p_requirement.stage_order IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.training_three_level_records r WHERE r.requirement_snapshot_id=p_requirement.requirement_snapshot_id
      AND r.requirement_snapshot_item_id=p_requirement.requirement_snapshot_item_id AND r.status='completed') THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;
  IF p_requirement.node_type='employee_final_acknowledgement' AND EXISTS(
    SELECT 1 FROM public.training_requirement_snapshot_items i WHERE i.snapshot_id=p_requirement.requirement_snapshot_id AND i.required
      AND NOT EXISTS(SELECT 1 FROM public.training_three_level_records r WHERE r.requirement_snapshot_item_id=i.id AND r.status='completed')) THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;
  IF p_requirement.requires_exam AND (p_requirement.admission_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.exam_attempts a WHERE a.admission_id=p_requirement.admission_id AND a.employee_id=p_requirement.employee_id
      AND a.exam_type='admission' AND a.status='submitted' AND a.result='pass')) THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;
  IF EXISTS(SELECT 1 FROM public.training_signature_requirements prior WHERE prior.requirement_cycle_id=p_requirement.requirement_cycle_id
    AND prior.required AND prior.sequence_no<p_requirement.sequence_no AND prior.status<>'signed') THEN RETURN 'signature_prerequisite_not_met'; END IF;
  RETURN 'ready';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_evidence_internal(p_requirement public.training_signature_requirements,p_authority JSONB) RETURNS JSONB AS $$
DECLARE v_snapshot public.training_requirement_snapshots; v_items JSONB; v_records JSONB; v_exam JSONB; v_display JSONB;
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_requirement.requirement_snapshot_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('snapshot_item_id',i.id,'stage_order',i.stage_order,'stage_type',i.stage_type,
    'package_id',i.training_package_id,'package_version_id',i.training_package_version_id,'package_version_no',i.training_package_version_no,
    'package_release',jsonb_build_object('approved_by',p.approved_by,'approved_at',p.approved_at,'status',p.status)) ORDER BY i.stage_order),'[]'::jsonb)
    INTO v_items FROM public.training_requirement_snapshot_items i JOIN public.training_admission_packages p ON p.id=i.training_package_id WHERE i.snapshot_id=v_snapshot.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('record_id',r.id,'snapshot_item_id',r.requirement_snapshot_item_id,'status',r.status,
    'effective_hours',r.effective_hours,'completed_at',r.completed_at) ORDER BY r.level),'[]'::jsonb)
    INTO v_records FROM public.training_three_level_records r WHERE r.requirement_snapshot_id=v_snapshot.id;
  SELECT jsonb_build_object('attempt_id',a.id,'admission_id',a.admission_id,'project_id',a.project_id,'exam_type',a.exam_type,
    'special_type',a.special_type,'paper_id',a.paper_id,'attempt_no',a.attempt_no,'score',a.score,'result',a.result,'submitted_at',a.submitted_at)
    INTO v_exam FROM public.exam_attempts a WHERE p_requirement.admission_id IS NOT NULL AND a.admission_id=p_requirement.admission_id
      AND a.employee_id=p_requirement.employee_id AND a.status='submitted' AND a.result='pass' ORDER BY a.submitted_at DESC,a.id LIMIT 1;
  SELECT jsonb_build_object('display_name',COALESCE(NULLIF(p.full_name,''),NULLIF(p.email,''),'已归档签字人')) INTO v_display
    FROM public.profiles p WHERE p.id=auth.uid();
  v_display:=COALESCE(v_display,jsonb_build_object('display_name','已归档签字人'));
  RETURN jsonb_build_object('schema','d15-signature-evidence-v1','person',jsonb_build_object('employee_id',p_requirement.employee_id,'stable_subject_id',p_requirement.employee_subject_id),
    'employment_relation_id',p_requirement.employment_relation_id,'admission_id',p_requirement.admission_id,'project_id',p_requirement.project_id,
    'requirement_snapshot',jsonb_build_object('id',v_snapshot.id,'scheme_id',v_snapshot.scheme_id,'scheme_version_id',v_snapshot.scheme_version_id,
      'organization_unit_id',v_snapshot.organization_unit_id,'effective_as_of',v_snapshot.effective_as_of,'generated_at',v_snapshot.generated_at),
    'training_packages',v_items,'completed_stages',v_records,'exam_result',v_exam,
    'signature_requirement',jsonb_build_object('id',p_requirement.id,'cycle_id',p_requirement.requirement_cycle_id,'node_code',p_requirement.node_code,
      'node_type',p_requirement.node_type,'sequence_no',p_requirement.sequence_no,'policy_id',p_requirement.policy_id,'policy_version_id',p_requirement.policy_version_id),
    'signer',jsonb_build_object('subject_id',p_authority->'subject_id','role',p_authority->'role','scope',p_authority->'scope','display',v_display));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_digest_internal(p_evidence JSONB) RETURNS TEXT AS $$
  SELECT encode(extensions.digest(convert_to(p_evidence::text,'UTF8'),'sha256'),'hex');
$$ LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_ensure_requirements(p_requirement_snapshot_id UUID,p_admission_id UUID DEFAULT NULL,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_snapshot public.training_requirement_snapshots; v_admission public.training_admissions; v_policy public.training_signature_policies;
  v_version public.training_signature_policy_versions; v_node public.training_signature_policy_nodes; v_item UUID; v_project UUID; v_cycle UUID:=gen_random_uuid(); v_count INTEGER:=0; v_req UUID;
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_requirement_snapshot_id;
  IF NOT FOUND OR NOT public.training_three_level_resolution_can_read(v_snapshot.employee_id,
    (SELECT project_id FROM public.training_admissions WHERE id=p_admission_id)) THEN
    RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字业务要求不存在或不可访问' USING ERRCODE='42501';
  END IF;
  IF p_admission_id IS NOT NULL THEN
    SELECT * INTO v_admission FROM public.training_admissions WHERE id=p_admission_id AND employee_id=v_snapshot.employee_id;
    IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_policy_invalid] admission 与人员不匹配'; END IF;
  END IF;
  SELECT p.* INTO v_policy FROM public.training_signature_policies p WHERE p.scheme_id=v_snapshot.scheme_id;
  IF NOT FOUND THEN SELECT p.* INTO v_policy FROM public.training_signature_policies p WHERE p.scheme_id IS NULL; END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_required','reason_code','signature_not_required','requirements','[]'::jsonb); END IF;
  SELECT * INTO v_version FROM public.training_signature_policy_versions WHERE policy_id=v_policy.id AND status='published'
    AND effective_from<=v_snapshot.effective_as_of AND (effective_to IS NULL OR effective_to>=v_snapshot.effective_as_of)
    ORDER BY effective_from DESC,version_no DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_required','reason_code','signature_not_required','requirements','[]'::jsonb); END IF;
  SELECT requirement_cycle_id INTO v_cycle FROM public.training_signature_requirements WHERE requirement_snapshot_id=v_snapshot.id AND policy_version_id=v_version.id
    AND (admission_id IS NOT DISTINCT FROM p_admission_id) ORDER BY created_at LIMIT 1;
  v_cycle:=COALESCE(v_cycle,gen_random_uuid());
  FOR v_node IN SELECT * FROM public.training_signature_policy_nodes WHERE policy_version_id=v_version.id ORDER BY sequence_no LOOP
    v_item:=NULL; v_project:=NULL;
    IF v_node.stage_order IS NOT NULL THEN
      SELECT id INTO v_item FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_order=v_node.stage_order
        AND (v_node.applies_stage_type IS NULL OR stage_type=v_node.applies_stage_type);
      IF v_item IS NULL THEN CONTINUE; END IF;
    ELSIF v_node.applies_stage_type IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_type=v_node.applies_stage_type) THEN
      CONTINUE;
    END IF;
    IF v_node.node_type='project_manager_or_safety_confirmation' THEN
      v_project:=COALESCE(v_admission.project_id,(SELECT site_project_id FROM public.training_requirement_snapshot_items WHERE snapshot_id=v_snapshot.id AND stage_type='actual_project' LIMIT 1));
      IF v_project IS NULL THEN CONTINUE; END IF;
    ELSIF p_admission_id IS NOT NULL THEN v_project:=v_admission.project_id; END IF;
    INSERT INTO public.training_signature_requirements(requirement_cycle_id,employee_id,employee_subject_id,employment_relation_id,admission_id,project_id,organization_unit_id,
      requirement_snapshot_id,requirement_snapshot_item_id,policy_id,policy_version_id,policy_node_id,node_code,node_type,stage_order,required,sequence_no,signer_mode,signer_roles_snapshot,requires_exam,due_at)
    VALUES(v_cycle,v_snapshot.employee_id,v_snapshot.subject_id,v_snapshot.employment_relation_id,p_admission_id,v_project,v_snapshot.organization_unit_id,
      v_snapshot.id,v_item,v_policy.id,v_version.id,v_node.id,v_node.node_code,v_node.node_type,v_node.stage_order,v_node.required,v_node.sequence_no,v_node.signer_mode,v_node.signer_roles,v_node.requires_exam,
      CASE WHEN v_node.due_days IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>v_node.due_days) END)
    ON CONFLICT(requirement_snapshot_id,policy_node_id,requirement_cycle_id) DO NOTHING RETURNING id INTO v_req;
    IF v_req IS NOT NULL THEN
      v_count:=v_count+1; INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
        VALUES(v_req,'created',public.training_current_account_subject_id(),'policy_snapshot',jsonb_build_object('policy_version_id',v_version.id,'request_id',p_request_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status','required','reason_code',CASE WHEN v_count>0 THEN 'signature_requirements_created' ELSE 'signature_requirements_reused' END,
    'policy_id',v_policy.id,'policy_version_id',v_version.id,'requirement_cycle_id',v_cycle,
    'requirements',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.sequence_no),'[]'::jsonb) FROM public.training_signature_requirements r WHERE r.requirement_cycle_id=v_cycle));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_requirement_list(p_employee_id UUID DEFAULT NULL,p_admission_id UUID DEFAULT NULL) RETURNS JSONB AS $$
BEGIN
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'employee_id',r.employee_id,'admission_id',r.admission_id,'project_id',r.project_id,
    'organization_unit_id',r.organization_unit_id,'node_code',r.node_code,'node_type',r.node_type,'stage_order',r.stage_order,'required',r.required,
    'sequence_no',r.sequence_no,'signer_mode',r.signer_mode,'signer_roles',r.signer_roles_snapshot,'status',r.status,'due_at',r.due_at,
    'policy_id',r.policy_id,'policy_version_id',r.policy_version_id,'created_at',r.created_at,'resolved_at',r.resolved_at,
    'result',CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'signed_at',s.signed_at,'signer_role',s.signer_role_snapshot,
      'signer_display',s.signer_display_snapshot,'evidence_digest',s.evidence_digest,'has_image',TRUE) END) ORDER BY r.created_at DESC,r.sequence_no)
    FROM public.training_signature_requirements r LEFT JOIN public.training_signature_results s ON s.requirement_id=r.id
    WHERE (p_employee_id IS NULL OR r.employee_id=p_employee_id) AND (p_admission_id IS NULL OR r.admission_id=p_admission_id)
      AND public.training_signature_can_read_requirement_internal(r)),'[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_prepare(p_requirement_id UUID) RETURNS JSONB AS $$
DECLARE v_req public.training_signature_requirements; v_auth JSONB; v_reason TEXT; v_evidence JSONB; v_digest TEXT; v_nonce TEXT; v_challenge UUID:=gen_random_uuid(); v_path TEXT;
BEGIN
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字要求不存在'; END IF;
  v_auth:=public.training_signature_authority_internal(v_req); v_reason:=public.training_signature_prerequisite_internal(v_req);
  IF v_reason='signature_already_completed' THEN RETURN jsonb_build_object('status','signed','reason_code',v_reason,'requirement_id',v_req.id); END IF;
  IF v_reason<>'ready' THEN RAISE EXCEPTION '[D15:%] 签字前置未满足',v_reason; END IF;
  v_evidence:=public.training_signature_evidence_internal(v_req,v_auth); v_digest:=public.training_signature_digest_internal(v_evidence);
  v_nonce:=encode(gen_random_bytes(24),'hex');
  v_path:=format('training-admission/signature-evidence/%s/%s/%s.png',v_req.id,v_challenge,gen_random_uuid());
  INSERT INTO public.training_signature_challenges(id,requirement_id,signer_subject_id,signer_authority_snapshot,nonce_hash,evidence_digest,evidence_snapshot,storage_path,expires_at)
    VALUES(v_challenge,v_req.id,(v_auth->>'subject_id')::uuid,v_auth,public.training_signature_digest_internal(to_jsonb(v_nonce)),v_digest,v_evidence,v_path,clock_timestamp()+INTERVAL '10 minutes');
  INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_req.id,'prepared',(v_auth->>'subject_id')::uuid,'prepare',jsonb_build_object('challenge_id',v_challenge,'evidence_digest',v_digest));
  RETURN jsonb_build_object('status','prepared','reason_code','signature_ready','requirement_id',v_req.id,'challenge_id',v_challenge,'nonce',v_nonce,
    'expires_at',clock_timestamp()+INTERVAL '10 minutes','evidence_digest',v_digest,'summary',v_evidence,'storage_bucket','certificates','storage_path',v_path,
    'upload_constraints',jsonb_build_object('mime_types',jsonb_build_array('image/png','image/jpeg'),'max_bytes',2097152,'width',jsonb_build_array(64,4096),'height',jsonb_build_array(32,4096)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions;

CREATE FUNCTION public.training_signature_file_can_upload(p_name TEXT) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND EXISTS(
    SELECT 1 FROM public.training_signature_challenges c JOIN public.training_signature_requirements r ON r.id=c.requirement_id
    WHERE c.storage_path=p_name AND c.signer_subject_id=public.training_current_account_subject_id() AND c.used_at IS NULL AND c.expires_at>clock_timestamp()
      AND r.status='pending' AND p_name ~ ('^training-admission/signature-evidence/'||r.id::text||'/'||c.id::text||'/[0-9a-f-]{36}\\.(png|jpg|jpeg)$')
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_file_can_read(p_name TEXT) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND EXISTS(
    SELECT 1 FROM public.training_signature_results s JOIN public.training_signature_requirements r ON r.id=s.requirement_id
    WHERE s.storage_path=p_name AND public.training_signature_can_read_requirement_internal(r)
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_submit(p_challenge_id UUID,p_nonce TEXT,p_idempotency_key TEXT,p_device JSONB DEFAULT '{}'::jsonb) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements; v_existing public.training_signature_results;
  v_auth JSONB; v_evidence JSONB; v_digest TEXT; v_object RECORD; v_mime TEXT; v_size BIGINT; v_width INTEGER; v_height INTEGER; v_result public.training_signature_results; v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF NULLIF(btrim(p_idempotency_key),'') IS NULL OR NULLIF(btrim(p_nonce),'') IS NULL OR jsonb_typeof(COALESCE(p_device,'{}'::jsonb))<>'object' THEN
    RAISE EXCEPTION '[D15:signature_file_invalid] 提交参数无效'; END IF;
  SELECT * INTO v_challenge FROM public.training_signature_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字 challenge 不存在'; END IF;
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=v_challenge.requirement_id FOR UPDATE;
  SELECT * INTO v_existing FROM public.training_signature_results WHERE requirement_id=v_req.id;
  IF FOUND THEN RETURN jsonb_build_object('status','signed','reason_code','signature_already_completed','idempotent',TRUE,'result_id',v_existing.id,
    'signed_at',v_existing.signed_at,'evidence_digest',v_existing.evidence_digest); END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=v_now THEN RAISE EXCEPTION '[D15:signature_challenge_expired] 签字 challenge 已失效'; END IF;
  IF v_challenge.nonce_hash<>public.training_signature_digest_internal(to_jsonb(p_nonce)) THEN RAISE EXCEPTION '[D15:signature_file_mismatch] challenge 不匹配'; END IF;
  v_auth:=public.training_signature_authority_internal(v_req);
  IF (v_auth->>'subject_id')::uuid<>v_challenge.signer_subject_id THEN RAISE EXCEPTION '[D15:signature_forbidden] 签字人不匹配' USING ERRCODE='42501'; END IF;
  IF public.training_signature_prerequisite_internal(v_req)<>'ready' THEN RAISE EXCEPTION '[D15:signature_prerequisite_not_met] 签字前置已变化'; END IF;
  v_evidence:=public.training_signature_evidence_internal(v_req,v_auth); v_digest:=public.training_signature_digest_internal(v_evidence);
  IF v_digest<>v_challenge.evidence_digest THEN RAISE EXCEPTION '[D15:signature_evidence_changed] 证据已变化，请重新确认'; END IF;
  SELECT o.* INTO v_object FROM storage.objects o WHERE o.bucket_id=v_challenge.storage_bucket AND o.name=v_challenge.storage_path;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 未找到本 challenge 的签字图片'; END IF;
  IF COALESCE(v_object.owner_id,v_object.owner::text)<>auth.uid()::text THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 签字图片不属于当前签字人'; END IF;
  v_mime:=lower(COALESCE(v_object.metadata->>'mimetype',v_object.metadata->>'contentType',''));
  v_size:=COALESCE((v_object.metadata->>'size')::bigint,0);
  v_width:=COALESCE((v_object.user_metadata->>'width')::integer,0); v_height:=COALESCE((v_object.user_metadata->>'height')::integer,0);
  IF v_mime NOT IN('image/png','image/jpeg') OR v_size NOT BETWEEN 1 AND 2097152 OR v_width NOT BETWEEN 64 AND 4096 OR v_height NOT BETWEEN 32 AND 4096
    OR lower(v_challenge.storage_path) !~ '\.(png|jpe?g)$' THEN RAISE EXCEPTION '[D15:signature_file_invalid] 签字图片格式、大小或尺寸无效'; END IF;
  INSERT INTO public.training_signature_results(requirement_id,challenge_id,signer_subject_id,signer_auth_user_id,signer_role_snapshot,signer_scope_snapshot,
    signer_display_snapshot,storage_bucket,storage_path,mime_type,file_size_bytes,image_width,image_height,evidence_digest,evidence_snapshot,signed_at,idempotency_key,device_snapshot)
  VALUES(v_req.id,v_challenge.id,v_challenge.signer_subject_id,auth.uid(),v_auth->>'role',v_auth->'scope',v_evidence->'signer'->'display',v_challenge.storage_bucket,
    v_challenge.storage_path,v_mime,v_size,v_width,v_height,v_digest,v_evidence,v_now,btrim(p_idempotency_key),COALESCE(p_device,'{}'::jsonb)) RETURNING * INTO v_result;
  PERFORM set_config('app.training_signature_mutation','on',TRUE);
  UPDATE public.training_signature_requirements SET status='signed',resolved_at=v_now,status_reason='signed' WHERE id=v_req.id;
  UPDATE public.training_signature_challenges SET used_at=v_now WHERE id=v_challenge.id;
  INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_req.id,'signed',v_result.signer_subject_id,'signed',jsonb_build_object('result_id',v_result.id,'evidence_digest',v_digest,'signer_role',v_result.signer_role_snapshot));
  RETURN jsonb_build_object('status','signed','reason_code','signature_completed','idempotent',FALSE,'result_id',v_result.id,'signed_at',v_result.signed_at,'evidence_digest',v_digest);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.training_signature_results WHERE requirement_id=v_req.id OR (signer_subject_id=(v_auth->>'subject_id')::uuid AND idempotency_key=btrim(p_idempotency_key)) ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status','signed','reason_code','signature_already_completed','idempotent',TRUE,'result_id',v_existing.id,'signed_at',v_existing.signed_at,'evidence_digest',v_existing.evidence_digest); END IF;
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;

CREATE FUNCTION public.training_signature_result_file(p_result_id UUID) RETURNS JSONB AS $$
DECLARE v_result public.training_signature_results; v_req public.training_signature_requirements;
BEGIN
  SELECT * INTO v_result FROM public.training_signature_results WHERE id=p_result_id;
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=v_result.requirement_id;
  IF v_result.id IS NULL OR NOT public.training_signature_can_read_requirement_internal(v_req) THEN RAISE EXCEPTION '[D15:signature_forbidden] 无权读取签字原图' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('bucket',v_result.storage_bucket,'path',v_result.storage_path,'mime_type',v_result.mime_type);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_supersede(p_requirement_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_old public.training_signature_requirements; v_new public.training_signature_requirements; v_subject UUID;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] supersede 必须填写原因'; END IF;
  SELECT * INTO v_old FROM public.training_signature_requirements WHERE id=p_requirement_id FOR UPDATE;
  IF NOT FOUND OR v_old.status IN('superseded','invalidated') THEN RAISE EXCEPTION '[D15:signature_superseded] 签字 requirement 已失效'; END IF;
  v_subject:=public.training_current_account_subject_id();
  INSERT INTO public.training_signature_requirements(requirement_cycle_id,employee_id,employee_subject_id,employment_relation_id,admission_id,project_id,organization_unit_id,
    requirement_snapshot_id,requirement_snapshot_item_id,policy_id,policy_version_id,policy_node_id,node_code,node_type,stage_order,required,sequence_no,signer_mode,signer_roles_snapshot,requires_exam,due_at,status_reason)
  VALUES(gen_random_uuid(),v_old.employee_id,v_old.employee_subject_id,v_old.employment_relation_id,v_old.admission_id,v_old.project_id,v_old.organization_unit_id,
    v_old.requirement_snapshot_id,v_old.requirement_snapshot_item_id,v_old.policy_id,v_old.policy_version_id,v_old.policy_node_id,v_old.node_code,v_old.node_type,v_old.stage_order,
    v_old.required,v_old.sequence_no,v_old.signer_mode,v_old.signer_roles_snapshot,v_old.requires_exam,v_old.due_at,'new_cycle') RETURNING * INTO v_new;
  PERFORM set_config('app.training_signature_mutation','on',TRUE);
  UPDATE public.training_signature_requirements SET status='superseded',superseded_by_requirement_id=v_new.id,status_reason=btrim(p_reason),resolved_at=clock_timestamp() WHERE id=v_old.id;
  INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail) VALUES
    (v_old.id,'superseded',v_subject,btrim(p_reason),jsonb_build_object('superseded_by',v_new.id,'request_id',p_request_id)),
    (v_new.id,'created',v_subject,'new_cycle',jsonb_build_object('supersedes',v_old.id,'request_id',p_request_id));
  RETURN jsonb_build_object('old_requirement_id',v_old.id,'new_requirement_id',v_new.id,'reason_code','signature_superseded');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

ALTER TABLE public.training_signature_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_policy_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_policy_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_signature_requirement_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.training_signature_policies,public.training_signature_policy_versions,public.training_signature_policy_nodes,
  public.training_signature_policy_audit_logs,public.training_signature_requirements,public.training_signature_challenges,
  public.training_signature_results,public.training_signature_requirement_events FROM PUBLIC,anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.training_signatures,public.training_admission_signatures FROM anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.training_submit_signature(UUID,TEXT,TEXT),public.training_admission_sign(UUID,UUID,TEXT,TEXT,TEXT,TEXT) FROM authenticated;

REVOKE ALL ON FUNCTION public.training_signature_history_immutable_guard(),public.training_signature_requirement_mutation_guard(),
  public.training_signature_policy_immutable_guard(),public.training_signature_require_company_admin(),
  public.training_signature_can_read_requirement_internal(public.training_signature_requirements),
  public.training_signature_authority_internal(public.training_signature_requirements),
  public.training_signature_prerequisite_internal(public.training_signature_requirements),
  public.training_signature_evidence_internal(public.training_signature_requirements,JSONB),public.training_signature_digest_internal(JSONB) FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION public.training_signature_policy_list(),public.training_signature_policy_create(TEXT,TEXT,UUID,DATE,TEXT,TEXT,TEXT),
  public.training_signature_policy_save_draft(UUID,JSONB,DATE,TEXT,TEXT,TEXT),public.training_signature_policy_publish(UUID,TEXT,TEXT),
  public.training_signature_policy_create_version(UUID,UUID,DATE,TEXT,TEXT,TEXT),public.training_signature_policy_retire(UUID,TEXT,TEXT),
  public.training_signature_ensure_requirements(UUID,UUID,TEXT),public.training_signature_requirement_list(UUID,UUID),
  public.training_signature_prepare(UUID),public.training_signature_file_can_upload(TEXT),public.training_signature_file_can_read(TEXT),
  public.training_signature_submit(UUID,TEXT,TEXT,JSONB),public.training_signature_result_file(UUID),public.training_signature_supersede(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_signature_policy_list(),public.training_signature_policy_create(TEXT,TEXT,UUID,DATE,TEXT,TEXT,TEXT),
  public.training_signature_policy_save_draft(UUID,JSONB,DATE,TEXT,TEXT,TEXT),public.training_signature_policy_publish(UUID,TEXT,TEXT),
  public.training_signature_policy_create_version(UUID,UUID,DATE,TEXT,TEXT,TEXT),public.training_signature_policy_retire(UUID,TEXT,TEXT),
  public.training_signature_ensure_requirements(UUID,UUID,TEXT),public.training_signature_requirement_list(UUID,UUID),
  public.training_signature_prepare(UUID),public.training_signature_file_can_upload(TEXT),public.training_signature_file_can_read(TEXT),
  public.training_signature_submit(UUID,TEXT,TEXT,JSONB),public.training_signature_result_file(UUID),public.training_signature_supersede(UUID,TEXT,TEXT) TO authenticated;

DROP POLICY IF EXISTS training_signature_evidence_upload ON storage.objects;
CREATE POLICY training_signature_evidence_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(
  bucket_id='certificates' AND public.training_signature_file_can_upload(name)
  AND lower(COALESCE(metadata->>'mimetype',metadata->>'contentType','')) IN('image/png','image/jpeg')
  AND COALESCE((metadata->>'size')::bigint,0) BETWEEN 1 AND 2097152
  AND COALESCE((user_metadata->>'width')::integer,0) BETWEEN 64 AND 4096
  AND COALESCE((user_metadata->>'height')::integer,0) BETWEEN 32 AND 4096
);
DROP POLICY IF EXISTS training_signature_evidence_read ON storage.objects;
CREATE POLICY training_signature_evidence_read ON storage.objects FOR SELECT TO authenticated USING(
  bucket_id='certificates' AND public.training_signature_file_can_read(name)
);
-- No UPDATE or DELETE policy is created. Existing generic certificate policies
-- already exclude the training-admission prefix, so signed objects cannot be replaced.

COMMENT ON TABLE public.training_signature_results IS 'D15 immutable in-system handwritten acknowledgement evidence; no claim of qualified electronic-signature status.';
COMMIT;

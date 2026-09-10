-- S3-A: unified organizations and versioned three-level training scheme foundation.
BEGIN;

CREATE TABLE public.organization_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_code TEXT NOT NULL UNIQUE CHECK(btrim(organization_code)<>''),
  name TEXT NOT NULL CHECK(btrim(name)<>''),
  organization_type TEXT NOT NULL CHECK(organization_type IN(
    'company','internal_department','operating_entity','logistics_center','other_internal_unit')),
  parent_id UUID REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  version_no INTEGER NOT NULL DEFAULT 1 CHECK(version_no>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(parent_id IS NULL OR parent_id<>id)
);

CREATE TABLE public.organization_unit_legacy_mappings (
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK(source_type IN('departments')),
  source_id UUID NOT NULL,
  source_code_snapshot TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_type,source_id),
  UNIQUE(organization_unit_id,source_type)
);

CREATE TABLE public.organization_unit_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  snapshot JSONB NOT NULL,
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  operator_roles_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  request_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_unit_id,version_no)
);
CREATE UNIQUE INDEX organization_unit_versions_request_idx
  ON public.organization_unit_versions(organization_unit_id,request_id) WHERE request_id IS NOT NULL;

INSERT INTO public.organization_units(id,organization_code,name,organization_type,parent_id,created_at)
SELECT d.id,d.code,d.name,CASE d.dept_type WHEN 'company' THEN 'company' WHEN 'entity' THEN 'operating_entity'
  WHEN 'internal' THEN 'internal_department' ELSE 'other_internal_unit' END,NULL,COALESCE(d.created_at,NOW())
FROM public.departments d WHERE d.dept_type<>'project'
ON CONFLICT(id) DO NOTHING;
UPDATE public.organization_units u SET parent_id=p.id
FROM public.departments d JOIN public.organization_units p ON p.id=d.parent_id
WHERE u.id=d.id AND u.parent_id IS DISTINCT FROM p.id;
INSERT INTO public.organization_unit_legacy_mappings(organization_unit_id,source_type,source_id,source_code_snapshot)
SELECT u.id,'departments',d.id,d.code FROM public.departments d JOIN public.organization_units u ON u.id=d.id
ON CONFLICT(source_type,source_id) DO NOTHING;
INSERT INTO public.organization_unit_versions(organization_unit_id,version_no,snapshot,reason)
SELECT u.id,u.version_no,to_jsonb(u),'v91 legacy organization bridge' FROM public.organization_units u
ON CONFLICT(organization_unit_id,version_no) DO NOTHING;

CREATE TABLE public.employment_organization_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employment_relation_id UUID NOT NULL,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  changed_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  UNIQUE(employment_relation_id,version_no)
);
CREATE UNIQUE INDEX employment_organization_current_idx
  ON public.employment_organization_assignments(employment_relation_id) WHERE active AND effective_to IS NULL;

CREATE TABLE public.employment_organization_assignment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES public.employment_organization_assignments(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL,
  old_organization_unit_id UUID REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  new_organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  old_active BOOLEAN,
  new_active BOOLEAN NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  operator_roles_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL,
  request_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX employment_organization_history_request_idx
  ON public.employment_organization_assignment_history(employment_relation_id,request_id) WHERE request_id IS NOT NULL;

INSERT INTO public.employment_organization_assignments(employment_relation_id,employee_id,organization_unit_id,effective_from,version_no,reason)
SELECT p.employment_relation_id,p.employee_id,m.organization_unit_id,COALESCE(p.employment_started_on,e.hire_date,CURRENT_DATE),1,'v91 legacy employment organization bridge'
FROM public.training_three_level_profiles p
JOIN public.training_employees e ON e.id=p.employee_id
JOIN public.organization_unit_legacy_mappings m ON m.source_type='departments' AND m.source_id=e.department_id
WHERE p.person_category='formal_internal'
ON CONFLICT(employment_relation_id,version_no) DO NOTHING;
INSERT INTO public.employment_organization_assignment_history(assignment_id,employment_relation_id,new_organization_unit_id,new_active,effective_from,effective_to,reason)
SELECT a.id,a.employment_relation_id,a.organization_unit_id,a.active,a.effective_from,a.effective_to,a.reason
FROM public.employment_organization_assignments a
WHERE NOT EXISTS(SELECT 1 FROM public.employment_organization_assignment_history h WHERE h.assignment_id=a.id);

CREATE TABLE public.three_level_training_schemes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_code TEXT NOT NULL UNIQUE CHECK(btrim(scheme_code)<>''),
  display_name TEXT NOT NULL CHECK(btrim(display_name)<>''),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.three_level_training_scheme_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_id UUID NOT NULL REFERENCES public.three_level_training_schemes(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK(version_number>0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published','retired','superseded')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  change_summary TEXT NOT NULL CHECK(btrim(change_summary)<>''),
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  published_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  UNIQUE(scheme_id,version_number),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK((status='draft' AND published_at IS NULL) OR status<>'draft')
);
CREATE UNIQUE INDEX three_level_scheme_one_draft_idx ON public.three_level_training_scheme_versions(scheme_id) WHERE status='draft';

CREATE TABLE public.three_level_training_scheme_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme_version_id UUID NOT NULL REFERENCES public.three_level_training_scheme_versions(id) ON DELETE RESTRICT,
  stage_order SMALLINT NOT NULL CHECK(stage_order BETWEEN 1 AND 3),
  stage_level TEXT NOT NULL CHECK(stage_level IN('company','organization','third')),
  stage_type TEXT NOT NULL CHECK(stage_type IN('company','organization','basic_project','actual_project','department_position','logistics_position','entity_position')),
  training_package_id UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  package_version_policy TEXT NOT NULL DEFAULT 'pinned' CHECK(package_version_policy IN('pinned')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  minimum_study_parameter_id TEXT REFERENCES public.system_parameter_definitions(parameter_id) ON DELETE RESTRICT,
  exam_policy_reference TEXT,
  signature_policy_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
  UNIQUE(scheme_version_id,stage_order),
  CHECK((stage_order=1 AND stage_level='company' AND stage_type='company') OR
        (stage_order=2 AND stage_level='organization' AND stage_type='organization') OR
        (stage_order=3 AND stage_level='third' AND stage_type IN('basic_project','actual_project','department_position','logistics_position','entity_position')))
);

CREATE TABLE public.three_level_training_applicability_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_code TEXT NOT NULL UNIQUE CHECK(btrim(rule_code)<>''),
  scheme_id UUID NOT NULL REFERENCES public.three_level_training_schemes(id) ON DELETE RESTRICT,
  person_category TEXT NOT NULL DEFAULT 'formal_internal' CHECK(person_category='formal_internal'),
  organization_unit_id UUID REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  organization_type TEXT CHECK(organization_type IN('company','internal_department','operating_entity','logistics_center','other_internal_unit')),
  employment_status TEXT CHECK(employment_status IS NULL OR employment_status IN('active','left')),
  employment_type TEXT CHECK(employment_type IS NULL OR employment_type IN('employee','special','manager')),
  position_category TEXT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  priority INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version_selection_policy TEXT NOT NULL DEFAULT 'latest_published' CHECK(version_selection_policy IN('latest_published','pinned')),
  pinned_scheme_version_id UUID REFERENCES public.three_level_training_scheme_versions(id) ON DELETE RESTRICT,
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(organization_unit_id IS NULL OR organization_type IS NULL),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK((version_selection_policy='pinned')=(pinned_scheme_version_id IS NOT NULL))
);

CREATE TABLE public.training_configuration_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type TEXT NOT NULL,
  object_id UUID NOT NULL,
  action TEXT NOT NULL,
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  operator_roles_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  before_state JSONB,
  after_state JSONB,
  reason TEXT NOT NULL CHECK(btrim(reason)<>''),
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_configuration_audit_request_idx
  ON public.training_configuration_audit_logs(object_type,object_id,request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION public.training_scheme_is_company_admin() RETURNS BOOLEAN AS $$
  SELECT public.training_account_is_active(auth.uid()) AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(public.training_account_roles(auth.uid())) r
    WHERE r->>'role'='company_admin' AND r->>'scope'='company');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_require_company_admin() RETURNS VOID AS $$
BEGIN
  IF NOT public.training_scheme_is_company_admin() THEN
    RAISE EXCEPTION '[S3A:forbidden] 仅有效公司级管理员可管理组织和三级教育方案' USING ERRCODE='42501';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_configuration_audit_write(p_type TEXT,p_id UUID,p_action TEXT,p_before JSONB,p_after JSONB,p_reason TEXT,p_request_id TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[S3A:reason_required] 必须填写变更原因'; END IF;
  INSERT INTO public.training_configuration_audit_logs(object_type,object_id,action,operator_subject_id,operator_roles_snapshot,before_state,after_state,reason,request_id)
  VALUES(p_type,p_id,p_action,public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),p_before,p_after,btrim(p_reason),NULLIF(btrim(p_request_id),''));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_configuration_history_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION '[S3A:audit_immutable] 配置历史和审计不可修改或删除'; END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_organization_versions_immutable BEFORE UPDATE OR DELETE ON public.organization_unit_versions FOR EACH ROW EXECUTE FUNCTION public.training_configuration_history_immutable();
CREATE TRIGGER trg_employment_organization_history_immutable BEFORE UPDATE OR DELETE ON public.employment_organization_assignment_history FOR EACH ROW EXECUTE FUNCTION public.training_configuration_history_immutable();
CREATE TRIGGER trg_training_configuration_audit_immutable BEFORE UPDATE OR DELETE ON public.training_configuration_audit_logs FOR EACH ROW EXECUTE FUNCTION public.training_configuration_history_immutable();

CREATE FUNCTION public.training_scheme_version_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status<>'draft' THEN
    IF current_setting('app.training_scheme_lifecycle',true)<>'on'
      OR (to_jsonb(NEW)-ARRAY['status','effective_to','reviewed_by','reviewed_at']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['status','effective_to','reviewed_by','reviewed_at']) THEN
      RAISE EXCEPTION '[S3A:published_version_immutable] 已发布方案版本不可原地修改或删除';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_scheme_version_immutable BEFORE UPDATE OR DELETE ON public.three_level_training_scheme_versions FOR EACH ROW EXECUTE FUNCTION public.training_scheme_version_immutable();

CREATE FUNCTION public.training_scheme_stage_draft_guard() RETURNS TRIGGER AS $$
DECLARE v_version UUID:=CASE WHEN TG_OP='DELETE' THEN OLD.scheme_version_id ELSE NEW.scheme_version_id END;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.three_level_training_scheme_versions WHERE id=v_version AND status='draft') THEN
    RAISE EXCEPTION '[S3A:published_version_immutable] 只有草稿版本可修改 stage';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_scheme_stage_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON public.three_level_training_scheme_stages FOR EACH ROW EXECUTE FUNCTION public.training_scheme_stage_draft_guard();

CREATE FUNCTION public.training_organization_list() RETURNS JSONB AS $$
BEGIN PERFORM public.training_scheme_require_company_admin();
RETURN COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.organization_code) FROM public.organization_units u),'[]'::jsonb); END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
CREATE FUNCTION public.training_organization_get(p_id UUID) RETURNS JSONB AS $$
DECLARE v JSONB; BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT to_jsonb(u) INTO v FROM public.organization_units u WHERE id=p_id;
IF v IS NULL THEN RAISE EXCEPTION '[S3A:organization_not_found] 组织不存在'; END IF; RETURN v; END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_organization_save(p_id UUID,p_data JSONB,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_id UUID:=COALESCE(p_id,gen_random_uuid()); v_old JSONB; v_new JSONB; v_parent UUID; v_type TEXT; v_active BOOLEAN; v_no INTEGER;
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[S3A:reason_required] 必须填写变更原因'; END IF;
  SELECT to_jsonb(u),u.version_no INTO v_old,v_no FROM public.organization_units u WHERE id=v_id FOR UPDATE;
  v_parent:=NULLIF(p_data->>'parent_id','')::uuid; v_type:=p_data->>'organization_type'; v_active:=COALESCE((p_data->>'active')::boolean,TRUE);
  IF v_type NOT IN('company','internal_department','operating_entity','logistics_center','other_internal_unit')
    OR NULLIF(btrim(p_data->>'organization_code'),'') IS NULL OR NULLIF(btrim(p_data->>'name'),'') IS NULL THEN
    RAISE EXCEPTION '[S3A:organization_invalid] 组织字段无效'; END IF;
  IF v_parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.organization_units WHERE id=v_parent AND active) THEN
    RAISE EXCEPTION '[S3A:organization_not_found] 上级组织不存在或已停用'; END IF;
  IF v_old IS NULL THEN
    INSERT INTO public.organization_units(id,organization_code,name,organization_type,parent_id,active,effective_from,effective_to,created_by,updated_by)
    VALUES(v_id,btrim(p_data->>'organization_code'),btrim(p_data->>'name'),v_type,v_parent,v_active,COALESCE((p_data->>'effective_from')::date,CURRENT_DATE),NULLIF(p_data->>'effective_to','')::date,public.training_current_account_subject_id(),public.training_current_account_subject_id());
  ELSE
    UPDATE public.organization_units SET organization_code=COALESCE(NULLIF(btrim(p_data->>'organization_code'),''),organization_code),
      name=COALESCE(NULLIF(btrim(p_data->>'name'),''),name),organization_type=COALESCE(v_type,organization_type),parent_id=v_parent,
      active=v_active,effective_from=COALESCE((p_data->>'effective_from')::date,effective_from),effective_to=NULLIF(p_data->>'effective_to','')::date,
      version_no=version_no+1,updated_by=public.training_current_account_subject_id(),updated_at=NOW() WHERE id=v_id;
  END IF;
  SELECT to_jsonb(u) INTO v_new FROM public.organization_units u WHERE id=v_id;
  INSERT INTO public.organization_unit_versions(organization_unit_id,version_no,snapshot,operator_subject_id,operator_roles_snapshot,reason,request_id)
  SELECT v_id,u.version_no,v_new,public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),btrim(p_reason),NULLIF(btrim(p_request_id),'') FROM public.organization_units u WHERE id=v_id;
  PERFORM public.training_configuration_audit_write('organization_unit',v_id,CASE WHEN v_old IS NULL THEN 'create' ELSE 'update' END,v_old,v_new,p_reason,p_request_id);
  RETURN v_new;
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '[S3A:organization_conflict] 组织编码或请求已存在';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_organization_set_active(p_id UUID,p_active BOOLEAN,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v JSONB;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.organization_units WHERE id=p_id) THEN RAISE EXCEPTION '[S3A:organization_not_found] 组织不存在'; END IF;
  SELECT public.training_organization_save(p_id,jsonb_build_object('organization_code',organization_code,'name',name,'organization_type',organization_type,
    'parent_id',parent_id,'active',p_active,'effective_from',effective_from,'effective_to',CASE WHEN p_active THEN NULL ELSE CURRENT_DATE END),p_reason,p_request_id)
    INTO v FROM public.organization_units WHERE id=p_id;
  RETURN v;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_employment_organization_assign(p_employment_relation_id UUID,p_organization_unit_id UUID,p_effective_from DATE,p_reason TEXT,p_request_id TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_old public.employment_organization_assignments; v_new public.employment_organization_assignments; v_no INTEGER;
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[S3A:reason_required] 必须填写变更原因'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employment_relation_id=p_employment_relation_id AND person_category='formal_internal' FOR UPDATE;
  IF v_profile.employee_id IS NULL THEN RAISE EXCEPTION '[S3A:employment_relation_invalid] 不存在有效正式员工用工关系'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_units WHERE id=p_organization_unit_id AND active) THEN RAISE EXCEPTION '[S3A:organization_inactive] 组织不存在或已停用'; END IF;
  SELECT * INTO v_old FROM public.employment_organization_assignments WHERE employment_relation_id=p_employment_relation_id AND active AND effective_to IS NULL FOR UPDATE;
  IF v_old.organization_unit_id=p_organization_unit_id THEN RETURN to_jsonb(v_old); END IF;
  SELECT COALESCE(MAX(version_no),0)+1 INTO v_no FROM public.employment_organization_assignments WHERE employment_relation_id=p_employment_relation_id;
  IF v_old.id IS NOT NULL THEN UPDATE public.employment_organization_assignments SET active=FALSE,effective_to=p_effective_from-1 WHERE id=v_old.id; END IF;
  INSERT INTO public.employment_organization_assignments(employment_relation_id,employee_id,organization_unit_id,effective_from,version_no,changed_by,reason)
  VALUES(p_employment_relation_id,v_profile.employee_id,p_organization_unit_id,p_effective_from,v_no,public.training_current_account_subject_id(),btrim(p_reason)) RETURNING * INTO v_new;
  INSERT INTO public.employment_organization_assignment_history(assignment_id,employment_relation_id,old_organization_unit_id,new_organization_unit_id,old_active,new_active,effective_from,operator_subject_id,operator_roles_snapshot,reason,request_id)
  VALUES(v_new.id,p_employment_relation_id,v_old.organization_unit_id,p_organization_unit_id,v_old.active,TRUE,p_effective_from,public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  PERFORM public.training_configuration_audit_write('employment_organization_assignment',v_new.id,'assign',to_jsonb(v_old),to_jsonb(v_new),p_reason,p_request_id);
  RETURN to_jsonb(v_new);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_employment_organization_current(p_employment_relation_id UUID) RETURNS JSONB AS $$
BEGIN PERFORM public.training_scheme_require_company_admin(); RETURN (SELECT to_jsonb(a) FROM public.employment_organization_assignments a WHERE employment_relation_id=p_employment_relation_id AND active AND effective_to IS NULL); END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_list() RETURNS JSONB AS $$
BEGIN PERFORM public.training_scheme_require_company_admin(); RETURN COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.scheme_code) FROM public.three_level_training_schemes s),'[]'::jsonb); END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
CREATE OR REPLACE FUNCTION public.training_scheme_get(p_id UUID) RETURNS JSONB AS $$
DECLARE v_result JSONB; BEGIN PERFORM public.training_scheme_require_company_admin();
SELECT to_jsonb(s)||jsonb_build_object('versions',COALESCE((SELECT jsonb_agg(to_jsonb(ver)||jsonb_build_object('stages',COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.stage_order) FROM public.three_level_training_scheme_stages g WHERE g.scheme_version_id=ver.id),'[]'::jsonb)) ORDER BY ver.version_number) FROM public.three_level_training_scheme_versions ver WHERE ver.scheme_id=s.id),'[]'::jsonb)) INTO v_result FROM public.three_level_training_schemes s WHERE s.id=p_id;
IF v_result IS NULL THEN RAISE EXCEPTION '[S3A:scheme_not_found] 方案不存在'; END IF; RETURN v_result; END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_create(p_scheme_code TEXT,p_display_name TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.three_level_training_schemes;
BEGIN PERFORM public.training_scheme_require_company_admin();
IF NULLIF(btrim(p_scheme_code),'') IS NULL OR NULLIF(btrim(p_display_name),'') IS NULL THEN RAISE EXCEPTION '[S3A:scheme_invalid] 方案编码和名称必填'; END IF;
INSERT INTO public.three_level_training_schemes(scheme_code,display_name,created_by,updated_by) VALUES(btrim(p_scheme_code),btrim(p_display_name),public.training_current_account_subject_id(),public.training_current_account_subject_id()) RETURNING * INTO v;
PERFORM public.training_configuration_audit_write('three_level_training_scheme',v.id,'create',NULL,to_jsonb(v),p_reason,p_request_id); RETURN to_jsonb(v);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '[S3A:scheme_conflict] 方案编码已存在'; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_create_version(p_scheme_id UUID,p_source_version_id UUID,p_effective_from DATE,p_change_summary TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_no INTEGER; v public.three_level_training_scheme_versions;
BEGIN PERFORM public.training_scheme_require_company_admin();
IF NOT EXISTS(SELECT 1 FROM public.three_level_training_schemes WHERE id=p_scheme_id AND active) THEN RAISE EXCEPTION '[S3A:scheme_not_found] 方案不存在或已停用'; END IF;
IF p_source_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.three_level_training_scheme_versions WHERE id=p_source_version_id AND scheme_id=p_scheme_id) THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 来源版本不存在'; END IF;
SELECT COALESCE(MAX(version_number),0)+1 INTO v_no FROM public.three_level_training_scheme_versions WHERE scheme_id=p_scheme_id;
INSERT INTO public.three_level_training_scheme_versions(scheme_id,version_number,effective_from,change_summary,created_by)
VALUES(p_scheme_id,v_no,p_effective_from,btrim(p_change_summary),public.training_current_account_subject_id()) RETURNING * INTO v;
IF p_source_version_id IS NOT NULL THEN INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id,package_version_policy,required,minimum_study_parameter_id,exam_policy_reference,signature_policy_reference,metadata)
 SELECT v.id,stage_order,stage_level,stage_type,training_package_id,package_version_policy,required,minimum_study_parameter_id,exam_policy_reference,signature_policy_reference,metadata FROM public.three_level_training_scheme_stages WHERE scheme_version_id=p_source_version_id; END IF;
PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',v.id,'create_draft',NULL,to_jsonb(v),p_reason,p_request_id); RETURN to_jsonb(v); END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_update_draft(p_version_id UUID,p_effective_from DATE,p_change_summary TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_old JSONB; v_new JSONB;
BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT to_jsonb(v) INTO v_old FROM public.three_level_training_scheme_versions v WHERE id=p_version_id FOR UPDATE;
IF v_old IS NULL THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 方案版本不存在'; END IF;
IF v_old->>'status'<>'draft' THEN RAISE EXCEPTION '[S3A:scheme_version_not_draft] 只有草稿版本可编辑'; END IF;
UPDATE public.three_level_training_scheme_versions SET effective_from=COALESCE(p_effective_from,effective_from),change_summary=COALESCE(NULLIF(btrim(p_change_summary),''),change_summary) WHERE id=p_version_id;
SELECT to_jsonb(v) INTO v_new FROM public.three_level_training_scheme_versions v WHERE id=p_version_id;
PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'update_draft',v_old,v_new,p_reason,p_request_id); RETURN v_new; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_scheme_set_stages(p_version_id UUID,p_stages JSONB,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_stage JSONB; v_before JSONB; v_after JSONB; v_package UUID;
BEGIN PERFORM public.training_scheme_require_company_admin();
IF NOT EXISTS(SELECT 1 FROM public.three_level_training_scheme_versions WHERE id=p_version_id AND status='draft') THEN RAISE EXCEPTION '[S3A:scheme_version_not_draft] 只有草稿版本可配置 stage'; END IF;
IF jsonb_typeof(p_stages)<>'array' THEN RAISE EXCEPTION '[S3A:invalid_stage_structure] stage 必须是数组'; END IF;
SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY stage_order),'[]'::jsonb) INTO v_before FROM public.three_level_training_scheme_stages s WHERE scheme_version_id=p_version_id;
FOR v_stage IN SELECT value FROM jsonb_array_elements(p_stages) LOOP
  BEGIN v_package:=(v_stage->>'training_package_id')::uuid; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '[S3A:training_package_not_valid] 培训包无效'; END;
  IF NOT EXISTS(SELECT 1 FROM public.training_admission_packages WHERE id=v_package AND status='published' AND training_category='basic_three_level') THEN RAISE EXCEPTION '[S3A:training_package_not_valid] 必须绑定已发布的三级教育培训包'; END IF;
END LOOP;
DELETE FROM public.three_level_training_scheme_stages WHERE scheme_version_id=p_version_id;
INSERT INTO public.three_level_training_scheme_stages(scheme_version_id,stage_order,stage_level,stage_type,training_package_id,required,minimum_study_parameter_id,exam_policy_reference,signature_policy_reference,metadata)
SELECT p_version_id,(j.stage->>'stage_order')::smallint,j.stage->>'stage_level',j.stage->>'stage_type',(j.stage->>'training_package_id')::uuid,COALESCE((j.stage->>'required')::boolean,TRUE),NULLIF(j.stage->>'minimum_study_parameter_id',''),NULLIF(j.stage->>'exam_policy_reference',''),NULLIF(j.stage->>'signature_policy_reference',''),COALESCE(j.stage->'metadata','{}'::jsonb)
FROM jsonb_array_elements(p_stages) AS j(stage);
SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY stage_order),'[]'::jsonb) INTO v_after FROM public.three_level_training_scheme_stages s WHERE scheme_version_id=p_version_id;
PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'set_stages',v_before,v_after,p_reason,p_request_id); RETURN v_after;
EXCEPTION WHEN check_violation OR unique_violation THEN RAISE EXCEPTION '[S3A:invalid_stage_structure] stage 结构无效'; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_publish(p_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.three_level_training_scheme_versions; v_before JSONB; v_after JSONB;
BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id FOR UPDATE;
IF v.id IS NULL THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 方案版本不存在'; END IF;
IF v.status<>'draft' THEN RAISE EXCEPTION '[S3A:scheme_version_not_draft] 只有草稿版本可发布'; END IF;
IF (SELECT count(*) FROM public.three_level_training_scheme_stages WHERE scheme_version_id=p_version_id)<>3 THEN RAISE EXCEPTION '[S3A:invalid_stage_structure] 发布前必须配置完整三个 stage'; END IF;
IF EXISTS(SELECT 1 FROM public.three_level_training_scheme_stages s LEFT JOIN public.training_admission_packages p ON p.id=s.training_package_id WHERE s.scheme_version_id=p_version_id AND (p.id IS NULL OR p.status<>'published' OR p.training_category<>'basic_three_level')) THEN RAISE EXCEPTION '[S3A:training_package_not_valid] stage 培训包不再有效'; END IF;
v_before:=to_jsonb(v); PERFORM set_config('app.training_scheme_lifecycle','on',true);
UPDATE public.three_level_training_scheme_versions SET status='superseded',effective_to=v.effective_from-1 WHERE scheme_id=v.scheme_id AND status='published' AND effective_from<v.effective_from;
UPDATE public.three_level_training_scheme_versions SET status='published',published_by=public.training_current_account_subject_id(),published_at=NOW() WHERE id=p_version_id;
SELECT to_jsonb(x) INTO v_after FROM public.three_level_training_scheme_versions x WHERE id=p_version_id;
PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'publish',v_before,v_after,p_reason,p_request_id); RETURN v_after; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_retire(p_version_id UUID,p_effective_to DATE,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_old JSONB; v_new JSONB; BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT to_jsonb(v) INTO v_old FROM public.three_level_training_scheme_versions v WHERE id=p_version_id AND status='published' FOR UPDATE;
IF v_old IS NULL THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 已发布方案版本不存在'; END IF; PERFORM set_config('app.training_scheme_lifecycle','on',true);
UPDATE public.three_level_training_scheme_versions SET status='retired',effective_to=p_effective_to WHERE id=p_version_id; SELECT to_jsonb(v) INTO v_new FROM public.three_level_training_scheme_versions v WHERE id=p_version_id;
PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'retire',v_old,v_new,p_reason,p_request_id); RETURN v_new; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_applicability_list() RETURNS JSONB AS $$
BEGIN PERFORM public.training_scheme_require_company_admin(); RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.rule_code) FROM public.three_level_training_applicability_rules r),'[]'::jsonb); END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_applicability_save(p_id UUID,p_data JSONB,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_id UUID:=COALESCE(p_id,gen_random_uuid()); v_old JSONB; v_new JSONB; v_scheme UUID; v_unit UUID; v_type TEXT; v_policy TEXT; v_pinned UUID;
BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT to_jsonb(r) INTO v_old FROM public.three_level_training_applicability_rules r WHERE id=v_id FOR UPDATE;
IF COALESCE(p_data->>'person_category','formal_internal')<>'formal_internal' THEN RAISE EXCEPTION '[S3A:applicability_rule_invalid] 三级教育方案只适用于正式员工'; END IF;
BEGIN v_scheme:=(p_data->>'scheme_id')::uuid; v_unit:=NULLIF(p_data->>'organization_unit_id','')::uuid; v_pinned:=NULLIF(p_data->>'pinned_scheme_version_id','')::uuid; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '[S3A:applicability_rule_invalid] 规则标识无效'; END;
v_type:=NULLIF(p_data->>'organization_type',''); v_policy:=COALESCE(NULLIF(p_data->>'version_selection_policy',''),'latest_published');
IF NOT EXISTS(SELECT 1 FROM public.three_level_training_schemes WHERE id=v_scheme) OR (v_unit IS NOT NULL AND v_type IS NOT NULL) THEN RAISE EXCEPTION '[S3A:applicability_rule_invalid] 规则条件无效'; END IF;
IF v_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.organization_units WHERE id=v_unit) THEN RAISE EXCEPTION '[S3A:organization_not_found] 组织不存在'; END IF;
IF v_policy='pinned' AND NOT EXISTS(SELECT 1 FROM public.three_level_training_scheme_versions WHERE id=v_pinned AND scheme_id=v_scheme AND status IN('published','retired','superseded')) THEN RAISE EXCEPTION '[S3A:scheme_version_not_found] 固定版本不存在或未发布'; END IF;
IF v_old IS NULL THEN
 INSERT INTO public.three_level_training_applicability_rules(id,rule_code,scheme_id,organization_unit_id,organization_type,employment_status,employment_type,position_category,effective_from,effective_to,priority,active,version_selection_policy,pinned_scheme_version_id,created_by,updated_by)
 VALUES(v_id,btrim(p_data->>'rule_code'),v_scheme,v_unit,v_type,NULLIF(p_data->>'employment_status',''),NULLIF(p_data->>'employment_type',''),NULLIF(p_data->>'position_category',''),(p_data->>'effective_from')::date,NULLIF(p_data->>'effective_to','')::date,COALESCE((p_data->>'priority')::integer,0),COALESCE((p_data->>'active')::boolean,TRUE),v_policy,v_pinned,public.training_current_account_subject_id(),public.training_current_account_subject_id());
ELSE
 UPDATE public.three_level_training_applicability_rules SET rule_code=btrim(p_data->>'rule_code'),scheme_id=v_scheme,organization_unit_id=v_unit,organization_type=v_type,employment_status=NULLIF(p_data->>'employment_status',''),employment_type=NULLIF(p_data->>'employment_type',''),position_category=NULLIF(p_data->>'position_category',''),effective_from=(p_data->>'effective_from')::date,effective_to=NULLIF(p_data->>'effective_to','')::date,priority=COALESCE((p_data->>'priority')::integer,0),active=COALESCE((p_data->>'active')::boolean,TRUE),version_selection_policy=v_policy,pinned_scheme_version_id=v_pinned,updated_by=public.training_current_account_subject_id(),updated_at=NOW() WHERE id=v_id;
END IF;
SELECT to_jsonb(r) INTO v_new FROM public.three_level_training_applicability_rules r WHERE id=v_id; PERFORM public.training_configuration_audit_write('three_level_training_applicability_rule',v_id,CASE WHEN v_old IS NULL THEN 'create' ELSE 'update' END,v_old,v_new,p_reason,p_request_id); RETURN v_new;
EXCEPTION WHEN check_violation OR not_null_violation THEN RAISE EXCEPTION '[S3A:applicability_rule_invalid] 规则字段无效'; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_applicability_set_active(p_id UUID,p_active BOOLEAN,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_old JSONB; v_new JSONB; BEGIN PERFORM public.training_scheme_require_company_admin(); SELECT to_jsonb(r) INTO v_old FROM public.three_level_training_applicability_rules r WHERE id=p_id FOR UPDATE;
IF v_old IS NULL THEN RAISE EXCEPTION '[S3A:applicability_rule_invalid] 规则不存在'; END IF; UPDATE public.three_level_training_applicability_rules SET active=p_active,updated_by=public.training_current_account_subject_id(),updated_at=NOW() WHERE id=p_id;
SELECT to_jsonb(r) INTO v_new FROM public.three_level_training_applicability_rules r WHERE id=p_id; PERFORM public.training_configuration_audit_write('three_level_training_applicability_rule',p_id,CASE WHEN p_active THEN 'activate' ELSE 'deactivate' END,v_old,v_new,p_reason,p_request_id); RETURN v_new; END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_match_applicability(p_person_category TEXT,p_organization_unit_id UUID,p_employment_status TEXT,p_employment_type TEXT,p_position_category TEXT,p_at DATE DEFAULT CURRENT_DATE)
RETURNS JSONB AS $$
DECLARE v_org public.organization_units; v_top RECORD;
BEGIN
  IF p_person_category<>'formal_internal' THEN RETURN jsonb_build_object('status','not_applicable','reason_code','applicability_rule_invalid'); END IF;
  IF p_organization_unit_id IS NOT NULL THEN SELECT * INTO v_org FROM public.organization_units WHERE id=p_organization_unit_id;
    IF v_org.id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason_code','organization_not_found'); END IF;
    IF NOT v_org.active OR p_at<v_org.effective_from OR (v_org.effective_to IS NOT NULL AND p_at>v_org.effective_to) THEN RETURN jsonb_build_object('status','blocked','reason_code','organization_inactive'); END IF;
  END IF;
  SELECT specificity,priority,count(DISTINCT scheme_id) AS scheme_count,min(scheme_id::text)::uuid AS scheme_id,jsonb_agg(id ORDER BY rule_code) AS rule_ids
  INTO v_top FROM (
    SELECT r.*,CASE WHEN r.organization_unit_id IS NOT NULL THEN 3 WHEN r.organization_type IS NOT NULL THEN 2 ELSE 1 END specificity
    FROM public.three_level_training_applicability_rules r WHERE r.active AND r.person_category=p_person_category
      AND p_at>=r.effective_from AND (r.effective_to IS NULL OR p_at<=r.effective_to)
      AND (r.organization_unit_id IS NULL OR r.organization_unit_id=p_organization_unit_id)
      AND (r.organization_type IS NULL OR r.organization_type=v_org.organization_type)
      AND (r.employment_status IS NULL OR r.employment_status=p_employment_status)
      AND (r.employment_type IS NULL OR r.employment_type=p_employment_type)
      AND (r.position_category IS NULL OR r.position_category=p_position_category)
  ) x GROUP BY specificity,priority ORDER BY specificity DESC,priority DESC LIMIT 1;
  IF v_top.specificity IS NULL THEN RETURN jsonb_build_object('status','blocked','reason_code','scheme_not_found'); END IF;
  IF v_top.scheme_count>1 THEN RETURN jsonb_build_object('status','ambiguous','reason_code','applicability_rule_conflict','precedence',v_top.specificity,'priority',v_top.priority,'rule_ids',v_top.rule_ids); END IF;
  RETURN jsonb_build_object('status','matched','reason_code','matched','scheme_id',v_top.scheme_id,'precedence',v_top.specificity,'priority',v_top.priority,'rule_ids',v_top.rule_ids);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

ALTER TABLE public.organization_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_unit_legacy_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_unit_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employment_organization_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employment_organization_assignment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.three_level_training_schemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.three_level_training_scheme_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.three_level_training_scheme_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.three_level_training_applicability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_configuration_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_units_admin_read ON public.organization_units FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY organization_mappings_admin_read ON public.organization_unit_legacy_mappings FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY organization_versions_admin_read ON public.organization_unit_versions FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY employment_organization_admin_read ON public.employment_organization_assignments FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY employment_organization_history_admin_read ON public.employment_organization_assignment_history FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY training_schemes_admin_read ON public.three_level_training_schemes FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY training_scheme_versions_admin_read ON public.three_level_training_scheme_versions FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY training_scheme_stages_admin_read ON public.three_level_training_scheme_stages FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY training_applicability_admin_read ON public.three_level_training_applicability_rules FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());
CREATE POLICY training_configuration_audit_admin_read ON public.training_configuration_audit_logs FOR SELECT TO authenticated USING(public.training_scheme_is_company_admin());

GRANT SELECT ON public.organization_units,public.organization_unit_legacy_mappings,public.organization_unit_versions,
 public.employment_organization_assignments,public.employment_organization_assignment_history,public.three_level_training_schemes,
 public.three_level_training_scheme_versions,public.three_level_training_scheme_stages,public.three_level_training_applicability_rules,
 public.training_configuration_audit_logs TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.organization_units,public.organization_unit_legacy_mappings,public.organization_unit_versions,
 public.employment_organization_assignments,public.employment_organization_assignment_history,public.three_level_training_schemes,
 public.three_level_training_scheme_versions,public.three_level_training_scheme_stages,public.three_level_training_applicability_rules,
 public.training_configuration_audit_logs FROM authenticated,anon;

REVOKE ALL ON FUNCTION public.training_scheme_is_company_admin(),public.training_scheme_require_company_admin(),
 public.training_configuration_audit_write(TEXT,UUID,TEXT,JSONB,JSONB,TEXT,TEXT),public.training_configuration_history_immutable(),
 public.training_scheme_version_immutable(),public.training_scheme_stage_draft_guard() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.training_organization_list(),public.training_organization_get(UUID),public.training_organization_save(UUID,JSONB,TEXT,TEXT),
 public.training_organization_set_active(UUID,BOOLEAN,TEXT,TEXT),public.training_employment_organization_assign(UUID,UUID,DATE,TEXT,TEXT),
 public.training_employment_organization_current(UUID),public.training_scheme_list(),public.training_scheme_get(UUID),
 public.training_scheme_create(TEXT,TEXT,TEXT,TEXT),public.training_scheme_create_version(UUID,UUID,DATE,TEXT,TEXT,TEXT),
 public.training_scheme_update_draft(UUID,DATE,TEXT,TEXT,TEXT),public.training_scheme_set_stages(UUID,JSONB,TEXT,TEXT),
 public.training_scheme_publish(UUID,TEXT,TEXT),public.training_scheme_retire(UUID,DATE,TEXT,TEXT),
 public.training_scheme_applicability_list(),public.training_scheme_applicability_save(UUID,JSONB,TEXT,TEXT),
 public.training_scheme_applicability_set_active(UUID,BOOLEAN,TEXT,TEXT),public.training_scheme_match_applicability(TEXT,UUID,TEXT,TEXT,TEXT,DATE)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_organization_list(),public.training_organization_get(UUID),public.training_organization_save(UUID,JSONB,TEXT,TEXT),
 public.training_organization_set_active(UUID,BOOLEAN,TEXT,TEXT),public.training_employment_organization_assign(UUID,UUID,DATE,TEXT,TEXT),
 public.training_employment_organization_current(UUID),public.training_scheme_list(),public.training_scheme_get(UUID),
 public.training_scheme_create(TEXT,TEXT,TEXT,TEXT),public.training_scheme_create_version(UUID,UUID,DATE,TEXT,TEXT,TEXT),
 public.training_scheme_update_draft(UUID,DATE,TEXT,TEXT,TEXT),public.training_scheme_set_stages(UUID,JSONB,TEXT,TEXT),
 public.training_scheme_publish(UUID,TEXT,TEXT),public.training_scheme_retire(UUID,DATE,TEXT,TEXT),
 public.training_scheme_applicability_list(),public.training_scheme_applicability_save(UUID,JSONB,TEXT,TEXT),
 public.training_scheme_applicability_set_active(UUID,BOOLEAN,TEXT,TEXT),public.training_scheme_match_applicability(TEXT,UUID,TEXT,TEXT,TEXT,DATE)
 TO authenticated;

COMMENT ON FUNCTION public.training_scheme_match_applicability(TEXT,UUID,TEXT,TEXT,TEXT,DATE) IS
  'S3-A controlled-field candidate matcher only. D11/D13 do not consume it until S3-B.';

COMMIT;

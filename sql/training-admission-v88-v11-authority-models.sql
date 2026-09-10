-- D00-D13 V1.1 compatibility: authoritative paths, categories, catalog and versioned parameters.
BEGIN;

CREATE TABLE IF NOT EXISTS public.system_parameter_definitions (
  parameter_id TEXT PRIMARY KEY, parameter_key TEXT NOT NULL UNIQUE, scope_type TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK(data_type IN('integer','number','boolean','text','enum')),
  default_value JSONB NOT NULL, min_value NUMERIC, max_value NUMERIC, allowed_values JSONB,
  requires_reason BOOLEAN NOT NULL DEFAULT TRUE, requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.system_parameter_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), parameter_id TEXT NOT NULL REFERENCES public.system_parameter_definitions(parameter_id) ON DELETE RESTRICT,
  scope_id UUID, value JSONB NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('draft','active','retired')),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), changed_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  change_reason TEXT NOT NULL, approval JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(parameter_id,scope_id,version_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS system_parameter_one_active_idx ON public.system_parameter_versions(parameter_id,COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE status='active';
CREATE TABLE IF NOT EXISTS public.system_parameter_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), parameter_id TEXT NOT NULL, scope_id UUID, old_version_id UUID, new_version_id UUID,
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL, reason TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.system_parameter_definitions(parameter_id,parameter_key,scope_type,data_type,default_value,min_value,max_value,allowed_values,requires_approval) VALUES
 ('TRN-HOUR-001','training.plan_hours','plan','number','1',0.5,NULL,NULL,FALSE),
 ('TRN-HOUR-002','training.required_hours','plan','number','1',0.5,NULL,NULL,FALSE),
 ('EXAM-QTY-001','exam.default_question_count','company','integer','20',10,100,NULL,FALSE),
 ('EXAM-DUR-001','exam.default_duration_minutes','company','integer','30',10,120,NULL,FALSE),
 ('EXAM-PASS-001','exam.default_pass_score','company','number','80',60,100,NULL,FALSE),
 ('EXAM-TRY-001','exam.default_attempt_limit','company','integer','3',1,10,NULL,FALSE),
 ('EXAM-DRILL-001','exam.drilling_required','company','boolean','false',NULL,NULL,'[true,false]'::jsonb,TRUE)
ON CONFLICT(parameter_id) DO NOTHING;
INSERT INTO public.system_parameter_versions(parameter_id,scope_id,value,version_no,status,change_reason)
SELECT d.parameter_id,NULL,d.default_value,1,'active','V1.1 initial controlled default' FROM public.system_parameter_definitions d
WHERE d.scope_type='company' ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.system_parameter_effective(p_parameter_id TEXT,p_scope_id UUID DEFAULT NULL,p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS JSONB AS $$
  SELECT jsonb_build_object('parameter_id',d.parameter_id,'value',COALESCE(v.value,d.default_value),'version_id',v.id,'version_no',COALESCE(v.version_no,0),'effective_at',v.effective_at)
  FROM public.system_parameter_definitions d LEFT JOIN LATERAL (
    SELECT x.* FROM public.system_parameter_versions x WHERE x.parameter_id=d.parameter_id AND x.status='active'
      AND x.effective_at<=p_at AND (x.scope_id=p_scope_id OR x.scope_id IS NULL)
    ORDER BY (x.scope_id IS NOT NULL) DESC,x.effective_at DESC,x.version_no DESC LIMIT 1
  ) v ON TRUE WHERE d.parameter_id=p_parameter_id AND d.enabled;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_effective(TEXT,UUID,TIMESTAMPTZ) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.system_parameter_effective(TEXT,UUID,TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.system_parameter_set(p_parameter_id TEXT,p_value JSONB,p_scope_id UUID,p_effective_at TIMESTAMPTZ,p_reason TEXT,p_approval JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB AS $$
DECLARE d public.system_parameter_definitions; v_old UUID; v_new UUID; v_no INTEGER; v_num NUMERIC;
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[V11:parameter_forbidden] 仅有效公司级管理员可修改参数'; END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[V11:parameter_reason_required] 必须填写修改原因'; END IF;
  SELECT * INTO d FROM public.system_parameter_definitions WHERE parameter_id=p_parameter_id AND enabled FOR UPDATE;
  IF d.parameter_id IS NULL THEN RAISE EXCEPTION '[V11:parameter_not_found] 参数不存在'; END IF;
  IF d.data_type IN('integer','number') THEN
    BEGIN v_num:=(p_value#>>'{}')::numeric; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是数字'; END;
    IF (d.min_value IS NOT NULL AND v_num<d.min_value) OR (d.max_value IS NOT NULL AND v_num>d.max_value) THEN RAISE EXCEPTION '[V11:parameter_out_of_range] 参数超出允许范围'; END IF;
    IF d.data_type='integer' AND trunc(v_num)<>v_num THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是整数'; END IF;
  ELSIF d.data_type='boolean' AND jsonb_typeof(p_value)<>'boolean' THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数必须是布尔值';
  ELSIF d.allowed_values IS NOT NULL AND NOT d.allowed_values @> jsonb_build_array(p_value) THEN RAISE EXCEPTION '[V11:parameter_invalid_value] 参数不在允许枚举中'; END IF;
  IF d.requires_approval AND COALESCE(p_approval->>'approved_by','')='' THEN RAISE EXCEPTION '[V11:parameter_approval_required] 参数变更需要审批'; END IF;
  SELECT id INTO v_old FROM public.system_parameter_versions WHERE parameter_id=p_parameter_id AND scope_id IS NOT DISTINCT FROM p_scope_id AND status='active' FOR UPDATE;
  SELECT COALESCE(MAX(version_no),0)+1 INTO v_no FROM public.system_parameter_versions WHERE parameter_id=p_parameter_id AND scope_id IS NOT DISTINCT FROM p_scope_id;
  UPDATE public.system_parameter_versions SET status='retired' WHERE id=v_old;
  INSERT INTO public.system_parameter_versions(parameter_id,scope_id,value,version_no,status,effective_at,changed_by,change_reason,approval)
  VALUES(p_parameter_id,p_scope_id,p_value,v_no,'active',COALESCE(p_effective_at,NOW()),public.training_current_account_subject_id(),btrim(p_reason),COALESCE(p_approval,'{}')) RETURNING id INTO v_new;
  INSERT INTO public.system_parameter_audit(parameter_id,scope_id,old_version_id,new_version_id,operator_subject_id,reason)
  VALUES(p_parameter_id,p_scope_id,v_old,v_new,public.training_current_account_subject_id(),btrim(p_reason));
  RETURN jsonb_build_object('parameter_id',p_parameter_id,'version_id',v_new,'version_no',v_no,'value',p_value);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.system_parameter_set(TEXT,JSONB,UUID,TIMESTAMPTZ,TEXT,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.system_parameter_set(TEXT,JSONB,UUID,TIMESTAMPTZ,TEXT,JSONB) TO authenticated;

CREATE TABLE IF NOT EXISTS public.special_requirement_catalog (
  special_type TEXT PRIMARY KEY, category TEXT NOT NULL CHECK(category IN('special_operation','project_special')),
  display_name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, certificate_required BOOLEAN NOT NULL,
  training_required BOOLEAN NOT NULL DEFAULT TRUE, exam_policy TEXT NOT NULL CHECK(exam_policy IN('required','parameter')),
  exam_parameter_id TEXT REFERENCES public.system_parameter_definitions(parameter_id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0, effective_version INTEGER NOT NULL DEFAULT 1 CHECK(effective_version>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK((exam_policy='required' AND exam_parameter_id IS NULL) OR (exam_policy='parameter' AND exam_parameter_id IS NOT NULL))
);
INSERT INTO public.special_requirement_catalog(special_type,category,display_name,certificate_required,exam_policy,exam_parameter_id,sort_order) VALUES
 ('blasting','special_operation','爆破',TRUE,'required',NULL,10),('electrical','special_operation','电工',TRUE,'required',NULL,20),
 ('welding','special_operation','焊工',TRUE,'required',NULL,30),('drilling','project_special','钻探',FALSE,'parameter','EXAM-DRILL-001',40)
ON CONFLICT(special_type) DO UPDATE SET category=EXCLUDED.category,display_name=EXCLUDED.display_name,certificate_required=EXCLUDED.certificate_required,
 exam_policy=EXCLUDED.exam_policy,exam_parameter_id=EXCLUDED.exam_parameter_id;

CREATE TABLE IF NOT EXISTS public.project_risk_catalog (
  risk_tag TEXT PRIMARY KEY, display_name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  special_type TEXT REFERENCES public.special_requirement_catalog(special_type) ON DELETE RESTRICT, sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT INTO public.project_risk_catalog(risk_tag,display_name,special_type,sort_order) VALUES('drilling','钻探作业','drilling',10) ON CONFLICT(risk_tag) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.site_project_risk_tags (
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,risk_tag TEXT NOT NULL REFERENCES public.project_risk_catalog(risk_tag) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,reason TEXT NOT NULL,PRIMARY KEY(project_id,risk_tag)
);
INSERT INTO public.site_project_risk_tags(project_id,risk_tag,reason) SELECT id,'drilling','migrated from includes_drilling' FROM public.site_projects WHERE includes_drilling
ON CONFLICT(project_id,risk_tag) DO UPDATE SET active=TRUE;

CREATE OR REPLACE FUNCTION public.site_project_sync_drilling_risk_tag() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.site_project_risk_tags(project_id,risk_tag,active,changed_by,reason,changed_at)
  VALUES(NEW.id,'drilling',NEW.includes_drilling,public.training_current_account_subject_id(),COALESCE(NULLIF(NEW.drilling_change_reason,''),'includes_drilling compatibility sync'),NOW())
  ON CONFLICT(project_id,risk_tag) DO UPDATE SET active=EXCLUDED.active,changed_by=EXCLUDED.changed_by,reason=EXCLUDED.reason,changed_at=NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.site_project_sync_drilling_risk_tag() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_site_project_sync_drilling_risk_tag ON public.site_projects;
CREATE TRIGGER trg_site_project_sync_drilling_risk_tag AFTER INSERT OR UPDATE OF includes_drilling ON public.site_projects FOR EACH ROW EXECUTE FUNCTION public.site_project_sync_drilling_risk_tag();

CREATE TABLE IF NOT EXISTS public.project_person_admission_paths (
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  primary_path TEXT NOT NULL CHECK(primary_path IN('employee','contractor','temporary_individual','visitor')),active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,source TEXT NOT NULL,version_no INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(project_id,employee_id)
);
CREATE TABLE IF NOT EXISTS public.project_person_admission_path_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),project_id UUID NOT NULL,employee_id UUID NOT NULL,old_path TEXT,new_path TEXT NOT NULL,
  old_active BOOLEAN,new_active BOOLEAN NOT NULL,effective_at TIMESTAMPTZ NOT NULL,operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,source TEXT NOT NULL,version_no INTEGER NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.training_member_primary_path(p_member public.site_project_members) RETURNS TEXT AS $$
  SELECT CASE WHEN EXISTS(SELECT 1 FROM public.training_three_level_profiles t WHERE t.employee_id=p_member.employee_id AND t.person_category='visitor') THEN 'visitor'
    WHEN p_member.membership_type='external' THEN 'contractor' WHEN p_member.membership_type='temporary' THEN 'temporary_individual' ELSE 'employee' END
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_member_primary_path(public.site_project_members) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_member_admission_path() RETURNS TRIGGER AS $$
DECLARE v_path TEXT:=public.training_member_primary_path(NEW); v_old public.project_person_admission_paths; v_version INTEGER;
BEGIN
  SELECT * INTO v_old FROM public.project_person_admission_paths WHERE project_id=NEW.project_id AND employee_id=NEW.employee_id FOR UPDATE;
  IF FOUND AND v_old.primary_path=v_path AND v_old.active=(NEW.status='active') THEN RETURN NEW; END IF;
  v_version:=COALESCE(v_old.version_no,0)+1;
  INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,changed_at,operator_subject_id,reason,source,version_no)
  VALUES(NEW.project_id,NEW.employee_id,v_path,NEW.status='active',COALESCE(NEW.joined_at,NOW()),NOW(),public.training_current_account_subject_id(),
    COALESCE(NULLIF(NEW.left_reason,''),'site project membership synchronized'),'site_project_members',v_version)
  ON CONFLICT(project_id,employee_id) DO UPDATE SET primary_path=EXCLUDED.primary_path,active=EXCLUDED.active,effective_at=EXCLUDED.effective_at,
    changed_at=NOW(),operator_subject_id=EXCLUDED.operator_subject_id,reason=EXCLUDED.reason,source=EXCLUDED.source,version_no=EXCLUDED.version_no;
  INSERT INTO public.project_person_admission_path_history(project_id,employee_id,old_path,new_path,old_active,new_active,effective_at,operator_subject_id,reason,source,version_no)
  VALUES(NEW.project_id,NEW.employee_id,v_old.primary_path,v_path,v_old.active,NEW.status='active',COALESCE(NEW.joined_at,NOW()),public.training_current_account_subject_id(),
    COALESCE(NULLIF(NEW.left_reason,''),'site project membership synchronized'),'site_project_members',v_version);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_sync_member_admission_path() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_sync_member_admission_path ON public.site_project_members;
CREATE TRIGGER trg_training_sync_member_admission_path AFTER INSERT OR UPDATE OF membership_type,status,contractor_id,left_at,left_reason ON public.site_project_members FOR EACH ROW EXECUTE FUNCTION public.training_sync_member_admission_path();
INSERT INTO public.project_person_admission_paths(project_id,employee_id,primary_path,active,effective_at,reason,source)
SELECT m.project_id,m.employee_id,public.training_member_primary_path(m),m.status='active',m.joined_at,'migrated from site_project_members','migration-v88' FROM public.site_project_members m
ON CONFLICT(project_id,employee_id) DO NOTHING;
INSERT INTO public.project_person_admission_path_history(project_id,employee_id,old_path,new_path,old_active,new_active,effective_at,reason,source,version_no)
SELECT p.project_id,p.employee_id,NULL,p.primary_path,NULL,p.active,p.effective_at,p.reason,p.source,p.version_no FROM public.project_person_admission_paths p
WHERE NOT EXISTS(SELECT 1 FROM public.project_person_admission_path_history h WHERE h.project_id=p.project_id AND h.employee_id=p.employee_id);

CREATE OR REPLACE FUNCTION public.training_primary_admission_path(p_project_id UUID,p_employee_id UUID)
RETURNS JSONB AS $$
  SELECT jsonb_build_object('project_id',p.project_id,'employee_id',p.employee_id,'primary_path',p.primary_path,'active',p.active,
    'effective_at',p.effective_at,'version_no',p.version_no,'source',p.source) FROM public.project_person_admission_paths p
  WHERE p.project_id=p_project_id AND p.employee_id=p_employee_id
    AND (p.employee_id=public.training_my_employee_id() OR public.site_project_can_manage(p.project_id) OR public.training_is_company_admin() OR public.is_entity_manager())
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_primary_admission_path(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_primary_admission_path(UUID,UUID) TO authenticated;

ALTER TABLE public.training_plans ADD COLUMN IF NOT EXISTS training_category TEXT;
ALTER TABLE public.training_admission_packages ADD COLUMN IF NOT EXISTS training_category TEXT;
UPDATE public.training_plans p SET training_category=CASE
  WHEN EXISTS(SELECT 1 FROM public.training_three_level_records r WHERE r.plan_id=p.id) THEN 'basic_three_level'
  WHEN p.level='special' AND COALESCE((SELECT category FROM public.special_requirement_catalog c WHERE c.special_type=p.special_type),'special_operation')='project_special' THEN 'project_special'
  WHEN p.level='special' THEN 'special_operation' WHEN p.site_project_id IS NOT NULL THEN 'project_induction' ELSE 'continuing_or_change' END
WHERE training_category IS NULL;
UPDATE public.training_admission_packages SET training_category='project_induction' WHERE training_category IS NULL;
ALTER TABLE public.training_plans ALTER COLUMN training_category SET DEFAULT 'continuing_or_change';
ALTER TABLE public.training_plans ALTER COLUMN training_category SET NOT NULL;
ALTER TABLE public.training_admission_packages ALTER COLUMN training_category SET DEFAULT 'project_induction';
ALTER TABLE public.training_admission_packages ALTER COLUMN training_category SET NOT NULL;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_v11_category_check CHECK(training_category IN('basic_three_level','project_induction','project_special','special_operation','continuing_or_change')) NOT VALID;
ALTER TABLE public.training_admission_packages ADD CONSTRAINT training_packages_v11_category_check CHECK(training_category IN('basic_three_level','project_induction','project_special','special_operation','continuing_or_change')) NOT VALID;
ALTER TABLE public.training_plans VALIDATE CONSTRAINT training_plans_v11_category_check;
ALTER TABLE public.training_admission_packages VALIDATE CONSTRAINT training_packages_v11_category_check;

ALTER TABLE public.training_admission_tasks ADD COLUMN IF NOT EXISTS training_category TEXT;
UPDATE public.training_admission_tasks t SET training_category=p.training_category FROM public.training_plans p WHERE p.id=t.plan_id AND t.training_category IS NULL;

ALTER TABLE public.system_parameter_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_parameter_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_parameter_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_requirement_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_risk_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_risk_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_person_admission_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_person_admission_path_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY parameter_definitions_read ON public.system_parameter_definitions FOR SELECT TO authenticated USING(TRUE);
CREATE POLICY parameter_versions_read ON public.system_parameter_versions FOR SELECT TO authenticated USING(TRUE);
CREATE POLICY special_catalog_read ON public.special_requirement_catalog FOR SELECT TO authenticated USING(TRUE);
CREATE POLICY risk_catalog_read ON public.project_risk_catalog FOR SELECT TO authenticated USING(TRUE);
CREATE POLICY project_risk_tags_read ON public.site_project_risk_tags FOR SELECT TO authenticated USING(public.site_project_can_read(project_id));
CREATE POLICY admission_paths_read ON public.project_person_admission_paths FOR SELECT TO authenticated USING(employee_id=public.training_my_employee_id() OR public.site_project_can_manage(project_id) OR public.training_is_company_admin() OR public.is_entity_manager());
CREATE POLICY admission_path_history_read ON public.project_person_admission_path_history FOR SELECT TO authenticated USING(employee_id=public.training_my_employee_id() OR public.site_project_can_manage(project_id) OR public.training_is_company_admin() OR public.is_entity_manager());
GRANT SELECT ON public.system_parameter_definitions,public.system_parameter_versions,public.special_requirement_catalog,public.project_risk_catalog,
 public.site_project_risk_tags,public.project_person_admission_paths,public.project_person_admission_path_history TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.system_parameter_definitions,public.system_parameter_versions,public.system_parameter_audit,public.special_requirement_catalog,
 public.project_risk_catalog,public.site_project_risk_tags,public.project_person_admission_paths,public.project_person_admission_path_history FROM authenticated,anon;

COMMIT;

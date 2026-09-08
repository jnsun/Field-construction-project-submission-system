-- D11 最终语义：三级教育是正式员工的一次性入职基础事实，不是逐项目重复任务。
BEGIN;

ALTER TABLE public.training_plans ADD COLUMN IF NOT EXISTS third_level_mode TEXT;
UPDATE public.training_plans SET third_level_mode='actual_project'
WHERE level='project' AND third_level_mode IS NULL AND site_project_id IS NOT NULL;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_third_level_mode_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_third_level_mode_check CHECK (
  (level<>'project' AND third_level_mode IS NULL)
  OR (level='project' AND third_level_mode='basic_project' AND department_id IS NOT NULL AND site_project_id IS NULL)
  OR (level='project' AND third_level_mode='actual_project' AND department_id IS NULL AND site_project_id IS NOT NULL)
) NOT VALID;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_scope_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_scope_check CHECK (
  (level='company' AND department_id IS NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level='entity' AND department_id IS NOT NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level='project' AND special_type IS NULL AND (
    (third_level_mode='basic_project' AND department_id IS NOT NULL AND site_project_id IS NULL)
    OR (third_level_mode='actual_project' AND department_id IS NULL AND site_project_id IS NOT NULL)))
  OR (level='special' AND special_type IS NOT NULL AND btrim(special_type)<>''
    AND ((department_id IS NOT NULL)<>(site_project_id IS NOT NULL)))
) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_plan_third_level_mode_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.level='project' AND NEW.third_level_mode IS NULL AND NEW.site_project_id IS NOT NULL THEN
    NEW.third_level_mode:='actual_project';
  ELSIF NEW.level<>'project' THEN NEW.third_level_mode:=NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_plan_third_level_mode_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_plan_third_level_mode ON public.training_plans;
CREATE TRIGGER trg_training_plan_third_level_mode BEFORE INSERT OR UPDATE OF level,department_id,site_project_id,third_level_mode
ON public.training_plans FOR EACH ROW EXECUTE FUNCTION public.training_plan_third_level_mode_guard();
CREATE OR REPLACE FUNCTION public.training_plan_third_level_mode_history_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.third_level_mode IS DISTINCT FROM OLD.third_level_mode AND public.training_plan_is_locked(OLD.id) THEN
    RAISE EXCEPTION '[D11:three_level_history_locked] 已形成历史的第三级模式不可修改';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_plan_third_level_mode_history_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_plan_third_level_mode_history ON public.training_plans;
CREATE TRIGGER trg_training_plan_third_level_mode_history BEFORE UPDATE OF third_level_mode ON public.training_plans
FOR EACH ROW EXECUTE FUNCTION public.training_plan_third_level_mode_history_guard();

CREATE OR REPLACE FUNCTION public.training_plan_scope_can_read(p_level TEXT,p_department_id UUID,p_site_project_id UUID)
RETURNS BOOLEAN AS $$ SELECT CASE p_level
  WHEN 'company' THEN public.training_is_company_admin()
  WHEN 'entity' THEN public.is_admin() AND p_department_id IS NOT NULL AND public.training_can_read(p_department_id)
  WHEN 'project' THEN CASE WHEN p_site_project_id IS NOT NULL THEN public.site_project_can_read(p_site_project_id)
    ELSE public.is_admin() AND p_department_id IS NOT NULL AND public.training_can_read(p_department_id) END
  WHEN 'special' THEN CASE WHEN p_site_project_id IS NOT NULL THEN public.site_project_can_read(p_site_project_id)
    ELSE public.is_admin() AND p_department_id IS NOT NULL AND public.training_can_read(p_department_id) END
  ELSE FALSE END; $$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_plan_row_can_write(p_level TEXT,p_department_id UUID,p_site_project_id UUID)
RETURNS BOOLEAN AS $$ SELECT CASE p_level
  WHEN 'company' THEN p_department_id IS NULL AND p_site_project_id IS NULL AND public.training_is_company_admin()
  WHEN 'entity' THEN p_department_id IS NOT NULL AND p_site_project_id IS NULL AND public.is_admin() AND public.training_can_write(p_department_id)
  WHEN 'project' THEN CASE WHEN p_site_project_id IS NOT NULL THEN p_department_id IS NULL AND public.site_project_can_manage(p_site_project_id)
    ELSE p_department_id IS NOT NULL AND public.is_admin() AND public.training_can_write(p_department_id) END
  WHEN 'special' THEN (p_department_id IS NOT NULL AND p_site_project_id IS NULL AND public.is_admin() AND public.training_can_write(p_department_id))
    OR (p_department_id IS NULL AND p_site_project_id IS NOT NULL AND public.site_project_can_manage(p_site_project_id))
  ELSE FALSE END; $$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE TABLE IF NOT EXISTS public.training_three_level_profiles (
  employee_id UUID PRIMARY KEY REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_category TEXT NOT NULL CHECK(person_category IN('formal_internal','contractor','temporary_individual','visitor')),
  onboarding_category TEXT NOT NULL CHECK(onboarding_category IN('new_hire','legacy_evidence_review','legacy_supplement','legacy_verified','completed','legacy_supplement_completed','not_applicable')),
  status TEXT NOT NULL CHECK(status IN('required','evidence_review','in_progress','verified','completed','not_applicable')),
  employment_started_on DATE,
  relation_source TEXT NOT NULL CHECK(btrim(relation_source)<>''),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((person_category='formal_internal' AND onboarding_category<>'not_applicable' AND status<>'not_applicable')
    OR (person_category<>'formal_internal' AND onboarding_category='not_applicable' AND status='not_applicable')),
  CHECK(onboarding_category<>'new_hire' OR employment_started_on IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.training_three_level_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL,
  level TEXT NOT NULL CHECK(level IN('company','entity','third')),
  plan_id UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE RESTRICT,
  assignment_id UUID REFERENCES public.training_assignments(id) ON DELETE RESTRICT,
  third_level_mode TEXT,
  source_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  source_project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','learning','completed')),
  planned_hours NUMERIC(7,2) NOT NULL CHECK(planned_hours>0),
  required_hours NUMERIC(7,2) NOT NULL CHECK(required_hours>0 AND required_hours<=planned_hours),
  effective_hours NUMERIC(7,2) NOT NULL DEFAULT 0 CHECK(effective_hours>=0),
  plan_version_root_id UUID NOT NULL, plan_version_no INT NOT NULL CHECK(plan_version_no>0),
  course_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(employment_relation_id,level),
  CHECK((level<>'third' AND third_level_mode IS NULL)
    OR (level='third' AND third_level_mode='basic_project' AND source_project_id IS NULL)
    OR (level='third' AND third_level_mode='actual_project' AND source_project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_three_level_records_employee ON public.training_three_level_records(employee_id,employment_relation_id);

CREATE TABLE IF NOT EXISTS public.training_three_level_legacy_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL,
  evidence_source TEXT NOT NULL CHECK(btrim(evidence_source)<>''), evidence_date DATE NOT NULL,
  evidence_reference TEXT, notes TEXT, reviewed_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.training_three_level_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  employment_relation_id UUID NOT NULL, event_type TEXT NOT NULL, old_state JSONB, new_state JSONB NOT NULL,
  notes TEXT, actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.training_three_level_history_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION '[D11:three_level_history_locked] 三级教育历史证据不可修改或删除'; END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_history_immutable() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_three_level_evidence_immutable ON public.training_three_level_legacy_evidence;
CREATE TRIGGER trg_three_level_evidence_immutable BEFORE UPDATE OR DELETE ON public.training_three_level_legacy_evidence
FOR EACH ROW EXECUTE FUNCTION public.training_three_level_history_immutable();
DROP TRIGGER IF EXISTS trg_three_level_audit_immutable ON public.training_three_level_audit_logs;
CREATE TRIGGER trg_three_level_audit_immutable BEFORE UPDATE OR DELETE ON public.training_three_level_audit_logs
FOR EACH ROW EXECUTE FUNCTION public.training_three_level_history_immutable();
CREATE OR REPLACE FUNCTION public.training_three_level_record_completed_guard() RETURNS TRIGGER AS $$
BEGIN IF OLD.status='completed' THEN RAISE EXCEPTION '[D11:three_level_history_locked] 已完成三级教育记录不可修改或删除'; END IF; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_record_completed_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_three_level_record_completed_guard ON public.training_three_level_records;
CREATE TRIGGER trg_three_level_record_completed_guard BEFORE UPDATE OR DELETE ON public.training_three_level_records
FOR EACH ROW EXECUTE FUNCTION public.training_three_level_record_completed_guard();

INSERT INTO public.training_three_level_profiles(employee_id,person_category,onboarding_category,status,employment_started_on,relation_source,notes)
SELECT e.id,
  CASE WHEN public.training_employee_uses_visitor_path(e.id) THEN 'visitor'
    WHEN EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='external')
      AND NOT EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='internal') THEN 'contractor'
    ELSE 'formal_internal' END,
  CASE WHEN public.training_employee_uses_visitor_path(e.id) OR (EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='external')
      AND NOT EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='internal')) THEN 'not_applicable' ELSE 'legacy_evidence_review' END,
  CASE WHEN public.training_employee_uses_visitor_path(e.id) OR (EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='external')
      AND NOT EXISTS(SELECT 1 FROM public.site_project_members m WHERE m.employee_id=e.id AND m.status='active' AND m.membership_type='internal')) THEN 'not_applicable' ELSE 'evidence_review' END,
  e.hire_date,'v83_fail_closed_backfill','存量人员未按创建时间推断；正式员工默认待历史证据审核'
FROM public.training_employees e ON CONFLICT(employee_id) DO NOTHING;

INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,new_state,notes)
SELECT p.employee_id,p.employment_relation_id,'v83_backfill',to_jsonb(p),'存量分类：无证据不视为完成'
FROM public.training_three_level_profiles p
WHERE NOT EXISTS(SELECT 1 FROM public.training_three_level_audit_logs a WHERE a.employee_id=p.employee_id AND a.event_type='v83_backfill');

CREATE OR REPLACE FUNCTION public.training_three_level_can_manage(p_employee_id UUID) RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND EXISTS(SELECT 1 FROM public.training_employees e WHERE e.id=p_employee_id
    AND e.department_id IS NOT NULL AND public.training_can_write(e.department_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
CREATE OR REPLACE FUNCTION public.training_three_level_can_read(p_employee_id UUID) RETURNS BOOLEAN AS $$
  SELECT p_employee_id=public.training_my_employee_id() OR (public.is_admin() AND EXISTS(
    SELECT 1 FROM public.training_employees e WHERE e.id=p_employee_id AND e.department_id IS NOT NULL AND public.training_can_read(e.department_id)));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_can_manage(UUID),public.training_three_level_can_read(UUID) FROM PUBLIC,anon,authenticated;

ALTER TABLE public.training_three_level_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_three_level_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_three_level_legacy_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_three_level_audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS three_level_profiles_read ON public.training_three_level_profiles;
DROP POLICY IF EXISTS three_level_records_read ON public.training_three_level_records;
DROP POLICY IF EXISTS three_level_evidence_read ON public.training_three_level_legacy_evidence;
DROP POLICY IF EXISTS three_level_audit_read ON public.training_three_level_audit_logs;
CREATE POLICY three_level_profiles_read ON public.training_three_level_profiles FOR SELECT TO authenticated USING(public.training_three_level_can_read(employee_id));
CREATE POLICY three_level_records_read ON public.training_three_level_records FOR SELECT TO authenticated USING(public.training_three_level_can_read(employee_id));
CREATE POLICY three_level_evidence_read ON public.training_three_level_legacy_evidence FOR SELECT TO authenticated USING(public.training_three_level_can_read(employee_id));
CREATE POLICY three_level_audit_read ON public.training_three_level_audit_logs FOR SELECT TO authenticated USING(public.training_three_level_can_read(employee_id));
GRANT SELECT ON public.training_three_level_profiles,public.training_three_level_records,public.training_three_level_legacy_evidence,public.training_three_level_audit_logs TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.training_three_level_profiles,public.training_three_level_records,public.training_three_level_legacy_evidence,public.training_three_level_audit_logs FROM authenticated;

CREATE OR REPLACE FUNCTION public.training_set_three_level_classification(
  p_employee_id UUID,p_person_category TEXT,p_onboarding_category TEXT,p_employment_started_on DATE,
  p_relation_source TEXT,p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_old public.training_three_level_profiles; v_relation UUID; v_status TEXT; v_new JSONB;
BEGIN
  IF NOT public.training_three_level_can_manage(p_employee_id) THEN RAISE EXCEPTION '[D11:forbidden] 无权维护人员三级教育分类'; END IF;
  IF NULLIF(btrim(p_relation_source),'') IS NULL THEN RAISE EXCEPTION '[D11:employment_relation_source_required] 必须记录权威用工关系来源'; END IF;
  SELECT * INTO v_old FROM public.training_three_level_profiles WHERE employee_id=p_employee_id FOR UPDATE;
  IF FOUND AND v_old.person_category='formal_internal' AND v_old.status IN('verified','completed')
    AND p_person_category='formal_internal' AND p_onboarding_category<>'new_hire' THEN
    RAISE EXCEPTION '[D11:three_level_history_locked] 已满足的当前用工关系不能降级；重新入职必须建立新关系';
  END IF;
  IF p_person_category='formal_internal' THEN
    IF p_onboarding_category NOT IN('new_hire','legacy_evidence_review','legacy_supplement') THEN RAISE EXCEPTION '[D11:invalid_three_level_classification] 正式员工完成状态只能由服务端完成或历史审核产生'; END IF;
    IF p_onboarding_category='new_hire' AND p_employment_started_on IS NULL THEN RAISE EXCEPTION '[D11:employment_start_required] 新用工关系必须记录开始日期'; END IF;
    v_status:=CASE p_onboarding_category WHEN 'legacy_evidence_review' THEN 'evidence_review' ELSE 'required' END;
  ELSIF p_person_category IN('contractor','temporary_individual','visitor') THEN
    IF p_onboarding_category<>'not_applicable' THEN RAISE EXCEPTION '[D11:invalid_three_level_classification] 非正式员工只能标记三级教育不适用'; END IF;
    v_status:='not_applicable';
  ELSE RAISE EXCEPTION '[D11:invalid_three_level_classification] 人员类别无效'; END IF;
  v_relation:=CASE WHEN NOT FOUND OR p_onboarding_category='new_hire' OR v_old.person_category IS DISTINCT FROM p_person_category
    THEN gen_random_uuid() ELSE v_old.employment_relation_id END;
  INSERT INTO public.training_three_level_profiles(employee_id,employment_relation_id,person_category,onboarding_category,status,
    employment_started_on,relation_source,notes,created_by,updated_by,updated_at)
  VALUES(p_employee_id,v_relation,p_person_category,p_onboarding_category,v_status,p_employment_started_on,btrim(p_relation_source),p_notes,auth.uid(),auth.uid(),NOW())
  ON CONFLICT(employee_id) DO UPDATE SET employment_relation_id=EXCLUDED.employment_relation_id,person_category=EXCLUDED.person_category,
    onboarding_category=EXCLUDED.onboarding_category,status=EXCLUDED.status,employment_started_on=EXCLUDED.employment_started_on,
    relation_source=EXCLUDED.relation_source,notes=EXCLUDED.notes,completed_at=NULL,updated_by=auth.uid(),updated_at=NOW();
  SELECT to_jsonb(p) INTO v_new FROM public.training_three_level_profiles p WHERE employee_id=p_employee_id;
  INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,old_state,new_state,notes,actor_id)
  VALUES(p_employee_id,v_relation,'classification_set',CASE WHEN v_old.employee_id IS NULL THEN NULL ELSE to_jsonb(v_old) END,v_new,p_notes,auth.uid());
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_set_three_level_classification(UUID,TEXT,TEXT,DATE,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_set_three_level_classification(UUID,TEXT,TEXT,DATE,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_confirm_legacy_three_level(
  p_employee_id UUID,p_evidence_source TEXT,p_evidence_date DATE,p_evidence_reference TEXT DEFAULT NULL,p_notes TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_new JSONB;
BEGIN
  IF NOT public.training_three_level_can_manage(p_employee_id) THEN RAISE EXCEPTION '[D11:forbidden] 无权确认历史三级教育'; END IF;
  IF NULLIF(btrim(p_evidence_source),'') IS NULL OR p_evidence_date IS NULL THEN RAISE EXCEPTION '[D11:legacy_evidence_required] 必须填写可核验的历史证据来源和日期'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id FOR UPDATE;
  IF NOT FOUND OR v_profile.person_category<>'formal_internal' OR v_profile.onboarding_category NOT IN('legacy_evidence_review','legacy_supplement') THEN
    RAISE EXCEPTION '[D11:invalid_legacy_evidence_state] 当前人员不处于历史证据确认流程'; END IF;
  INSERT INTO public.training_three_level_legacy_evidence(employee_id,employment_relation_id,evidence_source,evidence_date,evidence_reference,notes,reviewed_by)
  VALUES(p_employee_id,v_profile.employment_relation_id,btrim(p_evidence_source),p_evidence_date,NULLIF(btrim(p_evidence_reference),''),p_notes,auth.uid());
  UPDATE public.training_three_level_profiles SET onboarding_category='legacy_verified',status='verified',completed_at=p_evidence_date::timestamptz,
    notes=p_notes,updated_by=auth.uid(),updated_at=NOW() WHERE employee_id=p_employee_id;
  SELECT to_jsonb(p) INTO v_new FROM public.training_three_level_profiles p WHERE employee_id=p_employee_id;
  INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,old_state,new_state,notes,actor_id)
  VALUES(p_employee_id,v_profile.employment_relation_id,'legacy_evidence_verified',to_jsonb(v_profile),v_new,p_notes,auth.uid());
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_confirm_legacy_three_level(UUID,TEXT,DATE,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_confirm_legacy_three_level(UUID,TEXT,DATE,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_assign_three_level_program(
  p_employee_id UUID,p_company_plan_id UUID,p_entity_plan_id UUID,p_third_plan_id UUID,p_third_level_mode TEXT,p_source_project_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_entity UUID; v_item RECORD; v_plan public.training_plans; v_assignment UUID; v_user UUID; v_courses JSONB;
BEGIN
  IF NOT public.training_three_level_can_manage(p_employee_id) THEN RAISE EXCEPTION '[D11:forbidden] 无权下发三级教育'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id FOR UPDATE;
  IF NOT FOUND OR v_profile.person_category<>'formal_internal' OR v_profile.status NOT IN('required','in_progress') THEN RAISE EXCEPTION '[D11:three_level_not_assignable] 当前人员不需要员工三级教育'; END IF;
  SELECT public.training_department_entity(e.department_id),pr.id INTO v_entity,v_user FROM public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id=e.id WHERE e.id=p_employee_id;
  IF v_entity IS NULL THEN RAISE EXCEPTION '[D11:missing_effective_entity] 无法确定正式员工经营实体'; END IF;
  IF p_third_level_mode NOT IN('basic_project','actual_project') THEN RAISE EXCEPTION '[D11:invalid_third_level_mode] 第三级模式无效'; END IF;
  IF (p_third_level_mode='basic_project' AND p_source_project_id IS NOT NULL) OR (p_third_level_mode='actual_project' AND p_source_project_id IS NULL) THEN RAISE EXCEPTION '[D11:third_level_project_scope_mismatch] 第三级模式与项目范围不一致'; END IF;
  IF p_third_level_mode='actual_project' AND (NOT EXISTS(SELECT 1 FROM public.site_projects WHERE id=p_source_project_id) OR NOT public.site_project_can_manage(p_source_project_id)) THEN RAISE EXCEPTION '[D11:third_level_project_forbidden] 具体项目不存在或超出权限范围'; END IF;
  FOR v_item IN SELECT * FROM (VALUES('company',p_company_plan_id),('entity',p_entity_plan_id),('third',p_third_plan_id)) x(level,plan_id) LOOP
    SELECT * INTO v_plan FROM public.training_plans WHERE id=v_item.plan_id AND publish_status='published';
    IF NOT FOUND OR (v_item.level='company' AND v_plan.level<>'company') OR (v_item.level='entity' AND (v_plan.level<>'entity' OR v_plan.department_id<>v_entity))
      OR (v_item.level='third' AND (v_plan.level<>'project' OR v_plan.third_level_mode<>p_third_level_mode OR v_plan.site_project_id IS DISTINCT FROM p_source_project_id
        OR (p_third_level_mode='basic_project' AND v_plan.department_id<>v_entity))) THEN RAISE EXCEPTION '[D11:plan_scope_mismatch] 三级教育计划范围或模式不匹配'; END IF;
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id) VALUES(v_plan.id,p_employee_id,v_user,(SELECT department_id FROM public.training_employees WHERE id=p_employee_id))
      ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id RETURNING id INTO v_assignment;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'type',c.course_type,'required',c.required,'sort_order',c.sort_order) ORDER BY c.sort_order,c.id),'[]'::jsonb)
      INTO v_courses FROM public.training_courses c WHERE c.plan_id=v_plan.id;
    INSERT INTO public.training_three_level_records(employee_id,employment_relation_id,level,plan_id,assignment_id,third_level_mode,source_entity_id,source_project_id,
      planned_hours,required_hours,plan_version_root_id,plan_version_no,course_snapshot)
    VALUES(p_employee_id,v_profile.employment_relation_id,v_item.level,v_plan.id,v_assignment,CASE WHEN v_item.level='third' THEN p_third_level_mode END,v_entity,
      CASE WHEN v_item.level='third' THEN p_source_project_id END,v_plan.hours,COALESCE(v_plan.required_hours,v_plan.hours),COALESCE(v_plan.version_root_id,v_plan.id),COALESCE(v_plan.version_no,1),v_courses)
    ON CONFLICT(employment_relation_id,level) DO NOTHING;
  END LOOP;
  UPDATE public.training_three_level_profiles SET status='in_progress',updated_by=auth.uid(),updated_at=NOW() WHERE employee_id=p_employee_id;
  INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,new_state,actor_id)
  VALUES(p_employee_id,v_profile.employment_relation_id,'program_assigned',jsonb_build_object('third_level_mode',p_third_level_mode,'source_project_id',p_source_project_id),auth.uid());
  RETURN jsonb_build_object('employee_id',p_employee_id,'employment_relation_id',v_profile.employment_relation_id,'third_level_mode',p_third_level_mode);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_assign_three_level_program(UUID,UUID,UUID,UUID,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_assign_three_level_program(UUID,UUID,UUID,UUID,TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_admission_assignment() RETURNS TRIGGER AS $$
DECLARE v_admission_id UUID; v_profile public.training_three_level_profiles;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.progress IS NOT DISTINCT FROM OLD.progress AND NEW.hours_earned IS NOT DISTINCT FROM OLD.hours_earned THEN RETURN NEW; END IF;
  FOR v_admission_id IN SELECT admission_id FROM public.training_admission_tasks WHERE assignment_id=NEW.id LOOP
    UPDATE public.training_admission_tasks SET status=CASE WHEN NEW.status='completed' THEN 'completed' WHEN NEW.status='learning' OR COALESCE(NEW.progress,0)>0 THEN 'learning' ELSE 'pending' END,
      progress=LEAST(100,GREATEST(0,COALESCE(NEW.progress,0))),effective_hours=COALESCE(NEW.hours_earned,effective_hours),fulfillment_kind=CASE WHEN NEW.status='completed' THEN 'original' ELSE fulfillment_kind END,
      started_at=CASE WHEN NEW.status IN('learning','completed') OR COALESCE(NEW.progress,0)>0 THEN COALESCE(started_at,NOW()) ELSE started_at END,
      completed_at=CASE WHEN NEW.status='completed' THEN COALESCE(completed_at,NEW.completed_at,NOW()) ELSE completed_at END,decision_code=CASE WHEN NEW.status='completed' THEN 'original_completed' ELSE decision_code END,evaluated_at=NOW()
    WHERE admission_id=v_admission_id AND assignment_id=NEW.id;
    PERFORM public.training_recompute_admission_internal(v_admission_id);
  END LOOP;
  SELECT p.* INTO v_profile FROM public.training_three_level_profiles p JOIN public.training_three_level_records r ON r.employment_relation_id=p.employment_relation_id
    WHERE r.assignment_id=NEW.id AND p.employee_id=NEW.employee_id;
  IF FOUND THEN
    UPDATE public.training_three_level_records SET status=CASE WHEN NEW.status='completed' THEN 'completed' WHEN NEW.status='learning' OR COALESCE(NEW.progress,0)>0 THEN 'learning' ELSE 'pending' END,
      effective_hours=COALESCE(NEW.hours_earned,effective_hours),started_at=CASE WHEN NEW.status IN('learning','completed') OR COALESCE(NEW.progress,0)>0 THEN COALESCE(started_at,NOW()) ELSE started_at END,
      completed_at=CASE WHEN NEW.status='completed' THEN COALESCE(completed_at,NEW.completed_at,NOW()) ELSE completed_at END
    WHERE employment_relation_id=v_profile.employment_relation_id AND assignment_id=NEW.id AND status<>'completed';
    IF (SELECT count(*)=3 AND bool_and(status='completed' AND effective_hours>=required_hours) FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id) THEN
      UPDATE public.training_three_level_profiles SET onboarding_category=CASE WHEN onboarding_category='legacy_supplement' THEN 'legacy_supplement_completed' ELSE 'completed' END,
        status='completed',completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE employee_id=v_profile.employee_id;
      IF v_profile.status<>'completed' THEN
        INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,new_state,actor_id)
        SELECT p.employee_id,p.employment_relation_id,'training_completed',to_jsonb(p),COALESCE(auth.uid(),NEW.user_id) FROM public.training_three_level_profiles p WHERE p.employee_id=v_profile.employee_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_sync_admission_assignment() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_employee_uses_visitor_path(p_employee_id UUID) RETURNS BOOLEAN AS $$
  SELECT COALESCE((SELECT p.person_category='visitor' FROM public.training_three_level_profiles p WHERE p.employee_id=p_employee_id),
    COALESCE((SELECT btrim(position)='公司领导' FROM public.training_employees WHERE id=p_employee_id),FALSE));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_employee_uses_visitor_path(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_sync_three_level_tasks_internal(p_admission_id UUID) RETURNS VOID AS $$
DECLARE v_a public.training_admissions;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D11:admission_not_found] 准入记录不存在'; END IF;
  -- v83：项目准入只读取人员基础三级事实，不再按项目制造 company/entity/project 复用或补学行。
  PERFORM public.training_recompute_admission_internal(v_a.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_sync_three_level_tasks_internal(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_status(p_project_id UUID,p_employee_id UUID DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id()); v_profile public.training_three_level_profiles; v_levels JSONB; v_reason TEXT; v_satisfied BOOLEAN:=FALSE;
BEGIN
  IF v_employee IS NULL OR NOT (v_employee=public.training_my_employee_id() OR (p_project_id IS NOT NULL AND public.site_project_can_read(p_project_id)) OR public.training_three_level_can_read(v_employee)) THEN RAISE EXCEPTION '[D11:forbidden] 无权查看人员三级教育状态'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=v_employee;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','training','three_level_applicable',TRUE,'person_category','ambiguous_internal',
      'onboarding_category','legacy_evidence_review','supplement_required',TRUE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','legacy_three_level_evidence_review_required','levels','[]'::jsonb);
  END IF;
  IF v_profile.person_category='visitor' THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','visitor','three_level_applicable',FALSE,
    'person_category','visitor','onboarding_category','not_applicable','supplement_required',FALSE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','visitor_safety_briefing_required','levels','[]'::jsonb); END IF;
  IF v_profile.person_category<>'formal_internal' THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','project_admission','three_level_applicable',FALSE,
    'person_category',v_profile.person_category,'onboarding_category','not_applicable','supplement_required',FALSE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','three_level_not_applicable','exam_prerequisite_reason_code','three_level_not_applicable_use_project_admission_path','levels','[]'::jsonb); END IF;
  v_satisfied:=v_profile.status IN('verified','completed');
  IF v_profile.onboarding_category='legacy_evidence_review' THEN v_reason:='legacy_three_level_evidence_review_required';
  ELSIF v_profile.onboarding_category='legacy_supplement' AND v_profile.status='required' THEN v_reason:='legacy_three_level_supplement_required';
  ELSIF v_profile.onboarding_category='legacy_verified' THEN v_reason:='legacy_three_level_verified';
  ELSIF v_profile.onboarding_category='legacy_supplement_completed' THEN v_reason:='legacy_three_level_supplement_completed';
  ELSIF v_profile.status='completed' THEN v_reason:='three_level_training_completed';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='company' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_company_training';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='entity' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_entity_training';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='third' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_third_level_training';
  ELSE v_reason:='new_employee_three_level_required'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('level',r.level,'state',r.status,'reason_code',CASE WHEN r.status='completed' AND r.effective_hours>=r.required_hours THEN 'satisfied' ELSE 'incomplete_effective_hours' END,
    'items',jsonb_build_array(jsonb_build_object('record_id',r.id,'plan_id',r.plan_id,'plan_title',p.title,'version_root_id',r.plan_version_root_id,'version_no',r.plan_version_no,
      'status',r.status,'third_level_mode',r.third_level_mode,'source_entity_id',r.source_entity_id,'source_project_id',r.source_project_id,'planned_hours',r.planned_hours,
      'required_hours',r.required_hours,'effective_hours',r.effective_hours,'started_at',r.started_at,'completed_at',r.completed_at,'courses',r.course_snapshot))) ORDER BY CASE r.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END),'[]'::jsonb)
    INTO v_levels FROM public.training_three_level_records r JOIN public.training_plans p ON p.id=r.plan_id WHERE r.employment_relation_id=v_profile.employment_relation_id;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'employment_relation_id',v_profile.employment_relation_id,'path','training','three_level_applicable',TRUE,
    'person_category','formal_internal','onboarding_category',v_profile.onboarding_category,'supplement_required',v_profile.onboarding_category IN('legacy_evidence_review','legacy_supplement'),
    'overall_satisfied',v_satisfied,'exam_allowed',v_satisfied,'reason_code',v_reason,'completed_at',v_profile.completed_at,'levels',v_levels);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_status(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_status(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_exam_gate_internal(p_admission_id UUID) RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_status JSONB; v_reason TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D11:admission_not_found] 准入记录不存在'; END IF;
  v_status:=public.training_three_level_status(v_a.project_id,v_a.employee_id);
  v_reason:=CASE WHEN COALESCE((v_status->>'three_level_applicable')::boolean,FALSE)=FALSE AND v_status->>'person_category'<>'visitor'
    THEN 'three_level_not_applicable_use_project_admission_path' ELSE v_status->>'reason_code' END;
  RETURN jsonb_build_object('allowed',COALESCE((v_status->>'exam_allowed')::boolean,FALSE),'reason_code',v_reason,'status',v_status);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_exam_gate_internal(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_prepare_admission_exam(p_admission_id UUID) RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_plan UUID; v_assignment UUID; v_gate JSONB;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id FOR UPDATE;
  IF NOT FOUND OR v_a.employee_id IS DISTINCT FROM public.training_my_employee_id() THEN RAISE EXCEPTION '[D11:forbidden] 准入记录不存在或无权操作'; END IF;
  v_gate:=public.training_three_level_exam_gate_internal(p_admission_id);
  IF NOT (v_gate->>'allowed')::boolean THEN RAISE EXCEPTION '[D11:%] 三级教育前置条件未满足',v_gate->>'reason_code'; END IF;
  IF EXISTS(SELECT 1 FROM public.training_admission_tasks WHERE admission_id=p_admission_id AND status<>'completed' AND level NOT IN('company','entity','project')) THEN RAISE EXCEPTION '[D11:incomplete_required_training] 请先完成其他必修项目准入培训'; END IF;
  SELECT exam_plan_id INTO v_plan FROM public.training_admission_packages WHERE id=v_a.package_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION '[D11:missing_exam_plan] 培训包尚未配置综合准入考试'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.exam_papers WHERE plan_id=v_plan AND status='published') THEN RAISE EXCEPTION '[D11:missing_exam_paper] 综合准入考试尚未发布试卷'; END IF;
  INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id,exam_status)
  SELECT v_plan,e.id,pr.id,e.department_id,'pending' FROM public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id=e.id WHERE e.id=v_a.employee_id
  ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id RETURNING id INTO v_assignment;
  BEGIN UPDATE public.training_admissions SET exam_assignment_id=v_assignment,exam_required=TRUE,updated_at=NOW() WHERE id=p_admission_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION '[D11:ambiguous_admission_exam_binding] 综合考试任务已绑定其他准入记录'; END;
  RETURN jsonb_build_object('plan_id',v_plan,'assignment_id',v_assignment);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_prepare_admission_exam(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_prepare_admission_exam(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_save_plan_draft(p_plan_id UUID,p_plan JSONB,p_target_department_ids UUID[] DEFAULT ARRAY[]::UUID[])
RETURNS JSONB AS $$
DECLARE v_id UUID:=COALESCE(p_plan_id,gen_random_uuid()); v_level TEXT:=COALESCE(NULLIF(p_plan->>'level',''),'entity');
  v_department UUID:=NULLIF(p_plan->>'department_id','')::UUID; v_project UUID:=NULLIF(p_plan->>'site_project_id','')::UUID;
  v_special TEXT:=NULLIF(btrim(p_plan->>'special_type'),''); v_third TEXT:=NULLIF(p_plan->>'third_level_mode','');
  v_status TEXT; v_target UUID; v_targets UUID[]:=COALESCE(p_target_department_ids,ARRAY[]::UUID[]);
BEGIN
  IF NULLIF(btrim(p_plan->>'title'),'') IS NULL THEN RAISE EXCEPTION '培训名称不能为空'; END IF;
  IF v_level='project' AND v_third IS NULL AND v_project IS NOT NULL THEN v_third:='actual_project'; END IF;
  IF v_level<>'project' THEN v_third:=NULL; END IF;
  IF NOT public.training_plan_row_can_write(v_level,v_department,v_project) THEN RAISE EXCEPTION '您无权维护该培训计划范围'; END IF;
  IF v_level='entity' AND NOT EXISTS(SELECT 1 FROM public.departments WHERE id=v_department AND dept_type='entity') THEN RAISE EXCEPTION '经营实体级计划必须绑定经营实体'; END IF;
  IF v_level='project' AND v_third='basic_project' AND (v_project IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.departments WHERE id=v_department AND dept_type='entity')) THEN RAISE EXCEPTION '[D11:third_level_project_scope_mismatch] 基本项目级必须绑定经营实体且不绑定项目'; END IF;
  IF v_level='project' AND v_third='actual_project' AND (v_department IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.site_projects WHERE id=v_project)) THEN RAISE EXCEPTION '[D11:third_level_project_scope_mismatch] 具体项目级必须绑定正式项目'; END IF;
  IF v_level='project' AND v_third NOT IN('basic_project','actual_project') THEN RAISE EXCEPTION '[D11:invalid_third_level_mode] 项目级计划必须明确第三级模式'; END IF;
  IF v_level='special' AND v_special IS NULL THEN RAISE EXCEPTION '专项培训必须填写专项类型'; END IF;
  IF v_level IN('project','special') AND cardinality(v_targets)>0 THEN RAISE EXCEPTION '项目或专项范围不得用部门 targets 替代权威范围'; END IF;
  FOREACH v_target IN ARRAY v_targets LOOP IF NOT public.training_plan_target_can_use(v_target) THEN RAISE EXCEPTION '下发部门超出您的管理范围'; END IF; END LOOP;
  IF p_plan_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.training_plans WHERE id=p_plan_id) THEN
    SELECT approval_status INTO v_status FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
    IF v_status NOT IN('draft','rejected') OR public.training_plan_is_locked(p_plan_id) THEN RAISE EXCEPTION '只有未形成历史的草稿或驳回计划可以维护'; END IF;
    UPDATE public.training_plans SET title=btrim(p_plan->>'title'),level=v_level,department_id=v_department,site_project_id=v_project,
      third_level_mode=v_third,special_type=v_special,category=NULLIF(btrim(p_plan->>'category'),''),plan_year=COALESCE((p_plan->>'plan_year')::INT,EXTRACT(YEAR FROM CURRENT_DATE)::INT),
      start_date=NULLIF(p_plan->>'start_date','')::DATE,end_date=NULLIF(p_plan->>'end_date','')::DATE,hours=NULLIF(p_plan->>'hours','')::NUMERIC,
      required_hours=NULLIF(p_plan->>'required_hours','')::NUMERIC,deadline=NULLIF(p_plan->>'deadline','')::DATE,trainer=NULLIF(btrim(p_plan->>'trainer'),''),
      location=NULLIF(btrim(p_plan->>'location'),''),status=COALESCE(NULLIF(p_plan->>'status',''),'planned'),exam_mode=COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'),
      target_desc=NULLIF(btrim(p_plan->>'target_desc'),''),content=NULLIF(btrim(p_plan->>'content'),''),remark=NULLIF(btrim(p_plan->>'remark'),'') WHERE id=p_plan_id;
  ELSE
    INSERT INTO public.training_plans(id,title,level,department_id,site_project_id,third_level_mode,special_type,category,plan_year,start_date,end_date,hours,required_hours,
      deadline,trainer,location,status,exam_mode,target_desc,content,remark,created_by)
    VALUES(v_id,btrim(p_plan->>'title'),v_level,v_department,v_project,v_third,v_special,NULLIF(btrim(p_plan->>'category'),''),COALESCE((p_plan->>'plan_year')::INT,EXTRACT(YEAR FROM CURRENT_DATE)::INT),
      NULLIF(p_plan->>'start_date','')::DATE,NULLIF(p_plan->>'end_date','')::DATE,NULLIF(p_plan->>'hours','')::NUMERIC,NULLIF(p_plan->>'required_hours','')::NUMERIC,
      NULLIF(p_plan->>'deadline','')::DATE,NULLIF(btrim(p_plan->>'trainer'),''),NULLIF(btrim(p_plan->>'location'),''),COALESCE(NULLIF(p_plan->>'status',''),'planned'),
      COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'),NULLIF(btrim(p_plan->>'target_desc'),''),NULLIF(btrim(p_plan->>'content'),''),NULLIF(btrim(p_plan->>'remark'),''),auth.uid());
  END IF;
  DELETE FROM public.training_plan_targets WHERE plan_id=v_id;
  INSERT INTO public.training_plan_targets(plan_id,department_id) SELECT v_id,x FROM unnest(v_targets) x GROUP BY x;
  RETURN jsonb_build_object('plan_id',v_id,'target_count',cardinality(v_targets),'third_level_mode',v_third);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_save_plan_draft(UUID,JSONB,UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_save_plan_draft(UUID,JSONB,UUID[]) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;

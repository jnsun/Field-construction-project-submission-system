-- D09-2：四类权威计划范围、服务端学时约束、草稿与 targets 原子保存。
BEGIN;

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS site_project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS special_type TEXT;

ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_level_check;
UPDATE public.training_plans SET level = 'entity' WHERE level = 'dept';
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_level_check
  CHECK (level IN ('company', 'entity', 'project', 'special'));

ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_scope_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_scope_check CHECK (
  (level = 'company' AND department_id IS NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level = 'entity' AND department_id IS NOT NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level = 'project' AND department_id IS NULL AND site_project_id IS NOT NULL AND special_type IS NULL)
  OR (level = 'special' AND special_type IS NOT NULL AND btrim(special_type) <> ''
      AND ((department_id IS NOT NULL) <> (site_project_id IS NOT NULL)))
) NOT VALID;

ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_hours_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_hours_check
  CHECK (hours IS NULL OR hours > 0) NOT VALID;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_required_hours_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_required_hours_check
  CHECK (required_hours IS NULL OR (required_hours > 0 AND hours IS NOT NULL AND required_hours <= hours)) NOT VALID;
ALTER TABLE public.training_courses DROP CONSTRAINT IF EXISTS training_courses_page_count_check;
ALTER TABLE public.training_courses ADD CONSTRAINT training_courses_page_count_check
  CHECK (page_count IS NULL OR page_count > 0) NOT VALID;
ALTER TABLE public.training_courses DROP CONSTRAINT IF EXISTS training_courses_duration_sec_check;
ALTER TABLE public.training_courses ADD CONSTRAINT training_courses_duration_sec_check
  CHECK (duration_sec IS NULL OR duration_sec > 0) NOT VALID;
ALTER TABLE public.training_assignments DROP CONSTRAINT IF EXISTS training_assignments_hours_earned_check;
ALTER TABLE public.training_assignments ADD CONSTRAINT training_assignments_hours_earned_check
  CHECK (hours_earned IS NULL OR hours_earned >= 0) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_plan_row_can_write(
  p_level TEXT, p_department_id UUID, p_site_project_id UUID
) RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND CASE p_level
    WHEN 'company' THEN p_department_id IS NULL AND p_site_project_id IS NULL
                        AND public.training_is_company_admin()
    WHEN 'entity' THEN p_department_id IS NOT NULL AND p_site_project_id IS NULL
                       AND public.training_can_write(p_department_id)
    WHEN 'project' THEN p_department_id IS NULL AND p_site_project_id IS NOT NULL
                        AND public.site_project_can_manage(p_site_project_id)
    WHEN 'special' THEN (p_department_id IS NOT NULL AND p_site_project_id IS NULL
                          AND public.training_can_write(p_department_id))
                     OR (p_department_id IS NULL AND p_site_project_id IS NOT NULL
                          AND public.site_project_can_manage(p_site_project_id))
    ELSE FALSE
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS tr_plan_insert ON public.training_plans;
DROP POLICY IF EXISTS tr_plan_update ON public.training_plans;
DROP POLICY IF EXISTS tr_plan_delete ON public.training_plans;
DROP FUNCTION IF EXISTS public.training_plan_row_can_write(TEXT, UUID);
REVOKE ALL ON FUNCTION public.training_plan_row_can_write(TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_plan_row_can_write(TEXT, UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_admin_can_read(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id = p_plan_id AND CASE p.level
      WHEN 'company' THEN public.training_is_company_admin()
      WHEN 'entity' THEN public.training_can_read(p.department_id)
      WHEN 'project' THEN public.site_project_can_read(p.site_project_id)
      WHEN 'special' THEN CASE WHEN p.site_project_id IS NOT NULL
        THEN public.site_project_can_read(p.site_project_id)
        ELSE public.training_can_read(p.department_id) END
      ELSE FALSE END
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_plan_admin_can_read(UUID) FROM PUBLIC, anon, authenticated;

CREATE POLICY tr_plan_insert ON public.training_plans FOR INSERT TO authenticated
  WITH CHECK (public.training_plan_row_can_write(level, department_id, site_project_id));
CREATE POLICY tr_plan_update ON public.training_plans FOR UPDATE TO authenticated
  USING (public.training_plan_row_can_write(level, department_id, site_project_id))
  WITH CHECK (public.training_plan_row_can_write(level, department_id, site_project_id));
CREATE POLICY tr_plan_delete ON public.training_plans FOR DELETE TO authenticated
  USING (public.training_plan_row_can_write(level, department_id, site_project_id));

CREATE OR REPLACE FUNCTION public.training_plan_target_can_use(p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.departments d
    WHERE d.id = p_department_id
      AND d.dept_type IN ('entity', 'internal', 'project')
      AND (public.training_is_company_admin() OR public.training_can_write(d.id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_plan_target_can_use(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_save_plan_draft(
  p_plan_id UUID,
  p_plan JSONB,
  p_target_department_ids UUID[] DEFAULT ARRAY[]::UUID[]
) RETURNS JSONB AS $$
DECLARE
  v_id UUID := COALESCE(p_plan_id, gen_random_uuid());
  v_level TEXT := COALESCE(NULLIF(p_plan->>'level', ''), 'entity');
  v_department UUID := NULLIF(p_plan->>'department_id', '')::UUID;
  v_project UUID := NULLIF(p_plan->>'site_project_id', '')::UUID;
  v_special TEXT := NULLIF(btrim(p_plan->>'special_type'), '');
  v_status TEXT;
  v_target UUID;
  v_targets UUID[] := COALESCE(p_target_department_ids, ARRAY[]::UUID[]);
BEGIN
  IF NULLIF(btrim(p_plan->>'title'), '') IS NULL THEN RAISE EXCEPTION '培训名称不能为空'; END IF;
  IF NOT public.training_plan_row_can_write(v_level, v_department, v_project) THEN RAISE EXCEPTION '您无权维护该培训计划范围'; END IF;
  IF v_level = 'entity' AND NOT EXISTS (SELECT 1 FROM public.departments WHERE id=v_department AND dept_type='entity') THEN
    RAISE EXCEPTION '经营实体级计划必须绑定经营实体';
  END IF;
  IF v_level = 'project' AND NOT EXISTS (SELECT 1 FROM public.site_projects WHERE id=v_project) THEN RAISE EXCEPTION '项目级计划必须绑定正式项目'; END IF;
  IF v_level = 'special' AND v_special IS NULL THEN RAISE EXCEPTION '专项培训必须填写专项类型'; END IF;
  IF v_level IN ('project', 'special') AND cardinality(v_targets) > 0 THEN RAISE EXCEPTION '项目或专项范围不得用部门 targets 替代权威范围'; END IF;
  FOREACH v_target IN ARRAY v_targets LOOP
    IF NOT public.training_plan_target_can_use(v_target) THEN RAISE EXCEPTION '下发部门超出您的管理范围'; END IF;
  END LOOP;

  IF p_plan_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_plans WHERE id=p_plan_id) THEN
    SELECT approval_status INTO v_status FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
    IF v_status NOT IN ('draft', 'rejected') OR public.training_plan_is_locked(p_plan_id) THEN
      RAISE EXCEPTION '只有未形成历史的草稿或驳回计划可以维护';
    END IF;
    UPDATE public.training_plans SET
      title=btrim(p_plan->>'title'), level=v_level, department_id=v_department,
      site_project_id=v_project, special_type=v_special,
      category=NULLIF(btrim(p_plan->>'category'), ''),
      plan_year=COALESCE((p_plan->>'plan_year')::INT, EXTRACT(YEAR FROM CURRENT_DATE)::INT),
      start_date=NULLIF(p_plan->>'start_date', '')::DATE, end_date=NULLIF(p_plan->>'end_date', '')::DATE,
      hours=NULLIF(p_plan->>'hours', '')::NUMERIC, required_hours=NULLIF(p_plan->>'required_hours', '')::NUMERIC,
      deadline=NULLIF(p_plan->>'deadline', '')::DATE, trainer=NULLIF(btrim(p_plan->>'trainer'), ''),
      location=NULLIF(btrim(p_plan->>'location'), ''), status=COALESCE(NULLIF(p_plan->>'status',''),'planned'),
      exam_mode=COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'), target_desc=NULLIF(btrim(p_plan->>'target_desc'), ''),
      content=NULLIF(btrim(p_plan->>'content'), ''), remark=NULLIF(btrim(p_plan->>'remark'), '')
    WHERE id=p_plan_id;
  ELSE
    INSERT INTO public.training_plans(id,title,level,department_id,site_project_id,special_type,category,plan_year,
      start_date,end_date,hours,required_hours,deadline,trainer,location,status,exam_mode,target_desc,content,remark,created_by)
    VALUES(v_id,btrim(p_plan->>'title'),v_level,v_department,v_project,v_special,NULLIF(btrim(p_plan->>'category'),''),
      COALESCE((p_plan->>'plan_year')::INT,EXTRACT(YEAR FROM CURRENT_DATE)::INT),NULLIF(p_plan->>'start_date','')::DATE,
      NULLIF(p_plan->>'end_date','')::DATE,NULLIF(p_plan->>'hours','')::NUMERIC,NULLIF(p_plan->>'required_hours','')::NUMERIC,
      NULLIF(p_plan->>'deadline','')::DATE,NULLIF(btrim(p_plan->>'trainer'),''),NULLIF(btrim(p_plan->>'location'),''),
      COALESCE(NULLIF(p_plan->>'status',''),'planned'),COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'),
      NULLIF(btrim(p_plan->>'target_desc'),''),NULLIF(btrim(p_plan->>'content'),''),NULLIF(btrim(p_plan->>'remark'),''),auth.uid());
  END IF;

  DELETE FROM public.training_plan_targets WHERE plan_id=v_id;
  INSERT INTO public.training_plan_targets(plan_id,department_id)
    SELECT v_id,x FROM unnest(v_targets) x GROUP BY x;
  RETURN jsonb_build_object('plan_id',v_id,'target_count',cardinality(v_targets));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_save_plan_draft(UUID, JSONB, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_save_plan_draft(UUID, JSONB, UUID[]) TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.training_plan_targets FROM authenticated;
GRANT SELECT ON TABLE public.training_plan_targets TO authenticated;
DROP POLICY IF EXISTS tr_target_insert ON public.training_plan_targets;
DROP POLICY IF EXISTS tr_target_update ON public.training_plan_targets;
DROP POLICY IF EXISTS tr_target_delete ON public.training_plan_targets;

-- 学习状态和有效学时只能由既有 SECURITY DEFINER 学习/考试 RPC 写入。
REVOKE INSERT, UPDATE, DELETE ON TABLE public.training_assignments FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.training_course_progress FROM authenticated;

CREATE OR REPLACE FUNCTION public.training_assignment_effective_hours_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_required NUMERIC;
  v_effective NUMERIC;
BEGIN
  IF (NEW.status,NEW.completed_at,NEW.hours_earned)
     IS NOT DISTINCT FROM (OLD.status,OLD.completed_at,OLD.hours_earned) THEN RETURN NEW; END IF;
  SELECT p.required_hours,
         COALESCE(SUM(l.effective_sec),0)::NUMERIC / 3600
    INTO v_required,v_effective
  FROM public.training_plans p
  LEFT JOIN public.training_courses c ON c.plan_id=p.id
  LEFT JOIN public.training_study_logs l ON l.course_id=c.id AND l.employee_id=NEW.employee_id
  WHERE p.id=NEW.plan_id GROUP BY p.required_hours;
  NEW.hours_earned := round(LEAST(COALESCE(v_required,v_effective),v_effective),2);
  IF NEW.status='completed' AND (v_required IS NULL OR v_effective < v_required) THEN
    NEW.status := CASE WHEN NEW.progress > 0 THEN 'learning' ELSE 'pending' END;
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_assignment_effective_hours_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_assignment_effective_hours_guard ON public.training_assignments;
CREATE TRIGGER trg_training_assignment_effective_hours_guard
  BEFORE UPDATE ON public.training_assignments FOR EACH ROW
  EXECUTE FUNCTION public.training_assignment_effective_hours_guard();

NOTIFY pgrst, 'reload schema';
COMMIT;

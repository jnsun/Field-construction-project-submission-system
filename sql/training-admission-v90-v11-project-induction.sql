-- D00-D13 V1.1 compatibility: project induction stays separate from employee three-level education.
BEGIN;

UPDATE public.training_plans SET training_category='basic_three_level'
WHERE third_level_mode IS NOT NULL OR EXISTS(SELECT 1 FROM public.training_three_level_records r WHERE r.plan_id=training_plans.id);

ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_third_level_mode_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_third_level_mode_check CHECK(
  (level<>'project' AND third_level_mode IS NULL)
  OR (level='project' AND training_category='basic_three_level' AND third_level_mode='basic_project' AND department_id IS NOT NULL AND site_project_id IS NULL)
  OR (level='project' AND training_category='basic_three_level' AND third_level_mode='actual_project' AND department_id IS NULL AND site_project_id IS NOT NULL)
  OR (level='project' AND training_category='project_induction' AND third_level_mode IS NULL AND department_id IS NULL AND site_project_id IS NOT NULL)
) NOT VALID;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_scope_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_scope_check CHECK(
  (level='company' AND department_id IS NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level='entity' AND department_id IS NOT NULL AND site_project_id IS NULL AND special_type IS NULL)
  OR (level='project' AND special_type IS NULL AND ((training_category='project_induction' AND third_level_mode IS NULL AND department_id IS NULL AND site_project_id IS NOT NULL)
    OR (training_category='basic_three_level' AND third_level_mode='basic_project' AND department_id IS NOT NULL AND site_project_id IS NULL)
    OR (training_category='basic_three_level' AND third_level_mode='actual_project' AND department_id IS NULL AND site_project_id IS NOT NULL)))
  OR (level='special' AND special_type IS NOT NULL AND btrim(special_type)<>'' AND ((department_id IS NOT NULL)<>(site_project_id IS NOT NULL)))
) NOT VALID;

CREATE OR REPLACE FUNCTION public.training_plan_third_level_mode_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.level='special' AND NEW.training_category='continuing_or_change' THEN
    SELECT category INTO NEW.training_category FROM public.special_requirement_catalog WHERE special_type=public.training_special_type_code(NEW.special_type);
  ELSIF NEW.level='project' AND NEW.training_category='continuing_or_change' THEN NEW.training_category:='basic_three_level';
  END IF;
  IF NEW.training_category='project_induction' THEN NEW.level:='project'; NEW.third_level_mode:=NULL; NEW.department_id:=NULL;
  ELSIF NEW.training_category='basic_three_level' AND NEW.level='project' AND NEW.third_level_mode IS NULL AND NEW.site_project_id IS NOT NULL THEN NEW.third_level_mode:='actual_project';
  ELSIF NEW.level<>'project' THEN NEW.third_level_mode:=NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_plan_third_level_mode_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_plan_third_level_mode ON public.training_plans;
CREATE TRIGGER trg_training_plan_third_level_mode BEFORE INSERT OR UPDATE OF level,department_id,site_project_id,third_level_mode,training_category
ON public.training_plans FOR EACH ROW EXECUTE FUNCTION public.training_plan_third_level_mode_guard();

ALTER TABLE public.training_admission_tasks ADD COLUMN IF NOT EXISTS training_category TEXT;
UPDATE public.training_admission_tasks t SET training_category=p.training_category FROM public.training_plans p WHERE p.id=t.plan_id AND t.training_category IS NULL;
ALTER TABLE public.training_admission_tasks ALTER COLUMN training_category SET DEFAULT 'continuing_or_change';
ALTER TABLE public.training_admission_tasks ALTER COLUMN training_category SET NOT NULL;
ALTER TABLE public.training_admission_tasks ADD CONSTRAINT training_admission_tasks_v11_category_check CHECK(training_category IN('basic_three_level','project_induction','project_special','special_operation','continuing_or_change')) NOT VALID;
CREATE OR REPLACE FUNCTION public.training_admission_task_category_guard() RETURNS TRIGGER AS $$
BEGIN SELECT training_category INTO NEW.training_category FROM public.training_plans WHERE id=NEW.plan_id; RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_admission_task_category_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_admission_task_category ON public.training_admission_tasks;
CREATE TRIGGER trg_training_admission_task_category BEFORE INSERT OR UPDATE OF plan_id ON public.training_admission_tasks FOR EACH ROW EXECUTE FUNCTION public.training_admission_task_category_guard();

CREATE OR REPLACE FUNCTION public.training_save_plan_draft(p_plan_id UUID,p_plan JSONB,p_target_department_ids UUID[] DEFAULT ARRAY[]::UUID[])
RETURNS JSONB AS $$
DECLARE v_id UUID:=COALESCE(p_plan_id,gen_random_uuid()); v_level TEXT:=COALESCE(NULLIF(p_plan->>'level',''),'entity');
 v_category TEXT:=COALESCE(NULLIF(p_plan->>'training_category',''),'continuing_or_change'); v_department UUID:=NULLIF(p_plan->>'department_id','')::UUID;
 v_project UUID:=NULLIF(p_plan->>'site_project_id','')::UUID; v_special TEXT:=public.training_special_type_code(p_plan->>'special_type');
 v_third TEXT:=NULLIF(p_plan->>'third_level_mode',''); v_status TEXT; v_target UUID; v_targets UUID[]:=COALESCE(p_target_department_ids,ARRAY[]::UUID[]);
BEGIN
  IF NULLIF(btrim(p_plan->>'title'),'') IS NULL THEN RAISE EXCEPTION '培训名称不能为空'; END IF;
  IF v_category NOT IN('basic_three_level','project_induction','project_special','special_operation','continuing_or_change') THEN RAISE EXCEPTION '[V11:invalid_training_category] 培训类别无效'; END IF;
  IF v_category='project_induction' THEN v_level:='project';v_third:=NULL;v_department:=NULL;
  ELSIF v_level='project' AND v_category='basic_three_level' AND v_third IS NULL AND v_project IS NOT NULL THEN v_third:='actual_project'; END IF;
  IF v_level<>'project' THEN v_third:=NULL; END IF;
  IF NOT public.training_plan_row_can_write(v_level,v_department,v_project) THEN RAISE EXCEPTION '您无权维护该培训计划范围'; END IF;
  IF v_level='entity' AND NOT EXISTS(SELECT 1 FROM public.departments WHERE id=v_department AND dept_type='entity') THEN RAISE EXCEPTION '经营实体级计划必须绑定经营实体'; END IF;
  IF v_category='project_induction' AND NOT EXISTS(SELECT 1 FROM public.site_projects WHERE id=v_project) THEN RAISE EXCEPTION '[V11:project_induction_scope_mismatch] 项目入场教育必须绑定正式项目'; END IF;
  IF v_category='basic_three_level' AND v_level='project' AND v_third='basic_project' AND (v_project IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.departments WHERE id=v_department AND dept_type='entity')) THEN RAISE EXCEPTION '[D11:third_level_project_scope_mismatch] 基本项目级必须绑定经营实体且不绑定项目'; END IF;
  IF v_category='basic_three_level' AND v_level='project' AND v_third='actual_project' AND (v_department IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.site_projects WHERE id=v_project)) THEN RAISE EXCEPTION '[D11:third_level_project_scope_mismatch] 具体项目级必须绑定正式项目'; END IF;
  IF v_category='basic_three_level' AND v_level='project' AND v_third NOT IN('basic_project','actual_project') THEN RAISE EXCEPTION '[D11:invalid_third_level_mode] 基础三级教育项目级计划必须明确第三级模式'; END IF;
  IF v_level='special' AND v_special IS NULL THEN RAISE EXCEPTION '专项培训必须选择有效专项目录项'; END IF;
  IF v_level IN('project','special') AND cardinality(v_targets)>0 THEN RAISE EXCEPTION '项目或专项范围不得用部门 targets 替代权威范围'; END IF;
  FOREACH v_target IN ARRAY v_targets LOOP IF NOT public.training_plan_target_can_use(v_target) THEN RAISE EXCEPTION '下发部门超出您的管理范围'; END IF; END LOOP;
  IF p_plan_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.training_plans WHERE id=p_plan_id) THEN
    SELECT approval_status INTO v_status FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
    IF v_status NOT IN('draft','rejected') OR public.training_plan_is_locked(p_plan_id) THEN RAISE EXCEPTION '只有未形成历史的草稿或驳回计划可以维护'; END IF;
    UPDATE public.training_plans SET title=btrim(p_plan->>'title'),level=v_level,training_category=v_category,department_id=v_department,site_project_id=v_project,
      third_level_mode=v_third,special_type=v_special,category=NULLIF(btrim(p_plan->>'category'),''),plan_year=COALESCE((p_plan->>'plan_year')::INT,EXTRACT(YEAR FROM CURRENT_DATE)::INT),
      start_date=NULLIF(p_plan->>'start_date','')::DATE,end_date=NULLIF(p_plan->>'end_date','')::DATE,hours=NULLIF(p_plan->>'hours','')::NUMERIC,
      required_hours=NULLIF(p_plan->>'required_hours','')::NUMERIC,deadline=NULLIF(p_plan->>'deadline','')::DATE,trainer=NULLIF(btrim(p_plan->>'trainer'),''),
      location=NULLIF(btrim(p_plan->>'location'),''),status=COALESCE(NULLIF(p_plan->>'status',''),'planned'),exam_mode=COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'),
      target_desc=NULLIF(btrim(p_plan->>'target_desc'),''),content=NULLIF(btrim(p_plan->>'content'),''),remark=NULLIF(btrim(p_plan->>'remark'),'') WHERE id=p_plan_id;
  ELSE
    INSERT INTO public.training_plans(id,title,level,training_category,department_id,site_project_id,third_level_mode,special_type,category,plan_year,start_date,end_date,hours,required_hours,
      deadline,trainer,location,status,exam_mode,target_desc,content,remark,created_by)
    VALUES(v_id,btrim(p_plan->>'title'),v_level,v_category,v_department,v_project,v_third,v_special,NULLIF(btrim(p_plan->>'category'),''),COALESCE((p_plan->>'plan_year')::INT,EXTRACT(YEAR FROM CURRENT_DATE)::INT),
      NULLIF(p_plan->>'start_date','')::DATE,NULLIF(p_plan->>'end_date','')::DATE,NULLIF(p_plan->>'hours','')::NUMERIC,NULLIF(p_plan->>'required_hours','')::NUMERIC,
      NULLIF(p_plan->>'deadline','')::DATE,NULLIF(btrim(p_plan->>'trainer'),''),NULLIF(btrim(p_plan->>'location'),''),COALESCE(NULLIF(p_plan->>'status',''),'planned'),
      COALESCE(NULLIF(p_plan->>'exam_mode',''),'none'),NULLIF(btrim(p_plan->>'target_desc'),''),NULLIF(btrim(p_plan->>'content'),''),NULLIF(btrim(p_plan->>'remark'),''),auth.uid());
  END IF;
  DELETE FROM public.training_plan_targets WHERE plan_id=v_id;
  INSERT INTO public.training_plan_targets(plan_id,department_id) SELECT v_id,x FROM unnest(v_targets) x GROUP BY x;
  RETURN jsonb_build_object('plan_id',v_id,'target_count',cardinality(v_targets),'training_category',v_category,'third_level_mode',v_third);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_save_plan_draft(UUID,JSONB,UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_save_plan_draft(UUID,JSONB,UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.site_project_set_risk_tags(p_project_id UUID,p_risk_tags TEXT[],p_reason TEXT)
RETURNS JSONB AS $$
DECLARE v_tag TEXT; v_drilling BOOLEAN; v_reason TEXT:=NULLIF(btrim(p_reason),'');
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '[V11:risk_tags_forbidden] 无项目风险标签管理权限'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION '[V11:risk_tags_reason_required] 必须填写变更原因'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(COALESCE(p_risk_tags,ARRAY[]::TEXT[])) x WHERE NOT EXISTS(SELECT 1 FROM public.project_risk_catalog c WHERE c.risk_tag=x AND c.enabled)) THEN RAISE EXCEPTION '[V11:risk_tag_invalid] 风险标签无效'; END IF;
  FOR v_tag IN SELECT risk_tag FROM public.project_risk_catalog WHERE enabled LOOP
    INSERT INTO public.site_project_risk_tags(project_id,risk_tag,active,effective_at,changed_at,changed_by,reason)
    VALUES(p_project_id,v_tag,v_tag=ANY(COALESCE(p_risk_tags,ARRAY[]::TEXT[])),NOW(),NOW(),public.training_current_account_subject_id(),v_reason)
    ON CONFLICT(project_id,risk_tag) DO UPDATE SET active=EXCLUDED.active,changed_at=NOW(),changed_by=EXCLUDED.changed_by,reason=EXCLUDED.reason;
  END LOOP;
  v_drilling:='drilling'=ANY(COALESCE(p_risk_tags,ARRAY[]::TEXT[]));
  IF (SELECT includes_drilling FROM public.site_projects WHERE id=p_project_id) IS DISTINCT FROM v_drilling THEN PERFORM public.site_project_set_drilling_operation(p_project_id,v_drilling,v_reason); END IF;
  RETURN jsonb_build_object('project_id',p_project_id,'risk_tags',to_jsonb(COALESCE(p_risk_tags,ARRAY[]::TEXT[])),'changed',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.site_project_set_risk_tags(UUID,TEXT[],TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.site_project_set_risk_tags(UUID,TEXT[],TEXT) TO authenticated;

COMMIT;

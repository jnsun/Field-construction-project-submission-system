-- S3-D: cut D11 production requirements over to the immutable S3-B snapshot.
BEGIN;

ALTER TABLE public.training_requirement_snapshots
  ALTER COLUMN organization_assignment_id DROP NOT NULL,
  ALTER COLUMN organization_unit_id DROP NOT NULL,
  ALTER COLUMN matched_applicability_rule_id DROP NOT NULL,
  ALTER COLUMN scheme_id DROP NOT NULL,
  ALTER COLUMN scheme_version_id DROP NOT NULL;
ALTER TABLE public.training_requirement_snapshot_items
  ALTER COLUMN training_package_id DROP NOT NULL,
  ALTER COLUMN training_package_version_id DROP NOT NULL,
  ALTER COLUMN training_package_version_no DROP NOT NULL;
ALTER TABLE public.training_requirement_snapshot_events
  ALTER COLUMN matched_applicability_rule_id DROP NOT NULL,
  ALTER COLUMN scheme_version_id DROP NOT NULL;

ALTER TABLE public.training_requirement_snapshots ADD CONSTRAINT training_requirement_snapshot_source_shape CHECK(
  (source='authoritative_resolver' AND organization_assignment_id IS NOT NULL AND organization_unit_id IS NOT NULL
    AND matched_applicability_rule_id IS NOT NULL AND scheme_id IS NOT NULL AND scheme_version_id IS NOT NULL)
  OR source='legacy_d11_compatibility');
ALTER TABLE public.training_requirement_snapshot_items ADD CONSTRAINT training_requirement_snapshot_item_package_shape CHECK(
  (training_package_id IS NOT NULL AND training_package_version_id=training_package_id AND training_package_version_no IS NOT NULL)
  OR (training_package_id IS NULL AND training_package_version_id IS NULL AND training_package_version_no IS NULL));

ALTER TABLE public.training_three_level_records
  ADD COLUMN requirement_snapshot_id UUID REFERENCES public.training_requirement_snapshots(id) ON DELETE RESTRICT,
  ADD COLUMN requirement_snapshot_item_id UUID REFERENCES public.training_requirement_snapshot_items(id) ON DELETE RESTRICT,
  ADD COLUMN stage_type TEXT,
  ADD COLUMN organization_unit_id UUID REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  ADD COLUMN training_package_id UUID REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  ADD COLUMN training_package_version_no INTEGER;
ALTER TABLE public.training_three_level_records DROP CONSTRAINT training_three_level_records_check;
ALTER TABLE public.training_three_level_records DROP CONSTRAINT IF EXISTS training_three_level_records_check1;
ALTER TABLE public.training_three_level_records ADD CONSTRAINT training_three_level_records_stage_scope_check CHECK(
  (level<>'third' AND third_level_mode IS NULL)
  OR (level='third' AND third_level_mode IN('basic_project','department_position','logistics_position','entity_position') AND source_project_id IS NULL)
  OR (level='third' AND third_level_mode='actual_project' AND source_project_id IS NOT NULL));
ALTER TABLE public.training_three_level_records ADD CONSTRAINT training_three_level_records_snapshot_stage_check CHECK(
  stage_type IS NULL OR stage_type IN('company','organization','basic_project','actual_project','department_position','logistics_position','entity_position'));

CREATE FUNCTION public.training_create_legacy_three_level_snapshot_internal(p_employee_id UUID) RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_snapshot public.training_requirement_snapshots; v_assignment public.employment_organization_assignments;
  v_record public.training_three_level_records; v_item_id UUID; v_package public.training_admission_packages; v_order SMALLINT; v_stage_type TEXT;
BEGIN
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id FOR UPDATE;
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE employment_relation_id=v_profile.employment_relation_id AND requirement_type='basic_three_level';
  IF FOUND THEN RETURN public.training_requirement_snapshot_json(v_snapshot.id)||jsonb_build_object('reused',TRUE); END IF;
  IF v_profile.employee_id IS NULL OR v_profile.person_category<>'formal_internal' OR v_profile.status NOT IN('required','in_progress')
     OR NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id) THEN RETURN NULL; END IF;
  SELECT * INTO v_assignment FROM public.employment_organization_assignments WHERE employment_relation_id=v_profile.employment_relation_id
    AND effective_from<=CURRENT_DATE AND (effective_to IS NULL OR effective_to>=CURRENT_DATE) ORDER BY version_no DESC LIMIT 1;
  INSERT INTO public.training_requirement_snapshots(employee_id,subject_id,employment_relation_id,organization_assignment_id,organization_unit_id,
    matched_applicability_rule_id,scheme_id,scheme_version_id,effective_as_of,reason_code,explanation,source,operator_subject_id,authority_facts)
  VALUES(p_employee_id,(SELECT id FROM public.account_subjects WHERE employee_id=p_employee_id ORDER BY created_at LIMIT 1),v_profile.employment_relation_id,
    v_assignment.id,v_assignment.organization_unit_id,NULL,NULL,NULL,CURRENT_DATE,'legacy_d11_compatibility',
    '切换前已开始的真实 D11 三级教育任务按原计划和版本冻结','legacy_d11_compatibility',public.training_current_account_subject_id(),
    jsonb_build_object('employee_id',p_employee_id,'employment_relation_id',v_profile.employment_relation_id,'source','existing_training_three_level_records')) RETURNING * INTO v_snapshot;
  FOR v_record IN SELECT * FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id ORDER BY CASE level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END LOOP
    v_order:=CASE v_record.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END;
    v_stage_type:=CASE v_record.level WHEN 'company' THEN 'company' WHEN 'entity' THEN 'organization' ELSE v_record.third_level_mode END;
    SELECT p.* INTO v_package FROM public.training_admission_package_items i JOIN public.training_admission_packages p ON p.id=i.package_id
      WHERE i.plan_id=v_record.plan_id AND i.required AND p.status='published' AND p.training_category='basic_three_level'
      ORDER BY p.created_at,p.id LIMIT 1;
    INSERT INTO public.training_requirement_snapshot_items(snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,
      training_package_version_no,required,site_project_id,requirement_metadata)
    VALUES(v_snapshot.id,v_order,CASE v_record.level WHEN 'entity' THEN 'organization' ELSE v_record.level END,v_stage_type,v_package.id,v_package.id,v_package.version_no,TRUE,
      CASE WHEN v_stage_type='actual_project' THEN v_record.source_project_id END,
      jsonb_build_object('legacy_record_id',v_record.id,'legacy_plan_id',v_record.plan_id,'legacy_plan_version_root_id',v_record.plan_version_root_id,
        'legacy_plan_version_no',v_record.plan_version_no,'planned_hours',v_record.planned_hours,'required_hours',v_record.required_hours)) RETURNING id INTO v_item_id;
    UPDATE public.training_three_level_records SET requirement_snapshot_id=v_snapshot.id,requirement_snapshot_item_id=v_item_id,
      stage_type=v_stage_type,organization_unit_id=v_assignment.organization_unit_id,training_package_id=v_package.id,training_package_version_no=v_package.version_no
      WHERE id=v_record.id AND status<>'completed';
  END LOOP;
  INSERT INTO public.training_requirement_snapshot_events(snapshot_id,event_type,resolver_version,matched_applicability_rule_id,scheme_version_id,
    operator_subject_id,actor_source,authority_facts)
  VALUES(v_snapshot.id,'generated','legacy-d11-compatibility-v1',NULL,NULL,public.training_current_account_subject_id(),
    CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'authenticated_user' END,v_snapshot.authority_facts);
  RETURN public.training_requirement_snapshot_json(v_snapshot.id)||jsonb_build_object('reused',FALSE);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE employment_relation_id=v_profile.employment_relation_id AND requirement_type='basic_three_level';
  RETURN public.training_requirement_snapshot_json(v_snapshot.id)||jsonb_build_object('reused',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_materialize_three_level_snapshot_internal(p_snapshot_id UUID) RETURNS JSONB AS $$
DECLARE v_snapshot public.training_requirement_snapshots; v_item public.training_requirement_snapshot_items; v_plan public.training_plans;
  v_plan_id UUID; v_count INTEGER; v_assignment UUID; v_user UUID; v_courses JSONB; v_level TEXT; v_required NUMERIC;
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_snapshot_id FOR SHARE;
  IF v_snapshot.id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason_code','requirement_snapshot_not_found'); END IF;
  IF v_snapshot.source='legacy_d11_compatibility' THEN RETURN public.training_requirement_snapshot_json(v_snapshot.id); END IF;
  FOR v_item IN SELECT * FROM public.training_requirement_snapshot_items WHERE snapshot_id=p_snapshot_id AND required ORDER BY stage_order LOOP
    SELECT count(*),min(p.id::text)::uuid INTO v_count,v_plan_id
    FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id=i.plan_id
    WHERE i.package_id=v_item.training_package_id AND i.required AND p.publish_status='published' AND p.training_category='basic_three_level'
      AND i.level=CASE v_item.stage_level WHEN 'organization' THEN 'entity' WHEN 'third' THEN 'project' ELSE 'company' END;
    IF v_count<>1 THEN RETURN jsonb_build_object('status','blocked','reason_code','snapshot_package_plan_invalid','snapshot_id',p_snapshot_id,'stage_order',v_item.stage_order); END IF;
  END LOOP;
  SELECT id INTO v_user FROM public.profiles WHERE employee_id=v_snapshot.employee_id ORDER BY id LIMIT 1;
  FOR v_item IN SELECT * FROM public.training_requirement_snapshot_items WHERE snapshot_id=p_snapshot_id AND required ORDER BY stage_order LOOP
    SELECT p.* INTO v_plan FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id=i.plan_id
    WHERE i.package_id=v_item.training_package_id AND i.required AND p.publish_status='published' AND p.training_category='basic_three_level'
      AND i.level=CASE v_item.stage_level WHEN 'organization' THEN 'entity' WHEN 'third' THEN 'project' ELSE 'company' END LIMIT 1;
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
    SELECT v_plan.id,e.id,v_user,e.department_id FROM public.training_employees e WHERE e.id=v_snapshot.employee_id
    ON CONFLICT(plan_id,employee_id) DO UPDATE SET user_id=EXCLUDED.user_id,department_id=EXCLUDED.department_id RETURNING id INTO v_assignment;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'type',c.course_type,'required',c.required,'sort_order',c.sort_order) ORDER BY c.sort_order,c.id),'[]'::jsonb)
      INTO v_courses FROM public.training_courses c WHERE c.plan_id=v_plan.id;
    v_level:=CASE v_item.stage_level WHEN 'organization' THEN 'entity' ELSE v_item.stage_level END;
    v_required:=COALESCE(CASE WHEN jsonb_typeof(v_item.minimum_study_value)='number' THEN (v_item.minimum_study_value#>>'{}')::numeric END,v_plan.required_hours,v_plan.hours);
    INSERT INTO public.training_three_level_records(employee_id,employment_relation_id,level,plan_id,assignment_id,third_level_mode,source_entity_id,source_project_id,
      planned_hours,required_hours,plan_version_root_id,plan_version_no,course_snapshot,requirement_snapshot_id,requirement_snapshot_item_id,stage_type,
      organization_unit_id,training_package_id,training_package_version_no)
    VALUES(v_snapshot.employee_id,v_snapshot.employment_relation_id,v_level,v_plan.id,v_assignment,CASE WHEN v_level='third' THEN v_item.stage_type END,NULL,v_item.site_project_id,
      GREATEST(v_plan.hours,v_required),v_required,COALESCE(v_plan.version_root_id,v_plan.id),COALESCE(v_plan.version_no,1),v_courses,v_snapshot.id,v_item.id,v_item.stage_type,
      v_snapshot.organization_unit_id,v_item.training_package_id,v_item.training_package_version_no)
    ON CONFLICT(employment_relation_id,level) DO NOTHING;
  END LOOP;
  UPDATE public.training_three_level_profiles SET status='in_progress',updated_by=auth.uid(),updated_at=NOW()
    WHERE employee_id=v_snapshot.employee_id AND status='required';
  INSERT INTO public.training_three_level_audit_logs(employee_id,employment_relation_id,event_type,new_state,actor_id)
  SELECT v_snapshot.employee_id,v_snapshot.employment_relation_id,'snapshot_program_assigned',
    jsonb_build_object('snapshot_id',v_snapshot.id,'source',v_snapshot.source,'scheme_version_id',v_snapshot.scheme_version_id),auth.uid()
  WHERE NOT EXISTS(SELECT 1 FROM public.training_three_level_audit_logs WHERE employment_relation_id=v_snapshot.employment_relation_id AND event_type='snapshot_program_assigned');
  RETURN public.training_requirement_snapshot_json(v_snapshot.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_ensure_three_level_requirement(p_employee_id UUID,p_site_project_id UUID DEFAULT NULL,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_snapshot JSONB; v_snapshot_id UUID;
BEGIN
  IF p_employee_id IS NULL OR NOT public.training_three_level_resolution_can_read(p_employee_id,p_site_project_id) THEN
    RAISE EXCEPTION '[S3D:forbidden] 无权生成或读取该人员三级教育要求' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id FOR UPDATE;
  IF v_profile.employee_id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason_code','employment_relation_required'); END IF;
  IF v_profile.person_category<>'formal_internal' THEN RETURN jsonb_build_object('status','not_applicable','reason_code','three_level_not_applicable'); END IF;
  IF v_profile.status IN('verified','completed') OR v_profile.onboarding_category IN('legacy_verified','legacy_supplement_completed','completed') THEN
    RETURN jsonb_build_object('status','satisfied','reason_code',CASE WHEN v_profile.onboarding_category='legacy_verified' THEN 'legacy_three_level_verified' WHEN v_profile.onboarding_category='legacy_supplement_completed' THEN 'legacy_three_level_supplement_completed' ELSE 'three_level_training_completed' END,
      'employee_id',p_employee_id,'employment_relation_id',v_profile.employment_relation_id,'reused',TRUE);
  END IF;
  SELECT id INTO v_snapshot_id FROM public.training_requirement_snapshots WHERE employment_relation_id=v_profile.employment_relation_id AND requirement_type='basic_three_level';
  IF v_snapshot_id IS NULL AND EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id) THEN
    v_snapshot:=public.training_create_legacy_three_level_snapshot_internal(p_employee_id); v_snapshot_id:=NULLIF(v_snapshot->>'id','')::uuid;
  END IF;
  IF v_snapshot_id IS NULL THEN
    v_snapshot:=public.generate_three_level_training_requirement_snapshot(p_employee_id,v_profile.employment_relation_id,CURRENT_DATE,p_site_project_id,p_request_id);
    v_snapshot_id:=NULLIF(v_snapshot->>'id','')::uuid;
    IF v_snapshot_id IS NULL THEN RETURN v_snapshot; END IF;
  END IF;
  v_snapshot:=public.training_materialize_three_level_snapshot_internal(v_snapshot_id);
  RETURN v_snapshot||jsonb_build_object('production_authority','requirement_snapshot');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_assign_three_level_program(
  p_employee_id UUID,p_company_plan_id UUID,p_entity_plan_id UUID,p_third_plan_id UUID,p_third_level_mode TEXT,p_source_project_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_result JSONB;
BEGIN
  IF NOT public.training_three_level_can_manage(p_employee_id) THEN RAISE EXCEPTION '[D11:forbidden] 无权下发三级教育'; END IF;
  v_result:=public.training_ensure_three_level_requirement(p_employee_id,p_source_project_id,NULL);
  IF NULLIF(v_result->>'id','') IS NULL AND v_result->>'status'<>'satisfied' THEN RAISE EXCEPTION '[S3D:%] 配置驱动三级教育要求未生成',v_result->>'reason_code'; END IF;
  RETURN v_result||jsonb_build_object('legacy_plan_arguments_ignored',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_three_level_status(p_project_id UUID,p_employee_id UUID DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id()); v_profile public.training_three_level_profiles; v_levels JSONB; v_reason TEXT;
  v_satisfied BOOLEAN:=FALSE; v_ensure JSONB; v_snapshot public.training_requirement_snapshots;
BEGIN
  IF v_employee IS NULL OR NOT (v_employee=public.training_my_employee_id() OR (p_project_id IS NOT NULL AND public.site_project_can_read(p_project_id)) OR public.training_three_level_can_read(v_employee)) THEN RAISE EXCEPTION '[D11:forbidden] 无权查看人员三级教育状态'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=v_employee;
  IF NOT FOUND THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','training','three_level_applicable',TRUE,'person_category','ambiguous_internal','onboarding_category','legacy_evidence_review','supplement_required',TRUE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','legacy_three_level_evidence_review_required','levels','[]'::jsonb); END IF;
  IF v_profile.person_category='visitor' THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','visitor','three_level_applicable',FALSE,'person_category','visitor','onboarding_category','not_applicable','supplement_required',FALSE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','visitor_safety_briefing_required','levels','[]'::jsonb); END IF;
  IF v_profile.person_category<>'formal_internal' THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'path','project_admission','three_level_applicable',FALSE,'person_category',v_profile.person_category,'onboarding_category','not_applicable','supplement_required',FALSE,'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code','three_level_not_applicable','exam_prerequisite_reason_code','three_level_not_applicable_use_project_admission_path','levels','[]'::jsonb); END IF;
  v_satisfied:=v_profile.status IN('verified','completed') OR v_profile.onboarding_category IN('legacy_verified','legacy_supplement_completed','completed');
  IF NOT v_satisfied AND v_profile.onboarding_category NOT IN('legacy_evidence_review') THEN
    v_ensure:=public.training_ensure_three_level_requirement(v_employee,p_project_id,NULL);
    IF NULLIF(v_ensure->>'id','') IS NULL THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'employment_relation_id',v_profile.employment_relation_id,
      'path','training','three_level_applicable',TRUE,'person_category','formal_internal','onboarding_category',v_profile.onboarding_category,'supplement_required',v_profile.onboarding_category='legacy_supplement',
      'overall_satisfied',FALSE,'exam_allowed',FALSE,'reason_code',v_ensure->>'reason_code','resolver',v_ensure,'levels','[]'::jsonb); END IF;
    SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=v_employee;
  END IF;
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE employment_relation_id=v_profile.employment_relation_id AND requirement_type='basic_three_level';
  IF v_profile.onboarding_category='legacy_evidence_review' THEN v_reason:='legacy_three_level_evidence_review_required';
  ELSIF v_profile.onboarding_category='legacy_supplement' AND v_profile.status='required' THEN v_reason:='legacy_three_level_supplement_required';
  ELSIF v_profile.onboarding_category='legacy_verified' THEN v_reason:='legacy_three_level_verified';
  ELSIF v_profile.onboarding_category='legacy_supplement_completed' THEN v_reason:='legacy_three_level_supplement_completed';
  ELSIF v_profile.status='completed' THEN v_reason:='three_level_training_completed';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='company' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_company_training';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='entity' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_organization_training';
  ELSIF NOT EXISTS(SELECT 1 FROM public.training_three_level_records WHERE employment_relation_id=v_profile.employment_relation_id AND level='third' AND status='completed' AND effective_hours>=required_hours) THEN v_reason:='missing_third_level_training';
  ELSE v_reason:='new_employee_three_level_required'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('level',CASE r.level WHEN 'entity' THEN 'organization' ELSE r.level END,'state',r.status,
    'stage_type',COALESCE(r.stage_type,CASE r.level WHEN 'company' THEN 'company' WHEN 'entity' THEN 'organization' ELSE r.third_level_mode END),
    'reason_code',CASE WHEN r.status='completed' AND r.effective_hours>=r.required_hours THEN 'satisfied' ELSE 'incomplete_effective_hours' END,
    'items',jsonb_build_array(jsonb_build_object('record_id',r.id,'plan_id',r.plan_id,'plan_title',p.title,'version_root_id',r.plan_version_root_id,'version_no',r.plan_version_no,
      'status',r.status,'stage_type',COALESCE(r.stage_type,r.third_level_mode),'third_level_mode',r.third_level_mode,'organization_unit_id',COALESCE(r.organization_unit_id,v_snapshot.organization_unit_id),
      'organization_name',(SELECT name FROM public.organization_units WHERE id=COALESCE(r.organization_unit_id,v_snapshot.organization_unit_id)),
      'training_package_title',pkg.title,'training_package_version_no',COALESCE(r.training_package_version_no,pkg.version_no),
      'source_project_id',r.source_project_id,'planned_hours',r.planned_hours,'required_hours',r.required_hours,'effective_hours',r.effective_hours,
      'started_at',r.started_at,'completed_at',r.completed_at,'courses',r.course_snapshot))) ORDER BY CASE r.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 ELSE 3 END),'[]'::jsonb)
    INTO v_levels FROM public.training_three_level_records r JOIN public.training_plans p ON p.id=r.plan_id LEFT JOIN public.training_admission_packages pkg ON pkg.id=r.training_package_id
    WHERE r.employment_relation_id=v_profile.employment_relation_id;
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'employment_relation_id',v_profile.employment_relation_id,'path','training','three_level_applicable',TRUE,
    'person_category','formal_internal','onboarding_category',v_profile.onboarding_category,'supplement_required',v_profile.onboarding_category IN('legacy_evidence_review','legacy_supplement'),
    'overall_satisfied',v_satisfied,'exam_allowed',v_satisfied,'reason_code',v_reason,'completed_at',v_profile.completed_at,'levels',v_levels,
    'requirement_snapshot_id',v_snapshot.id,'requirement_source',v_snapshot.source,'scheme_id',v_snapshot.scheme_id,'scheme_version_id',v_snapshot.scheme_version_id,
    'scheme_version_number',(SELECT version_number FROM public.three_level_training_scheme_versions WHERE id=v_snapshot.scheme_version_id),
    'scheme_name',(SELECT display_name FROM public.three_level_training_schemes WHERE id=v_snapshot.scheme_id),
    'organization_unit_id',v_snapshot.organization_unit_id,'organization_name',(SELECT name FROM public.organization_units WHERE id=v_snapshot.organization_unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_three_level_exam_gate(p_admission_id UUID) RETURNS JSONB AS $$
DECLARE v_a public.training_admissions;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND OR NOT (v_a.employee_id=public.training_my_employee_id() OR public.site_project_can_read(v_a.project_id)) THEN
    RAISE EXCEPTION '[D11:forbidden] 无权检查该准入考试条件'; END IF;
  RETURN public.training_three_level_exam_gate_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_three_level_resolution_shadow(p_employee_id UUID,p_employment_relation_id UUID,p_project_id UUID DEFAULT NULL,p_as_of DATE DEFAULT CURRENT_DATE) RETURNS JSONB AS $$
DECLARE v_new JSONB; v_profile public.training_three_level_profiles;
BEGIN
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id AND employment_relation_id=p_employment_relation_id;
  v_new:=public.resolve_three_level_training_scheme(p_employee_id,p_employment_relation_id,p_as_of,p_project_id);
  RETURN jsonb_build_object('old',jsonb_build_object('overall_satisfied',COALESCE(v_profile.status IN('verified','completed'),FALSE),
    'onboarding_category',v_profile.onboarding_category,'existing_record_count',(SELECT count(*) FROM public.training_three_level_records WHERE employment_relation_id=p_employment_relation_id)),
    'new',v_new,'comparison',jsonb_build_object('production_cutover',TRUE,'authority','requirement_snapshot'));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION public.training_create_legacy_three_level_snapshot_internal(UUID),public.training_materialize_three_level_snapshot_internal(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.training_ensure_three_level_requirement(UUID,UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_ensure_three_level_requirement(UUID,UUID,TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.training_three_level_status(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_status(UUID,UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.training_three_level_exam_gate_internal(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.training_three_level_exam_gate(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_exam_gate(UUID) TO authenticated;

COMMENT ON FUNCTION public.training_assign_three_level_program(UUID,UUID,UUID,UUID,TEXT,UUID) IS 'S3-D compatibility wrapper; client plan arguments are ignored and the authoritative resolver snapshot selects content.';
COMMENT ON FUNCTION public.training_three_level_status(UUID,UUID) IS 'S3-D authoritative D11 status; first production need generates/reuses one immutable requirement snapshot and materializes its stages.';
COMMENT ON FUNCTION public.training_exam_context_internal(UUID,TEXT,TEXT) IS 'D13 admission prerequisite consumes authoritative D11 training_three_level_status; project induction and D12 special exams remain independent.';

COMMIT;

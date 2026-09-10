-- D13 R02-1: account lifecycle and object-level authorization boundaries.
BEGIN;

CREATE OR REPLACE FUNCTION public.training_project_person_effective_entity(
  p_project_id UUID, p_employee_id UUID
) RETURNS UUID AS $$
  SELECT CASE
    WHEN m.membership_type='external' THEN public.contractor_company_effective_entity(m.contractor_id)
    WHEN m.membership_type='temporary' THEN p.lead_entity_id
    ELSE COALESCE(public.training_department_entity(e.department_id),p.lead_entity_id)
  END
  FROM public.site_project_members m
  JOIN public.site_projects p ON p.id=m.project_id
  JOIN public.training_employees e ON e.id=m.employee_id
  WHERE m.project_id=p_project_id AND m.employee_id=p_employee_id
  ORDER BY (m.status='active') DESC,m.joined_at DESC,m.id DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_project_person_effective_entity(UUID,UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_project_person_can_read(
  p_project_id UUID, p_employee_id UUID
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_employee_id=public.training_my_employee_id()
    OR public.training_is_company_admin()
    OR EXISTS (
      SELECT 1 FROM public.site_project_roles r
      WHERE r.project_id=p_project_id AND r.user_id=auth.uid() AND r.active
        AND r.role IN('project_manager','safety_officer')
    )
    OR (
      public.is_entity_manager()
      AND public.training_my_dept_id() IS NOT NULL
      AND public.training_my_dept_id()=public.training_project_person_effective_entity(p_project_id,p_employee_id)
    )
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_project_person_can_read(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_project_person_can_read(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_resolution_can_read(
  p_employee_id UUID,p_site_project_id UUID DEFAULT NULL
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_employee_id=public.training_my_employee_id()
    OR public.training_scheme_is_company_admin()
    OR public.training_three_level_can_read(p_employee_id)
    OR (
      p_site_project_id IS NOT NULL
      AND public.training_project_person_can_read(p_site_project_id,p_employee_id)
      AND EXISTS (
        SELECT 1 FROM public.site_project_members m
        WHERE m.project_id=p_site_project_id AND m.employee_id=p_employee_id AND m.status='active'
      )
    )
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_resolution_can_read(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_three_level_resolution_can_read(UUID,UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.generate_three_level_training_requirement_snapshot(UUID,UUID,DATE,UUID,TEXT)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_primary_admission_path(p_project_id UUID,p_employee_id UUID)
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'project_id',p.project_id,'employee_id',p.employee_id,'primary_path',p.primary_path,
    'active',p.active,'effective_at',p.effective_at,'version_no',p.version_no,'source',p.source
  )
  FROM public.project_person_admission_paths p
  WHERE p.project_id=p_project_id AND p.employee_id=p_employee_id
    AND public.training_project_person_can_read(p.project_id,p.employee_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_primary_admission_path(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_primary_admission_path(UUID,UUID) TO authenticated;

DROP POLICY IF EXISTS admission_paths_read ON public.project_person_admission_paths;
CREATE POLICY admission_paths_read ON public.project_person_admission_paths
  FOR SELECT TO authenticated USING(public.training_project_person_can_read(project_id,employee_id));
DROP POLICY IF EXISTS admission_path_history_read ON public.project_person_admission_path_history;
CREATE POLICY admission_path_history_read ON public.project_person_admission_path_history
  FOR SELECT TO authenticated USING(public.training_project_person_can_read(project_id,employee_id));

CREATE OR REPLACE FUNCTION public.training_exam_requirement_context(
  p_admission_id UUID,p_exam_type TEXT,p_special_type TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v public.training_admissions; v_path TEXT; v_type TEXT;
BEGIN
  SELECT * INTO v FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D13:exam_not_found] 准入记录不存在'; END IF;
  IF NOT public.training_project_person_can_read(v.project_id,v.employee_id) THEN
    RAISE EXCEPTION '[D13:forbidden] 无权查看该考试要求' USING ERRCODE='42501';
  END IF;
  v_path:=public.training_primary_admission_path(v.project_id,v.employee_id)->>'primary_path';
  v_type:=CASE WHEN p_exam_type='special' THEN 'special_exam' WHEN v_path='employee' THEN 'employee_comprehensive_admission_exam' ELSE 'project_induction_exam' END;
  RETURN jsonb_build_object('admission_id',v.id,'project_id',v.project_id,'employee_id',v.employee_id,'primary_admission_path',v_path,
    'exam_semantic_type',v_type,'legacy_exam_type',p_exam_type,'special_type',public.training_special_type_code(p_special_type));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_exam_requirement_context(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_exam_requirement_context(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_employees_batch_delete(p_ids UUID[])
RETURNS JSONB AS $$
DECLARE v_employee public.training_employees; v_user UUID; v_result JSONB;
  v_processed INTEGER:=0; v_deactivated INTEGER:=0; v_accounts_closed INTEGER:=0;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids)=0 THEN RAISE EXCEPTION '[V11:account_invalid_request] 请先选择要停用的员工'; END IF;
  FOR v_employee IN SELECT * FROM public.training_employees WHERE id=ANY(p_ids) ORDER BY id FOR UPDATE LOOP
    IF NOT public.training_three_level_can_manage(v_employee.id) THEN
      RAISE EXCEPTION '[V11:account_forbidden] 无人员管理权限' USING ERRCODE='42501';
    END IF;
    SELECT p.id INTO v_user FROM public.profiles p WHERE p.employee_id=v_employee.id ORDER BY p.id LIMIT 1;
    IF v_user IS NOT NULL THEN
      v_result:=public.training_account_set_status(v_user,'closed','批量关闭员工登录身份',NULL,NULL);
      IF COALESCE((v_result->>'changed')::boolean,FALSE) THEN v_accounts_closed:=v_accounts_closed+1; END IF;
    END IF;
    IF v_employee.status<>'left' THEN
      PERFORM set_config('app.personnel_change_source','employee_batch_deactivate_rpc',TRUE);
      UPDATE public.training_employees SET status='left',updated_at=NOW() WHERE id=v_employee.id;
      v_deactivated:=v_deactivated+1;
    END IF;
    v_processed:=v_processed+1;
  END LOOP;
  IF v_processed<>cardinality(p_ids) THEN RAISE EXCEPTION '[V11:account_not_found] 部分员工不存在'; END IF;
  RETURN jsonb_build_object('processed',v_processed,'deactivated',v_deactivated,'accounts_closed',v_accounts_closed,
    'deleted',0,'accounts',0,'physical_delete',FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_employees_batch_delete(UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_employees_batch_delete(UUID[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_three_level_status(p_project_id UUID,p_employee_id UUID DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id()); v_profile public.training_three_level_profiles; v_levels JSONB; v_reason TEXT;
  v_satisfied BOOLEAN:=FALSE; v_ensure JSONB; v_snapshot public.training_requirement_snapshots;
BEGIN
  IF v_employee IS NULL OR NOT public.training_three_level_resolution_can_read(v_employee,p_project_id) THEN RAISE EXCEPTION '[D11:forbidden] 无权查看人员三级教育状态'; END IF;
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
    'organization_unit_id',v_snapshot.organization_unit_id,'organization_name',(SELECT name FROM public.organization_units WHERE id=v_snapshot.organization_unit_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_three_level_status(UUID,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_three_level_status(UUID,UUID) TO authenticated;

COMMIT;

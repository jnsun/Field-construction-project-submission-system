-- D16 R02: close the legacy confirmation bypass and materialize applicable D15 requirements.
BEGIN;

REVOKE ALL ON FUNCTION public.training_confirm_site(UUID,TEXT,NUMERIC,NUMERIC,TEXT,TEXT)
  FROM PUBLIC,anon,authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE public.training_site_confirmations
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_site_confirmation_prerequisite_internal(
  p_requirement public.training_site_confirmation_requirements
) RETURNS JSONB AS $$
DECLARE v_project public.site_projects; v_member public.site_project_members; v_admission public.training_admissions;
  v_path TEXT; v_three JSONB; v_special JSONB; v_signature JSONB:=jsonb_build_object('status','not_applicable','reason_code','signature_not_applicable');
  v_snapshot UUID; v_signature_cycle UUID; v_semantic TEXT; v_exam_plan UUID; v_reasons JSONB:='[]'::jsonb;
BEGIN
  SELECT * INTO v_project FROM public.site_projects WHERE id=p_requirement.project_id;
  SELECT * INTO v_member FROM public.site_project_members WHERE id=p_requirement.member_id;
  SELECT * INTO v_admission FROM public.training_admissions WHERE id=p_requirement.admission_id;
  SELECT primary_path INTO v_path FROM public.project_person_admission_paths
    WHERE project_id=p_requirement.project_id AND employee_id=p_requirement.employee_id AND active
    ORDER BY effective_at DESC,version_no DESC LIMIT 1;
  IF v_project.id IS NULL OR v_project.status<>'active' THEN v_reasons:=v_reasons||jsonb_build_array('project_not_active'); END IF;
  IF v_member.id IS NULL OR v_member.project_id<>p_requirement.project_id OR v_member.employee_id<>p_requirement.employee_id OR v_member.status<>'active' THEN
    v_reasons:=v_reasons||jsonb_build_array('membership_not_active'); END IF;
  IF v_admission.id IS NULL OR v_admission.project_id<>p_requirement.project_id OR v_admission.employee_id<>p_requirement.employee_id
    OR v_admission.member_id IS DISTINCT FROM p_requirement.member_id THEN v_reasons:=v_reasons||jsonb_build_array('admission_binding_mismatch'); END IF;
  IF v_path IS NULL OR v_path='visitor' OR v_path<>p_requirement.primary_admission_path THEN v_reasons:=v_reasons||jsonb_build_array('admission_path_not_applicable'); END IF;
  IF v_path='employee' THEN
    v_three:=public.training_three_level_status(p_requirement.project_id,p_requirement.employee_id);
    IF NOT COALESCE((v_three->>'overall_satisfied')::boolean,FALSE) THEN v_reasons:=v_reasons||jsonb_build_array('three_level_training_not_completed'); END IF;
    v_snapshot:=NULLIF(v_three->>'requirement_snapshot_id','')::uuid;
    IF v_snapshot IS NOT NULL THEN
      v_signature:=public.training_signature_ensure_requirements(v_snapshot,p_requirement.admission_id,'d16:'||p_requirement.id::text);
      IF v_signature->>'status'='required' THEN
        v_signature_cycle:=NULLIF(v_signature->>'requirement_cycle_id','')::uuid;
        IF v_signature_cycle IS NULL OR EXISTS(
          SELECT 1 FROM public.training_signature_requirements s
          WHERE s.requirement_cycle_id=v_signature_cycle AND s.required AND s.status<>'signed'
        ) THEN v_reasons:=v_reasons||jsonb_build_array('required_signature_not_completed'); END IF;
      ELSIF v_signature->>'status'<>'not_required' THEN
        v_reasons:=v_reasons||jsonb_build_array('required_signature_not_completed');
      END IF;
    END IF;
  END IF;
  v_semantic:=CASE WHEN v_path='employee' THEN 'employee_comprehensive_admission_exam' ELSE 'project_induction_exam' END;
  SELECT exam_plan_id INTO v_exam_plan FROM public.training_admission_packages WHERE id=v_admission.package_id;
  IF v_exam_plan IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.exam_attempts a JOIN public.exam_papers p ON p.id=a.paper_id
    WHERE a.admission_id=p_requirement.admission_id AND a.project_id=p_requirement.project_id
      AND a.employee_id=p_requirement.employee_id AND a.exam_type='admission' AND a.exam_semantic_type=v_semantic
      AND a.special_type IS NULL AND a.status='submitted' AND a.result='pass' AND p.plan_id=v_exam_plan
      AND p.exam_type='admission' AND p.exam_semantic_type=v_semantic AND p.special_type IS NULL
  ) THEN v_reasons:=v_reasons||jsonb_build_array('admission_exam_not_passed'); END IF;
  v_special:=public.training_special_requirements_internal(p_requirement.project_id,p_requirement.employee_id);
  IF NOT COALESCE((v_special->>'overall_satisfied')::boolean,FALSE) THEN v_reasons:=v_reasons||jsonb_build_array('special_requirements_not_satisfied'); END IF;
  RETURN jsonb_build_object('satisfied',jsonb_array_length(v_reasons)=0,'blocked_reasons',v_reasons,
    'three_level',v_three,'special_requirements',v_special,'signature_requirements',v_signature,
    'exam_semantic_type',v_semantic,'exam_plan_id',v_exam_plan);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

ALTER FUNCTION public.training_site_confirmation_status(UUID,UUID) VOLATILE;
ALTER FUNCTION public.training_site_confirmation_project_list(UUID) VOLATILE;

REVOKE ALL ON FUNCTION public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)
  FROM PUBLIC,anon,authenticated;

COMMENT ON FUNCTION public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements)
IS 'D16 authoritative prerequisite resolution; materializes applicable D15 requirements and treats only D15 not_required as not applicable.';

COMMIT;

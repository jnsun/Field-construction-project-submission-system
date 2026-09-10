-- D15 R02-1: authoritative project binding, hard prerequisites, exact D13 exam
-- evidence, and gap-free future policy selection.
BEGIN;

CREATE OR REPLACE FUNCTION public.training_signature_exam_evidence_internal(
  p_requirement public.training_signature_requirements
) RETURNS JSONB AS $$
DECLARE
  v_admission public.training_admissions;
  v_path TEXT;
  v_semantic TEXT;
  v_exam_plan UUID;
  v_exam JSONB;
BEGIN
  IF p_requirement.admission_id IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO v_admission FROM public.training_admissions
  WHERE id=p_requirement.admission_id AND employee_id=p_requirement.employee_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT primary_path INTO v_path FROM public.project_person_admission_paths
  WHERE project_id=v_admission.project_id AND employee_id=v_admission.employee_id AND active
  ORDER BY effective_at DESC,version_no DESC LIMIT 1;
  v_semantic:=CASE WHEN v_path='employee' THEN 'employee_comprehensive_admission_exam' ELSE 'project_induction_exam' END;

  SELECT exam_plan_id INTO v_exam_plan FROM public.training_admission_packages WHERE id=v_admission.package_id;
  IF v_exam_plan IS NULL THEN RETURN NULL; END IF;

  SELECT jsonb_build_object(
    'attempt_id',a.id,'admission_id',a.admission_id,'project_id',a.project_id,
    'exam_type',a.exam_type,'exam_semantic_type',a.exam_semantic_type,'special_type',a.special_type,
    'exam_plan_id',p.plan_id,'paper_id',a.paper_id,'attempt_no',a.attempt_no,
    'score',a.score,'result',a.result,'submitted_at',a.submitted_at)
  INTO v_exam
  FROM public.exam_attempts a
  JOIN public.exam_papers p ON p.id=a.paper_id
  WHERE a.admission_id=v_admission.id
    AND a.project_id=v_admission.project_id
    AND a.employee_id=v_admission.employee_id
    AND a.exam_type='admission'
    AND a.exam_semantic_type=v_semantic
    AND a.special_type IS NULL
    AND a.status='submitted' AND a.result='pass'
    AND p.plan_id=v_exam_plan AND p.exam_type='admission'
    AND p.exam_semantic_type=v_semantic AND p.special_type IS NULL
  ORDER BY a.submitted_at DESC,a.id DESC LIMIT 1;
  RETURN v_exam;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION public.training_signature_exam_evidence_internal(public.training_signature_requirements)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_signature_prerequisite_internal(
  p_requirement public.training_signature_requirements
) RETURNS TEXT AS $$
DECLARE
  v_exam_required BOOLEAN;
BEGIN
  IF p_requirement.status='signed' THEN RETURN 'signature_already_completed'; END IF;
  IF p_requirement.status IN('superseded','invalidated') THEN RETURN 'signature_superseded'; END IF;

  IF p_requirement.stage_order IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.training_three_level_records r
    WHERE r.requirement_snapshot_id=p_requirement.requirement_snapshot_id
      AND r.requirement_snapshot_item_id=p_requirement.requirement_snapshot_item_id
      AND r.status='completed') THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;

  IF p_requirement.node_type IN(
    'employee_final_acknowledgement','organization_responsible_confirmation','project_manager_or_safety_confirmation'
  ) AND EXISTS(
    SELECT 1 FROM public.training_requirement_snapshot_items i
    WHERE i.snapshot_id=p_requirement.requirement_snapshot_id AND i.required
      AND NOT EXISTS(
        SELECT 1 FROM public.training_three_level_records r
        WHERE r.requirement_snapshot_id=i.snapshot_id
          AND r.requirement_snapshot_item_id=i.id AND r.status='completed')) THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;

  SELECT COALESCE(a.exam_required,FALSE) INTO v_exam_required
  FROM public.training_admissions a
  WHERE a.id=p_requirement.admission_id AND a.employee_id=p_requirement.employee_id;
  v_exam_required:=p_requirement.requires_exam OR (
    p_requirement.node_type='employee_final_acknowledgement' AND COALESCE(v_exam_required,FALSE));
  IF v_exam_required AND public.training_signature_exam_evidence_internal(p_requirement) IS NULL THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.training_signature_requirements prior
    WHERE prior.requirement_cycle_id=p_requirement.requirement_cycle_id
      AND prior.required AND prior.sequence_no<p_requirement.sequence_no AND prior.status<>'signed') THEN
    RETURN 'signature_prerequisite_not_met';
  END IF;
  RETURN 'ready';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION public.training_signature_prerequisite_internal(public.training_signature_requirements)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_signature_evidence_internal(
  p_requirement public.training_signature_requirements,p_authority JSONB
) RETURNS JSONB AS $$
DECLARE
  v_snapshot public.training_requirement_snapshots;
  v_items JSONB;
  v_records JSONB;
  v_exam JSONB;
  v_display JSONB;
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_requirement.requirement_snapshot_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('snapshot_item_id',i.id,'stage_order',i.stage_order,'stage_type',i.stage_type,
    'package_id',i.training_package_id,'package_version_id',i.training_package_version_id,'package_version_no',i.training_package_version_no,
    'package_release',jsonb_build_object('approved_by',p.approved_by,'approved_at',p.approved_at,'status',p.status)) ORDER BY i.stage_order),'[]'::jsonb)
    INTO v_items FROM public.training_requirement_snapshot_items i JOIN public.training_admission_packages p ON p.id=i.training_package_id WHERE i.snapshot_id=v_snapshot.id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('record_id',r.id,'snapshot_item_id',r.requirement_snapshot_item_id,'status',r.status,
    'effective_hours',r.effective_hours,'completed_at',r.completed_at) ORDER BY r.level),'[]'::jsonb)
    INTO v_records FROM public.training_three_level_records r WHERE r.requirement_snapshot_id=v_snapshot.id;
  v_exam:=public.training_signature_exam_evidence_internal(p_requirement);
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

REVOKE ALL ON FUNCTION public.training_signature_evidence_internal(public.training_signature_requirements,JSONB)
FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_signature_ensure_requirements(
  p_requirement_snapshot_id UUID,p_admission_id UUID DEFAULT NULL,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_snapshot public.training_requirement_snapshots;
  v_admission public.training_admissions;
  v_policy public.training_signature_policies;
  v_version public.training_signature_policy_versions;
  v_node public.training_signature_policy_nodes;
  v_item UUID;
  v_snapshot_project UUID;
  v_project_count INTEGER;
  v_project UUID;
  v_cycle UUID:=gen_random_uuid();
  v_count INTEGER:=0;
  v_req UUID;
BEGIN
  SELECT * INTO v_snapshot FROM public.training_requirement_snapshots WHERE id=p_requirement_snapshot_id;
  SELECT count(DISTINCT site_project_id),min(site_project_id::text)::uuid
    INTO v_project_count,v_snapshot_project
  FROM public.training_requirement_snapshot_items
  WHERE snapshot_id=p_requirement_snapshot_id AND stage_type='actual_project';
  IF v_project_count>1 THEN RAISE EXCEPTION '[D15:signature_project_mismatch] Snapshot 项目来源不唯一'; END IF;
  IF v_snapshot.id IS NULL OR NOT public.training_three_level_resolution_can_read(v_snapshot.employee_id,v_snapshot_project) THEN
    RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字业务要求不存在或不可访问' USING ERRCODE='42501';
  END IF;

  IF p_admission_id IS NOT NULL THEN
    SELECT * INTO v_admission FROM public.training_admissions WHERE id=p_admission_id AND employee_id=v_snapshot.employee_id;
    IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_policy_invalid] admission 与人员不匹配'; END IF;
  END IF;
  IF v_snapshot_project IS NOT NULL AND (v_admission.id IS NULL OR v_admission.project_id<>v_snapshot_project) THEN
    RAISE EXCEPTION '[D15:signature_project_mismatch] admission 与 Snapshot 权威项目不匹配';
  END IF;

  SELECT p.* INTO v_policy FROM public.training_signature_policies p WHERE p.scheme_id=v_snapshot.scheme_id;
  IF NOT FOUND THEN SELECT p.* INTO v_policy FROM public.training_signature_policies p WHERE p.scheme_id IS NULL; END IF;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_required','reason_code','signature_not_required','requirements','[]'::jsonb); END IF;
  SELECT * INTO v_version FROM public.training_signature_policy_versions
  WHERE policy_id=v_policy.id AND status IN('published','superseded')
    AND effective_from<=v_snapshot.effective_as_of AND (effective_to IS NULL OR effective_to>=v_snapshot.effective_as_of)
  ORDER BY effective_from DESC,version_no DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_required','reason_code','signature_not_required','requirements','[]'::jsonb); END IF;

  SELECT requirement_cycle_id INTO v_cycle FROM public.training_signature_requirements
  WHERE requirement_snapshot_id=v_snapshot.id AND policy_version_id=v_version.id
    AND (admission_id IS NOT DISTINCT FROM p_admission_id) ORDER BY created_at LIMIT 1;
  v_cycle:=COALESCE(v_cycle,gen_random_uuid());
  FOR v_node IN SELECT * FROM public.training_signature_policy_nodes WHERE policy_version_id=v_version.id ORDER BY sequence_no LOOP
    v_item:=NULL; v_project:=NULL;
    IF v_node.stage_order IS NOT NULL THEN
      SELECT id INTO v_item FROM public.training_requirement_snapshot_items
      WHERE snapshot_id=v_snapshot.id AND stage_order=v_node.stage_order
        AND (v_node.applies_stage_type IS NULL OR stage_type=v_node.applies_stage_type);
      IF v_item IS NULL THEN CONTINUE; END IF;
    ELSIF v_node.applies_stage_type IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.training_requirement_snapshot_items
      WHERE snapshot_id=v_snapshot.id AND stage_type=v_node.applies_stage_type) THEN
      CONTINUE;
    END IF;
    IF v_node.node_type='project_manager_or_safety_confirmation' THEN
      IF v_snapshot_project IS NULL THEN RAISE EXCEPTION '[D15:signature_project_mismatch] 项目签字节点缺少 Snapshot 权威项目'; END IF;
      v_project:=v_snapshot_project;
    END IF;
    INSERT INTO public.training_signature_requirements(requirement_cycle_id,employee_id,employee_subject_id,employment_relation_id,admission_id,project_id,organization_unit_id,
      requirement_snapshot_id,requirement_snapshot_item_id,policy_id,policy_version_id,policy_node_id,node_code,node_type,stage_order,required,sequence_no,signer_mode,signer_roles_snapshot,requires_exam,due_at)
    VALUES(v_cycle,v_snapshot.employee_id,v_snapshot.subject_id,v_snapshot.employment_relation_id,p_admission_id,v_project,v_snapshot.organization_unit_id,
      v_snapshot.id,v_item,v_policy.id,v_version.id,v_node.id,v_node.node_code,v_node.node_type,v_node.stage_order,v_node.required,v_node.sequence_no,v_node.signer_mode,v_node.signer_roles,v_node.requires_exam,
      CASE WHEN v_node.due_days IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>v_node.due_days) END)
    ON CONFLICT(requirement_snapshot_id,policy_node_id,requirement_cycle_id) DO NOTHING RETURNING id INTO v_req;
    IF v_req IS NOT NULL THEN
      v_count:=v_count+1;
      INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
      VALUES(v_req,'created',public.training_current_account_subject_id(),'policy_snapshot',jsonb_build_object('policy_version_id',v_version.id,'request_id',p_request_id));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status','required','reason_code',CASE WHEN v_count>0 THEN 'signature_requirements_created' ELSE 'signature_requirements_reused' END,
    'policy_id',v_policy.id,'policy_version_id',v_version.id,'requirement_cycle_id',v_cycle,
    'requirements',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.sequence_no),'[]'::jsonb) FROM public.training_signature_requirements r WHERE r.requirement_cycle_id=v_cycle));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION public.training_signature_ensure_requirements(UUID,UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_signature_ensure_requirements(UUID,UUID,TEXT) TO authenticated;

COMMENT ON FUNCTION public.training_signature_exam_evidence_internal(public.training_signature_requirements)
IS 'D15 exact D13 admission/project/person/semantic/plan PASS evidence for one frozen signature requirement.';

COMMIT;

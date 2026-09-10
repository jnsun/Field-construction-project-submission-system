-- D16: authoritative on-site confirmation, photo evidence, optional location and re-confirmation cycles.
BEGIN;

CREATE TABLE public.training_site_confirmation_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  member_id UUID NOT NULL REFERENCES public.site_project_members(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  primary_admission_path TEXT NOT NULL CHECK(primary_admission_path IN('employee','contractor','temporary_individual')),
  cycle_no INTEGER NOT NULL CHECK(cycle_no>0),
  previous_requirement_id UUID REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  source_event_type TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','invalidated','superseded')),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  status_reason TEXT,
  created_by UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(project_id,employee_id,cycle_no),
  UNIQUE(project_id,employee_id,source_event_type,source_reference),
  CHECK((status IN('pending','confirmed') AND is_current) OR (status IN('invalidated','superseded') AND NOT is_current))
);
CREATE UNIQUE INDEX training_site_confirmation_one_current_idx
  ON public.training_site_confirmation_requirements(project_id,employee_id) WHERE is_current;
CREATE INDEX training_site_confirmation_project_idx
  ON public.training_site_confirmation_requirements(project_id,status,created_at DESC);

CREATE TABLE public.training_site_confirmation_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  confirmer_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  confirmer_authority_snapshot JSONB NOT NULL CHECK(jsonb_typeof(confirmer_authority_snapshot)='object'),
  nonce_hash TEXT NOT NULL CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_snapshot JSONB NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
  storage_bucket TEXT NOT NULL DEFAULT 'certificates' CHECK(storage_bucket='certificates'),
  storage_path TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.training_site_confirmation_photo_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  challenge_id UUID NOT NULL UNIQUE REFERENCES public.training_site_confirmation_challenges(id) ON DELETE RESTRICT,
  uploader_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  storage_object_id UUID NOT NULL,
  storage_bucket TEXT NOT NULL CHECK(storage_bucket='certificates'),
  storage_path TEXT NOT NULL,
  storage_object_version TEXT,
  storage_object_updated_at TIMESTAMPTZ NOT NULL,
  detected_mime_type TEXT NOT NULL CHECK(detected_mime_type IN('image/png','image/jpeg')),
  actual_size_bytes BIGINT NOT NULL CHECK(actual_size_bytes BETWEEN 1 AND 5242880),
  actual_width INTEGER NOT NULL CHECK(actual_width BETWEEN 64 AND 8192),
  actual_height INTEGER NOT NULL CHECK(actual_height BETWEEN 64 AND 8192),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  validator_version TEXT NOT NULL CHECK(btrim(validator_version)<>''),
  validated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.training_site_confirmation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL UNIQUE REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  challenge_id UUID NOT NULL UNIQUE REFERENCES public.training_site_confirmation_challenges(id) ON DELETE RESTRICT,
  confirmer_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  confirmer_auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmer_role_snapshot TEXT NOT NULL CHECK(confirmer_role_snapshot IN('project_manager','safety_officer')),
  confirmer_scope_snapshot JSONB NOT NULL CHECK(jsonb_typeof(confirmer_scope_snapshot)='object'),
  storage_bucket TEXT NOT NULL CHECK(storage_bucket='certificates'),
  storage_path TEXT NOT NULL UNIQUE,
  photo_validation_id UUID NOT NULL REFERENCES public.training_site_confirmation_photo_validations(id) ON DELETE RESTRICT,
  photo_content_sha256 TEXT NOT NULL CHECK(photo_content_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_digest TEXT NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_snapshot JSONB NOT NULL CHECK(jsonb_typeof(evidence_snapshot)='object'),
  location_status TEXT NOT NULL CHECK(location_status IN('present','pending')),
  initial_location JSONB,
  confirmed_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL,
  device_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(device_snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(confirmer_subject_id,idempotency_key),
  CHECK((location_status='present' AND initial_location IS NOT NULL AND jsonb_typeof(initial_location)='object') OR
        (location_status='pending' AND initial_location IS NULL))
);

CREATE TABLE public.training_site_confirmation_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL UNIQUE REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  result_id UUID NOT NULL UNIQUE REFERENCES public.training_site_confirmation_results(id) ON DELETE RESTRICT,
  location JSONB NOT NULL CHECK(jsonb_typeof(location)='object'),
  supplemented_by UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  source_reference TEXT NOT NULL,
  supplemented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.training_site_confirmation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_site_confirmation_requirements(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN('created','prepared','confirmed','location_supplemented','invalidated','superseded')),
  actor_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  actor_role_snapshot TEXT,
  reason TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(detail)='object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX training_site_confirmation_events_idx ON public.training_site_confirmation_events(requirement_id,occurred_at);

CREATE FUNCTION public.training_site_confirmation_history_immutable_guard() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION '[D16:site_confirmation_immutable] 现场确认结果、照片、定位和审计历史不可修改或删除'; END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_site_confirmation_result_immutable BEFORE UPDATE OR DELETE ON public.training_site_confirmation_results
  FOR EACH ROW EXECUTE FUNCTION public.training_site_confirmation_history_immutable_guard();
CREATE TRIGGER trg_site_confirmation_validation_immutable BEFORE UPDATE OR DELETE ON public.training_site_confirmation_photo_validations
  FOR EACH ROW EXECUTE FUNCTION public.training_site_confirmation_history_immutable_guard();
CREATE TRIGGER trg_site_confirmation_location_immutable BEFORE UPDATE OR DELETE ON public.training_site_confirmation_locations
  FOR EACH ROW EXECUTE FUNCTION public.training_site_confirmation_history_immutable_guard();
CREATE TRIGGER trg_site_confirmation_event_immutable BEFORE UPDATE OR DELETE ON public.training_site_confirmation_events
  FOR EACH ROW EXECUTE FUNCTION public.training_site_confirmation_history_immutable_guard();

CREATE FUNCTION public.training_site_confirmation_requirement_guard() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.training_site_confirmation_mutation',TRUE)<>'on' THEN
    RAISE EXCEPTION '[D16:site_confirmation_immutable] requirement 只能经权威状态机变更';
  END IF;
  IF (OLD.project_id,OLD.member_id,OLD.employee_id,OLD.admission_id,OLD.primary_admission_path,OLD.cycle_no,
      OLD.previous_requirement_id,OLD.source_event_type,OLD.source_reference,OLD.created_by,OLD.created_at)
    IS DISTINCT FROM
     (NEW.project_id,NEW.member_id,NEW.employee_id,NEW.admission_id,NEW.primary_admission_path,NEW.cycle_no,
      NEW.previous_requirement_id,NEW.source_event_type,NEW.source_reference,NEW.created_by,NEW.created_at) THEN
    RAISE EXCEPTION '[D16:site_confirmation_immutable] requirement 权威绑定不可修改';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_site_confirmation_requirement_guard BEFORE UPDATE OR DELETE ON public.training_site_confirmation_requirements
  FOR EACH ROW EXECUTE FUNCTION public.training_site_confirmation_requirement_guard();

CREATE FUNCTION public.training_site_confirmation_digest_internal(p_value JSONB) RETURNS TEXT AS $$
  SELECT encode(extensions.digest(convert_to(p_value::text,'UTF8'),'sha256'),'hex');
$$ LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=public,extensions;

CREATE FUNCTION public.training_site_confirmation_authority_internal(p_project_id UUID) RETURNS JSONB AS $$
DECLARE v_subject UUID; v_role TEXT;
BEGIN
  IF NOT public.training_account_is_active(auth.uid()) THEN
    RAISE EXCEPTION '[D16:site_confirmation_forbidden] 当前账号不可执行现场确认' USING ERRCODE='42501';
  END IF;
  SELECT r.role INTO v_role FROM public.site_project_roles r
  WHERE r.project_id=p_project_id AND r.user_id=auth.uid() AND r.active
    AND r.role IN('project_manager','safety_officer')
  ORDER BY CASE r.role WHEN 'project_manager' THEN 1 ELSE 2 END LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION '[D16:site_confirmation_forbidden] 仅当前项目经理或安全员可执行现场确认' USING ERRCODE='42501';
  END IF;
  v_subject:=public.training_current_account_subject_id();
  RETURN jsonb_build_object('subject_id',v_subject,'role',v_role,'scope',jsonb_build_object('scope','project','scope_id',p_project_id));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_can_read_internal(p_project_id UUID,p_employee_id UUID) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_employee_id=public.training_my_employee_id() OR public.site_project_can_read_management_data(p_project_id)
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_prerequisite_internal(p_requirement public.training_site_confirmation_requirements)
RETURNS JSONB AS $$
DECLARE v_project public.site_projects; v_member public.site_project_members; v_admission public.training_admissions;
  v_path TEXT; v_three JSONB; v_special JSONB; v_semantic TEXT; v_exam_plan UUID; v_reasons JSONB:='[]'::jsonb;
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
  IF EXISTS(SELECT 1 FROM public.training_signature_requirements s
    WHERE s.admission_id=p_requirement.admission_id AND s.employee_id=p_requirement.employee_id
      AND (s.project_id IS NULL OR s.project_id=p_requirement.project_id) AND s.required AND s.status='pending') THEN
    v_reasons:=v_reasons||jsonb_build_array('required_signature_not_completed'); END IF;
  RETURN jsonb_build_object('satisfied',jsonb_array_length(v_reasons)=0,'blocked_reasons',v_reasons,
    'three_level',v_three,'special_requirements',v_special,'exam_semantic_type',v_semantic,'exam_plan_id',v_exam_plan);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_create_internal(
  p_project_id UUID,p_employee_id UUID,p_source_event_type TEXT,p_source_reference TEXT,p_reason TEXT,p_actor UUID
) RETURNS public.training_site_confirmation_requirements AS $$
DECLARE v_member public.site_project_members; v_admission public.training_admissions; v_path TEXT;
  v_old public.training_site_confirmation_requirements; v_new public.training_site_confirmation_requirements; v_cycle INTEGER;
BEGIN
  SELECT * INTO v_member FROM public.site_project_members
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND status='active' ORDER BY joined_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:membership_not_active] 当前人员不是项目 active member'; END IF;
  SELECT * INTO v_admission FROM public.training_admissions
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND member_id=v_member.id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:admission_binding_mismatch] 缺少项目、人员、成员精确绑定的 admission'; END IF;
  SELECT primary_path INTO v_path FROM public.project_person_admission_paths
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND active ORDER BY effective_at DESC,version_no DESC LIMIT 1;
  IF v_path IS NULL AND p_source_event_type IN('membership_reactivated','project_reactivated') THEN
    v_path:=public.training_member_primary_path(v_member);
  END IF;
  IF v_path IS NULL OR v_path='visitor' THEN RAISE EXCEPTION '[D16:admission_path_not_applicable] 访客或未识别路径不进入现场确认'; END IF;
  SELECT * INTO v_new FROM public.training_site_confirmation_requirements
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND source_event_type=p_source_event_type AND source_reference=p_source_reference;
  IF FOUND THEN RETURN v_new; END IF;
  SELECT * INTO v_old FROM public.training_site_confirmation_requirements
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO v_old FROM public.training_site_confirmation_requirements
      WHERE project_id=p_project_id AND employee_id=p_employee_id ORDER BY cycle_no DESC LIMIT 1 FOR UPDATE;
  END IF;
  SELECT COALESCE(max(cycle_no),0)+1 INTO v_cycle FROM public.training_site_confirmation_requirements
    WHERE project_id=p_project_id AND employee_id=p_employee_id;
  IF v_old.id IS NOT NULL AND v_old.is_current THEN
    PERFORM set_config('app.training_site_confirmation_mutation','on',TRUE);
    UPDATE public.training_site_confirmation_requirements SET status='superseded',is_current=FALSE,status_reason=p_reason,resolved_at=clock_timestamp() WHERE id=v_old.id;
    INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,actor_subject_id,reason,detail)
      VALUES(v_old.id,'superseded',p_actor,p_reason,jsonb_build_object('source_event_type',p_source_event_type,'source_reference',p_source_reference));
  END IF;
  INSERT INTO public.training_site_confirmation_requirements(project_id,member_id,employee_id,admission_id,primary_admission_path,cycle_no,
    previous_requirement_id,source_event_type,source_reference,status_reason,created_by)
  VALUES(p_project_id,v_member.id,p_employee_id,v_admission.id,v_path,v_cycle,v_old.id,p_source_event_type,p_source_reference,p_reason,p_actor)
  RETURNING * INTO v_new;
  INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_new.id,'created',p_actor,p_reason,jsonb_build_object('cycle_no',v_cycle,'previous_requirement_id',v_old.id));
  RETURN v_new;
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_new FROM public.training_site_confirmation_requirements
    WHERE project_id=p_project_id AND employee_id=p_employee_id AND source_event_type=p_source_event_type AND source_reference=p_source_reference;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_ensure(p_admission_id UUID,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_admission public.training_admissions; v_auth JSONB; v_req public.training_site_confirmation_requirements;
BEGIN
  SELECT * INTO v_admission FROM public.training_admissions WHERE id=p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:admission_binding_mismatch] admission 不存在'; END IF;
  v_auth:=public.training_site_confirmation_authority_internal(v_admission.project_id);
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements
    WHERE project_id=v_admission.project_id AND employee_id=v_admission.employee_id AND is_current;
  IF NOT FOUND THEN
    v_req:=public.training_site_confirmation_create_internal(v_admission.project_id,v_admission.employee_id,'initial_admission',v_admission.id::text,
      'initial site confirmation requirement',(v_auth->>'subject_id')::uuid);
  END IF;
  RETURN to_jsonb(v_req)||jsonb_build_object('idempotent',v_req.source_reference=v_admission.id::text,'prerequisite',public.training_site_confirmation_prerequisite_internal(v_req));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_status(p_project_id UUID,p_employee_id UUID DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v_employee UUID:=COALESCE(p_employee_id,public.training_my_employee_id()); v_req public.training_site_confirmation_requirements;
  v_result public.training_site_confirmation_results; v_location JSONB; v_pre JSONB;
BEGIN
  IF v_employee IS NULL OR NOT public.training_site_confirmation_can_read_internal(p_project_id,v_employee) THEN
    RAISE EXCEPTION '[D16:site_confirmation_forbidden] 无权查看现场确认状态' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE project_id=p_project_id AND employee_id=v_employee AND is_current;
  IF NOT FOUND THEN RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'required',FALSE,'status','not_created','satisfied',FALSE,'blocked_reasons',jsonb_build_array('site_confirmation_not_created')); END IF;
  SELECT * INTO v_result FROM public.training_site_confirmation_results WHERE requirement_id=v_req.id;
  SELECT location INTO v_location FROM public.training_site_confirmation_locations WHERE requirement_id=v_req.id;
  v_pre:=public.training_site_confirmation_prerequisite_internal(v_req);
  RETURN jsonb_build_object('project_id',p_project_id,'employee_id',v_employee,'admission_id',v_req.admission_id,'member_id',v_req.member_id,
    'requirement_id',v_req.id,'cycle_no',v_req.cycle_no,'previous_requirement_id',v_req.previous_requirement_id,'required',TRUE,
    'status',v_req.status,'confirmed_at',v_result.confirmed_at,'location_status',CASE WHEN v_result.id IS NULL THEN 'not_submitted' WHEN v_result.location_status='present' OR v_location IS NOT NULL THEN 'present' ELSE 'pending' END,
    'satisfied',v_req.status='confirmed','blocked_reasons',CASE WHEN v_req.status='confirmed' THEN '[]'::jsonb ELSE v_pre->'blocked_reasons'||jsonb_build_array('site_confirmation_required') END,
    'prerequisite',v_pre,'photo',CASE WHEN v_result.id IS NULL THEN NULL ELSE jsonb_build_object('result_id',v_result.id,'storage_bucket',v_result.storage_bucket,'storage_path',v_result.storage_path,'content_sha256',v_result.photo_content_sha256) END);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_project_list(p_project_id UUID) RETURNS JSONB AS $$
BEGIN
  PERFORM public.training_site_confirmation_authority_internal(p_project_id);
  RETURN COALESCE((SELECT jsonb_agg(public.training_site_confirmation_status(p_project_id,m.employee_id) ORDER BY e.name)
    FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id
    WHERE m.project_id=p_project_id AND m.status='active'
      AND COALESCE((public.training_primary_admission_path(p_project_id,m.employee_id)->>'primary_path'),'visitor')<>'visitor'),'[]'::jsonb);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_prepare(p_requirement_id UUID) RETURNS JSONB AS $$
DECLARE v_req public.training_site_confirmation_requirements; v_auth JSONB; v_pre JSONB; v_evidence JSONB;
  v_challenge UUID:=gen_random_uuid(); v_nonce TEXT:=encode(extensions.gen_random_bytes(32),'hex'); v_path TEXT; v_digest TEXT;
BEGIN
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE id=p_requirement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] requirement 不存在'; END IF;
  v_auth:=public.training_site_confirmation_authority_internal(v_req.project_id);
  IF v_req.status='confirmed' THEN RETURN jsonb_build_object('status','confirmed','reason_code','site_confirmation_already_completed','requirement_id',v_req.id); END IF;
  IF v_req.status<>'pending' OR NOT v_req.is_current THEN RAISE EXCEPTION '[D16:site_confirmation_stale] 当前周期已失效'; END IF;
  v_pre:=public.training_site_confirmation_prerequisite_internal(v_req);
  IF NOT (v_pre->>'satisfied')::boolean THEN RAISE EXCEPTION '[D16:site_confirmation_prerequisite_not_met] 前置条件未满足'; END IF;
  v_evidence:=jsonb_build_object('schema','d16-site-confirmation-evidence-v1','requirement',jsonb_build_object('id',v_req.id,'cycle_no',v_req.cycle_no,
      'project_id',v_req.project_id,'member_id',v_req.member_id,'employee_id',v_req.employee_id,'admission_id',v_req.admission_id,'primary_admission_path',v_req.primary_admission_path),
    'prerequisite',v_pre,'confirmer',v_auth);
  v_digest:=public.training_site_confirmation_digest_internal(v_evidence);
  v_path:=format('training-admission/site-confirmation/%s/%s/%s.png',v_req.id,v_challenge,gen_random_uuid());
  INSERT INTO public.training_site_confirmation_challenges(id,requirement_id,confirmer_subject_id,confirmer_authority_snapshot,nonce_hash,evidence_digest,evidence_snapshot,storage_path,expires_at)
    VALUES(v_challenge,v_req.id,(v_auth->>'subject_id')::uuid,v_auth,public.training_site_confirmation_digest_internal(to_jsonb(v_nonce)),v_digest,v_evidence,v_path,clock_timestamp()+interval '15 minutes');
  INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,actor_subject_id,actor_role_snapshot,reason,detail)
    VALUES(v_req.id,'prepared',(v_auth->>'subject_id')::uuid,v_auth->>'role','prepared',jsonb_build_object('challenge_id',v_challenge));
  RETURN jsonb_build_object('status','prepared','requirement_id',v_req.id,'challenge_id',v_challenge,'nonce',v_nonce,'evidence_digest',v_digest,
    'storage_bucket','certificates','storage_path',v_path,'expires_at',clock_timestamp()+interval '15 minutes');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_file_can_upload(p_name TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM public.training_site_confirmation_challenges c
    JOIN public.training_site_confirmation_requirements r ON r.id=c.requirement_id
    JOIN public.account_subjects s ON s.id=c.confirmer_subject_id
    WHERE c.storage_path=p_name AND c.used_at IS NULL AND c.expires_at>clock_timestamp()
      AND r.status='pending' AND r.is_current AND s.auth_user_id=auth.uid()
      AND p_name ~ ('^training-admission/site-confirmation/'||r.id::text||'/'||c.id::text||'/[0-9a-f-]{36}\\.(png|jpg|jpeg)$'));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_file_can_read(p_name TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM public.training_site_confirmation_challenges c
    JOIN public.training_site_confirmation_requirements r ON r.id=c.requirement_id
    WHERE c.storage_path=p_name AND public.training_site_confirmation_can_read_internal(r.project_id,r.employee_id));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_file_validation_context(p_challenge_id UUID) RETURNS JSONB AS $$
DECLARE v_challenge public.training_site_confirmation_challenges; v_req public.training_site_confirmation_requirements; v_auth JSONB;
BEGIN
  SELECT * INTO v_challenge FROM public.training_site_confirmation_challenges WHERE id=p_challenge_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] challenge 不存在'; END IF;
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE id=v_challenge.requirement_id;
  v_auth:=public.training_site_confirmation_authority_internal(v_req.project_id);
  IF (v_auth->>'subject_id')::uuid<>v_challenge.confirmer_subject_id THEN RAISE EXCEPTION '[D16:site_confirmation_forbidden] 确认人不匹配' USING ERRCODE='42501'; END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=clock_timestamp() THEN RAISE EXCEPTION '[D16:site_confirmation_challenge_expired] challenge 已失效'; END IF;
  RETURN jsonb_build_object('requirement_id',v_req.id,'challenge_id',v_challenge.id,'storage_bucket',v_challenge.storage_bucket,
    'storage_path',v_challenge.storage_path,'max_bytes',5242880,'allowed_mime_types',jsonb_build_array('image/png','image/jpeg'));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_record_photo_validation(
  p_challenge_id UUID,p_detected_mime_type TEXT,p_actual_size_bytes BIGINT,p_actual_width INTEGER,
  p_actual_height INTEGER,p_content_sha256 TEXT,p_validator_version TEXT
) RETURNS JSONB AS $$
DECLARE v_challenge public.training_site_confirmation_challenges; v_req public.training_site_confirmation_requirements;
  v_object storage.objects; v_subject UUID; v_existing public.training_site_confirmation_photo_validations; v_new public.training_site_confirmation_photo_validations;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role',TRUE),'')<>'service_role' THEN RAISE EXCEPTION '[D16:site_confirmation_forbidden] 仅受控图片验证服务可写入验证事实' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_challenge FROM public.training_site_confirmation_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] challenge 不存在'; END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=clock_timestamp() THEN RAISE EXCEPTION '[D16:site_confirmation_challenge_expired] challenge 已失效'; END IF;
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE id=v_challenge.requirement_id;
  SELECT * INTO v_object FROM storage.objects WHERE bucket_id=v_challenge.storage_bucket AND name=v_challenge.storage_path;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_photo_mismatch] 未找到本 challenge 的现场照片'; END IF;
  SELECT id INTO v_subject FROM public.account_subjects WHERE auth_user_id::text=COALESCE(v_object.owner_id,v_object.owner::text) AND id=v_challenge.confirmer_subject_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION '[D16:site_confirmation_photo_mismatch] 文件所有者与确认人不一致'; END IF;
  IF p_detected_mime_type NOT IN('image/png','image/jpeg') OR p_actual_size_bytes NOT BETWEEN 1 AND 5242880
    OR p_actual_width NOT BETWEEN 64 AND 8192 OR p_actual_height NOT BETWEEN 64 AND 8192
    OR lower(COALESCE(p_content_sha256,'')) !~ '^[0-9a-f]{64}$' OR NULLIF(btrim(p_validator_version),'') IS NULL THEN
    RAISE EXCEPTION '[D16:site_confirmation_photo_invalid] 真实图片验证结果无效'; END IF;
  SELECT * INTO v_existing FROM public.training_site_confirmation_photo_validations WHERE challenge_id=v_challenge.id;
  IF FOUND THEN
    IF v_existing.storage_object_id=v_object.id AND v_existing.storage_object_updated_at=v_object.updated_at
      AND v_existing.storage_object_version IS NOT DISTINCT FROM v_object.version AND v_existing.content_sha256=lower(p_content_sha256)
      AND v_existing.detected_mime_type=p_detected_mime_type AND v_existing.actual_size_bytes=p_actual_size_bytes
      AND v_existing.actual_width=p_actual_width AND v_existing.actual_height=p_actual_height THEN RETURN to_jsonb(v_existing)||jsonb_build_object('idempotent',TRUE); END IF;
    RAISE EXCEPTION '[D16:site_confirmation_photo_mismatch] 图片验证后发生变化';
  END IF;
  INSERT INTO public.training_site_confirmation_photo_validations(requirement_id,challenge_id,uploader_subject_id,storage_object_id,storage_bucket,storage_path,
    storage_object_version,storage_object_updated_at,detected_mime_type,actual_size_bytes,actual_width,actual_height,content_sha256,validator_version)
  VALUES(v_req.id,v_challenge.id,v_subject,v_object.id,v_challenge.storage_bucket,v_challenge.storage_path,v_object.version,v_object.updated_at,
    p_detected_mime_type,p_actual_size_bytes,p_actual_width,p_actual_height,lower(p_content_sha256),btrim(p_validator_version)) RETURNING * INTO v_new;
  RETURN to_jsonb(v_new)||jsonb_build_object('idempotent',FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;

CREATE FUNCTION public.training_site_confirmation_submit(
  p_challenge_id UUID,p_nonce TEXT,p_idempotency_key TEXT,p_location JSONB DEFAULT NULL,p_device JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
DECLARE v_challenge public.training_site_confirmation_challenges; v_req public.training_site_confirmation_requirements;
  v_existing public.training_site_confirmation_results; v_auth JSONB; v_pre JSONB; v_validation public.training_site_confirmation_photo_validations;
  v_object storage.objects; v_evidence JSONB; v_digest TEXT; v_result public.training_site_confirmation_results; v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  IF NULLIF(btrim(p_nonce),'') IS NULL OR NULLIF(btrim(p_idempotency_key),'') IS NULL
    OR (p_location IS NOT NULL AND jsonb_typeof(p_location)<>'object') OR jsonb_typeof(COALESCE(p_device,'{}'))<>'object' THEN
    RAISE EXCEPTION '[D16:site_confirmation_invalid_request] 提交参数无效'; END IF;
  SELECT * INTO v_challenge FROM public.training_site_confirmation_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] challenge 不存在'; END IF;
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE id=v_challenge.requirement_id FOR UPDATE;
  v_auth:=public.training_site_confirmation_authority_internal(v_req.project_id);
  IF (v_auth->>'subject_id')::uuid<>v_challenge.confirmer_subject_id THEN RAISE EXCEPTION '[D16:site_confirmation_forbidden] 确认人不匹配' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_existing FROM public.training_site_confirmation_results WHERE requirement_id=v_req.id;
  IF FOUND THEN RETURN jsonb_build_object('status','confirmed','reason_code','site_confirmation_already_completed','idempotent',TRUE,'result_id',v_existing.id,'confirmed_at',v_existing.confirmed_at); END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=v_now THEN RAISE EXCEPTION '[D16:site_confirmation_challenge_expired] challenge 已失效'; END IF;
  IF v_challenge.nonce_hash<>public.training_site_confirmation_digest_internal(to_jsonb(p_nonce)) THEN RAISE EXCEPTION '[D16:site_confirmation_photo_mismatch] challenge 不匹配'; END IF;
  v_pre:=public.training_site_confirmation_prerequisite_internal(v_req);
  IF NOT (v_pre->>'satisfied')::boolean THEN RAISE EXCEPTION '[D16:site_confirmation_prerequisite_not_met] 前置条件已变化'; END IF;
  SELECT * INTO v_validation FROM public.training_site_confirmation_photo_validations WHERE challenge_id=v_challenge.id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_photo_invalid] 现场照片尚未经过真实内容验证'; END IF;
  SELECT * INTO v_object FROM storage.objects WHERE id=v_validation.storage_object_id AND bucket_id=v_validation.storage_bucket AND name=v_validation.storage_path;
  IF NOT FOUND OR v_object.updated_at<>v_validation.storage_object_updated_at OR v_object.version IS DISTINCT FROM v_validation.storage_object_version
    OR COALESCE(v_object.owner_id,v_object.owner::text)<>auth.uid()::text THEN RAISE EXCEPTION '[D16:site_confirmation_photo_mismatch] 已验证照片已变化或不属于当前确认人'; END IF;
  v_evidence:=v_challenge.evidence_snapshot||jsonb_build_object('confirmed_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'photo_validation',jsonb_build_object('id',v_validation.id,'storage_object_id',v_validation.storage_object_id,'content_sha256',v_validation.content_sha256,
      'detected_mime_type',v_validation.detected_mime_type,'actual_size_bytes',v_validation.actual_size_bytes,'actual_width',v_validation.actual_width,'actual_height',v_validation.actual_height),
    'location',p_location);
  v_digest:=public.training_site_confirmation_digest_internal(v_evidence);
  INSERT INTO public.training_site_confirmation_results(requirement_id,challenge_id,confirmer_subject_id,confirmer_auth_user_id,confirmer_role_snapshot,
    confirmer_scope_snapshot,storage_bucket,storage_path,photo_validation_id,photo_content_sha256,evidence_digest,evidence_snapshot,location_status,initial_location,
    confirmed_at,idempotency_key,device_snapshot)
  VALUES(v_req.id,v_challenge.id,(v_auth->>'subject_id')::uuid,auth.uid(),v_auth->>'role',v_auth->'scope',v_validation.storage_bucket,v_validation.storage_path,
    v_validation.id,v_validation.content_sha256,v_digest,v_evidence,CASE WHEN p_location IS NULL THEN 'pending' ELSE 'present' END,p_location,v_now,btrim(p_idempotency_key),COALESCE(p_device,'{}'))
  RETURNING * INTO v_result;
  PERFORM set_config('app.training_site_confirmation_mutation','on',TRUE);
  UPDATE public.training_site_confirmation_requirements SET status='confirmed',status_reason='confirmed',resolved_at=v_now WHERE id=v_req.id;
  UPDATE public.training_site_confirmation_challenges SET used_at=v_now WHERE id=v_challenge.id;
  INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,actor_subject_id,actor_role_snapshot,reason,detail)
    VALUES(v_req.id,'confirmed',v_result.confirmer_subject_id,v_result.confirmer_role_snapshot,'confirmed',jsonb_build_object('result_id',v_result.id,'evidence_digest',v_digest));
  RETURN jsonb_build_object('status','confirmed','reason_code','site_confirmation_completed','idempotent',FALSE,'result_id',v_result.id,'confirmed_at',v_result.confirmed_at,'location_status',v_result.location_status);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.training_site_confirmation_results WHERE requirement_id=v_req.id OR (confirmer_subject_id=(v_auth->>'subject_id')::uuid AND idempotency_key=btrim(p_idempotency_key)) ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status','confirmed','reason_code','site_confirmation_already_completed','idempotent',TRUE,'result_id',v_existing.id,'confirmed_at',v_existing.confirmed_at); END IF;
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;

CREATE FUNCTION public.training_site_confirmation_supplement_location(
  p_requirement_id UUID,p_location JSONB,p_source_reference TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_req public.training_site_confirmation_requirements; v_result public.training_site_confirmation_results; v_auth JSONB;
  v_existing public.training_site_confirmation_locations; v_new public.training_site_confirmation_locations; v_ref TEXT:=NULLIF(btrim(p_source_reference),'');
BEGIN
  IF p_location IS NULL OR jsonb_typeof(p_location)<>'object' THEN RAISE EXCEPTION '[D16:site_confirmation_location_invalid] 定位数据必须是对象'; END IF;
  SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE id=p_requirement_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] requirement 不存在'; END IF;
  v_auth:=public.training_site_confirmation_authority_internal(v_req.project_id);
  SELECT * INTO v_result FROM public.training_site_confirmation_results WHERE requirement_id=v_req.id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_location_invalid] 只能为已完成的原确认补充定位'; END IF;
  IF v_result.location_status='present' THEN RETURN jsonb_build_object('status','present','idempotent',TRUE,'source','initial_confirmation'); END IF;
  SELECT * INTO v_existing FROM public.training_site_confirmation_locations WHERE requirement_id=v_req.id;
  IF FOUND THEN
    IF v_existing.location=p_location AND (v_ref IS NULL OR v_existing.source_reference=v_ref) THEN RETURN to_jsonb(v_existing)||jsonb_build_object('idempotent',TRUE); END IF;
    RAISE EXCEPTION '[D16:site_confirmation_immutable] 已补充定位不可覆盖';
  END IF;
  INSERT INTO public.training_site_confirmation_locations(requirement_id,result_id,location,supplemented_by,source_reference)
  VALUES(v_req.id,v_result.id,p_location,(v_auth->>'subject_id')::uuid,COALESCE(v_ref,'location-'||v_req.id::text)) RETURNING * INTO v_new;
  INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,actor_subject_id,actor_role_snapshot,reason,detail)
    VALUES(v_req.id,'location_supplemented',(v_auth->>'subject_id')::uuid,v_auth->>'role','location_supplemented',jsonb_build_object('location_id',v_new.id));
  RETURN to_jsonb(v_new)||jsonb_build_object('idempotent',FALSE,'status','present');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_supersede(
  p_requirement_id UUID,p_source_event_type TEXT,p_source_reference TEXT,p_reason TEXT
) RETURNS JSONB AS $$
DECLARE v_old public.training_site_confirmation_requirements; v_auth JSONB; v_new public.training_site_confirmation_requirements;
BEGIN
  IF NULLIF(btrim(p_source_event_type),'') IS NULL OR NULLIF(btrim(p_source_reference),'') IS NULL OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION '[D16:site_confirmation_invalid_request] source event、reference 和 reason 必填'; END IF;
  SELECT * INTO v_old FROM public.training_site_confirmation_requirements WHERE id=p_requirement_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D16:site_confirmation_not_found] requirement 不存在'; END IF;
  v_auth:=public.training_site_confirmation_authority_internal(v_old.project_id);
  v_new:=public.training_site_confirmation_create_internal(v_old.project_id,v_old.employee_id,btrim(p_source_event_type),btrim(p_source_reference),btrim(p_reason),(v_auth->>'subject_id')::uuid);
  RETURN jsonb_build_object('old_requirement_id',v_old.id,'new_requirement_id',v_new.id,'cycle_no',v_new.cycle_no,'idempotent',v_new.source_reference=btrim(p_source_reference));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_site_confirmation_project_member_trigger() RETURNS TRIGGER AS $$
DECLARE v_req public.training_site_confirmation_requirements; v_ref TEXT;
BEGIN
  IF OLD.status='active' AND NEW.status<>'active' THEN
    SELECT * INTO v_req FROM public.training_site_confirmation_requirements WHERE project_id=NEW.project_id AND employee_id=NEW.employee_id AND is_current FOR UPDATE;
    IF FOUND THEN
      PERFORM set_config('app.training_site_confirmation_mutation','on',TRUE);
      UPDATE public.training_site_confirmation_requirements SET status='invalidated',is_current=FALSE,status_reason='membership_inactive',resolved_at=clock_timestamp() WHERE id=v_req.id;
      INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,reason,detail) VALUES(v_req.id,'invalidated','membership_inactive',jsonb_build_object('member_id',NEW.id));
    END IF;
  ELSIF OLD.status<>'active' AND NEW.status='active' AND EXISTS(SELECT 1 FROM public.site_projects WHERE id=NEW.project_id AND status='active') THEN
    v_ref:=NEW.id::text||':'||txid_current()::text;
    BEGIN PERFORM public.training_site_confirmation_create_internal(NEW.project_id,NEW.employee_id,'membership_reactivated',v_ref,'membership reactivated',NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
CREATE TRIGGER trg_site_confirmation_member_status AFTER UPDATE OF status ON public.site_project_members
  FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.training_site_confirmation_project_member_trigger();

CREATE FUNCTION public.training_site_confirmation_project_status_trigger() RETURNS TRIGGER AS $$
DECLARE v_req public.training_site_confirmation_requirements; v_member public.site_project_members; v_ref TEXT;
BEGIN
  IF NEW.status IN('paused','pending_close','closed') THEN
    FOR v_req IN SELECT * FROM public.training_site_confirmation_requirements WHERE project_id=NEW.id AND is_current FOR UPDATE LOOP
      PERFORM set_config('app.training_site_confirmation_mutation','on',TRUE);
      UPDATE public.training_site_confirmation_requirements SET status='invalidated',is_current=FALSE,status_reason='project_'||NEW.status,resolved_at=clock_timestamp() WHERE id=v_req.id;
      INSERT INTO public.training_site_confirmation_events(requirement_id,event_type,reason,detail) VALUES(v_req.id,'invalidated','project_'||NEW.status,jsonb_build_object('old_status',OLD.status,'new_status',NEW.status));
    END LOOP;
  ELSIF OLD.status IN('paused','pending_close','closed') AND NEW.status='active' THEN
    FOR v_member IN SELECT * FROM public.site_project_members WHERE project_id=NEW.id AND status='active' LOOP
      v_ref:=NEW.id::text||':'||txid_current()::text||':'||v_member.id::text;
      BEGIN PERFORM public.training_site_confirmation_create_internal(NEW.id,v_member.employee_id,'project_reactivated',v_ref,'project reactivated',NULL);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
CREATE TRIGGER trg_site_confirmation_project_status AFTER UPDATE OF status ON public.site_projects
  FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.training_site_confirmation_project_status_trigger();

ALTER TABLE public.training_site_confirmation_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmation_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmation_photo_validations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmation_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_site_confirmation_requirements,public.training_site_confirmation_challenges,
  public.training_site_confirmation_photo_validations,public.training_site_confirmation_results,
  public.training_site_confirmation_locations,public.training_site_confirmation_events FROM PUBLIC,anon,authenticated;

REVOKE ALL ON FUNCTION public.training_site_confirmation_history_immutable_guard(),public.training_site_confirmation_requirement_guard(),
  public.training_site_confirmation_digest_internal(JSONB),public.training_site_confirmation_authority_internal(UUID),
  public.training_site_confirmation_can_read_internal(UUID,UUID),public.training_site_confirmation_prerequisite_internal(public.training_site_confirmation_requirements),
  public.training_site_confirmation_create_internal(UUID,UUID,TEXT,TEXT,TEXT,UUID),public.training_site_confirmation_project_member_trigger(),
  public.training_site_confirmation_project_status_trigger(),public.training_site_confirmation_record_photo_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_site_confirmation_record_photo_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.training_site_confirmation_ensure(UUID,TEXT),public.training_site_confirmation_status(UUID,UUID),
  public.training_site_confirmation_project_list(UUID),public.training_site_confirmation_prepare(UUID),
  public.training_site_confirmation_file_can_upload(TEXT),public.training_site_confirmation_file_can_read(TEXT),
  public.training_site_confirmation_file_validation_context(UUID),public.training_site_confirmation_submit(UUID,TEXT,TEXT,JSONB,JSONB),
  public.training_site_confirmation_supplement_location(UUID,JSONB,TEXT),public.training_site_confirmation_supersede(UUID,TEXT,TEXT,TEXT)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_site_confirmation_ensure(UUID,TEXT),public.training_site_confirmation_status(UUID,UUID),
  public.training_site_confirmation_project_list(UUID),public.training_site_confirmation_prepare(UUID),
  public.training_site_confirmation_file_can_upload(TEXT),public.training_site_confirmation_file_can_read(TEXT),
  public.training_site_confirmation_file_validation_context(UUID),public.training_site_confirmation_submit(UUID,TEXT,TEXT,JSONB,JSONB),
  public.training_site_confirmation_supplement_location(UUID,JSONB,TEXT),public.training_site_confirmation_supersede(UUID,TEXT,TEXT,TEXT)
  TO authenticated;

CREATE POLICY training_site_confirmation_photo_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(
  bucket_id='certificates' AND public.training_site_confirmation_file_can_upload(name)
  AND lower(COALESCE(metadata->>'mimetype',metadata->>'contentType','')) IN('image/png','image/jpeg')
  AND COALESCE((metadata->>'size')::bigint,0) BETWEEN 1 AND 5242880
);
CREATE POLICY training_site_confirmation_photo_read ON storage.objects FOR SELECT TO authenticated USING(
  bucket_id='certificates' AND public.training_site_confirmation_file_can_read(name)
);

COMMENT ON TABLE public.training_site_confirmation_results IS 'D16 immutable server-authoritative site confirmation evidence; photo required and location optional.';
COMMENT ON FUNCTION public.training_site_confirmation_status(UUID,UUID) IS 'D16 person plus project authoritative site-confirmation status; clients must not infer locally.';
COMMIT;

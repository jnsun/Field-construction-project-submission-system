-- S3-C: server-side publish validation used by the company-admin Web console.
BEGIN;

CREATE FUNCTION public.training_scheme_validate_publish(p_version_id UUID) RETURNS JSONB AS $$
DECLARE v public.three_level_training_scheme_versions; v_reason TEXT; v_conflicts JSONB;
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id;
  IF v.id IS NULL THEN v_reason:='scheme_version_not_found';
  ELSIF v.status<>'draft' THEN v_reason:='scheme_version_not_draft';
  ELSIF v.effective_from IS NULL THEN v_reason:='scheme_effective_date_required';
  ELSIF (SELECT count(*) FROM public.three_level_training_scheme_stages WHERE scheme_version_id=v.id)<>3 THEN v_reason:='invalid_stage_structure';
  ELSIF EXISTS(SELECT 1 FROM public.three_level_training_scheme_stages s LEFT JOIN public.training_admission_packages p ON p.id=s.training_package_id
    WHERE s.scheme_version_id=v.id AND (p.id IS NULL OR p.status<>'published' OR p.training_category<>'basic_three_level')) THEN v_reason:='training_package_not_valid';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('rule_id',a.id,'conflicting_rule_id',b.id,'priority',a.priority,
    'precedence',CASE WHEN a.organization_unit_id IS NOT NULL THEN 3 WHEN a.organization_type IS NOT NULL THEN 2 ELSE 1 END)),'[]'::jsonb)
  INTO v_conflicts
  FROM public.three_level_training_applicability_rules a
  JOIN public.three_level_training_applicability_rules b ON b.id<>a.id AND b.scheme_id<>a.scheme_id AND b.active
    AND b.priority=a.priority
    AND (CASE WHEN b.organization_unit_id IS NOT NULL THEN 3 WHEN b.organization_type IS NOT NULL THEN 2 ELSE 1 END)
      =(CASE WHEN a.organization_unit_id IS NOT NULL THEN 3 WHEN a.organization_type IS NOT NULL THEN 2 ELSE 1 END)
    AND b.organization_unit_id IS NOT DISTINCT FROM a.organization_unit_id
    AND b.organization_type IS NOT DISTINCT FROM a.organization_type
    AND (a.employment_status IS NULL OR b.employment_status IS NULL OR a.employment_status=b.employment_status)
    AND (a.employment_type IS NULL OR b.employment_type IS NULL OR a.employment_type=b.employment_type)
    AND (a.position_category IS NULL OR b.position_category IS NULL OR a.position_category=b.position_category)
    AND daterange(a.effective_from,COALESCE(a.effective_to,'infinity'::date),'[]') && daterange(b.effective_from,COALESCE(b.effective_to,'infinity'::date),'[]')
  WHERE a.scheme_id=v.scheme_id AND a.active;
  IF v_reason IS NULL AND jsonb_array_length(v_conflicts)>0 THEN v_reason:='applicability_rule_conflict'; END IF;
  RETURN jsonb_build_object('valid',v_reason IS NULL,'reason_code',COALESCE(v_reason,'publish_validation_passed'),'conflicts',v_conflicts,
    'scheme_id',v.scheme_id,'scheme_version_id',v.id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_scheme_applicability_conflicts() RETURNS JSONB AS $$
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'rule_id',a.id,'conflicting_rule_id',b.id,'scheme_id',a.scheme_id,
      'conflicting_scheme_id',b.scheme_id,'priority',a.priority,
      'precedence',CASE WHEN a.organization_unit_id IS NOT NULL THEN 3 WHEN a.organization_type IS NOT NULL THEN 2 ELSE 1 END
    ) ORDER BY a.id,b.id),'[]'::jsonb)
    FROM public.three_level_training_applicability_rules a
    JOIN public.three_level_training_applicability_rules b ON b.id>a.id AND b.scheme_id<>a.scheme_id AND b.active
      AND b.priority=a.priority
      AND (CASE WHEN b.organization_unit_id IS NOT NULL THEN 3 WHEN b.organization_type IS NOT NULL THEN 2 ELSE 1 END)
        =(CASE WHEN a.organization_unit_id IS NOT NULL THEN 3 WHEN a.organization_type IS NOT NULL THEN 2 ELSE 1 END)
      AND b.organization_unit_id IS NOT DISTINCT FROM a.organization_unit_id
      AND b.organization_type IS NOT DISTINCT FROM a.organization_type
      AND (a.employment_status IS NULL OR b.employment_status IS NULL OR a.employment_status=b.employment_status)
      AND (a.employment_type IS NULL OR b.employment_type IS NULL OR a.employment_type=b.employment_type)
      AND (a.position_category IS NULL OR b.position_category IS NULL OR a.position_category=b.position_category)
      AND daterange(a.effective_from,COALESCE(a.effective_to,'infinity'::date),'[]') && daterange(b.effective_from,COALESCE(b.effective_to,'infinity'::date),'[]')
    WHERE a.active
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.training_scheme_publish(p_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.three_level_training_scheme_versions; v_before JSONB; v_after JSONB; v_validation JSONB;
BEGIN
  PERFORM public.training_scheme_require_company_admin();
  v_validation:=public.training_scheme_validate_publish(p_version_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    IF v_validation->>'reason_code'='applicability_rule_conflict' THEN RAISE EXCEPTION '[S3C:applicability_rule_conflict] 适用规则存在同层级同 priority 冲突'; END IF;
    RAISE EXCEPTION '[S3A:%] 方案发布校验失败',v_validation->>'reason_code';
  END IF;
  SELECT * INTO v FROM public.three_level_training_scheme_versions WHERE id=p_version_id FOR UPDATE;
  v_before:=to_jsonb(v); PERFORM set_config('app.training_scheme_lifecycle','on',true);
  UPDATE public.three_level_training_scheme_versions SET status='superseded',effective_to=v.effective_from-1
    WHERE scheme_id=v.scheme_id AND status='published' AND effective_from<v.effective_from;
  UPDATE public.three_level_training_scheme_versions SET status='published',published_by=public.training_current_account_subject_id(),published_at=NOW() WHERE id=p_version_id;
  SELECT to_jsonb(x) INTO v_after FROM public.three_level_training_scheme_versions x WHERE id=p_version_id;
  PERFORM public.training_configuration_audit_write('three_level_training_scheme_version',p_version_id,'publish',v_before,v_after,p_reason,p_request_id);
  RETURN v_after;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

REVOKE ALL ON FUNCTION public.training_scheme_validate_publish(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_scheme_validate_publish(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.training_scheme_applicability_conflicts() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_scheme_applicability_conflicts() TO authenticated;

COMMIT;

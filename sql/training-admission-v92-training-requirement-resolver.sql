-- S3-B: authoritative three-level resolver and immutable requirement snapshots.
BEGIN;

CREATE TABLE public.training_requirement_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_type TEXT NOT NULL DEFAULT 'basic_three_level' CHECK(requirement_type='basic_three_level'),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  employment_relation_id UUID NOT NULL,
  organization_assignment_id UUID NOT NULL REFERENCES public.employment_organization_assignments(id) ON DELETE RESTRICT,
  organization_unit_id UUID NOT NULL REFERENCES public.organization_units(id) ON DELETE RESTRICT,
  matched_applicability_rule_id UUID NOT NULL REFERENCES public.three_level_training_applicability_rules(id) ON DELETE RESTRICT,
  scheme_id UUID NOT NULL REFERENCES public.three_level_training_schemes(id) ON DELETE RESTRICT,
  scheme_version_id UUID NOT NULL REFERENCES public.three_level_training_scheme_versions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_as_of DATE NOT NULL,
  resolver_version TEXT NOT NULL DEFAULT 'three-level-resolver-v1',
  reason_code TEXT NOT NULL,
  explanation TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'authoritative_resolver',
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  request_id TEXT,
  authority_facts JSONB NOT NULL CHECK(jsonb_typeof(authority_facts)='object'),
  UNIQUE(employment_relation_id,requirement_type)
);

CREATE TABLE public.training_requirement_snapshot_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES public.training_requirement_snapshots(id) ON DELETE RESTRICT,
  stage_order SMALLINT NOT NULL CHECK(stage_order BETWEEN 1 AND 3),
  stage_level TEXT NOT NULL CHECK(stage_level IN('company','organization','third')),
  stage_type TEXT NOT NULL CHECK(stage_type IN('company','organization','basic_project','actual_project','department_position','logistics_position','entity_position')),
  training_package_id UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  training_package_version_id UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  training_package_version_no INTEGER NOT NULL CHECK(training_package_version_no>0),
  required BOOLEAN NOT NULL,
  minimum_study_parameter_id TEXT REFERENCES public.system_parameter_definitions(parameter_id) ON DELETE RESTRICT,
  minimum_study_parameter_version_id UUID REFERENCES public.system_parameter_versions(id) ON DELETE RESTRICT,
  minimum_study_parameter_version_no INTEGER,
  minimum_study_value JSONB,
  exam_policy_reference TEXT,
  signature_policy_reference TEXT,
  site_project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  requirement_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(requirement_metadata)='object'),
  UNIQUE(snapshot_id,stage_order),
  CHECK(training_package_id=training_package_version_id),
  CHECK((stage_type='actual_project' AND site_project_id IS NOT NULL) OR (stage_type<>'actual_project' AND site_project_id IS NULL))
);

CREATE TABLE public.training_requirement_snapshot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES public.training_requirement_snapshots(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN('generated','reused')),
  resolver_version TEXT NOT NULL,
  matched_applicability_rule_id UUID NOT NULL,
  scheme_version_id UUID NOT NULL,
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  actor_source TEXT NOT NULL CHECK(actor_source IN('authenticated_user','system')),
  request_id TEXT,
  authority_facts JSONB NOT NULL CHECK(jsonb_typeof(authority_facts)='object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX training_requirement_snapshot_event_request_idx
  ON public.training_requirement_snapshot_events(snapshot_id,request_id) WHERE request_id IS NOT NULL;

CREATE FUNCTION public.training_requirement_snapshot_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION '[S3B:requirement_snapshot_immutable] 三级教育 requirement snapshot 不可修改或删除'; END;
$$ LANGUAGE plpgsql SET search_path=public;
CREATE TRIGGER trg_training_requirement_snapshot_immutable BEFORE UPDATE OR DELETE ON public.training_requirement_snapshots FOR EACH ROW EXECUTE FUNCTION public.training_requirement_snapshot_immutable();
CREATE TRIGGER trg_training_requirement_snapshot_items_immutable BEFORE UPDATE OR DELETE ON public.training_requirement_snapshot_items FOR EACH ROW EXECUTE FUNCTION public.training_requirement_snapshot_immutable();
CREATE TRIGGER trg_training_requirement_snapshot_events_immutable BEFORE UPDATE OR DELETE ON public.training_requirement_snapshot_events FOR EACH ROW EXECUTE FUNCTION public.training_requirement_snapshot_immutable();

CREATE OR REPLACE FUNCTION public.training_three_level_resolution_can_read(p_employee_id UUID,p_site_project_id UUID DEFAULT NULL) RETURNS BOOLEAN AS $$
  SELECT COALESCE(public.training_account_is_active(auth.uid()) AND (
    p_employee_id=public.training_my_employee_id()
    OR public.training_scheme_is_company_admin()
    OR public.training_three_level_can_read(p_employee_id)
    OR (p_site_project_id IS NOT NULL AND public.site_project_can_read(p_site_project_id))
  ),FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE OR REPLACE FUNCTION public.resolve_three_level_training_scheme(
  p_employee_id UUID,
  p_employment_relation_id UUID,
  p_as_of DATE DEFAULT CURRENT_DATE,
  p_site_project_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_profile public.training_three_level_profiles;
  v_employee public.training_employees;
  v_assignment public.employment_organization_assignments;
  v_org public.organization_units;
  v_top RECORD;
  v_rule public.three_level_training_applicability_rules;
  v_version public.three_level_training_scheme_versions;
  v_version_id UUID;
  v_version_count INTEGER;
  v_stages JSONB;
  v_stage_count INTEGER;
  v_actual BOOLEAN;
  v_explanation TEXT;
BEGIN
  IF p_employee_id IS NULL OR NOT public.training_three_level_resolution_can_read(p_employee_id,p_site_project_id) THEN
    RAISE EXCEPTION '[S3B:forbidden] 无权解析该人员三级教育方案' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_employee FROM public.training_employees WHERE id=p_employee_id;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id;
  IF v_profile.employee_id IS NULL OR p_employment_relation_id IS NULL OR v_profile.employment_relation_id<>p_employment_relation_id THEN
    RETURN jsonb_build_object('status','blocked','applicable',FALSE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'reason_code','employment_relation_required','explanation','缺少与人员匹配的当前正式用工关系','resolver_version','three-level-resolver-v1');
  END IF;
  IF v_profile.person_category<>'formal_internal' THEN
    RETURN jsonb_build_object('status','not_applicable','applicable',FALSE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'person_category',v_profile.person_category,'reason_code','three_level_not_applicable','explanation','该人员类别不适用本公司员工三级教育','resolver_version','three-level-resolver-v1');
  END IF;
  SELECT * INTO v_assignment FROM public.employment_organization_assignments a
    WHERE a.employment_relation_id=p_employment_relation_id AND a.employee_id=p_employee_id
      AND a.effective_from<=p_as_of AND (a.effective_to IS NULL OR a.effective_to>=p_as_of)
    ORDER BY a.version_no DESC LIMIT 1;
  IF v_assignment.id IS NULL THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'person_category',v_profile.person_category,'reason_code','organization_assignment_required','explanation','缺少该用工关系在解析日期的权威组织归属','resolver_version','three-level-resolver-v1');
  END IF;
  SELECT * INTO v_org FROM public.organization_units WHERE id=v_assignment.organization_unit_id;
  IF v_org.id IS NULL OR p_as_of<v_org.effective_from OR (v_org.effective_to IS NOT NULL AND p_as_of>v_org.effective_to)
     OR (NOT v_org.active AND v_org.effective_to IS NULL) THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'organization_assignment_id',v_assignment.id,'organization_unit_id',v_assignment.organization_unit_id,
      'reason_code','organization_assignment_required','explanation','权威组织在解析日期无效','resolver_version','three-level-resolver-v1');
  END IF;

  SELECT specificity,priority,count(DISTINCT scheme_id) scheme_count,min(scheme_id::text)::uuid scheme_id,
    min(id::text)::uuid matched_rule_id,jsonb_agg(id ORDER BY rule_code) matched_rule_ids
  INTO v_top FROM (
    SELECT r.*,CASE WHEN r.organization_unit_id IS NOT NULL THEN 3 WHEN r.organization_type IS NOT NULL THEN 2 ELSE 1 END specificity
    FROM public.three_level_training_applicability_rules r
    WHERE r.active AND r.person_category='formal_internal'
      AND p_as_of>=r.effective_from AND (r.effective_to IS NULL OR p_as_of<=r.effective_to)
      AND (r.organization_unit_id IS NULL OR r.organization_unit_id=v_org.id)
      AND (r.organization_type IS NULL OR r.organization_type=v_org.organization_type)
      AND (r.employment_status IS NULL OR r.employment_status=v_employee.status)
      AND (r.employment_type IS NULL OR r.employment_type=v_employee.emp_type)
      AND (r.position_category IS NULL OR r.position_category=v_employee.position)
  ) candidates GROUP BY specificity,priority ORDER BY specificity DESC,priority DESC LIMIT 1;
  IF v_top.specificity IS NULL THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'organization_assignment_id',v_assignment.id,'organization_unit_id',v_org.id,'organization_type',v_org.organization_type,
      'reason_code','training_scheme_not_found','explanation','没有匹配的三级教育适用规则','resolver_version','three-level-resolver-v1');
  END IF;
  IF v_top.scheme_count>1 THEN
    RETURN jsonb_build_object('status','ambiguous','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'organization_assignment_id',v_assignment.id,'organization_unit_id',v_org.id,'organization_type',v_org.organization_type,
      'matched_rule_ids',v_top.matched_rule_ids,'precedence',v_top.specificity,'priority',v_top.priority,
      'reason_code','training_scheme_ambiguous','explanation','同一优先层级和 priority 匹配到不同方案，已拒绝随机选择','resolver_version','three-level-resolver-v1');
  END IF;
  SELECT * INTO v_rule FROM public.three_level_training_applicability_rules WHERE id=v_top.matched_rule_id;

  SELECT count(*),min(id::text)::uuid INTO v_version_count,v_version_id
  FROM public.three_level_training_scheme_versions sv
  WHERE sv.scheme_id=v_rule.scheme_id AND sv.status IN('published','retired','superseded')
    AND sv.published_at IS NOT NULL AND sv.published_at::date<=p_as_of
    AND sv.effective_from<=p_as_of AND (sv.effective_to IS NULL OR sv.effective_to>=p_as_of)
    AND (v_rule.version_selection_policy='latest_published' OR sv.id=v_rule.pinned_scheme_version_id);
  IF v_version_count<>1 THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'organization_assignment_id',v_assignment.id,'organization_unit_id',v_org.id,'matched_rule_id',v_rule.id,'scheme_id',v_rule.scheme_id,
      'precedence',v_top.specificity,'priority',v_top.priority,'reason_code','training_scheme_version_not_effective',
      'explanation','解析日期没有唯一已发布且有效的方案版本','resolver_version','three-level-resolver-v1');
  END IF;
  SELECT * INTO v_version FROM public.three_level_training_scheme_versions WHERE id=v_version_id;

  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object(
    'stage_id',s.id,'stage_order',s.stage_order,'stage_level',s.stage_level,'stage_type',s.stage_type,'required',s.required,
    'training_package_id',p.id,'training_package_version_id',p.id,'training_package_version_no',p.version_no,
    'minimum_study_parameter_id',s.minimum_study_parameter_id,
    'minimum_study_parameter_version_id',sp.value->>'version_id','minimum_study_parameter_version_no',COALESCE((sp.value->>'version_no')::integer,0),
    'minimum_study_value',sp.value->'value','exam_policy_reference',s.exam_policy_reference,
    'signature_policy_reference',s.signature_policy_reference,'site_project_id',CASE WHEN s.stage_type='actual_project' THEN p_site_project_id END,
    'metadata',s.metadata) ORDER BY s.stage_order),'[]'::jsonb),bool_or(s.stage_type='actual_project')
  INTO v_stage_count,v_stages,v_actual
  FROM public.three_level_training_scheme_stages s
  LEFT JOIN public.training_admission_packages p ON p.id=s.training_package_id AND p.status='published' AND p.training_category='basic_three_level'
  LEFT JOIN LATERAL (SELECT public.system_parameter_effective(s.minimum_study_parameter_id,NULL,p_as_of::timestamptz) value) sp ON s.minimum_study_parameter_id IS NOT NULL
  WHERE s.scheme_version_id=v_version.id;
  IF v_stage_count<>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_stages) x WHERE x->>'training_package_id' IS NULL) THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'scheme_id',v_rule.scheme_id,'scheme_version_id',v_version.id,'reason_code',CASE WHEN v_stage_count<>3 THEN 'training_stage_invalid' ELSE 'training_package_version_required' END,
      'explanation','方案 stage 或培训包版本不完整','resolver_version','three-level-resolver-v1');
  END IF;
  IF v_actual AND (p_site_project_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.site_projects p JOIN public.site_project_members m ON m.project_id=p.id
    WHERE p.id=p_site_project_id AND p.status='active' AND m.employee_id=p_employee_id AND m.status='active')) THEN
    RETURN jsonb_build_object('status','blocked','applicable',TRUE,'employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,
      'organization_assignment_id',v_assignment.id,'organization_unit_id',v_org.id,'matched_rule_id',v_rule.id,'scheme_id',v_rule.scheme_id,'scheme_version_id',v_version.id,
      'precedence',v_top.specificity,'priority',v_top.priority,'reason_code','actual_project_required','explanation','actual_project 第三级必须绑定人员当前所在的有效项目','resolver_version','three-level-resolver-v1');
  END IF;
  v_explanation:=format('正式员工按组织 %s 命中 precedence=%s priority=%s 的规则和已发布方案版本',v_org.organization_code,v_top.specificity,v_top.priority);
  RETURN jsonb_build_object('status','resolved','applicable',TRUE,'employee_id',p_employee_id,'subject_id',(SELECT id FROM public.account_subjects WHERE employee_id=p_employee_id ORDER BY created_at LIMIT 1),
    'employment_relation_id',p_employment_relation_id,'person_category',v_profile.person_category,'onboarding_category',v_profile.onboarding_category,
    'organization_assignment_id',v_assignment.id,'organization_unit_id',v_org.id,'organization_code',v_org.organization_code,'organization_type',v_org.organization_type,
    'matched_rule_id',v_rule.id,'matched_rule_ids',v_top.matched_rule_ids,'precedence',v_top.specificity,'priority',v_top.priority,
    'scheme_id',v_rule.scheme_id,'scheme_version_id',v_version.id,'scheme_version_number',v_version.version_number,
    'effective_as_of',p_as_of,'site_project_id',CASE WHEN v_actual THEN p_site_project_id END,'stages',v_stages,
    'reason_code','three_level_requirement_resolved','explanation',v_explanation,'resolver_version','three-level-resolver-v1');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.explain_three_level_training_resolution(
  p_employee_id UUID,p_employment_relation_id UUID,p_as_of DATE DEFAULT CURRENT_DATE,p_site_project_id UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_result JSONB; v_org UUID; v_rules JSONB;
BEGIN
  v_result:=public.resolve_three_level_training_scheme(p_employee_id,p_employment_relation_id,p_as_of,p_site_project_id);
  v_org:=NULLIF(v_result->>'organization_unit_id','')::uuid;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('rule_id',r.id,'rule_code',r.rule_code,'scheme_id',r.scheme_id,'active',r.active,
    'precedence',CASE WHEN r.organization_unit_id IS NOT NULL THEN 3 WHEN r.organization_type IS NOT NULL THEN 2 ELSE 1 END,
    'priority',r.priority,'matched',r.id::text=ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_result->'matched_rule_ids','[]'::jsonb)))),
    'excluded_reason',CASE WHEN NOT r.active THEN 'inactive' WHEN p_as_of<r.effective_from OR (r.effective_to IS NOT NULL AND p_as_of>r.effective_to) THEN 'outside_effective_date'
      WHEN r.organization_unit_id IS NOT NULL AND r.organization_unit_id IS DISTINCT FROM v_org THEN 'organization_unit_mismatch'
      WHEN r.organization_type IS NOT NULL AND r.organization_type IS DISTINCT FROM v_result->>'organization_type' THEN 'organization_type_mismatch' ELSE NULL END)
    ORDER BY r.rule_code),'[]'::jsonb) INTO v_rules FROM public.three_level_training_applicability_rules r;
  RETURN v_result||jsonb_build_object('evaluated_rules',v_rules);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_requirement_snapshot_json(p_snapshot_id UUID) RETURNS JSONB AS $$
  SELECT to_jsonb(s)||jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.stage_order) FROM public.training_requirement_snapshot_items i WHERE i.snapshot_id=s.id),'[]'::jsonb))
  FROM public.training_requirement_snapshots s WHERE s.id=p_snapshot_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.generate_three_level_training_requirement_snapshot(
  p_employee_id UUID,p_employment_relation_id UUID,p_as_of DATE DEFAULT CURRENT_DATE,p_site_project_id UUID DEFAULT NULL,p_request_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_profile public.training_three_level_profiles; v_existing UUID; v_resolution JSONB; v_snapshot public.training_requirement_snapshots; v_item JSONB; v_facts JSONB;
BEGIN
  IF p_employee_id IS NULL OR NOT public.training_three_level_resolution_can_read(p_employee_id,p_site_project_id) THEN RAISE EXCEPTION '[S3B:forbidden] 无权生成该人员三级教育 requirement snapshot' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_profile FROM public.training_three_level_profiles WHERE employee_id=p_employee_id AND employment_relation_id=p_employment_relation_id FOR UPDATE;
  IF v_profile.employee_id IS NULL THEN RETURN jsonb_build_object('status','blocked','reason_code','employment_relation_required'); END IF;
  SELECT id INTO v_existing FROM public.training_requirement_snapshots WHERE employment_relation_id=p_employment_relation_id AND requirement_type='basic_three_level';
  IF v_existing IS NOT NULL THEN
    INSERT INTO public.training_requirement_snapshot_events(snapshot_id,event_type,resolver_version,matched_applicability_rule_id,scheme_version_id,operator_subject_id,actor_source,request_id,authority_facts)
    SELECT s.id,'reused',s.resolver_version,s.matched_applicability_rule_id,s.scheme_version_id,public.training_current_account_subject_id(),CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'authenticated_user' END,NULLIF(btrim(p_request_id),''),s.authority_facts
    FROM public.training_requirement_snapshots s WHERE s.id=v_existing ON CONFLICT(snapshot_id,request_id) WHERE request_id IS NOT NULL DO NOTHING;
    RETURN public.training_requirement_snapshot_json(v_existing)||jsonb_build_object('reason_code','requirement_snapshot_exists','reused',TRUE);
  END IF;
  IF v_profile.person_category<>'formal_internal' THEN RETURN jsonb_build_object('status','not_applicable','reason_code','three_level_not_applicable'); END IF;
  IF v_profile.onboarding_category NOT IN('new_hire','legacy_supplement') OR v_profile.status NOT IN('required','in_progress') THEN
    RETURN jsonb_build_object('status','blocked','reason_code','requirement_snapshot_not_required');
  END IF;
  v_resolution:=public.resolve_three_level_training_scheme(p_employee_id,p_employment_relation_id,p_as_of,p_site_project_id);
  IF v_resolution->>'status'<>'resolved' THEN RETURN v_resolution; END IF;
  v_facts:=jsonb_build_object('employee_id',p_employee_id,'employment_relation_id',p_employment_relation_id,'person_category',v_profile.person_category,
    'onboarding_category',v_profile.onboarding_category,'organization_assignment_id',v_resolution->>'organization_assignment_id','organization_unit_id',v_resolution->>'organization_unit_id',
    'matched_rule_id',v_resolution->>'matched_rule_id','scheme_version_id',v_resolution->>'scheme_version_id','effective_as_of',p_as_of);
  INSERT INTO public.training_requirement_snapshots(employee_id,subject_id,employment_relation_id,organization_assignment_id,organization_unit_id,matched_applicability_rule_id,
    scheme_id,scheme_version_id,effective_as_of,reason_code,explanation,operator_subject_id,request_id,authority_facts)
  VALUES(p_employee_id,NULLIF(v_resolution->>'subject_id','')::uuid,p_employment_relation_id,(v_resolution->>'organization_assignment_id')::uuid,(v_resolution->>'organization_unit_id')::uuid,
    (v_resolution->>'matched_rule_id')::uuid,(v_resolution->>'scheme_id')::uuid,(v_resolution->>'scheme_version_id')::uuid,p_as_of,v_resolution->>'reason_code',v_resolution->>'explanation',
    public.training_current_account_subject_id(),NULLIF(btrim(p_request_id),''),v_facts) RETURNING * INTO v_snapshot;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_resolution->'stages') LOOP
    INSERT INTO public.training_requirement_snapshot_items(snapshot_id,stage_order,stage_level,stage_type,training_package_id,training_package_version_id,
      training_package_version_no,required,minimum_study_parameter_id,minimum_study_parameter_version_id,minimum_study_parameter_version_no,minimum_study_value,
      exam_policy_reference,signature_policy_reference,site_project_id,requirement_metadata)
    VALUES(v_snapshot.id,(v_item->>'stage_order')::smallint,v_item->>'stage_level',v_item->>'stage_type',(v_item->>'training_package_id')::uuid,
      (v_item->>'training_package_version_id')::uuid,(v_item->>'training_package_version_no')::integer,(v_item->>'required')::boolean,
      NULLIF(v_item->>'minimum_study_parameter_id',''),NULLIF(v_item->>'minimum_study_parameter_version_id','')::uuid,NULLIF(v_item->>'minimum_study_parameter_version_no','')::integer,
      v_item->'minimum_study_value',NULLIF(v_item->>'exam_policy_reference',''),NULLIF(v_item->>'signature_policy_reference',''),NULLIF(v_item->>'site_project_id','')::uuid,
      COALESCE(v_item->'metadata','{}'::jsonb));
  END LOOP;
  INSERT INTO public.training_requirement_snapshot_events(snapshot_id,event_type,resolver_version,matched_applicability_rule_id,scheme_version_id,operator_subject_id,actor_source,request_id,authority_facts)
  VALUES(v_snapshot.id,'generated',v_snapshot.resolver_version,v_snapshot.matched_applicability_rule_id,v_snapshot.scheme_version_id,public.training_current_account_subject_id(),
    CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'authenticated_user' END,NULLIF(btrim(p_request_id),''),v_facts);
  RETURN public.training_requirement_snapshot_json(v_snapshot.id)||jsonb_build_object('reused',FALSE);
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_existing FROM public.training_requirement_snapshots WHERE employment_relation_id=p_employment_relation_id AND requirement_type='basic_three_level';
  IF v_existing IS NULL THEN RAISE; END IF;
  RETURN public.training_requirement_snapshot_json(v_existing)||jsonb_build_object('reason_code','requirement_snapshot_exists','reused',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_three_level_requirement_snapshot(p_employee_id UUID,p_employment_relation_id UUID) RETURNS JSONB AS $$
DECLARE v_id UUID; BEGIN
  IF NOT public.training_three_level_resolution_can_read(p_employee_id,NULL) THEN RAISE EXCEPTION '[S3B:forbidden] 无权查看 requirement snapshot' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_id FROM public.training_requirement_snapshots WHERE employee_id=p_employee_id AND employment_relation_id=p_employment_relation_id AND requirement_type='basic_three_level';
  RETURN public.training_requirement_snapshot_json(v_id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_three_level_resolution_shadow(p_employee_id UUID,p_employment_relation_id UUID,p_project_id UUID DEFAULT NULL,p_as_of DATE DEFAULT CURRENT_DATE) RETURNS JSONB AS $$
DECLARE v_old JSONB; v_new JSONB; v_old_applicable BOOLEAN; v_new_applicable BOOLEAN;
BEGIN
  v_old:=public.training_three_level_status(p_project_id,p_employee_id);
  v_new:=public.resolve_three_level_training_scheme(p_employee_id,p_employment_relation_id,p_as_of,p_project_id);
  v_old_applicable:=COALESCE((v_old->>'three_level_applicable')::boolean,FALSE);
  v_new_applicable:=COALESCE((v_new->>'applicable')::boolean,FALSE);
  RETURN jsonb_build_object('old',v_old,'new',v_new,'comparison',jsonb_build_object(
    'applicable_equal',v_old_applicable=v_new_applicable,'old_applicable',v_old_applicable,'new_applicable',v_new_applicable,
    'company_requirement',(SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_new->'stages','[]'::jsonb)) x WHERE x->>'stage_level'='company')),
    'organization_requirement',(SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_new->'stages','[]'::jsonb)) x WHERE x->>'stage_level'='organization')),
    'third_requirement',(SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v_new->'stages','[]'::jsonb)) x WHERE x->>'stage_level'='third')),
    'old_third_types',(SELECT COALESCE(jsonb_agg(DISTINCT r.third_level_mode),'[]'::jsonb) FROM public.training_three_level_records r WHERE r.employment_relation_id=p_employment_relation_id AND r.level='third'),
    'new_third_type',(SELECT x->>'stage_type' FROM jsonb_array_elements(COALESCE(v_new->'stages','[]'::jsonb)) x WHERE x->>'stage_level'='third' LIMIT 1)));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

ALTER TABLE public.training_requirement_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_requirement_snapshot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_requirement_snapshot_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY training_requirement_snapshots_read ON public.training_requirement_snapshots FOR SELECT TO authenticated USING(public.training_three_level_resolution_can_read(employee_id,NULL));
CREATE POLICY training_requirement_snapshot_items_read ON public.training_requirement_snapshot_items FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.training_requirement_snapshots s WHERE s.id=snapshot_id AND public.training_three_level_resolution_can_read(s.employee_id,NULL)));
CREATE POLICY training_requirement_snapshot_events_read ON public.training_requirement_snapshot_events FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.training_requirement_snapshots s WHERE s.id=snapshot_id AND public.training_three_level_resolution_can_read(s.employee_id,NULL)));
REVOKE ALL ON public.training_requirement_snapshots,public.training_requirement_snapshot_items,public.training_requirement_snapshot_events FROM PUBLIC,authenticated,anon;
GRANT SELECT ON public.training_requirement_snapshots,public.training_requirement_snapshot_items,public.training_requirement_snapshot_events TO authenticated;

REVOKE ALL ON FUNCTION public.training_requirement_snapshot_immutable(),public.training_three_level_resolution_can_read(UUID,UUID),public.training_requirement_snapshot_json(UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.resolve_three_level_training_scheme(UUID,UUID,DATE,UUID),public.explain_three_level_training_resolution(UUID,UUID,DATE,UUID),
 public.generate_three_level_training_requirement_snapshot(UUID,UUID,DATE,UUID,TEXT),public.training_three_level_requirement_snapshot(UUID,UUID),
 public.training_three_level_resolution_shadow(UUID,UUID,UUID,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_three_level_training_scheme(UUID,UUID,DATE,UUID),public.explain_three_level_training_resolution(UUID,UUID,DATE,UUID),
 public.generate_three_level_training_requirement_snapshot(UUID,UUID,DATE,UUID,TEXT),public.training_three_level_requirement_snapshot(UUID,UUID),
 public.training_three_level_resolution_shadow(UUID,UUID,UUID,DATE) TO authenticated;

COMMENT ON FUNCTION public.resolve_three_level_training_scheme(UUID,UUID,DATE,UUID) IS 'S3-B authoritative resolver v1; D11/D13 production paths remain unchanged until an explicit later switch.';
COMMENT ON TABLE public.training_requirement_snapshots IS 'Immutable one-per-employment-relation basic three-level requirement authority snapshot.';

COMMIT;

-- ============================================================================
-- 培训准入第三十五批：外协资料转档与上岗资格联动
-- 前置：training-admission-v1.sql 至 training-admission-v34.sql 已执行。
-- 申请附件转入台账后均为待审核，绝不自动视为合格。
-- ============================================================================

ALTER TABLE public.project_join_application_attachments
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported_document_id UUID REFERENCES public.contractor_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS imported_contract_id UUID REFERENCES public.contractor_contracts(id) ON DELETE SET NULL;

-- 外协人员上岗前必须满足：单位有效、项目合同有效、单位资质审核通过；
-- 爆破、钻探、电工、焊工还必须有本人有效的特种作业证。
CREATE OR REPLACE FUNCTION public.training_external_compliance_reason(
  p_project_id UUID, p_employee_id UUID, p_member_id UUID DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_member public.site_project_members;
  v_position TEXT;
  v_company_status TEXT;
BEGIN
  SELECT m, COALESCE(m.work_type, e.position) INTO v_member, v_position
  FROM public.site_project_members m
  JOIN public.training_employees e ON e.id = m.employee_id
  WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
    AND (p_member_id IS NULL OR m.id = p_member_id);
  IF NOT FOUND OR v_member.membership_type <> 'external' THEN RETURN NULL; END IF;

  SELECT c.status INTO v_company_status FROM public.contractor_companies c WHERE c.id = v_member.contractor_id;
  IF v_company_status IS DISTINCT FROM 'active' THEN RETURN '外协单位尚未审核通过或已停用'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contractor_contracts c
    WHERE c.project_id = p_project_id AND c.contractor_id = v_member.contractor_id AND c.status = 'valid'
      AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
      AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)
  ) THEN
    IF EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = v_member.contractor_id AND c.status = 'valid' AND c.end_date < CURRENT_DATE) THEN
      RETURN '外协合同已到期';
    END IF;
    RETURN '外协合同尚未审核通过';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contractor_documents d
    WHERE d.project_id = p_project_id AND d.contractor_id = v_member.contractor_id
      AND d.document_type = 'qualification' AND d.review_status = 'approved'
      AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
  ) THEN
    IF EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p_project_id AND d.contractor_id = v_member.contractor_id AND d.document_type = 'qualification' AND d.review_status = 'approved' AND d.valid_until < CURRENT_DATE) THEN
      RETURN '外协单位资质已过期';
    END IF;
    RETURN '外协单位资质尚未审核通过';
  END IF;

  IF COALESCE(v_position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (
    SELECT 1 FROM public.contractor_documents d
    WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id
      AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
      AND d.valid_until >= CURRENT_DATE
  ) THEN
    IF EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND d.valid_until < CURRENT_DATE) THEN
      RETURN '特种作业证已过期';
    END IF;
    RETURN '高风险岗位尚未审核通过特种作业证';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 审核通过的入场申请可将原附件转入既有台账。转入后仍须在“外协与入场”页人工审核。
CREATE OR REPLACE FUNCTION public.site_project_import_application_attachment(
  p_attachment_id UUID, p_certificate_type TEXT DEFAULT NULL,
  p_certificate_no TEXT DEFAULT NULL, p_valid_until DATE DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_file public.project_join_application_attachments;
  v_app public.project_join_applications;
  v_id UUID;
BEGIN
  SELECT * INTO v_file FROM public.project_join_application_attachments WHERE id = p_attachment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '申请附件不存在'; END IF;
  SELECT * INTO v_app FROM public.project_join_applications WHERE id = v_file.application_id;
  IF NOT FOUND OR v_app.status <> 'approved' OR v_app.employee_id IS NULL THEN RAISE EXCEPTION '请先完成入场申请审核后再转入台账'; END IF;
  IF NOT public.site_project_can_manage(v_app.project_id) THEN RAISE EXCEPTION '您无权转入该项目资料'; END IF;
  IF v_file.imported_at IS NOT NULL THEN RAISE EXCEPTION '该附件已转入台账'; END IF;

  IF v_file.attachment_type = 'contract' THEN
    INSERT INTO public.contractor_contracts(project_id, contractor_id, contract_name, storage_path, status)
    VALUES (v_app.project_id, v_app.contractor_id, COALESCE(NULLIF(v_file.original_name, ''), '外协申请合同附件'), v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
    UPDATE public.project_join_application_attachments SET imported_at = NOW(), imported_contract_id = v_id WHERE id = v_file.id;
    RETURN jsonb_build_object('kind', 'contract', 'id', v_id);
  END IF;

  IF v_file.attachment_type = 'special_certificate' THEN
    IF NULLIF(btrim(p_certificate_type), '') IS NULL OR NULLIF(btrim(p_certificate_no), '') IS NULL OR p_valid_until IS NULL THEN
      RAISE EXCEPTION '转入特种作业证时必须补充证书类型、编号和有效期';
    END IF;
    IF p_valid_until < CURRENT_DATE THEN RAISE EXCEPTION '特种作业证有效期不能早于今天'; END IF;
    INSERT INTO public.contractor_documents(project_id, contractor_id, employee_id, document_type, certificate_type, certificate_no, valid_until, storage_path, review_status)
    VALUES (v_app.project_id, v_app.contractor_id, v_app.employee_id, 'special_certificate', btrim(p_certificate_type), btrim(p_certificate_no), p_valid_until, v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.contractor_documents(project_id, contractor_id, document_type, storage_path, review_status)
    VALUES (v_app.project_id, v_app.contractor_id, 'qualification', v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
  END IF;
  UPDATE public.project_join_application_attachments SET imported_at = NOW(), imported_document_id = v_id WHERE id = v_file.id;
  RETURN jsonb_build_object('kind', 'document', 'id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 外协资料变更后重算对应人员，供合同/资质/证照人工审核完成后调用。
CREATE OR REPLACE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE
  v_a public.training_admissions; v_p public.site_projects; v_e public.training_employees;
  v_pkg public.training_admission_packages; v_total INT; v_done INT; v_final_signed BOOLEAN; v_external_reason TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT (public.site_project_can_manage(v_a.project_id) OR public.training_is_company_admin() OR public.is_entity_manager() OR v_a.employee_id = public.training_my_employee_id()) THEN RAISE EXCEPTION '您无权重新计算该人员的准入资格'; END IF;
  SELECT * INTO v_p FROM public.site_projects WHERE id = v_a.project_id;
  SELECT * INTO v_e FROM public.training_employees WHERE id = v_a.employee_id;
  SELECT * INTO v_pkg FROM public.training_admission_packages WHERE id = v_a.package_id;
  SELECT COUNT(*)::INT, COUNT(*) FILTER (WHERE status = 'completed')::INT INTO v_total, v_done FROM public.training_admission_tasks WHERE admission_id = p_admission_id;
  SELECT public.training_external_compliance_reason(v_a.project_id, v_a.employee_id, v_a.member_id) INTO v_external_reason;
  SELECT EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee' AND s.cycle_no = v_a.training_cycle_no) INTO v_final_signed;
  UPDATE public.training_admissions SET
    status = CASE
      WHEN v_p.status = 'closed' THEN 'project_closed'
      WHEN v_p.status IN ('paused', 'pending_close') OR v_a.member_id IS NULL THEN 'blocked'
      WHEN v_a.retrain_required THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN 'blocked'
      WHEN v_a.valid_until IS NOT NULL AND v_a.valid_until < CURRENT_DATE THEN 'expired'
      WHEN v_external_reason IS NOT NULL THEN 'blocked'
      WHEN v_total = 0 OR v_done < v_total THEN CASE WHEN v_done > 0 THEN 'learning' ELSE 'pending' END
      WHEN v_a.exam_required AND NOT v_a.exam_passed THEN 'exam_pending'
      WHEN NOT v_final_signed THEN 'pending_sign'
      WHEN v_a.site_confirmed_at IS NULL THEN 'pending_site_confirm'
      ELSE 'eligible' END,
    blocked_reason = CASE
      WHEN v_p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
      WHEN v_p.status = 'closed' THEN '项目已关闭'
      WHEN v_a.retrain_required THEN COALESCE(v_a.retrain_reason, '停工超过设定期限，须完成复训后方可上岗')
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN '人员已离开项目'
      WHEN v_a.valid_until IS NOT NULL AND v_a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期，禁止上岗'
      WHEN v_external_reason IS NOT NULL THEN v_external_reason
      ELSE NULL END,
    valid_until = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL AND v_pkg.id IS NOT NULL
                           AND NOT (v_a.valid_until IS NOT NULL AND v_a.valid_until < CURRENT_DATE)
      THEN (CURRENT_DATE + (v_pkg.validity_years::TEXT || ' years')::INTERVAL)::DATE ELSE valid_until END,
    eligible_from = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL
      THEN COALESCE(eligible_from, NOW()) ELSE eligible_from END, updated_at = NOW()
  WHERE id = p_admission_id RETURNING * INTO v_a;
  RETURN v_a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_refresh_external_admissions(p_project_id UUID DEFAULT NULL, p_contractor_id UUID DEFAULT NULL)
RETURNS INT AS $$
DECLARE v_admission UUID; v_count INT := 0;
BEGIN
  IF p_project_id IS NULL AND NOT (public.training_is_company_admin() OR public.is_entity_manager()) THEN RAISE EXCEPTION '汇总刷新外协资格需要经营实体或公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT (public.site_project_can_manage(p_project_id) OR public.training_is_company_admin() OR public.is_entity_manager()) THEN RAISE EXCEPTION '您无权刷新该项目外协资格'; END IF;
  FOR v_admission IN
    SELECT a.id FROM public.training_admissions a
    JOIN public.site_project_members m ON m.id = a.member_id
    WHERE m.membership_type = 'external' AND (p_project_id IS NULL OR a.project_id = p_project_id) AND (p_contractor_id IS NULL OR m.contractor_id = p_contractor_id)
  LOOP
    PERFORM public.training_recompute_admission(v_admission); v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 员工端和现场扫码均实时叠加外协资料要求，不依赖管理员是否刚好点过刷新。
CREATE OR REPLACE FUNCTION public.training_my_admission_status()
RETURNS TABLE (
  admission_id UUID, project_id UUID, project_code TEXT, project_name TEXT,
  project_location TEXT, project_status TEXT, work_position TEXT, status TEXT,
  blocked_reason TEXT, valid_until DATE, certificate_no TEXT, task_total INT,
  task_done INT, site_confirmed_at TIMESTAMPTZ, due_at TIMESTAMPTZ, urgent BOOLEAN
) AS $$
  SELECT a.id, p.id, p.project_code, p.name, p.location, p.status, e.position,
    CASE WHEN p.status IN ('paused', 'pending_close') THEN 'blocked' WHEN p.status = 'closed' THEN 'project_closed'
      WHEN public.training_external_compliance_reason(p.id, e.id, a.member_id) IS NOT NULL THEN 'blocked'
      WHEN a.status = 'eligible' AND (a.valid_until IS NULL OR a.valid_until >= CURRENT_DATE) THEN 'eligible'
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired' ELSE a.status END,
    CASE WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认' WHEN p.status = 'closed' THEN '项目已关闭'
      WHEN public.training_external_compliance_reason(p.id, e.id, a.member_id) IS NOT NULL THEN public.training_external_compliance_reason(p.id, e.id, a.member_id)
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期' ELSE a.blocked_reason END,
    a.valid_until, c.certificate_no, COALESCE(t.task_total, 0), COALESCE(t.task_done, 0), a.site_confirmed_at, a.due_at, a.urgent
  FROM public.training_admissions a JOIN public.site_projects p ON p.id = a.project_id JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.training_eligibility_certificates c ON c.admission_id = a.id AND c.status = 'valid'
  LEFT JOIN LATERAL (SELECT COUNT(*)::INT AS task_total, COUNT(*) FILTER (WHERE x.status = 'completed')::INT AS task_done FROM public.training_admission_tasks x WHERE x.admission_id = a.id) t ON TRUE
  WHERE a.employee_id = public.training_my_employee_id() ORDER BY p.status = 'active' DESC, p.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_verify_certificate(p_certificate_no TEXT)
RETURNS TABLE(certificate_no TEXT, employee_name TEXT, photo_path TEXT, work_position TEXT, project_code TEXT, project_name TEXT, admission_status TEXT, valid_until DATE, blocked_reason TEXT, project_id UUID, employee_id UUID) AS $$
  SELECT c.certificate_no, e.name, e.photo_path, e.position, p.project_code, p.name,
    CASE WHEN p.status IN ('paused', 'pending_close') THEN 'blocked' WHEN p.status = 'closed' THEN 'project_closed'
      WHEN public.training_external_compliance_reason(p.id, e.id, a.member_id) IS NOT NULL THEN 'blocked'
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired' WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN 'expired' ELSE a.status END,
    LEAST(COALESCE(a.valid_until, c.valid_until), c.valid_until),
    CASE WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认' WHEN p.status = 'closed' THEN '项目已关闭'
      WHEN public.training_external_compliance_reason(p.id, e.id, a.member_id) IS NOT NULL THEN public.training_external_compliance_reason(p.id, e.id, a.member_id)
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期' WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN '电子记录凭证已失效' ELSE a.blocked_reason END,
    p.id, e.id
  FROM public.training_eligibility_certificates c JOIN public.training_admissions a ON a.id = c.admission_id
  JOIN public.site_projects p ON p.id = a.project_id JOIN public.training_employees e ON e.id = a.employee_id
  WHERE upper(c.certificate_no) = upper(btrim(p_certificate_no)) AND public.site_project_can_manage(p.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.site_project_import_application_attachment(UUID, TEXT, TEXT, DATE),
  public.training_recompute_admission(UUID), public.training_refresh_external_admissions(UUID, UUID),
  public.training_my_admission_status(), public.training_verify_certificate(TEXT) TO authenticated;

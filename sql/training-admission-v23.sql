-- ============================================================================
-- 培训准入第二十三批：外协人员检查台账
-- 前置：training-admission-v1.sql 至 training-admission-v22.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_contractor_personnel_ledger(UUID);
CREATE FUNCTION public.training_contractor_personnel_ledger(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, phone TEXT, work_position TEXT,
  contractor_name TEXT, unified_code TEXT, member_status TEXT, joined_at TIMESTAMPTZ,
  contract_no TEXT, contract_name TEXT, contract_status TEXT, special_certificates TEXT,
  certificate_status TEXT, admission_status TEXT, valid_until DATE
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '汇总外协人员台账需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目外协人员台账'; END IF;
  RETURN QUERY
  SELECT p.project_code, p.name, e.name, e.phone, COALESCE(m.work_type, e.position), cc.name, cc.unified_code,
         m.status, m.joined_at, ct.contract_no, ct.contract_name, ct.status,
         COALESCE(cert.certificate_text, '无'), COALESCE(cert.review_text, '未登记'),
         COALESCE(a.status, 'not_started'), a.valid_until
  FROM public.site_project_members m
  JOIN public.site_projects p ON p.id = m.project_id
  JOIN public.training_employees e ON e.id = m.employee_id
  JOIN public.contractor_companies cc ON cc.id = m.contractor_id
  LEFT JOIN LATERAL (
    SELECT c.contract_no, c.contract_name, c.status FROM public.contractor_contracts c
    WHERE c.project_id = m.project_id AND c.contractor_id = m.contractor_id
    ORDER BY c.created_at DESC LIMIT 1
  ) ct ON TRUE
  LEFT JOIN LATERAL (
    SELECT string_agg(COALESCE(d.certificate_type, '特种作业证') || COALESCE('（' || d.certificate_no || '）', ''), '；' ORDER BY d.created_at DESC) AS certificate_text,
           CASE WHEN bool_or(d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) THEN '已审核有效'
                WHEN count(d.id) > 0 THEN '待审核/已失效' ELSE '未登记' END AS review_text
    FROM public.contractor_documents d
    WHERE d.project_id = m.project_id AND d.employee_id = m.employee_id AND d.document_type = 'special_certificate'
  ) cert ON TRUE
  LEFT JOIN public.training_admissions a ON a.project_id = m.project_id AND a.employee_id = m.employee_id
  WHERE m.membership_type = 'external' AND (p_project_id IS NULL OR m.project_id = p_project_id)
  ORDER BY p.name, cc.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_contractor_personnel_ledger(UUID) TO authenticated;

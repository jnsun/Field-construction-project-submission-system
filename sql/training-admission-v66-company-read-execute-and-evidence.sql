-- D07 R02：补齐公司级只读判断的最小执行授权，并修复电子证据只读 RPC 排序。

-- Storage/RLS 以调用者身份直接使用该布尔判断，因此 authenticated 需要 EXECUTE。
-- 函数仍为 SECURITY DEFINER 且固定 search_path，只返回当前账号是否为公司级管理员。
REVOKE ALL ON FUNCTION public.training_is_company_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_is_company_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.training_admission_evidence(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  evidence_type TEXT, evidence_name TEXT, occurred_at TIMESTAMPTZ, storage_path TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN
    RAISE EXCEPTION '您无权查看该项目人员的准入电子证据';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
  ) THEN
    RAISE EXCEPTION '该人员未加入本项目';
  END IF;

  RETURN QUERY
  SELECT 'signature',
         CASE s.signer_role WHEN 'employee' THEN '员工电子签字'
                            WHEN 'company_safety_head' THEN '安全生产部部长签字'
                            WHEN 'entity_head' THEN '经营实体负责人签字'
                            WHEN 'project_manager' THEN '项目经理签字'
                            WHEN 'safety_officer' THEN '安全员签字' ELSE '电子签字' END,
         s.signed_at, s.storage_path
  FROM public.training_admission_signatures s
  JOIN public.training_admissions a ON a.id = s.admission_id
  WHERE a.project_id = p_project_id AND a.employee_id = p_employee_id

  UNION ALL
  SELECT 'site_confirmation', '现场确认照片', x.confirmed_at, x.photo_path
  FROM public.training_site_confirmations x
  JOIN public.training_admissions a ON a.id = x.admission_id
  WHERE a.project_id = p_project_id AND a.employee_id = p_employee_id
  ORDER BY 3 DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_admission_evidence(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_admission_evidence(UUID, UUID) TO authenticated;

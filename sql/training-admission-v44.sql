-- ============================================================================
-- 培训准入第四十四批：准入流转档案的电子证据查看
-- 前置：certificate-management.sql、training-admission-v1.sql 至 v43.sql 已执行。
-- 原始签字和现场照片仍在私有桶中，仅项目管理人员可通过短时签名链接查看。
-- ============================================================================

DROP POLICY IF EXISTS training_admission_signature_read ON storage.objects;
CREATE POLICY training_admission_signature_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'signatures'
    AND EXISTS (
      SELECT 1 FROM public.training_admissions a
      WHERE a.id::TEXT = (storage.foldername(name))[3]
        AND (a.employee_id = public.training_my_employee_id() OR public.site_project_can_manage(a.project_id))
    )
  );

CREATE OR REPLACE FUNCTION public.training_admission_evidence(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  evidence_type TEXT, evidence_name TEXT, occurred_at TIMESTAMPTZ, storage_path TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN
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
  ORDER BY occurred_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_admission_evidence(UUID, UUID) TO authenticated;

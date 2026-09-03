-- ============================================================================
-- 培训准入第四十三批：项目签字与现场确认照片的最小 Storage 权限
-- 前置：certificate-management.sql、training-admission-v1.sql 至 v42.sql 已执行。
-- 员工只可上传本人签字；项目经理/安全员可为本人项目上传项目签字和现场确认照片。
-- 不开放覆盖、更新或删除。
-- ============================================================================

DROP POLICY IF EXISTS training_admission_signature_upload ON storage.objects;
CREATE POLICY training_admission_signature_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'signatures'
    AND lower(name) ~ '\.(png|jpe?g|webp)$'
    AND EXISTS (
      SELECT 1 FROM public.training_admissions a
      WHERE a.id::TEXT = (storage.foldername(name))[3]
        AND (a.employee_id = public.training_my_employee_id() OR public.site_project_can_manage(a.project_id))
    )
  );

DROP POLICY IF EXISTS training_admission_site_confirmation_upload ON storage.objects;
CREATE POLICY training_admission_site_confirmation_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'site-confirmations'
    AND lower(name) ~ '\.(png|jpe?g|webp)$'
    AND CASE
      WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

DROP POLICY IF EXISTS training_admission_site_confirmation_read ON storage.objects;
CREATE POLICY training_admission_site_confirmation_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'site-confirmations'
    AND CASE
      WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

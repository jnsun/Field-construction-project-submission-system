-- ============================================================================
-- 培训准入第四十二批：项目外协资料附件的最小 Storage 权限
-- 前置：certificate-management.sql、training-admission-v1.sql 至 v41.sql 已执行。
-- 仅允许项目管理人员在本人项目目录新增、读取 PDF/图片；不开放覆盖、更新或删除。
-- ============================================================================

DROP POLICY IF EXISTS training_admission_contractor_upload ON storage.objects;
CREATE POLICY training_admission_contractor_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] IN ('contractor-contracts', 'contractor-documents')
    AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$'
    AND CASE
      WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

DROP POLICY IF EXISTS training_admission_contractor_read ON storage.objects;
CREATE POLICY training_admission_contractor_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] IN ('contractor-contracts', 'contractor-documents')
    AND CASE
      WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

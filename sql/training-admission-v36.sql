-- ============================================================================
-- 培训准入第三十六批：外协扫码申请附件的最小 Storage 权限
-- 前置：certificate-management.sql、training-admission-v1.sql 至 v35.sql 已执行。
-- 仅开放 training-admission/join-applications 目录的图片/PDF 新增；不可覆盖、更新或删除。
-- ============================================================================

DROP POLICY IF EXISTS training_admission_join_upload ON storage.objects;
CREATE POLICY training_admission_join_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'join-applications'
    AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$'
  );

-- 原申请人可查看自己的文件；项目经理/安全员可查看本项目申请的照片和附件。
-- 其余 certificates 桶对象仍沿用既有的证照权限策略。
DROP POLICY IF EXISTS training_admission_join_read ON storage.objects;
CREATE POLICY training_admission_join_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'join-applications'
    AND (
      EXISTS (
        SELECT 1 FROM public.project_join_applications a
        WHERE a.photo_path = name
          AND (a.applicant_user_id = auth.uid() OR public.site_project_can_manage(a.project_id))
      )
      OR EXISTS (
        SELECT 1 FROM public.project_join_application_attachments f
        JOIN public.project_join_applications a ON a.id = f.application_id
        WHERE f.storage_path = name
          AND (a.applicant_user_id = auth.uid() OR public.site_project_can_manage(a.project_id))
      )
    )
  );

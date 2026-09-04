-- D03 source-backed application Storage configuration initializer.
-- Scope: private bucket configuration and application-owned storage.objects
-- policies only. Supabase platform tables, indexes, metadata and file bytes are
-- intentionally outside D03 and are owned by INF02.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'D03 Storage platform foundation is missing';
  END IF;
END $$;

INSERT INTO storage.buckets (id, name, public) VALUES
  ('training-courses', 'training-courses', false),
  ('certificates', 'certificates', false),
  ('avatars', 'avatars', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "training_courses_read" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_write" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_manage" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_delete" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_read_authorized" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_write_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_update_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_delete_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_signatures_write_own" ON storage.objects;
DROP POLICY IF EXISTS "training_signatures_read_own" ON storage.objects;
CREATE POLICY "training_courses_read_authorized" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'training-courses' AND (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.training_courses c JOIN public.training_assignments a ON a.plan_id = c.plan_id
    WHERE c.file_path = name AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
  ) OR EXISTS (SELECT 1 FROM public.training_signatures s WHERE s.storage_path = name AND s.employee_id = public.training_my_employee_id()))
);
CREATE POLICY "training_courses_write_admin" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'training-courses' AND public.is_admin());
CREATE POLICY "training_courses_update_admin" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'training-courses' AND public.is_admin()) WITH CHECK (bucket_id = 'training-courses' AND public.is_admin());
CREATE POLICY "training_courses_delete_admin" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'training-courses' AND public.is_admin());
CREATE POLICY "training_signatures_write_own" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'training-courses' AND (storage.foldername(name))[1] = 'signatures' AND EXISTS (
    SELECT 1 FROM public.training_assignments a
    WHERE a.id::text = split_part(storage.filename(name), '_', 1)
      AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
  )
);

DROP POLICY IF EXISTS "avatars_read" ON storage.objects;
DROP POLICY IF EXISTS "avatars_write" ON storage.objects;
DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
DROP POLICY IF EXISTS "avatars_delete" ON storage.objects;
CREATE POLICY "avatars_read" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'avatars' AND (public.is_admin() OR (storage.foldername(name))[1] = (SELECT employee_id::text FROM public.profiles WHERE id = auth.uid()))
);
CREATE POLICY "avatars_write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'avatars' AND (public.is_admin() OR (storage.foldername(name))[1] = (SELECT employee_id::text FROM public.profiles WHERE id = auth.uid()))
);
CREATE POLICY "avatars_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND public.is_admin());
CREATE POLICY "avatars_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND public.is_admin());

DROP POLICY IF EXISTS "cert_storage_read_own_dept" ON storage.objects;
DROP POLICY IF EXISTS "cert_storage_read_admin" ON storage.objects;
DROP POLICY IF EXISTS "cert_storage_write_admin" ON storage.objects;
DROP POLICY IF EXISTS "cert_storage_update_admin" ON storage.objects;
DROP POLICY IF EXISTS "cert_storage_delete_admin" ON storage.objects;
CREATE POLICY "cert_storage_read_own_dept" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] IN (SELECT department_id::text FROM public.profiles WHERE id = auth.uid())
);
CREATE POLICY "cert_storage_read_admin" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'certificates' AND public.is_admin());
CREATE POLICY "cert_storage_write_admin" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'certificates' AND public.is_admin());
CREATE POLICY "cert_storage_update_admin" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'certificates' AND public.is_admin());
CREATE POLICY "cert_storage_delete_admin" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'certificates' AND public.is_admin());

DROP POLICY IF EXISTS training_admission_join_upload ON storage.objects;
DROP POLICY IF EXISTS training_admission_join_read ON storage.objects;
DROP POLICY IF EXISTS training_admission_contractor_upload ON storage.objects;
DROP POLICY IF EXISTS training_admission_contractor_read ON storage.objects;
DROP POLICY IF EXISTS training_admission_signature_upload ON storage.objects;
DROP POLICY IF EXISTS training_admission_site_confirmation_upload ON storage.objects;
DROP POLICY IF EXISTS training_admission_site_confirmation_read ON storage.objects;
DROP POLICY IF EXISTS training_admission_signature_read ON storage.objects;
CREATE POLICY training_admission_join_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'join-applications' AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$'
);
CREATE POLICY training_admission_join_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'join-applications' AND (
    EXISTS (SELECT 1 FROM public.project_join_applications a WHERE a.photo_path = name AND (a.applicant_user_id = auth.uid() OR public.site_project_can_manage(a.project_id))) OR
    EXISTS (SELECT 1 FROM public.project_join_application_attachments f JOIN public.project_join_applications a ON a.id = f.application_id WHERE f.storage_path = name AND (a.applicant_user_id = auth.uid() OR public.site_project_can_manage(a.project_id)))
  )
);
CREATE POLICY training_admission_contractor_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] IN ('contractor-contracts', 'contractor-documents') AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$' AND CASE WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID) ELSE FALSE END
);
CREATE POLICY training_admission_contractor_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] IN ('contractor-contracts', 'contractor-documents') AND CASE WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID) ELSE FALSE END
);
CREATE POLICY training_admission_signature_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'signatures' AND lower(name) ~ '\.(png|jpe?g|webp)$' AND EXISTS (SELECT 1 FROM public.training_admissions a WHERE a.id::text = (storage.foldername(name))[3] AND (a.employee_id = public.training_my_employee_id() OR public.site_project_can_manage(a.project_id)))
);
CREATE POLICY training_admission_site_confirmation_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'site-confirmations' AND lower(name) ~ '\.(png|jpe?g|webp)$' AND CASE WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID) ELSE FALSE END
);
CREATE POLICY training_admission_site_confirmation_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'site-confirmations' AND CASE WHEN (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN public.site_project_can_manage((storage.foldername(name))[3]::UUID) ELSE FALSE END
);
CREATE POLICY training_admission_signature_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'certificates' AND (storage.foldername(name))[1] = 'training-admission' AND (storage.foldername(name))[2] = 'signatures' AND EXISTS (SELECT 1 FROM public.training_admissions a WHERE a.id::text = (storage.foldername(name))[3] AND (a.employee_id = public.training_my_employee_id() OR public.site_project_can_manage(a.project_id)))
);

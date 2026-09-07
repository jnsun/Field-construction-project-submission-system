-- D07 R02：恢复公司级管理员的公司范围只读，同时保持项目日常管理权限严格隔离。
-- site_project_can_manage() 不变；所有写入、审核、催办、现场确认和邀请码操作继续使用它。

CREATE OR REPLACE FUNCTION public.site_project_can_read_management_data(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR public.site_project_can_manage(p_project_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_can_read_management_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_can_read_management_data(UUID) TO authenticated;

-- 这两张后续新增的台账只有 RLS 策略但缺少基础 SELECT 授权；补最小读取授权，
-- 行范围仍完全由下方策略决定。
GRANT SELECT ON TABLE
  public.training_admission_reminders,
  public.training_verification_logs
TO authenticated;

DROP POLICY IF EXISTS site_project_invites_read ON public.site_project_invites;
CREATE POLICY site_project_invites_read ON public.site_project_invites
  FOR SELECT TO authenticated
  USING (public.site_project_can_read_management_data(project_id));

-- contractor_contracts_all 继续只授予日常管理人员写权限；单独补公司级只读策略。
DROP POLICY IF EXISTS contractor_contracts_read ON public.contractor_contracts;
CREATE POLICY contractor_contracts_read ON public.contractor_contracts
  FOR SELECT TO authenticated
  USING (public.site_project_can_read_management_data(project_id));

DROP POLICY IF EXISTS project_join_applications_read ON public.project_join_applications;
CREATE POLICY project_join_applications_read ON public.project_join_applications
  FOR SELECT TO authenticated
  USING (
    applicant_user_id = auth.uid()
    OR public.site_project_can_read_management_data(project_id)
  );

DROP POLICY IF EXISTS project_join_application_attachments_read ON public.project_join_application_attachments;
CREATE POLICY project_join_application_attachments_read ON public.project_join_application_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_join_applications a
      WHERE a.id = application_id
        AND (
          a.applicant_user_id = auth.uid()
          OR public.site_project_can_read_management_data(a.project_id)
        )
    )
  );

DROP POLICY IF EXISTS training_admission_reminders_read ON public.training_admission_reminders;
CREATE POLICY training_admission_reminders_read ON public.training_admission_reminders
  FOR SELECT TO authenticated
  USING (
    employee_id = public.training_my_employee_id()
    OR public.site_project_can_read_management_data(project_id)
  );

DROP POLICY IF EXISTS training_verification_logs_read ON public.training_verification_logs;
CREATE POLICY training_verification_logs_read ON public.training_verification_logs
  FOR SELECT TO authenticated
  USING (public.site_project_can_read_management_data(project_id));

DROP POLICY IF EXISTS training_personnel_reapproval_read ON public.training_personnel_reapproval_requests;
CREATE POLICY training_personnel_reapproval_read ON public.training_personnel_reapproval_requests
  FOR SELECT TO authenticated
  USING (public.site_project_can_read_management_data(project_id));

-- 最近核验记录属于只读台账；核验和写入留痕 RPC 仍使用 site_project_can_manage()。
CREATE OR REPLACE FUNCTION public.training_recent_verification_logs(
  p_project_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 20
)
RETURNS TABLE(
  verified_at TIMESTAMPTZ,
  project_code TEXT,
  project_name TEXT,
  employee_name TEXT,
  work_position TEXT,
  credential_type TEXT,
  result_status TEXT,
  code_suffix TEXT,
  reason TEXT,
  verifier_name TEXT
) AS $$
  SELECT l.verified_at, p.project_code, p.name, e.name, e.position, l.credential_type,
         l.result_status, l.code_suffix, l.reason, COALESCE(pr.full_name, pr.email, '—')
  FROM public.training_verification_logs l
  JOIN public.site_projects p ON p.id = l.project_id
  JOIN public.training_employees e ON e.id = l.employee_id
  LEFT JOIN public.profiles pr ON pr.id = l.verifier_id
  WHERE public.site_project_can_read_management_data(l.project_id)
    AND (p_project_id IS NULL OR l.project_id = p_project_id)
  ORDER BY l.verified_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_recent_verification_logs(UUID, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_recent_verification_logs(UUID, INT) TO authenticated;

-- Storage 的读取与上传分离。上传策略继续使用 site_project_can_manage()。
CREATE OR REPLACE FUNCTION public.site_project_join_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_join_applications a
    WHERE a.photo_path = p_storage_path
      AND (
        a.applicant_user_id = auth.uid()
        OR public.site_project_can_read_management_data(a.project_id)
      )
  )
  OR EXISTS (
    SELECT 1
    FROM public.project_join_application_attachments f
    JOIN public.project_join_applications a ON a.id = f.application_id
    WHERE f.storage_path = p_storage_path
      AND (
        a.applicant_user_id = auth.uid()
        OR public.site_project_can_read_management_data(a.project_id)
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_join_file_can_read(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_join_file_can_read(TEXT) TO authenticated;

-- storage.objects 的所有 SELECT 策略会一起参与求值。旧课件策略直接查询未授予
-- authenticated 的业务表，会连带阻断 certificates 桶读取；封装后保持原权限不变。
CREATE OR REPLACE FUNCTION public.training_course_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.training_courses c
        JOIN public.training_assignments a ON a.plan_id = c.plan_id
        WHERE c.file_path = p_storage_path
          AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
      )
      OR EXISTS (
        SELECT 1
        FROM public.training_signatures s
        WHERE s.storage_path = p_storage_path
          AND s.employee_id = public.training_my_employee_id()
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_can_read(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_read(TEXT) TO authenticated;

-- is_admin() 是多条既有 Storage 策略的直接入口；v49 撤销 PUBLIC 默认权限后，
-- 仅向已登录角色恢复调用权。函数只判断当前账号，不返回业务数据。
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.training_course_file_can_write(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR (
        (storage.foldername(p_storage_path))[1] = 'signatures'
        AND EXISTS (
          SELECT 1
          FROM public.training_assignments a
          WHERE a.id::TEXT = split_part(storage.filename(p_storage_path), '_', 1)
            AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
        )
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_can_write(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_write(TEXT) TO authenticated;

DROP POLICY IF EXISTS training_courses_read ON storage.objects;
DROP POLICY IF EXISTS training_courses_read_authorized ON storage.objects;
CREATE POLICY training_courses_read_authorized ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'training-courses'
    AND public.training_course_file_can_read(name)
  );

DROP POLICY IF EXISTS training_courses_write ON storage.objects;
CREATE POLICY training_courses_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'training-courses'
    AND public.training_course_file_can_write(name)
  );

DROP POLICY IF EXISTS training_admission_join_read ON storage.objects;
CREATE POLICY training_admission_join_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'join-applications'
    AND public.site_project_join_file_can_read(name)
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
      THEN public.site_project_can_read_management_data((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

DROP POLICY IF EXISTS training_admission_signature_read ON storage.objects;
CREATE POLICY training_admission_signature_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'signatures'
    AND EXISTS (
      SELECT 1
      FROM public.training_admissions a
      WHERE a.id::TEXT = (storage.foldername(name))[3]
        AND (
          a.employee_id = public.training_my_employee_id()
          OR public.site_project_can_read_management_data(a.project_id)
        )
    )
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
      THEN public.site_project_can_read_management_data((storage.foldername(name))[3]::UUID)
      ELSE FALSE
    END
  );

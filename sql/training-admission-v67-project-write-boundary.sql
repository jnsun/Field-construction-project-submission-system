-- D07 R02：收口剩余项目写权限旁路。
-- 公司级只读与项目日常管理继续分离；所有项目写入按具体 project_id 实时鉴权。

DROP FUNCTION IF EXISTS public.training_refresh_expired_admissions();
CREATE OR REPLACE FUNCTION public.training_refresh_expired_admissions(p_project_id UUID)
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN
    RAISE EXCEPTION '您无权刷新该项目的到期准入状态';
  END IF;

  UPDATE public.training_admissions a
  SET status = 'expired',
      retrain_required = TRUE,
      retrain_reason = '年度培训合格凭证已到期，须完成年度复训后方可上岗',
      blocked_reason = '培训合格凭证已过期，禁止上岗',
      updated_at = NOW()
  WHERE a.project_id = p_project_id
    AND a.valid_until IS NOT NULL
    AND a.valid_until < CURRENT_DATE
    AND a.status <> 'project_closed';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_refresh_expired_admissions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_refresh_expired_admissions(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE
  v_a public.training_admissions; v_p public.site_projects; v_e public.training_employees;
  v_pkg public.training_admission_packages; v_total INT; v_done INT; v_final_signed BOOLEAN; v_external_reason TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id)
     AND v_a.employee_id <> public.training_my_employee_id() THEN
    RAISE EXCEPTION '您无权重新计算该人员的准入资格';
  END IF;
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

REVOKE ALL ON FUNCTION public.training_recompute_admission(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_recompute_admission(UUID) TO authenticated;

DROP POLICY IF EXISTS contractor_documents_write ON public.contractor_documents;
CREATE POLICY contractor_documents_write ON public.contractor_documents
  FOR ALL TO authenticated USING (
    (project_id IS NULL AND public.training_is_company_admin())
    OR (project_id IS NOT NULL AND public.site_project_can_manage(project_id))
  ) WITH CHECK (
    (project_id IS NULL AND public.training_is_company_admin())
    OR (project_id IS NOT NULL AND public.site_project_can_manage(project_id))
  );

-- 证书桶的通用管理员写权限不再覆盖项目准入目录。
DROP POLICY IF EXISTS "cert_storage_write_admin" ON storage.objects;
CREATE POLICY "cert_storage_write_admin" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'certificates'
    AND public.is_admin()
    AND COALESCE((storage.foldername(name))[1], '') <> 'training-admission'
  );

DROP POLICY IF EXISTS "cert_storage_update_admin" ON storage.objects;
CREATE POLICY "cert_storage_update_admin" ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'certificates'
    AND public.is_admin()
    AND COALESCE((storage.foldername(name))[1], '') <> 'training-admission'
  ) WITH CHECK (
    bucket_id = 'certificates'
    AND public.is_admin()
    AND COALESCE((storage.foldername(name))[1], '') <> 'training-admission'
  );

DROP POLICY IF EXISTS "cert_storage_delete_admin" ON storage.objects;
CREATE POLICY "cert_storage_delete_admin" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'certificates'
    AND public.is_admin()
    AND COALESCE((storage.foldername(name))[1], '') <> 'training-admission'
  );

-- 申请人上传仍是本人申请流程，不属于项目管理；管理员不得借该入口写项目准入目录。
DROP POLICY IF EXISTS training_admission_join_upload ON storage.objects;
CREATE POLICY training_admission_join_upload ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'join-applications'
    AND NOT public.is_admin()
    AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$'
  );

CREATE OR REPLACE FUNCTION public.training_admission_file_can_manage(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN (storage.foldername(p_storage_path))[2] IN ('contractor-contracts', 'contractor-documents', 'site-confirmations')
         AND (storage.foldername(p_storage_path))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN public.site_project_can_manage((storage.foldername(p_storage_path))[3]::UUID)
    WHEN (storage.foldername(p_storage_path))[2] = 'signatures'
      THEN EXISTS (
        SELECT 1 FROM public.training_admissions a
        WHERE a.id::TEXT = (storage.foldername(p_storage_path))[3]
          AND public.site_project_can_manage(a.project_id)
      )
    WHEN (storage.foldername(p_storage_path))[2] = 'join-applications'
      THEN EXISTS (
        SELECT 1 FROM public.project_join_applications a
        WHERE a.photo_path = p_storage_path
          AND public.site_project_can_manage(a.project_id)
      ) OR EXISTS (
        SELECT 1
        FROM public.project_join_application_attachments f
        JOIN public.project_join_applications a ON a.id = f.application_id
        WHERE f.storage_path = p_storage_path
          AND public.site_project_can_manage(a.project_id)
      )
    ELSE FALSE
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_admission_file_can_manage(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_admission_file_can_manage(TEXT) TO authenticated;

DROP POLICY IF EXISTS training_admission_project_update ON storage.objects;
CREATE POLICY training_admission_project_update ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
  ) WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
  );

DROP POLICY IF EXISTS training_admission_project_delete ON storage.objects;
CREATE POLICY training_admission_project_delete ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
  );

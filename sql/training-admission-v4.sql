-- ============================================================================
-- 培训准入第四批：员工逐级电子签字校验
-- 前置：training-admission-v1.sql 至 training-admission-v3.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_admission_sign(UUID, UUID, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.training_admission_sign(
  p_admission_id UUID, p_task_id UUID, p_signer_role TEXT,
  p_storage_path TEXT, p_record_hash TEXT, p_device_info TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE v_a public.training_admissions; v_project UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NULLIF(btrim(p_storage_path), '') IS NULL OR NULLIF(btrim(p_record_hash), '') IS NULL THEN
    RAISE EXCEPTION '签字图片和记录哈希不能为空';
  END IF;
  v_project := v_a.project_id;

  IF p_signer_role = 'employee' THEN
    IF v_a.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '只能由本人签署员工记录'; END IF;
    IF p_task_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.training_admission_tasks t
      WHERE t.id = p_task_id AND t.admission_id = p_admission_id AND t.status = 'completed'
    ) THEN RAISE EXCEPTION '该层级培训尚未完成，不能签字'; END IF;
    -- 最终签字前，三级/专项任务必须全部完成并分别完成员工签字。
    IF p_task_id IS NULL AND EXISTS (
      SELECT 1 FROM public.training_admission_tasks t
      WHERE t.admission_id = p_admission_id AND (
        t.status <> 'completed' OR NOT EXISTS (
          SELECT 1 FROM public.training_admission_signatures s
          WHERE s.admission_id = p_admission_id AND s.task_id = t.id AND s.signer_role = 'employee'
        )
      )
    ) THEN RAISE EXCEPTION '请先完成全部培训并逐级签字，再签署完整准入记录'; END IF;
  ELSIF p_signer_role = 'company_safety_head' THEN
    IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司级管理员可以签署公司级记录'; END IF;
  ELSIF p_signer_role = 'entity_head' THEN
    IF NOT public.site_project_can_admin(v_project) THEN RAISE EXCEPTION '只有主责经营实体管理员可以签署'; END IF;
  ELSIF p_signer_role IN ('project_manager', 'safety_officer') THEN
    IF NOT EXISTS (SELECT 1 FROM public.site_project_roles r
                   WHERE r.project_id = v_project AND r.user_id = auth.uid()
                     AND r.active AND r.role = p_signer_role) THEN
      RAISE EXCEPTION '当前账号不是该项目的指定签署人';
    END IF;
  ELSE
    RAISE EXCEPTION '不支持的签署角色';
  END IF;

  IF p_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.training_admission_tasks t
    WHERE t.id = p_task_id AND t.admission_id = p_admission_id
  ) THEN RAISE EXCEPTION '签署的培训层级不属于该入场记录'; END IF;
  IF p_task_id IS NULL AND p_signer_role = 'employee' AND EXISTS (
    SELECT 1 FROM public.training_admission_signatures s
    WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee'
  ) THEN RAISE EXCEPTION '完整准入记录已经签署'; END IF;

  INSERT INTO public.training_admission_signatures(admission_id, task_id, signer_role, signer_user_id,
                                                   storage_path, record_hash, device_info)
  VALUES (p_admission_id, p_task_id, p_signer_role, auth.uid(), p_storage_path, p_record_hash, p_device_info)
  ON CONFLICT (admission_id, task_id, signer_role) DO NOTHING;
  IF p_task_id IS NOT NULL THEN
    UPDATE public.training_admission_tasks SET signed_at = NOW() WHERE id = p_task_id;
  ELSE
    UPDATE public.training_admissions SET final_signed_at = NOW(), updated_at = NOW() WHERE id = p_admission_id;
  END IF;
  PERFORM public.training_recompute_admission(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_sign(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 员工只能上传自己的准入签字图片；管理端仍可按既有管理员策略读取。
DROP POLICY IF EXISTS training_admission_signature_upload ON storage.objects;
CREATE POLICY training_admission_signature_upload ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'signatures'
    AND EXISTS (
      SELECT 1 FROM public.training_admissions a
      WHERE a.id::TEXT = (storage.foldername(name))[3]
        AND a.employee_id = public.training_my_employee_id()
    )
  );

-- 验证：SELECT proname FROM pg_proc WHERE proname = 'training_admission_sign';

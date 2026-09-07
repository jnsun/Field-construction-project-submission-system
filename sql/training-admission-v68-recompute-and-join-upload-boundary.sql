-- D07 R02：封闭准入重算本人旁路，并把加入申请上传绑定到有效邀请码、项目和当前用户。
BEGIN;

CREATE OR REPLACE FUNCTION public.training_recompute_admission_internal(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE
  v_a public.training_admissions; v_p public.site_projects; v_e public.training_employees;
  v_pkg public.training_admission_packages; v_total INT; v_done INT; v_final_signed BOOLEAN; v_external_reason TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
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

REVOKE ALL ON FUNCTION public.training_recompute_admission_internal(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE v_project_id UUID;
BEGIN
  SELECT project_id INTO v_project_id
  FROM public.training_admissions
  WHERE id = p_admission_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_project_id) THEN
    RAISE EXCEPTION '您无权重新计算该人员的准入资格';
  END IF;
  RETURN public.training_recompute_admission_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_recompute_admission(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_recompute_admission(UUID) TO authenticated;

-- 学习和考试完成由触发器自动推进，不经过可直接调用的项目管理 RPC。
CREATE OR REPLACE FUNCTION public.training_sync_admission_assignment()
RETURNS TRIGGER AS $$
DECLARE v_admission_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.progress IS NOT DISTINCT FROM OLD.progress
     AND NEW.hours_earned IS NOT DISTINCT FROM OLD.hours_earned THEN
    RETURN NEW;
  END IF;
  FOR v_admission_id IN
    SELECT admission_id FROM public.training_admission_tasks WHERE assignment_id = NEW.id
  LOOP
    UPDATE public.training_admission_tasks
    SET status = CASE
          WHEN NEW.status = 'completed' THEN 'completed'
          WHEN NEW.status = 'learning' OR COALESCE(NEW.progress, 0) > 0 THEN 'learning'
          ELSE 'pending'
        END,
        progress = LEAST(100, GREATEST(0, COALESCE(NEW.progress, 0))),
        effective_hours = COALESCE(NEW.hours_earned, effective_hours),
        completed_at = CASE WHEN NEW.status = 'completed' THEN COALESCE(completed_at, NEW.completed_at, NOW()) ELSE completed_at END
    WHERE admission_id = v_admission_id AND assignment_id = NEW.id;
    PERFORM public.training_recompute_admission_internal(v_admission_id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_sync_admission_exam()
RETURNS TRIGGER AS $$
DECLARE v_admission UUID;
BEGIN
  FOR v_admission IN SELECT id FROM public.training_admissions WHERE exam_assignment_id = NEW.id LOOP
    UPDATE public.training_admissions
    SET exam_passed = NEW.exam_status = 'passed', exam_score = NEW.exam_score,
        exam_attempts = COALESCE(NEW.exam_attempts, 0), updated_at = NOW()
    WHERE id = v_admission;
    PERFORM public.training_recompute_admission_internal(v_admission);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 员工签字仍可合法推进本人流程，但不能借此获得内部重算函数的直接执行权。
CREATE OR REPLACE FUNCTION public.training_admission_sign(
  p_admission_id UUID, p_task_id UUID, p_signer_role TEXT, p_storage_path TEXT, p_record_hash TEXT, p_device_info TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE v_a public.training_admissions; v_project UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NULLIF(btrim(p_storage_path), '') IS NULL OR NULLIF(btrim(p_record_hash), '') IS NULL THEN RAISE EXCEPTION '签字图片和记录哈希不能为空'; END IF;
  v_project := v_a.project_id;
  IF p_signer_role = 'employee' THEN
    IF v_a.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '只能由本人签署员工记录'; END IF;
    IF p_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.id = p_task_id AND t.admission_id = p_admission_id AND t.status = 'completed') THEN RAISE EXCEPTION '该层级培训尚未完成，不能签字'; END IF;
    IF p_task_id IS NULL AND EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id = p_admission_id AND (t.status <> 'completed' OR NOT EXISTS (
      SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id AND s.task_id = t.id AND s.signer_role = 'employee'))) THEN RAISE EXCEPTION '请先完成全部培训并逐级签字，再签署完整准入记录'; END IF;
  ELSIF p_signer_role = 'company_safety_head' THEN
    IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司级管理员可以签署公司级记录'; END IF;
  ELSIF p_signer_role = 'entity_head' THEN
    IF NOT public.site_project_can_admin(v_project) THEN RAISE EXCEPTION '只有主责经营实体管理员可以签署'; END IF;
  ELSIF p_signer_role IN ('project_manager', 'safety_officer') THEN
    IF NOT EXISTS (SELECT 1 FROM public.site_project_roles r WHERE r.project_id = v_project AND r.user_id = auth.uid() AND r.active AND r.role = p_signer_role) THEN RAISE EXCEPTION '当前账号不是该项目的指定签署人'; END IF;
  ELSE RAISE EXCEPTION '不支持的签署角色'; END IF;
  IF p_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.id = p_task_id AND t.admission_id = p_admission_id) THEN RAISE EXCEPTION '签署的培训层级不属于该入场记录'; END IF;
  IF p_task_id IS NULL AND p_signer_role = 'employee' AND EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee' AND s.cycle_no = v_a.training_cycle_no) THEN RAISE EXCEPTION '本复训批次的完整准入记录已经签署'; END IF;
  INSERT INTO public.training_admission_signatures(admission_id, task_id, signer_role, signer_user_id, storage_path, record_hash, device_info, cycle_no)
  VALUES (p_admission_id, p_task_id, p_signer_role, auth.uid(), p_storage_path, p_record_hash, p_device_info, v_a.training_cycle_no)
  ON CONFLICT (admission_id, task_id, signer_role) DO NOTHING;
  IF p_task_id IS NOT NULL THEN UPDATE public.training_admission_tasks SET signed_at = NOW() WHERE id = p_task_id;
  ELSE UPDATE public.training_admissions SET final_signed_at = NOW(), updated_at = NOW() WHERE id = p_admission_id; END IF;
  PERFORM public.training_recompute_admission_internal(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 公司级管理员的正式项目重开路径原本合法，继续使用内部重算而不放宽公开 RPC。
CREATE OR REPLACE FUNCTION public.site_project_update(
  p_project_id UUID, p_name TEXT, p_project_type TEXT, p_location TEXT, p_status TEXT,
  p_start_date DATE, p_expected_end_date DATE, p_actual_end_date DATE, p_lead_entity_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE v_old public.site_projects; v_new public.site_projects; v_admission UUID;
BEGIN
  SELECT * INTO v_old FROM public.site_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权维护该正式项目'; END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN RAISE EXCEPTION '您无权把主责经营实体变更为该单位'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN RAISE EXCEPTION '主责单位必须是经营实体'; END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN RAISE EXCEPTION '预计完工日期不能早于开工日期'; END IF;
  IF v_old.status IS DISTINCT FROM p_status AND NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION '项目状态变化必须填写原因'; END IF;
  IF v_old.status = 'closed' AND p_status NOT IN ('closed', 'active') THEN RAISE EXCEPTION '已关闭项目重新开启时必须恢复为在建状态'; END IF;
  UPDATE public.site_projects SET
    name = btrim(p_name), project_type = NULLIF(btrim(p_project_type), ''), location = NULLIF(btrim(p_location), ''), status = p_status,
    start_date = p_start_date, expected_end_date = p_expected_end_date,
    actual_end_date = CASE WHEN v_old.status = 'closed' AND p_status = 'active' THEN NULL ELSE p_actual_end_date END,
    lead_entity_id = p_lead_entity_id,
    pause_started_at = CASE WHEN p_status = 'paused' THEN COALESCE(v_old.pause_started_at, NOW()) ELSE NULL END,
    pause_reason = CASE WHEN p_status = 'paused' THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
    closed_at = CASE WHEN p_status = 'closed' THEN COALESCE(v_old.closed_at, NOW()) ELSE NULL END,
    closed_by = CASE WHEN p_status = 'closed' THEN auth.uid() ELSE NULL END,
    close_reason = CASE WHEN p_status IN ('closed', 'pending_close') THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
    report_notes = COALESCE(NULLIF(btrim(p_reason), ''), v_old.report_notes)
  WHERE id = p_project_id RETURNING * INTO v_new;
  IF v_new.lead_entity_id <> v_old.lead_entity_id THEN
    UPDATE public.site_project_entities SET is_lead = FALSE WHERE project_id = p_project_id;
    INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
    VALUES (p_project_id, v_new.lead_entity_id, TRUE)
    ON CONFLICT (project_id, entity_id) DO UPDATE SET is_lead = TRUE;
  END IF;
  IF v_old.status IS DISTINCT FROM v_new.status AND v_new.status IN ('paused', 'pending_close', 'closed') THEN
    UPDATE public.site_project_invites SET revoked_at = NOW() WHERE project_id = p_project_id AND revoked_at IS NULL;
  END IF;
  IF v_old.status IN ('paused', 'pending_close', 'closed') AND v_new.status = 'active' THEN
    UPDATE public.training_admissions a SET site_confirmed_at = NULL,
      retrain_required = CASE WHEN v_old.pause_started_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = a.package_id
        AND EXTRACT(EPOCH FROM (NOW() - v_old.pause_started_at)) / 86400 >= p.pause_retrain_days) THEN TRUE ELSE a.retrain_required END,
      retrain_reason = CASE WHEN v_old.pause_started_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = a.package_id
        AND EXTRACT(EPOCH FROM (NOW() - v_old.pause_started_at)) / 86400 >= p.pause_retrain_days)
        THEN '项目停工已超过培训包设定期限，须完成项目级/专项复训并重新现场确认' ELSE a.retrain_reason END,
      updated_at = NOW() WHERE a.project_id = p_project_id;
    FOR v_admission IN SELECT id FROM public.training_admissions WHERE project_id = p_project_id LOOP
      PERFORM public.training_recompute_admission_internal(v_admission);
    END LOOP;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 邀请码摘要多返回 project_id，前端据此构造受约束的上传路径。
DROP FUNCTION IF EXISTS public.site_project_invite_summary(TEXT);
CREATE FUNCTION public.site_project_invite_summary(p_token TEXT)
RETURNS TABLE(project_id UUID, project_code TEXT, project_name TEXT, expires_at TIMESTAMPTZ) AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录后再申请加入项目'; END IF;
  IF NULLIF(btrim(p_token), '') IS NULL THEN RAISE EXCEPTION '请扫描项目二维码或输入邀请码'; END IF;
  RETURN QUERY
  SELECT p.id, p.project_code, p.name, i.expires_at
  FROM public.site_project_invites i
  JOIN public.site_projects p ON p.id = i.project_id
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex')
    AND i.revoked_at IS NULL AND i.expires_at > NOW() AND p.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效、已过期，或项目当前未开放外协人员申请'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

REVOKE ALL ON FUNCTION public.site_project_invite_summary(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_invite_summary(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.site_project_join_upload_can_insert(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT public.is_admin()
    AND (storage.foldername(p_storage_path))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND (storage.foldername(p_storage_path))[4] = auth.uid()::TEXT
    AND (storage.foldername(p_storage_path))[5] ~* '^[0-9a-f]{64}$'
    AND EXISTS (
      SELECT 1
      FROM public.site_project_invites i
      JOIN public.site_projects p ON p.id = i.project_id
      WHERE i.project_id::TEXT = (storage.foldername(p_storage_path))[3]
        AND i.token_hash = lower((storage.foldername(p_storage_path))[5])
        AND i.revoked_at IS NULL
        AND i.expires_at > NOW()
        AND p.status = 'active'
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_join_upload_can_insert(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_join_upload_can_insert(TEXT) TO authenticated;

DROP POLICY IF EXISTS training_admission_join_upload ON storage.objects;
CREATE POLICY training_admission_join_upload ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] = 'join-applications'
    AND public.site_project_join_upload_can_insert(name)
    AND lower(name) ~ '\.(pdf|png|jpe?g|webp)$'
  );

COMMIT;

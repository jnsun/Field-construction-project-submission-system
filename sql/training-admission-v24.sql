-- ============================================================================
-- 培训准入第二十四批：年度凭证到期自动禁止上岗
-- 前置：training-admission-v1.sql 至 training-admission-v23.sql 已执行。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE v_a public.training_admissions; v_p public.site_projects; v_e public.training_employees;
  v_pkg public.training_admission_packages; v_total INT; v_done INT; v_has_cert BOOLEAN; v_final_signed BOOLEAN;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT (public.site_project_can_manage(v_a.project_id) OR v_a.employee_id = public.training_my_employee_id()) THEN RAISE EXCEPTION '您无权重新计算该人员的准入资格'; END IF;
  SELECT * INTO v_p FROM public.site_projects WHERE id = v_a.project_id;
  SELECT * INTO v_e FROM public.training_employees WHERE id = v_a.employee_id;
  SELECT * INTO v_pkg FROM public.training_admission_packages WHERE id = v_a.package_id;
  SELECT COUNT(*)::INT, COUNT(*) FILTER (WHERE status = 'completed')::INT INTO v_total, v_done FROM public.training_admission_tasks WHERE admission_id = p_admission_id;
  SELECT EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = v_a.project_id AND d.employee_id = v_a.employee_id
    AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) INTO v_has_cert;
  SELECT EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id
    AND s.task_id IS NULL AND s.signer_role = 'employee' AND s.cycle_no = v_a.training_cycle_no) INTO v_final_signed;
  UPDATE public.training_admissions SET
    status = CASE
      WHEN v_p.status = 'closed' THEN 'project_closed'
      WHEN v_p.status IN ('paused', 'pending_close') OR v_a.member_id IS NULL THEN 'blocked'
      WHEN v_a.retrain_required THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN 'blocked'
      WHEN v_a.valid_until IS NOT NULL AND v_a.valid_until < CURRENT_DATE THEN 'expired'
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN 'blocked'
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
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN '高风险岗位尚未审核通过特种作业证'
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
GRANT EXECUTE ON FUNCTION public.training_recompute_admission(UUID) TO authenticated;

-- 项目管理人员每次进入执行台时刷新自己可管理项目的到期人员；公司管理员可刷新全部项目。
DROP FUNCTION IF EXISTS public.training_refresh_expired_admissions();
CREATE FUNCTION public.training_refresh_expired_admissions()
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.training_admissions a
  SET status = 'expired', blocked_reason = '培训合格凭证已过期，禁止上岗', updated_at = NOW()
  WHERE a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE AND a.status <> 'project_closed'
    AND (public.training_is_company_admin() OR public.site_project_can_manage(a.project_id));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_refresh_expired_admissions() TO authenticated;

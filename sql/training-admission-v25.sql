-- ============================================================================
-- 培训准入第二十五批：年度到期复训
-- 前置：training-admission-v1.sql 至 training-admission-v24.sql 已执行。
-- ============================================================================

DO $$
DECLARE v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint FROM pg_constraint
  WHERE conrelid = 'public.training_admission_retraining_cycles'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%trigger_type%';
  IF v_constraint IS NOT NULL THEN EXECUTE format('ALTER TABLE public.training_admission_retraining_cycles DROP CONSTRAINT %I', v_constraint); END IF;
  ALTER TABLE public.training_admission_retraining_cycles
    ADD CONSTRAINT training_admission_retraining_cycles_trigger_type_check
    CHECK (trigger_type IN ('pause_exceeded', 'material_course_update', 'annual_expiry', 'manual'));
END $$;

-- 到期扫描不仅标记失效，也明确列入待复训名单；项目端据此展示“发起年度复训”。
CREATE OR REPLACE FUNCTION public.training_refresh_expired_admissions()
RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  UPDATE public.training_admissions a
  SET status = 'expired', retrain_required = TRUE, retrain_reason = '年度培训合格凭证已到期，须完成年度复训后方可上岗',
      blocked_reason = '培训合格凭证已过期，禁止上岗', updated_at = NOW()
  WHERE a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE AND a.status <> 'project_closed'
    AND (public.training_is_company_admin() OR public.site_project_can_manage(a.project_id));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_refresh_expired_admissions() TO authenticated;

-- 复用停工复训的完整受控流程，随后把档案触发原因修正为“年度到期”。
DROP FUNCTION IF EXISTS public.training_start_annual_retraining(UUID, UUID, TEXT);
CREATE FUNCTION public.training_start_annual_retraining(
  p_admission_id UUID, p_package_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE v_admission public.training_admissions; v_result UUID;
BEGIN
  SELECT * INTO v_admission FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '准入记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_admission.project_id) THEN RAISE EXCEPTION '您无权发起该人员年度复训'; END IF;
  IF v_admission.valid_until IS NULL OR v_admission.valid_until >= CURRENT_DATE THEN RAISE EXCEPTION '该人员的培训凭证尚未到期，无需发起年度复训'; END IF;
  UPDATE public.training_admissions SET retrain_required = TRUE,
    retrain_reason = COALESCE(NULLIF(btrim(p_reason), ''), '年度培训合格凭证已到期，须完成年度复训后方可上岗'), updated_at = NOW()
  WHERE id = p_admission_id;
  v_result := public.training_start_pause_retraining(p_admission_id, p_package_id, p_reason);
  UPDATE public.training_admission_retraining_cycles
  SET trigger_type = 'annual_expiry', reason = COALESCE(NULLIF(btrim(p_reason), ''), '年度培训合格凭证已到期，须完成年度复训后方可上岗')
  WHERE admission_id = p_admission_id AND cycle_no = (SELECT training_cycle_no FROM public.training_admissions WHERE id = p_admission_id);
  -- 新周期开始后清空旧凭证有效期，防止每日到期刷新把正在补学的人员重复标记为待复训。
  UPDATE public.training_admissions SET valid_until = NULL, updated_at = NOW() WHERE id = p_admission_id;
  PERFORM public.training_recompute_admission(p_admission_id);
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_start_annual_retraining(UUID, UUID, TEXT) TO authenticated;

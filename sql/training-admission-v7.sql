-- ============================================================================
-- 培训准入第七批：培训包版本审核与签发
-- 前置：training-admission-v1.sql 至 training-admission-v6.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_review_admission_package(UUID, TEXT, TEXT);
CREATE FUNCTION public.training_review_admission_package(
  p_package_id UUID, p_action TEXT, p_note TEXT DEFAULT NULL
) RETURNS public.training_admission_packages AS $$
DECLARE v_package public.training_admission_packages; v_result public.training_admission_packages;
        v_needs_project_review BOOLEAN;
BEGIN
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在'; END IF;
  IF v_package.status <> 'pending_review' THEN RAISE EXCEPTION '只有待审核培训包可以进行审核'; END IF;
  IF p_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION '审核动作只能是 approve 或 reject'; END IF;
  IF p_action = 'reject' AND NULLIF(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION '驳回培训包必须填写意见'; END IF;

  IF v_package.project_id IS NULL THEN
    IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '公司通用培训包只能由安全生产部公司级管理员签发'; END IF;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.training_admission_package_items
                   WHERE package_id = p_package_id AND level IN ('project', 'special'))
      INTO v_needs_project_review;
    IF v_needs_project_review THEN
      IF NOT EXISTS (SELECT 1 FROM public.site_project_roles r
                     WHERE r.project_id = v_package.project_id AND r.user_id = auth.uid()
                       AND r.active AND r.role IN ('project_manager', 'safety_officer')) THEN
        RAISE EXCEPTION '含项目级或专项内容的培训包，须由项目经理或安全员审核';
      END IF;
    ELSIF NOT public.site_project_can_admin(v_package.project_id) THEN
      RAISE EXCEPTION '经营实体级培训包须由主责经营实体管理员审核';
    END IF;
  END IF;

  UPDATE public.training_admission_packages
  SET status = CASE WHEN p_action = 'approve' THEN 'published' ELSE 'draft' END,
      approved_by = CASE WHEN p_action = 'approve' THEN auth.uid() ELSE NULL END,
      approved_at = CASE WHEN p_action = 'approve' THEN NOW() ELSE NULL END,
      review_note = NULLIF(btrim(p_note), ''), updated_at = NOW()
  WHERE id = p_package_id RETURNING * INTO v_result;
  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_review_admission_package(UUID, TEXT, TEXT) TO authenticated;

-- 验证：SELECT proname FROM pg_proc WHERE proname = 'training_review_admission_package';

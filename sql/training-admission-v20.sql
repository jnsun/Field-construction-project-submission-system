-- ============================================================================
-- 培训准入第二十批：准入培训包版本复制
-- 前置：training-admission-v1.sql 至 training-admission-v19.sql 已执行。
-- ============================================================================

ALTER TABLE public.training_admission_packages
  ADD COLUMN IF NOT EXISTS supersedes_package_id UUID REFERENCES public.training_admission_packages(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.training_clone_admission_package(p_package_id UUID)
RETURNS UUID AS $$
DECLARE v_old public.training_admission_packages%ROWTYPE; v_new UUID; v_version INT;
BEGIN
  SELECT * INTO v_old FROM public.training_admission_packages WHERE id = p_package_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在'; END IF;
  IF NOT ((v_old.project_id IS NULL AND public.training_is_company_admin())
          OR (v_old.project_id IS NOT NULL AND public.site_project_can_admin(v_old.project_id))) THEN
    RAISE EXCEPTION '您无权复制该培训包版本';
  END IF;
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.training_admission_packages WHERE id = p_package_id OR supersedes_package_id = p_package_id;
  INSERT INTO public.training_admission_packages(
    project_id, title, version_no, source_document_path, validity_years, pause_retrain_days,
    exam_plan_id, status, created_by, supersedes_package_id
  ) VALUES (
    v_old.project_id, v_old.title || '（v' || v_version || '）', v_version, v_old.source_document_path,
    v_old.validity_years, v_old.pause_retrain_days, v_old.exam_plan_id, 'draft', auth.uid(), p_package_id
  ) RETURNING id INTO v_new;
  INSERT INTO public.training_admission_package_items(package_id, plan_id, level, required, sort_order)
  SELECT v_new, plan_id, level, required, sort_order FROM public.training_admission_package_items WHERE package_id = p_package_id;
  INSERT INTO public.training_admission_special_rules(package_id, position_keyword, plan_id)
  SELECT v_new, position_keyword, plan_id FROM public.training_admission_special_rules WHERE package_id = p_package_id;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_clone_admission_package(UUID) TO authenticated;

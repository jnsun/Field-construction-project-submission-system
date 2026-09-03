-- ============================================================================
-- 培训准入第二十八批：项目人员批量发起准入培训
-- 前置：training-admission-v1.sql 至 training-admission-v27.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_start_admission_batch(UUID, UUID[], UUID);
CREATE FUNCTION public.training_start_admission_batch(
  p_project_id UUID, p_employee_ids UUID[], p_package_id UUID
)
RETURNS TABLE (employee_id UUID, admission_id UUID, result_code TEXT, result_message TEXT) AS $$
DECLARE v_employee UUID; v_admission UUID;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权为该项目批量发起准入培训'; END IF;
  IF COALESCE(array_length(p_employee_ids, 1), 0) = 0 THEN RAISE EXCEPTION '请至少选择一名人员'; END IF;
  IF array_length(p_employee_ids, 1) > 300 THEN RAISE EXCEPTION '单次最多处理 300 人，请分批发起'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = p_package_id AND p.status = 'published' AND (p.project_id IS NULL OR p.project_id = p_project_id)) THEN
    RAISE EXCEPTION '培训包不存在、未签发或不适用于该项目';
  END IF;

  FOREACH v_employee IN ARRAY p_employee_ids LOOP
    employee_id := v_employee; admission_id := NULL; result_code := NULL; result_message := NULL;
    IF EXISTS (SELECT 1 FROM public.training_admissions a WHERE a.project_id = p_project_id AND a.employee_id = v_employee) THEN
      result_code := 'skipped'; result_message := '已有准入记录，未重复下发'; RETURN NEXT; CONTINUE;
    END IF;
    BEGIN
      v_admission := public.training_start_admission(p_project_id, v_employee, p_package_id);
      PERFORM public.training_send_admission_start_notice(v_admission);
      admission_id := v_admission; result_code := 'started'; result_message := '已下发培训任务和系统内提醒'; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      result_code := 'failed'; result_message := SQLERRM; RETURN NEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_start_admission_batch(UUID, UUID[], UUID) TO authenticated;

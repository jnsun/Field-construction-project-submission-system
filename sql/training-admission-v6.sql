-- ============================================================================
-- 培训准入第六批：项目复工后的现场确认强制失效
-- 前置：training-admission-v1.sql 至 training-admission-v5.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT);
CREATE FUNCTION public.site_project_update(
  p_project_id UUID,
  p_name TEXT,
  p_project_type TEXT,
  p_location TEXT,
  p_status TEXT,
  p_start_date DATE,
  p_expected_end_date DATE,
  p_actual_end_date DATE,
  p_lead_entity_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE v_old public.site_projects; v_new public.site_projects; v_admission UUID;
BEGIN
  SELECT * INTO v_old FROM public.site_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权维护该正式项目'; END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN
    RAISE EXCEPTION '您无权把主责经营实体变更为该单位';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN
    RAISE EXCEPTION '主责单位必须是经营实体';
  END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN
    RAISE EXCEPTION '预计完工日期不能早于开工日期';
  END IF;
  IF p_status IN ('paused', 'closed', 'pending_close') AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION '暂停、待关闭或关闭必须填写原因';
  END IF;
  IF v_old.status = 'closed' AND p_status <> 'closed' AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION '项目重新开启必须填写原因';
  END IF;

  UPDATE public.site_projects
  SET name = btrim(p_name), project_type = NULLIF(btrim(p_project_type), ''),
      location = NULLIF(btrim(p_location), ''), status = p_status,
      start_date = p_start_date, expected_end_date = p_expected_end_date,
      actual_end_date = p_actual_end_date, lead_entity_id = p_lead_entity_id,
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

  -- 复工后不能继续使用停工前的现场确认。培训、考试和签字仍有效，
  -- 但必须由项目经理或安全员重新现场确认后才能恢复“可上岗”。
  IF v_old.status IN ('paused', 'pending_close', 'closed') AND v_new.status = 'active' THEN
    UPDATE public.training_admissions
    SET site_confirmed_at = NULL, updated_at = NOW()
    WHERE project_id = p_project_id;
    FOR v_admission IN SELECT id FROM public.training_admissions WHERE project_id = p_project_id LOOP
      PERFORM public.training_recompute_admission(v_admission);
    END LOOP;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT) TO authenticated;

-- 验证：SELECT proname FROM pg_proc WHERE proname = 'site_project_update';

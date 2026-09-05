-- D06：补齐暂停复工、关闭重开、状态审计和邀请码失效边界。
BEGIN;

-- 历史上已进入禁止状态的项目，其旧邀请码立即永久失效。
UPDATE public.site_project_invites i
SET revoked_at = NOW()
FROM public.site_projects p
WHERE p.id = i.project_id
  AND p.status IN ('paused', 'pending_close', 'closed')
  AND i.revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.site_project_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
  v_entity_id UUID;
  v_detail JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project_id := OLD.id;
    v_entity_id := OLD.id;
    v_detail := jsonb_build_object('old', to_jsonb(OLD));
  ELSE
    v_project_id := NEW.id;
    v_entity_id := NEW.id;
    v_detail := jsonb_build_object(
      'new', to_jsonb(NEW),
      'old', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
    );
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
      v_detail := v_detail || jsonb_build_object('status_change', jsonb_build_object(
        'from', OLD.status,
        'to', NEW.status,
        'reason', NULLIF(btrim(NEW.report_notes), '')
      ));
    END IF;
  END IF;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_project_id, auth.uid(), lower(TG_OP), TG_TABLE_NAME, v_entity_id, v_detail);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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

  IF v_old.status IS DISTINCT FROM v_new.status
     AND v_new.status IN ('paused', 'pending_close', 'closed') THEN
    UPDATE public.site_project_invites
    SET revoked_at = NOW()
    WHERE project_id = p_project_id AND revoked_at IS NULL;
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
      PERFORM public.training_recompute_admission(v_admission);
    END LOOP;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT)
TO authenticated;

-- 邀请码刷新使用 extensions 中的 pgcrypto，重开后必须显式刷新生成新码。
ALTER FUNCTION public.site_project_refresh_invite(UUID)
  SET search_path = public, extensions;

COMMIT;

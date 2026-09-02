-- ============================================================================
-- 培训准入第五批：受控临时通行
-- 前置：training-admission-v1.sql 至 training-admission-v4.sql 已执行。
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.training_temp_access_no_seq;
ALTER TABLE public.training_temporary_access
  ADD COLUMN IF NOT EXISTS pass_code TEXT UNIQUE;

DROP FUNCTION IF EXISTS public.training_grant_temporary_access(UUID, TEXT, TIMESTAMPTZ);
CREATE FUNCTION public.training_grant_temporary_access(
  p_admission_id UUID, p_reason TEXT, p_expires_at TIMESTAMPTZ
) RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_project public.site_projects; v_id UUID; v_code TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '准入记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id) THEN RAISE EXCEPTION '您无权授予该人员临时通行'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_a.project_id;
  IF v_project.status <> 'active' THEN RAISE EXCEPTION '项目不是在建状态，不能授予临时通行'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION '必须填写临时通行原因'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= NOW() THEN RAISE EXCEPTION '临时通行截止时间必须晚于当前时间'; END IF;
  IF p_expires_at > NOW() + INTERVAL '24 hours' THEN RAISE EXCEPTION '临时通行最长不得超过 24 小时'; END IF;

  -- 同一人同一项目只保留一张未撤销、未到期的临时通行，避免现场误判。
  UPDATE public.training_temporary_access SET revoked_at = NOW()
  WHERE admission_id = v_a.id AND revoked_at IS NULL AND expires_at > NOW();
  v_code := 'TMP-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || lpad(nextval('public.training_temp_access_no_seq')::TEXT, 5, '0');
  INSERT INTO public.training_temporary_access(admission_id, employee_id, project_id, reason, expires_at, approved_by, pass_code)
  VALUES (v_a.id, v_a.employee_id, v_a.project_id, btrim(p_reason), p_expires_at, auth.uid(), v_code)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'pass_code', v_code, 'expires_at', p_expires_at, 'label', '临时通行（台账标红）');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_grant_temporary_access(UUID, TEXT, TIMESTAMPTZ) TO authenticated;

DROP FUNCTION IF EXISTS public.training_revoke_temporary_access(UUID);
CREATE FUNCTION public.training_revoke_temporary_access(p_access_id UUID)
RETURNS VOID AS $$
DECLARE v_project UUID;
BEGIN
  SELECT project_id INTO v_project FROM public.training_temporary_access WHERE id = p_access_id;
  IF v_project IS NULL THEN RAISE EXCEPTION '临时通行记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_project) THEN RAISE EXCEPTION '您无权撤销该临时通行'; END IF;
  UPDATE public.training_temporary_access SET revoked_at = NOW() WHERE id = p_access_id AND revoked_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_revoke_temporary_access(UUID) TO authenticated;

-- 验证：SELECT proname FROM pg_proc WHERE proname LIKE 'training_%temporary_access';

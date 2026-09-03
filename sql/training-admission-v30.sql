-- ============================================================================
-- 培训准入第三十批：外协人员自助申请的必填资料约束
-- 前置：training-admission-v1.sql 至 training-admission-v29.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.site_project_apply(
  p_token TEXT, p_name TEXT, p_phone TEXT, p_position TEXT,
  p_contractor_name TEXT, p_contractor_code TEXT, p_photo_path TEXT
) RETURNS UUID AS $$
DECLARE
  v_invite public.site_project_invites; v_project public.site_projects;
  v_company UUID; v_company_status TEXT; v_application UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT i.* INTO v_invite FROM public.site_project_invites i
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex') AND i.revoked_at IS NULL AND i.expires_at > NOW();
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效或已过期'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_invite.project_id;
  IF v_project.status <> 'active' THEN RAISE EXCEPTION '项目当前未开放外协人员申请'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL OR NULLIF(btrim(p_phone), '') IS NULL OR NULLIF(btrim(p_position), '') IS NULL THEN RAISE EXCEPTION '姓名、手机号和工种不能为空'; END IF;
  IF btrim(p_phone) !~ '^1[3-9][0-9]{9}$' THEN RAISE EXCEPTION '手机号格式不正确'; END IF;
  IF NULLIF(btrim(p_contractor_name), '') IS NULL THEN RAISE EXCEPTION '请填写外协单位名称'; END IF;
  IF NULLIF(btrim(p_photo_path), '') IS NULL OR p_photo_path !~ '^training-admission/join-applications/' THEN RAISE EXCEPTION '请上传本人现场照片'; END IF;
  SELECT id, status INTO v_company, v_company_status FROM public.contractor_companies
  WHERE name = btrim(p_contractor_name) AND COALESCE(unified_code, '') = COALESCE(NULLIF(btrim(p_contractor_code), ''), '');
  IF v_company IS NULL THEN
    INSERT INTO public.contractor_companies(name, unified_code, status, created_by)
    VALUES (btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), ''), 'pending', auth.uid()) RETURNING id INTO v_company;
  ELSIF v_company_status IN ('rejected', 'inactive') THEN
    RAISE EXCEPTION '该外协单位当前不可申请加入项目，请联系项目部处理';
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_join_applications WHERE project_id = v_project.id AND applicant_user_id = auth.uid() AND status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN RAISE EXCEPTION '您已经申请过加入该项目'; END IF;
  INSERT INTO public.project_join_applications(project_id, applicant_user_id, name, phone, position, photo_path, contractor_id, contractor_name_input, contractor_code_input)
  VALUES (v_project.id, auth.uid(), btrim(p_name), btrim(p_phone), btrim(p_position), p_photo_path, v_company, btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), '')) RETURNING id INTO v_application;
  RETURN v_application;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 外协自助申请附件：单位资质、合同、特种作业证均进入申请档案，等待人工审核。
CREATE TABLE IF NOT EXISTS public.project_join_application_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES public.project_join_applications(id) ON DELETE CASCADE,
  attachment_type TEXT NOT NULL CHECK (attachment_type IN ('qualification', 'contract', 'special_certificate')),
  original_name TEXT,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.project_join_application_attachments ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.project_join_application_attachments TO authenticated;
DROP POLICY IF EXISTS project_join_application_attachments_read ON public.project_join_application_attachments;
CREATE POLICY project_join_application_attachments_read ON public.project_join_application_attachments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.project_join_applications a WHERE a.id = application_id AND (a.applicant_user_id = auth.uid() OR public.site_project_can_manage(a.project_id))));

DROP FUNCTION IF EXISTS public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.site_project_apply(p_token TEXT, p_name TEXT, p_phone TEXT, p_position TEXT, p_contractor_name TEXT, p_contractor_code TEXT, p_photo_path TEXT, p_attachments JSONB DEFAULT '[]'::JSONB) RETURNS UUID AS $$
DECLARE v_invite public.site_project_invites; v_project public.site_projects; v_company UUID; v_status TEXT; v_application UUID; v_item JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT i.* INTO v_invite FROM public.site_project_invites i WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex') AND i.revoked_at IS NULL AND i.expires_at > NOW();
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效或已过期'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_invite.project_id; IF v_project.status <> 'active' THEN RAISE EXCEPTION '项目当前未开放外协人员申请'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL OR NULLIF(btrim(p_phone), '') IS NULL OR NULLIF(btrim(p_position), '') IS NULL OR NULLIF(btrim(p_contractor_name), '') IS NULL THEN RAISE EXCEPTION '姓名、手机号、工种和外协单位不能为空'; END IF;
  IF btrim(p_phone) !~ '^1[3-9][0-9]{9}$' OR NULLIF(btrim(p_photo_path), '') IS NULL OR p_photo_path !~ '^training-admission/join-applications/' THEN RAISE EXCEPTION '手机号或现场照片不符合要求'; END IF;
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::JSONB)) <> 'array' THEN RAISE EXCEPTION '申请附件格式不正确'; END IF;
  IF jsonb_array_length(COALESCE(p_attachments, '[]'::JSONB)) > 3 THEN RAISE EXCEPTION '最多提交三份申请附件'; END IF;
  IF COALESCE(p_position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) x WHERE x->>'type' = 'special_certificate') THEN RAISE EXCEPTION '高风险工种必须上传特种作业证附件'; END IF;
  SELECT id, status INTO v_company, v_status FROM public.contractor_companies WHERE name = btrim(p_contractor_name) AND COALESCE(unified_code, '') = COALESCE(NULLIF(btrim(p_contractor_code), ''), '');
  IF v_company IS NULL THEN INSERT INTO public.contractor_companies(name, unified_code, status, created_by) VALUES (btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), ''), 'pending', auth.uid()) RETURNING id INTO v_company; ELSIF v_status IN ('rejected', 'inactive') THEN RAISE EXCEPTION '该外协单位当前不可申请加入项目'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_join_applications WHERE project_id = v_project.id AND applicant_user_id = auth.uid() AND status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN RAISE EXCEPTION '您已经申请过加入该项目'; END IF;
  INSERT INTO public.project_join_applications(project_id, applicant_user_id, name, phone, position, photo_path, contractor_id, contractor_name_input, contractor_code_input) VALUES (v_project.id, auth.uid(), btrim(p_name), btrim(p_phone), btrim(p_position), p_photo_path, v_company, btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), '')) RETURNING id INTO v_application;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::JSONB)) LOOP
    IF COALESCE(v_item->>'type', '') NOT IN ('qualification', 'contract', 'special_certificate') OR COALESCE(v_item->>'path', '') !~ '^training-admission/join-applications/' THEN RAISE EXCEPTION '申请附件格式不正确'; END IF;
    INSERT INTO public.project_join_application_attachments(application_id, attachment_type, original_name, storage_path) VALUES (v_application, v_item->>'type', NULLIF(left(v_item->>'name', 160), ''), v_item->>'path');
  END LOOP;
  RETURN v_application;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;

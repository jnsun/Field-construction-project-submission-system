-- ============================================================================
-- 培训准入第三十三批：扫码后自动进入项目申请与邀请码预校验
-- 前置：training-admission-v1.sql 至 training-admission-v32.sql 已执行。
-- 仅返回持有邀请码者申请时需要确认的项目名称和有效期，不返回人员或合同资料。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.site_project_invite_summary(p_token TEXT)
RETURNS TABLE(project_code TEXT, project_name TEXT, expires_at TIMESTAMPTZ) AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录后再申请加入项目'; END IF;
  IF NULLIF(btrim(p_token), '') IS NULL THEN RAISE EXCEPTION '请扫描项目二维码或输入邀请码'; END IF;
  RETURN QUERY
  SELECT p.project_code, p.name, i.expires_at
  FROM public.site_project_invites i
  JOIN public.site_projects p ON p.id = i.project_id
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex')
    AND i.revoked_at IS NULL AND i.expires_at > NOW() AND p.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效、已过期，或项目当前未开放外协人员申请'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.site_project_invite_summary(TEXT) TO authenticated;

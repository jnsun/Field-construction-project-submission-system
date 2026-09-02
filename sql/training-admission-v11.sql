-- ============================================================================
-- 培训准入第十一批：临时通行二维码核验
-- 前置：training-admission-v1.sql 至 training-admission-v10.sql 已执行。
-- 临时通行始终是受控例外，不能替代正常电子记录凭证。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_verify_temporary_access(TEXT);
CREATE FUNCTION public.training_verify_temporary_access(p_pass_code TEXT)
RETURNS TABLE (
  pass_code TEXT,
  employee_name TEXT,
  photo_path TEXT,
  work_position TEXT,
  project_code TEXT,
  project_name TEXT,
  access_status TEXT,
  expires_at TIMESTAMPTZ,
  reason TEXT
) AS $$
BEGIN
  IF NULLIF(btrim(p_pass_code), '') IS NULL THEN
    RAISE EXCEPTION '请输入临时通行编号';
  END IF;

  -- 仅返回当前登录人可管理项目的、当前已生效且未撤销的通行记录。
  RETURN QUERY
  SELECT t.pass_code,
         e.name,
         e.photo_path,
         e.position,
         p.project_code,
         p.name,
         'temporary_access'::TEXT,
         t.expires_at,
         t.reason
  FROM public.training_temporary_access t
  JOIN public.training_employees e ON e.id = t.employee_id
  JOIN public.site_projects p ON p.id = t.project_id
  WHERE upper(t.pass_code) = upper(btrim(p_pass_code))
    AND t.revoked_at IS NULL
    AND t.starts_at <= NOW()
    AND t.expires_at > NOW()
    AND p.status = 'active'
    AND public.site_project_can_manage(p.id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_verify_temporary_access(TEXT) TO authenticated;

-- 验证：以项目经理或安全员账号执行。
-- SELECT * FROM public.training_verify_temporary_access('TMP-20260902-00001');

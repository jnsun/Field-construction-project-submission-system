-- ============================================================================
-- 培训准入第三十二批：现场二维码核验留痕
-- 前置：training-admission-v1.sql 至 training-admission-v31.sql 已执行。
-- 只保存凭证末 6 位，不保存身份证、手机号、照片或完整二维码内容。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.training_verification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  verifier_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('certificate', 'temporary', 'visitor')),
  result_status TEXT NOT NULL,
  code_suffix TEXT NOT NULL,
  reason TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_training_verification_logs_project
  ON public.training_verification_logs(project_id, verified_at DESC);

ALTER TABLE public.training_verification_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_verification_logs_read ON public.training_verification_logs;
CREATE POLICY training_verification_logs_read ON public.training_verification_logs
  FOR SELECT TO authenticated USING (public.site_project_can_manage(project_id));

CREATE OR REPLACE FUNCTION public.training_log_verification(
  p_project_id UUID, p_employee_id UUID, p_credential_type TEXT,
  p_result_status TEXT, p_reason TEXT DEFAULT NULL, p_code TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权记录该项目的现场核验'; END IF;
  IF p_credential_type NOT IN ('certificate', 'temporary', 'visitor') THEN RAISE EXCEPTION '未知的凭证类别'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_employees WHERE id = p_employee_id) THEN RAISE EXCEPTION '人员不存在'; END IF;
  INSERT INTO public.training_verification_logs(project_id, employee_id, verifier_id, credential_type, result_status, code_suffix, reason)
  VALUES (p_project_id, p_employee_id, auth.uid(), p_credential_type, COALESCE(NULLIF(btrim(p_result_status), ''), 'unknown'),
    right(upper(regexp_replace(COALESCE(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 6), NULLIF(btrim(p_reason), ''));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_recent_verification_logs(p_project_id UUID DEFAULT NULL, p_limit INT DEFAULT 20)
RETURNS TABLE(verified_at TIMESTAMPTZ, project_code TEXT, project_name TEXT, employee_name TEXT, work_position TEXT, credential_type TEXT, result_status TEXT, code_suffix TEXT, reason TEXT, verifier_name TEXT) AS $$
  SELECT l.verified_at, p.project_code, p.name, e.name, e.position, l.credential_type,
         l.result_status, l.code_suffix, l.reason, COALESCE(pr.full_name, pr.email, '—')
  FROM public.training_verification_logs l
  JOIN public.site_projects p ON p.id = l.project_id
  JOIN public.training_employees e ON e.id = l.employee_id
  LEFT JOIN public.profiles pr ON pr.id = l.verifier_id
  WHERE public.site_project_can_manage(l.project_id) AND (p_project_id IS NULL OR l.project_id = p_project_id)
  ORDER BY l.verified_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 补充内部 ID，仅供登录项目管理人员核验成功后写入留痕，页面不会展示这些 ID。
DROP FUNCTION IF EXISTS public.training_verify_certificate(TEXT);
CREATE FUNCTION public.training_verify_certificate(p_certificate_no TEXT)
RETURNS TABLE(certificate_no TEXT, employee_name TEXT, photo_path TEXT, work_position TEXT, project_code TEXT, project_name TEXT, admission_status TEXT, valid_until DATE, blocked_reason TEXT, project_id UUID, employee_id UUID) AS $$
  SELECT c.certificate_no, e.name, e.photo_path, e.position, p.project_code, p.name,
    CASE WHEN p.status IN ('paused', 'pending_close') THEN 'blocked' WHEN p.status = 'closed' THEN 'project_closed'
      WHEN COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) THEN 'blocked'
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired' WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN 'expired' ELSE a.status END,
    LEAST(COALESCE(a.valid_until, c.valid_until), c.valid_until),
    CASE WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认' WHEN p.status = 'closed' THEN '项目已关闭'
      WHEN COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) THEN '高风险岗位尚未审核通过特种作业证'
      WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期' WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN '电子记录凭证已失效' ELSE a.blocked_reason END,
    p.id, e.id
  FROM public.training_eligibility_certificates c JOIN public.training_admissions a ON a.id = c.admission_id
  JOIN public.site_projects p ON p.id = a.project_id JOIN public.training_employees e ON e.id = a.employee_id
  WHERE upper(c.certificate_no) = upper(btrim(p_certificate_no)) AND public.site_project_can_manage(p.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_verify_temporary_access(TEXT);
CREATE FUNCTION public.training_verify_temporary_access(p_pass_code TEXT)
RETURNS TABLE(pass_code TEXT, employee_name TEXT, photo_path TEXT, work_position TEXT, project_code TEXT, project_name TEXT, access_status TEXT, expires_at TIMESTAMPTZ, reason TEXT, project_id UUID, employee_id UUID) AS $$
  SELECT t.pass_code, e.name, e.photo_path, e.position, p.project_code, p.name, 'temporary_access'::TEXT, t.expires_at, t.reason, p.id, e.id
  FROM public.training_temporary_access t JOIN public.training_employees e ON e.id = t.employee_id JOIN public.site_projects p ON p.id = t.project_id
  WHERE upper(t.pass_code) = upper(btrim(p_pass_code)) AND t.revoked_at IS NULL AND t.starts_at <= NOW() AND t.expires_at > NOW() AND p.status = 'active' AND public.site_project_can_manage(p.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_verify_visitor_notice(TEXT);
CREATE FUNCTION public.training_verify_visitor_notice(p_pass_code TEXT)
RETURNS TABLE(pass_code TEXT, employee_name TEXT, photo_path TEXT, work_position TEXT, project_code TEXT, project_name TEXT, access_status TEXT, expires_at TIMESTAMPTZ, notice_content TEXT, project_id UUID, employee_id UUID) AS $$
  SELECT n.pass_code, e.name, e.photo_path, e.position, p.project_code, p.name, 'visitor_notice'::TEXT, n.expires_at, n.notice_content, p.id, e.id
  FROM public.training_visitor_safety_notices n JOIN public.training_employees e ON e.id = n.employee_id JOIN public.site_projects p ON p.id = n.project_id
  WHERE upper(n.pass_code) = upper(btrim(p_pass_code)) AND n.acknowledged_at IS NOT NULL AND n.revoked_at IS NULL AND n.expires_at > NOW() AND p.status = 'active' AND public.site_project_can_manage(p.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_log_verification(UUID, UUID, TEXT, TEXT, TEXT, TEXT),
  public.training_recent_verification_logs(UUID, INT), public.training_verify_certificate(TEXT),
  public.training_verify_temporary_access(TEXT), public.training_verify_visitor_notice(TEXT) TO authenticated;

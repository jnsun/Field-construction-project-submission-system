-- ============================================================================
-- 培训准入第十四批：公司领导访客安全告知与二维码核验
-- 前置：training-admission-v1.sql 至 training-admission-v13.sql 已执行。
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS public.training_visitor_notice_no_seq;
CREATE TABLE IF NOT EXISTS public.training_visitor_safety_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  notice_content TEXT NOT NULL,
  pass_code TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  issued_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at <= created_at + INTERVAL '7 days')
);
ALTER TABLE public.training_visitor_safety_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_visitor_notices_read ON public.training_visitor_safety_notices;
CREATE POLICY training_visitor_notices_read ON public.training_visitor_safety_notices FOR SELECT TO authenticated
  USING (public.site_project_can_read(project_id) OR employee_id = public.training_my_employee_id());

CREATE OR REPLACE FUNCTION public.training_issue_visitor_notice(p_project_id UUID, p_employee_id UUID, p_content TEXT, p_expires_at TIMESTAMPTZ)
RETURNS JSONB AS $$
DECLARE v_project public.site_projects%ROWTYPE; v_code TEXT; v_id UUID;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权登记该项目访客安全告知'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = p_project_id;
  IF NOT FOUND OR v_project.status <> 'active' THEN RAISE EXCEPTION '仅在建项目可登记领导访客'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_employees WHERE id = p_employee_id AND status = 'active') THEN RAISE EXCEPTION '访客人员不存在或非在职状态'; END IF;
  IF NULLIF(btrim(p_content), '') IS NULL THEN RAISE EXCEPTION '必须填写现场安全告知内容'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= NOW() OR p_expires_at > NOW() + INTERVAL '7 days' THEN RAISE EXCEPTION '访客安全告知有效期须在未来 7 天内'; END IF;
  UPDATE public.training_visitor_safety_notices SET revoked_at = NOW()
    WHERE project_id = p_project_id AND employee_id = p_employee_id AND revoked_at IS NULL AND expires_at > NOW();
  v_code := 'VIS-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || lpad(nextval('public.training_visitor_notice_no_seq')::TEXT, 5, '0');
  INSERT INTO public.training_visitor_safety_notices(project_id, employee_id, notice_content, pass_code, expires_at, issued_by)
  VALUES (p_project_id, p_employee_id, btrim(p_content), v_code, p_expires_at, auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'pass_code', v_code, 'expires_at', p_expires_at);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_acknowledge_visitor_notice(p_notice_id UUID)
RETURNS VOID AS $$
DECLARE v_notice public.training_visitor_safety_notices%ROWTYPE;
BEGIN
  SELECT * INTO v_notice FROM public.training_visitor_safety_notices WHERE id = p_notice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '访客安全告知不存在'; END IF;
  IF v_notice.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '只能由本人确认访客安全告知'; END IF;
  IF v_notice.revoked_at IS NOT NULL OR v_notice.expires_at <= NOW() OR NOT EXISTS (SELECT 1 FROM public.site_projects WHERE id = v_notice.project_id AND status = 'active') THEN RAISE EXCEPTION '该访客安全告知已失效'; END IF;
  UPDATE public.training_visitor_safety_notices SET acknowledged_at = NOW(), acknowledged_by = auth.uid() WHERE id = p_notice_id AND acknowledged_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_my_visitor_notices()
RETURNS TABLE(id UUID, project_code TEXT, project_name TEXT, notice_content TEXT, pass_code TEXT, expires_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ) AS $$
  SELECT n.id, p.project_code, p.name, n.notice_content, n.pass_code, n.expires_at, n.acknowledged_at
  FROM public.training_visitor_safety_notices n JOIN public.site_projects p ON p.id = n.project_id
  WHERE n.employee_id = public.training_my_employee_id() AND n.revoked_at IS NULL AND n.expires_at > NOW() AND p.status = 'active'
  ORDER BY n.expires_at;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_verify_visitor_notice(p_pass_code TEXT)
RETURNS TABLE(pass_code TEXT, employee_name TEXT, photo_path TEXT, work_position TEXT, project_code TEXT, project_name TEXT, access_status TEXT, expires_at TIMESTAMPTZ, notice_content TEXT) AS $$
  SELECT n.pass_code, e.name, e.photo_path, e.position, p.project_code, p.name, 'visitor_notice'::TEXT, n.expires_at, n.notice_content
  FROM public.training_visitor_safety_notices n JOIN public.training_employees e ON e.id = n.employee_id JOIN public.site_projects p ON p.id = n.project_id
  WHERE upper(n.pass_code) = upper(btrim(p_pass_code)) AND n.acknowledged_at IS NOT NULL AND n.revoked_at IS NULL
    AND n.expires_at > NOW() AND p.status = 'active' AND public.site_project_can_manage(p.id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_issue_visitor_notice(UUID, UUID, TEXT, TIMESTAMPTZ), public.training_acknowledge_visitor_notice(UUID), public.training_my_visitor_notices(), public.training_verify_visitor_notice(TEXT) TO authenticated;

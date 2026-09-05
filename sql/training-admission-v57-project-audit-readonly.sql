-- D06：项目状态历史对客户端严格只读，读取范围继续由现有 RLS 控制。
BEGIN;

REVOKE ALL ON TABLE public.site_project_audit_logs FROM anon, authenticated;
GRANT SELECT ON TABLE public.site_project_audit_logs TO authenticated;

COMMIT;

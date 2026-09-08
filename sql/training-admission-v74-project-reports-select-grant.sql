-- Pages 项目报送直接查询需要表级 SELECT；可见范围继续由既有 RLS policy 决定。
BEGIN;

GRANT SELECT ON TABLE public.project_reports TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

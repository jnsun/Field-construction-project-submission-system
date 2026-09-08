-- D08 R02：项目成员只能通过受控服务端流程创建，客户端不得直接 INSERT。
BEGIN;

REVOKE INSERT ON TABLE public.site_project_members FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

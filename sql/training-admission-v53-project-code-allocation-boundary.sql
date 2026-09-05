-- D06：项目编号只能随正式项目创建分配，禁止单独占用编号。
BEGIN;

REVOKE ALL ON FUNCTION public.next_site_project_code()
FROM PUBLIC, anon, authenticated;

COMMIT;

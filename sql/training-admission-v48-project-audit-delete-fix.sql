-- Keep project deletion auditable without violating site_project_audit_logs.project_id FK.
BEGIN;

DROP TRIGGER IF EXISTS trg_site_projects_audit ON public.site_projects;
DROP TRIGGER IF EXISTS trg_site_projects_audit_delete ON public.site_projects;

CREATE TRIGGER trg_site_projects_audit
  AFTER INSERT OR UPDATE ON public.site_projects
  FOR EACH ROW EXECUTE FUNCTION public.site_project_audit_trigger();

CREATE TRIGGER trg_site_projects_audit_delete
  BEFORE DELETE ON public.site_projects
  FOR EACH ROW EXECUTE FUNCTION public.site_project_audit_trigger();

COMMIT;

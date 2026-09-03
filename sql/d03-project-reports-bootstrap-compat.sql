-- D03 empty-database compatibility bridge.
-- training-admission-v1 reads the legacy monthly-report status column,
-- but schema.sql intentionally remains the minimal original baseline.
ALTER TABLE public.project_reports
  ADD COLUMN IF NOT EXISTS project_status TEXT DEFAULT 'active';

ALTER TABLE public.project_reports
  DROP CONSTRAINT IF EXISTS project_reports_project_status_check;
ALTER TABLE public.project_reports
  ADD CONSTRAINT project_reports_project_status_check
  CHECK (project_status IN ('active', 'completed'));

UPDATE public.project_reports
SET project_status = 'active'
WHERE project_status IS NULL OR project_status = '';

ALTER TABLE public.project_reports
  ALTER COLUMN project_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_project_status_department
  ON public.project_reports (project_status, department_id);

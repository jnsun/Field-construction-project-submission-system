-- D03 empty-database compatibility bridge.
-- department-tree.sql and later department RPCs require these legacy columns,
-- but no active migration creates them from schema.sql alone.
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS needs_report BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS can_view_admin BOOLEAN;

COMMENT ON COLUMN public.departments.needs_report IS 'Whether this department must submit monthly field-project reports.';
COMMENT ON COLUMN public.departments.can_view_admin IS 'Optional explicit access to the reporting management view.';

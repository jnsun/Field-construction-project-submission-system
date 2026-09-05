-- D03: make notification settings safe in a clean replay and recovery target.
-- Direct table access remains ungranted; existing company-admin SECURITY DEFINER
-- RPCs are the only authenticated application access path.
BEGIN;

ALTER TABLE public.training_admission_notification_settings ENABLE ROW LEVEL SECURITY;

COMMIT;

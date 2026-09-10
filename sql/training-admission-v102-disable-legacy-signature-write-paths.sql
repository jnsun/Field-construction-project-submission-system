-- D15 forward hardening: retain legacy evidence read-only, but close write and
-- TRUNCATE paths that bypass the v98 authoritative evidence state machine.
BEGIN;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.training_signatures,public.training_admission_signatures FROM anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.training_submit_signature(UUID,TEXT,TEXT),public.training_admission_sign(UUID,UUID,TEXT,TEXT,TEXT,TEXT) FROM authenticated;
COMMIT;

-- D05 security baseline. Apply after the existing training-admission migrations.
-- This migration is repeatable and does not alter signed or published records.
BEGIN;

-- PostgreSQL grants EXECUTE to PUBLIC by default. SECURITY DEFINER functions
-- must never inherit that default, because anon callers bypass application roles.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.signature);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- This auth trigger writes into public.profiles. Pin the lookup path so a
-- malicious object in a caller-controlled schema cannot be resolved first.
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- Existing explicit authenticated grants remain in place. Remove the broad
-- signature policy so a completed signature cannot be changed or deleted.
DROP POLICY IF EXISTS sig_me ON public.training_signatures;
DROP POLICY IF EXISTS training_signatures_read ON public.training_signatures;
DROP POLICY IF EXISTS training_signatures_insert ON public.training_signatures;

CREATE POLICY training_signatures_read ON public.training_signatures
  FOR SELECT TO authenticated
  USING (employee_id = public.training_my_employee_id() OR public.is_admin());

CREATE POLICY training_signatures_insert ON public.training_signatures
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = public.training_my_employee_id());

CREATE OR REPLACE FUNCTION public.training_signature_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '已签署记录不可修改或删除';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_signatures_immutable ON public.training_signatures;
CREATE TRIGGER trg_training_signatures_immutable
  BEFORE UPDATE OR DELETE ON public.training_signatures
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_immutable_guard();

DROP TRIGGER IF EXISTS trg_training_admission_signatures_immutable ON public.training_admission_signatures;
CREATE TRIGGER trg_training_admission_signatures_immutable
  BEFORE UPDATE OR DELETE ON public.training_admission_signatures
  FOR EACH ROW EXECUTE FUNCTION public.training_signature_immutable_guard();

REVOKE ALL ON FUNCTION public.training_signature_immutable_guard() FROM PUBLIC, anon, authenticated;

COMMIT;

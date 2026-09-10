-- D15 forward correction for databases that already executed v98 before the
-- pgcrypto extension schema was pinned for challenge generation.
BEGIN;
ALTER FUNCTION public.training_signature_prepare(UUID) SET search_path=public,extensions;
COMMIT;

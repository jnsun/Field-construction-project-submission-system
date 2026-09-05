-- D05 P1: close implicit/public execution of SECURITY DEFINER statistics functions.
-- Keep authenticated access only for the eight RPCs called directly by the Web client.

BEGIN;

DO $$
DECLARE
  v_missing text;
  v_invalid text;
BEGIN
  WITH expected(signature) AS (
    VALUES
      ('public.stats_alert_ack(uuid[])'),
      ('public.stats_alert_inbox(boolean)'),
      ('public.stats_alert_sync()'),
      ('public.stats_can_access(uuid)'),
      ('public.stats_export_records(uuid,uuid)'),
      ('public.stats_overdue_list(uuid,integer)'),
      ('public.stats_overview(uuid,date,date)'),
      ('public.stats_scope_depts(uuid)'),
      ('public.stats_set_cert_target(uuid,integer)'),
      ('public.stats_set_settings(numeric,integer)')
  )
  SELECT string_agg(signature, ', ' ORDER BY signature)
    INTO v_missing
    FROM expected
   WHERE to_regprocedure(signature) IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v52 prerequisite missing statistics functions: %', v_missing;
  END IF;

  WITH expected(signature) AS (
    VALUES
      ('public.stats_alert_ack(uuid[])'),
      ('public.stats_alert_inbox(boolean)'),
      ('public.stats_alert_sync()'),
      ('public.stats_can_access(uuid)'),
      ('public.stats_export_records(uuid,uuid)'),
      ('public.stats_overdue_list(uuid,integer)'),
      ('public.stats_overview(uuid,date,date)'),
      ('public.stats_scope_depts(uuid)'),
      ('public.stats_set_cert_target(uuid,integer)'),
      ('public.stats_set_settings(numeric,integer)')
  )
  SELECT string_agg(e.signature, ', ' ORDER BY e.signature)
    INTO v_invalid
    FROM expected e
    JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
   WHERE NOT p.prosecdef
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public']::text[];

  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION 'v52 refuses unsafe statistics function definitions: %', v_invalid;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.stats_alert_ack(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_alert_inbox(boolean) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_alert_sync() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_can_access(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_export_records(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_overdue_list(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_overview(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_scope_depts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_set_cert_target(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.stats_set_settings(numeric, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.stats_alert_ack(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_alert_inbox(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_alert_sync() TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_export_records(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_overdue_list(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_overview(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_set_cert_target(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_set_settings(numeric, integer) TO authenticated;

DO $$
DECLARE
  v_error text;
BEGIN
  WITH expected(signature, authenticated_execute) AS (
    VALUES
      ('public.stats_alert_ack(uuid[])', true),
      ('public.stats_alert_inbox(boolean)', true),
      ('public.stats_alert_sync()', true),
      ('public.stats_can_access(uuid)', false),
      ('public.stats_export_records(uuid,uuid)', true),
      ('public.stats_overdue_list(uuid,integer)', true),
      ('public.stats_overview(uuid,date,date)', true),
      ('public.stats_scope_depts(uuid)', false),
      ('public.stats_set_cert_target(uuid,integer)', true),
      ('public.stats_set_settings(numeric,integer)', true)
  ), checked AS (
    SELECT e.signature,
           e.authenticated_execute,
           EXISTS (
             SELECT 1
               FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
              WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
           ) AS public_execute,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS actual_authenticated_execute
      FROM expected e
      JOIN pg_proc p ON p.oid = to_regprocedure(e.signature)
  )
  SELECT string_agg(signature, ', ' ORDER BY signature)
    INTO v_error
    FROM checked
   WHERE public_execute
      OR anon_execute
      OR actual_authenticated_execute IS DISTINCT FROM authenticated_execute;

  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION 'v52 statistics EXECUTE boundary verification failed: %', v_error;
  END IF;
END;
$$;

COMMIT;

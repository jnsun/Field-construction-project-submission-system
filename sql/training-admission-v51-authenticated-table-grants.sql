-- D05: restore the table privileges required for existing authenticated Web calls.
-- RLS policies remain the authority for row visibility and write scope.
BEGIN;

DO $$
DECLARE
  missing_boundary TEXT;
BEGIN
  SELECT string_agg(required.table_name || ':' || required.command, ', ' ORDER BY required.table_name, required.command)
    INTO missing_boundary
  FROM (VALUES
    ('profiles', 'SELECT'),
    ('departments', 'SELECT'),
    ('training_employees', 'SELECT'),
    ('training_employees', 'INSERT'),
    ('training_employees', 'UPDATE'),
    ('training_employees', 'DELETE')
  ) AS required(table_name, command)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = required.table_name
      AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = required.table_name
      AND p.cmd = required.command
  );

  IF missing_boundary IS NOT NULL THEN
    RAISE EXCEPTION 'D05 refuses table grants because an RLS boundary is missing: %', missing_boundary;
  END IF;
END $$;

REVOKE ALL PRIVILEGES ON TABLE
  public.profiles,
  public.departments,
  public.training_employees
FROM anon;

GRANT SELECT ON TABLE
  public.profiles,
  public.departments
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.training_employees
TO authenticated;

-- training_employees policies call these two helpers directly. v49 revoked
-- the PostgreSQL PUBLIC default, so authenticated must receive only these
-- policy-entry functions; nested helpers continue to run as the definer.
REVOKE ALL ON FUNCTION public.training_can_read(UUID), public.training_can_write(UUID)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_can_read(UUID), public.training_can_write(UUID)
TO authenticated;

COMMIT;

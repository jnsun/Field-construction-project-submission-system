-- Read-only persistent-state fingerprint. It emits row counts and hashes only;
-- no personal data leaves PostgreSQL and no persistent table is created.
CREATE TEMP TABLE d03_data_fingerprint_tmp (
  table_schema TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL,
  row_hash TEXT NOT NULL,
  PRIMARY KEY (table_schema, table_name)
);

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE (table_schema = 'public' AND table_name = ANY (ARRAY[
      'departments', 'profiles', 'project_reports', 'training_employees',
      'training_plans', 'training_assignments', 'training_records',
      'training_participants', 'exam_attempts', 'certificates', 'site_projects',
      'site_project_entities', 'site_project_members', 'contractor_companies',
      'training_admissions', 'training_admission_signatures',
      'training_eligibility_certificates'
    ])) OR (table_schema = 'storage' AND table_name = 'objects')
  LOOP
    EXECUTE format(
      'INSERT INTO d03_data_fingerprint_tmp(table_schema, table_name, row_count, row_hash)
       SELECT %L, %L, count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, '''' ORDER BY to_jsonb(t)::text), ''''))
       FROM %I.%I t',
      r.table_schema, r.table_name, r.table_schema, r.table_name
    );
  END LOOP;
END $$;

SELECT table_schema, table_name, row_count, row_hash
FROM d03_data_fingerprint_tmp
ORDER BY table_schema, table_name;

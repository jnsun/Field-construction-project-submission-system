-- Read-only persistent-state fingerprint. Temporary objects vanish on disconnect.
DROP TABLE IF EXISTS d03_data_fingerprint;
CREATE TEMP TABLE d03_data_fingerprint (
  table_name TEXT PRIMARY KEY,
  row_count BIGINT NOT NULL
);

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY (ARRAY[
        'departments', 'profiles', 'project_reports', 'training_employees',
        'training_plans', 'training_assignments', 'training_records',
        'training_participants', 'exam_attempts', 'certificates'
      ])
  LOOP
    EXECUTE format(
      'INSERT INTO d03_data_fingerprint(table_name, row_count) SELECT %L, count(*) FROM public.%I',
      r.table_name, r.table_name
    );
  END LOOP;
END $$;

SELECT table_name, row_count FROM d03_data_fingerprint ORDER BY table_name;

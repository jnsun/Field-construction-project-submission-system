-- D03 post-migration inventory. It returns metadata only and makes no persistent changes.
WITH target_tables(table_name) AS (
  VALUES
    ('site_projects'), ('site_project_audit_logs'), ('site_project_entities'),
    ('site_project_roles'), ('site_project_invites'), ('contractor_companies'),
    ('contractor_contracts'), ('contractor_documents'), ('project_join_applications'),
    ('site_project_members'), ('training_admission_packages'),
    ('training_admission_package_items'), ('training_admissions'),
    ('training_admission_tasks'), ('training_admission_signatures'),
    ('training_site_confirmations'), ('training_temporary_access'),
    ('training_eligibility_certificates'), ('training_admission_reminders'),
    ('training_admission_special_rules'), ('training_visitor_safety_notices'),
    ('training_admission_notification_settings')
), target_functions(function_name) AS (
  VALUES
    ('site_project_create'), ('site_project_update'), ('site_project_apply'),
    ('training_start_admission'), ('training_confirm_site'),
    ('training_grant_temporary_access'), ('training_prepare_admission_exam'),
    ('training_set_package_special_rules'), ('training_admission_record_cards'),
    ('training_issue_visitor_notice'), ('training_generate_due_reminders'),
    ('site_project_report_status_hints')
)
SELECT 'table' AS category, c.relname AS object_name,
  jsonb_build_object('rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity) AS details
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN target_tables t ON t.table_name = c.relname
WHERE n.nspname = 'public' AND c.relkind = 'r'
UNION ALL
SELECT 'column', cols.table_name || '.' || cols.column_name,
  jsonb_build_object('type', cols.data_type, 'nullable', cols.is_nullable, 'default', cols.column_default)
FROM information_schema.columns cols
JOIN target_tables t ON t.table_name = cols.table_name
WHERE cols.table_schema = 'public'
UNION ALL
SELECT 'constraint', rel.relname || '.' || con.conname, jsonb_build_object('definition', pg_get_constraintdef(con.oid))
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
JOIN target_tables t ON t.table_name = rel.relname
WHERE n.nspname = 'public'
UNION ALL
SELECT 'index', rel.relname || '.' || idx.relname, jsonb_build_object('definition', pg_get_indexdef(idx.oid))
FROM pg_index i
JOIN pg_class rel ON rel.oid = i.indrelid
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
JOIN target_tables t ON t.table_name = rel.relname
WHERE n.nspname = 'public'
UNION ALL
SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
  jsonb_build_object('security_definer', p.prosecdef, 'config', p.proconfig, 'acl', p.proacl)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN target_functions f ON f.function_name = p.proname
WHERE n.nspname = 'public'
UNION ALL
SELECT 'trigger', rel.relname || '.' || trg.tgname,
  jsonb_build_object('enabled', trg.tgenabled, 'definition', pg_get_triggerdef(trg.oid))
FROM pg_trigger trg
JOIN pg_class rel ON rel.oid = trg.tgrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
JOIN target_tables t ON t.table_name = rel.relname
WHERE n.nspname = 'public' AND NOT trg.tgisinternal
UNION ALL
SELECT 'policy', pol.tablename || '.' || pol.policyname,
  jsonb_build_object('command', pol.cmd, 'roles', pol.roles, 'using', pol.qual, 'check', pol.with_check)
FROM pg_policies pol
JOIN target_tables t ON t.table_name = pol.tablename
WHERE pol.schemaname = 'public'
UNION ALL
SELECT 'storage_bucket', b.id, jsonb_build_object('public', b.public, 'file_size_limit', b.file_size_limit)
FROM storage.buckets b WHERE b.id IN ('training-courses', 'training-signatures', 'avatars')
UNION ALL
SELECT 'storage_policy', pol.tablename || '.' || pol.policyname,
  jsonb_build_object('command', pol.cmd, 'roles', pol.roles, 'using', pol.qual, 'check', pol.with_check)
FROM pg_policies pol
WHERE pol.schemaname = 'storage' AND pol.tablename = 'objects'
ORDER BY category, object_name;

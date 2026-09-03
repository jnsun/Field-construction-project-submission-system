-- D03: v1-v16 SECURITY DEFINER permission verification and hardening.
-- Execute only after training-admission-v1.sql through v16.sql.
-- Every listed RPC is intended for authenticated callers; trigger-only helpers
-- are revoked without being granted to application roles.
DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname = ANY (ARRAY[
        'next_site_project_code', 'site_project_member_guard', 'site_project_can_read',
        'site_project_can_manage', 'site_project_can_admin', 'site_project_audit_trigger',
        'training_temporary_access_guard', 'site_project_create', 'site_project_update',
        'site_project_link_reports', 'site_project_set_entities', 'site_project_refresh_invite',
        'site_project_apply', 'training_start_admission', 'training_confirm_site',
        'training_recompute_admission', 'training_admission_sign', 'training_issue_certificate',
        'training_admission_report', 'training_admission_signature_report',
        'training_my_admission_status', 'training_my_employee_id', 'site_project_set_roles',
        'site_project_review_application', 'training_sync_admission_assignment',
        'training_verify_certificate', 'training_my_certificate', 'training_grant_temporary_access',
        'training_revoke_temporary_access', 'training_review_admission_package',
        'training_batch_remind', 'training_prepare_admission_exam',
        'training_sync_admission_exam', 'training_set_package_special_rules',
        'training_verify_temporary_access', 'training_admission_record_cards',
        'training_plan_can_approve', 'training_request_plan_approval', 'training_approve_plan',
        'training_batch_approve_plans', 'training_course_version_guard', 'training_publish_plan',
        'training_issue_visitor_notice', 'training_acknowledge_visitor_notice',
        'training_my_visitor_notices', 'training_verify_visitor_notice',
        'training_send_admission_start_notice', 'training_generate_due_reminders',
        'site_project_report_status_hints'
      ])
      AND NOT EXISTS (
        SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::TEXT[])) c
        WHERE c LIKE 'search_path=public%'
      )
  ) THEN
    RAISE EXCEPTION 'D03 refused: a v1-v16 SECURITY DEFINER function has no fixed public search_path';
  END IF;

  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname = ANY (ARRAY[
        'next_site_project_code', 'site_project_member_guard', 'site_project_can_read',
        'site_project_can_manage', 'site_project_can_admin', 'site_project_audit_trigger',
        'training_temporary_access_guard', 'site_project_create', 'site_project_update',
        'site_project_link_reports', 'site_project_set_entities', 'site_project_refresh_invite',
        'site_project_apply', 'training_start_admission', 'training_confirm_site',
        'training_recompute_admission', 'training_admission_sign', 'training_issue_certificate',
        'training_admission_report', 'training_admission_signature_report',
        'training_my_admission_status', 'training_my_employee_id', 'site_project_set_roles',
        'site_project_review_application', 'training_sync_admission_assignment',
        'training_verify_certificate', 'training_my_certificate', 'training_grant_temporary_access',
        'training_revoke_temporary_access', 'training_review_admission_package',
        'training_batch_remind', 'training_prepare_admission_exam',
        'training_sync_admission_exam', 'training_set_package_special_rules',
        'training_verify_temporary_access', 'training_admission_record_cards',
        'training_plan_can_approve', 'training_request_plan_approval', 'training_approve_plan',
        'training_batch_approve_plans', 'training_course_version_guard', 'training_publish_plan',
        'training_issue_visitor_notice', 'training_acknowledge_visitor_notice',
        'training_my_visitor_notices', 'training_verify_visitor_notice',
        'training_send_admission_start_notice', 'training_generate_due_reminders',
        'site_project_report_status_hints'
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.signature);
  END LOOP;
END $$;

-- Re-grant only callable RPCs. Policy and trigger helpers remain non-callable.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'next_site_project_code', 'site_project_can_read', 'site_project_can_manage',
        'site_project_can_admin', 'site_project_create', 'site_project_update',
        'site_project_link_reports', 'site_project_set_entities', 'site_project_refresh_invite',
        'site_project_apply', 'training_start_admission', 'training_confirm_site',
        'training_recompute_admission', 'training_admission_sign', 'training_issue_certificate',
        'training_admission_report', 'training_admission_signature_report',
        'training_my_admission_status', 'training_my_employee_id', 'site_project_set_roles',
        'site_project_review_application', 'training_verify_certificate', 'training_my_certificate',
        'training_grant_temporary_access', 'training_revoke_temporary_access',
        'training_review_admission_package', 'training_batch_remind',
        'training_prepare_admission_exam', 'training_set_package_special_rules',
        'training_verify_temporary_access', 'training_admission_record_cards',
        'training_request_plan_approval', 'training_approve_plan',
        'training_batch_approve_plans', 'training_publish_plan',
        'training_issue_visitor_notice', 'training_acknowledge_visitor_notice',
        'training_my_visitor_notices', 'training_verify_visitor_notice',
        'training_send_admission_start_notice', 'training_generate_due_reminders',
        'site_project_report_status_hints'
      ])
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.signature);
  END LOOP;
END $$;

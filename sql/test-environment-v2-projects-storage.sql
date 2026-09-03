-- D02 phase 2: isolated project-state and Storage fixtures.
-- Run only after test-environment-v1.sql in a dedicated test database.
BEGIN;
DO $$ BEGIN
  IF current_setting('app.safety_test_confirmation', true) <> 'D02_TEST_ONLY' THEN
    RAISE EXCEPTION 'Refusing to seed: set app.safety_test_confirmation to D02_TEST_ONLY for this session.';
  END IF;
END $$;

-- Keep test employees inside the anonymous D02 organization tree.
UPDATE public.training_employees e
SET department_id = CASE
  WHEN e.employee_no IN ('D02-001', 'D02-008') THEN (SELECT id FROM public.departments WHERE code = 'D02-SAFE')
  ELSE (SELECT id FROM public.departments WHERE code = 'D02-ENT-A')
END
WHERE e.remark = 'D02-TEST' AND e.department_id IS NULL;

INSERT INTO public.site_projects(project_code, name, project_type, location, status, start_date, expected_end_date, lead_entity_id, report_notes)
SELECT v.project_code, v.name, v.project_type, v.location, v.status, CURRENT_DATE - 14, CURRENT_DATE + 90, d.id, 'D02-TEST'
FROM (VALUES
  ('D02-NORMAL', '[D02-TEST] 普通野外项目', '野外勘查', 'D02 测试区 A', 'active'),
  ('D02-HIGH-RISK', '[D02-TEST] 高风险钻探项目', '钻探', 'D02 测试区 B', 'active'),
  ('D02-PAUSED', '[D02-TEST] 暂停项目', '野外勘查', 'D02 测试区 C', 'paused'),
  ('D02-REOPENED', '[D02-TEST] 关闭后重开项目', '野外勘查', 'D02 测试区 D', 'active')
) AS v(project_code, name, project_type, location, status)
JOIN public.departments d ON d.code = 'D02-ENT-A'
ON CONFLICT (project_code) DO UPDATE
SET name = EXCLUDED.name, status = EXCLUDED.status, report_notes = 'D02-TEST', updated_at = NOW();

UPDATE public.site_projects
SET pause_started_at = CASE WHEN status = 'paused' THEN NOW() - INTERVAL '10 days' ELSE NULL END,
    pause_reason = CASE WHEN status = 'paused' THEN 'D02-TEST 暂停状态夹具' ELSE NULL END
WHERE project_code = 'D02-PAUSED';

INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
SELECT p.id, d.id, TRUE
FROM public.site_projects p JOIN public.departments d ON d.code = 'D02-ENT-A'
WHERE p.project_code LIKE 'D02-%'
ON CONFLICT (project_id, entity_id) DO UPDATE SET is_lead = TRUE;

INSERT INTO public.site_project_audit_logs(project_id, action, entity_type, entity_id, detail)
SELECT p.id, 'd02_fixture_created', 'site_project', p.id,
       jsonb_build_object('run_key', 'D02-TEST-20260903', 'state', p.status)
FROM public.site_projects p WHERE p.project_code LIKE 'D02-%'
  AND NOT EXISTS (SELECT 1 FROM public.site_project_audit_logs l WHERE l.project_id = p.id AND l.action = 'd02_fixture_created');
INSERT INTO public.site_project_audit_logs(project_id, action, entity_type, entity_id, detail)
SELECT p.id, 'd02_reopened', 'site_project', p.id,
       jsonb_build_object('run_key', 'D02-TEST-20260903', 'reason', 'fixture covers closed-to-active history')
FROM public.site_projects p WHERE p.project_code = 'D02-REOPENED'
  AND NOT EXISTS (SELECT 1 FROM public.site_project_audit_logs l WHERE l.project_id = p.id AND l.action = 'd02_reopened');

INSERT INTO public.safety_test_fixture_registry(run_key, table_name, record_id, fixture_role)
SELECT 'D02-TEST-20260903', 'site_projects', p.id, p.project_code
FROM public.site_projects p WHERE p.project_code LIKE 'D02-%'
ON CONFLICT DO NOTHING;

INSERT INTO public.contractor_companies(name, unified_code, contact_name, contact_phone, status, review_note)
VALUES ('[D02-TEST] 外协单位', 'D02TEST000000000001', '测试联系人', '13900000007', 'active', 'D02-TEST')
ON CONFLICT (name, unified_code) DO UPDATE SET status = 'active', review_note = 'D02-TEST';

INSERT INTO public.safety_test_fixture_registry(run_key, table_name, record_id, fixture_role)
SELECT 'D02-TEST-20260903', 'contractor_companies', id, 'external_company'
FROM public.contractor_companies WHERE name = '[D02-TEST] 外协单位' AND unified_code = 'D02TEST000000000001'
ON CONFLICT DO NOTHING;

INSERT INTO public.site_project_members(project_id, employee_id, membership_type, work_type, status)
SELECT p.id, e.id, 'internal', e.position, 'active'
FROM public.site_projects p
JOIN public.training_employees e ON e.remark = 'D02-TEST'
WHERE (p.project_code = 'D02-NORMAL' AND e.employee_no IN ('D02-002', 'D02-003', 'D02-004', 'D02-008'))
   OR (p.project_code = 'D02-HIGH-RISK' AND e.employee_no IN ('D02-002', 'D02-003', 'D02-005', 'D02-006', 'D02-010'))
   OR (p.project_code IN ('D02-PAUSED', 'D02-REOPENED') AND e.employee_no IN ('D02-002', 'D02-004'))
ON CONFLICT (project_id, employee_id) DO UPDATE SET status = 'active', left_at = NULL, left_reason = NULL;

INSERT INTO public.site_project_members(project_id, employee_id, contractor_id, membership_type, work_type, status)
SELECT p.id, e.id, c.id, 'external', e.position, 'active'
FROM public.site_projects p
JOIN public.training_employees e ON e.employee_no = 'D02-007'
JOIN public.contractor_companies c ON c.name = '[D02-TEST] 外协单位' AND c.unified_code = 'D02TEST000000000001'
WHERE p.project_code = 'D02-NORMAL'
ON CONFLICT (project_id, employee_id) DO UPDATE SET contractor_id = EXCLUDED.contractor_id, membership_type = 'external', status = 'active';

INSERT INTO public.contractor_documents(contractor_id, employee_id, project_id, document_type, certificate_type, certificate_no, valid_from, valid_until, storage_path, review_status, review_note)
SELECT c.id, e.id, p.id, 'special_certificate', e.position, 'D02-CERT-' || e.employee_no,
       CURRENT_DATE - 30, CURRENT_DATE + 180,
       'd02-test/certificates/' || e.employee_no || '.pdf', 'approved', 'D02-TEST'
FROM public.training_employees e
JOIN public.site_projects p ON p.project_code = 'D02-HIGH-RISK'
LEFT JOIN public.contractor_companies c ON FALSE
WHERE e.employee_no IN ('D02-005', 'D02-006')
  AND NOT EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id AND d.certificate_no = 'D02-CERT-' || e.employee_no);

INSERT INTO storage.buckets (id, name, public)
VALUES ('training-courses', 'training-courses', FALSE), ('certificates', 'certificates', FALSE)
ON CONFLICT (id) DO UPDATE SET public = FALSE;

COMMIT;

-- Operator verification: all rows are anonymous test fixtures and both buckets are private.
SELECT p.project_code, p.status, COUNT(m.id)::INT AS member_count
FROM public.site_projects p LEFT JOIN public.site_project_members m ON m.project_id = p.id AND m.status = 'active'
WHERE p.project_code LIKE 'D02-%' GROUP BY p.project_code, p.status ORDER BY p.project_code;
SELECT id, public FROM storage.buckets WHERE id IN ('training-courses', 'certificates') ORDER BY id;

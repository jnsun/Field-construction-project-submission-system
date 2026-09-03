-- D02 test-only fixtures. Execute only against a dedicated test database.
BEGIN;
DO $$ BEGIN
  IF current_setting('app.safety_test_confirmation', true) <> 'D02_TEST_ONLY' THEN
    RAISE EXCEPTION 'Refusing to seed: set app.safety_test_confirmation to D02_TEST_ONLY for this session.';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.safety_test_fixture_registry (
  run_key TEXT NOT NULL, table_name TEXT NOT NULL, record_id UUID NOT NULL,
  fixture_role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_key, table_name, record_id)
);
ALTER TABLE public.safety_test_fixture_registry ENABLE ROW LEVEL SECURITY;
-- No application policies: database operator scripts only.
INSERT INTO public.departments(name, code, sort_order, dept_type)
SELECT v.name, v.code, v.sort_order, v.dept_type
FROM (VALUES
  ('[D02-TEST] 安全生产部','D02-SAFE',9901,'internal'),
  ('[D02-TEST] 经营实体甲','D02-ENT-A',9902,'entity'),
  ('[D02-TEST] 经营实体乙','D02-ENT-B',9903,'entity')
) AS v(name, code, sort_order, dept_type)
WHERE NOT EXISTS (SELECT 1 FROM public.departments d WHERE d.name = v.name);
INSERT INTO public.training_employees(name, employee_no, position, phone, emp_type, status, remark)
SELECT v.name, v.employee_no, v.position, v.phone, v.emp_type, v.status, v.remark
FROM (VALUES
  ('测试-安全管理员','D02-001','安全管理员','13900000001','manager','active','D02-TEST'),
  ('测试-项目经理','D02-002','项目经理','13900000002','manager','active','D02-TEST'),
  ('测试-安全员','D02-003','安全员','13900000003','manager','active','D02-TEST'),
  ('测试-普通员工','D02-004','野外作业员','13900000004','employee','active','D02-TEST'),
  ('测试-钻探人员','D02-005','钻探','13900000005','special','active','D02-TEST'),
  ('测试-电工','D02-006','电工','13900000006','special','active','D02-TEST'),
  ('测试-外协人员','D02-007','劳务人员','13900000007','employee','active','D02-TEST'),
  ('测试-领导访客','D02-008','公司领导','13900000008','manager','active','D02-TEST'),
  ('测试-无权限用户','D02-009','观察员','13900000009','employee','active','D02-TEST'),
  ('测试-证照过期','D02-010','焊工','13900000010','special','active','D02-TEST')
) AS v(name, employee_no, position, phone, emp_type, status, remark)
WHERE NOT EXISTS (SELECT 1 FROM public.training_employees e WHERE e.phone = v.phone);
INSERT INTO public.safety_test_fixture_registry(run_key,table_name,record_id,fixture_role)
SELECT 'D02-TEST-20260903','training_employees',id,remark FROM public.training_employees WHERE remark='D02-TEST'
ON CONFLICT DO NOTHING;
INSERT INTO public.safety_test_fixture_registry(run_key,table_name,record_id,fixture_role)
SELECT 'D02-TEST-20260903','departments',id,'D02-TEST'
FROM public.departments WHERE name LIKE '[D02-TEST]%'
ON CONFLICT DO NOTHING;
COMMIT;

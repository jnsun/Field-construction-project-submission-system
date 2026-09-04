-- D03 anonymous historical fixture for the v0 bootstrap schema.
-- It is deliberately limited to tables that exist before training-admission-v1.
BEGIN;

DO $$
BEGIN
  IF current_setting('app.safety_test_confirmation', true) <> 'D03_TEST_ONLY' THEN
    RAISE EXCEPTION 'Refusing D03 historical seed without D03_TEST_ONLY confirmation.';
  END IF;
END $$;

INSERT INTO public.departments(name, code, sort_order, dept_type)
VALUES
  ('[D03-HIST] 安全生产部', 'D03-HIST-SAFE', 9801, 'internal'),
  ('[D03-HIST] 经营实体', 'D03-HIST-ENTITY', 9802, 'entity')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.training_employees(name, employee_no, department_id, position, phone, emp_type, status, remark)
SELECT v.name, v.employee_no, d.id, v.position, v.phone, v.emp_type, 'active', 'D03-HISTORICAL'
FROM (VALUES
  ('D03 匿名员工甲', 'D03-HIST-001', 'D03-HIST-SAFE', '安全管理员', '13900000101', 'manager'),
  ('D03 匿名员工乙', 'D03-HIST-002', 'D03-HIST-ENTITY', '野外作业员', '13900000102', 'employee')
) AS v(name, employee_no, department_code, position, phone, emp_type)
JOIN public.departments d ON d.code = v.department_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.training_employees e WHERE e.employee_no = v.employee_no
);

INSERT INTO public.project_reports(
  department_id, project_name, project_type, construction_location, contract_amount,
  duration_months, department_entity, project_manager, contact_info, overall_progress,
  monthly_construction_status, equipment_models, on_site_personnel, on_site_vehicles,
  safety_inspection, safety_hazards, reporting_year, reporting_month
)
SELECT d.id, '[D03-HIST] 匿名野外项目', '野外勘查', 'D03 测试区域', 100.00,
       6, '[D03-HIST] 经营实体', 'D03 匿名项目负责人', '13900000101', '历史项目正常推进',
       'D03 匿名历史施工记录', 'D03 测试设备 1 台', 2, 1, TRUE, FALSE,
       EXTRACT(YEAR FROM CURRENT_DATE)::INT, EXTRACT(MONTH FROM CURRENT_DATE)::INT
FROM public.departments d
WHERE d.code = 'D03-HIST-ENTITY'
  AND NOT EXISTS (SELECT 1 FROM public.project_reports WHERE project_name = '[D03-HIST] 匿名野外项目');

INSERT INTO public.training_plans(title, category, level, department_id, plan_year, plan_month, hours, trainer, target_desc, content, status, remark)
SELECT '[D03-HIST] 历史安全教育', '入场三级教育', 'dept', d.id,
       EXTRACT(YEAR FROM CURRENT_DATE)::INT, EXTRACT(MONTH FROM CURRENT_DATE)::INT,
       4, 'D03 匿名讲师', '匿名历史员工', 'D03 匿名历史培训内容', 'done', 'D03-HISTORICAL'
FROM public.departments d
WHERE d.code = 'D03-HIST-ENTITY'
  AND NOT EXISTS (SELECT 1 FROM public.training_plans WHERE title = '[D03-HIST] 历史安全教育');

INSERT INTO public.training_records(plan_id, title, train_date, hours, trainer, location, department_id, content, participant_count, sign_method, remark)
SELECT p.id, '[D03-HIST] 历史安全教育记录', CURRENT_DATE - 30, 4,
       'D03 匿名讲师', 'D03 测试区域', p.department_id, 'D03 匿名历史培训内容', 1, 'manual', 'D03-HISTORICAL'
FROM public.training_plans p
WHERE p.title = '[D03-HIST] 历史安全教育'
  AND NOT EXISTS (SELECT 1 FROM public.training_records WHERE title = '[D03-HIST] 历史安全教育记录');

INSERT INTO public.training_participants(record_id, employee_id, employee_name, department_id, signed, score, result, remark)
SELECT r.id, e.id, e.name, e.department_id, TRUE, 90, 'pass', 'D03-HISTORICAL'
FROM public.training_records r
JOIN public.training_employees e ON e.employee_no = 'D03-HIST-002'
WHERE r.title = '[D03-HIST] 历史安全教育记录'
  AND NOT EXISTS (
    SELECT 1 FROM public.training_participants p WHERE p.record_id = r.id AND p.employee_id = e.id
  );

COMMIT;

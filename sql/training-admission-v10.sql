-- ============================================================================
-- 培训准入第十批：高风险岗位专项培训与专项考试
-- 前置：training-admission-v1.sql 至 training-admission-v9.sql 已执行。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.training_admission_special_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE CASCADE,
  position_keyword TEXT NOT NULL CHECK (position_keyword IN ('爆破', '钻探', '电工', '焊工')),
  plan_id UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(package_id, position_keyword)
);
ALTER TABLE public.training_admission_special_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_admission_special_rules_read ON public.training_admission_special_rules;
CREATE POLICY training_admission_special_rules_read ON public.training_admission_special_rules
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admission_packages p WHERE p.id = package_id
      AND ((p.project_id IS NULL AND public.training_is_company_admin())
        OR (p.project_id IS NOT NULL AND public.site_project_can_read(p.project_id)))
  ));

DROP FUNCTION IF EXISTS public.training_set_package_special_rules(UUID, JSONB);
CREATE FUNCTION public.training_set_package_special_rules(p_package_id UUID, p_rules JSONB)
RETURNS VOID AS $$
DECLARE v_package public.training_admission_packages; v_rule JSONB;
BEGIN
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id = p_package_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在'; END IF;
  IF v_package.status = 'published' THEN RAISE EXCEPTION '已发布培训包不可修改专项规则，请新建版本'; END IF;
  IF NOT ((v_package.project_id IS NULL AND public.training_is_company_admin())
          OR (v_package.project_id IS NOT NULL AND public.site_project_can_admin(v_package.project_id))) THEN
    RAISE EXCEPTION '您无权维护该培训包';
  END IF;
  DELETE FROM public.training_admission_special_rules WHERE package_id = p_package_id;
  FOR v_rule IN SELECT * FROM jsonb_array_elements(COALESCE(p_rules, '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.training_admission_package_items i
                   WHERE i.package_id = p_package_id AND i.plan_id = (v_rule->>'plan_id')::UUID AND i.level = 'special') THEN
      RAISE EXCEPTION '专项规则必须选择当前培训包内的专项培训计划';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.training_plans p WHERE p.id = (v_rule->>'plan_id')::UUID
                   AND COALESCE(p.exam_mode, 'none') <> 'none') THEN
      RAISE EXCEPTION '高风险专项培训计划必须启用考试';
    END IF;
    INSERT INTO public.training_admission_special_rules(package_id, position_keyword, plan_id)
    VALUES (p_package_id, v_rule->>'position_keyword', (v_rule->>'plan_id')::UUID);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_set_package_special_rules(UUID, JSONB) TO authenticated;

-- 发起准入时只下发与工种匹配的专项任务；高风险工种没有专项规则时直接拒绝。
DROP FUNCTION IF EXISTS public.training_start_admission(UUID, UUID, UUID);
CREATE FUNCTION public.training_start_admission(p_project_id UUID, p_employee_id UUID, p_package_id UUID)
RETURNS UUID AS $$
DECLARE v_admission UUID; v_member UUID; v_package public.training_admission_packages; v_position TEXT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权发起该项目入场培训'; END IF;
  SELECT id INTO v_member FROM public.site_project_members WHERE project_id = p_project_id AND employee_id = p_employee_id AND status = 'active';
  IF v_member IS NULL THEN RAISE EXCEPTION '该人员不是项目在场成员'; END IF;
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id = p_package_id AND status = 'published' AND (project_id IS NULL OR project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在、未发布或不适用于该项目'; END IF;
  SELECT position INTO v_position FROM public.training_employees WHERE id = p_employee_id;
  IF COALESCE(v_position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (
    SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = p_package_id AND v_position ILIKE '%' || r.position_keyword || '%'
  ) THEN RAISE EXCEPTION '高风险岗位必须配置匹配的专项培训与专项考试后才能发起准入'; END IF;
  IF EXISTS (SELECT 1 FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id = i.plan_id
             WHERE i.package_id = p_package_id AND COALESCE(p.publish_status, '') <> 'published') THEN
    RAISE EXCEPTION '培训包包含尚未发布的培训计划，请先发布计划后再发起准入';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r JOIN public.exam_papers ep ON ep.plan_id = r.plan_id AND ep.status = 'published'
                 WHERE r.package_id = p_package_id AND v_position ILIKE '%' || r.position_keyword || '%')
     AND EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = p_package_id AND v_position ILIKE '%' || r.position_keyword || '%') THEN
    RAISE EXCEPTION '高风险专项培训尚未发布专项考试试卷';
  END IF;
  INSERT INTO public.training_admissions(project_id, member_id, employee_id, package_id)
  VALUES (p_project_id, v_member, p_employee_id, p_package_id)
  ON CONFLICT (project_id, employee_id) DO UPDATE SET package_id = EXCLUDED.package_id, updated_at = NOW()
  RETURNING id INTO v_admission;
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT i.plan_id, e.id, pr.id, e.department_id FROM public.training_admission_package_items i
  CROSS JOIN public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id = e.id
  WHERE i.package_id = p_package_id AND i.required AND e.id = p_employee_id
    AND (i.level <> 'special' OR NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id AND e.position ILIKE '%' || r.position_keyword || '%'))
  ON CONFLICT (plan_id, employee_id) DO UPDATE SET user_id = EXCLUDED.user_id, department_id = EXCLUDED.department_id;
  INSERT INTO public.training_admission_tasks(admission_id, plan_id, level, assignment_id)
  SELECT v_admission, i.plan_id, i.level, a.id FROM public.training_admission_package_items i
  JOIN public.training_assignments a ON a.plan_id = i.plan_id AND a.employee_id = p_employee_id
  WHERE i.package_id = p_package_id AND i.required
    AND (i.level <> 'special' OR NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id AND v_position ILIKE '%' || r.position_keyword || '%'))
  ON CONFLICT (admission_id, plan_id) DO UPDATE SET assignment_id = EXCLUDED.assignment_id;
  RETURN v_admission;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_start_admission(UUID, UUID, UUID) TO authenticated;

-- 验证：SELECT to_regclass('public.training_admission_special_rules');

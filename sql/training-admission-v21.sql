-- ============================================================================
-- 培训准入第二十一批：停工超期复训与复工重新确认
-- 前置：training-admission-v1.sql 至 training-admission-v20.sql 已执行。
-- 历史培训任务、考试、签字和现场确认永久保留；复训只新增一个批次。
-- ============================================================================

ALTER TABLE public.training_admissions
  ADD COLUMN IF NOT EXISTS training_cycle_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS retrain_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS retrain_reason TEXT;
ALTER TABLE public.training_admission_tasks
  ADD COLUMN IF NOT EXISTS cycle_no INT NOT NULL DEFAULT 1;
ALTER TABLE public.training_admission_signatures
  ADD COLUMN IF NOT EXISTS cycle_no INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.training_admission_retraining_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  cycle_no INT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('pause_exceeded', 'material_course_update', 'manual')),
  reason TEXT NOT NULL,
  old_package_id UUID REFERENCES public.training_admission_packages(id) ON DELETE SET NULL,
  new_package_id UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(admission_id, cycle_no)
);
ALTER TABLE public.training_admission_retraining_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_admission_retraining_cycles_read ON public.training_admission_retraining_cycles;
CREATE POLICY training_admission_retraining_cycles_read ON public.training_admission_retraining_cycles
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admissions a WHERE a.id = admission_id
      AND (public.site_project_can_read(a.project_id) OR a.employee_id = public.training_my_employee_id())
  ));
GRANT SELECT ON public.training_admission_retraining_cycles TO authenticated;

-- 超过停工期限后，由项目管理人员选择已签发的新版本培训包，只补学项目级和匹配的专项内容。
DROP FUNCTION IF EXISTS public.training_start_pause_retraining(UUID, UUID, TEXT);
CREATE FUNCTION public.training_start_pause_retraining(
  p_admission_id UUID, p_package_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_a public.training_admissions; v_pkg public.training_admission_packages;
  v_position TEXT; v_cycle INT; v_old_package UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '准入记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id) THEN RAISE EXCEPTION '您无权发起该人员的复训'; END IF;
  IF NOT v_a.retrain_required THEN RAISE EXCEPTION '该人员当前不需要发起停工复训'; END IF;
  SELECT * INTO v_pkg FROM public.training_admission_packages
  WHERE id = p_package_id AND status = 'published' AND (project_id IS NULL OR project_id = v_a.project_id);
  IF NOT FOUND THEN RAISE EXCEPTION '复训培训包不存在、未发布或不适用于该项目'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_admission_package_items i
                 WHERE i.package_id = p_package_id AND i.required AND i.level IN ('project', 'special')) THEN
    RAISE EXCEPTION '复训培训包至少应包含一项项目级或专项培训计划';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.training_admission_package_items i
    JOIN public.training_admission_tasks t ON t.admission_id = v_a.id AND t.plan_id = i.plan_id
    WHERE i.package_id = p_package_id AND i.required AND i.level IN ('project', 'special')
  ) THEN RAISE EXCEPTION '复训培训包仍在使用旧计划。请先复制并发布新的项目级/专项培训计划，再替换到培训包新版本。'; END IF;
  SELECT position INTO v_position FROM public.training_employees WHERE id = v_a.employee_id;
  IF COALESCE(v_position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (
    SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = p_package_id
      AND v_position ILIKE '%' || r.position_keyword || '%'
  ) THEN RAISE EXCEPTION '高风险岗位复训必须配置匹配的专项培训与专项考试'; END IF;
  IF EXISTS (SELECT 1 FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id = i.plan_id
             WHERE i.package_id = p_package_id AND i.required AND i.level IN ('project', 'special')
               AND COALESCE(p.publish_status, '') <> 'published') THEN
    RAISE EXCEPTION '复训培训包包含尚未发布的培训计划';
  END IF;
  IF EXISTS (SELECT 1 FROM public.training_admission_special_rules r
             WHERE r.package_id = p_package_id AND v_position ILIKE '%' || r.position_keyword || '%')
     AND NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r JOIN public.exam_papers ep ON ep.plan_id = r.plan_id AND ep.status = 'published'
                     WHERE r.package_id = p_package_id AND v_position ILIKE '%' || r.position_keyword || '%') THEN
    RAISE EXCEPTION '高风险专项复训尚未发布专项考试试卷';
  END IF;

  v_cycle := v_a.training_cycle_no + 1; v_old_package := v_a.package_id;
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT i.plan_id, e.id, pr.id, e.department_id
  FROM public.training_admission_package_items i
  JOIN public.training_employees e ON e.id = v_a.employee_id
  LEFT JOIN public.profiles pr ON pr.employee_id = e.id
  WHERE i.package_id = p_package_id AND i.required AND i.level IN ('project', 'special')
    AND (i.level <> 'special' OR NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id AND e.position ILIKE '%' || r.position_keyword || '%'))
  ON CONFLICT (plan_id, employee_id) DO UPDATE SET user_id = EXCLUDED.user_id, department_id = EXCLUDED.department_id;
  INSERT INTO public.training_admission_tasks(admission_id, plan_id, level, assignment_id, cycle_no)
  SELECT v_a.id, i.plan_id, i.level, x.id, v_cycle
  FROM public.training_admission_package_items i
  JOIN public.training_assignments x ON x.plan_id = i.plan_id AND x.employee_id = v_a.employee_id
  WHERE i.package_id = p_package_id AND i.required AND i.level IN ('project', 'special')
    AND (i.level <> 'special' OR NOT EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.package_id = i.package_id AND r.plan_id = i.plan_id AND v_position ILIKE '%' || r.position_keyword || '%'));
  UPDATE public.training_admission_tasks t
  SET status = CASE WHEN a.status = 'completed' THEN 'completed' WHEN a.status = 'learning' OR COALESCE(a.progress, 0) > 0 THEN 'learning' ELSE 'pending' END,
      progress = LEAST(100, GREATEST(0, COALESCE(a.progress, 0))), effective_hours = COALESCE(a.hours_earned, 0),
      completed_at = CASE WHEN a.status = 'completed' THEN COALESCE(a.completed_at, NOW()) ELSE NULL END
  FROM public.training_assignments a
  WHERE t.admission_id = v_a.id AND t.cycle_no = v_cycle AND t.assignment_id = a.id;
  INSERT INTO public.training_admission_retraining_cycles(admission_id, cycle_no, trigger_type, reason, old_package_id, new_package_id, started_by)
  VALUES (v_a.id, v_cycle, 'pause_exceeded', COALESCE(NULLIF(btrim(p_reason), ''), v_a.retrain_reason, '项目停工超过设定期限，复工前需补学'), v_old_package, p_package_id, auth.uid());
  UPDATE public.training_admissions
  SET package_id = p_package_id, training_cycle_no = v_cycle, retrain_required = FALSE, retrain_reason = NULL,
      final_signed_at = NULL, site_confirmed_at = NULL, status = 'pending', blocked_reason = '已发起复训，完成补学、电子签字和现场确认前禁止上岗', updated_at = NOW()
  WHERE id = v_a.id;
  PERFORM public.training_recompute_admission(v_a.id);
  RETURN v_a.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_start_pause_retraining(UUID, UUID, TEXT) TO authenticated;

-- 将复训待办置于资格状态机最高优先级，防止旧凭证被误判为仍可上岗。
CREATE OR REPLACE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE v_a public.training_admissions; v_p public.site_projects; v_e public.training_employees;
  v_pkg public.training_admission_packages; v_total INT; v_done INT; v_has_cert BOOLEAN; v_final_signed BOOLEAN;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT (public.site_project_can_manage(v_a.project_id) OR v_a.employee_id = public.training_my_employee_id()) THEN RAISE EXCEPTION '您无权重新计算该人员的准入资格'; END IF;
  SELECT * INTO v_p FROM public.site_projects WHERE id = v_a.project_id;
  SELECT * INTO v_e FROM public.training_employees WHERE id = v_a.employee_id;
  SELECT * INTO v_pkg FROM public.training_admission_packages WHERE id = v_a.package_id;
  SELECT COUNT(*)::INT, COUNT(*) FILTER (WHERE status = 'completed')::INT INTO v_total, v_done FROM public.training_admission_tasks WHERE admission_id = p_admission_id;
  SELECT EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = v_a.project_id AND d.employee_id = v_a.employee_id
    AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) INTO v_has_cert;
  SELECT EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id
    AND s.task_id IS NULL AND s.signer_role = 'employee' AND s.cycle_no = v_a.training_cycle_no) INTO v_final_signed;
  UPDATE public.training_admissions SET
    status = CASE
      WHEN v_p.status = 'closed' THEN 'project_closed'
      WHEN v_p.status IN ('paused', 'pending_close') OR v_a.member_id IS NULL THEN 'blocked'
      WHEN v_a.retrain_required THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN 'blocked'
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN 'blocked'
      WHEN v_total = 0 OR v_done < v_total THEN CASE WHEN v_done > 0 THEN 'learning' ELSE 'pending' END
      WHEN v_a.exam_required AND NOT v_a.exam_passed THEN 'exam_pending'
      WHEN NOT v_final_signed THEN 'pending_sign'
      WHEN v_a.site_confirmed_at IS NULL THEN 'pending_site_confirm'
      ELSE 'eligible' END,
    blocked_reason = CASE
      WHEN v_p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
      WHEN v_p.status = 'closed' THEN '项目已关闭'
      WHEN v_a.retrain_required THEN COALESCE(v_a.retrain_reason, '停工超过设定期限，须完成复训后方可上岗')
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN '人员已离开项目'
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN '高风险岗位尚未审核通过特种作业证'
      ELSE NULL END,
    valid_until = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL AND v_pkg.id IS NOT NULL
      THEN (CURRENT_DATE + (v_pkg.validity_years::TEXT || ' years')::INTERVAL)::DATE ELSE valid_until END,
    eligible_from = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed) AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL
      THEN COALESCE(eligible_from, NOW()) ELSE eligible_from END, updated_at = NOW()
  WHERE id = p_admission_id RETURNING * INTO v_a;
  RETURN v_a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_recompute_admission(UUID) TO authenticated;

-- 新复训批次需重新完成完整电子签字；逐级历史签字仍随原任务永久留档。
CREATE OR REPLACE FUNCTION public.training_admission_sign(
  p_admission_id UUID, p_task_id UUID, p_signer_role TEXT, p_storage_path TEXT, p_record_hash TEXT, p_device_info TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE v_a public.training_admissions; v_project UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NULLIF(btrim(p_storage_path), '') IS NULL OR NULLIF(btrim(p_record_hash), '') IS NULL THEN RAISE EXCEPTION '签字图片和记录哈希不能为空'; END IF;
  v_project := v_a.project_id;
  IF p_signer_role = 'employee' THEN
    IF v_a.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '只能由本人签署员工记录'; END IF;
    IF p_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.id = p_task_id AND t.admission_id = p_admission_id AND t.status = 'completed') THEN RAISE EXCEPTION '该层级培训尚未完成，不能签字'; END IF;
    IF p_task_id IS NULL AND EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.admission_id = p_admission_id AND (t.status <> 'completed' OR NOT EXISTS (
      SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id AND s.task_id = t.id AND s.signer_role = 'employee'))) THEN RAISE EXCEPTION '请先完成全部培训并逐级签字，再签署完整准入记录'; END IF;
  ELSIF p_signer_role = 'company_safety_head' THEN
    IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司级管理员可以签署公司级记录'; END IF;
  ELSIF p_signer_role = 'entity_head' THEN
    IF NOT public.site_project_can_admin(v_project) THEN RAISE EXCEPTION '只有主责经营实体管理员可以签署'; END IF;
  ELSIF p_signer_role IN ('project_manager', 'safety_officer') THEN
    IF NOT EXISTS (SELECT 1 FROM public.site_project_roles r WHERE r.project_id = v_project AND r.user_id = auth.uid() AND r.active AND r.role = p_signer_role) THEN RAISE EXCEPTION '当前账号不是该项目的指定签署人'; END IF;
  ELSE RAISE EXCEPTION '不支持的签署角色'; END IF;
  IF p_task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.id = p_task_id AND t.admission_id = p_admission_id) THEN RAISE EXCEPTION '签署的培训层级不属于该入场记录'; END IF;
  IF p_task_id IS NULL AND p_signer_role = 'employee' AND EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee' AND s.cycle_no = v_a.training_cycle_no) THEN RAISE EXCEPTION '本复训批次的完整准入记录已经签署'; END IF;
  INSERT INTO public.training_admission_signatures(admission_id, task_id, signer_role, signer_user_id, storage_path, record_hash, device_info, cycle_no)
  VALUES (p_admission_id, p_task_id, p_signer_role, auth.uid(), p_storage_path, p_record_hash, p_device_info, v_a.training_cycle_no)
  ON CONFLICT (admission_id, task_id, signer_role) DO NOTHING;
  IF p_task_id IS NOT NULL THEN UPDATE public.training_admission_tasks SET signed_at = NOW() WHERE id = p_task_id;
  ELSE UPDATE public.training_admissions SET final_signed_at = NOW(), updated_at = NOW() WHERE id = p_admission_id; END IF;
  PERFORM public.training_recompute_admission(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_sign(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 复工时：无论停工时长都需重新现场确认；超过培训包期限则自动锁定并要求复训。
DROP FUNCTION IF EXISTS public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT);
CREATE FUNCTION public.site_project_update(
  p_project_id UUID, p_name TEXT, p_project_type TEXT, p_location TEXT, p_status TEXT,
  p_start_date DATE, p_expected_end_date DATE, p_actual_end_date DATE, p_lead_entity_id UUID, p_reason TEXT DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE v_old public.site_projects; v_new public.site_projects; v_admission UUID;
BEGIN
  SELECT * INTO v_old FROM public.site_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权维护该正式项目'; END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN RAISE EXCEPTION '您无权把主责经营实体变更为该单位'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN RAISE EXCEPTION '主责单位必须是经营实体'; END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN RAISE EXCEPTION '预计完工日期不能早于开工日期'; END IF;
  IF p_status IN ('paused', 'closed', 'pending_close') AND NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION '暂停、待关闭或关闭必须填写原因'; END IF;
  IF v_old.status = 'closed' AND p_status <> 'closed' AND NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION '项目重新开启必须填写原因'; END IF;
  UPDATE public.site_projects SET name = btrim(p_name), project_type = NULLIF(btrim(p_project_type), ''), location = NULLIF(btrim(p_location), ''), status = p_status,
    start_date = p_start_date, expected_end_date = p_expected_end_date, actual_end_date = p_actual_end_date, lead_entity_id = p_lead_entity_id,
    pause_started_at = CASE WHEN p_status = 'paused' THEN COALESCE(v_old.pause_started_at, NOW()) ELSE NULL END,
    pause_reason = CASE WHEN p_status = 'paused' THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
    closed_at = CASE WHEN p_status = 'closed' THEN COALESCE(v_old.closed_at, NOW()) ELSE NULL END,
    closed_by = CASE WHEN p_status = 'closed' THEN auth.uid() ELSE NULL END,
    close_reason = CASE WHEN p_status IN ('closed', 'pending_close') THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
    report_notes = COALESCE(NULLIF(btrim(p_reason), ''), v_old.report_notes)
  WHERE id = p_project_id RETURNING * INTO v_new;
  IF v_new.lead_entity_id <> v_old.lead_entity_id THEN
    UPDATE public.site_project_entities SET is_lead = FALSE WHERE project_id = p_project_id;
    INSERT INTO public.site_project_entities(project_id, entity_id, is_lead) VALUES (p_project_id, v_new.lead_entity_id, TRUE) ON CONFLICT (project_id, entity_id) DO UPDATE SET is_lead = TRUE;
  END IF;
  IF v_old.status IN ('paused', 'pending_close', 'closed') AND v_new.status = 'active' THEN
    UPDATE public.training_admissions a SET site_confirmed_at = NULL,
      retrain_required = CASE WHEN v_old.pause_started_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = a.package_id
        AND EXTRACT(EPOCH FROM (NOW() - v_old.pause_started_at)) / 86400 >= p.pause_retrain_days) THEN TRUE ELSE a.retrain_required END,
      retrain_reason = CASE WHEN v_old.pause_started_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = a.package_id
        AND EXTRACT(EPOCH FROM (NOW() - v_old.pause_started_at)) / 86400 >= p.pause_retrain_days)
        THEN '项目停工已超过培训包设定期限，须完成项目级/专项复训并重新现场确认' ELSE a.retrain_reason END,
      updated_at = NOW() WHERE a.project_id = p_project_id;
    FOR v_admission IN SELECT id FROM public.training_admissions WHERE project_id = p_project_id LOOP PERFORM public.training_recompute_admission(v_admission); END LOOP;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT) TO authenticated;

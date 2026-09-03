-- ============================================================================
-- 培训准入第四十一批：现场角色移动端管理闭环
-- 前置：training-admission-v1.sql 至 v40.sql 已执行。
-- 项目审核通过外协入场申请时，仅将待审核外协单位置为有效；
-- 项目合同、单位资质和高风险人员特种作业证仍须单独人工审核。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.site_project_review_application(
  p_application_id UUID, p_action TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_app public.project_join_applications;
  v_project public.site_projects;
  v_employee UUID;
  v_member UUID;
  v_cross_project BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_app FROM public.project_join_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场申请不存在'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_app.project_id;
  IF NOT FOUND OR v_project.status <> 'active' THEN RAISE EXCEPTION '项目未处于在建状态，不能审核入场'; END IF;
  IF p_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION '审核动作仅支持 approve 或 reject'; END IF;
  IF p_action = 'reject' AND NULLIF(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION '驳回申请必须填写原因'; END IF;

  IF v_app.status = 'pending_project_review' THEN
    IF NOT public.site_project_can_manage(v_app.project_id) THEN RAISE EXCEPTION '您无权进行项目审核'; END IF;
    IF p_action = 'reject' THEN
      UPDATE public.project_join_applications
      SET status = 'rejected', review_note = btrim(p_note), project_reviewed_by = auth.uid(), project_reviewed_at = NOW(), updated_at = NOW()
      WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'rejected', 'stage', 'project');
    END IF;
    IF v_app.contractor_id IS NULL THEN RAISE EXCEPTION '外协人员必须先填写并关联外协单位'; END IF;

    SELECT id INTO v_employee FROM public.training_employees
    WHERE name = v_app.name AND phone = v_app.phone ORDER BY created_at LIMIT 1;
    IF v_employee IS NULL THEN
      INSERT INTO public.training_employees(name, phone, position, department_id, emp_type, status, remark, created_by)
      VALUES (v_app.name, v_app.phone, v_app.position, v_project.lead_entity_id, 'employee', 'active', '外协人员（项目邀请码申请）', auth.uid())
      RETURNING id INTO v_employee;
    END IF;
    UPDATE public.project_join_applications
    SET employee_id = v_employee, project_reviewed_by = auth.uid(), project_reviewed_at = NOW(),
        review_note = NULLIF(btrim(p_note), ''), updated_at = NOW()
    WHERE id = v_app.id;

    SELECT EXISTS (
      SELECT 1 FROM public.site_project_members m
      WHERE m.employee_id = v_employee AND m.project_id <> v_app.project_id AND m.status = 'active'
    ) INTO v_cross_project;
    IF v_cross_project THEN
      UPDATE public.project_join_applications SET status = 'pending_entity_review', updated_at = NOW() WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'pending_entity_review', 'stage', 'entity', 'employee_id', v_employee);
    END IF;
  ELSIF v_app.status = 'pending_entity_review' THEN
    IF NOT public.site_project_can_admin(v_app.project_id) THEN RAISE EXCEPTION '仅主责经营实体管理员或公司管理员可以进行跨项目复核'; END IF;
    IF p_action = 'reject' THEN
      UPDATE public.project_join_applications
      SET status = 'rejected', review_note = btrim(p_note), entity_reviewed_by = auth.uid(), entity_reviewed_at = NOW(), updated_at = NOW()
      WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'rejected', 'stage', 'entity');
    END IF;
    v_employee := v_app.employee_id;
    IF v_employee IS NULL THEN RAISE EXCEPTION '申请缺少人员档案，请退回后重新发起'; END IF;
    UPDATE public.project_join_applications
    SET entity_reviewed_by = auth.uid(), entity_reviewed_at = NOW(), review_note = NULLIF(btrim(p_note), ''), updated_at = NOW()
    WHERE id = v_app.id;
  ELSE
    RAISE EXCEPTION '当前申请状态不允许审核';
  END IF;

  -- 项目审核只激活本次确认过的待审核单位；已驳回或已停用单位不会被自动恢复。
  UPDATE public.contractor_companies
  SET status = 'active', reviewed_by = auth.uid(), reviewed_at = NOW(), review_note = '项目入场审核通过', updated_at = NOW()
  WHERE id = v_app.contractor_id AND status = 'pending';

  INSERT INTO public.site_project_members(project_id, employee_id, contractor_id, application_id, membership_type, work_type, status, created_by)
  VALUES (v_app.project_id, v_employee, v_app.contractor_id, v_app.id, 'external', v_app.position, 'active', auth.uid())
  ON CONFLICT (project_id, employee_id) DO UPDATE
    SET contractor_id = EXCLUDED.contractor_id, application_id = EXCLUDED.application_id,
        membership_type = 'external', work_type = EXCLUDED.work_type, status = 'active', left_at = NULL, left_reason = NULL
  RETURNING id INTO v_member;
  UPDATE public.project_join_applications SET status = 'approved', updated_at = NOW() WHERE id = v_app.id;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_app.project_id, auth.uid(), 'approve', 'project_join_application', v_app.id,
          jsonb_build_object('employee_id', v_employee, 'member_id', v_member, 'contractor_id', v_app.contractor_id));
  RETURN jsonb_build_object('status', 'approved', 'employee_id', v_employee, 'member_id', v_member);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.site_project_review_application(UUID, TEXT, TEXT) TO authenticated;

-- 培训入场准入 v2：项目角色与外协申请审核闭环。
-- 前提：已成功执行 sql/training-admission-v1.sql、personnel-center-v1.sql。

-- 人员登录绑定以 profiles.employee_id 为准，修正旧培训脚本对 employee.user_id 的依赖。
CREATE OR REPLACE FUNCTION public.training_my_employee_id()
RETURNS UUID AS $$
  SELECT employee_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.site_project_can_read(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR EXISTS (
        SELECT 1 FROM public.site_projects p
        WHERE p.id = p_project_id AND public.training_can_read(p.lead_entity_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_entities pe
        WHERE pe.project_id = p_project_id AND public.training_can_read(pe.entity_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_roles r
        WHERE r.project_id = p_project_id AND r.user_id = auth.uid() AND r.active
      )
      OR EXISTS (
        SELECT 1
        FROM public.site_project_members m
        JOIN public.profiles pr ON pr.employee_id = m.employee_id
        WHERE m.project_id = p_project_id AND m.status = 'active' AND pr.id = auth.uid()
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 经营实体管理员指定项目经理（最多 2 人）和任意数量安全员，统一替换项目当前角色。
DROP FUNCTION IF EXISTS public.site_project_set_roles(UUID, JSONB);
CREATE FUNCTION public.site_project_set_roles(p_project_id UUID, p_roles JSONB)
RETURNS VOID AS $$
DECLARE v_roles JSONB := COALESCE(p_roles, '[]'::JSONB);
BEGIN
  IF NOT public.site_project_can_admin(p_project_id) THEN
    RAISE EXCEPTION '仅主责经营实体管理员或公司管理员可以任命项目角色';
  END IF;
  IF jsonb_typeof(v_roles) <> 'array' THEN
    RAISE EXCEPTION '项目角色参数格式不正确';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_roles) r
    WHERE COALESCE(r->>'role', '') NOT IN ('project_manager', 'safety_officer')
       OR NULLIF(r->>'user_id', '') IS NULL
  ) THEN
    RAISE EXCEPTION '项目角色仅支持项目经理和安全员，且必须指定账号';
  END IF;
  IF (SELECT COUNT(DISTINCT r->>'user_id')
      FROM jsonb_array_elements(v_roles) r WHERE r->>'role' = 'project_manager') > 2 THEN
    RAISE EXCEPTION '每个项目最多指定 2 名项目经理';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = (r->>'user_id')::UUID)
  ) THEN
    RAISE EXCEPTION '指定的项目角色账号不存在或不可见';
  END IF;

  DELETE FROM public.site_project_roles WHERE project_id = p_project_id;
  INSERT INTO public.site_project_roles(project_id, user_id, role, active, assigned_by)
  SELECT p_project_id, (r->>'user_id')::UUID, r->>'role', TRUE, auth.uid()
  FROM (SELECT DISTINCT value AS r FROM jsonb_array_elements(v_roles)) x;

  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, detail)
  VALUES (p_project_id, auth.uid(), 'set_roles', 'site_project_roles', jsonb_build_object('roles', v_roles));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_set_roles(UUID, JSONB) TO authenticated;

-- 外协申请审核：首次项目申请由项目端审核；已有其他项目在场记录时转经营实体复核。
DROP FUNCTION IF EXISTS public.site_project_review_application(UUID, TEXT, TEXT);
CREATE FUNCTION public.site_project_review_application(
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
  IF p_action = 'reject' AND NULLIF(btrim(p_note), '') IS NULL THEN
    RAISE EXCEPTION '驳回申请必须填写原因';
  END IF;

  IF v_app.status = 'pending_project_review' THEN
    IF NOT public.site_project_can_manage(v_app.project_id) THEN
      RAISE EXCEPTION '您无权进行项目审核';
    END IF;
    IF p_action = 'reject' THEN
      UPDATE public.project_join_applications
      SET status = 'rejected', review_note = btrim(p_note), project_reviewed_by = auth.uid(),
          project_reviewed_at = NOW(), updated_at = NOW()
      WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'rejected', 'stage', 'project');
    END IF;
    IF v_app.contractor_id IS NULL THEN
      RAISE EXCEPTION '外协人员必须先填写并关联外协单位';
    END IF;

    SELECT id INTO v_employee
    FROM public.training_employees
    WHERE name = v_app.name AND phone = v_app.phone
    ORDER BY created_at LIMIT 1;
    IF v_employee IS NULL THEN
      INSERT INTO public.training_employees(name, phone, position, department_id, emp_type, status, remark, created_by)
      VALUES (v_app.name, v_app.phone, v_app.position, v_project.lead_entity_id, 'employee', 'active',
              '外协人员（项目邀请码申请）', auth.uid())
      RETURNING id INTO v_employee;
    END IF;
    UPDATE public.project_join_applications SET employee_id = v_employee, project_reviewed_by = auth.uid(),
      project_reviewed_at = NOW(), review_note = NULLIF(btrim(p_note), ''), updated_at = NOW()
    WHERE id = v_app.id;

    SELECT EXISTS (
      SELECT 1 FROM public.site_project_members m
      WHERE m.employee_id = v_employee AND m.project_id <> v_app.project_id AND m.status = 'active'
    ) INTO v_cross_project;
    IF v_cross_project THEN
      UPDATE public.project_join_applications SET status = 'pending_entity_review', updated_at = NOW()
      WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'pending_entity_review', 'stage', 'entity', 'employee_id', v_employee);
    END IF;
  ELSIF v_app.status = 'pending_entity_review' THEN
    IF NOT public.site_project_can_admin(v_app.project_id) THEN
      RAISE EXCEPTION '仅主责经营实体管理员或公司管理员可以进行跨项目复核';
    END IF;
    IF p_action = 'reject' THEN
      UPDATE public.project_join_applications
      SET status = 'rejected', review_note = btrim(p_note), entity_reviewed_by = auth.uid(),
          entity_reviewed_at = NOW(), updated_at = NOW()
      WHERE id = v_app.id;
      RETURN jsonb_build_object('status', 'rejected', 'stage', 'entity');
    END IF;
    v_employee := v_app.employee_id;
    IF v_employee IS NULL THEN RAISE EXCEPTION '申请缺少人员档案，请退回后重新发起'; END IF;
    UPDATE public.project_join_applications
    SET entity_reviewed_by = auth.uid(), entity_reviewed_at = NOW(),
        review_note = NULLIF(btrim(p_note), ''), updated_at = NOW()
    WHERE id = v_app.id;
  ELSE
    RAISE EXCEPTION '当前申请状态不允许审核';
  END IF;

  INSERT INTO public.site_project_members(project_id, employee_id, contractor_id, application_id,
                                           membership_type, work_type, status, created_by)
  VALUES (v_app.project_id, v_employee, v_app.contractor_id, v_app.id, 'external', v_app.position, 'active', auth.uid())
  ON CONFLICT (project_id, employee_id) DO UPDATE
    SET contractor_id = EXCLUDED.contractor_id, application_id = EXCLUDED.application_id,
        membership_type = 'external', work_type = EXCLUDED.work_type, status = 'active',
        left_at = NULL, left_reason = NULL
  RETURNING id INTO v_member;
  UPDATE public.project_join_applications SET status = 'approved', updated_at = NOW() WHERE id = v_app.id;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_app.project_id, auth.uid(), 'approve', 'project_join_application', v_app.id,
          jsonb_build_object('employee_id', v_employee, 'member_id', v_member));
  RETURN jsonb_build_object('status', 'approved', 'employee_id', v_employee, 'member_id', v_member);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_review_application(UUID, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 培训准入第三十一批：入场培训截止时间与当天加急
-- 前置：training-admission-v1.sql 至 training-admission-v30.sql 已执行。
-- 规则：普通准入默认下发后 3 天完成；可标记“到场当天加急”。
--       无论是否逾期，未完成准入均保持禁止入场、禁止上岗。
-- ============================================================================

ALTER TABLE public.training_admissions
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_training_admissions_due
  ON public.training_admissions(project_id, due_at)
  WHERE due_at IS NOT NULL AND status <> 'eligible';

DROP FUNCTION IF EXISTS public.training_start_admission(UUID, UUID, UUID);
CREATE FUNCTION public.training_start_admission(
  p_project_id UUID, p_employee_id UUID, p_package_id UUID,
  p_due_at TIMESTAMPTZ DEFAULT NULL, p_urgent BOOLEAN DEFAULT FALSE
)
RETURNS UUID AS $$
DECLARE v_admission UUID; v_member UUID; v_package public.training_admission_packages; v_due_at TIMESTAMPTZ;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权发起该项目入场培训'; END IF;
  v_due_at := COALESCE(p_due_at, date_trunc('day', NOW()) + INTERVAL '3 days 18 hours');
  IF v_due_at <= NOW() THEN RAISE EXCEPTION '完成截止时间必须晚于当前时间'; END IF;
  IF p_urgent AND v_due_at > date_trunc('day', NOW()) + INTERVAL '1 day' THEN RAISE EXCEPTION '当天加急的截止时间不能晚于明天零点'; END IF;
  SELECT id INTO v_member FROM public.site_project_members WHERE project_id = p_project_id AND employee_id = p_employee_id AND status = 'active';
  IF v_member IS NULL THEN RAISE EXCEPTION '该人员不是项目在场成员'; END IF;
  SELECT * INTO v_package FROM public.training_admission_packages WHERE id = p_package_id AND status = 'published' AND (project_id IS NULL OR project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在、未发布或不适用于该项目'; END IF;
  IF EXISTS (SELECT 1 FROM public.training_admission_package_items i JOIN public.training_plans p ON p.id = i.plan_id WHERE i.package_id = p_package_id AND COALESCE(p.publish_status, '') <> 'published') THEN
    RAISE EXCEPTION '培训包包含尚未发布的培训计划，请先发布计划后再发起准入';
  END IF;
  INSERT INTO public.training_admissions(project_id, member_id, employee_id, package_id, due_at, urgent)
  VALUES (p_project_id, v_member, p_employee_id, p_package_id, v_due_at, COALESCE(p_urgent, FALSE))
  ON CONFLICT (project_id, employee_id) DO UPDATE
    SET package_id = EXCLUDED.package_id, due_at = EXCLUDED.due_at, urgent = EXCLUDED.urgent, updated_at = NOW()
  RETURNING id INTO v_admission;
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT i.plan_id, e.id, pr.id, e.department_id FROM public.training_admission_package_items i
  CROSS JOIN public.training_employees e LEFT JOIN public.profiles pr ON pr.employee_id = e.id
  WHERE i.package_id = p_package_id AND i.required AND e.id = p_employee_id
  ON CONFLICT (plan_id, employee_id) DO UPDATE SET user_id = EXCLUDED.user_id, department_id = EXCLUDED.department_id;
  INSERT INTO public.training_admission_tasks(admission_id, plan_id, level, assignment_id)
  SELECT v_admission, i.plan_id, i.level, a.id FROM public.training_admission_package_items i
  JOIN public.training_assignments a ON a.plan_id = i.plan_id AND a.employee_id = p_employee_id
  WHERE i.package_id = p_package_id AND i.required
  ON CONFLICT (admission_id, plan_id) DO UPDATE SET assignment_id = EXCLUDED.assignment_id;
  RETURN v_admission;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_start_admission_batch(UUID, UUID[], UUID);
CREATE FUNCTION public.training_start_admission_batch(
  p_project_id UUID, p_employee_ids UUID[], p_package_id UUID,
  p_due_at TIMESTAMPTZ DEFAULT NULL, p_urgent BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (employee_id UUID, admission_id UUID, result_code TEXT, result_message TEXT) AS $$
DECLARE v_employee UUID; v_admission UUID;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权为该项目批量发起准入培训'; END IF;
  IF COALESCE(array_length(p_employee_ids, 1), 0) = 0 THEN RAISE EXCEPTION '请至少选择一名人员'; END IF;
  IF array_length(p_employee_ids, 1) > 300 THEN RAISE EXCEPTION '单次最多处理 300 人，请分批发起'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.id = p_package_id AND p.status = 'published' AND (p.project_id IS NULL OR p.project_id = p_project_id)) THEN RAISE EXCEPTION '培训包不存在、未签发或不适用于该项目'; END IF;
  FOREACH v_employee IN ARRAY p_employee_ids LOOP
    employee_id := v_employee; admission_id := NULL; result_code := NULL; result_message := NULL;
    IF EXISTS (SELECT 1 FROM public.training_admissions a WHERE a.project_id = p_project_id AND a.employee_id = v_employee) THEN result_code := 'skipped'; result_message := '已有准入记录，未重复下发'; RETURN NEXT; CONTINUE; END IF;
    BEGIN
      v_admission := public.training_start_admission(p_project_id, v_employee, p_package_id, p_due_at, p_urgent);
      PERFORM public.training_send_admission_start_notice(v_admission);
      admission_id := v_admission; result_code := 'started'; result_message := '已下发培训任务和系统内提醒'; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN result_code := 'failed'; result_message := SQLERRM; RETURN NEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_send_admission_start_notice(p_admission_id UUID)
RETURNS VOID AS $$
DECLARE v_a public.training_admissions%ROWTYPE; v_deadline TEXT;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '准入记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id) THEN RAISE EXCEPTION '您无权发送该准入任务提醒'; END IF;
  v_deadline := CASE WHEN v_a.due_at IS NULL THEN '' ELSE ' 请于 ' || to_char(v_a.due_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || ' 前完成。' END;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by, event_key)
  VALUES (v_a.project_id, v_a.id, v_a.employee_id,
    CASE WHEN v_a.urgent THEN '您有一项到场当天加急的项目三级安全教育任务。' ELSE '已为您下发项目三级安全教育任务。' END || v_deadline || '完成学习、考试、电子签字和现场确认前，禁止入场、禁止上岗。',
    auth.uid(), 'start:' || v_a.id::TEXT)
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO UPDATE SET message = EXCLUDED.message, created_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_generate_due_reminders(p_project_id UUID)
RETURNS INT AS $$
DECLARE v_days INT; v_count INT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权生成该项目提醒'; END IF;
  SELECT due_soon_days INTO v_days FROM public.training_admission_notification_settings WHERE id = TRUE;
  INSERT INTO public.training_admission_reminders(project_id, admission_id, employee_id, message, created_by, event_key)
  SELECT a.project_id, a.id, a.employee_id,
    CASE WHEN a.due_at < NOW() THEN '您的项目准入培训已逾期，请立即完成。未完成前禁止入场、禁止上岗。'
         WHEN a.urgent THEN '您的项目准入培训为当天加急任务，请于 ' || to_char(a.due_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || ' 前完成。未完成前禁止入场、禁止上岗。'
         ELSE '您的项目准入培训即将于 ' || to_char(a.due_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') || ' 截止，请尽快完成。' END,
    auth.uid(), CASE WHEN a.due_at < NOW() THEN 'admission-overdue:' || a.id::TEXT || ':' || CURRENT_DATE::TEXT ELSE 'admission-due:' || a.id::TEXT || ':' || a.due_at::DATE::TEXT END
  FROM public.training_admissions a
  WHERE a.project_id = p_project_id AND a.status <> 'eligible' AND a.due_at IS NOT NULL
    AND (a.due_at < NOW() OR a.urgent OR a.due_at <= NOW() + make_interval(days => v_days))
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 员工手机端同时看到自己任务的明确截止时间；资格判定沿用原有项目、证照和凭证规则。
DROP FUNCTION IF EXISTS public.training_my_admission_status();
CREATE FUNCTION public.training_my_admission_status()
RETURNS TABLE (
  admission_id UUID, project_id UUID, project_code TEXT, project_name TEXT,
  project_location TEXT, project_status TEXT, work_position TEXT, status TEXT,
  blocked_reason TEXT, valid_until DATE, certificate_no TEXT, task_total INT,
  task_done INT, site_confirmed_at TIMESTAMPTZ, due_at TIMESTAMPTZ, urgent BOOLEAN
) AS $$
  SELECT a.id, p.id, p.project_code, p.name, p.location, p.status, e.position,
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN 'blocked'
           WHEN p.status = 'closed' THEN 'project_closed'
           WHEN (COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (
             SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id
               AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
               AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
           )) THEN 'blocked'
           WHEN EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id
             AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND d.valid_until IS NOT NULL AND d.valid_until < CURRENT_DATE) THEN 'blocked'
           WHEN a.status = 'eligible' AND (a.valid_until IS NULL OR a.valid_until >= CURRENT_DATE) THEN 'eligible'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired'
           ELSE a.status
         END,
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
           WHEN p.status = 'closed' THEN '项目已关闭'
           WHEN (COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (
             SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id
               AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
               AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
           )) THEN '高风险岗位尚未审核通过特种作业证'
           WHEN EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p.id AND d.employee_id = e.id
             AND d.document_type = 'special_certificate' AND d.review_status = 'approved' AND d.valid_until IS NOT NULL AND d.valid_until < CURRENT_DATE) THEN '特种作业证已过期'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期'
           ELSE a.blocked_reason
         END,
         a.valid_until, c.certificate_no, COALESCE(t.task_total, 0), COALESCE(t.task_done, 0),
         a.site_confirmed_at, a.due_at, a.urgent
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.training_eligibility_certificates c ON c.admission_id = a.id AND c.status = 'valid'
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INT AS task_total, COUNT(*) FILTER (WHERE x.status = 'completed')::INT AS task_done
    FROM public.training_admission_tasks x WHERE x.admission_id = a.id
  ) t ON TRUE
  WHERE a.employee_id = public.training_my_employee_id()
  ORDER BY p.status = 'active' DESC, p.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_start_admission(UUID, UUID, UUID, TIMESTAMPTZ, BOOLEAN),
  public.training_start_admission_batch(UUID, UUID[], UUID, TIMESTAMPTZ, BOOLEAN),
  public.training_send_admission_start_notice(UUID), public.training_generate_due_reminders(UUID),
  public.training_my_admission_status() TO authenticated;

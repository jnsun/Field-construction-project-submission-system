-- ============================================================================
-- 培训准入第三十八批：单人准入条件清单
-- 前置：training-admission-v1.sql 至 v37.sql 已执行。
-- 只读汇总，不修改任何培训、外协或资格数据。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_admission_readiness_checklist(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  condition_code TEXT, condition_name TEXT, condition_status TEXT,
  detail TEXT, next_action TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权查看该项目准入清单'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id AND m.status = 'active') THEN RAISE EXCEPTION '该人员不是项目在场成员'; END IF;

  RETURN QUERY
  WITH d AS (
    SELECT m.id AS member_id, m.membership_type, m.contractor_id, COALESCE(m.work_type, e.position, '') AS work_position,
      a.id AS admission_id, a.status AS admission_status, a.blocked_reason, a.exam_required, a.exam_passed,
      a.final_signed_at, a.site_confirmed_at, a.valid_until,
      COALESCE(t.total, 0) AS task_total, COALESCE(t.done, 0) AS task_done,
      public.training_external_compliance_reason(p_project_id, p_employee_id, m.id) AS external_reason
    FROM public.site_project_members m
    JOIN public.training_employees e ON e.id = m.employee_id
    LEFT JOIN LATERAL (
      SELECT x.* FROM public.training_admissions x WHERE x.project_id = m.project_id AND x.employee_id = m.employee_id ORDER BY x.created_at DESC LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::INT AS total, COUNT(*) FILTER (WHERE x.status = 'completed')::INT AS done
      FROM public.training_admission_tasks x WHERE x.admission_id = a.id
    ) t ON TRUE
    WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id AND m.status = 'active'
  )
  SELECT 'personnel_review', '人员关键资料复核',
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN 'pending' ELSE 'passed' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN '身份证号、照片、岗位或所属单位等资料已变更' ELSE '当前无待复核的关键资料变更' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN '在“入场审核”完成资料复核' ELSE '无需处理' END
  UNION ALL SELECT 'training', '必修培训完成',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.task_total > 0 AND d.task_done = d.task_total THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '尚未发起项目准入培训' ELSE format('已完成 %s / %s 项必修培训', d.task_done, d.task_total) END,
      CASE WHEN d.admission_id IS NULL THEN '在“准入执行”下发培训包' WHEN d.task_done < d.task_total THEN '催办员工完成剩余课件' ELSE '无需处理' END
  FROM d
  UNION ALL SELECT 'exam', '综合准入考试',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN NOT d.exam_required OR d.exam_passed THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后生成考试' WHEN NOT d.exam_required THEN '本培训包未要求综合考试' WHEN d.exam_passed THEN '考试已通过' ELSE '待参加或通过补考' END,
      CASE WHEN d.admission_id IS NULL OR NOT d.exam_required OR d.exam_passed THEN '无需处理' ELSE '催办员工参加考试' END
  FROM d
  UNION ALL SELECT 'signature', '员工完整电子签字',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.final_signed_at IS NOT NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后签署' WHEN d.final_signed_at IS NOT NULL THEN '已完成电子签字' ELSE '待员工手写电子签字' END,
      CASE WHEN d.admission_id IS NULL OR d.final_signed_at IS NOT NULL THEN '无需处理' ELSE '催办员工完成全部层级签字' END
  FROM d
  UNION ALL SELECT 'site_confirm', '项目现场确认',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.site_confirmed_at IS NOT NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后确认' WHEN d.site_confirmed_at IS NOT NULL THEN '项目负责人或安全员已现场确认' ELSE '待项目负责人或安全员现场确认' END,
      CASE WHEN d.admission_id IS NULL OR d.site_confirmed_at IS NOT NULL THEN '无需处理' ELSE '上传现场照片并完成确认' END
  FROM d
  UNION ALL SELECT 'contractor_company', '外协单位审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN '外协单位已审核有效' ELSE '外协单位尚未审核通过或已停用' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN '无需处理' ELSE '在“外协与入场”审核外协单位' END
  FROM d
  UNION ALL SELECT 'contract', '项目合同审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN '项目合同已审核有效' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND c.end_date < CURRENT_DATE) THEN '项目合同已到期' ELSE '项目合同尚未审核通过' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN '无需处理' ELSE '在“外协与入场”登记并审核项目合同' END
  FROM d
  UNION ALL SELECT 'qualification', '外协单位资质审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN '单位资质已审核有效' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND x.valid_until < CURRENT_DATE) THEN '单位资质已过期' ELSE '单位资质尚未审核通过' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN '无需处理' ELSE '在“外协与入场”登记并审核单位资质' END
  FROM d
  UNION ALL SELECT 'special_certificate', '高风险岗位特种作业证',
      CASE WHEN d.membership_type <> 'external' OR d.work_position !~ '(爆破|钻探|电工|焊工)' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.employee_id = p_employee_id AND x.document_type = 'special_certificate' AND x.review_status = 'approved' AND x.valid_until >= CURRENT_DATE) THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' OR d.work_position !~ '(爆破|钻探|电工|焊工)' THEN '当前岗位不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.employee_id = p_employee_id AND x.document_type = 'special_certificate' AND x.review_status = 'approved' AND x.valid_until >= CURRENT_DATE) THEN '本人特种作业证已审核有效' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.employee_id = p_employee_id AND x.document_type = 'special_certificate' AND x.review_status = 'approved' AND x.valid_until < CURRENT_DATE) THEN '本人特种作业证已过期' ELSE '本人特种作业证尚未审核通过' END,
      CASE WHEN d.membership_type <> 'external' OR d.work_position !~ '(爆破|钻探|电工|焊工)' OR EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.employee_id = p_employee_id AND x.document_type = 'special_certificate' AND x.review_status = 'approved' AND x.valid_until >= CURRENT_DATE) THEN '无需处理' ELSE '补充并审核本人特种作业证' END
  FROM d
  UNION ALL SELECT 'result', '当前上岗结论',
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN '当前满足上岗条件' ELSE COALESCE(d.external_reason, d.blocked_reason, '尚未满足全部准入条件') END,
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN '无需处理' ELSE '按以上待处理项逐项完成' END
  FROM d;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_admission_readiness_checklist(UUID, UUID) TO authenticated;

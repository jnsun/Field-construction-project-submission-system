-- ============================================================================
-- 培训准入第三十九批：单人准入流转档案
-- 前置：training-admission-v1.sql 至 v38.sql 已执行。
-- 只读汇总既有业务记录，不新增日志、不改变准入资格。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_admission_timeline(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  occurred_at TIMESTAMPTZ, event_code TEXT, event_name TEXT, detail TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN
    RAISE EXCEPTION '您无权查看该项目人员的准入流转档案';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
  ) THEN
    RAISE EXCEPTION '该人员未加入本项目';
  END IF;

  RETURN QUERY
  WITH admissions AS (
    SELECT a.*
    FROM public.training_admissions a
    WHERE a.project_id = p_project_id AND a.employee_id = p_employee_id
  )
  SELECT * FROM (
  SELECT a.created_at, 'admission_started', '发起项目准入',
         '培训包：' || COALESCE(p.title, '未命名培训包') || '；当前状态：' || a.status
  FROM admissions a
  LEFT JOIN public.training_admission_packages p ON p.id = a.package_id

  UNION ALL
  SELECT t.completed_at, 'training_completed', '完成培训学习',
         CASE t.level WHEN 'company' THEN '公司级' WHEN 'entity' THEN '经营实体级'
                      WHEN 'project' THEN '项目级' WHEN 'special' THEN '专项培训' ELSE t.level END
         || '：' || COALESCE(pl.title, '未命名培训计划')
  FROM public.training_admission_tasks t
  JOIN admissions a ON a.id = t.admission_id
  LEFT JOIN public.training_plans pl ON pl.id = t.plan_id
  WHERE t.status = 'completed' AND t.completed_at IS NOT NULL

  UNION ALL
  SELECT s.signed_at, 'signature', '电子签字',
         CASE s.signer_role WHEN 'employee' THEN '员工本人'
                            WHEN 'company_safety_head' THEN '安全生产部部长'
                            WHEN 'entity_head' THEN '经营实体负责人'
                            WHEN 'project_manager' THEN '项目经理'
                            WHEN 'safety_officer' THEN '安全员' ELSE s.signer_role END
         || CASE WHEN s.task_id IS NULL THEN '：完整准入记录' ELSE '：培训层级记录' END
  FROM public.training_admission_signatures s
  JOIN admissions a ON a.id = s.admission_id

  UNION ALL
  SELECT x.confirmed_at, 'site_confirmed', '项目现场确认',
         CASE WHEN x.location_enabled THEN '已上传现场照片并记录定位' ELSE '已上传现场照片' END
         || COALESCE('；备注：' || NULLIF(btrim(x.note), ''), '')
  FROM public.training_site_confirmations x
  JOIN admissions a ON a.id = x.admission_id

  UNION ALL
  SELECT q.updated_at, 'exam_result', '综合准入考试结果',
         CASE WHEN q.exam_status = 'passed' THEN '考试通过' ELSE '尚未通过' END
         || COALESCE('；成绩：' || q.exam_score::TEXT || ' 分', '')
         || '；已考试 ' || COALESCE(q.exam_attempts, 0)::TEXT || ' 次'
  FROM public.training_assignments q
  JOIN admissions a ON a.exam_assignment_id = q.id
  WHERE q.exam_status <> 'none'

  UNION ALL
  SELECT c.issued_at, 'certificate_issued', '签发电子记录凭证',
         '凭证编号：' || c.certificate_no || '；有效至：' || c.valid_until::TEXT
  FROM public.training_eligibility_certificates c
  JOIN admissions a ON a.id = c.admission_id

  UNION ALL
  SELECT x.starts_at, 'temporary_access_granted', '授予临时通行',
         '通行编号：' || COALESCE(x.pass_code, '未编号') || '；截止：' || x.expires_at::TEXT || '；原因：' || x.reason
  FROM public.training_temporary_access x
  JOIN admissions a ON a.id = x.admission_id

  UNION ALL
  SELECT x.revoked_at, 'temporary_access_revoked', '撤销临时通行',
         '通行编号：' || COALESCE(x.pass_code, '未编号')
  FROM public.training_temporary_access x
  JOIN admissions a ON a.id = x.admission_id
  WHERE x.revoked_at IS NOT NULL

  UNION ALL
  SELECT r.requested_at, 'personnel_reapproval_requested', '人员关键资料待复核',
         '变更项：' || array_to_string(r.changed_fields, '、')
  FROM public.training_personnel_reapproval_requests r
  WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id

  UNION ALL
  SELECT r.reviewed_at, 'personnel_reapproval_reviewed', '人员资料复核完成',
         CASE r.status WHEN 'approved' THEN '已通过' WHEN 'rejected' THEN '已驳回' ELSE r.status END
         || COALESCE('；说明：' || NULLIF(btrim(r.review_note), ''), '')
  FROM public.training_personnel_reapproval_requests r
  WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.reviewed_at IS NOT NULL

  UNION ALL
  SELECT a.updated_at, 'current_status', '当前准入状态',
         CASE a.status WHEN 'eligible' THEN '可上岗' WHEN 'blocked' THEN '禁止上岗'
                       WHEN 'expired' THEN '已失效' WHEN 'project_closed' THEN '项目已关闭'
                       ELSE '待完成：' || a.status END
         || COALESCE('；原因：' || NULLIF(btrim(a.blocked_reason), ''), '')
  FROM admissions a
  ) AS events
  ORDER BY occurred_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_admission_timeline(UUID, UUID) TO authenticated;

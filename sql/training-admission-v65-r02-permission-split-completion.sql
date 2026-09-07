-- D07 R02：完成公司级只读与项目日常管理权限分离。
-- 写操作继续按具体项目使用 site_project_can_manage()；三个查询 RPC 使用独立读取判断。

-- 证书桶的管理员兜底只授予公司级管理员；经营实体管理员读取项目文件时
-- 必须继续经过各 training-admission 路径的 project_id 策略。
DROP POLICY IF EXISTS "cert_storage_read_admin" ON storage.objects;
CREATE POLICY "cert_storage_read_admin" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'certificates' AND public.training_is_company_admin());

CREATE OR REPLACE FUNCTION public.training_refresh_external_admissions(
  p_project_id UUID DEFAULT NULL,
  p_contractor_id UUID DEFAULT NULL
) RETURNS INT AS $$
DECLARE v_admission UUID; v_count INT := 0;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION '刷新外协资格必须指定项目';
  END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN
    RAISE EXCEPTION '您无权刷新该项目外协资格';
  END IF;
  FOR v_admission IN
    SELECT a.id FROM public.training_admissions a
    JOIN public.site_project_members m ON m.id = a.member_id
    WHERE m.membership_type = 'external'
      AND a.project_id = p_project_id
      AND (p_contractor_id IS NULL OR m.contractor_id = p_contractor_id)
  LOOP
    PERFORM public.training_recompute_admission(v_admission);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_refresh_external_admissions(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_refresh_external_admissions(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_admission_readiness_checklist(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  condition_code TEXT, condition_name TEXT, condition_status TEXT,
  detail TEXT, next_action TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN RAISE EXCEPTION '您无权查看该项目准入清单'; END IF;
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

CREATE OR REPLACE FUNCTION public.training_admission_timeline(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  occurred_at TIMESTAMPTZ, event_code TEXT, event_name TEXT, detail TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN
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

CREATE OR REPLACE FUNCTION public.training_admission_evidence(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  evidence_type TEXT, evidence_name TEXT, occurred_at TIMESTAMPTZ, storage_path TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN
    RAISE EXCEPTION '您无权查看该项目人员的准入电子证据';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
  ) THEN
    RAISE EXCEPTION '该人员未加入本项目';
  END IF;

  RETURN QUERY
  SELECT 'signature',
         CASE s.signer_role WHEN 'employee' THEN '员工电子签字'
                            WHEN 'company_safety_head' THEN '安全生产部部长签字'
                            WHEN 'entity_head' THEN '经营实体负责人签字'
                            WHEN 'project_manager' THEN '项目经理签字'
                            WHEN 'safety_officer' THEN '安全员签字' ELSE '电子签字' END,
         s.signed_at, s.storage_path
  FROM public.training_admission_signatures s
  JOIN public.training_admissions a ON a.id = s.admission_id
  WHERE a.project_id = p_project_id AND a.employee_id = p_employee_id

  UNION ALL
  SELECT 'site_confirmation', '现场确认照片', x.confirmed_at, x.photo_path
  FROM public.training_site_confirmations x
  JOIN public.training_admissions a ON a.id = x.admission_id
  WHERE a.project_id = p_project_id AND a.employee_id = p_employee_id
  ORDER BY occurred_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION
  public.training_admission_readiness_checklist(UUID, UUID),
  public.training_admission_timeline(UUID, UUID),
  public.training_admission_evidence(UUID, UUID)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.training_admission_readiness_checklist(UUID, UUID),
  public.training_admission_timeline(UUID, UUID),
  public.training_admission_evidence(UUID, UUID)
TO authenticated;

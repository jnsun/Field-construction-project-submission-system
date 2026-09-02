-- ============================================================================
-- 培训准入第三批：学习状态联动与受控凭证核验
-- 前置：已成功执行 training-admission-v1.sql、training-admission-v2.sql
-- 本脚本不会读取或暴露身份证、手机号、合同、证照附件等敏感资料。
-- ============================================================================

-- 通用培训任务完成后，同步回写对应项目准入任务，并重新计算上岗资格。
-- 这样员工无需让管理员手工“刷新资格”，完成学习后状态会自动推进。
DROP TRIGGER IF EXISTS trg_training_assignment_sync_admission ON public.training_assignments;
DROP FUNCTION IF EXISTS public.training_sync_admission_assignment();
CREATE FUNCTION public.training_sync_admission_assignment()
RETURNS TRIGGER AS $$
DECLARE
  v_admission_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.progress IS NOT DISTINCT FROM OLD.progress
     AND NEW.hours_earned IS NOT DISTINCT FROM OLD.hours_earned THEN
    RETURN NEW;
  END IF;

  FOR v_admission_id IN
    SELECT admission_id
    FROM public.training_admission_tasks
    WHERE assignment_id = NEW.id
  LOOP
    UPDATE public.training_admission_tasks
    SET status = CASE
          WHEN NEW.status = 'completed' THEN 'completed'
          WHEN NEW.status = 'learning' OR COALESCE(NEW.progress, 0) > 0 THEN 'learning'
          ELSE 'pending'
        END,
        progress = LEAST(100, GREATEST(0, COALESCE(NEW.progress, 0))),
        effective_hours = COALESCE(NEW.hours_earned, effective_hours),
        completed_at = CASE WHEN NEW.status = 'completed' THEN COALESCE(completed_at, NEW.completed_at, NOW()) ELSE completed_at END
    WHERE admission_id = v_admission_id AND assignment_id = NEW.id;

    -- training_recompute_admission() 会按当前登录人验证权限；触发器在员工本人
    -- 学习时由本人调用，在管理员补录时由项目管理人调用，均符合既有权限规则。
    PERFORM public.training_recompute_admission(v_admission_id);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_training_assignment_sync_admission
  AFTER UPDATE OF status, progress, hours_earned ON public.training_assignments
  FOR EACH ROW EXECUTE FUNCTION public.training_sync_admission_assignment();

-- 项目经理、安全员、经营实体或公司管理员使用。返回字段严格限制为现场核验所需内容。
DROP FUNCTION IF EXISTS public.training_verify_certificate(TEXT);
CREATE FUNCTION public.training_verify_certificate(p_certificate_no TEXT)
RETURNS TABLE (
  certificate_no TEXT,
  employee_name TEXT,
  photo_path TEXT,
  work_position TEXT,
  project_code TEXT,
  project_name TEXT,
  admission_status TEXT,
  valid_until DATE,
  blocked_reason TEXT
) AS $$
BEGIN
  IF NULLIF(btrim(p_certificate_no), '') IS NULL THEN
    RAISE EXCEPTION '请输入凭证编号';
  END IF;

  RETURN QUERY
  SELECT c.certificate_no,
         e.name,
         e.photo_path,
         e.position,
         p.project_code,
         p.name,
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN 'blocked'
           WHEN p.status = 'closed' THEN 'project_closed'
           WHEN COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)'
             AND NOT EXISTS (
               SELECT 1 FROM public.contractor_documents d
               WHERE d.project_id = p.id AND d.employee_id = e.id
                 AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
                 AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
             ) THEN 'blocked'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired'
           WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN 'expired'
           ELSE a.status
         END,
         LEAST(COALESCE(a.valid_until, c.valid_until), c.valid_until),
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
           WHEN p.status = 'closed' THEN '项目已关闭'
           WHEN COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)'
             AND NOT EXISTS (
               SELECT 1 FROM public.contractor_documents d
               WHERE d.project_id = p.id AND d.employee_id = e.id
                 AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
                 AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
             ) THEN '高风险岗位尚未审核通过特种作业证'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期'
           WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN '电子记录凭证已失效'
           ELSE a.blocked_reason
         END
  FROM public.training_eligibility_certificates c
  JOIN public.training_admissions a ON a.id = c.admission_id
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  WHERE upper(c.certificate_no) = upper(btrim(p_certificate_no))
    AND public.site_project_can_manage(p.id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_verify_certificate(TEXT) TO authenticated;

-- 员工仅能查看自己的凭证摘要，用于手机端展示；不返回身份证、联系方式或附件。
DROP FUNCTION IF EXISTS public.training_my_certificate(UUID);
CREATE FUNCTION public.training_my_certificate(p_admission_id UUID)
RETURNS TABLE (
  certificate_no TEXT,
  employee_name TEXT,
  photo_path TEXT,
  work_position TEXT,
  project_code TEXT,
  project_name TEXT,
  admission_status TEXT,
  valid_until DATE,
  blocked_reason TEXT
) AS $$
  SELECT c.certificate_no, e.name, e.photo_path, e.position, p.project_code, p.name,
         CASE WHEN p.status IN ('paused', 'pending_close') THEN 'blocked'
              WHEN p.status = 'closed' THEN 'project_closed'
              WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired'
              WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN 'expired'
              ELSE a.status END,
         LEAST(COALESCE(a.valid_until, c.valid_until), c.valid_until),
         CASE WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
              WHEN p.status = 'closed' THEN '项目已关闭'
              WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期'
              WHEN c.status <> 'valid' OR c.valid_until < CURRENT_DATE THEN '电子记录凭证已失效'
              ELSE a.blocked_reason END
  FROM public.training_eligibility_certificates c
  JOIN public.training_admissions a ON a.id = c.admission_id
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  WHERE a.id = p_admission_id
    AND a.employee_id = public.training_my_employee_id()
    AND c.status = 'valid'
  ORDER BY c.issued_at DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_my_certificate(UUID) TO authenticated;

-- 执行后可用以下查询确认：
-- SELECT tgname FROM pg_trigger WHERE tgname = 'trg_training_assignment_sync_admission';
-- SELECT proname FROM pg_proc WHERE proname IN ('training_verify_certificate', 'training_my_certificate');

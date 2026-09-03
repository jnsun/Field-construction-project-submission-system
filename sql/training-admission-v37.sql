-- ============================================================================
-- 培训准入第三十七批：人员关键资料变更复核
-- 前置：training-management.sql、personnel-center-v1.sql、training-admission-v1.sql 至 v36.sql 已执行。
-- 复核表只记录变更字段，不复制身份证号、照片路径等敏感原值或新值。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.training_personnel_reapproval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  changed_fields TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_personnel_reapproval_pending
  ON public.training_personnel_reapproval_requests(project_id, employee_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_training_personnel_reapproval_project
  ON public.training_personnel_reapproval_requests(project_id, status, requested_at DESC);

ALTER TABLE public.training_personnel_reapproval_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_personnel_reapproval_read ON public.training_personnel_reapproval_requests;
CREATE POLICY training_personnel_reapproval_read ON public.training_personnel_reapproval_requests
  FOR SELECT TO authenticated USING (public.site_project_can_manage(project_id));

-- 将某项目人员的关键资料变更合并为一条待复核记录，并立即阻断其现有准入。
CREATE OR REPLACE FUNCTION public.training_request_personnel_reapproval(
  p_project_id UUID, p_employee_id UUID, p_fields TEXT[]
) RETURNS VOID AS $$
BEGIN
  IF COALESCE(array_length(p_fields, 1), 0) = 0 THEN RETURN; END IF;
  INSERT INTO public.training_personnel_reapproval_requests(project_id, employee_id, changed_fields, requested_by)
  VALUES (p_project_id, p_employee_id, p_fields, auth.uid())
  ON CONFLICT (project_id, employee_id) WHERE status = 'pending' DO UPDATE
  SET changed_fields = ARRAY(
        SELECT DISTINCT field_name FROM unnest(public.training_personnel_reapproval_requests.changed_fields || EXCLUDED.changed_fields) AS fields(field_name)
      ), requested_by = auth.uid(), requested_at = NOW(), review_note = NULL;
  UPDATE public.training_admissions
  SET status = 'blocked', blocked_reason = '人员关键资料已变更，待项目复核后方可上岗', updated_at = NOW()
  WHERE project_id = p_project_id AND employee_id = p_employee_id AND status <> 'project_closed';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_employee_reapproval_guard()
RETURNS TRIGGER AS $$
DECLARE v_fields TEXT[] := ARRAY[]::TEXT[]; v_project UUID;
BEGIN
  IF NEW.id_number IS DISTINCT FROM OLD.id_number THEN v_fields := array_append(v_fields, '身份证号'); END IF;
  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path THEN v_fields := array_append(v_fields, '人员照片'); END IF;
  IF NEW.position IS DISTINCT FROM OLD.position THEN v_fields := array_append(v_fields, '岗位/工种'); END IF;
  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN v_fields := array_append(v_fields, '所属部门'); END IF;
  IF array_length(v_fields, 1) IS NULL THEN RETURN NEW; END IF;
  FOR v_project IN SELECT project_id FROM public.site_project_members WHERE employee_id = NEW.id AND status = 'active' LOOP
    PERFORM public.training_request_personnel_reapproval(v_project, NEW.id, v_fields);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_employee_reapproval_guard ON public.training_employees;
CREATE TRIGGER trg_training_employee_reapproval_guard
  AFTER UPDATE OF id_number, photo_path, position, department_id ON public.training_employees
  FOR EACH ROW EXECUTE FUNCTION public.training_employee_reapproval_guard();

CREATE OR REPLACE FUNCTION public.training_project_member_reapproval_guard()
RETURNS TRIGGER AS $$
DECLARE v_fields TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NEW.membership_type <> 'external' THEN RETURN NEW; END IF;
  IF NEW.contractor_id IS DISTINCT FROM OLD.contractor_id THEN v_fields := array_append(v_fields, '所属外协单位'); END IF;
  IF NEW.work_type IS DISTINCT FROM OLD.work_type THEN v_fields := array_append(v_fields, '项目工种'); END IF;
  IF array_length(v_fields, 1) IS NOT NULL THEN
    PERFORM public.training_request_personnel_reapproval(NEW.project_id, NEW.employee_id, v_fields);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_project_member_reapproval_guard ON public.site_project_members;
CREATE TRIGGER trg_training_project_member_reapproval_guard
  AFTER UPDATE OF contractor_id, work_type ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.training_project_member_reapproval_guard();

-- 已审核通过的特种作业证若被替换文件、编号、类别或有效期，自动退回待审核。
CREATE OR REPLACE FUNCTION public.training_special_certificate_reapproval_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.document_type = 'special_certificate' AND OLD.review_status = 'approved'
    AND (NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.certificate_type IS DISTINCT FROM OLD.certificate_type
      OR NEW.certificate_no IS DISTINCT FROM OLD.certificate_no OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_until IS DISTINCT FROM OLD.valid_until) THEN
    NEW.review_status := 'pending'; NEW.reviewed_by := NULL; NEW.reviewed_at := NULL;
    NEW.review_note := '特种作业证资料已变更，需重新审核';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_special_certificate_reapproval_guard ON public.contractor_documents;
CREATE TRIGGER trg_training_special_certificate_reapproval_guard
  BEFORE UPDATE OF storage_path, certificate_type, certificate_no, valid_from, valid_until ON public.contractor_documents
  FOR EACH ROW EXECUTE FUNCTION public.training_special_certificate_reapproval_guard();

CREATE OR REPLACE FUNCTION public.training_review_personnel_reapproval(
  p_request_id UUID, p_action TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE v_request public.training_personnel_reapproval_requests; v_admission UUID;
BEGIN
  SELECT * INTO v_request FROM public.training_personnel_reapproval_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'pending' THEN RAISE EXCEPTION '待复核记录不存在或已处理'; END IF;
  IF NOT public.site_project_can_manage(v_request.project_id) THEN RAISE EXCEPTION '您无权复核该项目人员资料'; END IF;
  IF p_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION '复核动作不正确'; END IF;
  IF p_action = 'reject' AND NULLIF(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION '驳回时必须填写原因'; END IF;
  UPDATE public.training_personnel_reapproval_requests
  SET status = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
      reviewed_by = auth.uid(), reviewed_at = NOW(), review_note = NULLIF(btrim(p_note), '')
  WHERE id = v_request.id;
  IF p_action = 'approve' THEN
    FOR v_admission IN SELECT id FROM public.training_admissions WHERE project_id = v_request.project_id AND employee_id = v_request.employee_id LOOP
      PERFORM public.training_recompute_admission(v_admission);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT SELECT ON public.training_personnel_reapproval_requests TO authenticated;
GRANT EXECUTE ON FUNCTION public.training_review_personnel_reapproval(UUID, TEXT, TEXT) TO authenticated;

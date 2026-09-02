-- ============================================================================
-- 培训准入第十三批：课件版本审核、签发与批量签发
-- 前置：training-admission-v1.sql 至 training-admission-v12.sql 已执行。
-- ============================================================================

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (approval_status IN ('draft', 'pending_review', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS approval_note TEXT,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- 已在使用的历史计划视为已完成当时签发，避免升级后误阻断既有培训。
UPDATE public.training_plans SET approval_status = 'approved'
WHERE publish_status = 'published' AND approval_status = 'draft';

CREATE OR REPLACE FUNCTION public.training_plan_can_approve(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id = p_plan_id AND (
      (p.level = 'company' AND public.training_is_company_admin())
      OR (p.level <> 'company' AND public.training_can_write(p.department_id))
      OR EXISTS (
        SELECT 1 FROM public.training_admission_package_items i
        JOIN public.training_admission_packages ap ON ap.id = i.package_id
        WHERE i.plan_id = p.id AND ap.project_id IS NOT NULL
          AND public.site_project_can_manage(ap.project_id)
      )
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_request_plan_approval(p_plan_id UUID)
RETURNS VOID AS $$
DECLARE v_plan public.training_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM public.training_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v_plan.publish_status = 'published' THEN RAISE EXCEPTION '已发布版本不可再次送审，请新建版本'; END IF;
  IF NOT ((v_plan.level = 'company' AND public.training_is_company_admin()) OR public.training_can_write(v_plan.department_id)) THEN
    RAISE EXCEPTION '您无权送审该培训计划';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_courses WHERE plan_id = p_plan_id) THEN
    RAISE EXCEPTION '请至少添加一份课件后再送审';
  END IF;
  UPDATE public.training_plans
  SET approval_status = 'pending_review', submitted_at = NOW(), submitted_by = auth.uid(),
      approved_at = NULL, approved_by = NULL, approval_note = NULL
  WHERE id = p_plan_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_approve_plan(p_plan_id UUID, p_approved BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE v_plan public.training_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM public.training_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v_plan.approval_status <> 'pending_review' THEN RAISE EXCEPTION '只有待审核的计划可以签发或驳回'; END IF;
  IF NOT public.training_plan_can_approve(p_plan_id) THEN RAISE EXCEPTION '您无权签发该层级培训计划'; END IF;
  IF NOT p_approved AND NULLIF(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION '驳回时必须填写修改意见'; END IF;
  UPDATE public.training_plans
  SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
      approval_note = NULLIF(btrim(p_note), ''), approved_at = CASE WHEN p_approved THEN NOW() ELSE NULL END,
      approved_by = CASE WHEN p_approved THEN auth.uid() ELSE NULL END
  WHERE id = p_plan_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_batch_approve_plans(p_plan_ids UUID[])
RETURNS INT AS $$
DECLARE v_id UUID; v_count INT := 0;
BEGIN
  FOREACH v_id IN ARRAY COALESCE(p_plan_ids, ARRAY[]::UUID[]) LOOP
    IF EXISTS (SELECT 1 FROM public.training_plans WHERE id = v_id AND approval_status = 'pending_review')
       AND public.training_plan_can_approve(v_id) THEN
      UPDATE public.training_plans SET approval_status = 'approved', approval_note = '批量签发',
        approved_at = NOW(), approved_by = auth.uid() WHERE id = v_id;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 已签发或已发布版本的课件不得直接改动；修改必须形成新的待审核版本。
CREATE OR REPLACE FUNCTION public.training_course_version_guard()
RETURNS TRIGGER AS $$
DECLARE v_plan_id UUID; v_status TEXT; v_publish TEXT;
BEGIN
  v_plan_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_id ELSE NEW.plan_id END;
  SELECT approval_status, publish_status INTO v_status, v_publish FROM public.training_plans WHERE id = v_plan_id;
  IF v_publish = 'published' THEN RAISE EXCEPTION '已发布课件不可修改，请新建培训计划版本'; END IF;
  IF v_status = 'pending_review' OR v_status = 'approved' THEN RAISE EXCEPTION '计划正在审核或已签发，请退回草稿后修改课件'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_training_course_version_guard ON public.training_courses;
CREATE TRIGGER trg_training_course_version_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.training_courses
  FOR EACH ROW EXECUTE FUNCTION public.training_course_version_guard();

-- 发布必须在签发后进行；复用原下发逻辑。
CREATE OR REPLACE FUNCTION public.training_publish_plan(p_plan_id UUID)
RETURNS JSONB AS $$
DECLARE v_plan public.training_plans%ROWTYPE; v_count INT := 0; v_record_id UUID;
BEGIN
  SELECT * INTO v_plan FROM public.training_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF NOT ((v_plan.level = 'company' AND public.training_is_company_admin()) OR public.training_can_write(v_plan.department_id)) THEN
    RAISE EXCEPTION '无权限发布该计划';
  END IF;
  IF v_plan.approval_status <> 'approved' THEN RAISE EXCEPTION '培训计划须经签发后才能发布'; END IF;
  IF v_plan.publish_status = 'published' THEN RAISE EXCEPTION '该计划已发布'; END IF;
  WITH RECURSIVE scope_seed AS (SELECT department_id AS id FROM public.training_plan_targets WHERE plan_id = p_plan_id UNION ALL SELECT d.id FROM public.departments d JOIN scope_seed ON d.parent_id = scope_seed.id),
  own_seed AS (SELECT v_plan.department_id AS id WHERE v_plan.department_id IS NOT NULL UNION ALL SELECT d.id FROM public.departments d JOIN own_seed ON d.parent_id = own_seed.id),
  covered AS (SELECT id FROM scope_seed UNION SELECT id FROM own_seed WHERE NOT EXISTS (SELECT 1 FROM scope_seed))
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT p_plan_id, e.id, e.user_id, e.department_id FROM public.training_employees e
  WHERE e.status = 'active' AND ((v_plan.level = 'company' AND NOT EXISTS (SELECT 1 FROM public.training_plan_targets WHERE plan_id = p_plan_id)) OR e.department_id IN (SELECT id FROM covered WHERE id IS NOT NULL))
  ON CONFLICT (plan_id, employee_id) DO NOTHING;
  SELECT COUNT(*) INTO v_count FROM public.training_assignments WHERE plan_id = p_plan_id;
  INSERT INTO public.training_records(plan_id, title, train_date, hours, trainer, location, department_id, content, source)
  SELECT p.id, p.title, COALESCE(p.start_date, CURRENT_DATE), p.required_hours, p.trainer, p.location, p.department_id, p.content, 'auto' FROM public.training_plans p
  WHERE p.id = p_plan_id AND NOT EXISTS (SELECT 1 FROM public.training_records r WHERE r.plan_id = p.id AND r.source = 'auto') RETURNING id INTO v_record_id;
  UPDATE public.training_plans SET publish_status = 'published', published_at = NOW(), published_by = auth.uid() WHERE id = p_plan_id;
  RETURN jsonb_build_object('success', true, 'assigned', v_count, 'record_id', v_record_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_request_plan_approval(UUID), public.training_approve_plan(UUID, BOOLEAN, TEXT), public.training_batch_approve_plans(UUID[]), public.training_publish_plan(UUID) TO authenticated;

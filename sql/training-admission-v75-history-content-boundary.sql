-- D09-1：培训计划、课件、资源文件历史不可变与内容读取安全边界。
BEGIN;

-- Web 管理端直接使用三张业务表；表级入口恢复后仍由 RLS 和下方历史 guard 限制。
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.training_plans,
  public.training_courses,
  public.training_library
TO authenticated;

-- training_plans 的既有 SELECT policy 依赖此只读范围函数。
GRANT EXECUTE ON FUNCTION public.training_shared_plan_ids() TO authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_has_history(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.training_assignments a WHERE a.plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.training_records r WHERE r.plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_tasks t WHERE t.plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_package_items i WHERE i.plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_special_rules r WHERE r.plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.training_admission_packages p WHERE p.exam_plan_id = p_plan_id)
      OR EXISTS (SELECT 1 FROM public.exam_papers p WHERE p.plan_id = p_plan_id)
      OR EXISTS (
        SELECT 1 FROM public.training_study_logs l
        JOIN public.training_courses c ON c.id = l.course_id
        WHERE c.plan_id = p_plan_id
      )
      OR EXISTS (
        SELECT 1 FROM public.training_course_progress cp
        JOIN public.training_courses c ON c.id = cp.course_id
        WHERE c.plan_id = p_plan_id
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_plan_is_locked(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id = p_plan_id
      AND (
        p.approval_status IN ('pending_review', 'approved')
        OR p.publish_status = 'published'
        OR public.training_plan_has_history(p.id)
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_plan_has_history(UUID), public.training_plan_is_locked(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.training_plan_is_locked(OLD.id) THEN
      RAISE EXCEPTION '已送审、签发、发布或形成培训历史的计划不可删除，请新建版本';
    END IF;
    RETURN OLD;
  END IF;

  IF current_setting('app.training_lifecycle_write', TRUE) = 'D09_CONTROLLED' THEN
    RETURN NEW;
  END IF;

  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status
     OR NEW.approval_note IS DISTINCT FROM OLD.approval_note
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.publish_status IS DISTINCT FROM OLD.publish_status
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
    RAISE EXCEPTION '审批和发布字段只能通过受控流程修改';
  END IF;

  IF public.training_plan_is_locked(OLD.id) THEN
    RAISE EXCEPTION '已送审、签发、发布或形成培训历史的计划不可直接修改，请新建版本';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_plan_history_guard ON public.training_plans;
CREATE TRIGGER trg_training_plan_history_guard
  BEFORE UPDATE OR DELETE ON public.training_plans
  FOR EACH ROW EXECUTE FUNCTION public.training_plan_history_guard();

CREATE OR REPLACE FUNCTION public.training_course_version_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_old_plan UUID;
  v_new_plan UUID;
BEGIN
  v_old_plan := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.plan_id END;
  v_new_plan := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.plan_id END;

  IF v_old_plan IS NOT NULL AND public.training_plan_is_locked(v_old_plan) THEN
    RAISE EXCEPTION '已送审、签发、发布或形成培训历史的课件不可修改或删除，请新建计划版本';
  END IF;
  IF v_new_plan IS NOT NULL AND public.training_plan_is_locked(v_new_plan) THEN
    RAISE EXCEPTION '已送审、签发、发布或形成培训历史的计划不可新增或移入课件，请新建计划版本';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_course_library_snapshot()
RETURNS TRIGGER AS $$
DECLARE v_library public.training_library%ROWTYPE;
BEGIN
  IF NEW.library_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.library_id IS NOT DISTINCT FROM OLD.library_id) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_library FROM public.training_library WHERE id = NEW.library_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训资源不存在'; END IF;

  NEW.title := COALESCE(NULLIF(btrim(NEW.title), ''), v_library.title);
  NEW.course_type := CASE WHEN v_library.course_type = 'article' THEN 'text' ELSE v_library.course_type END;
  NEW.file_path := v_library.storage_path;
  NEW.file_url := v_library.file_url;
  NEW.content := v_library.content;
  NEW.page_count := v_library.page_count;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_course_library_snapshot ON public.training_courses;
CREATE TRIGGER trg_training_course_library_snapshot
  BEFORE INSERT OR UPDATE OF library_id ON public.training_courses
  FOR EACH ROW EXECUTE FUNCTION public.training_course_library_snapshot();

ALTER TABLE public.training_courses DROP CONSTRAINT IF EXISTS training_courses_course_type_check;
ALTER TABLE public.training_courses ADD CONSTRAINT training_courses_course_type_check
  CHECK (course_type IN ('pdf', 'video', 'image', 'text', 'link', 'ppt', 'html'));
ALTER TABLE public.training_library DROP CONSTRAINT IF EXISTS training_library_course_type_check;
ALTER TABLE public.training_library ADD CONSTRAINT training_library_course_type_check
  CHECK (course_type IN ('pdf', 'ppt', 'article', 'image', 'html'));

ALTER TABLE public.training_courses DROP CONSTRAINT IF EXISTS training_courses_file_url_https;
ALTER TABLE public.training_courses ADD CONSTRAINT training_courses_file_url_https
  CHECK (file_url IS NULL OR file_url ~* '^https://[^[:space:]]+$');
ALTER TABLE public.training_library DROP CONSTRAINT IF EXISTS training_library_file_url_https;
ALTER TABLE public.training_library ADD CONSTRAINT training_library_file_url_https
  CHECK (file_url IS NULL OR file_url ~* '^https://[^[:space:]]+$');

CREATE OR REPLACE FUNCTION public.training_can_read_course(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_plans p
    WHERE p.id = p_plan_id
      AND (
        (
          public.is_admin()
          AND (
            (p.level = 'company' AND public.training_is_company_admin())
            OR (p.department_id IS NOT NULL AND public.training_can_read(p.department_id))
          )
        )
        OR (
          p.publish_status = 'published'
          AND EXISTS (
            SELECT 1 FROM public.training_assignments a
            WHERE a.plan_id = p.id
              AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
          )
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_can_read_course(UUID) TO authenticated;

DROP POLICY IF EXISTS tr_lib_select ON public.training_library;
CREATE POLICY tr_lib_select ON public.training_library
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    AND (
      (scope = 'company' AND public.training_is_company_admin())
      OR (department_id IS NOT NULL AND public.training_can_read(department_id))
    )
  );

CREATE OR REPLACE FUNCTION public.training_course_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.training_courses c
        JOIN public.training_plans p ON p.id = c.plan_id
        JOIN public.training_assignments a ON a.plan_id = c.plan_id
        WHERE c.file_path = p_storage_path
          AND p.publish_status = 'published'
          AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
      )
      OR EXISTS (
        SELECT 1 FROM public.training_signatures s
        WHERE s.storage_path = p_storage_path
          AND s.employee_id = public.training_my_employee_id()
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_course_file_is_locked(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_courses c
    WHERE c.file_path = p_storage_path
      AND public.training_plan_is_locked(c.plan_id)
  )
  OR EXISTS (
    SELECT 1
    FROM public.training_courses c
    JOIN public.training_library l ON l.id = c.library_id
    WHERE l.storage_path = p_storage_path
      AND public.training_plan_is_locked(c.plan_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_course_file_can_manage(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
     AND NOT public.training_course_file_is_locked(p_storage_path);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_is_locked(TEXT), public.training_course_file_can_manage(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_read(TEXT), public.training_course_file_can_manage(TEXT)
  TO authenticated;

DROP POLICY IF EXISTS training_courses_update_admin ON storage.objects;
CREATE POLICY training_courses_update_admin ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'training-courses'
    AND public.training_course_file_can_manage(name)
  )
  WITH CHECK (
    bucket_id = 'training-courses'
    AND public.training_course_file_can_manage(name)
  );

DROP POLICY IF EXISTS training_courses_delete_admin ON storage.objects;
CREATE POLICY training_courses_delete_admin ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'training-courses'
    AND public.training_course_file_can_manage(name)
  );

CREATE OR REPLACE FUNCTION public.training_request_plan_approval(p_plan_id UUID)
RETURNS VOID AS $$
DECLARE v_plan public.training_plans%ROWTYPE;
BEGIN
  SELECT * INTO v_plan FROM public.training_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v_plan.publish_status = 'published' THEN RAISE EXCEPTION '已发布版本不可再次送审，请新建版本'; END IF;
  IF v_plan.approval_status NOT IN ('draft', 'rejected') THEN RAISE EXCEPTION '只有草稿或被驳回计划可以送审'; END IF;
  IF NOT ((v_plan.level = 'company' AND public.training_is_company_admin()) OR public.training_can_write(v_plan.department_id)) THEN
    RAISE EXCEPTION '您无权送审该培训计划';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_courses WHERE plan_id = p_plan_id) THEN
    RAISE EXCEPTION '请至少添加一份课件后再送审';
  END IF;
  PERFORM set_config('app.training_lifecycle_write', 'D09_CONTROLLED', TRUE);
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
  PERFORM set_config('app.training_lifecycle_write', 'D09_CONTROLLED', TRUE);
  UPDATE public.training_plans
  SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
      approval_note = NULLIF(btrim(p_note), ''),
      approved_at = CASE WHEN p_approved THEN NOW() ELSE NULL END,
      approved_by = CASE WHEN p_approved THEN auth.uid() ELSE NULL END
  WHERE id = p_plan_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_batch_approve_plans(p_plan_ids UUID[])
RETURNS INT AS $$
DECLARE v_id UUID; v_count INT := 0;
BEGIN
  PERFORM set_config('app.training_lifecycle_write', 'D09_CONTROLLED', TRUE);
  FOREACH v_id IN ARRAY COALESCE(p_plan_ids, ARRAY[]::UUID[]) LOOP
    IF EXISTS (SELECT 1 FROM public.training_plans WHERE id = v_id AND approval_status = 'pending_review')
       AND public.training_plan_can_approve(v_id) THEN
      UPDATE public.training_plans
      SET approval_status = 'approved', approval_note = '批量签发',
          approved_at = NOW(), approved_by = auth.uid()
      WHERE id = v_id;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

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
  WITH RECURSIVE scope_seed AS (
    SELECT department_id AS id FROM public.training_plan_targets WHERE plan_id = p_plan_id
    UNION ALL SELECT d.id FROM public.departments d JOIN scope_seed ON d.parent_id = scope_seed.id
  ), own_seed AS (
    SELECT v_plan.department_id AS id WHERE v_plan.department_id IS NOT NULL
    UNION ALL SELECT d.id FROM public.departments d JOIN own_seed ON d.parent_id = own_seed.id
  ), covered AS (
    SELECT id FROM scope_seed UNION SELECT id FROM own_seed WHERE NOT EXISTS (SELECT 1 FROM scope_seed)
  )
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT p_plan_id, e.id, e.user_id, e.department_id FROM public.training_employees e
  WHERE e.status = 'active'
    AND ((v_plan.level = 'company' AND NOT EXISTS (SELECT 1 FROM public.training_plan_targets WHERE plan_id = p_plan_id))
         OR e.department_id IN (SELECT id FROM covered WHERE id IS NOT NULL))
  ON CONFLICT (plan_id, employee_id) DO NOTHING;
  SELECT COUNT(*) INTO v_count FROM public.training_assignments WHERE plan_id = p_plan_id;
  INSERT INTO public.training_records(plan_id, title, train_date, hours, trainer, location, department_id, content, source)
  SELECT p.id, p.title, COALESCE(p.start_date, CURRENT_DATE), p.required_hours, p.trainer, p.location,
         p.department_id, p.content, 'auto'
  FROM public.training_plans p
  WHERE p.id = p_plan_id
    AND NOT EXISTS (SELECT 1 FROM public.training_records r WHERE r.plan_id = p.id AND r.source = 'auto')
  RETURNING id INTO v_record_id;
  PERFORM set_config('app.training_lifecycle_write', 'D09_CONTROLLED', TRUE);
  UPDATE public.training_plans
  SET publish_status = 'published', published_at = NOW(), published_by = auth.uid()
  WHERE id = p_plan_id;
  RETURN jsonb_build_object('success', true, 'assigned', v_count, 'record_id', v_record_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_request_plan_approval(UUID),
  public.training_approve_plan(UUID, BOOLEAN, TEXT),
  public.training_batch_approve_plans(UUID[]),
  public.training_publish_plan(UUID)
TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- D09-1 R02：关闭计划层级、资源库快照与 training-courses 文件的三个权限旁路。
BEGIN;

CREATE OR REPLACE FUNCTION public.training_plan_row_can_write(p_level TEXT, p_department_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
     AND CASE
       WHEN p_level = 'company'
         THEN p_department_id IS NULL AND public.training_is_company_admin()
       ELSE p_department_id IS NOT NULL AND public.training_can_write(p_department_id)
     END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_plan_row_can_write(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_plan_row_can_write(TEXT, UUID) TO authenticated;

DROP POLICY IF EXISTS tr_plan_insert ON public.training_plans;
CREATE POLICY tr_plan_insert ON public.training_plans
  FOR INSERT TO authenticated
  WITH CHECK (public.training_plan_row_can_write(level, department_id));

DROP POLICY IF EXISTS tr_plan_update ON public.training_plans;
CREATE POLICY tr_plan_update ON public.training_plans
  FOR UPDATE TO authenticated
  USING (public.training_plan_row_can_write(level, department_id))
  WITH CHECK (public.training_plan_row_can_write(level, department_id));

DROP POLICY IF EXISTS tr_plan_delete ON public.training_plans;
CREATE POLICY tr_plan_delete ON public.training_plans
  FOR DELETE TO authenticated
  USING (public.training_plan_row_can_write(level, department_id));

CREATE OR REPLACE FUNCTION public.training_plan_admin_can_read(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND EXISTS (
    SELECT 1
    FROM public.training_plans p
    WHERE p.id = p_plan_id
      AND (
        (p.level = 'company' AND public.training_is_company_admin())
        OR (p.department_id IS NOT NULL AND public.training_can_read(p.department_id))
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_plan_admin_can_read(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_library_can_read(p_library_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND EXISTS (
    SELECT 1
    FROM public.training_library l
    WHERE l.id = p_library_id
      AND (
        (l.scope = 'company' AND public.training_is_company_admin())
        OR (l.department_id IS NOT NULL AND public.training_can_read(l.department_id))
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_library_can_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_library_can_read(UUID) TO authenticated;

DROP POLICY IF EXISTS tr_lib_select ON public.training_library;
CREATE POLICY tr_lib_select ON public.training_library
  FOR SELECT TO authenticated
  USING (public.training_library_can_read(id));

CREATE OR REPLACE FUNCTION public.training_course_library_snapshot()
RETURNS TRIGGER AS $$
DECLARE v_library public.training_library%ROWTYPE;
BEGIN
  IF NEW.library_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.library_id IS NOT DISTINCT FROM OLD.library_id) THEN
    RETURN NEW;
  END IF;
  IF NOT public.training_library_can_read(NEW.library_id) THEN
    RAISE EXCEPTION '您无权引用该培训资源';
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

CREATE OR REPLACE FUNCTION public.training_course_file_owned_unlinked(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM storage.objects o
    WHERE o.bucket_id = 'training-courses'
      AND o.name = p_storage_path
      AND (o.owner = auth.uid() OR o.owner_id = auth.uid()::TEXT)
  )
  AND NOT EXISTS (SELECT 1 FROM public.training_courses c WHERE c.file_path = p_storage_path)
  AND NOT EXISTS (SELECT 1 FROM public.training_library l WHERE l.storage_path = p_storage_path)
  AND NOT EXISTS (SELECT 1 FROM public.training_signatures s WHERE s.storage_path = p_storage_path);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_owned_unlinked(TEXT)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_course_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
         SELECT 1 FROM public.training_courses c
         WHERE c.file_path = p_storage_path
           AND public.training_plan_admin_can_read(c.plan_id)
       )
      OR EXISTS (
         SELECT 1 FROM public.training_library l
         WHERE l.storage_path = p_storage_path
           AND public.training_library_can_read(l.id)
       )
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
      )
      OR public.training_course_file_owned_unlinked(p_storage_path);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_course_file_can_manage(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT NOT public.training_course_file_is_locked(p_storage_path)
     AND (
       EXISTS (
         SELECT 1 FROM public.training_courses c
         WHERE c.file_path = p_storage_path
           AND public.training_plan_admin_can_read(c.plan_id)
       )
       OR EXISTS (
         SELECT 1 FROM public.training_library l
         WHERE l.storage_path = p_storage_path
           AND public.training_library_can_read(l.id)
       )
       OR (public.is_admin() AND public.training_course_file_owned_unlinked(p_storage_path))
     );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_can_read(TEXT),
  public.training_course_file_can_manage(TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_read(TEXT),
  public.training_course_file_can_manage(TEXT)
TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

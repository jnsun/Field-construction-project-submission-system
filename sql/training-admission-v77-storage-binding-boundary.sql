-- D09-1：Storage 文件路径只能由真实 owner 首次绑定，或按写入前已有业务关系合法复用。
BEGIN;

CREATE OR REPLACE FUNCTION public.training_course_file_can_bind(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM storage.objects o
    WHERE o.bucket_id = 'training-courses'
      AND o.name = p_storage_path
  )
  AND (
    public.training_course_file_owned_unlinked(p_storage_path)
    OR EXISTS (
      SELECT 1
      FROM public.training_courses c
      WHERE c.file_path = p_storage_path
        AND public.training_plan_admin_can_read(c.plan_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.training_library l
      WHERE l.storage_path = p_storage_path
        AND public.training_library_can_read(l.id)
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_file_can_bind(TEXT)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_course_storage_binding_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.file_path IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.file_path IS NOT DISTINCT FROM OLD.file_path) THEN
    RETURN NEW;
  END IF;
  IF NOT public.training_course_file_can_bind(NEW.file_path) THEN
    RAISE EXCEPTION '您无权绑定该培训文件或文件不存在';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_course_storage_binding_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_training_course_storage_binding_guard ON public.training_courses;
CREATE TRIGGER trg_training_course_storage_binding_guard
  BEFORE INSERT OR UPDATE OF file_path, library_id ON public.training_courses
  FOR EACH ROW EXECUTE FUNCTION public.training_course_storage_binding_guard();

CREATE OR REPLACE FUNCTION public.training_library_storage_binding_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.storage_path IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.storage_path IS NOT DISTINCT FROM OLD.storage_path) THEN
    RETURN NEW;
  END IF;
  IF NOT public.training_course_file_can_bind(NEW.storage_path) THEN
    RAISE EXCEPTION '您无权绑定该培训文件或文件不存在';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_library_storage_binding_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_training_library_storage_binding_guard ON public.training_library;
CREATE TRIGGER trg_training_library_storage_binding_guard
  BEFORE INSERT OR UPDATE OF storage_path ON public.training_library
  FOR EACH ROW EXECUTE FUNCTION public.training_library_storage_binding_guard();

NOTIFY pgrst, 'reload schema';
COMMIT;

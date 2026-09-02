-- 安全加固 v1：在 Supabase SQL Editor 整文件执行，可重复执行。
-- 覆盖：匿名账号枚举、培训课件/签名公开访问、宽泛的文件写删权限、可预测密码。

-- 1. 禁止未登录的手机号/部门名解析；前端统一改为邮箱登录。
REVOKE ALL ON FUNCTION public.resolve_login_identifier(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_login_identifier(TEXT) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.training_staff_register(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.training_staff_register(TEXT, TEXT) FROM anon, authenticated;

-- 2. 课件桶改为私有。管理员维护课件，员工仅能读取自己被指派培训的课件。
INSERT INTO storage.buckets (id, name, public)
VALUES ('training-courses', 'training-courses', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "training_courses_read" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_write" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_manage" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_delete" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_read_authorized" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_write_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_update_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_courses_delete_admin" ON storage.objects;
DROP POLICY IF EXISTS "training_signatures_write_own" ON storage.objects;
DROP POLICY IF EXISTS "training_signatures_read_own" ON storage.objects;

CREATE POLICY "training_courses_read_authorized" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'training-courses' AND (
      public.is_admin() OR EXISTS (
        SELECT 1
        FROM public.training_courses c
        JOIN public.training_assignments a ON a.plan_id = c.plan_id
        WHERE c.file_path = name
          AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
      ) OR EXISTS (
        SELECT 1
        FROM public.training_signatures s
        WHERE s.storage_path = name
          AND s.employee_id = public.training_my_employee_id()
      )
    )
  );

CREATE POLICY "training_courses_write_admin" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'training-courses' AND public.is_admin());
CREATE POLICY "training_courses_update_admin" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'training-courses' AND public.is_admin())
  WITH CHECK (bucket_id = 'training-courses' AND public.is_admin());
CREATE POLICY "training_courses_delete_admin" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'training-courses' AND public.is_admin());

-- 仅允许员工为自己的培训任务上传签名文件；签名不能覆盖或删除。
CREATE POLICY "training_signatures_write_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'training-courses'
    AND (storage.foldername(name))[1] = 'signatures'
    AND EXISTS (
      SELECT 1 FROM public.training_assignments a
      WHERE a.id::text = split_part(storage.filename(name), '_', 1)
        AND (a.user_id = auth.uid() OR a.employee_id = public.training_my_employee_id())
    )
  );

-- 3. 重置密码必须由管理员显式提供至少 12 位临时密码，禁止使用身份证后六位。
DROP FUNCTION IF EXISTS public.training_staff_reset(UUID);
DROP FUNCTION IF EXISTS public.training_staff_reset(UUID, TEXT);
CREATE FUNCTION public.training_staff_reset(p_employee_id UUID, p_temporary_password TEXT)
RETURNS JSONB AS $$
DECLARE
  v_emp public.training_employees%ROWTYPE;
  v_email TEXT;
  v_uid UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '只有管理员才能执行此操作'; END IF;
  IF length(coalesce(p_temporary_password, '')) < 12 THEN
    RAISE EXCEPTION '临时密码至少 12 位';
  END IF;
  SELECT * INTO v_emp FROM public.training_employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION '员工不存在'; END IF;
  IF v_emp.phone IS NULL OR btrim(v_emp.phone) = '' THEN RAISE EXCEPTION '该员工未登记手机号'; END IF;

  v_email := btrim(v_emp.phone) || '@staff.local';
  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '该员工尚未开通账号，请使用人员与组织模块开通';
  END IF;

  UPDATE auth.users
  SET encrypted_password = crypt(p_temporary_password, gen_salt('bf', 10)), updated_at = now()
  WHERE id = v_uid;
  RETURN jsonb_build_object('success', true, 'user_id', v_uid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;
REVOKE ALL ON FUNCTION public.training_staff_reset(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.training_staff_reset(UUID, TEXT) TO authenticated;

-- =============================================================
-- sql/personnel-center-v1.sql —— 人员与组织中心 · 数据层 v1（P1）
--
-- 配套设计文档：docs/personnel-architecture-v1-design.md
-- 幂等：可重复执行（CREATE OR REPLACE + IF NOT EXISTS + 缝合迁移天然幂等）
-- 前提：sql/schema.sql、sql/account-rpc-v2.sql、sql/training-management.sql
--       （含 training-fix-v13.sql）均已执行
--
-- 内容：
--   1. 权威员工表加字段（job_grade 岗级 / photo_path 照片）
--      ※ 特种作业标记不新增列：training_employees.emp_type='special' 已承担
--   2. profiles 瘦身为纯登录表：新增 employee_id 可空关联（1 账号 : 0..1 档案）
--   3. 存量缝合迁移（按手机号幂等 UPDATE，绝不自动建档）
--   4. personnel_change_logs 变更留痕表 + RLS
--   5. 新 RPC：people_create_account / people_link_account /
--      people_unlink_account / employee_self_profile / employee_self_update
--   6. 手机号同步触发器（员工表改手机号 → 联动登录账号）
--   7. avatars Storage 私有桶 + 策略（目录第一层 = 员工 id）
--   8. 末尾自检
-- =============================================================

-- --------------------------------------------------------------------------
-- 1. 权威员工表 = training_employees 加字段（不改表名，证照/培训已挂在它上面）
-- --------------------------------------------------------------------------
ALTER TABLE public.training_employees
  ADD COLUMN IF NOT EXISTS job_grade  TEXT,   -- 岗级 / 职务（报表分组用）
  ADD COLUMN IF NOT EXISTS photo_path TEXT;   -- 照片 Storage key（avatars 桶，格式：{employee_id}/{时间戳_随机}.{ext}）

-- --------------------------------------------------------------------------
-- 2. profiles 瘦身为纯登录表：employee_id 弱关联
--    有值 = 员工开通了登录；NULL = 纯管理账号（超管、领导查数账号等）
-- --------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES public.training_employees(id)
  ON DELETE SET NULL;

-- 一个档案最多绑定一个登录账号（部分唯一索引，NULL 不受限）
DROP INDEX IF EXISTS idx_profiles_employee_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_employee_uniq
  ON public.profiles(employee_id) WHERE employee_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 3. 存量缝合迁移：按手机号把已有账号挂到已有档案（幂等；匹配不上留 NULL，
--    绝不自动建档——由管理员在人员中心人工认领）
-- --------------------------------------------------------------------------
UPDATE public.profiles p
SET employee_id = te.id
FROM public.training_employees te
WHERE p.employee_id IS NULL
  AND te.status = 'active'
  AND p.phone IS NOT NULL
  AND p.phone = te.phone;

-- --------------------------------------------------------------------------
-- 4. 变更留痕表（员工自助改手机号/照片，直接生效 + 留痕）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.personnel_change_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,                 -- phone | photo_path（预留扩展）
  old_value   TEXT,
  new_value   TEXT,
  changed_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,  -- 留痕保留，操作人账号删除后置空
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pcl_employee ON public.personnel_change_logs(employee_id, created_at DESC);

-- 幂等重建 changed_by 外键：必须带 ON DELETE SET NULL（否则留痕会卡死账号删除）
ALTER TABLE public.personnel_change_logs DROP CONSTRAINT IF EXISTS personnel_change_logs_changed_by_fkey;
ALTER TABLE public.personnel_change_logs
  ADD CONSTRAINT personnel_change_logs_changed_by_fkey
  FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 兜底：profiles.role 列默认值必须是 employee（remove-reporter-role.sql 收紧 CHECK 时
-- 未同步默认值，导致 handle_new_user 触发器插入 role='reporter' 必然 23514）
ALTER TABLE public.profiles ALTER COLUMN role SET DEFAULT 'employee';

ALTER TABLE public.personnel_change_logs ENABLE ROW LEVEL SECURITY;

-- 跨表策略按铁律包 SECURITY DEFINER 函数防递归：
-- 可见 = ①本员工在本账号管辖树内（training_can_read） ②本员工就是"我"（员工查自己的变更）
CREATE OR REPLACE FUNCTION public.people_can_view_changes(p_employee uuid, p_dept uuid)
RETURNS BOOLEAN AS $$
  SELECT public.training_can_read(p_dept)
     OR EXISTS (
       SELECT 1 FROM public.profiles
       WHERE id = auth.uid() AND employee_id = p_employee
     )
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS "pcl_select" ON public.personnel_change_logs;
CREATE POLICY "pcl_select" ON public.personnel_change_logs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.training_employees te
      WHERE te.id = personnel_change_logs.employee_id
        AND public.people_can_view_changes(te.id, te.department_id)
    )
  );

-- 写入只经 RPC（SECURITY DEFINER），不开放直写
DROP POLICY IF EXISTS "pcl_write" ON public.personnel_change_logs;

-- --------------------------------------------------------------------------
-- 5. RPC
-- --------------------------------------------------------------------------

-- 5.1 为已有员工开通登录账号（人员中心「开通登录」入口）
--     姓名/部门/手机号可省略：缺省自动取员工档案值
--     权限：管理员且对本员工部门有 training_can_write 权限
--     内部复用 account-rpc-v2 的 create_dept_user（权限矩阵/手机号唯一性全继承）
CREATE OR REPLACE FUNCTION public.people_create_account(
  p_employee_id   UUID,
  p_email         TEXT,
  p_password      TEXT,
  p_full_name     TEXT DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_role          TEXT DEFAULT 'employee',
  p_phone         TEXT DEFAULT NULL,
  p_admin_level   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_emp       public.training_employees%ROWTYPE;
  v_name      TEXT;
  v_dept      UUID;
  v_phone     TEXT;
  v_result    JSONB;
  v_user_id   UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION '必须指定员工档案';
  END IF;

  SELECT * INTO v_emp FROM public.training_employees WHERE id = p_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '员工档案不存在';
  END IF;
  IF NOT public.training_can_write(v_emp.department_id) THEN
    RAISE EXCEPTION '您无权为该员工所在部门开通账号';
  END IF;

  -- 已有账号绑定该档案（唯一索引兜底，这里提前给友好提示）
  IF EXISTS (SELECT 1 FROM public.profiles WHERE employee_id = p_employee_id) THEN
    RAISE EXCEPTION '该员工已绑定登录账号，如需更换请先解除关联';
  END IF;

  -- 姓名必填；缺省取档案
  v_name := COALESCE(NULLIF(btrim(coalesce(p_full_name, '')), ''), v_emp.name);
  IF v_name IS NULL OR v_name = '' THEN
    RAISE EXCEPTION '账号名称不能为空';
  END IF;
  v_dept  := COALESCE(p_department_id, v_emp.department_id);
  v_phone := COALESCE(NULLIF(btrim(coalesce(p_phone, '')), ''), v_emp.phone);

  v_result := public.create_dept_user(
    p_email, p_password, v_name, v_dept, p_role, v_phone, p_admin_level
  );
  v_user_id := (v_result->>'user_id')::UUID;

  UPDATE public.profiles SET employee_id = p_employee_id WHERE id = v_user_id;

  RETURN jsonb_build_object('success', true, 'user_id', v_user_id, 'employee_id', p_employee_id);
END;
$$;

-- 5.2 认领：把已有账号（含纯管理账号）挂到员工档案上（公司级管理员）
CREATE OR REPLACE FUNCTION public.people_link_account(
  p_employee_id UUID,
  p_user_id     UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_emp  public.training_employees%ROWTYPE;
  v_dept UUID;
BEGIN
  IF NOT (public.is_super_admin() OR public.training_is_company_admin()) THEN
    RAISE EXCEPTION '仅公司级管理员可以关联账号与档案';
  END IF;

  SELECT * INTO v_emp FROM public.training_employees WHERE id = p_employee_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '员工档案不存在';
  END IF;
  v_dept := v_emp.department_id;

  -- 该档案当前绑定的账号（若有）先解绑
  UPDATE public.profiles SET employee_id = NULL WHERE employee_id = p_employee_id;

  BEGIN
    UPDATE public.profiles SET employee_id = p_employee_id WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '该档案已绑定其他登录账号';
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION '登录账号不存在';
  END IF;

  RETURN jsonb_build_object('success', true, 'employee_id', p_employee_id, 'user_id', p_user_id);
END;
$$;

-- 5.3 解除账号与档案的关联（公司级管理员）
CREATE OR REPLACE FUNCTION public.people_unlink_account(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT (public.is_super_admin() OR public.training_is_company_admin()) THEN
    RAISE EXCEPTION '仅公司级管理员可以解除关联';
  END IF;
  UPDATE public.profiles SET employee_id = NULL WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '登录账号不存在';
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 5.4 员工自助：我的档案（本人 360 自视图）
--     返回 has_employee=false 表示该账号未绑定档案（纯管理账号）
CREATE OR REPLACE FUNCTION public.employee_self_profile()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_emp_id   UUID;
  v_emp      public.training_employees%ROWTYPE;
  v_acct     public.profiles%ROWTYPE;
  v_certs    JSONB;
  v_training JSONB;
BEGIN
  SELECT * INTO v_acct FROM public.profiles WHERE id = v_uid;
  v_emp_id := v_acct.employee_id;
  IF v_emp_id IS NULL THEN
    RETURN jsonb_build_object('has_employee', false,
      'account', jsonb_build_object('full_name', v_acct.full_name, 'email', v_acct.email));
  END IF;

  SELECT * INTO v_emp FROM public.training_employees WHERE id = v_emp_id;

  -- 个人证照：按身份证号匹配（证照明细仍归属证照模块，此处只读汇总）
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'cert_name', c.cert_name, 'cert_no', c.cert_no,
           'valid_until', c.valid_until, 'is_long_term', c.is_long_term,
           'expire_days', CASE WHEN c.is_long_term THEN NULL
                               ELSE (c.valid_until - CURRENT_DATE) END))
           FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb)
    INTO v_certs
    FROM public.certificates c
   WHERE c.cert_category = 'personal'
     AND v_emp.id_number IS NOT NULL
     AND c.holder_id_no = v_emp.id_number;

  -- 培训汇总：双通道（user_id 快照 + employee_id 实时绑定）
  SELECT jsonb_build_object(
           'tasks',       COUNT(*),
           'completed',   COUNT(*) FILTER (WHERE a.status = 'completed'),
           'exams_taken', COUNT(*) FILTER (WHERE a.exam_status <> 'none'),
           'exams_passed',COUNT(*) FILTER (WHERE a.exam_status = 'passed')
         )
    INTO v_training
    FROM public.training_assignments a
   WHERE a.employee_id = v_emp_id
      OR (v_acct.id IS NOT NULL AND a.user_id = v_acct.id);

  RETURN jsonb_build_object(
    'has_employee', true,
    'account', jsonb_build_object(
      'full_name', v_acct.full_name, 'email', v_acct.email,
      'role', v_acct.role, 'phone', v_acct.phone),
    'employee', jsonb_build_object(
      'id', v_emp.id, 'name', v_emp.name, 'employee_no', v_emp.employee_no,
      'department', (SELECT name FROM public.departments WHERE id = v_emp.department_id),
      'position', v_emp.position, 'job_grade', v_emp.job_grade,
      'id_number', v_emp.id_number, 'phone', v_emp.phone,
      'hire_date', v_emp.hire_date, 'emp_type', v_emp.emp_type,
      'photo_path', v_emp.photo_path, 'status', v_emp.status),
    'certs', v_certs,
    'training', v_training
  );
END;
$$;

-- 5.5 员工自助修改（仅放行 phone / photo_path；直接生效 + 留痕）
--     phone 同时联动登录账号（手机号即登录标识）
CREATE OR REPLACE FUNCTION public.employee_self_update(
  p_field TEXT,
  p_value TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_emp_id UUID;
  v_old    TEXT;
  v_new    TEXT;
BEGIN
  SELECT employee_id INTO v_emp_id FROM public.profiles WHERE id = v_uid;
  IF v_emp_id IS NULL THEN
    RAISE EXCEPTION '当前账号未绑定员工档案，无法自助修改';
  END IF;

  v_new := NULLIF(btrim(coalesce(p_value, '')), '');

  IF p_field = 'phone' THEN
    IF v_new IS NULL OR v_new !~ '^1[3-9][0-9]{9}$' THEN
      RAISE EXCEPTION '手机号格式不正确（应为 11 位国内手机号）';
    END IF;
    -- 全局唯一：员工表（排除自己）+ 账号表（排除自己名下账号）
    IF EXISTS (SELECT 1 FROM public.training_employees
                WHERE phone = v_new AND id <> v_emp_id) THEN
      RAISE EXCEPTION '该手机号已被其他员工使用';
    END IF;
    IF EXISTS (SELECT 1 FROM public.profiles
                WHERE phone = v_new AND employee_id <> v_emp_id) THEN
      RAISE EXCEPTION '该手机号已被其他登录账号占用';
    END IF;

    SELECT phone INTO v_old FROM public.training_employees WHERE id = v_emp_id;
    UPDATE public.training_employees SET phone = v_new, updated_at = NOW() WHERE id = v_emp_id;
    UPDATE public.profiles SET phone = v_new WHERE employee_id = v_emp_id;

  ELSIF p_field = 'photo_path' THEN
    IF v_new IS NULL OR v_new !~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9._-]{1,160}$' THEN
      RAISE EXCEPTION '照片路径不合法';
    END IF;
    IF split_part(v_new, '/', 1) <> v_emp_id::text THEN
      RAISE EXCEPTION '只能上传本人照片';
    END IF;
    SELECT photo_path INTO v_old FROM public.training_employees WHERE id = v_emp_id;
    UPDATE public.training_employees SET photo_path = v_new, updated_at = NOW() WHERE id = v_emp_id;

  ELSE
    RAISE EXCEPTION '不允许自助修改该字段：%', p_field;
  END IF;

  INSERT INTO public.personnel_change_logs (employee_id, field, old_value, new_value, changed_by)
  VALUES (v_emp_id, p_field, v_old, v_new, v_uid);

  RETURN jsonb_build_object('success', true, 'field', p_field);
END;
$$;

-- --------------------------------------------------------------------------
-- 6. 手机号同步触发器：管理员在人员中心改员工手机号 → 联动其登录账号
--    （反向不联动：账号手机号改动仍走 update_dept_user，由管理员负责两处一致；
--      员工自助改手机号走 5.5 RPC，两处同步更新）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_employee_phone_to_profile()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    UPDATE public.profiles SET phone = NEW.phone WHERE employee_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_employee_phone ON public.training_employees;
CREATE TRIGGER trg_sync_employee_phone
  AFTER UPDATE OF phone ON public.training_employees
  FOR EACH ROW EXECUTE FUNCTION public.sync_employee_phone_to_profile();

-- --------------------------------------------------------------------------
-- 7. avatars Storage 私有桶 + 策略
--    目录第一层 = 员工 id（photo_path 约定 {employee_id}/{时间戳_随机}.{ext}）
-- --------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', false)
ON CONFLICT (id) DO NOTHING;

-- 7.1 读：管理员全量；员工读本人目录
DROP POLICY IF EXISTS "avatars_read" ON storage.objects;
CREATE POLICY "avatars_read" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'avatars'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = (
        SELECT employee_id::text FROM public.profiles WHERE id = auth.uid())
    )
  );

-- 7.2 写：管理员或本人目录（自助上传照片）
DROP POLICY IF EXISTS "avatars_write" ON storage.objects;
CREATE POLICY "avatars_write" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'avatars'
    AND (
      public.is_admin()
      OR (storage.foldername(name))[1] = (
        SELECT employee_id::text FROM public.profiles WHERE id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
CREATE POLICY "avatars_update" ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'avatars' AND public.is_admin()
  );

-- 7.3 删：仅管理员
DROP POLICY IF EXISTS "avatars_delete" ON storage.objects;
CREATE POLICY "avatars_delete" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'avatars' AND public.is_admin()
  );

-- --------------------------------------------------------------------------
-- 8. 授权 + 自检
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.people_create_account(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.people_link_account(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.people_unlink_account(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_self_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.employee_self_update(TEXT, TEXT) TO authenticated;

DO $$
DECLARE
  v_tables INT; v_funcs INT; v_linked INT;
BEGIN
  SELECT COUNT(*) INTO v_tables FROM (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'personnel_change_logs'
    UNION ALL
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'employee_id'
    UNION ALL
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'training_employees' AND column_name = 'job_grade'
    UNION ALL
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'training_employees' AND column_name = 'photo_path'
  ) t;
  SELECT COUNT(*) INTO v_funcs FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('people_create_account', 'people_link_account', 'people_unlink_account',
                     'employee_self_profile', 'employee_self_update',
                     'people_can_view_changes', 'sync_employee_phone_to_profile');
  SELECT COUNT(*) INTO v_linked FROM public.profiles WHERE employee_id IS NOT NULL;

  IF v_tables <> 4 OR v_funcs <> 7 THEN
    RAISE EXCEPTION '自检未通过：表/列 %/4，函数 %/7', v_tables, v_funcs;
  END IF;
  RAISE NOTICE '人员与组织中心 v1 自检 OK：4 项表/列、7 个函数齐全；已缝合账号-档案 % 对', v_linked;
END;
$$;

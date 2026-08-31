-- ==========================================================================
-- 培训教育模块 v2 —— 员工在线学习 + 自动记录
--
-- 业务口径（2026-08-31 与用户确认）：
--   · 管理员按层级发起培训：公司级→全员，部门级→本部门（含下级），项目级→本项目
--   · 覆盖人群由系统自动展开，不需要逐个添加人员
--   · 员工用手机号登录，在手机或网页上完成在线学习
--   · 课件进度达到 90% 才算完成；全部必修课件完成 → 自动记录学时与完成时间
--   · 过渡登录：手机号 + 身份证后 6 位（等域名备案 + 微信服务号下来后换扫码登录，
--     只换登录入口，user_id 不变，已积累的学习记录不丢）
--
-- 执行方式：Supabase 控制台 → SQL Editor → 全部粘贴 → Run（幂等，可重复执行）
-- 前置：已执行 sql/training-management.sql 与 sql/training-fix-v13.sql
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. profiles 角色增加 employee（员工账号）
-- --------------------------------------------------------------------------
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'reporter', 'employee'));

-- 员工用手机号登录，profiles 必须有 phone 列（phone-login.sql 里已建，这里兜底）
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS phone TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE schemaname='public' AND indexname='idx_profiles_phone') THEN
    EXECUTE 'CREATE UNIQUE INDEX idx_profiles_phone ON public.profiles (phone)
             WHERE phone IS NOT NULL AND btrim(phone) <> ''''';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1. 员工档案：绑定登录账号
-- --------------------------------------------------------------------------
ALTER TABLE public.training_employees
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_emp_user
  ON public.training_employees (user_id) WHERE user_id IS NOT NULL;

-- 手机号唯一（用于登录），空值不参与
CREATE UNIQUE INDEX IF NOT EXISTS idx_tr_emp_phone
  ON public.training_employees (phone) WHERE phone IS NOT NULL AND btrim(phone) <> '';

-- --------------------------------------------------------------------------
-- 2. 培训计划：发布状态 / 截止时间 / 要求学时
-- --------------------------------------------------------------------------
ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS deadline       DATE,
  ADD COLUMN IF NOT EXISTS required_hours NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS publish_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (publish_status IN ('draft', 'published', 'closed')),
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by   UUID REFERENCES auth.users(id);

-- --------------------------------------------------------------------------
-- 3. 课件
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_courses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  course_type  TEXT NOT NULL DEFAULT 'pdf'
                 CHECK (course_type IN ('pdf', 'video', 'image', 'text', 'link')),
  file_path    TEXT,                      -- Supabase Storage 中的对象路径
  file_url     TEXT,                      -- 外链地址（course_type='link' 时用）
  content      TEXT,                      -- 图文正文（course_type='text' 时用）
  page_count   INT,                       -- PDF 总页数（用于计算进度）
  duration_sec INT,                       -- 视频总秒数（用于计算进度）
  required     BOOLEAN NOT NULL DEFAULT TRUE,   -- 必修课件才计入完成条件
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_course_plan ON public.training_courses(plan_id, sort_order);

DROP TRIGGER IF EXISTS trg_tr_course_updated ON public.training_courses;
CREATE TRIGGER trg_tr_course_updated BEFORE UPDATE ON public.training_courses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 4. 参训名单（培训任务 × 员工）—— 自动记录的核心落点
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'learning', 'completed', 'overdue')),
  progress      NUMERIC(5,1) NOT NULL DEFAULT 0,
  completed_at  TIMESTAMPTZ,
  hours_earned  NUMERIC(5,1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_tr_asg_plan  ON public.training_assignments(plan_id);
CREATE INDEX IF NOT EXISTS idx_tr_asg_user  ON public.training_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_tr_asg_emp   ON public.training_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_tr_asg_dept  ON public.training_assignments(department_id);
CREATE INDEX IF NOT EXISTS idx_tr_asg_state ON public.training_assignments(status);

DROP TRIGGER IF EXISTS trg_tr_asg_updated ON public.training_assignments;
CREATE TRIGGER trg_tr_asg_updated BEFORE UPDATE ON public.training_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 5. 课件进度（每人每课件一行）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_course_progress (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES public.training_assignments(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  progress      NUMERIC(5,1) NOT NULL DEFAULT 0,   -- 0 ~ 100
  max_position  NUMERIC NOT NULL DEFAULT 0,        -- 视频秒数 或 PDF 页码（只增不减，防拖拽跳看）
  finished      BOOLEAN NOT NULL DEFAULT FALSE,
  finished_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (course_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_tr_cp_emp ON public.training_course_progress(employee_id);

-- --------------------------------------------------------------------------
-- 6. 权限辅助函数
-- --------------------------------------------------------------------------

-- 6.1 当前登录账号对应的员工档案
CREATE OR REPLACE FUNCTION public.training_my_employee_id()
RETURNS UUID AS $$
  SELECT id FROM public.training_employees WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 6.2 我参训的计划（员工端用）
CREATE OR REPLACE FUNCTION public.training_my_plan_ids()
RETURNS SETOF UUID AS $$
  SELECT plan_id FROM public.training_assignments WHERE user_id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 6.3 能否读某个计划的课件：参训员工 或 管辖内管理员 或 公司级计划
CREATE OR REPLACE FUNCTION public.training_can_read_course(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT p_plan_id IN (SELECT public.training_my_plan_ids())
     OR public.training_can_read((SELECT p.department_id FROM public.training_plans p WHERE p.id = p_plan_id))
     OR EXISTS (SELECT 1 FROM public.training_plans p WHERE p.id = p_plan_id AND p.level = 'company');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 7. 发布计划：按层级自动展开参训名单
--    覆盖规则（优先级从高到低）：
--      ① level = 'company'                → 全体在职员工
--      ② training_plan_targets 有记录      → 这些部门及其所有下级部门
--      ③ 否则                              → 计划所属部门及其所有下级部门
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_publish_plan(UUID);
CREATE FUNCTION public.training_publish_plan(p_plan_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_plan     public.training_plans%ROWTYPE;
  v_count    INT := 0;
  v_record_id UUID;
BEGIN
  SELECT * INTO v_plan FROM public.training_plans WHERE id = p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;

  IF NOT public.training_can_write(v_plan.department_id) THEN
    RAISE EXCEPTION '无权限发布该计划';
  END IF;

  IF v_plan.publish_status = 'published' THEN
    RAISE EXCEPTION '该计划已发布，如需追加人员请在计划里补充覆盖部门后重新发布';
  END IF;

  WITH RECURSIVE scope_seed AS (
    SELECT department_id AS id FROM public.training_plan_targets WHERE plan_id = p_plan_id
    UNION ALL
    SELECT d.id FROM public.departments d JOIN scope_seed ON d.parent_id = scope_seed.id
  ),
  own_seed AS (
    SELECT v_plan.department_id AS id WHERE v_plan.department_id IS NOT NULL
    UNION ALL
    SELECT d.id FROM public.departments d JOIN own_seed ON d.parent_id = own_seed.id
  ),
  covered AS (
    SELECT id FROM scope_seed
    UNION
    SELECT id FROM own_seed WHERE NOT EXISTS (SELECT 1 FROM scope_seed)
  )
  INSERT INTO public.training_assignments (plan_id, employee_id, user_id, department_id)
  SELECT p_plan_id, e.id, e.user_id, e.department_id
  FROM public.training_employees e
  WHERE e.status = 'active'
    AND (
      v_plan.level = 'company'
      OR e.department_id IN (SELECT id FROM covered WHERE id IS NOT NULL)
    )
  ON CONFLICT (plan_id, employee_id) DO NOTHING;

  SELECT COUNT(*) INTO v_count
  FROM public.training_assignments WHERE plan_id = p_plan_id;

  -- 同步生成一条培训记录（供统计与一人一档使用；线下培训仍走手工登记）
  INSERT INTO public.training_records (
    plan_id, title, train_date, hours, trainer, location, department_id, content, source
  )
  SELECT p.id, p.title, COALESCE(p.start_date, CURRENT_DATE), p.required_hours,
         p.trainer, p.location, p.department_id, p.content, 'auto'
  FROM public.training_plans p
  WHERE p.id = p_plan_id
    AND NOT EXISTS (
      SELECT 1 FROM public.training_records r WHERE r.plan_id = p.id AND r.source = 'auto'
    )
  RETURNING id INTO v_record_id;

  UPDATE public.training_plans SET
    publish_status = 'published',
    published_at   = NOW(),
    published_by   = auth.uid()
  WHERE id = p_plan_id;

  RETURN jsonb_build_object('success', true, 'assigned', v_count, 'record_id', v_record_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_publish_plan(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 8. 员工上报课件进度（达到 90% 即完成；全部必修完成 → 自动记录）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_save_course_progress(UUID, NUMERIC, NUMERIC);
CREATE FUNCTION public.training_save_course_progress(
  p_course_id UUID,
  p_progress  NUMERIC,
  p_position  NUMERIC
) RETURNS JSONB AS $$
DECLARE
  v_emp      UUID;
  v_asg      public.training_assignments%ROWTYPE;
  v_plan_id  UUID;
  v_finished BOOLEAN;
  v_prog     NUMERIC;
  v_total    INT := 0;
  v_done     INT := 0;
  v_avg      NUMERIC := 0;
  v_all_done BOOLEAN := FALSE;
  v_record_id UUID;
  v_hours    NUMERIC;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案，请联系管理员'; END IF;

  SELECT a.* INTO v_asg
  FROM public.training_assignments a
  JOIN public.training_courses c ON c.id = p_course_id
  WHERE a.plan_id = c.plan_id AND a.employee_id = v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION '您不在该培训的参训范围内'; END IF;

  v_plan_id := v_asg.plan_id;
  v_prog    := LEAST(GREATEST(COALESCE(p_progress, 0), 0), 100);
  v_finished := v_prog >= 90;

  INSERT INTO public.training_course_progress (
    assignment_id, course_id, employee_id, progress, max_position, finished, finished_at
  ) VALUES (
    v_asg.id, p_course_id, v_emp, v_prog, COALESCE(p_position, 0), v_finished,
    CASE WHEN v_finished THEN NOW() END
  )
  ON CONFLICT (course_id, employee_id) DO UPDATE SET
    progress     = GREATEST(public.training_course_progress.progress, v_prog),
    max_position = GREATEST(public.training_course_progress.max_position, COALESCE(p_position, 0)),
    finished     = public.training_course_progress.finished OR v_finished,
    finished_at  = COALESCE(public.training_course_progress.finished_at,
                            CASE WHEN v_finished THEN NOW() END),
    updated_at   = NOW();

  -- 汇总必修课件完成情况
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE cp.finished),
         COALESCE(AVG(COALESCE(cp.progress, 0)), 0)
    INTO v_total, v_done, v_avg
  FROM public.training_courses c
  LEFT JOIN public.training_course_progress cp
    ON cp.course_id = c.id AND cp.employee_id = v_emp
  WHERE c.plan_id = v_plan_id AND c.required;

  v_all_done := (v_total > 0 AND v_done = v_total);

  SELECT required_hours INTO v_hours FROM public.training_plans WHERE id = v_plan_id;

  UPDATE public.training_assignments SET
    status = CASE
               WHEN v_all_done THEN 'completed'
               WHEN v_avg > 0  THEN 'learning'
               ELSE status
             END,
    progress     = v_avg,
    completed_at = CASE WHEN v_all_done THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
    hours_earned = CASE WHEN v_all_done THEN COALESCE(v_hours, hours_earned) ELSE hours_earned END,
    updated_at   = NOW()
  WHERE id = v_asg.id;

  -- 完成后同步到参训明细（供统计与一人一档读取）
  IF v_all_done THEN
    SELECT id INTO v_record_id
    FROM public.training_records WHERE plan_id = v_plan_id AND source = 'auto' LIMIT 1;

    IF v_record_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.training_participants tp
         WHERE tp.record_id = v_record_id AND tp.employee_id = v_emp
       ) THEN
      INSERT INTO public.training_participants (
        record_id, employee_id, employee_name, department_id, signed, result
      )
      SELECT v_record_id, e.id, e.name, e.department_id, TRUE, 'pass'
      FROM public.training_employees e WHERE e.id = v_emp;

      UPDATE public.training_records
      SET participant_count = (SELECT COUNT(*) FROM public.training_participants WHERE record_id = v_record_id)
      WHERE id = v_record_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'progress',   round(v_avg, 1),
    'total',      v_total,
    'done',       v_done,
    'completed',  v_all_done
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_save_course_progress(UUID, NUMERIC, NUMERIC) TO authenticated;

-- --------------------------------------------------------------------------
-- 9. 员工端「我的培训」列表
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_my_trainings();
CREATE FUNCTION public.training_my_trainings()
RETURNS TABLE (
  plan_id        UUID,
  title          TEXT,
  category       TEXT,
  deadline       DATE,
  required_hours NUMERIC,
  status         TEXT,
  progress       NUMERIC,
  course_total   INT,
  course_done    INT,
  completed_at   TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.title, p.category, p.deadline, p.required_hours,
         CASE WHEN a.status <> 'completed' AND p.deadline IS NOT NULL AND p.deadline < CURRENT_DATE
              THEN 'overdue' ELSE a.status END,
         a.progress,
         (SELECT COUNT(*)::INT FROM public.training_courses c
           WHERE c.plan_id = p.id AND c.required),
         (SELECT COUNT(*)::INT FROM public.training_courses c
            JOIN public.training_course_progress cp ON cp.course_id = c.id
           WHERE c.plan_id = p.id AND c.required
             AND cp.employee_id = a.employee_id AND cp.finished),
         a.completed_at
  FROM public.training_assignments a
  JOIN public.training_plans p ON p.id = a.plan_id
  WHERE a.user_id = auth.uid()
    AND p.publish_status = 'published'
  ORDER BY (a.status = 'completed'), p.deadline NULLS LAST, p.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.training_my_trainings() TO authenticated;

-- --------------------------------------------------------------------------
-- 10. 计划完成进度（管理员看板）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_plan_progress(UUID);
CREATE FUNCTION public.training_plan_progress(p_plan_id UUID)
RETURNS TABLE (
  total INT, completed INT, learning INT, pending INT, overdue INT, avg_progress NUMERIC
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COUNT(*)::INT,
         COUNT(*) FILTER (WHERE a.status = 'completed')::INT,
         COUNT(*) FILTER (WHERE a.status = 'learning')::INT,
         COUNT(*) FILTER (WHERE a.status = 'pending')::INT,
         COUNT(*) FILTER (WHERE a.status <> 'completed'
                            AND p.deadline IS NOT NULL AND p.deadline < CURRENT_DATE)::INT,
         COALESCE(round(AVG(a.progress), 1), 0)
  FROM public.training_assignments a
  JOIN public.training_plans p ON p.id = a.plan_id
  WHERE a.plan_id = p_plan_id;
$$;

GRANT EXECUTE ON FUNCTION public.training_plan_progress(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 11. 员工账号自助开通（过渡登录：手机号 + 身份证后 6 位）
--     登录名 = 手机号，初始密码 = 身份证后 6 位
--     等微信扫码接入后只换登录入口，user_id 不变，学习记录不丢
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_staff_register(TEXT, TEXT);
CREATE FUNCTION public.training_staff_register(p_phone TEXT, p_id_tail TEXT)
RETURNS JSONB AS $$
DECLARE
  v_emp    public.training_employees%ROWTYPE;
  v_phone  TEXT;
  v_email  TEXT;
  v_uid    UUID;
BEGIN
  v_phone := btrim(COALESCE(p_phone, ''));
  IF v_phone = '' THEN RAISE EXCEPTION '请输入手机号'; END IF;
  IF btrim(COALESCE(p_id_tail, '')) = '' THEN RAISE EXCEPTION '请输入身份证后 6 位'; END IF;

  SELECT * INTO v_emp
  FROM public.training_employees
  WHERE phone = v_phone AND status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN RAISE EXCEPTION '该手机号未登记在员工档案中，请联系管理员'; END IF;
  IF v_emp.id_number IS NULL OR right(btrim(v_emp.id_number), 6) <> btrim(p_id_tail) THEN
    RAISE EXCEPTION '身份信息不匹配，请核对身份证后 6 位';
  END IF;
  IF v_emp.user_id IS NOT NULL THEN
    RAISE EXCEPTION '该手机号已开通，请直接登录';
  END IF;

  v_email := v_phone || '@staff.local';
  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(v_email)) THEN
    RAISE EXCEPTION '登录账号已存在，请直接登录';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    v_email,
    crypt(btrim(p_id_tail), gen_salt('bf', 10)),
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(), now()
  )
  RETURNING id INTO v_uid;

  INSERT INTO public.profiles (id, email, department_id, role, full_name, phone)
  VALUES (v_uid, v_email, v_emp.department_id, 'employee', v_emp.name, v_phone)
  ON CONFLICT (id) DO UPDATE SET
    email         = EXCLUDED.email,
    department_id = EXCLUDED.department_id,
    role          = 'employee',
    full_name     = EXCLUDED.full_name,
    phone         = EXCLUDED.phone;

  UPDATE public.training_employees SET user_id = v_uid WHERE id = v_emp.id;

  RETURN jsonb_build_object('success', true, 'email', v_email, 'user_id', v_uid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION public.training_staff_register(TEXT, TEXT) TO anon, authenticated;

-- --------------------------------------------------------------------------
-- 12. 管理员批量开通 / 重置员工账号
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_staff_reset(UUID);
CREATE FUNCTION public.training_staff_reset(p_employee_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_emp   public.training_employees%ROWTYPE;
  v_email TEXT;
  v_uid   UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION '只有管理员才能执行此操作'; END IF;

  SELECT * INTO v_emp FROM public.training_employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION '员工不存在'; END IF;
  IF v_emp.phone IS NULL OR btrim(v_emp.phone) = '' THEN RAISE EXCEPTION '该员工未登记手机号'; END IF;
  IF v_emp.id_number IS NULL OR length(btrim(v_emp.id_number)) < 6 THEN RAISE EXCEPTION '该员工未登记身份证号'; END IF;

  v_email := btrim(v_emp.phone) || '@staff.local';

  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = lower(v_email);

  IF v_uid IS NULL THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmation_token, recovery_token,
      email_change, email_change_token_new,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
      'authenticated', 'authenticated', v_email,
      crypt(right(btrim(v_emp.id_number), 6), gen_salt('bf', 10)),
      now(), '', '', '', '',
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now()
    ) RETURNING id INTO v_uid;
  ELSE
    UPDATE auth.users
    SET encrypted_password = crypt(right(btrim(v_emp.id_number), 6), gen_salt('bf', 10)),
        updated_at = now()
    WHERE id = v_uid;
  END IF;

  INSERT INTO public.profiles (id, email, department_id, role, full_name, phone)
  VALUES (v_uid, v_email, v_emp.department_id, 'employee', v_emp.name, btrim(v_emp.phone))
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    department_id = EXCLUDED.department_id,
    role = 'employee',
    full_name = EXCLUDED.full_name,
    phone = EXCLUDED.phone;

  UPDATE public.training_employees SET user_id = v_uid WHERE id = p_employee_id;

  RETURN jsonb_build_object('success', true, 'email', v_email, 'user_id', v_uid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION public.training_staff_reset(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 13. RLS
-- --------------------------------------------------------------------------
ALTER TABLE public.training_courses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_assignments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_course_progress   ENABLE ROW LEVEL SECURITY;

-- 课件：参训员工可读；管理员按层级可写
DROP POLICY IF EXISTS "tr_course_select" ON public.training_courses;
CREATE POLICY "tr_course_select" ON public.training_courses
  FOR SELECT TO authenticated
  USING (public.training_can_read_course(plan_id));

DROP POLICY IF EXISTS "tr_course_write" ON public.training_courses;
CREATE POLICY "tr_course_write" ON public.training_courses
  FOR ALL TO authenticated
  USING (
    public.is_admin() AND public.training_can_read(
      (SELECT p.department_id FROM public.training_plans p WHERE p.id = plan_id)
    )
  )
  WITH CHECK (
    public.is_admin() AND public.training_can_read(
      (SELECT p.department_id FROM public.training_plans p WHERE p.id = plan_id)
    )
  );

-- 参训名单：员工只看自己；管理员看管辖内
DROP POLICY IF EXISTS "tr_asg_select" ON public.training_assignments;
CREATE POLICY "tr_asg_select" ON public.training_assignments
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.training_can_read(department_id)
  );

DROP POLICY IF EXISTS "tr_asg_insert" ON public.training_assignments;
CREATE POLICY "tr_asg_insert" ON public.training_assignments
  FOR INSERT TO authenticated
  WITH CHECK (public.training_can_read(department_id));

DROP POLICY IF EXISTS "tr_asg_update" ON public.training_assignments;
CREATE POLICY "tr_asg_update" ON public.training_assignments
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    OR public.training_can_read(department_id)
  );

-- 课件进度：员工自己读写；管理员只读管辖内
DROP POLICY IF EXISTS "tr_cp_select" ON public.training_course_progress;
CREATE POLICY "tr_cp_select" ON public.training_course_progress
  FOR SELECT TO authenticated
  USING (
    employee_id = public.training_my_employee_id()
    OR public.training_can_read(
      (SELECT a.department_id FROM public.training_assignments a WHERE a.id = assignment_id)
    )
  );

DROP POLICY IF EXISTS "tr_cp_insert" ON public.training_course_progress;
CREATE POLICY "tr_cp_insert" ON public.training_course_progress
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = public.training_my_employee_id());

DROP POLICY IF EXISTS "tr_cp_update" ON public.training_course_progress;
CREATE POLICY "tr_cp_update" ON public.training_course_progress
  FOR UPDATE TO authenticated
  USING (employee_id = public.training_my_employee_id());

-- --------------------------------------------------------------------------
-- 14. 课件存储桶
--     注意：自托管 Supabase 默认单文件上限 50MB，视频较大需要在
--     /opt/supabase/docker/.env 里调 storage 的 FILE_SIZE_LIMIT 后重启 storage 容器
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'training-courses') THEN
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('training-courses', 'training-courses', true);
  END IF;
END $$;

DROP POLICY IF EXISTS "training_courses_read" ON storage.objects;
CREATE POLICY "training_courses_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'training-courses');

DROP POLICY IF EXISTS "training_courses_write" ON storage.objects;
CREATE POLICY "training_courses_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'training-courses');

DROP POLICY IF EXISTS "training_courses_manage" ON storage.objects;
CREATE POLICY "training_courses_manage" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'training-courses');

DROP POLICY IF EXISTS "training_courses_delete" ON storage.objects;
CREATE POLICY "training_courses_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'training-courses');

-- ==========================================================================
-- 执行完成后：
--   1. 管理员在「员工档案」里批量导入员工（姓名 / 部门 / 手机号 / 身份证号必填）
--   2. 员工档案里点「开通账号」，员工即可用 手机号 + 身份证后 6 位 登录
--   3. 建培训计划 → 加课件 → 发布（自动展开参训名单）
--   4. 员工登录后进「培训教育」只看得到「我的培训」
-- ==========================================================================

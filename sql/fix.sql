-- ==========================================================================
-- 施工项目月报管理系统 - 登录报错一键修复脚本
-- ==========================================================================
-- 适用场景：登录时提示"用户信息获取失败，请联系管理员"
-- 常见原因：
--   1. SQL 未完整执行（profiles 表不存在）
--   2. 先创建了账号、后执行 SQL（触发器未生效，profiles 无记录）
--   3. RLS 策略缺失导致查询被拒
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴以下全部内容 -> Run
-- 脚本幂等，可重复执行，不会影响已有数据。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 第 1 步：诊断 —— 查看所有账号的 profile 情况（执行后查看结果表）
-- --------------------------------------------------------------------------
SELECT
  au.email                                AS "用户邮箱",
  au.created_at                           AS "账号创建时间",
  CASE WHEN p.id IS NULL THEN '❌ 缺失' ELSE '✅ 正常' END AS "profile记录",
  p.role                                  AS "角色",
  d.name                                  AS "所属部门"
FROM auth.users au
LEFT JOIN public.profiles p     ON p.id = au.id
LEFT JOIN public.departments d  ON d.id = p.department_id
ORDER BY au.created_at DESC;

-- --------------------------------------------------------------------------
-- 第 2 步：确保 profiles 表存在（若已存在则跳过）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email         TEXT,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  role          TEXT NOT NULL DEFAULT 'reporter' CHECK (role IN ('admin', 'reporter')),
  full_name     TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 确保 departments 表存在（若 schema.sql 未执行过）
CREATE TABLE IF NOT EXISTS public.departments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  code        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 补插部门种子数据（若已存在则跳过，不影响已有数据）
INSERT INTO public.departments (name, code, sort_order) VALUES
  ('工程一部',     'DEPT-01', 1), ('工程二部',     'DEPT-02', 2),
  ('工程三部',     'DEPT-03', 3), ('工程四部',     'DEPT-04', 4),
  ('工程五部',     'DEPT-05', 5), ('市政一部',     'DEPT-06', 6),
  ('市政二部',     'DEPT-07', 7), ('建筑一部',     'DEPT-08', 8),
  ('建筑二部',     'DEPT-09', 9), ('建筑三部',     'DEPT-10', 10),
  ('装饰工程部',   'DEPT-11', 11), ('基础设施部',   'DEPT-12', 12),
  ('机电工程部',   'DEPT-13', 13), ('钢结构部',     'DEPT-14', 14),
  ('园林景观部',   'DEPT-15', 15), ('环保工程部',   'DEPT-16', 16),
  ('水利工程部',   'DEPT-17', 17), ('路桥工程部',   'DEPT-18', 18),
  ('隧道工程部',   'DEPT-19', 19), ('管道工程部',   'DEPT-20', 20),
  ('电力工程部',   'DEPT-21', 21), ('通信工程部',   'DEPT-22', 22),
  ('安防工程部',   'DEPT-23', 23), ('检测中心',     'DEPT-24', 24)
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- 第 3 步：确保自动创建 profile 的触发器存在（幂等重建）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- --------------------------------------------------------------------------
-- 第 4 步：核心修复 —— 为所有缺失 profile 的已存在账号补插记录
--          （解决"先创建账号、后执行 SQL"导致的缺失）
-- --------------------------------------------------------------------------
INSERT INTO public.profiles (id, email)
SELECT au.id, au.email
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 第 5 步：确保 RLS 策略存在（幂等重建）
-- --------------------------------------------------------------------------

-- 5.0 管理员判断函数（SECURITY DEFINER 绕过 RLS，修复 42P17 无限递归）
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_reports ENABLE ROW LEVEL SECURITY;

-- 用户可查看/更新自己的 profile
DROP POLICY IF EXISTS "profiles_select_self" ON public.profiles;
CREATE POLICY "profiles_select_self" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
CREATE POLICY "profiles_update_self" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 管理员可查看所有 profile（使用 is_admin() 函数，避免递归）
DROP POLICY IF EXISTS "profiles_select_admin" ON public.profiles;
CREATE POLICY "profiles_select_admin" ON public.profiles
  FOR SELECT TO authenticated USING (public.is_admin());

-- 已登录用户可查看部门列表
DROP POLICY IF EXISTS "departments_select_authenticated" ON public.departments;
CREATE POLICY "departments_select_authenticated" ON public.departments
  FOR SELECT TO authenticated USING (true);

-- project_reports 策略（表不存在时自动创建，避免 DROP POLICY 报错）
CREATE TABLE IF NOT EXISTS public.project_reports (
  id                         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id              UUID REFERENCES public.departments(id) ON DELETE CASCADE NOT NULL,
  project_name               TEXT NOT NULL,
  project_type               TEXT NOT NULL,
  construction_location      TEXT NOT NULL,
  contract_amount            DECIMAL(14,2) NOT NULL,
  duration_months            INTEGER NOT NULL,
  department_entity          TEXT NOT NULL,
  project_manager            TEXT NOT NULL,
  contact_info               TEXT NOT NULL,
  overall_progress           TEXT NOT NULL,
  monthly_construction_status TEXT NOT NULL,
  equipment_models           TEXT NOT NULL,
  on_site_personnel          INTEGER NOT NULL DEFAULT 0,
  on_site_vehicles           INTEGER NOT NULL DEFAULT 0,
  safety_inspection          BOOLEAN NOT NULL DEFAULT FALSE,
  safety_hazards             BOOLEAN NOT NULL DEFAULT FALSE,
  safety_hazard_detail       TEXT,
  reporting_year             INTEGER NOT NULL,
  reporting_month            INTEGER NOT NULL,
  submitted_by               UUID REFERENCES auth.users(id),
  submitted_at               TIMESTAMPTZ DEFAULT NOW(),
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_reporting_month CHECK (reporting_month >= 1 AND reporting_month <= 12),
  CONSTRAINT chk_personnel CHECK (on_site_personnel >= 0),
  CONSTRAINT chk_vehicles CHECK (on_site_vehicles >= 0),
  CONSTRAINT chk_amount CHECK (contract_amount >= 0)
);

DROP POLICY IF EXISTS "reports_select_own_dept" ON public.project_reports;
CREATE POLICY "reports_select_own_dept" ON public.project_reports
  FOR SELECT TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "reports_select_admin" ON public.project_reports;
CREATE POLICY "reports_select_admin" ON public.project_reports
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "reports_insert_own_dept" ON public.project_reports;
CREATE POLICY "reports_insert_own_dept" ON public.project_reports
  FOR INSERT TO authenticated WITH CHECK (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "reports_update_own_dept" ON public.project_reports;
CREATE POLICY "reports_update_own_dept" ON public.project_reports
  FOR UPDATE TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "reports_delete_own_dept" ON public.project_reports;
CREATE POLICY "reports_delete_own_dept" ON public.project_reports
  FOR DELETE TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- 第 6 步：复诊 —— 再次查看修复结果
--          （正常情况下所有账号的 profile 记录应显示"✅ 正常"）
-- --------------------------------------------------------------------------
SELECT
  au.email                                AS "用户邮箱",
  CASE WHEN p.id IS NULL THEN '❌ 仍缺失' ELSE '✅ 正常' END AS "profile记录",
  p.role                                  AS "角色",
  d.name                                  AS "所属部门"
FROM auth.users au
LEFT JOIN public.profiles p     ON p.id = au.id
LEFT JOIN public.departments d  ON d.id = p.department_id
ORDER BY au.created_at DESC;

-- --------------------------------------------------------------------------
-- 修复完成后，若账号仍未分配部门，请执行（把邮箱替换为实际邮箱）：
--
--   UPDATE public.profiles
--   SET department_id = (SELECT id FROM public.departments WHERE name = '工程一部')
--   WHERE email = 'dept01@example.com';
--
-- 如需设置管理员：
--
--   UPDATE public.profiles
--   SET role = 'admin', full_name = '系统管理员'
--   WHERE email = 'admin@example.com';
-- ==========================================================================

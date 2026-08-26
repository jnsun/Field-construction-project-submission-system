-- ==========================================================================
-- 施工项目月报管理系统 - Supabase 数据库 Schema
-- ==========================================================================
-- 使用方法：
-- 1. 登录 Supabase 控制台 -> SQL Editor
-- 2. 复制以下全部内容并执行
-- 3. 执行完毕后，参照 README.md 创建用户账号并分配部门
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 部门表
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.departments (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,           -- 部门名称
  code        TEXT NOT NULL UNIQUE,             -- 部门编码
  sort_order  INTEGER DEFAULT 0,               -- 排序序号
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 2. 用户配置表（扩展 auth.users）
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

-- --------------------------------------------------------------------------
-- 3. 项目月报表（核心数据表）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_reports (
  id                         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id              UUID REFERENCES public.departments(id) ON DELETE CASCADE NOT NULL,
  -- 基础信息
  project_name               TEXT NOT NULL,                              -- 项目名称
  project_type               TEXT NOT NULL,                              -- 项目类型
  construction_location      TEXT NOT NULL,                              -- 施工地点
  contract_amount            DECIMAL(14,2) NOT NULL,                     -- 合同额（万元）
  duration_months            INTEGER NOT NULL,                           -- 工期（月）
  department_entity          TEXT NOT NULL,                               -- 项目归属部门或实体
  project_manager            TEXT NOT NULL,                               -- 项目负责人
  contact_info               TEXT NOT NULL,                               -- 联系方式
  -- 进度与施工情况
  overall_progress           TEXT NOT NULL,                               -- 项目整体进度情况
  monthly_construction_status TEXT NOT NULL,                             -- 本月项目施工情况
  equipment_models           TEXT NOT NULL,                               -- 设备型号及数量
  on_site_personnel          INTEGER NOT NULL DEFAULT 0,                  -- 现场人数
  on_site_vehicles           INTEGER NOT NULL DEFAULT 0,                  -- 现场车辆数
  -- 安全信息
  safety_inspection          BOOLEAN NOT NULL DEFAULT FALSE,              -- 是否进行安全自检
  safety_hazards             BOOLEAN NOT NULL DEFAULT FALSE,              -- 是否存在安全隐患
  safety_hazard_detail       TEXT,                                        -- 隐患详情（存在隐患时填写）
  -- 报送信息
  reporting_year             INTEGER NOT NULL,                            -- 报送年份
  reporting_month            INTEGER NOT NULL,                            -- 报送月份 (1-12)
  submitted_by               UUID REFERENCES auth.users(id),
  submitted_at               TIMESTAMPTZ DEFAULT NOW(),
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW(),
  -- 约束
  CONSTRAINT chk_reporting_month CHECK (reporting_month >= 1 AND reporting_month <= 12),
  CONSTRAINT chk_personnel CHECK (on_site_personnel >= 0),
  CONSTRAINT chk_vehicles CHECK (on_site_vehicles >= 0),
  CONSTRAINT chk_amount CHECK (contract_amount >= 0)
);

-- --------------------------------------------------------------------------
-- 4. 索引
-- --------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_reports_dept_month
  ON public.project_reports(department_id, reporting_year, reporting_month);

CREATE INDEX IF NOT EXISTS idx_reports_year_month
  ON public.project_reports(reporting_year, reporting_month);

CREATE INDEX IF NOT EXISTS idx_reports_submitted_by
  ON public.project_reports(submitted_by);

CREATE INDEX IF NOT EXISTS idx_profiles_department
  ON public.profiles(department_id);

-- --------------------------------------------------------------------------
-- 5. 自动更新 updated_at 函数与触发器
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_reports_updated_at ON public.project_reports;
CREATE TRIGGER trg_reports_updated_at
  BEFORE UPDATE ON public.project_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 6. 用户注册时自动创建 profile 记录
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
-- 7. 行级安全策略 (RLS)
-- --------------------------------------------------------------------------

-- 7.0 管理员判断函数（SECURITY DEFINER 绕过 RLS，避免策略递归 42P17）
--     注意：策略内若直接查询 profiles 表本身会造成无限递归，
--     因此把管理员判断封装为函数，以定义者权限执行
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 7.1 启用 RLS
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_reports ENABLE ROW LEVEL SECURITY;

-- 7.2 departments 策略：所有已登录用户可查看部门列表
DROP POLICY IF EXISTS "departments_select_authenticated" ON public.departments;
CREATE POLICY "departments_select_authenticated" ON public.departments
  FOR SELECT TO authenticated USING (true);

-- 7.3 profiles 策略
-- 用户可查看自己的 profile
DROP POLICY IF EXISTS "profiles_select_self" ON public.profiles;
CREATE POLICY "profiles_select_self" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

-- 用户可更新自己的 profile
DROP POLICY IF EXISTS "profiles_update_self" ON public.profiles;
CREATE POLICY "profiles_update_self" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);

-- 管理员可查看所有 profile
DROP POLICY IF EXISTS "profiles_select_admin" ON public.profiles;
CREATE POLICY "profiles_select_admin" ON public.profiles
  FOR SELECT TO authenticated USING (public.is_admin());

-- 7.4 project_reports 策略
-- 查看：用户只能查看本部门的报送记录
DROP POLICY IF EXISTS "reports_select_own_dept" ON public.project_reports;
CREATE POLICY "reports_select_own_dept" ON public.project_reports
  FOR SELECT TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- 查看：管理员可查看所有记录
DROP POLICY IF EXISTS "reports_select_admin" ON public.project_reports;
CREATE POLICY "reports_select_admin" ON public.project_reports
  FOR SELECT TO authenticated USING (public.is_admin());

-- 新增：用户只能为本部门新增报送
DROP POLICY IF EXISTS "reports_insert_own_dept" ON public.project_reports;
CREATE POLICY "reports_insert_own_dept" ON public.project_reports
  FOR INSERT TO authenticated WITH CHECK (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- 修改：用户只能修改本部门的报送
DROP POLICY IF EXISTS "reports_update_own_dept" ON public.project_reports;
CREATE POLICY "reports_update_own_dept" ON public.project_reports
  FOR UPDATE TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- 删除：用户只能删除本部门的报送
DROP POLICY IF EXISTS "reports_delete_own_dept" ON public.project_reports;
CREATE POLICY "reports_delete_own_dept" ON public.project_reports
  FOR DELETE TO authenticated USING (
    department_id IN (
      SELECT department_id FROM public.profiles WHERE id = auth.uid()
    )
  );

-- --------------------------------------------------------------------------
-- 8. 视图：月度报送汇总状态（方便查询）
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_monthly_summary AS
SELECT
  pr.id,
  pr.project_name,
  pr.project_type,
  pr.construction_location,
  pr.contract_amount,
  pr.duration_months,
  pr.department_entity,
  pr.project_manager,
  pr.contact_info,
  pr.overall_progress,
  pr.monthly_construction_status,
  pr.equipment_models,
  pr.on_site_personnel,
  pr.on_site_vehicles,
  pr.safety_inspection,
  pr.safety_hazards,
  pr.safety_hazard_detail,
  pr.reporting_year,
  pr.reporting_month,
  pr.submitted_at,
  d.name AS department_name,
  d.code AS department_code
FROM public.project_reports pr
JOIN public.departments d ON d.id = pr.department_id;

-- --------------------------------------------------------------------------
-- 9. 种子数据：部门列表（24个部门，可按需修改）
-- --------------------------------------------------------------------------
INSERT INTO public.departments (name, code, sort_order) VALUES
  ('工程一部',     'DEPT-01', 1),
  ('工程二部',     'DEPT-02', 2),
  ('工程三部',     'DEPT-03', 3),
  ('工程四部',     'DEPT-04', 4),
  ('工程五部',     'DEPT-05', 5),
  ('市政一部',     'DEPT-06', 6),
  ('市政二部',     'DEPT-07', 7),
  ('建筑一部',     'DEPT-08', 8),
  ('建筑二部',     'DEPT-09', 9),
  ('建筑三部',     'DEPT-10', 10),
  ('装饰工程部',   'DEPT-11', 11),
  ('基础设施部',   'DEPT-12', 12),
  ('机电工程部',   'DEPT-13', 13),
  ('钢结构部',     'DEPT-14', 14),
  ('园林景观部',   'DEPT-15', 15),
  ('环保工程部',   'DEPT-16', 16),
  ('水利工程部',   'DEPT-17', 17),
  ('路桥工程部',   'DEPT-18', 18),
  ('隧道工程部',   'DEPT-19', 19),
  ('管道工程部',   'DEPT-20', 20),
  ('电力工程部',   'DEPT-21', 21),
  ('通信工程部',   'DEPT-22', 22),
  ('安防工程部',   'DEPT-23', 23),
  ('检测中心',     'DEPT-24', 24)
ON CONFLICT (name) DO NOTHING;

-- ==========================================================================
-- 以下为用户管理说明（需手动执行，请根据实际情况修改）：
--
-- 步骤 A：在 Supabase 控制台 -> Authentication -> Users 页面
--         点击 "Add user" -> "Create new user"
--         为每个部门创建一个账号（邮箱+密码）
--
-- 步骤 B：用户创建后，会自动生成 profile 记录（触发器自动完成）
--         执行以下 SQL 将用户分配到对应部门：
--
--         -- 将某个用户分配到部门（将邮箱替换为实际邮箱）
--         UPDATE public.profiles
--         SET department_id = (
--           SELECT id FROM public.departments WHERE name = '工程一部'
--         )
--         WHERE email = 'dept01@example.com';
--
-- 步骤 C：设置管理员账号
--         -- 将某个用户设为管理员
--         UPDATE public.profiles
--         SET role = 'admin', full_name = '系统管理员'
--         WHERE email = 'admin@example.com';
--
-- 步骤 D：批量查看所有用户与部门分配情况
--         SELECT p.email, p.full_name, p.role, d.name AS department_name
--         FROM public.profiles p
--         LEFT JOIN public.departments d ON d.id = p.department_id
--         ORDER BY p.role DESC, d.sort_order;
-- ==========================================================================

-- ==========================================================================
-- 培训教育模块 v1 - Supabase 数据库 Schema
-- ==========================================================================
-- 依据：《培训教育模块架构设计.docx》，2026-08-31 与用户确认的 v1 范围：
--   · 本期做【Web 版】，在现有安全生产管理系统内实现，不做微信小程序
--   · 员工【只建档案，不登录】：由管理员录入，参训记录由管理员登记
--   · 【v1 就建三级管理员权限】：公司级 / 部门级 / 项目级，各管各的数据
--   · 考试先做【成绩登记版】（题库、在线答题、防作弊留到 v2）
--
-- 前置条件：
--   与月报、证照系统共用同一 Supabase 项目，请先执行 sql/schema.sql
--   （departments / profiles / is_admin()）。本文件幂等，可重复执行。
--
-- 内容：
--   0. 组织层级支撑：departments 增加 parent_id / dept_type
--   1. 管理员级别：profiles 增加 admin_level（company / dept / project）
--   2. 权限函数：管辖部门集合（递归下级）、可写判断
--   3. training_employees        员工档案（一人一档）
--   4. training_plans           培训计划（三级各自创建）
--   5. training_plan_targets    计划适用范围（下发到哪些部门）
--   6. training_records         培训记录（一次培训的实际实施）
--   7. training_participants    参训人员明细（含签到/成绩）
--   8. training_exams           考试登记（v1：只登记成绩）
--   9. RLS：读按管辖范围，写仅本层级管理员
--
-- 使用方法：
--   云 Supabase（Pages 测试）与服务器自建库执行【同一份文件】。
--   Supabase 控制台 -> SQL Editor -> 复制全部 -> Run
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 组织层级支撑
--    parent_id：上级部门（部门经营实体 -> 其下属项目部）
--    dept_type：company 公司 / entity 部门经营实体 / project 项目部
--    说明：现有 25 个部门保持扁平也能用（parent_id 为空即视为同级），
--          后续在「部门维护」里补齐上下级即可自动获得层级数据权限。
-- --------------------------------------------------------------------------
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.departments(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='departments' AND column_name='dept_type'
  ) THEN
    ALTER TABLE public.departments
      ADD COLUMN dept_type TEXT NOT NULL DEFAULT 'entity'
      CHECK (dept_type IN ('company', 'entity', 'project'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_departments_parent ON public.departments(parent_id);

-- --------------------------------------------------------------------------
-- 1. 管理员级别
--    admin_level：company 公司级（安全生产部） / dept 部门级 / project 项目级
--    超级管理员（is_super_admin = true）等同 company 级，无需单独设置。
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='profiles' AND column_name='admin_level'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN admin_level TEXT CHECK (admin_level IN ('company', 'dept', 'project'));
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 2. 权限函数
-- --------------------------------------------------------------------------

-- 2.1 当前用户所属部门
CREATE OR REPLACE FUNCTION public.training_my_dept_id()
RETURNS UUID AS $$
  SELECT department_id FROM public.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2.2 当前用户是否为「公司级」管理员（含超级管理员）
CREATE OR REPLACE FUNCTION public.training_is_company_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND (is_super_admin IS TRUE OR admin_level = 'company')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2.3 当前用户管辖的部门集合（自己部门 + 所有下级部门；公司级 = 全部）
CREATE OR REPLACE FUNCTION public.training_visible_dept_ids()
RETURNS SETOF UUID AS $$
  WITH RECURSIVE mine AS (
    SELECT public.training_my_dept_id() AS id
    UNION ALL
    SELECT d.id FROM public.departments d JOIN mine ON d.parent_id = mine.id
  )
  SELECT id FROM mine WHERE id IS NOT NULL
  UNION
  SELECT id FROM public.departments WHERE public.training_is_company_admin();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 2.4 是否可写某部门的数据（仅管理员，且该部门在管辖范围内）
CREATE OR REPLACE FUNCTION public.training_can_write(target_dept UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
     AND (target_dept IS NULL OR target_dept IN (SELECT public.training_visible_dept_ids()));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 3. 员工档案（一人一档；v1 员工本人不登录）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_employees (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name          TEXT        NOT NULL,
  employee_no   TEXT,                       -- 工号
  department_id UUID        REFERENCES public.departments(id) ON DELETE SET NULL,
  position      TEXT,                       -- 岗位 / 工种
  id_number     TEXT,                       -- 身份证号（展示时前端脱敏）
  phone         TEXT,
  hire_date     DATE,                       -- 入场 / 入职日期
  emp_type      TEXT        NOT NULL DEFAULT 'employee'
                CHECK (emp_type IN ('employee', 'special', 'manager')),
  status        TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'left')),
  remark        TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_emp_dept   ON public.training_employees(department_id);
CREATE INDEX IF NOT EXISTS idx_tr_emp_name   ON public.training_employees(name);
CREATE INDEX IF NOT EXISTS idx_tr_emp_status ON public.training_employees(status);

-- --------------------------------------------------------------------------
-- 4. 培训计划（三级各自创建；level 标记创建层级）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_plans (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title         TEXT        NOT NULL,
  category      TEXT,                        -- 入场三级教育/年度再培训/专项培训/特种作业/其他
  level         TEXT        NOT NULL DEFAULT 'dept'
                CHECK (level IN ('company', 'dept', 'project')),
  department_id UUID        REFERENCES public.departments(id) ON DELETE CASCADE,
  parent_plan_id UUID       REFERENCES public.training_plans(id) ON DELETE SET NULL,  -- 上级下发来的计划
  plan_year     INT         NOT NULL,
  plan_month    INT,
  start_date    DATE,
  end_date      DATE,
  hours         NUMERIC(5,1),                -- 计划学时
  trainer       TEXT,                        -- 讲师 / 组织单位
  location      TEXT,
  target_desc   TEXT,                        -- 适用对象说明（全员/指定部门/指定人员）
  content       TEXT,                        -- 培训内容摘要
  require_exam  BOOLEAN     NOT NULL DEFAULT FALSE,   -- 是否需要考试（v2 联动）
  status        TEXT        NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned', 'ongoing', 'done', 'cancelled')),
  remark        TEXT,
  created_by    UUID        REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_plan_dept  ON public.training_plans(department_id);
CREATE INDEX IF NOT EXISTS idx_tr_plan_year  ON public.training_plans(plan_year, plan_month);
CREATE INDEX IF NOT EXISTS idx_tr_plan_level ON public.training_plans(level);

-- --------------------------------------------------------------------------
-- 5. 计划适用范围（下发到哪些部门）
--    来源：上级计划下发 / 本计划指定参加部门
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_plan_targets (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id       UUID        NOT NULL REFERENCES public.training_plans(id) ON DELETE CASCADE,
  department_id UUID        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  due_date      DATE,                        -- 要求完成日期
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_tr_target_dept ON public.training_plan_targets(department_id);

-- --------------------------------------------------------------------------
-- 6. 培训记录（一次培训的实际实施情况）
--    可由计划转化（plan_id），也可独立登记临时培训
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_records (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id        UUID REFERENCES public.training_plans(id) ON DELETE SET NULL,
  title          TEXT        NOT NULL,
  train_date     DATE        NOT NULL,
  hours          NUMERIC(5,1),
  trainer        TEXT,
  location       TEXT,
  department_id  UUID        REFERENCES public.departments(id) ON DELETE SET NULL,
  content        TEXT,
  participant_count INT      NOT NULL DEFAULT 0,   -- 由参训明细维护时同步
  sign_method    TEXT        NOT NULL DEFAULT 'manual'
                 CHECK (sign_method IN ('manual', 'sign_sheet', 'photo', 'gps')),
  remark         TEXT,
  created_by     UUID        REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_rec_dept ON public.training_records(department_id);
CREATE INDEX IF NOT EXISTS idx_tr_rec_date ON public.training_records(train_date);
CREATE INDEX IF NOT EXISTS idx_tr_rec_plan ON public.training_records(plan_id);

-- --------------------------------------------------------------------------
-- 7. 参训人员明细（含签到与成绩）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_participants (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  record_id      UUID        NOT NULL REFERENCES public.training_records(id) ON DELETE CASCADE,
  employee_id    UUID        REFERENCES public.training_employees(id) ON DELETE SET NULL,
  employee_name  TEXT        NOT NULL,          -- 姓名快照（员工档案删除后仍留痕）
  department_id  UUID        REFERENCES public.departments(id) ON DELETE SET NULL,
  signed         BOOLEAN     NOT NULL DEFAULT TRUE,   -- 是否签到
  score          NUMERIC(5,1),                        -- 成绩（无考试时可空）
  result         TEXT        NOT NULL DEFAULT 'unknown'
                 CHECK (result IN ('pass', 'fail', 'absent', 'unknown')),
  remark         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_part_record ON public.training_participants(record_id);
CREATE INDEX IF NOT EXISTS idx_tr_part_emp    ON public.training_participants(employee_id);

-- --------------------------------------------------------------------------
-- 8. 考试登记（v1：只登记成绩，不做在线答题）
--    pass_rate = pass_count / participant_count，前端计算展示
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_exams (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  record_id         UUID REFERENCES public.training_records(id) ON DELETE CASCADE,
  exam_name         TEXT        NOT NULL,
  exam_date         DATE        NOT NULL,
  department_id     UUID        REFERENCES public.departments(id) ON DELETE SET NULL,
  participant_count INT         NOT NULL DEFAULT 0,   -- 参考人数
  pass_count        INT         NOT NULL DEFAULT 0,   -- 合格人数
  pass_line         NUMERIC(5,1) DEFAULT 60,          -- 合格线
  remark            TEXT,
  created_by        UUID        REFERENCES auth.users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_exam_record ON public.training_exams(record_id);
CREATE INDEX IF NOT EXISTS idx_tr_exam_date   ON public.training_exams(exam_date);

-- --------------------------------------------------------------------------
-- 9. updated_at 触发器
-- --------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_tr_emp_updated   ON public.training_employees;
CREATE TRIGGER trg_tr_emp_updated   BEFORE UPDATE ON public.training_employees
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_tr_plan_updated  ON public.training_plans;
CREATE TRIGGER trg_tr_plan_updated  BEFORE UPDATE ON public.training_plans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_tr_rec_updated   ON public.training_records;
CREATE TRIGGER trg_tr_rec_updated   BEFORE UPDATE ON public.training_records
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_tr_exam_updated  ON public.training_exams;
CREATE TRIGGER trg_tr_exam_updated  BEFORE UPDATE ON public.training_exams
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 10. RLS 行级安全
--     读：登录用户可读「本层级管辖范围内」的数据
--     写：仅管理员，且目标部门在管辖范围内
-- --------------------------------------------------------------------------
ALTER TABLE public.training_employees     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_plans         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_plan_targets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_exams         ENABLE ROW LEVEL SECURITY;

-- 10.1 员工档案
DROP POLICY IF EXISTS "tr_emp_select" ON public.training_employees;
CREATE POLICY "tr_emp_select" ON public.training_employees
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));

DROP POLICY IF EXISTS "tr_emp_insert" ON public.training_employees;
CREATE POLICY "tr_emp_insert" ON public.training_employees
  FOR INSERT TO authenticated WITH CHECK (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_emp_update" ON public.training_employees;
CREATE POLICY "tr_emp_update" ON public.training_employees
  FOR UPDATE TO authenticated USING (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_emp_delete" ON public.training_employees;
CREATE POLICY "tr_emp_delete" ON public.training_employees
  FOR DELETE TO authenticated USING (public.training_can_write(department_id));

-- 10.2 培训计划：公司级计划对所有已登录用户可见
DROP POLICY IF EXISTS "tr_plan_select" ON public.training_plans;
CREATE POLICY "tr_plan_select" ON public.training_plans
  FOR SELECT TO authenticated
  USING (
    department_id IN (SELECT public.training_visible_dept_ids())
    OR level = 'company'
    OR id IN (
      SELECT pt.plan_id FROM public.training_plan_targets pt
      WHERE pt.department_id IN (SELECT public.training_visible_dept_ids())
    )
  );

DROP POLICY IF EXISTS "tr_plan_insert" ON public.training_plans;
CREATE POLICY "tr_plan_insert" ON public.training_plans
  FOR INSERT TO authenticated WITH CHECK (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_plan_update" ON public.training_plans;
CREATE POLICY "tr_plan_update" ON public.training_plans
  FOR UPDATE TO authenticated USING (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_plan_delete" ON public.training_plans;
CREATE POLICY "tr_plan_delete" ON public.training_plans
  FOR DELETE TO authenticated USING (public.training_can_write(department_id));

-- 10.3 计划适用范围
DROP POLICY IF EXISTS "tr_target_select" ON public.training_plan_targets;
CREATE POLICY "tr_target_select" ON public.training_plan_targets
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));

DROP POLICY IF EXISTS "tr_target_write" ON public.training_plan_targets;
CREATE POLICY "tr_target_write" ON public.training_plan_targets
  FOR ALL TO authenticated
  USING (
    public.is_admin() AND EXISTS (
      SELECT 1 FROM public.training_plans p
      WHERE p.id = plan_id AND public.training_can_write(p.department_id)
    )
  )
  WITH CHECK (
    public.is_admin() AND EXISTS (
      SELECT 1 FROM public.training_plans p
      WHERE p.id = plan_id AND public.training_can_write(p.department_id)
    )
  );

-- 10.4 培训记录
DROP POLICY IF EXISTS "tr_rec_select" ON public.training_records;
CREATE POLICY "tr_rec_select" ON public.training_records
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));

DROP POLICY IF EXISTS "tr_rec_insert" ON public.training_records;
CREATE POLICY "tr_rec_insert" ON public.training_records
  FOR INSERT TO authenticated WITH CHECK (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_rec_update" ON public.training_records;
CREATE POLICY "tr_rec_update" ON public.training_records
  FOR UPDATE TO authenticated USING (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_rec_delete" ON public.training_records;
CREATE POLICY "tr_rec_delete" ON public.training_records
  FOR DELETE TO authenticated USING (public.training_can_write(department_id));

-- 10.5 参训人员明细：跟随所属培训记录的权限
DROP POLICY IF EXISTS "tr_part_select" ON public.training_participants;
CREATE POLICY "tr_part_select" ON public.training_participants
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.training_records r
    WHERE r.id = record_id
      AND r.department_id IN (SELECT public.training_visible_dept_ids())
  ));

DROP POLICY IF EXISTS "tr_part_write" ON public.training_participants;
CREATE POLICY "tr_part_write" ON public.training_participants
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.training_records r
    WHERE r.id = record_id AND public.training_can_write(r.department_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.training_records r
    WHERE r.id = record_id AND public.training_can_write(r.department_id)
  ));

-- 10.6 考试登记
DROP POLICY IF EXISTS "tr_exam_select" ON public.training_exams;
CREATE POLICY "tr_exam_select" ON public.training_exams
  FOR SELECT TO authenticated
  USING (
    department_id IN (SELECT public.training_visible_dept_ids())
    OR (record_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.training_records r
      WHERE r.id = record_id
        AND r.department_id IN (SELECT public.training_visible_dept_ids())
    ))
  );

DROP POLICY IF EXISTS "tr_exam_insert" ON public.training_exams;
CREATE POLICY "tr_exam_insert" ON public.training_exams
  FOR INSERT TO authenticated WITH CHECK (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_exam_update" ON public.training_exams;
CREATE POLICY "tr_exam_update" ON public.training_exams
  FOR UPDATE TO authenticated USING (public.training_can_write(department_id));

DROP POLICY IF EXISTS "tr_exam_delete" ON public.training_exams;
CREATE POLICY "tr_exam_delete" ON public.training_exams
  FOR DELETE TO authenticated USING (public.training_can_write(department_id));

-- ==========================================================================
-- 执行完成后请做两件事：
--   1. 给现有管理员账号设置级别（超级管理员无需设置）：
--      UPDATE public.profiles SET admin_level = 'dept' WHERE email = '某部门管理员@qq.com';
--   2. 如需三级数据隔离，在部门维护里补齐 departments.parent_id（部门 -> 项目部）
-- ==========================================================================

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
-- ⚠️ 这里绝不能用 FOR ALL：FOR ALL 会覆盖 SELECT，若 SELECT 策略里再引用
--    training_plans，就会和 training_plans 的策略互相触发，报
--    "infinite recursion detected in policy for relation training_plans"。
--    正确做法：SELECT 只看自身字段，写操作（INSERT/UPDATE/DELETE）才回查 training_plans。
DROP POLICY IF EXISTS "tr_target_select" ON public.training_plan_targets;
CREATE POLICY "tr_target_select" ON public.training_plan_targets
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));

DROP POLICY IF EXISTS "tr_target_write" ON public.training_plan_targets;

DROP POLICY IF EXISTS "tr_target_insert" ON public.training_plan_targets;
CREATE POLICY "tr_target_insert" ON public.training_plan_targets
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin() AND EXISTS (
      SELECT 1 FROM public.training_plans p
      WHERE p.id = plan_id AND public.training_can_write(p.department_id)
    )
  );

DROP POLICY IF EXISTS "tr_target_update" ON public.training_plan_targets;
CREATE POLICY "tr_target_update" ON public.training_plan_targets
  FOR UPDATE TO authenticated
  USING (
    public.is_admin() AND EXISTS (
      SELECT 1 FROM public.training_plans p
      WHERE p.id = plan_id AND public.training_can_write(p.department_id)
    )
  );

DROP POLICY IF EXISTS "tr_target_delete" ON public.training_plan_targets;
CREATE POLICY "tr_target_delete" ON public.training_plan_targets
  FOR DELETE TO authenticated
  USING (
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
-- 11. v1.1 升级：计划下发 → 部门上报完成 → 自动生成培训记录
--     业务口径（2026-08-31 与用户确认）：
--       · 培训记录主要由「计划执行上报」自动产生，而不是手工从零录入
--       · 上报时按部门档案一键带入在职员工为参训人员
--       · 需要「一人一档」：可查看某员工历年培训与考试成绩
-- --------------------------------------------------------------------------

-- 11.1 计划下发行（计划 × 部门）增加执行字段
ALTER TABLE public.training_plan_targets
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reported', 'skipped')),
  ADD COLUMN IF NOT EXISTS record_id UUID REFERENCES public.training_records(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS actual_date DATE,
  ADD COLUMN IF NOT EXISTS hours NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS participant_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sign_method TEXT DEFAULT 'manual'
    CHECK (sign_method IN ('manual', 'sign_sheet', 'photo', 'gps')),
  ADD COLUMN IF NOT EXISTS trainer TEXT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS reported_by UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remark TEXT;

CREATE INDEX IF NOT EXISTS idx_tr_target_status ON public.training_plan_targets(status);

-- 11.2 培训记录标记来源（auto = 由计划上报自动生成；manual = 手工登记）
ALTER TABLE public.training_records
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS plan_target_id UUID
    REFERENCES public.training_plan_targets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tr_rec_source ON public.training_records(source);

-- 11.3 考试登记标记来源（计划要求考试时自动生成待填记录）
ALTER TABLE public.training_exams
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('auto', 'manual')),
  ADD COLUMN IF NOT EXISTS plan_target_id UUID
    REFERENCES public.training_plan_targets(id) ON DELETE SET NULL;

-- 11.4 RPC：上报完成（一个事务内完成：建记录 → 带入参训人员 → 回写下发行 → 需要考试时建考试）
--     权限：仅管理员，且该部门在管辖范围内
DROP FUNCTION IF EXISTS public.training_report_complete(UUID, DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.training_report_complete(
  p_target_id   UUID,
  p_actual_date DATE,
  p_hours       NUMERIC,
  p_sign_method TEXT,
  p_trainer     TEXT,
  p_location    TEXT,
  p_content     TEXT
) RETURNS UUID AS $$
DECLARE
  v_target   public.training_plan_targets%ROWTYPE;
  v_plan     public.training_plans%ROWTYPE;
  v_record_id UUID;
  v_count    INT := 0;
BEGIN
  SELECT * INTO v_target FROM public.training_plan_targets WHERE id = p_target_id;
  IF NOT FOUND THEN RAISE EXCEPTION '下发记录不存在'; END IF;

  SELECT * INTO v_plan FROM public.training_plans WHERE id = v_target.plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '关联培训计划不存在'; END IF;

  IF NOT public.training_can_write(v_target.department_id) THEN
    RAISE EXCEPTION '无权限上报该部门的培训完成情况';
  END IF;

  IF v_target.status = 'reported' AND v_target.record_id IS NOT NULL THEN
    RAISE EXCEPTION '该部门已上报完成，如需修改请直接编辑对应的培训记录';
  END IF;

  -- 1) 生成培训记录
  INSERT INTO public.training_records (
    plan_id, plan_target_id, title, train_date, hours, trainer, location,
    department_id, content, source, sign_method, created_by
  ) VALUES (
    v_plan.id, v_target.id, v_plan.title,
    COALESCE(p_actual_date, CURRENT_DATE), p_hours,
    COALESCE(p_trainer, v_plan.trainer), COALESCE(p_location, v_plan.location),
    v_target.department_id, COALESCE(p_content, v_plan.content),
    'auto', COALESCE(p_sign_method, 'manual'), auth.uid()
  ) RETURNING id INTO v_record_id;

  -- 2) 按部门档案一键带入在职员工为参训人员
  INSERT INTO public.training_participants (
    record_id, employee_id, employee_name, department_id, signed, result
  )
  SELECT v_record_id, e.id, e.name, e.department_id, TRUE, 'unknown'
  FROM public.training_employees e
  WHERE e.department_id = v_target.department_id AND e.status = 'active';

  SELECT COUNT(*) INTO v_count
  FROM public.training_participants WHERE record_id = v_record_id;

  UPDATE public.training_records SET participant_count = v_count WHERE id = v_record_id;

  -- 3) 回写下发行状态
  UPDATE public.training_plan_targets SET
    status = 'reported',
    record_id = v_record_id,
    actual_date = COALESCE(p_actual_date, CURRENT_DATE),
    hours = p_hours,
    participant_count = v_count,
    sign_method = COALESCE(p_sign_method, 'manual'),
    trainer = COALESCE(p_trainer, v_plan.trainer),
    location = COALESCE(p_location, v_plan.location),
    content = COALESCE(p_content, v_plan.content),
    reported_by = auth.uid(),
    reported_at = NOW()
  WHERE id = p_target_id;

  -- 4) 计划要求考试时，自动生成一条待填的考试登记
  IF v_plan.require_exam THEN
    INSERT INTO public.training_exams (
      record_id, plan_target_id, exam_name, exam_date, department_id,
      participant_count, pass_count, pass_line, source, created_by
    ) VALUES (
      v_record_id, v_target.id, v_plan.title || ' 考试',
      COALESCE(p_actual_date, CURRENT_DATE), v_target.department_id,
      v_count, 0, 60, 'auto', auth.uid()
    );
  END IF;

  RETURN v_record_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_report_complete(UUID, DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 11.5 RPC：查询某员工的个人培训档案（一人一档）
DROP FUNCTION IF EXISTS public.training_employee_history(UUID);
CREATE FUNCTION public.training_employee_history(p_employee_id UUID)
RETURNS TABLE (
  record_id     UUID,
  train_date    DATE,
  title         TEXT,
  hours         NUMERIC,
  signed        BOOLEAN,
  score         NUMERIC,
  result        TEXT,
  department_id UUID
) AS $$
  SELECT r.id, r.train_date, r.title, r.hours, p.signed, p.score, p.result, r.department_id
  FROM public.training_participants p
  JOIN public.training_records r ON r.id = p.record_id
  WHERE p.employee_id = p_employee_id
  ORDER BY r.train_date DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_employee_history(UUID) TO authenticated;

-- ==========================================================================
-- 执行完成后请做三件事：
--   1. 给现有管理员账号设置级别（超级管理员无需设置）：
--      UPDATE public.profiles SET admin_level = 'dept' WHERE email = '某部门管理员@qq.com';
--   2. 如需三级数据隔离，在部门维护里补齐 departments.parent_id（部门 -> 项目部）
--   3. 老数据补标来源（可选）：
--      UPDATE public.training_records SET source = 'manual' WHERE source IS NULL;
-- ==========================================================================

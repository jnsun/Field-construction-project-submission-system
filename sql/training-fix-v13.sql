-- ==========================================================================
-- 培训教育模块 —— 权限补丁 v1.3（可单独执行，也可重复执行）
--
-- 解决的问题（2026-08-31 排障结论）：
--   ① 部门为空的数据「存得进去、读不出来」—— 保存成功但列表 0 条
--   ② 未设置 admin_level 的管理员，可见部门为空 —— 各列表全部空白
--   ③ 计划适用范围（下发部门）策略递归 —— infinite recursion detected
--   ④ 上报时才能决定「本次是否组织考试」—— 建计划忘勾选就没有考试记录
--
-- 执行方式：Supabase 控制台 → SQL Editor → 粘贴 → Run
-- （如果前面已经完整跑过 training-management.sql，直接跑这一个文件即可）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 兜底：未配置 admin_level 的管理员暂按「公司级」处理
--    避免出现「管理员登录进来所有列表都是空的」。
--    后续在账号上设置 admin_level 后会自动收紧为公司级 / 部门级 / 项目级。
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.training_is_company_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role = 'admin'
      AND (is_super_admin IS TRUE OR COALESCE(admin_level, 'company') = 'company')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 2. 统一的「可读」判定
--    旧写法 `department_id IN (可见部门)` 在 department_id 为 NULL 时求值为
--    NULL（不通过），导致这类记录对谁都不可见。这里显式处理 NULL：
--    部门为空的数据只有公司级能看到。
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.training_can_read(p_dept UUID)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN p_dept IS NULL THEN public.training_is_company_admin()
    ELSE p_dept IN (SELECT public.training_visible_dept_ids())
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 3. 递归治理：把「跨表查询」装进 SECURITY DEFINER 函数，
--    策略里不再直接查另一张表，彻底断掉 policy 互相触发的递归
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.training_shared_plan_ids()
RETURNS SETOF UUID AS $$
  SELECT plan_id FROM public.training_plan_targets
  WHERE department_id IN (SELECT public.training_visible_dept_ids());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_can_write_plan(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin() AND EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id = p_plan_id
      AND (p.department_id IS NULL
           OR p.department_id IN (SELECT public.training_visible_dept_ids()))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 清理历史遗留的 FOR ALL 策略（它会覆盖 SELECT 并引发递归）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname='public' AND tablename='training_plan_targets'
               AND policyname='tr_target_write') THEN
    EXECUTE 'DROP POLICY "tr_target_write" ON public.training_plan_targets';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 4. 重写全部读策略
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS "tr_emp_select" ON public.training_employees;
CREATE POLICY "tr_emp_select" ON public.training_employees
  FOR SELECT TO authenticated
  USING (public.training_can_read(department_id));

DROP POLICY IF EXISTS "tr_plan_select" ON public.training_plans;
CREATE POLICY "tr_plan_select" ON public.training_plans
  FOR SELECT TO authenticated
  USING (
    public.training_can_read(department_id)
    OR level = 'company'
    OR id IN (SELECT public.training_shared_plan_ids())
  );

DROP POLICY IF EXISTS "tr_target_select" ON public.training_plan_targets;
CREATE POLICY "tr_target_select" ON public.training_plan_targets
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));

DROP POLICY IF EXISTS "tr_target_insert" ON public.training_plan_targets;
CREATE POLICY "tr_target_insert" ON public.training_plan_targets
  FOR INSERT TO authenticated
  WITH CHECK (public.training_can_write_plan(plan_id));

DROP POLICY IF EXISTS "tr_target_update" ON public.training_plan_targets;
CREATE POLICY "tr_target_update" ON public.training_plan_targets
  FOR UPDATE TO authenticated
  USING (public.training_can_write_plan(plan_id));

DROP POLICY IF EXISTS "tr_target_delete" ON public.training_plan_targets;
CREATE POLICY "tr_target_delete" ON public.training_plan_targets
  FOR DELETE TO authenticated
  USING (public.training_can_write_plan(plan_id));

DROP POLICY IF EXISTS "tr_rec_select" ON public.training_records;
CREATE POLICY "tr_rec_select" ON public.training_records
  FOR SELECT TO authenticated
  USING (public.training_can_read(department_id));

DROP POLICY IF EXISTS "tr_part_select" ON public.training_participants;
CREATE POLICY "tr_part_select" ON public.training_participants
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.training_records r
    WHERE r.id = record_id AND public.training_can_read(r.department_id)
  ));

DROP POLICY IF EXISTS "tr_exam_select" ON public.training_exams;
CREATE POLICY "tr_exam_select" ON public.training_exams
  FOR SELECT TO authenticated
  USING (
    public.training_can_read(department_id)
    OR (record_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.training_records r
      WHERE r.id = record_id AND public.training_can_read(r.department_id)
    ))
  );

-- --------------------------------------------------------------------------
-- 5. 上报 RPC 增加「本次是否组织考试」参数
--    p_with_exam 传 NULL 时跟随计划上的「需要考试」设置
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_report_complete(UUID, DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.training_report_complete(UUID, DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.training_report_complete(
  p_target_id   UUID,
  p_actual_date DATE,
  p_hours       NUMERIC,
  p_sign_method TEXT,
  p_trainer     TEXT,
  p_location    TEXT,
  p_content     TEXT,
  p_with_exam   BOOLEAN DEFAULT NULL
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

  -- 4) 需要考试时自动生成一条待填的考试登记
  IF COALESCE(p_with_exam, v_plan.require_exam) THEN
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

GRANT EXECUTE ON FUNCTION public.training_report_complete(UUID, DATE, NUMERIC, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- --------------------------------------------------------------------------
-- 6. 权限自检（页面「统计概览」会显示；也可单独执行 SELECT * FROM public.training_debug_me();）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_debug_me();
CREATE FUNCTION public.training_debug_me()
RETURNS TABLE (
  email              TEXT,
  role               TEXT,
  is_super_admin     BOOLEAN,
  admin_level        TEXT,
  dept_name          TEXT,
  is_company_admin   BOOLEAN,
  visible_dept_count BIGINT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.email, p.role, p.is_super_admin, p.admin_level, d.name,
         public.training_is_company_admin(),
         (SELECT COUNT(*) FROM public.training_visible_dept_ids())
  FROM public.profiles p
  LEFT JOIN public.departments d ON d.id = p.department_id
  WHERE p.id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.training_debug_me() TO authenticated;

-- ==========================================================================
-- 执行完后：刷新页面 → 培训教育 → 统计概览，最下方「当前账号权限自检」
-- 应显示：级别 公司级 / 可见部门 25 个。若可见部门为 0，说明该账号没配
-- admin_level 也没归属部门，执行：
--   UPDATE public.profiles SET admin_level = 'company' WHERE email = '你的账号@qq.com';
-- ==========================================================================

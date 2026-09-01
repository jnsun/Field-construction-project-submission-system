-- ============================================================================
-- 统计分析模块 v1 — sql/statistics-module.sql
-- 依赖：training-management.sql / training-online-v2.sql / training-content-library.sql
--       / exam-module.sql（先跑）；certificate-management.sql 可后补（持证率自动降级）
-- 权限：全部 RPC = SECURITY DEFINER + search_path 锁定 + 入口管辖校验
--       （复用 training_visible_dept_ids()，dept 级穿透非管辖部门服务端直接拒绝）
-- 幂等：可重复执行
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 阈值配置（全局一行）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stats_settings (
  id                  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  completion_threshold numeric NOT NULL DEFAULT 80,   -- 单位完成率预警阈值 %
  overdue_grace_days   int    NOT NULL DEFAULT 7,     -- 个人逾期宽限天数
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.stats_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.stats_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stats_settings_admin" ON public.stats_settings;
CREATE POLICY "stats_settings_admin" ON public.stats_settings
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ----------------------------------------------------------------------------
-- 2. 持证率基准数（公司级维护；未配置的部门持证率显示 "—" 不按 0 误读）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stats_cert_targets (
  department_id uuid PRIMARY KEY REFERENCES public.departments(id) ON DELETE CASCADE,
  target_count  int NOT NULL CHECK (target_count >= 0),
  updated_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stats_cert_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stats_ct_select" ON public.stats_cert_targets;
CREATE POLICY "stats_ct_select" ON public.stats_cert_targets
  FOR SELECT TO authenticated
  USING (department_id IN (SELECT public.training_visible_dept_ids()));
DROP POLICY IF EXISTS "stats_ct_write" ON public.stats_cert_targets;
CREATE POLICY "stats_ct_write" ON public.stats_cert_targets
  FOR ALL TO authenticated
  USING (public.training_is_company_admin())
  WITH CHECK (public.training_is_company_admin());

-- ----------------------------------------------------------------------------
-- 3. 预警信箱（懒计算落库）+ 已读表
--    dedup_key 保证同一问题每管理员每月只推一次
--    分发 = stats_alert_inbox() 按 training_visible_dept_ids() 交集收取
--    （项目部级问题其上级实体/公司级管理员同样可见，天然实现管理链分发）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stats_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type    text NOT NULL CHECK (alert_type IN ('unit_completion', 'person_overdue')),
  department_id uuid,                       -- 预警归属部门（分发依据）
  employee_id   uuid,                       -- 个人预警对象（单位预警为空）
  plan_id       uuid,
  payload       jsonb NOT NULL,             -- 快照：名称/完成率/逾期天数等展示数据
  dedup_key     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stats_alerts_dedup ON public.stats_alerts(dedup_key);
CREATE INDEX IF NOT EXISTS idx_stats_alerts_dept ON public.stats_alerts(department_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.stats_alert_reads (
  alert_id   uuid NOT NULL REFERENCES public.stats_alerts(id) ON DELETE CASCADE,
  admin_uid  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, admin_uid)
);

ALTER TABLE public.stats_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stats_alerts_select" ON public.stats_alerts;
CREATE POLICY "stats_alerts_select" ON public.stats_alerts
  FOR SELECT TO authenticated
  USING (public.is_admin());
DROP POLICY IF EXISTS "stats_alerts_insert" ON public.stats_alerts;
CREATE POLICY "stats_alerts_insert" ON public.stats_alerts
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "stats_alerts_delete" ON public.stats_alerts;
CREATE POLICY "stats_alerts_delete" ON public.stats_alerts
  FOR DELETE TO authenticated USING (public.is_admin());

ALTER TABLE public.stats_alert_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stats_reads_owner" ON public.stats_alert_reads;
CREATE POLICY "stats_reads_owner" ON public.stats_alert_reads
  FOR ALL TO authenticated
  USING (admin_uid = auth.uid()) WITH CHECK (admin_uid = auth.uid());

GRANT SELECT ON public.stats_settings TO authenticated;
GRANT SELECT ON public.stats_cert_targets TO authenticated;
GRANT SELECT ON public.stats_alerts TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. 辅助：管辖范围（入口校验 + 范围展开）
-- ----------------------------------------------------------------------------

-- 4.1 p_dept 是否在当前管理员管辖范围内（公司级全量由 visible_dept_ids 兜底）
CREATE OR REPLACE FUNCTION public.stats_can_access(p_dept uuid)
RETURNS boolean AS $$
  SELECT p_dept IS NOT NULL
     AND p_dept IN (SELECT public.training_visible_dept_ids());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 4.2 统计范围部门集合：p_dept 为空 → 全部管辖部门；否则 p_dept 的递归子树
--     （入口已校验 p_dept ⊆ 管辖集，子树必为其子集）
CREATE OR REPLACE FUNCTION public.stats_scope_depts(p_dept uuid)
RETURNS SETOF uuid AS $$
  WITH RECURSIVE tree AS (
    SELECT p_dept AS id
    UNION ALL
    SELECT d.id FROM public.departments d
      JOIN tree t ON d.parent_id = t.id
  )
  SELECT t.id FROM tree t
  WHERE p_dept IS NOT NULL
    AND t.id IN (SELECT public.training_visible_dept_ids())
  UNION
  SELECT id FROM (SELECT unnest(ARRAY(SELECT public.training_visible_dept_ids())) AS id) s
  WHERE p_dept IS NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- 5. 核心看板 RPC：stats_overview
--    p_dept 空=all 管辖汇总；指定=穿透该部门（非管辖 → 403）
--    p_from/p_to 空=全部时间（窗口作用于任务创建时间与学习开始时间）
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_overview(uuid, date, date);
CREATE FUNCTION public.stats_overview(
  p_dept uuid DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to   date DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_scope    uuid[];
  v_tot      int;  v_done int;
  v_exam_tot int;  v_exam_pass int;  v_first_tot int;  v_first_pass int;
  v_sec      bigint; v_learners int;
  v_overdue  int;
  v_cert_holders int; v_cert_target int;
  v_has_cert boolean;
  v_threshold numeric; v_grace int;
  v_detail   json; v_ret json;
BEGIN
  -- 入口管辖校验：越权穿透服务端拒绝
  IF p_dept IS NOT NULL AND NOT public.stats_can_access(p_dept) THEN
    RAISE EXCEPTION '无权查看该部门统计数据'
      USING ERRCODE = '42501', HINT = 'dept_not_in_scope';
  END IF;

  v_scope := ARRAY(SELECT public.stats_scope_depts(p_dept));
  IF v_scope IS NULL OR array_length(v_scope, 1) IS NULL THEN
    RETURN json_build_object('depts', '[]'::json, 'scope', NULL,
      'settings', json_build_object('completion_threshold', 80, 'overdue_grace_days', 7),
      'generated_at', now());
  END IF;

  SELECT completion_threshold, overdue_grace_days
    INTO v_threshold, v_grace FROM public.stats_settings WHERE id = 1;

  ---------- 任务维度（按 employee_id 口径，双通道不漏） ----------
  SELECT count(*),
         count(*) FILTER (WHERE a.status = 'completed'),
         count(*) FILTER (WHERE pl.exam_mode <> 'none'),
         count(*) FILTER (WHERE pl.exam_mode <> 'none' AND a.exam_status = 'passed')
    INTO v_tot, v_done, v_exam_tot, v_exam_pass
    FROM public.training_assignments a
    JOIN public.training_plans pl ON pl.id = a.plan_id
   WHERE a.department_id = ANY(v_scope)
     AND (p_from IS NULL OR a.created_at::date >= p_from)
     AND (p_to   IS NULL OR a.created_at::date <= p_to);

  -- 首考通过率（attempt_no=1）
  SELECT count(DISTINCT a.id) FILTER (WHERE t1.result IS NOT NULL),
         count(DISTINCT a.id) FILTER (WHERE t1.result = 'pass')
    INTO v_first_tot, v_first_pass
    FROM public.training_assignments a
    JOIN public.training_plans pl ON pl.id = a.plan_id
    LEFT JOIN LATERAL (
      SELECT r.result FROM public.exam_attempts r
       WHERE r.assignment_id = a.id AND r.attempt_no = 1 LIMIT 1) t1 ON true
   WHERE a.department_id = ANY(v_scope) AND pl.exam_mode <> 'none'
     AND (p_from IS NULL OR a.created_at::date >= p_from)
     AND (p_to   IS NULL OR a.created_at::date <= p_to);

  ---------- 学习时长（心跳有效时长，失焦已剔除） ----------
  SELECT COALESCE(sum(l.effective_sec), 0), count(DISTINCT l.employee_id)
    INTO v_sec, v_learners
    FROM public.training_study_logs l
    JOIN public.training_employees e ON e.id = l.employee_id
   WHERE e.department_id = ANY(v_scope)
     AND (p_from IS NULL OR l.started_at::date >= p_from)
     AND (p_to   IS NULL OR l.started_at::date <= p_to);

  ---------- 逾期未学人数（due_date 在计划适用范围表，按计划×部门） ----------
  SELECT count(DISTINCT a.employee_id)
    INTO v_overdue
    FROM public.training_assignments a
    JOIN public.training_plan_targets t
      ON t.plan_id = a.plan_id AND t.department_id = a.department_id
   WHERE a.department_id = ANY(v_scope)
     AND t.due_date < current_date
     AND a.status <> 'completed'
     AND (p_from IS NULL OR a.created_at::date >= p_from)
     AND (p_to   IS NULL OR a.created_at::date <= p_to);

  ---------- 持证率（certificates 表不存在 → null 降级，不拖垮其他指标） ----------
  v_has_cert := to_regclass('public.certificates') IS NOT NULL;
  IF v_has_cert THEN
    SELECT count(DISTINCT c.holder_id_no)
      INTO v_cert_holders
      FROM public.certificates c
     WHERE c.department_id = ANY(v_scope)
       AND c.cert_category = 'personal'
       AND c.status = 'active'
       AND (c.is_long_term OR c.valid_until >= current_date)
       AND c.holder_id_no IS NOT NULL;
    SELECT COALESCE(sum(target_count), 0) INTO v_cert_target
      FROM public.stats_cert_targets WHERE department_id = ANY(v_scope);
    IF v_cert_target = 0 THEN v_cert_target := NULL; END IF;  -- 未配置 → 显示 "—"
  END IF;

  ---------- 下级部门分组明细（逐级穿透的数据源） ----------
  SELECT json_agg(row_to_json(d.*) ORDER BY d.completion_rate NULLS LAST, d.name)
    INTO v_detail
    FROM (
      SELECT a.department_id AS dept_id,
             COALESCE(dp.name, '（部门已删除）') AS dept_name,
             count(*) AS tasks,
             count(*) FILTER (WHERE a.status = 'completed') AS completed,
             CASE WHEN count(*) > 0
                  THEN round(count(*) FILTER (WHERE a.status = 'completed') * 100.0 / count(*), 1)
                  END AS completion_rate,
             count(*) FILTER (WHERE pl.exam_mode <> 'none') AS exam_tasks,
             count(*) FILTER (WHERE pl.exam_mode <> 'none' AND a.exam_status = 'passed') AS exam_passed,
             CASE WHEN count(*) FILTER (WHERE pl.exam_mode <> 'none') > 0
                  THEN round(count(*) FILTER (WHERE pl.exam_mode <> 'none' AND a.exam_status = 'passed')
                             * 100.0 / count(*) FILTER (WHERE pl.exam_mode <> 'none'), 1)
                  END AS exam_rate,
             COALESCE(sec_sum.s, 0) AS study_sec,
             COALESCE(sec_sum.n, 0) AS learners,
             CASE WHEN COALESCE(sec_sum.n, 0) > 0
                  THEN round(COALESCE(sec_sum.s, 0) / sec_sum.n / 60.0, 1) END AS avg_minutes,
             COALESCE(od.n, 0) AS overdue_persons
        FROM public.training_assignments a
        JOIN public.training_plans pl ON pl.id = a.plan_id
        LEFT JOIN public.departments dp ON dp.id = a.department_id
        LEFT JOIN LATERAL (
          SELECT sum(l.effective_sec) AS s, count(DISTINCT l.employee_id) AS n
            FROM public.training_study_logs l
            JOIN public.training_employees e ON e.id = l.employee_id
           WHERE e.department_id = a.department_id
             AND (p_from IS NULL OR l.started_at::date >= p_from)
             AND (p_to   IS NULL OR l.started_at::date <= p_to)) sec_sum ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT a2.employee_id) AS n
            FROM public.training_assignments a2
            JOIN public.training_plan_targets t2
              ON t2.plan_id = a2.plan_id AND t2.department_id = a2.department_id
           WHERE a2.department_id = a.department_id
             AND t2.due_date < current_date
             AND a2.status <> 'completed') od ON true
       WHERE a.department_id = ANY(v_scope)
         AND (p_from IS NULL OR a.created_at::date >= p_from)
         AND (p_to   IS NULL OR a.created_at::date <= p_to)
       GROUP BY a.department_id, dp.name, sec_sum.s, sec_sum.n, od.n
    ) d;

  -- 持证率列：certificates 表存在才合并（表未建时保持 json null，前端显示"证照模块未启用"）
  IF v_has_cert AND v_detail IS NOT NULL THEN
    WITH cm AS (
      SELECT c.department_id AS dept_id,
             count(DISTINCT c.holder_id_no) AS h,
             (SELECT sum(target_count) FROM public.stats_cert_targets
               WHERE department_id = c.department_id) AS t
        FROM public.certificates c
       WHERE c.department_id = ANY(v_scope)
         AND c.cert_category = 'personal' AND c.status = 'active'
         AND (c.is_long_term OR c.valid_until >= current_date)
         AND c.holder_id_no IS NOT NULL
       GROUP BY c.department_id
    ), merged AS (
      SELECT jsonb_agg(
               jsonb_set(jsonb_set(d, '{cert_holders}', COALESCE(to_jsonb(cm.h), 'null'::jsonb)),
                         '{cert_target}',    COALESCE(to_jsonb(cm.t), 'null'::jsonb))
               ORDER BY (d->>'completion_rate') NULLS LAST, (d->>'dept_name')) AS j
        FROM jsonb_array_elements(v_detail::jsonb) d
        LEFT JOIN cm ON cm.dept_id = (d->>'dept_id')::uuid
    )
    SELECT j::text::json INTO v_detail FROM merged;
  END IF;

  v_ret := json_build_object(
    'scope', CASE WHEN p_dept IS NULL THEN NULL
                  ELSE (SELECT json_build_object('dept_id', id, 'dept_name', name)
                          FROM public.departments WHERE id = p_dept) END,
    'total', json_build_object(
      'tasks', v_tot, 'completed', v_done,
      'completion_rate', CASE WHEN v_tot > 0 THEN round(v_done * 100.0 / v_tot, 1) END,
      'exam_tasks', v_exam_tot, 'exam_passed', v_exam_pass,
      'exam_rate', CASE WHEN v_exam_tot > 0 THEN round(v_exam_pass * 100.0 / v_exam_tot, 1) END,
      'first_pass_total', v_first_tot, 'first_pass', v_first_pass,
      'first_pass_rate', CASE WHEN v_first_tot > 0 THEN round(v_first_pass * 100.0 / v_first_tot, 1) END,
      'study_sec', v_sec, 'learners', v_learners,
      'avg_minutes', CASE WHEN v_learners > 0 THEN round(v_sec / v_learners / 60.0, 1) END,
      'overdue_persons', v_overdue,
      'cert_holders', v_cert_holders, 'cert_target', v_cert_target,
      'cert_rate', CASE WHEN v_cert_target IS NOT NULL AND v_cert_target > 0
                        THEN round(v_cert_holders * 100.0 / v_cert_target, 1) END,
      'cert_enabled', v_has_cert),
    'depts', COALESCE(v_detail, '[]'::json),
    'settings', json_build_object('completion_threshold', v_threshold, 'overdue_grace_days', v_grace),
    'generated_at', now());
  RETURN v_ret;
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. 逾期个人名单
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_overdue_list(uuid, int);
CREATE FUNCTION public.stats_overdue_list(p_dept uuid DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_scope uuid[]; v_rows json;
BEGIN
  IF p_dept IS NOT NULL AND NOT public.stats_can_access(p_dept) THEN
    RAISE EXCEPTION '无权查看该部门数据' USING ERRCODE = '42501', HINT = 'dept_not_in_scope';
  END IF;
  v_scope := ARRAY(SELECT public.stats_scope_depts(p_dept));

  SELECT json_agg(row_to_json(r.*) ORDER BY r.overdue_days DESC)
    INTO v_rows
    FROM (
      SELECT a.employee_id,
             e.name AS emp_name,
             e.department_id AS dept_id,
             COALESCE(dp.name, '（部门已删除）') AS dept_name,
             pl.id AS plan_id, pl.title AS plan_title,
             t.due_date,
             (current_date - t.due_date) AS overdue_days,
             a.status,
             a.progress
        FROM public.training_assignments a
        JOIN public.training_employees e ON e.id = a.employee_id
        JOIN public.training_plans pl ON pl.id = a.plan_id
        JOIN public.training_plan_targets t
          ON t.plan_id = a.plan_id AND t.department_id = a.department_id
        LEFT JOIN public.departments dp ON dp.id = a.department_id
       WHERE a.department_id = ANY(v_scope)
         AND t.due_date < current_date
         AND a.status <> 'completed'
       ORDER BY t.due_date
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
    ) r;
  RETURN json_build_object('rows', COALESCE(v_rows, '[]'::json), 'count',
    CASE WHEN v_rows IS NULL THEN 0 ELSE json_array_length(v_rows) END);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. 预警懒计算：stats_alert_sync()
--    单位预警：某部门累计完成率 < 阈值（该部门有任务才判）
--    个人预警：due_date < today - 宽限天数 且未完成
--    dedup_key 带年月 → 同一问题每管理员每月只推一次
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_alert_sync();
CREATE FUNCTION public.stats_alert_sync()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_threshold numeric; v_grace int;
  v_unit int := 0; v_person int := 0; v_ym text := to_char(current_date, 'YYYYMM');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '仅管理员可触发预警同步' USING ERRCODE = '42501';
  END IF;
  SELECT completion_threshold, overdue_grace_days INTO v_threshold, v_grace
    FROM public.stats_settings WHERE id = 1;

  -- 单位完成率预警（范围 = 当前管理员可见部门，dept 级打开也能补齐自己辖区的预警）
  WITH dept_rate AS (
    SELECT a.department_id AS dept_id,
           count(*) AS tasks,
           count(*) FILTER (WHERE a.status = 'completed') AS done
      FROM public.training_assignments a
     WHERE a.department_id IN (SELECT public.training_visible_dept_ids())
     GROUP BY a.department_id
  )
  INSERT INTO public.stats_alerts (alert_type, department_id, payload, dedup_key)
  SELECT 'unit_completion', r.dept_id,
         jsonb_build_object('dept_name', d.name, 'tasks', r.tasks,
                            'completed', r.done,
                            'rate', round(r.done * 100.0 / r.tasks, 1),
                            'threshold', v_threshold),
         'unit_completion:' || r.dept_id || ':all:' || v_ym
    FROM dept_rate r JOIN public.departments d ON d.id = r.dept_id
   WHERE r.tasks > 0 AND round(r.done * 100.0 / r.tasks, 1) < v_threshold
  ON CONFLICT (dedup_key) DO NOTHING;
  GET DIAGNOSTICS v_unit = ROW_COUNT;

  -- 个人逾期预警（超宽限期未完成）
  INSERT INTO public.stats_alerts (alert_type, department_id, employee_id, plan_id, payload, dedup_key)
  SELECT 'person_overdue', a.department_id, a.employee_id, a.plan_id,
         jsonb_build_object('emp_name', e.name, 'plan_title', pl.title,
                            'due_date', t.due_date,
                            'overdue_days', current_date - t.due_date,
                            'grace_days', v_grace),
         'person_overdue:' || a.plan_id || ':' || a.employee_id || ':' || v_ym
    FROM public.training_assignments a
    JOIN public.training_plan_targets t
      ON t.plan_id = a.plan_id AND t.department_id = a.department_id
    JOIN public.training_employees e ON e.id = a.employee_id
    JOIN public.training_plans pl ON pl.id = a.plan_id
   WHERE a.department_id IN (SELECT public.training_visible_dept_ids())
     AND t.due_date < current_date - v_grace
     AND a.status <> 'completed'
  ON CONFLICT (dedup_key) DO NOTHING;
  GET DIAGNOSTICS v_person = ROW_COUNT;

  -- 清理 12 个月前的旧预警（信箱保鲜）
  DELETE FROM public.stats_alerts WHERE created_at < now() - interval '12 months';

  RETURN json_build_object('unit_alerts', v_unit, 'person_alerts', v_person);
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. 预警信箱：stats_alert_inbox() + stats_alert_ack()
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_alert_inbox();
CREATE FUNCTION public.stats_alert_inbox(p_unread_only boolean DEFAULT false)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_rows json; v_unread int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '仅管理员可读预警' USING ERRCODE = '42501';
  END IF;

  SELECT json_agg(row_to_json(r.*) ORDER BY r.created_at DESC) INTO v_rows
    FROM (
      SELECT al.id, al.alert_type, al.department_id, al.employee_id, al.plan_id,
             al.payload, al.created_at,
             (r.alert_id IS NULL) AS unread
        FROM public.stats_alerts al
        LEFT JOIN public.stats_alert_reads r
          ON r.alert_id = al.id AND r.admin_uid = auth.uid()
       WHERE al.department_id IN (SELECT public.training_visible_dept_ids())
         AND (NOT p_unread_only OR r.alert_id IS NULL)
       ORDER BY al.created_at DESC
       LIMIT 300
    ) r;

  SELECT count(*) INTO v_unread
    FROM public.stats_alerts al
    LEFT JOIN public.stats_alert_reads r
      ON r.alert_id = al.id AND r.admin_uid = auth.uid()
   WHERE al.department_id IN (SELECT public.training_visible_dept_ids())
     AND r.alert_id IS NULL;

  RETURN json_build_object('rows', COALESCE(v_rows, '[]'::json), 'unread', v_unread);
END;
$$;

DROP FUNCTION IF EXISTS public.stats_alert_ack(uuid[]);
CREATE FUNCTION public.stats_alert_ack(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() OR p_ids IS NULL THEN RETURN; END IF;
  INSERT INTO public.stats_alert_reads (alert_id, admin_uid)
  SELECT al.id, auth.uid()
    FROM public.stats_alerts al
   WHERE al.id = ANY(p_ids)
     AND al.department_id IN (SELECT public.training_visible_dept_ids())
  ON CONFLICT (alert_id, admin_uid) DO NOTHING;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. 报表导出数据源：stats_export_records
--    管辖范围内培训记录 + 学习/考试汇总 + 签字 storage_path（前端拉图转 base64）
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_export_records(uuid, uuid);
CREATE FUNCTION public.stats_export_records(p_plan uuid DEFAULT NULL, p_dept uuid DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_scope uuid[]; v_rows json;
BEGIN
  IF p_dept IS NOT NULL AND NOT public.stats_can_access(p_dept) THEN
    RAISE EXCEPTION '无权导出该部门数据' USING ERRCODE = '42501', HINT = 'dept_not_in_scope';
  END IF;
  v_scope := ARRAY(SELECT public.stats_scope_depts(p_dept));

  SELECT json_agg(row_to_json(r.*) ORDER BY r.dept_name, r.emp_name) INTO v_rows
    FROM (
      SELECT a.id AS assignment_id,
             pl.id AS plan_id, pl.title AS plan_title, pl.category AS plan_category,
             pl.hours AS plan_hours, pl.start_date, pl.end_date,
             a.employee_id, e.name AS emp_name, e.position, e.employee_no,
             a.department_id AS dept_id, COALESCE(dp.name, '（部门已删除）') AS dept_name,
             a.status, a.progress, a.hours_earned, a.completed_at,
             a.exam_status, a.exam_score, a.exam_attempts,
             COALESCE(st.sec, 0) AS study_sec,
             sig.storage_path, sig.signed_at
        FROM public.training_assignments a
        JOIN public.training_employees e ON e.id = a.employee_id
        JOIN public.training_plans pl ON pl.id = a.plan_id
        LEFT JOIN public.departments dp ON dp.id = a.department_id
        LEFT JOIN LATERAL (
          SELECT sum(l.effective_sec) AS sec FROM public.training_study_logs l
           WHERE l.employee_id = a.employee_id
             AND l.course_id IN (SELECT c.id FROM public.training_courses c
                                  WHERE c.plan_id = a.plan_id)) st ON true
        LEFT JOIN public.training_signatures sig ON sig.assignment_id = a.id
       WHERE a.department_id = ANY(v_scope)
         AND a.status = 'completed'
         AND (p_plan IS NULL OR a.plan_id = p_plan)
       LIMIT 2000
    ) r;
  RETURN json_build_object('rows', COALESCE(v_rows, '[]'::json),
    'count', CASE WHEN v_rows IS NULL THEN 0 ELSE json_array_length(v_rows) END);
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. 持证基准维护（仅公司级）
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_set_cert_target(uuid, int);
CREATE FUNCTION public.stats_set_cert_target(p_dept uuid, p_count int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '仅公司级管理员可维护持证基准' USING ERRCODE = '42501';
  END IF;
  IF p_count < 0 THEN RAISE EXCEPTION '基准数不能为负'; END IF;
  INSERT INTO public.stats_cert_targets (department_id, target_count, updated_by)
  VALUES (p_dept, p_count, auth.uid())
  ON CONFLICT (department_id) DO UPDATE
    SET target_count = EXCLUDED.target_count, updated_by = auth.uid(), updated_at = now();
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. 预警阈值设置（仅公司级）
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.stats_set_settings(numeric, int);
CREATE FUNCTION public.stats_set_settings(p_completion_threshold numeric, p_overdue_grace_days int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '仅公司级管理员可修改预警阈值' USING ERRCODE = '42501';
  END IF;
  IF p_completion_threshold IS NULL OR p_completion_threshold < 0 OR p_completion_threshold > 100
     OR p_overdue_grace_days IS NULL OR p_overdue_grace_days < 0 OR p_overdue_grace_days > 365 THEN
    RAISE EXCEPTION '阈值取值不合法（完成率 0~100，宽限 0~365 天）';
  END IF;
  UPDATE public.stats_settings
     SET completion_threshold = p_completion_threshold,
         overdue_grace_days   = p_overdue_grace_days,
         updated_by = auth.uid(), updated_at = now()
   WHERE id = 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.stats_overview(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_overdue_list(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_alert_sync() TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_alert_inbox(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_alert_ack(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_export_records(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_set_cert_target(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stats_set_settings(numeric, int) TO authenticated;

-- ----------------------------------------------------------------------------
-- 11. 验证段（在 SQL 编辑器执行后应输出全部 OK）
-- ----------------------------------------------------------------------------
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('stats_settings','stats_cert_targets','stats_alerts','stats_alert_reads');
  IF v <> 4 THEN RAISE EXCEPTION '表数量不符: %/4', v; END IF;

  SELECT count(*) INTO v FROM pg_proc
   WHERE proname IN ('stats_overview','stats_overdue_list','stats_alert_sync',
                     'stats_alert_inbox','stats_alert_ack','stats_export_records',
                     'stats_set_cert_target','stats_can_access','stats_scope_depts',
                     'stats_set_settings');
  IF v < 10 THEN RAISE EXCEPTION '函数数量不符: %/10', v; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.stats_settings WHERE id = 1) THEN
    RAISE EXCEPTION 'stats_settings 初始行缺失';
  END IF;

  RAISE NOTICE 'statistics-module.sql 安装验证通过：4 表 / 10 函数 / settings 初始行 OK';
END $$;

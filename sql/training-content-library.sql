-- ==========================================================================
-- 培训 v2 增量：三级内容资源库 + 学习时长心跳（防刷）+ 计划必修/选修
--
-- 依赖：sql/training-online-v2.sql（员工账号 / training_assignments / 课件进度底座）
--       sql/training-management.sql + training-fix-v13.sql（更早的底座）
--
-- 决策（2026-08-31 用户确认）：
--   · 课件暂不上视频 —— 资源库类型枚举不含 video/audio，后期需要再放开 CHECK
--   · 防刷强度 = 15~30s 心跳 + 页面失焦暂停（不做随机防挂机弹窗）
--     服务端仍保留三重校验：增量上限 / 墙钟间隔 / 5 分钟断会话
--
-- 执行：云 Supabase → SQL Editor → 粘贴全部 → Run（幂等，可重复执行）
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 前置校验
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.training_my_employee_id()') IS NULL
     OR to_regclass('public.training_assignments') IS NULL THEN
    RAISE EXCEPTION '请先执行 sql/training-online-v2.sql（员工账号与参训底座）';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- 1. 计划级必修/选修 + 课件类型加 ppt
-- --------------------------------------------------------------------------
ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.training_plans.is_required IS '必修/选修（选修计划不强制完成，看板区分统计）';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.training_courses'::regclass
               AND conname  = 'training_courses_course_type_check') THEN
    ALTER TABLE public.training_courses DROP CONSTRAINT training_courses_course_type_check;
  END IF;
  ALTER TABLE public.training_courses
    ADD CONSTRAINT training_courses_course_type_check
    CHECK (course_type IN ('pdf', 'video', 'image', 'text', 'link', 'ppt'));
END $$;

-- --------------------------------------------------------------------------
-- 2. 三级内容资源库（公司通用库 / 部门专业库 / 项目专项库）
--    与计划课件分离：库里沉淀复用，计划通过 library_id 引入（库里更新课件随动）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_library (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  course_type   TEXT NOT NULL DEFAULT 'pdf'
                CHECK (course_type IN ('pdf', 'ppt', 'article', 'image')),
  scope         TEXT NOT NULL DEFAULT 'company'
                CHECK (scope IN ('company', 'dept', 'project')),
  department_id UUID REFERENCES public.departments(id) ON DELETE CASCADE,
  storage_path  TEXT,                       -- training-courses 桶内路径（library/ 前缀）
  file_url      TEXT,                       -- 外链（备用）
  content       TEXT,                       -- 图文正文（course_type='article'）
  page_count    INT,                        -- PDF/PPT 页数（进度用）
  file_size     BIGINT,
  status        TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('draft', 'published', 'archived')),
  uploaded_by   UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- company 库不挂部门；dept/project 库必须挂部门
  CONSTRAINT tr_lib_scope_dept CHECK (
    (scope = 'company' AND department_id IS NULL)
    OR (scope IN ('dept', 'project') AND department_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tr_lib_scope
  ON public.training_library(scope, department_id, status);

DROP TRIGGER IF EXISTS trg_tr_lib_updated ON public.training_library;
CREATE TRIGGER trg_tr_lib_updated BEFORE UPDATE ON public.training_library
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 计划课件可引用资源库文件（引入而非复制）
ALTER TABLE public.training_courses
  ADD COLUMN IF NOT EXISTS library_id UUID REFERENCES public.training_library(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tr_course_lib ON public.training_courses(library_id);

-- 3. 资源库 RLS
--    读：公司库全员可见；部门/项目库 = training_can_read 树内可见
--    写：管理员；公司库仅公司级（is_company_admin），部门/项目库 = training_can_write 树内
ALTER TABLE public.training_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tr_lib_select" ON public.training_library;
CREATE POLICY "tr_lib_select" ON public.training_library
  FOR SELECT TO authenticated
  USING (
    scope = 'company'
    OR (department_id IS NOT NULL AND public.training_can_read(department_id))
  );

DROP POLICY IF EXISTS "tr_lib_write" ON public.training_library;
CREATE POLICY "tr_lib_write" ON public.training_library
  FOR ALL TO authenticated
  USING (
    public.is_admin()
    AND (
      (scope = 'company' AND public.training_is_company_admin())
      OR (department_id IS NOT NULL AND public.training_can_write(department_id))
    )
  )
  WITH CHECK (
    public.is_admin()
    AND (
      (scope = 'company' AND public.training_is_company_admin())
      OR (department_id IS NOT NULL AND public.training_can_write(department_id))
    )
  );

-- --------------------------------------------------------------------------
-- 4. 学习会话表（有效时长的唯一事实来源，服务端累计、不信前端总数）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.training_study_logs (
  id            UUID PRIMARY KEY,           -- 客户端生成的会话 ID
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES public.training_courses(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_beat_at  TIMESTAMPTZ,
  beats         INT NOT NULL DEFAULT 0,     -- 有效心跳数
  effective_sec INT NOT NULL DEFAULT 0,     -- 服务端累计有效学习秒数
  closed        BOOLEAN NOT NULL DEFAULT FALSE,
  client_meta   JSONB                       -- 设备 / 网络等（可选）
);

CREATE INDEX IF NOT EXISTS idx_tr_log_emp    ON public.training_study_logs(employee_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tr_log_course ON public.training_study_logs(course_id);

ALTER TABLE public.training_study_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tr_log_select" ON public.training_study_logs;
CREATE POLICY "tr_log_select" ON public.training_study_logs
  FOR SELECT TO authenticated
  USING (
    employee_id = public.training_my_employee_id()
    OR public.is_admin()      -- 管理员可读学习时长（时长数据敏感面小，简化为管理员可读）
  );

DROP POLICY IF EXISTS "tr_log_insert" ON public.training_study_logs;
CREATE POLICY "tr_log_insert" ON public.training_study_logs
  FOR INSERT TO authenticated
  WITH CHECK (employee_id = public.training_my_employee_id());

-- --------------------------------------------------------------------------
-- 5. 心跳 RPC：每 15~30 秒一次
--    校验：① delta ∈ (0,60]  ② 与上次心跳墙钟间隔 ≥ delta×0.8-1（防脚本连发）
--          ③ 距上次心跳超过 5 分钟 → 会话作废重建（挂机/断网不计时长）
--    心跳通过后联动 training_save_course_progress（90% 完成 / 任务回写逻辑复用）
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_course_heartbeat(UUID, UUID, INT, NUMERIC, NUMERIC);
CREATE FUNCTION public.training_course_heartbeat(
  p_session_id UUID,             -- 首次传 NULL，之后用返回值里的 session_id
  p_course_id  UUID,
  p_delta_sec  INT,
  p_position   NUMERIC DEFAULT NULL,   -- PDF/PPT 页码（前端播放位置）
  p_progress   NUMERIC DEFAULT NULL     -- 进度 0~100（可空：只记时长不更新进度）
) RETURNS JSONB AS $$
DECLARE
  v_emp     UUID;
  v_log     public.training_study_logs%ROWTYPE;
  v_gap     NUMERIC;
  v_sid     UUID := p_session_id;
  v_new     BOOLEAN := FALSE;
  v_counted BOOLEAN := FALSE;
  v_saved   JSONB;
  v_now_sec INT;
BEGIN
  v_emp := public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案，请联系管理员'; END IF;
  IF p_delta_sec IS NULL OR p_delta_sec <= 0 OR p_delta_sec > 60 THEN
    RAISE EXCEPTION '心跳参数非法';
  END IF;

  -- 参训范围校验：课件所在计划的参训名单里必须有我
  IF NOT EXISTS (
    SELECT 1
    FROM public.training_assignments a
    JOIN public.training_courses c ON c.id = p_course_id AND c.plan_id = a.plan_id
    WHERE a.employee_id = v_emp
  ) THEN
    RAISE EXCEPTION '您不在该课件的参训范围内';
  END IF;

  -- 会话有效性：不属于我 / 已关闭 / 换了课件 / 超过 5 分钟无心跳 → 作废重建
  IF v_sid IS NOT NULL THEN
    SELECT * INTO v_log FROM public.training_study_logs
    WHERE id = v_sid AND employee_id = v_emp;
    IF NOT FOUND
       OR v_log.closed
       OR v_log.course_id <> p_course_id
       OR v_log.last_beat_at IS NULL
       OR v_log.last_beat_at < NOW() - INTERVAL '5 minutes' THEN
      UPDATE public.training_study_logs SET closed = TRUE
      WHERE id = v_sid AND employee_id = v_emp;
      v_sid := NULL;
    END IF;
  END IF;

  IF v_sid IS NULL THEN
    INSERT INTO public.training_study_logs (id, employee_id, course_id, last_beat_at)
    VALUES (gen_random_uuid(), v_emp, p_course_id, NOW())
    RETURNING * INTO v_log;
    v_sid := v_log.id;
    v_new := TRUE;
  END IF;

  -- 墙钟间隔校验：间隔过短视为脚本连发，只刷新心跳时间、不计时长
  v_gap := EXTRACT(EPOCH FROM (NOW() - v_log.last_beat_at));
  IF NOT v_new AND v_gap < p_delta_sec * 0.8 - 1 THEN
    UPDATE public.training_study_logs SET last_beat_at = NOW() WHERE id = v_sid;
  ELSE
    UPDATE public.training_study_logs SET
      beats         = beats + 1,
      effective_sec = effective_sec + p_delta_sec,
      last_beat_at  = NOW()
    WHERE id = v_sid;
    v_counted := TRUE;
  END IF;

  -- 进度联动：复用 90% 完成 / assignment 回写 / participants 同步逻辑
  IF p_progress IS NOT NULL THEN
    v_saved := public.training_save_course_progress(
                 p_course_id, p_progress, COALESCE(p_position, 0));
  END IF;

  SELECT effective_sec INTO v_now_sec
  FROM public.training_study_logs WHERE id = v_sid;

  RETURN jsonb_build_object(
    'session_id',    v_sid,
    'counted',       v_counted,
    'effective_sec', v_now_sec,
    'progress',      v_saved->'progress',
    'completed',     v_saved->'completed'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.training_course_heartbeat(UUID, UUID, INT, NUMERIC, NUMERIC)
  TO authenticated;

-- --------------------------------------------------------------------------
-- 6. 员工端：我的累计有效学习秒数
-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.training_my_study_seconds();
CREATE FUNCTION public.training_my_study_seconds()
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(effective_sec), 0)::INT
  FROM public.training_study_logs
  WHERE employee_id = public.training_my_employee_id();
$$;

GRANT EXECUTE ON FUNCTION public.training_my_study_seconds() TO authenticated;

-- ==========================================================================
-- 执行完成后验证：
--   SELECT scope, COUNT(*) FROM training_library GROUP BY scope;   -- 三级库
--   SELECT COUNT(*) FROM training_study_logs;                      -- 会话表
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('training_course_heartbeat','training_my_study_seconds');   -- 两个 RPC 已建
-- ==========================================================================

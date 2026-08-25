-- ==========================================================================
-- 部门月度「无野外施工项目」确认
-- --------------------------------------------------------------------------
-- 用途：部门账号在某一月份确实没有正在野外施工的项目时，可一键确认
--       "本月无野外施工项目"，视同 0 填报。管理员在报送状态中可同步看到
--       该部门已确认本月无野外施工项目。
-- 执行顺序：在 schema.sql / fix.sql / phone-login.sql / super-admin.sql 等
--           之后执行即可（本脚本自包含，幂等，可重复执行）。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 部门月度状态表
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.department_month_status (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id    UUID REFERENCES public.departments(id) ON DELETE CASCADE NOT NULL,
  reporting_year   INTEGER NOT NULL,
  reporting_month  INTEGER NOT NULL,
  -- 是否确认"本月无正在野外施工的项目"（视同 0 填报）
  no_field_projects BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at     TIMESTAMPTZ,                                  -- 确认时间
  confirmed_by     UUID REFERENCES auth.users(id),               -- 确认人
  note             TEXT,                                          -- 备注（预留）
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_dms_month CHECK (reporting_month >= 1 AND reporting_month <= 12),
  -- 每部门每月仅一行
  CONSTRAINT uq_dms_dept_month UNIQUE (department_id, reporting_year, reporting_month)
);

CREATE INDEX IF NOT EXISTS idx_dms_dept_month
  ON public.department_month_status(department_id, reporting_year, reporting_month);
CREATE INDEX IF NOT EXISTS idx_dms_year_month
  ON public.department_month_status(reporting_year, reporting_month);

-- 自动更新 updated_at
DROP TRIGGER IF EXISTS trg_dms_updated_at ON public.department_month_status;
CREATE TRIGGER trg_dms_updated_at
  BEFORE UPDATE ON public.department_month_status
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 2. 行级安全策略（RLS）
--    本部门成员可读写本部门记录；管理员可读写所有记录
-- --------------------------------------------------------------------------
ALTER TABLE public.department_month_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dms_policy" ON public.department_month_status;
CREATE POLICY "dms_policy" ON public.department_month_status
  FOR ALL TO authenticated
  USING (
    department_id IN (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    OR public.is_admin()
  )
  WITH CHECK (
    department_id IN (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    OR public.is_admin()
  );

-- --------------------------------------------------------------------------
-- 3. 确认 / 撤销 RPC（SECURITY DEFINER：显式校验权限，避免 RLS 递归）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_dept_no_field_status(
  p_department_id UUID,
  p_year          INTEGER,
  p_month         INTEGER,
  p_no_field      BOOLEAN,
  p_note          TEXT DEFAULT NULL
)
RETURNS public.department_month_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_my_dept  UUID;
  v_is_admin BOOLEAN;
  v_note     TEXT := NULLIF(btrim(coalesce(p_note, '')), '');
  v_row      public.department_month_status;
BEGIN
  -- 权限校验：管理员 或 本部门成员
  SELECT department_id INTO v_my_dept FROM public.profiles WHERE id = auth.uid();
  SELECT public.is_admin() INTO v_is_admin;
  IF NOT v_is_admin AND (v_my_dept IS NULL OR v_my_dept <> p_department_id) THEN
    RAISE EXCEPTION '无权修改该部门的报送状态';
  END IF;

  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION '报送月份不合法（应为 1-12）';
  END IF;

  IF p_no_field THEN
    -- 确认"本月无野外施工项目"
    INSERT INTO public.department_month_status
      (department_id, reporting_year, reporting_month, no_field_projects, confirmed_at, confirmed_by, note)
    VALUES
      (p_department_id, p_year, p_month, TRUE, now(), auth.uid(), v_note)
    ON CONFLICT (department_id, reporting_year, reporting_month)
    DO UPDATE SET
      no_field_projects = TRUE,
      confirmed_at      = now(),
      confirmed_by      = auth.uid(),
      note              = v_note,
      updated_at        = now()
    RETURNING * INTO v_row;
  ELSE
    -- 撤销确认：清除标志（保留行以便追溯）
    INSERT INTO public.department_month_status
      (department_id, reporting_year, reporting_month, no_field_projects, confirmed_at, confirmed_by, note)
    VALUES
      (p_department_id, p_year, p_month, FALSE, NULL, NULL, NULL)
    ON CONFLICT (department_id, reporting_year, reporting_month)
    DO UPDATE SET
      no_field_projects = FALSE,
      confirmed_at      = NULL,
      confirmed_by      = NULL,
      note              = NULL,
      updated_at        = now()
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

-- 视图：方便管理员一次性查看某月所有部门的无野外施工确认情况
-- （读取通过 RLS 限制：管理员可见全部，部门成员仅见本部门）
DROP VIEW IF EXISTS public.v_dept_no_field_status;
CREATE OR REPLACE VIEW public.v_dept_no_field_status AS
SELECT
  s.id,
  s.department_id,
  s.reporting_year,
  s.reporting_month,
  s.no_field_projects,
  s.confirmed_at,
  s.confirmed_by,
  s.note,
  d.name AS department_name,
  d.code AS department_code
FROM public.department_month_status s
JOIN public.departments d ON d.id = s.department_id;

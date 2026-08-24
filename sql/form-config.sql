-- ==========================================================================
-- 施工项目月报管理系统 - 报送表格配置（表单配置管理）
-- ==========================================================================
-- 功能：
--   1. 项目类型选项管理（报送表单"项目类型"下拉框的可选项）
--      project_types 表：增 / 改 / 删，由管理员在页面操作
--   2. 报送字段管理（"默认项目报送表格"的全部字段 + 自定义字段）
--      report_fields 表：增 / 改 / 删，支持文本/数字/多行文本/下拉/日期
--      - 系统内置字段（is_builtin = true）：与 project_reports 表固定列对应，
--        管理员可修改名称/必填/排序/启用状态，但类型由数据库列决定，不可修改，
--        也不可删除（只能停用，保证历史数据与表结构安全）
--      - 自定义字段（is_builtin = false）：值保存在 project_reports.custom_data (JSONB)
--   3. 报送记录增加 custom_data 列（自定义字段值）
--
-- 安全设计（与既有模块一致）：
--   - 所有写操作均通过 SECURITY DEFINER RPC + is_admin() 校验
--   - project_types / report_fields 只对已登录用户开放 SELECT（报送表单需要读取）
--   - 删除项目类型前检查历史报送记录引用，防止数据"消失"
--   - 内置字段禁止删除、禁止改类型/选项（由 SQL 层强制，前端同样限制）
--
-- 执行方法：Supabase 控制台 -> SQL Editor -> 粘贴全部内容 -> Run
-- 幂等可重复执行（已执行过旧版的库再次执行即可完成升级）。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. 项目类型表
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_types (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,            -- 类型名称
  sort_order  INTEGER DEFAULT 0,               -- 排序序号（越小越靠前）
  is_active   BOOLEAN DEFAULT TRUE,            -- 是否启用（停用后不出现在表单）
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- --------------------------------------------------------------------------
-- 2. 报送字段配置表
--    字段值存储：
--      - 内置字段（is_builtin = true）→ project_reports 固定列（field_key = 列名）
--      - 自定义字段（is_builtin = false）→ project_reports.custom_data (JSONB)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_fields (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  field_key    TEXT NOT NULL UNIQUE,           -- 字段标识（内置=数据库列名；自定义=f_8位十六进制）
  label        TEXT NOT NULL,                  -- 显示名称（如：质量评分）
  field_type   TEXT NOT NULL
               CHECK (field_type IN ('text','number','textarea','select','date')),
  options      JSONB,                          -- 下拉选择类型的选项数组，如 ["优","良","差"]
  is_required  BOOLEAN DEFAULT FALSE,          -- 是否必填
  sort_order   INTEGER DEFAULT 0,              -- 排序序号
  is_active    BOOLEAN DEFAULT TRUE,           -- 是否启用（停用后不出现在报送表单/汇总表）
  is_builtin   BOOLEAN DEFAULT FALSE,          -- 是否系统内置字段（内置字段不可删除/不可改类型）
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- 旧库升级：补充 is_builtin 列（幂等）
ALTER TABLE public.report_fields
  ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN DEFAULT FALSE;

-- --------------------------------------------------------------------------
-- 3. 报送记录增加自定义数据列（存储所有自定义字段的值）
-- --------------------------------------------------------------------------
ALTER TABLE public.project_reports
  ADD COLUMN IF NOT EXISTS custom_data JSONB DEFAULT '{}'::jsonb;

-- --------------------------------------------------------------------------
-- 4. RLS：两张配置表对已登录用户开放读取（报送表单需要），写操作只走 RPC
-- --------------------------------------------------------------------------
ALTER TABLE public.project_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_types_select_authenticated" ON public.project_types;
CREATE POLICY "project_types_select_authenticated" ON public.project_types
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "report_fields_select_authenticated" ON public.report_fields;
CREATE POLICY "report_fields_select_authenticated" ON public.report_fields
  FOR SELECT TO authenticated USING (true);

-- --------------------------------------------------------------------------
-- 5. 项目类型 RPC
-- --------------------------------------------------------------------------

-- 5.1 新增项目类型
--     p_name         类型名称（必填，全局唯一）
--     p_sort_order   排序号（可选；不传自动排最后）
CREATE OR REPLACE FUNCTION public.create_project_type(
  p_name         TEXT,
  p_sort_order   INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_type_id UUID;
  v_sort    INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '类型名称不能为空';
  END IF;
  p_name := trim(p_name);

  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.project_types;
  END IF;

  INSERT INTO public.project_types (name, sort_order)
  VALUES (p_name, v_sort)
  RETURNING id INTO v_type_id;

  RETURN jsonb_build_object('success', true, 'type_id', v_type_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该项目类型已存在';
END;
$$;

-- 5.2 修改项目类型（名称 / 排序 / 启用状态）
--     注意：修改名称后，历史报送记录中保存的旧名称不会自动更新
CREATE OR REPLACE FUNCTION public.update_project_type(
  p_type_id      UUID,
  p_name         TEXT,
  p_sort_order   INTEGER DEFAULT NULL,
  p_is_active    BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;
  IF p_type_id IS NULL THEN
    RAISE EXCEPTION '类型 ID 不能为空';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '类型名称不能为空';
  END IF;

  UPDATE public.project_types
  SET name = trim(p_name),
      sort_order = COALESCE(p_sort_order, sort_order),
      is_active = p_is_active
  WHERE id = p_type_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '项目类型不存在或已被删除';
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该项目类型已存在';
END;
$$;

-- 5.3 删除项目类型
--     删除前检查历史报送记录是否使用了该类型，有则阻止
CREATE OR REPLACE FUNCTION public.delete_project_type(
  p_type_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_name        TEXT;
  v_used_count  INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  SELECT name INTO v_name FROM public.project_types WHERE id = p_type_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION '项目类型不存在或已被删除';
  END IF;

  -- 检查历史报送记录引用（project_reports.project_type 存的是类型名称文本）
  SELECT COUNT(*) INTO v_used_count
  FROM public.project_reports
  WHERE project_type = v_name;

  IF v_used_count > 0 THEN
    RAISE EXCEPTION '已有 % 条报送记录使用了「%」，不能删除。如需停用请改为编辑并将状态设为停用', v_used_count, v_name;
  END IF;

  DELETE FROM public.project_types WHERE id = p_type_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 6. 自定义字段 RPC
-- --------------------------------------------------------------------------

-- 6.1 新增自定义字段
--     p_label        显示名称（如：质量评分）
--     p_field_type   字段类型：text | number | textarea | select | date
--     p_options      下拉选择选项（JSON 数组字符串，如 '["优","良","差"]'，仅 select 需要）
--     p_is_required  是否必填
--     p_sort_order   排序号（可选）
CREATE OR REPLACE FUNCTION public.create_report_field(
  p_label         TEXT,
  p_field_type    TEXT,
  p_options       JSONB DEFAULT NULL,
  p_is_required   BOOLEAN DEFAULT FALSE,
  p_sort_order    INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_field_id UUID;
  v_key      TEXT;
  v_sort     INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  IF p_label IS NULL OR trim(p_label) = '' THEN
    RAISE EXCEPTION '字段名称不能为空';
  END IF;
  IF p_field_type NOT IN ('text','number','textarea','select','date') THEN
    RAISE EXCEPTION '不支持的字段类型';
  END IF;
  IF p_field_type = 'select' AND (p_options IS NULL OR jsonb_array_length(p_options) = 0) THEN
    RAISE EXCEPTION '下拉选择类型必须提供至少一个选项';
  END IF;

  p_label := trim(p_label);
  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.report_fields;
  END IF;

  -- 自动生成字段标识：f_ 前缀 + 8 位随机十六进制
  v_key := 'f_' || lower(substr(md5(gen_random_uuid()::text), 1, 8));

  INSERT INTO public.report_fields (field_key, label, field_type, options, is_required, sort_order)
  VALUES (v_key, p_label, p_field_type, p_options, p_is_required, v_sort)
  RETURNING id INTO v_field_id;

  RETURN jsonb_build_object('success', true, 'field_id', v_field_id, 'field_key', v_key);
END;
$$;

-- 6.2 修改字段
--     注意：
--       - 修改类型/选项后，仅影响之后填写的报送；历史数据保留
--       - 内置字段（is_builtin）的类型与选项由数据库列决定，SQL 层强制锁定：
--         即使调用方传了新的 field_type / options 也会被忽略，保持原值
CREATE OR REPLACE FUNCTION public.update_report_field(
  p_field_id      UUID,
  p_label         TEXT,
  p_field_type    TEXT,
  p_options       JSONB DEFAULT NULL,
  p_is_required   BOOLEAN DEFAULT FALSE,
  p_sort_order    INTEGER DEFAULT NULL,
  p_is_active     BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_is_builtin BOOLEAN;
  v_field_type TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  IF p_field_id IS NULL THEN
    RAISE EXCEPTION '字段 ID 不能为空';
  END IF;
  IF p_label IS NULL OR trim(p_label) = '' THEN
    RAISE EXCEPTION '字段名称不能为空';
  END IF;

  -- 读取字段现状（判断是否内置、当前类型）
  SELECT is_builtin, field_type INTO v_is_builtin, v_field_type
  FROM public.report_fields WHERE id = p_field_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '字段不存在或已被删除';
  END IF;

  -- 只有自定义字段才校验并接受新的类型/选项；内置字段类型锁定
  IF NOT v_is_builtin THEN
    IF p_field_type NOT IN ('text','number','textarea','select','date') THEN
      RAISE EXCEPTION '不支持的字段类型';
    END IF;
    IF p_field_type = 'select' AND (p_options IS NULL OR jsonb_array_length(p_options) = 0) THEN
      RAISE EXCEPTION '下拉选择类型必须提供至少一个选项';
    END IF;
  END IF;

  UPDATE public.report_fields
  SET label = trim(p_label),
      field_type = CASE WHEN v_is_builtin THEN field_type ELSE p_field_type END,
      options = CASE WHEN v_is_builtin THEN options ELSE p_options END,
      is_required = p_is_required,
      sort_order = COALESCE(p_sort_order, sort_order),
      is_active = p_is_active
  WHERE id = p_field_id;

  RETURN jsonb_build_object('success', true, 'is_builtin', v_is_builtin);
END;
$$;

-- 6.3 删除字段
--     内置字段（is_builtin）禁止删除：数据库列不能删，删除会造成报送表结构/历史数据问题，
--     应通过"编辑 -> 停用"将其从报送表格中移除。
--     自定义字段删除后，历史报送数据中的该字段值仍保留在 custom_data 中，只是不再展示
CREATE OR REPLACE FUNCTION public.delete_report_field(
  p_field_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_is_builtin BOOLEAN;
  v_label      TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  SELECT is_builtin, label INTO v_is_builtin, v_label
  FROM public.report_fields WHERE id = p_field_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '字段不存在或已被删除';
  END IF;

  IF v_is_builtin THEN
    RAISE EXCEPTION '「%」为系统内置字段，不能删除；如需从报送表格中移除，请编辑并设为「停用」', v_label;
  END IF;

  DELETE FROM public.report_fields WHERE id = p_field_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 7. 授权：允许已登录用户调用 RPC（权限由函数体内 is_admin() 校验）
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_project_type(TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_project_type(UUID, TEXT, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_project_type(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_report_field(TEXT, TEXT, JSONB, BOOLEAN, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_report_field(UUID, TEXT, TEXT, JSONB, BOOLEAN, INTEGER, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_report_field(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 8. 种子数据：项目类型（与原有报送表单内置选项一致）
-- --------------------------------------------------------------------------
INSERT INTO public.project_types (name, sort_order) VALUES
  ('房屋建筑工程',   1),
  ('市政公用工程',   2),
  ('公路工程',       3),
  ('水利工程',       4),
  ('电力工程',       5),
  ('通信工程',       6),
  ('机电安装工程',   7),
  ('装饰装修工程',   8),
  ('园林绿化工程',   9),
  ('环保工程',      10),
  ('钢结构工程',    11),
  ('基础设施工程',  12),
  ('其他',          99)
ON CONFLICT (name) DO NOTHING;

-- --------------------------------------------------------------------------
-- 9. 种子数据：系统内置报送字段（"默认项目报送表格"）
--     field_key = project_reports 表列名；is_builtin = true
--     类型由数据库列决定，管理端只可改名称/必填/排序/启停，不可删除
--     幂等：ON CONFLICT (field_key) DO NOTHING，重复执行不覆盖管理员已改的配置
-- --------------------------------------------------------------------------
INSERT INTO public.report_fields
  (field_key, label, field_type, options, is_required, sort_order, is_active, is_builtin)
VALUES
  ('project_name',            '项目名称',            'text',     NULL,                 TRUE,  1,  TRUE, TRUE),
  ('project_type',            '项目类型',            'select',   '[]'::jsonb,          TRUE,  2,  TRUE, TRUE),
  ('construction_location',   '施工地点',            'text',     NULL,                 TRUE,  3,  TRUE, TRUE),
  ('contract_amount',         '合同额（万元）',      'number',   NULL,                 TRUE,  4,  TRUE, TRUE),
  ('duration_months',         '工期（月）',          'number',   NULL,                 TRUE,  5,  TRUE, TRUE),
  ('department_entity',       '项目归属部门或实体',  'text',     NULL,                 TRUE,  6,  TRUE, TRUE),
  ('project_manager',         '项目负责人',          'text',     NULL,                 TRUE,  7,  TRUE, TRUE),
  ('contact_info',            '联系方式',            'text',     NULL,                 TRUE,  8,  TRUE, TRUE),
  ('overall_progress',        '项目整体进度情况',    'textarea', NULL,                 TRUE,  9,  TRUE, TRUE),
  ('monthly_construction_status', '本月项目施工情况', 'textarea', NULL,                TRUE, 10,  TRUE, TRUE),
  ('equipment_models',        '设备型号及数量',      'textarea', NULL,                 TRUE, 11,  TRUE, TRUE),
  ('on_site_personnel',       '现场人数',            'number',   NULL,                 TRUE, 12,  TRUE, TRUE),
  ('on_site_vehicles',        '现场车辆数',          'number',   NULL,                 TRUE, 13,  TRUE, TRUE),
  ('safety_inspection',       '是否进行安全自检',    'select',   '["是","否"]'::jsonb, TRUE, 14,  TRUE, TRUE),
  ('safety_hazards',          '是否存在安全隐患',    'select',   '["是","否"]'::jsonb, TRUE, 15,  TRUE, TRUE),
  ('safety_hazard_detail',    '安全隐患详情',        'textarea', NULL,                 TRUE, 16,  TRUE, TRUE)
ON CONFLICT (field_key) DO NOTHING;

-- ==========================================================================
-- 验证 SQL：
--   SELECT * FROM public.project_types ORDER BY sort_order;
--   SELECT field_key, label, field_type, is_builtin, is_active
--     FROM public.report_fields ORDER BY sort_order;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'project_reports' AND column_name = 'custom_data';
-- ==========================================================================

-- ==========================================================================
-- 资质证照管理系统 - Supabase 数据库 Schema（v3：管理员维护 + 公司只读）
-- ==========================================================================
-- 前置条件：
--   本系统与「施工项目月报管理系统」共用同一个 Supabase 项目和账号体系，
--   请先执行月报系统的 sql/schema.sql（创建 departments / profiles / is_admin()），
--   再执行本文件。账号、管理员全部复用，无需重新创建。
--
-- v3 变更（相对 v2，可从 v1/v2 直接重复执行本文件完成升级）：
--   权限模型反转——证照的登记、编辑、删除、换证、附件上传删除仅管理员可操作；
--   公司账号（reporter）对本公司证照与附件只读（可查看、预览、下载）。
--   具体变化：
--     1. certificates / certificate_files 的 INSERT / UPDATE / DELETE 策略
--        由「本公司可写」收紧为「仅管理员（is_admin()）」。
--     2. Storage 桶 certificates 的写/删策略由「本公司目录」收紧为「仅管理员」。
--     3. RPC delete_certificate 权限校验收紧为仅管理员。
--
-- v2 变更（相对 v1）：
--   1. 组织维度由「部门」调整为「公司」：departments 表增加 is_company 标记，
--      种子公司：物化院有限公司、六勘院有限公司。
--      公司账号 = profiles.department_id 指向公司行的普通账号（reporter），
--      登录方式不变（邮箱 / 手机号 / 公司名称 / 公司编码）。
--   2. 证照大类改为：company 公司证照 / personal 个人证照
--      （旧数据 enterprise -> company、person -> personal 自动迁移）。
--   3. 证照类型字典支持两个可选「子分类」维度（名称 + 选项列表），
--      certificates 表新增 sub1_value / sub2_value 记录所选值。
--
-- 内容：
--   0. 公司（departments.is_company + 种子）
--   1. certificate_types   证照类型字典（含子分类维度，管理员可维护）
--   2. certificates        证照台账（核心表）
--   3. certificate_files   证照附件记录（配合 Storage bucket "certificates"）
--   4. cert_settings       全局设置（到期预警天数）
--   5. Storage 私有桶 + 访问策略（按公司目录隔离读，写仅管理员）
--   6. RPC：类型字典维护（含子分类）/ 设置维护 / 删除证照（仅删记录，附件由前端 Storage API 删除）
--   7. RLS 行级安全（公司只读本公司，管理员全量读写）
--
-- 使用方法：
--   Supabase 控制台 -> SQL Editor -> 复制全部内容 -> Run
--   幂等可重复执行。
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0. 兜底：is_admin() 管理员判断函数（月报系统 schema.sql 已创建，这里幂等重建）
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- --------------------------------------------------------------------------
-- 0.1 公司：departments 表增加 is_company 标记，并种子两家公司
--     说明：月报系统的职能部门（工程一部等）is_company 保持 false，
--     本系统只把 is_company = true 的行当作「公司」使用，两套系统互不影响。
-- --------------------------------------------------------------------------
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS is_company BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO public.departments (name, code, sort_order, is_company) VALUES
  ('物化院有限公司', 'COMP-01', 901, TRUE),
  ('六勘院有限公司', 'COMP-02', 902, TRUE)
ON CONFLICT (name) DO UPDATE SET is_company = TRUE;

-- --------------------------------------------------------------------------
-- 1. 证照类型字典
--    category: 'company' 公司证照 | 'personal' 个人证照
--    sub1/sub2：两个可选的「子分类」维度（如 爆破作业人员许可证 -> 人员类别：
--    爆破员/保管员/...），label 为维度名称，options 为可选值列表；
--    公司证照通常无子分类（label 为 NULL 即不启用）。
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.certificate_types (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,            -- 类型名称（如：安全生产许可证）
  category     TEXT NOT NULL DEFAULT 'company'
               CHECK (category IN ('company', 'personal')),
  sub1_label   TEXT,                            -- 子分类1名称（如：人员类别），NULL = 不启用
  sub1_options TEXT[] DEFAULT '{}',             -- 子分类1可选值
  sub2_label   TEXT,                            -- 子分类2名称（如：学习地点），NULL = 不启用
  sub2_options TEXT[] DEFAULT '{}',             -- 子分类2可选值
  sort_order   INTEGER DEFAULT 0,               -- 排序（越小越靠前）
  is_active    BOOLEAN DEFAULT TRUE,            -- 停用后不出现在表单下拉中
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- v1 -> v2 迁移：补列、类别取值迁移（enterprise->company / person->personal）
ALTER TABLE public.certificate_types ADD COLUMN IF NOT EXISTS sub1_label TEXT;
ALTER TABLE public.certificate_types ADD COLUMN IF NOT EXISTS sub1_options TEXT[] DEFAULT '{}';
ALTER TABLE public.certificate_types ADD COLUMN IF NOT EXISTS sub2_label TEXT;
ALTER TABLE public.certificate_types ADD COLUMN IF NOT EXISTS sub2_options TEXT[] DEFAULT '{}';
ALTER TABLE public.certificate_types DROP CONSTRAINT IF EXISTS certificate_types_category_check;
UPDATE public.certificate_types SET category = 'company'  WHERE category = 'enterprise';
UPDATE public.certificate_types SET category = 'personal' WHERE category = 'person';
ALTER TABLE public.certificate_types
  ADD CONSTRAINT certificate_types_category_check CHECK (category IN ('company', 'personal'));

-- --------------------------------------------------------------------------
-- 2. 证照台账（核心表）
--    status（生命周期，手动标记）:
--      'active'   在用（默认；展示状态"有效/即将到期/已过期"由有效期自动计算）
--      'replaced' 已换证（续期换证后旧证归档，保留可查）
--      'revoked'  已注销
--    department_id：归属公司（departments 表中 is_company = true 的行）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.certificates (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  department_id      UUID REFERENCES public.departments(id) ON DELETE CASCADE NOT NULL,
  -- 基本信息
  cert_name          TEXT NOT NULL,                              -- 证照名称
  cert_type          TEXT NOT NULL,                              -- 证照类型（类型名称文本）
  cert_category      TEXT NOT NULL DEFAULT 'company'
                     CHECK (cert_category IN ('company', 'personal')),
  cert_no            TEXT,                                       -- 证照编号（可留空，批量导入/新增后补填）
  sub1_value         TEXT,                                       -- 子分类1所选值（对应类型 sub1_label，如：爆破员）
  sub2_value         TEXT,                                       -- 子分类2所选值（对应类型 sub2_label，如：太原）
  issuing_authority  TEXT,                                       -- 发证机关
  issue_date         DATE,                                       -- 发证日期
  -- 有效期
  valid_from         DATE,                                       -- 有效期起
  valid_until        DATE,                                       -- 有效期止（长期有效时为空）
  is_long_term       BOOLEAN NOT NULL DEFAULT FALSE,             -- 长期有效
  -- 个人证照专属
  holder_name        TEXT,                                       -- 持证人姓名
  holder_id_no       TEXT,                                       -- 持证人证件号（前端列表脱敏展示）
  holder_position    TEXT,                                       -- 职务/岗位
  -- 其他
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'replaced', 'revoked')),
  remark             TEXT,                                       -- 备注
  renewed_from       UUID REFERENCES public.certificates(id) ON DELETE SET NULL,  -- 换证来源（旧证 ID）
  renewed_at         TIMESTAMPTZ,                                -- 换证时间（记在旧证上）
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  -- 约束
  CONSTRAINT chk_valid_range CHECK (
    is_long_term OR valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from
  )
);

-- v1 -> v2 迁移：补子分类值列、大类取值迁移（v1 部署过的库直接重跑本文件即可）
ALTER TABLE public.certificates ADD COLUMN IF NOT EXISTS sub1_value TEXT;
ALTER TABLE public.certificates ADD COLUMN IF NOT EXISTS sub2_value TEXT;
ALTER TABLE public.certificates DROP CONSTRAINT IF EXISTS certificates_cert_category_check;
UPDATE public.certificates SET cert_category = 'company'  WHERE cert_category = 'enterprise';
UPDATE public.certificates SET cert_category = 'personal' WHERE cert_category = 'person';
ALTER TABLE public.certificates
  ADD CONSTRAINT certificates_cert_category_check CHECK (cert_category IN ('company', 'personal'));

-- v4.1 迁移：证照编号允许为空（批量导入时待后期编辑补填）
ALTER TABLE public.certificates ALTER COLUMN cert_no DROP NOT NULL;

-- v6 迁移：新增「当年培训状态」字段（已培训 / 无需培训 / 待培训）
ALTER TABLE public.certificates ADD COLUMN IF NOT EXISTS training_status TEXT;
ALTER TABLE public.certificates DROP CONSTRAINT IF EXISTS certificates_training_status_check;
ALTER TABLE public.certificates
  ADD CONSTRAINT certificates_training_status_check
  CHECK (training_status IS NULL OR training_status IN ('已培训', '无需培训', '待培训'));

CREATE INDEX IF NOT EXISTS idx_certs_dept        ON public.certificates(department_id);
CREATE INDEX IF NOT EXISTS idx_certs_valid_until ON public.certificates(valid_until);
CREATE INDEX IF NOT EXISTS idx_certs_renewed_from ON public.certificates(renewed_from);

-- updated_at 自动维护触发器（复用月报系统函数，幂等）
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_certs_updated_at ON public.certificates;
CREATE TRIGGER trg_certs_updated_at
  BEFORE UPDATE ON public.certificates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- --------------------------------------------------------------------------
-- 3. 证照附件记录表（文件本体存 Storage 私有桶 certificates）
--    存储路径约定：{公司ID}/{证照ID}/{随机文件名.ext}
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.certificate_files (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id UUID REFERENCES public.certificates(id) ON DELETE CASCADE NOT NULL,
  file_name      TEXT NOT NULL,               -- 原始文件名（展示用）
  storage_path   TEXT NOT NULL,               -- Storage 对象路径
  file_size      BIGINT,                      -- 字节
  content_type   TEXT,                        -- MIME 类型
  uploaded_by    UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_files_cert ON public.certificate_files(certificate_id);

-- --------------------------------------------------------------------------
-- 3.5 历年培训记录表（与证照 1:N，随证照级联删除）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.certificate_trainings (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id  UUID REFERENCES public.certificates(id) ON DELETE CASCADE NOT NULL,
  training_year   INTEGER NOT NULL,                             -- 培训年份（用于「历年」分组）
  training_date   DATE,                                         -- 培训日期（选填）
  training_content TEXT NOT NULL,                               -- 培训内容
  training_org    TEXT,                                         -- 培训机构 / 组织（选填）
  hours           NUMERIC,                                      -- 培训学时（选填）
  training_result TEXT,                                         -- 培训结果 / 考核（选填，如：合格）
  remark          TEXT,                                         -- 备注（选填）
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_training_year CHECK (training_year >= 2000 AND training_year <= 9999)
);

CREATE INDEX IF NOT EXISTS idx_cert_trainings_cert ON public.certificate_trainings(certificate_id);

-- --------------------------------------------------------------------------
-- 4. 全局设置（单行表：到期预警天数）
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cert_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  warn_days  INTEGER NOT NULL DEFAULT 90 CHECK (warn_days >= 1 AND warn_days <= 365),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO public.cert_settings (id, warn_days) VALUES (1, 90)
  ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 5. RLS 行级安全
-- --------------------------------------------------------------------------

ALTER TABLE public.certificate_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certificate_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cert_settings ENABLE ROW LEVEL SECURITY;

-- 5.1 证照类型字典：所有已登录用户可读（表单下拉需要），写操作只走 RPC
DROP POLICY IF EXISTS "cert_types_select_authenticated" ON public.certificate_types;
CREATE POLICY "cert_types_select_authenticated" ON public.certificate_types
  FOR SELECT TO authenticated USING (true);

-- 5.2 设置：所有已登录用户可读（计算预警状态需要），写操作只走 RPC
DROP POLICY IF EXISTS "cert_settings_select_authenticated" ON public.cert_settings;
CREATE POLICY "cert_settings_select_authenticated" ON public.cert_settings
  FOR SELECT TO authenticated USING (true);

-- 5.3 certificates 策略（v3 权限模型：公司账号只读本公司，管理员全量读写）
DROP POLICY IF EXISTS "certs_select_own_dept" ON public.certificates;
CREATE POLICY "certs_select_own_dept" ON public.certificates
  FOR SELECT TO authenticated USING (
    department_id IN (SELECT department_id FROM public.profiles WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS "certs_select_admin" ON public.certificates;
CREATE POLICY "certs_select_admin" ON public.certificates
  FOR SELECT TO authenticated USING (public.is_admin());

-- 写权限（新增 / 编辑 / 删除）仅管理员；v1/v2 的本公司可写策略一并清理
DROP POLICY IF EXISTS "certs_insert_own_dept" ON public.certificates;
DROP POLICY IF EXISTS "certs_update_own_dept" ON public.certificates;
DROP POLICY IF EXISTS "certs_delete_own_dept" ON public.certificates;

DROP POLICY IF EXISTS "certs_insert_admin" ON public.certificates;
CREATE POLICY "certs_insert_admin" ON public.certificates
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "certs_update_admin" ON public.certificates;
CREATE POLICY "certs_update_admin" ON public.certificates
  FOR UPDATE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "certs_delete_admin" ON public.certificates;
CREATE POLICY "certs_delete_admin" ON public.certificates
  FOR DELETE TO authenticated USING (public.is_admin());

-- 5.4 certificate_files 策略：读跟随所属证照的公司权限，写仅管理员
DROP POLICY IF EXISTS "cert_files_select_own_dept" ON public.certificate_files;
CREATE POLICY "cert_files_select_own_dept" ON public.certificate_files
  FOR SELECT TO authenticated USING (
    certificate_id IN (
      SELECT c.id FROM public.certificates c
      WHERE c.department_id IN (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "cert_files_select_admin" ON public.certificate_files;
CREATE POLICY "cert_files_select_admin" ON public.certificate_files
  FOR SELECT TO authenticated USING (public.is_admin());

-- 附件登记 / 删除仅管理员；v1/v2 的本公司可写策略一并清理
DROP POLICY IF EXISTS "cert_files_insert_own_dept" ON public.certificate_files;
DROP POLICY IF EXISTS "cert_files_delete_own_dept" ON public.certificate_files;

DROP POLICY IF EXISTS "cert_files_insert_admin" ON public.certificate_files;
CREATE POLICY "cert_files_insert_admin" ON public.certificate_files
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "cert_files_delete_admin" ON public.certificate_files;
CREATE POLICY "cert_files_delete_admin" ON public.certificate_files
  FOR DELETE TO authenticated USING (public.is_admin());

-- 5.5 certificate_trainings 策略：读跟随所属证照的公司权限，写仅管理员
ALTER TABLE public.certificate_trainings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cert_trainings_select_own_dept" ON public.certificate_trainings;
CREATE POLICY "cert_trainings_select_own_dept" ON public.certificate_trainings
  FOR SELECT TO authenticated USING (
    certificate_id IN (
      SELECT c.id FROM public.certificates c
      WHERE c.department_id IN (SELECT department_id FROM public.profiles WHERE id = auth.uid())
    )
  );

DROP POLICY IF EXISTS "cert_trainings_select_admin" ON public.certificate_trainings;
CREATE POLICY "cert_trainings_select_admin" ON public.certificate_trainings
  FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "cert_trainings_insert_admin" ON public.certificate_trainings;
CREATE POLICY "cert_trainings_insert_admin" ON public.certificate_trainings
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "cert_trainings_update_admin" ON public.certificate_trainings;
CREATE POLICY "cert_trainings_update_admin" ON public.certificate_trainings
  FOR UPDATE TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "cert_trainings_delete_admin" ON public.certificate_trainings;
CREATE POLICY "cert_trainings_delete_admin" ON public.certificate_trainings
  FOR DELETE TO authenticated USING (public.is_admin());

-- --------------------------------------------------------------------------
-- 6. Storage 私有桶 + 对象级策略（读按公司目录隔离，写/删仅管理员；
--    目录第一层 = 公司的 department_id）
-- --------------------------------------------------------------------------

-- 6.1 创建私有桶（不允许公开访问，下载走签名 URL）
INSERT INTO storage.buckets (id, name, public)
VALUES ('certificates', 'certificates', false)
ON CONFLICT (id) DO NOTHING;

-- 6.2 本公司目录内的对象可读（目录第一层 = 公司 ID）
DROP POLICY IF EXISTS "cert_storage_read_own_dept" ON storage.objects;
CREATE POLICY "cert_storage_read_own_dept" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] IN (
      SELECT department_id::text FROM public.profiles WHERE id = auth.uid()
    )
  );

-- 管理员可读全部证照附件
DROP POLICY IF EXISTS "cert_storage_read_admin" ON storage.objects;
CREATE POLICY "cert_storage_read_admin" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'certificates' AND public.is_admin()
  );

-- 6.3 上传 / 覆盖：仅管理员（v3 权限模型：附件由管理员统一维护）
--     v1/v2 的本公司目录可写策略一并清理
DROP POLICY IF EXISTS "cert_storage_write_own_dept" ON storage.objects;
DROP POLICY IF EXISTS "cert_storage_update_own_dept" ON storage.objects;

DROP POLICY IF EXISTS "cert_storage_write_admin" ON storage.objects;
CREATE POLICY "cert_storage_write_admin" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'certificates' AND public.is_admin()
  );

DROP POLICY IF EXISTS "cert_storage_update_admin" ON storage.objects;
CREATE POLICY "cert_storage_update_admin" ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'certificates' AND public.is_admin()
  );

-- 6.4 删除：仅管理员；v1/v2 的本公司目录可删策略一并清理
DROP POLICY IF EXISTS "cert_storage_delete_own_dept" ON storage.objects;

DROP POLICY IF EXISTS "cert_storage_delete_admin" ON storage.objects;
CREATE POLICY "cert_storage_delete_admin" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'certificates' AND public.is_admin()
  );

-- --------------------------------------------------------------------------
-- 7. RPC
-- --------------------------------------------------------------------------

-- 7.1 新增证照类型（管理员；含子分类维度定义）
--     子分类规则：名称与选项须成对提供；两者都为空表示不启用该维度。
DROP FUNCTION IF EXISTS public.create_certificate_type(TEXT, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION public.create_certificate_type(
  p_name         TEXT,
  p_category     TEXT DEFAULT 'company',
  p_sort_order   INTEGER DEFAULT NULL,
  p_sub1_label   TEXT DEFAULT NULL,
  p_sub1_options TEXT[] DEFAULT NULL,
  p_sub2_label   TEXT DEFAULT NULL,
  p_sub2_options TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_type_id UUID;
  v_sort    INTEGER;
  v_opt1    TEXT[];
  v_opt2    TEXT[];
  v_label1  TEXT;
  v_label2  TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION '类型名称不能为空';
  END IF;
  IF p_category NOT IN ('company', 'personal') THEN
    RAISE EXCEPTION '大类只能是 company（公司证照）或 personal（个人证照）';
  END IF;

  -- 清洗子分类：去空白项；名称与选项成对校验
  SELECT array_agg(trim(o)) INTO v_opt1
  FROM unnest(COALESCE(p_sub1_options, '{}'::text[])) AS o WHERE trim(o) <> '';
  SELECT array_agg(trim(o)) INTO v_opt2
  FROM unnest(COALESCE(p_sub2_options, '{}'::text[])) AS o WHERE trim(o) <> '';
  v_label1 := NULLIF(trim(COALESCE(p_sub1_label, '')), '');
  v_label2 := NULLIF(trim(COALESCE(p_sub2_label, '')), '');

  IF v_label1 IS NULL AND v_opt1 IS NOT NULL THEN
    RAISE EXCEPTION '子分类1已填写选项，请补充子分类名称';
  END IF;
  IF v_label1 IS NOT NULL AND v_opt1 IS NULL THEN
    RAISE EXCEPTION '子分类1已填写名称，请至少填写一个选项';
  END IF;
  IF v_label2 IS NULL AND v_opt2 IS NOT NULL THEN
    RAISE EXCEPTION '子分类2已填写选项，请补充子分类名称';
  END IF;
  IF v_label2 IS NOT NULL AND v_opt2 IS NULL THEN
    RAISE EXCEPTION '子分类2已填写名称，请至少填写一个选项';
  END IF;
  IF v_label1 IS NULL THEN v_opt1 := NULL; END IF;
  IF v_label2 IS NULL THEN v_opt2 := NULL; END IF;

  v_sort := p_sort_order;
  IF v_sort IS NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort FROM public.certificate_types;
  END IF;

  INSERT INTO public.certificate_types
    (name, category, sub1_label, sub1_options, sub2_label, sub2_options, sort_order)
  VALUES (trim(p_name), p_category, v_label1, v_opt1, v_label2, v_opt2, v_sort)
  RETURNING id INTO v_type_id;

  RETURN jsonb_build_object('success', true, 'type_id', v_type_id);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该证照类型已存在';
END;
$$;

-- 7.2 修改证照类型（管理员；含子分类维度定义）
DROP FUNCTION IF EXISTS public.update_certificate_type(UUID, TEXT, TEXT, INTEGER, BOOLEAN);
CREATE OR REPLACE FUNCTION public.update_certificate_type(
  p_type_id      UUID,
  p_name         TEXT,
  p_category     TEXT,
  p_sort_order   INTEGER DEFAULT NULL,
  p_is_active    BOOLEAN DEFAULT TRUE,
  p_sub1_label   TEXT DEFAULT NULL,
  p_sub1_options TEXT[] DEFAULT NULL,
  p_sub2_label   TEXT DEFAULT NULL,
  p_sub2_options TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_opt1   TEXT[];
  v_opt2   TEXT[];
  v_label1 TEXT;
  v_label2 TEXT;
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
  IF p_category NOT IN ('company', 'personal') THEN
    RAISE EXCEPTION '大类只能是 company（公司证照）或 personal（个人证照）';
  END IF;

  SELECT array_agg(trim(o)) INTO v_opt1
  FROM unnest(COALESCE(p_sub1_options, '{}'::text[])) AS o WHERE trim(o) <> '';
  SELECT array_agg(trim(o)) INTO v_opt2
  FROM unnest(COALESCE(p_sub2_options, '{}'::text[])) AS o WHERE trim(o) <> '';
  v_label1 := NULLIF(trim(COALESCE(p_sub1_label, '')), '');
  v_label2 := NULLIF(trim(COALESCE(p_sub2_label, '')), '');

  IF v_label1 IS NULL AND v_opt1 IS NOT NULL THEN
    RAISE EXCEPTION '子分类1已填写选项，请补充子分类名称';
  END IF;
  IF v_label1 IS NOT NULL AND v_opt1 IS NULL THEN
    RAISE EXCEPTION '子分类1已填写名称，请至少填写一个选项';
  END IF;
  IF v_label2 IS NULL AND v_opt2 IS NOT NULL THEN
    RAISE EXCEPTION '子分类2已填写选项，请补充子分类名称';
  END IF;
  IF v_label2 IS NOT NULL AND v_opt2 IS NULL THEN
    RAISE EXCEPTION '子分类2已填写名称，请至少填写一个选项';
  END IF;
  IF v_label1 IS NULL THEN v_opt1 := NULL; END IF;
  IF v_label2 IS NULL THEN v_opt2 := NULL; END IF;

  UPDATE public.certificate_types
  SET name = trim(p_name),
      category = p_category,
      sub1_label = v_label1,
      sub1_options = COALESCE(v_opt1, '{}'),
      sub2_label = v_label2,
      sub2_options = COALESCE(v_opt2, '{}'),
      sort_order = COALESCE(p_sort_order, sort_order),
      is_active = p_is_active
  WHERE id = p_type_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '证照类型不存在或已被删除';
  END IF;

  RETURN jsonb_build_object('success', true);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION '该证照类型已存在';
END;
$$;

-- 7.3 删除证照类型（管理员；有台账引用时阻止，防止数据"消失"）
CREATE OR REPLACE FUNCTION public.delete_certificate_type(
  p_type_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_name       TEXT;
  v_used_count INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;

  SELECT name INTO v_name FROM public.certificate_types WHERE id = p_type_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION '证照类型不存在或已被删除';
  END IF;

  SELECT COUNT(*) INTO v_used_count
  FROM public.certificates
  WHERE cert_type = v_name;

  IF v_used_count > 0 THEN
    RAISE EXCEPTION '已有 % 条证照记录使用了「%」，不能删除。如需停用请编辑并将状态设为停用', v_used_count, v_name;
  END IF;

  DELETE FROM public.certificate_types WHERE id = p_type_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 7.4 更新预警天数（管理员）
CREATE OR REPLACE FUNCTION public.update_cert_settings(
  p_warn_days INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能执行此操作';
  END IF;
  IF p_warn_days IS NULL OR p_warn_days < 1 OR p_warn_days > 365 THEN
    RAISE EXCEPTION '预警天数须在 1 - 365 之间';
  END IF;

  UPDATE public.cert_settings
  SET warn_days = p_warn_days, updated_at = NOW()
  WHERE id = 1;

  RETURN jsonb_build_object('success', true, 'warn_days', p_warn_days);
END;
$$;

-- 7.5 删除证照（仅管理员；连带删除 Storage 附件对象与附件记录）
--     前端删除统一走此 RPC，保证孤儿文件不残留
CREATE OR REPLACE FUNCTION public.delete_certificate(
  p_cert_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dept_id UUID;
BEGIN
  SELECT department_id INTO v_dept_id
  FROM public.certificates WHERE id = p_cert_id;
  IF v_dept_id IS NULL THEN
    RAISE EXCEPTION '证照不存在或已被删除';
  END IF;

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION '只有管理员才能删除证照';
  END IF;

  -- 附件记录由外键 ON DELETE CASCADE 随证照行删除。
  -- 注意：不能在此直接 DELETE storage.objects（Supabase 禁止直接删除 storage 表，
  -- 会报 "Direct deletion from storage tables is not allowed"），
  -- Storage 对象由前端先通过 Storage API（sb.storage.from(...).remove）删除，
  -- 再调用本函数删除证照记录。
  DELETE FROM public.certificates WHERE id = p_cert_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- --------------------------------------------------------------------------
-- 8. 授权：允许已登录用户调用 RPC（权限在函数体内校验）
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_certificate_type(TEXT, TEXT, INTEGER, TEXT, TEXT[], TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_certificate_type(UUID, TEXT, TEXT, INTEGER, BOOLEAN, TEXT, TEXT[], TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_certificate_type(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_cert_settings(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_certificate(UUID) TO authenticated;

-- --------------------------------------------------------------------------
-- 9. 种子数据
-- --------------------------------------------------------------------------

-- 9.1 清理 v1 的通用种子类型（仅删除未被台账引用的；安全生产许可证在新字典中保留）
DELETE FROM public.certificate_types
WHERE name IN (
  '营业执照', '建筑业企业资质证书', '承装（修、试）电力设施许可证', '排污许可证',
  '一般纳税人资格证明', '银行开户许可证',
  '一级建造师注册证', '二级建造师注册证', '安全员证', '施工员证',
  '质量员证', '特种作业操作证', '职称证书'
) AND NOT EXISTS (
  SELECT 1 FROM public.certificates c WHERE c.cert_type = public.certificate_types.name
);

-- 9.2 证照类型种子（公司证照 5 类 + 个人证照 5 类，含子分类维度；管理员可在页面调整）
INSERT INTO public.certificate_types
  (name, category, sub1_label, sub1_options, sub2_label, sub2_options, sort_order)
VALUES
  -- 公司证照（无子分类）
  ('安全生产许可证',       'company', NULL, NULL, NULL, NULL, 1),
  ('爆破作业单位许可证',   'company', NULL, NULL, NULL, NULL, 2),
  ('应急预案备案登记表',   'company', NULL, NULL, NULL, NULL, 3),
  ('安全生产部标准化二级', 'company', NULL, NULL, NULL, NULL, 4),
  ('安全生产责任保险',     'company', NULL, NULL, NULL, NULL, 5),
  -- 个人证照（含子分类维度）
  ('爆破作业人员许可证', 'personal',
     '人员类别', ARRAY['爆破员','保管员','安全员','爆破工程技术人员初级/D','爆破工程技术人员中级/C'],
     NULL, NULL, 11),
  ('非煤矿山安全管理人员证书', 'personal',
     '证书类别', ARRAY['主要负责人','安全管理人员'],
     '学习地点', ARRAY['太原','运城'], 12),
  ('特种作业人员资格证', 'personal',
     '培训机构', ARRAY['应急局','住建局'],
     '作业类别', ARRAY['低压电工作业','焊接与热切割作业'], 13),
  ('安全生产考核合格证书', 'personal',
     '类别', ARRAY['A类人员','B类人员','C类人员'],
     NULL, NULL, 14),
  ('注册安全工程师', 'personal',
     '专业类别', ARRAY['金属非金属矿山安全','其他安全'],
     NULL, NULL, 15)
ON CONFLICT (name) DO UPDATE SET
  category     = EXCLUDED.category,
  sub1_label   = EXCLUDED.sub1_label,
  sub1_options = EXCLUDED.sub1_options,
  sub2_label   = EXCLUDED.sub2_label,
  sub2_options = EXCLUDED.sub2_options,
  sort_order   = EXCLUDED.sort_order;

-- ==========================================================================
-- 验证 SQL：
--   SELECT name, is_company FROM public.departments WHERE is_company = true;
--   SELECT name, category, sub1_label, sub1_options, sub2_label, sub2_options
--     FROM public.certificate_types ORDER BY category, sort_order;
--   SELECT * FROM public.cert_settings;
--   SELECT id, name FROM storage.buckets WHERE id = 'certificates';
-- ==========================================================================

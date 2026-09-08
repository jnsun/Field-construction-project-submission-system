-- D08-1：外协单位当前状态、不可变版本历史与受控维护入口。
BEGIN;

ALTER TABLE public.contractor_companies
  ADD COLUMN IF NOT EXISTS managing_entity_id UUID
  REFERENCES public.departments(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_contractor_companies_managing_entity
  ON public.contractor_companies(managing_entity_id);

CREATE TABLE IF NOT EXISTS public.contractor_company_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  name TEXT NOT NULL,
  unified_code TEXT,
  legal_representative TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  managing_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rejected', 'inactive')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('baseline', 'create', 'update', 'review')),
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contractor_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_contractor_company_versions_history
  ON public.contractor_company_versions(contractor_id, version_no DESC);

-- 已有单位以当前完整状态建立第 1 个基线版本，不改写原业务行。
INSERT INTO public.contractor_company_versions (
  contractor_id, version_no, name, unified_code, legal_representative,
  contact_name, contact_phone, managing_entity_id, status, created_by,
  reviewed_by, reviewed_at, review_note, source_created_at, source_updated_at,
  change_kind, changed_by, changed_at
)
SELECT c.id, 1, c.name, c.unified_code, c.legal_representative,
       c.contact_name, c.contact_phone, c.managing_entity_id, c.status, c.created_by,
       c.reviewed_by, c.reviewed_at, c.review_note, c.created_at, c.updated_at,
       'baseline', COALESCE(c.reviewed_by, c.created_by), c.created_at
FROM public.contractor_companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.contractor_company_versions v WHERE v.contractor_id = c.id
);

CREATE OR REPLACE FUNCTION public.contractor_company_version_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '外协单位历史版本不可修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_company_version_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_contractor_company_versions_immutable ON public.contractor_company_versions;
CREATE TRIGGER trg_contractor_company_versions_immutable
  BEFORE UPDATE OR DELETE ON public.contractor_company_versions
  FOR EACH ROW EXECUTE FUNCTION public.contractor_company_version_guard();

CREATE OR REPLACE FUNCTION public.contractor_company_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_kind TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
      NEW.name, NEW.unified_code, NEW.legal_representative, NEW.contact_name,
      NEW.contact_phone, NEW.managing_entity_id, NEW.status, NEW.reviewed_by,
      NEW.reviewed_at, NEW.review_note
    ) IS NOT DISTINCT FROM ROW(
      OLD.name, OLD.unified_code, OLD.legal_representative, OLD.contact_name,
      OLD.contact_phone, OLD.managing_entity_id, OLD.status, OLD.reviewed_by,
      OLD.reviewed_at, OLD.review_note
    ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.contractor_company_versions
  WHERE contractor_id = NEW.id;

  v_kind := CASE
    WHEN TG_OP = 'INSERT' THEN 'create'
    WHEN NEW.status IS DISTINCT FROM OLD.status
      OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
      OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
      OR NEW.review_note IS DISTINCT FROM OLD.review_note THEN 'review'
    ELSE 'update'
  END;

  INSERT INTO public.contractor_company_versions (
    contractor_id, version_no, name, unified_code, legal_representative,
    contact_name, contact_phone, managing_entity_id, status, created_by,
    reviewed_by, reviewed_at, review_note, source_created_at, source_updated_at,
    change_kind, changed_by
  ) VALUES (
    NEW.id, v_version, NEW.name, NEW.unified_code, NEW.legal_representative,
    NEW.contact_name, NEW.contact_phone, NEW.managing_entity_id, NEW.status, NEW.created_by,
    NEW.reviewed_by, NEW.reviewed_at, NEW.review_note, NEW.created_at, NEW.updated_at,
    v_kind, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_company_snapshot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_contractor_company_snapshot ON public.contractor_companies;
CREATE TRIGGER trg_contractor_company_snapshot
  AFTER INSERT OR UPDATE ON public.contractor_companies
  FOR EACH ROW EXECUTE FUNCTION public.contractor_company_snapshot();

CREATE OR REPLACE FUNCTION public.contractor_company_effective_entity(p_contractor_id UUID)
RETURNS UUID AS $$
  SELECT COALESCE(
    c.managing_entity_id,
    (
      SELECT p.lead_entity_id
      FROM public.contractor_contracts ct
      JOIN public.site_projects p ON p.id = ct.project_id
      WHERE ct.contractor_id = c.id
      ORDER BY ct.created_at, ct.id
      LIMIT 1
    ),
    (
      SELECT pr.department_id
      FROM public.profiles pr
      JOIN public.departments d ON d.id = pr.department_id AND d.dept_type = 'entity'
      WHERE pr.id = c.created_by
    )
  )
  FROM public.contractor_companies c
  WHERE c.id = p_contractor_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_company_effective_entity(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contractor_company_effective_entity(UUID) TO authenticated;

-- 旧单位只回填能够从既有合同或创建人实体明确解析的归属；无法解析的保留 NULL，后续业务入口默认拒绝。
UPDATE public.contractor_companies c
SET managing_entity_id = public.contractor_company_effective_entity(c.id)
WHERE c.managing_entity_id IS NULL
  AND public.contractor_company_effective_entity(c.id) IS NOT NULL;

-- 创建人部门只用于上面的存量一次性回填；运行时不能因创建人后续调动而漂移单位归属。
CREATE OR REPLACE FUNCTION public.contractor_company_effective_entity(p_contractor_id UUID)
RETURNS UUID AS $$
  SELECT COALESCE(
    c.managing_entity_id,
    (
      SELECT p.lead_entity_id
      FROM public.contractor_contracts ct
      JOIN public.site_projects p ON p.id = ct.project_id
      WHERE ct.contractor_id = c.id
      ORDER BY ct.created_at, ct.id
      LIMIT 1
    )
  )
  FROM public.contractor_companies c
  WHERE c.id = p_contractor_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_company_can_manage(p_contractor_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE((
    SELECT auth.uid() IS NOT NULL AND (
      public.training_is_company_admin()
      OR (
        public.is_entity_manager()
        AND public.training_my_dept_id() = public.contractor_company_effective_entity(c.id)
      )
    )
    FROM public.contractor_companies c
    WHERE c.id = p_contractor_id
  ), FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_company_can_read(p_contractor_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    public.contractor_company_can_manage(p_contractor_id)
    OR public.training_is_company_admin()
    OR EXISTS (
      SELECT 1
      FROM public.contractor_contracts ct
      WHERE ct.contractor_id = p_contractor_id
        AND public.site_project_can_read(ct.project_id)
    ), FALSE);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_company_can_manage(UUID), public.contractor_company_can_read(UUID)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contractor_company_can_manage(UUID), public.contractor_company_can_read(UUID)
TO authenticated;

DROP POLICY IF EXISTS contractor_companies_write ON public.contractor_companies;
DROP POLICY IF EXISTS contractor_companies_read ON public.contractor_companies;
CREATE POLICY contractor_companies_read ON public.contractor_companies
  FOR SELECT TO authenticated USING (public.contractor_company_can_read(id));

ALTER TABLE public.contractor_company_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_company_versions_read ON public.contractor_company_versions;
CREATE POLICY contractor_company_versions_read ON public.contractor_company_versions
  FOR SELECT TO authenticated USING (public.contractor_company_can_manage(contractor_id));

REVOKE INSERT, UPDATE, DELETE ON TABLE public.contractor_companies FROM anon, authenticated;
GRANT SELECT ON TABLE public.contractor_companies TO authenticated;
REVOKE ALL ON TABLE public.contractor_company_versions FROM anon, authenticated;
GRANT SELECT ON TABLE public.contractor_company_versions TO authenticated;

CREATE OR REPLACE FUNCTION public.contractor_company_create(
  p_name TEXT,
  p_unified_code TEXT DEFAULT NULL,
  p_legal_representative TEXT DEFAULT NULL,
  p_contact_name TEXT DEFAULT NULL,
  p_contact_phone TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(p_name), '');
  v_code TEXT := NULLIF(upper(btrim(p_unified_code)), '');
  v_legal TEXT := NULLIF(btrim(p_legal_representative), '');
  v_contact TEXT := NULLIF(btrim(p_contact_name), '');
  v_phone TEXT := NULLIF(btrim(p_contact_phone), '');
  v_entity UUID;
  v_existing public.contractor_companies;
  v_company public.contractor_companies;
  v_version INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF public.is_entity_manager() THEN
    v_entity := public.training_my_dept_id();
  ELSIF NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '您无权创建外协单位';
  END IF;
  IF v_name IS NULL OR length(v_name) > 200 THEN RAISE EXCEPTION '单位名称不能为空且不能超过 200 个字符'; END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[0-9A-Z]{18}$' THEN RAISE EXCEPTION '统一社会信用代码必须为 18 位数字或大写字母'; END IF;
  IF length(COALESCE(v_legal, '')) > 100 OR length(COALESCE(v_contact, '')) > 100 THEN RAISE EXCEPTION '法定代表人或负责人不能超过 100 个字符'; END IF;
  IF length(COALESCE(v_phone, '')) > 40 THEN RAISE EXCEPTION '联系电话不能超过 40 个字符'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('contractor-company:name:' || lower(v_name), 0));
  IF v_code IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('contractor-company:code:' || v_code, 0));
  END IF;

  SELECT * INTO v_existing
  FROM public.contractor_companies c
  WHERE lower(btrim(c.name)) = lower(v_name)
     OR (v_code IS NOT NULL AND upper(btrim(c.unified_code)) = v_code)
  ORDER BY c.created_at, c.id
  LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF NOT public.contractor_company_can_manage(v_existing.id) THEN
      RAISE EXCEPTION '该外协单位已存在且不属于当前经营实体';
    END IF;
    IF v_existing.name = v_name
       AND v_existing.unified_code IS NOT DISTINCT FROM v_code
       AND v_existing.legal_representative IS NOT DISTINCT FROM v_legal
       AND v_existing.contact_name IS NOT DISTINCT FROM v_contact
       AND v_existing.contact_phone IS NOT DISTINCT FROM v_phone THEN
      SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = v_existing.id;
      RETURN jsonb_build_object('company_id', v_existing.id, 'created', FALSE, 'version_no', v_version);
    END IF;
    RAISE EXCEPTION '同名或同一统一社会信用代码的外协单位已存在，请修改现有记录';
  END IF;

  INSERT INTO public.contractor_companies (
    name, unified_code, legal_representative, contact_name, contact_phone,
    managing_entity_id, status, created_by
  ) VALUES (
    v_name, v_code, v_legal, v_contact, v_phone, v_entity, 'pending', auth.uid()
  ) RETURNING * INTO v_company;
  SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = v_company.id;
  RETURN jsonb_build_object('company_id', v_company.id, 'created', TRUE, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_company_update(
  p_company_id UUID,
  p_name TEXT,
  p_unified_code TEXT DEFAULT NULL,
  p_legal_representative TEXT DEFAULT NULL,
  p_contact_name TEXT DEFAULT NULL,
  p_contact_phone TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(p_name), '');
  v_code TEXT := NULLIF(upper(btrim(p_unified_code)), '');
  v_legal TEXT := NULLIF(btrim(p_legal_representative), '');
  v_contact TEXT := NULLIF(btrim(p_contact_name), '');
  v_phone TEXT := NULLIF(btrim(p_contact_phone), '');
  v_company public.contractor_companies;
  v_entity UUID;
  v_version INTEGER;
BEGIN
  SELECT * INTO v_company FROM public.contractor_companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '外协单位不存在'; END IF;
  IF NOT public.contractor_company_can_manage(p_company_id) THEN RAISE EXCEPTION '您无权修改该外协单位'; END IF;
  IF v_name IS NULL OR length(v_name) > 200 THEN RAISE EXCEPTION '单位名称不能为空且不能超过 200 个字符'; END IF;
  IF v_code IS NOT NULL AND v_code !~ '^[0-9A-Z]{18}$' THEN RAISE EXCEPTION '统一社会信用代码必须为 18 位数字或大写字母'; END IF;
  IF length(COALESCE(v_legal, '')) > 100 OR length(COALESCE(v_contact, '')) > 100 THEN RAISE EXCEPTION '法定代表人或负责人不能超过 100 个字符'; END IF;
  IF length(COALESCE(v_phone, '')) > 40 THEN RAISE EXCEPTION '联系电话不能超过 40 个字符'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('contractor-company:name:' || lower(v_name), 0));
  IF v_code IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('contractor-company:code:' || v_code, 0));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.contractor_companies c
    WHERE c.id <> p_company_id
      AND (lower(btrim(c.name)) = lower(v_name)
        OR (v_code IS NOT NULL AND upper(btrim(c.unified_code)) = v_code))
  ) THEN
    RAISE EXCEPTION '同名或同一统一社会信用代码的外协单位已存在';
  END IF;

  IF v_company.name = v_name
     AND v_company.unified_code IS NOT DISTINCT FROM v_code
     AND v_company.legal_representative IS NOT DISTINCT FROM v_legal
     AND v_company.contact_name IS NOT DISTINCT FROM v_contact
     AND v_company.contact_phone IS NOT DISTINCT FROM v_phone THEN
    SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = p_company_id;
    RETURN jsonb_build_object('company_id', p_company_id, 'changed', FALSE, 'version_no', v_version);
  END IF;

  v_entity := CASE WHEN public.is_entity_manager() THEN public.training_my_dept_id() ELSE v_company.managing_entity_id END;
  UPDATE public.contractor_companies
  SET name = v_name,
      unified_code = v_code,
      legal_representative = v_legal,
      contact_name = v_contact,
      contact_phone = v_phone,
      managing_entity_id = COALESCE(managing_entity_id, v_entity)
  WHERE id = p_company_id;
  SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = p_company_id;
  RETURN jsonb_build_object('company_id', p_company_id, 'changed', TRUE, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_company_review(
  p_company_id UUID,
  p_status TEXT,
  p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_company public.contractor_companies;
  v_status TEXT := lower(btrim(COALESCE(p_status, '')));
  v_note TEXT := NULLIF(btrim(p_note), '');
  v_version INTEGER;
BEGIN
  SELECT * INTO v_company FROM public.contractor_companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '外协单位不存在'; END IF;
  IF NOT public.contractor_company_can_manage(p_company_id) THEN RAISE EXCEPTION '您无权审核或维护该外协单位'; END IF;
  IF v_status NOT IN ('active', 'rejected', 'inactive') THEN RAISE EXCEPTION '外协单位状态不合法'; END IF;
  IF v_status IN ('rejected', 'inactive') AND v_note IS NULL THEN RAISE EXCEPTION '驳回或停用时必须填写原因'; END IF;
  IF length(COALESCE(v_note, '')) > 1000 THEN RAISE EXCEPTION '审核说明不能超过 1000 个字符'; END IF;

  IF v_company.status = v_status AND v_company.review_note IS NOT DISTINCT FROM v_note THEN
    SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = p_company_id;
    RETURN jsonb_build_object('company_id', p_company_id, 'changed', FALSE, 'status', v_status, 'version_no', v_version);
  END IF;

  UPDATE public.contractor_companies
  SET status = v_status, reviewed_by = auth.uid(), reviewed_at = NOW(), review_note = v_note
  WHERE id = p_company_id;
  SELECT MAX(version_no) INTO v_version FROM public.contractor_company_versions WHERE contractor_id = p_company_id;
  RETURN jsonb_build_object('company_id', p_company_id, 'changed', TRUE, 'status', v_status, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION
  public.contractor_company_create(TEXT, TEXT, TEXT, TEXT, TEXT),
  public.contractor_company_update(UUID, TEXT, TEXT, TEXT, TEXT, TEXT),
  public.contractor_company_review(UUID, TEXT, TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.contractor_company_create(TEXT, TEXT, TEXT, TEXT, TEXT),
  public.contractor_company_update(UUID, TEXT, TEXT, TEXT, TEXT, TEXT),
  public.contractor_company_review(UUID, TEXT, TEXT)
TO authenticated;

COMMIT;

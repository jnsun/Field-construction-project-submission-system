-- D08-4：项目实际特种作业证照匹配，合同/资质/证照不可变归档。
BEGIN;

ALTER TABLE public.site_projects
  ADD COLUMN IF NOT EXISTS includes_drilling BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS drilling_change_reason TEXT,
  ADD COLUMN IF NOT EXISTS drilling_changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS drilling_changed_at TIMESTAMPTZ;

ALTER TABLE public.site_project_members
  ADD COLUMN IF NOT EXISTS special_work_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.site_project_members
  DROP CONSTRAINT IF EXISTS site_project_members_special_work_types_check;
ALTER TABLE public.site_project_members
  ADD CONSTRAINT site_project_members_special_work_types_check CHECK (
    special_work_types <@ ARRAY['爆破', '电工', '焊工']::TEXT[]
    AND array_position(special_work_types, NULL) IS NULL
  ) NOT VALID;
ALTER TABLE public.site_project_members
  VALIDATE CONSTRAINT site_project_members_special_work_types_check;

ALTER TABLE public.site_project_member_assignment_history
  ADD COLUMN IF NOT EXISTS previous_special_work_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS special_work_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.contractor_documents
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason TEXT;

-- 旧证书分类必须先进入下方不可变 baseline，再进行当前业务分类纠偏。

-- 先解除旧函数中的岗位名称推断；文件后部替换所有调用后再删除该兼容函数。
CREATE OR REPLACE FUNCTION public.training_required_special_certificate_type(p_position TEXT)
RETURNS TEXT AS $$ SELECT NULL::TEXT; $$
LANGUAGE sql IMMUTABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_special_work_write_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.special_work_assignment_source', true), '') <> 'rpc'
     AND ((TG_OP = 'INSERT' AND cardinality(NEW.special_work_types) > 0)
       OR (TG_OP = 'UPDATE' AND NEW.special_work_types IS DISTINCT FROM OLD.special_work_types)) THEN
    RAISE EXCEPTION '项目实际特种作业只能通过受控接口维护';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.training_special_work_write_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_special_work_write_guard ON public.site_project_members;
CREATE TRIGGER trg_training_special_work_write_guard
  BEFORE INSERT OR UPDATE ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.training_special_work_write_guard();

CREATE OR REPLACE FUNCTION public.training_project_drilling_write_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.project_drilling_assignment_source', true), '') <> 'rpc'
     AND ((TG_OP = 'INSERT' AND NEW.includes_drilling)
       OR (TG_OP = 'UPDATE' AND NEW.includes_drilling IS DISTINCT FROM OLD.includes_drilling)) THEN
    RAISE EXCEPTION '项目钻探作业属性只能通过受控接口维护';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.training_project_drilling_write_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_project_drilling_write_guard ON public.site_projects;
CREATE TRIGGER trg_training_project_drilling_write_guard
  BEFORE INSERT OR UPDATE ON public.site_projects
  FOR EACH ROW EXECUTE FUNCTION public.training_project_drilling_write_guard();

CREATE OR REPLACE FUNCTION public.site_project_member_assignment_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_source TEXT := COALESCE(NULLIF(current_setting('app.member_assignment_source', true), ''), 'database_update');
  v_reason TEXT := NULLIF(current_setting('app.member_assignment_reason', true), '');
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.contractor_id IS NOT DISTINCT FROM OLD.contractor_id
     AND NEW.work_type IS NOT DISTINCT FROM OLD.work_type
     AND NEW.special_work_types IS NOT DISTINCT FROM OLD.special_work_types THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.site_project_member_assignment_history WHERE member_id = NEW.id;
  INSERT INTO public.site_project_member_assignment_history (
    member_id, project_id, employee_id, version_no, previous_contractor_id,
    contractor_id, previous_work_type, work_type, previous_special_work_types,
    special_work_types, effective_at, change_reason, change_source, changed_by
  ) VALUES (
    NEW.id, NEW.project_id, NEW.employee_id, v_version,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.contractor_id ELSE NULL END,
    NEW.contractor_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.work_type ELSE NULL END,
    NEW.work_type,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.special_work_types ELSE ARRAY[]::TEXT[] END,
    NEW.special_work_types,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.joined_at ELSE NOW() END,
    v_reason, v_source, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_member_assignment_snapshot() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_site_project_member_assignment_snapshot ON public.site_project_members;
CREATE TRIGGER trg_site_project_member_assignment_snapshot
  AFTER INSERT OR UPDATE OF contractor_id, work_type, special_work_types ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.site_project_member_assignment_snapshot();

CREATE OR REPLACE FUNCTION public.training_project_member_reapproval_guard()
RETURNS TRIGGER AS $$
DECLARE v_fields TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NEW.membership_type = 'external' THEN
    IF NEW.contractor_id IS DISTINCT FROM OLD.contractor_id THEN v_fields := array_append(v_fields, '所属外协单位'); END IF;
    IF NEW.work_type IS DISTINCT FROM OLD.work_type THEN v_fields := array_append(v_fields, '项目工种'); END IF;
  END IF;
  IF NEW.special_work_types IS DISTINCT FROM OLD.special_work_types THEN
    v_fields := array_append(v_fields, '本项目实际特种作业');
  END IF;
  IF array_length(v_fields, 1) IS NOT NULL THEN
    PERFORM public.training_request_personnel_reapproval(NEW.project_id, NEW.employee_id, v_fields);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_project_member_reapproval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_project_member_reapproval_guard ON public.site_project_members;
CREATE TRIGGER trg_training_project_member_reapproval_guard
  AFTER UPDATE OF contractor_id, work_type, special_work_types ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.training_project_member_reapproval_guard();

CREATE OR REPLACE FUNCTION public.training_set_member_special_work_types(
  p_member_id UUID, p_special_work_types TEXT[], p_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_member public.site_project_members;
  v_types TEXT[];
  v_reason TEXT := NULLIF(btrim(p_reason), '');
  v_version INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_member FROM public.site_project_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '项目人员关系不存在'; END IF;
  IF NOT public.site_project_can_manage(v_member.project_id) THEN RAISE EXCEPTION '您无权维护该项目人员实际作业'; END IF;
  IF v_reason IS NULL OR length(v_reason) > 1000 THEN RAISE EXCEPTION '请填写不超过 1000 字的作业安排变更原因'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_special_work_types, ARRAY[]::TEXT[])) x WHERE x IS NULL OR btrim(x) NOT IN ('爆破', '电工', '焊工')) THEN
    RAISE EXCEPTION '项目实际特种作业类型不合法';
  END IF;
  SELECT COALESCE(array_agg(x ORDER BY x), ARRAY[]::TEXT[]) INTO v_types
  FROM (SELECT DISTINCT btrim(x) x FROM unnest(COALESCE(p_special_work_types, ARRAY[]::TEXT[])) x) normalized;
  IF v_member.special_work_types = v_types THEN
    SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id = p_member_id;
    RETURN jsonb_build_object('member_id', p_member_id, 'changed', FALSE, 'special_work_types', v_types, 'version_no', v_version);
  END IF;
  PERFORM set_config('app.special_work_assignment_source', 'rpc', true);
  PERFORM set_config('app.member_assignment_source', 'special_work_assignment_rpc', true);
  PERFORM set_config('app.member_assignment_reason', v_reason, true);
  UPDATE public.site_project_members SET special_work_types = v_types WHERE id = p_member_id;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_member.project_id, auth.uid(), 'special_work_assignment_changed', 'site_project_member', p_member_id,
    jsonb_build_object('from', v_member.special_work_types, 'to', v_types, 'reason', v_reason));
  SELECT MAX(version_no) INTO v_version FROM public.site_project_member_assignment_history WHERE member_id = p_member_id;
  RETURN jsonb_build_object('member_id', p_member_id, 'changed', TRUE, 'special_work_types', v_types, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.site_project_set_drilling_operation(
  p_project_id UUID, p_enabled BOOLEAN, p_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_project public.site_projects;
  v_reason TEXT := NULLIF(btrim(p_reason), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权维护该项目钻探作业属性'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION '请明确是否包含钻探作业'; END IF;
  IF v_project.includes_drilling = p_enabled THEN
    RETURN jsonb_build_object('project_id', p_project_id, 'changed', FALSE, 'includes_drilling', p_enabled);
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 1000 THEN RAISE EXCEPTION '请填写不超过 1000 字的钻探作业变更原因'; END IF;
  PERFORM set_config('app.project_drilling_assignment_source', 'rpc', true);
  UPDATE public.site_projects
  SET includes_drilling = p_enabled, drilling_change_reason = v_reason,
      drilling_changed_by = auth.uid(), drilling_changed_at = NOW()
  WHERE id = p_project_id;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (p_project_id, auth.uid(), 'drilling_operation_changed', 'site_project', p_project_id,
    jsonb_build_object('from', v_project.includes_drilling, 'to', p_enabled, 'reason', v_reason));
  RETURN jsonb_build_object('project_id', p_project_id, 'changed', TRUE, 'includes_drilling', p_enabled);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_project_drilling_training_scope(p_project_id UUID)
RETURNS TABLE (
  project_id UUID, member_id UUID, employee_id UUID, membership_type TEXT,
  requires_drilling_training BOOLEAN, requirement_code TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN RAISE EXCEPTION '您无权查看该项目专项培训范围'; END IF;
  RETURN QUERY
  SELECT m.project_id, m.id, m.employee_id, m.membership_type,
         p.includes_drilling,
         CASE WHEN p.includes_drilling THEN 'drilling_project_training'::TEXT ELSE NULL::TEXT END
  FROM public.site_project_members m
  JOIN public.site_projects p ON p.id = m.project_id
  WHERE m.project_id = p_project_id AND m.status = 'active';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION
  public.training_set_member_special_work_types(UUID, TEXT[], TEXT),
  public.site_project_set_drilling_operation(UUID, BOOLEAN, TEXT),
  public.training_project_drilling_training_scope(UUID)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.training_set_member_special_work_types(UUID, TEXT[], TEXT),
  public.site_project_set_drilling_operation(UUID, BOOLEAN, TEXT),
  public.training_project_drilling_training_scope(UUID)
TO authenticated;

CREATE TABLE IF NOT EXISTS public.contractor_contract_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES public.contractor_contracts(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  contractor_id UUID NOT NULL REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  contract_no TEXT,
  contract_name TEXT,
  start_date DATE,
  end_date DATE,
  storage_path TEXT,
  status TEXT NOT NULL,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('baseline', 'create', 'review', 'terminate')),
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contract_id, version_no)
);

CREATE TABLE IF NOT EXISTS public.contractor_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.contractor_documents(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  project_id UUID REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  contractor_id UUID REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  employee_id UUID REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL,
  certificate_type TEXT,
  certificate_no TEXT,
  valid_from DATE,
  valid_until DATE,
  storage_path TEXT NOT NULL,
  review_status TEXT NOT NULL,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revocation_reason TEXT,
  source_created_at TIMESTAMPTZ NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('baseline', 'create', 'review', 'revoke')),
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_contractor_contract_versions_history
  ON public.contractor_contract_versions(contract_id, version_no DESC);
CREATE INDEX IF NOT EXISTS idx_contractor_document_versions_history
  ON public.contractor_document_versions(document_id, version_no DESC);

INSERT INTO public.contractor_contract_versions (
  contract_id, version_no, project_id, contractor_id, contract_no, contract_name,
  start_date, end_date, storage_path, status, reviewed_by, reviewed_at, review_note,
  source_created_at, source_updated_at, change_kind, changed_by, changed_at
)
SELECT c.id, 1, c.project_id, c.contractor_id, c.contract_no, c.contract_name,
       c.start_date, c.end_date, c.storage_path, c.status, c.reviewed_by, c.reviewed_at,
       c.review_note, c.created_at, c.updated_at, 'baseline',
       COALESCE(c.reviewed_by, p.created_by), c.created_at
FROM public.contractor_contracts c
JOIN public.site_projects p ON p.id = c.project_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.contractor_contract_versions v WHERE v.contract_id = c.id
);

INSERT INTO public.contractor_document_versions (
  document_id, version_no, project_id, contractor_id, employee_id, document_type,
  certificate_type, certificate_no, valid_from, valid_until, storage_path,
  review_status, reviewed_by, reviewed_at, review_note, revoked_at, revoked_by,
  revocation_reason, source_created_at, change_kind, changed_by, changed_at
)
SELECT d.id, 1, d.project_id, d.contractor_id, d.employee_id, d.document_type,
       d.certificate_type, d.certificate_no, d.valid_from, d.valid_until, d.storage_path,
       d.review_status, d.reviewed_by, d.reviewed_at, d.review_note, d.revoked_at,
       d.revoked_by, d.revocation_reason, d.created_at, 'baseline', d.reviewed_by, d.created_at
FROM public.contractor_documents d
WHERE NOT EXISTS (
  SELECT 1 FROM public.contractor_document_versions v WHERE v.document_id = d.id
);

CREATE OR REPLACE FUNCTION public.contractor_archive_version_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '外协合同、资质和证照历史不可修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_archive_version_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_contractor_contract_version_guard ON public.contractor_contract_versions;
CREATE TRIGGER trg_contractor_contract_version_guard
  BEFORE UPDATE OR DELETE ON public.contractor_contract_versions
  FOR EACH ROW EXECUTE FUNCTION public.contractor_archive_version_guard();
DROP TRIGGER IF EXISTS trg_contractor_document_version_guard ON public.contractor_document_versions;
CREATE TRIGGER trg_contractor_document_version_guard
  BEFORE UPDATE OR DELETE ON public.contractor_document_versions
  FOR EACH ROW EXECUTE FUNCTION public.contractor_archive_version_guard();

CREATE OR REPLACE FUNCTION public.contractor_contract_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_kind TEXT;
BEGIN
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.contractor_contract_versions WHERE contract_id = NEW.id;
  v_kind := CASE
    WHEN TG_OP = 'INSERT' THEN 'create'
    WHEN NEW.status = 'terminated' AND OLD.status IS DISTINCT FROM NEW.status THEN 'terminate'
    ELSE 'review'
  END;
  INSERT INTO public.contractor_contract_versions (
    contract_id, version_no, project_id, contractor_id, contract_no, contract_name,
    start_date, end_date, storage_path, status, reviewed_by, reviewed_at, review_note,
    source_created_at, source_updated_at, change_kind, changed_by
  ) VALUES (
    NEW.id, v_version, NEW.project_id, NEW.contractor_id, NEW.contract_no,
    NEW.contract_name, NEW.start_date, NEW.end_date, NEW.storage_path, NEW.status,
    NEW.reviewed_by, NEW.reviewed_at, NEW.review_note, NEW.created_at, NEW.updated_at,
    v_kind, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_document_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_kind TEXT;
BEGIN
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.contractor_document_versions WHERE document_id = NEW.id;
  v_kind := CASE
    WHEN TG_OP = 'INSERT' THEN 'create'
    WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN 'revoke'
    ELSE 'review'
  END;
  INSERT INTO public.contractor_document_versions (
    document_id, version_no, project_id, contractor_id, employee_id, document_type,
    certificate_type, certificate_no, valid_from, valid_until, storage_path,
    review_status, reviewed_by, reviewed_at, review_note, revoked_at, revoked_by,
    revocation_reason, source_created_at, change_kind, changed_by
  ) VALUES (
    NEW.id, v_version, NEW.project_id, NEW.contractor_id, NEW.employee_id,
    NEW.document_type, NEW.certificate_type, NEW.certificate_no, NEW.valid_from,
    NEW.valid_until, NEW.storage_path, NEW.review_status, NEW.reviewed_by,
    NEW.reviewed_at, NEW.review_note, NEW.revoked_at, NEW.revoked_by,
    NEW.revocation_reason, NEW.created_at, v_kind, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_contract_snapshot(), public.contractor_document_snapshot()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_contractor_contract_snapshot ON public.contractor_contracts;
CREATE TRIGGER trg_contractor_contract_snapshot
  AFTER INSERT OR UPDATE ON public.contractor_contracts
  FOR EACH ROW EXECUTE FUNCTION public.contractor_contract_snapshot();
DROP TRIGGER IF EXISTS trg_contractor_document_snapshot ON public.contractor_documents;
CREATE TRIGGER trg_contractor_document_snapshot
  AFTER INSERT OR UPDATE ON public.contractor_documents
  FOR EACH ROW EXECUTE FUNCTION public.contractor_document_snapshot();

-- 旧版本允许自由文本证书类型。原始审核事实已经进入 version=1；当前门禁只保留正式三类，
-- 其他旧资料降级为普通历史资料但保留原 certificate_type、审核人、审核时间和文件。
UPDATE public.contractor_documents
SET document_type = 'other',
    review_note = CASE
      WHEN certificate_type = '钻探' THEN concat_ws('；', NULLIF(review_note, ''), '钻探属于项目级专项培训范围，不是人员特种作业证')
      ELSE concat_ws('；', NULLIF(review_note, ''), '旧证书类型仅保留为历史资料，不参与当前项目门禁')
    END
WHERE document_type = 'special_certificate'
  AND (certificate_type IS NULL OR certificate_type NOT IN ('爆破', '电工', '焊工'));

ALTER TABLE public.contractor_documents
  DROP CONSTRAINT IF EXISTS contractor_documents_special_certificate_type_check;
ALTER TABLE public.contractor_documents
  ADD CONSTRAINT contractor_documents_special_certificate_type_check CHECK (
    document_type <> 'special_certificate'
    OR (
      certificate_type IN ('爆破', '电工', '焊工')
      AND employee_id IS NOT NULL
      AND valid_until IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE public.contractor_documents
  VALIDATE CONSTRAINT contractor_documents_special_certificate_type_check;

CREATE OR REPLACE FUNCTION public.contractor_archive_delete_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '外协合同、资质和证照必须永久保留，不能物理删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.contractor_archive_delete_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_contractor_contract_delete_guard ON public.contractor_contracts;
CREATE TRIGGER trg_contractor_contract_delete_guard
  BEFORE DELETE ON public.contractor_contracts
  FOR EACH ROW EXECUTE FUNCTION public.contractor_archive_delete_guard();
DROP TRIGGER IF EXISTS trg_contractor_document_delete_guard ON public.contractor_documents;
CREATE TRIGGER trg_contractor_document_delete_guard
  BEFORE DELETE ON public.contractor_documents
  FOR EACH ROW EXECUTE FUNCTION public.contractor_archive_delete_guard();

ALTER TABLE public.contractor_contract_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_document_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contractor_contract_versions_read ON public.contractor_contract_versions;
CREATE POLICY contractor_contract_versions_read ON public.contractor_contract_versions
  FOR SELECT TO authenticated USING (public.site_project_can_read_management_data(project_id));
DROP POLICY IF EXISTS contractor_document_versions_read ON public.contractor_document_versions;
CREATE POLICY contractor_document_versions_read ON public.contractor_document_versions
  FOR SELECT TO authenticated USING (
    project_id IS NOT NULL AND public.site_project_can_read_management_data(project_id)
  );

DROP POLICY IF EXISTS contractor_contracts_all ON public.contractor_contracts;
DROP POLICY IF EXISTS contractor_documents_write ON public.contractor_documents;
REVOKE ALL PRIVILEGES ON TABLE
  public.contractor_contracts, public.contractor_documents,
  public.project_join_application_attachments
FROM anon, authenticated;
GRANT SELECT ON TABLE public.contractor_contracts, public.contractor_documents,
  public.project_join_application_attachments TO authenticated;
REVOKE ALL ON TABLE public.contractor_contract_versions, public.contractor_document_versions
FROM anon, authenticated;
GRANT SELECT ON TABLE public.contractor_contract_versions, public.contractor_document_versions
TO authenticated;

CREATE OR REPLACE FUNCTION public.contractor_archive_project_company_allowed(
  p_project_id UUID, p_contractor_id UUID
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.contractor_companies c
    WHERE c.id = p_contractor_id
      AND c.status <> 'inactive'
      AND (
        public.training_is_company_admin()
        OR EXISTS (
          SELECT 1 FROM public.site_project_entities pe
          WHERE pe.project_id = p_project_id
            AND pe.entity_id = public.contractor_company_effective_entity(c.id)
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_archive_assert_storage(
  p_storage_path TEXT, p_folder TEXT, p_project_id UUID
) RETURNS VOID AS $$
BEGIN
  IF NULLIF(btrim(p_storage_path), '') IS NULL
     OR p_storage_path NOT LIKE 'training-admission/' || p_folder || '/' || p_project_id::TEXT || '/%'
     OR lower(p_storage_path) !~ '\.(pdf|png|jpe?g|webp)$' THEN
    RAISE EXCEPTION '附件路径或文件类型不合法';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'certificates' AND o.name = p_storage_path
  ) THEN
    RAISE EXCEPTION '附件尚未成功上传';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

REVOKE ALL ON FUNCTION
  public.contractor_archive_project_company_allowed(UUID, UUID),
  public.contractor_archive_assert_storage(TEXT, TEXT, UUID)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.contractor_contract_create(
  p_project_id UUID,
  p_contractor_id UUID,
  p_contract_no TEXT DEFAULT NULL,
  p_contract_name TEXT DEFAULT NULL,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL,
  p_storage_path TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_contract public.contractor_contracts;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权维护该项目合同'; END IF;
  IF NOT public.contractor_archive_project_company_allowed(p_project_id, p_contractor_id) THEN
    RAISE EXCEPTION '外协单位不属于该项目经营实体范围';
  END IF;
  IF p_start_date IS NOT NULL AND p_end_date IS NOT NULL AND p_end_date < p_start_date THEN
    RAISE EXCEPTION '合同结束日期不能早于开始日期';
  END IF;
  IF length(COALESCE(btrim(p_contract_no), '')) > 100 OR length(COALESCE(btrim(p_contract_name), '')) > 300 THEN
    RAISE EXCEPTION '合同编号或名称过长';
  END IF;
  PERFORM public.contractor_archive_assert_storage(p_storage_path, 'contractor-contracts', p_project_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('contractor-contract:' || p_storage_path, 0));
  SELECT * INTO v_contract FROM public.contractor_contracts WHERE storage_path = p_storage_path LIMIT 1;
  IF FOUND THEN
    IF v_contract.project_id <> p_project_id OR v_contract.contractor_id <> p_contractor_id THEN
      RAISE EXCEPTION '该合同附件已归档到其他记录';
    END IF;
    RETURN jsonb_build_object('contract_id', v_contract.id, 'created', FALSE, 'status', v_contract.status);
  END IF;
  INSERT INTO public.contractor_contracts (
    project_id, contractor_id, contract_no, contract_name, start_date, end_date,
    storage_path, status
  ) VALUES (
    p_project_id, p_contractor_id, NULLIF(btrim(p_contract_no), ''),
    NULLIF(btrim(p_contract_name), ''), p_start_date, p_end_date, p_storage_path, 'pending'
  ) RETURNING * INTO v_contract;
  PERFORM public.training_refresh_external_admissions(p_project_id, p_contractor_id);
  RETURN jsonb_build_object('contract_id', v_contract.id, 'created', TRUE, 'status', v_contract.status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

CREATE OR REPLACE FUNCTION public.contractor_contract_review(
  p_contract_id UUID, p_status TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_contract public.contractor_contracts;
  v_status TEXT := lower(btrim(COALESCE(p_status, '')));
  v_note TEXT := NULLIF(btrim(p_note), '');
BEGIN
  SELECT * INTO v_contract FROM public.contractor_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '合同不存在'; END IF;
  IF NOT public.site_project_can_manage(v_contract.project_id) THEN RAISE EXCEPTION '您无权审核该项目合同'; END IF;
  IF v_status NOT IN ('valid', 'terminated') THEN RAISE EXCEPTION '合同审核状态不合法'; END IF;
  IF v_status = 'terminated' AND v_note IS NULL THEN RAISE EXCEPTION '终止或驳回合同时必须填写原因'; END IF;
  IF v_status = 'valid' AND v_contract.end_date IS NOT NULL AND v_contract.end_date < CURRENT_DATE THEN
    RAISE EXCEPTION '已过期合同不能审核为有效';
  END IF;
  IF length(COALESCE(v_note, '')) > 1000 THEN RAISE EXCEPTION '审核说明不能超过 1000 个字符'; END IF;
  IF v_contract.status = v_status AND v_contract.review_note IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('contract_id', v_contract.id, 'changed', FALSE, 'status', v_status);
  END IF;
  UPDATE public.contractor_contracts
  SET status = v_status, reviewed_by = auth.uid(), reviewed_at = NOW(), review_note = v_note
  WHERE id = v_contract.id;
  PERFORM public.training_refresh_external_admissions(v_contract.project_id, v_contract.contractor_id);
  RETURN jsonb_build_object('contract_id', v_contract.id, 'changed', TRUE, 'status', v_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_document_create(
  p_project_id UUID,
  p_contractor_id UUID DEFAULT NULL,
  p_employee_id UUID DEFAULT NULL,
  p_document_type TEXT DEFAULT NULL,
  p_certificate_type TEXT DEFAULT NULL,
  p_certificate_no TEXT DEFAULT NULL,
  p_valid_from DATE DEFAULT NULL,
  p_valid_until DATE DEFAULT NULL,
  p_storage_path TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_document public.contractor_documents;
  v_type TEXT := lower(btrim(COALESCE(p_document_type, '')));
  v_certificate_type TEXT := NULLIF(btrim(p_certificate_type), '');
  v_contractor_id UUID := p_contractor_id;
  v_member_contractor_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权维护该项目资质或证照'; END IF;
  IF v_type NOT IN ('qualification', 'special_certificate', 'other') THEN RAISE EXCEPTION '资料类型不合法'; END IF;
  IF v_type = 'qualification' AND v_contractor_id IS NULL THEN RAISE EXCEPTION '单位资质必须关联外协单位'; END IF;
  IF v_type = 'special_certificate' THEN
    IF p_employee_id IS NULL OR v_certificate_type NOT IN ('爆破', '电工', '焊工')
       OR NULLIF(btrim(p_certificate_no), '') IS NULL OR p_valid_until IS NULL THEN
      RAISE EXCEPTION '特种作业证必须关联人员，并填写受支持的证书类型、编号和有效期';
    END IF;
    IF p_valid_until < CURRENT_DATE THEN RAISE EXCEPTION '特种作业证有效期不能早于今天'; END IF;
    SELECT m.contractor_id INTO v_member_contractor_id
    FROM public.site_project_members m
      WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
        AND m.membership_type = 'external' AND m.status IN ('active', 'left');
    IF NOT FOUND THEN RAISE EXCEPTION '证照人员不属于该项目外协人员范围'; END IF;
    IF v_contractor_id IS NULL THEN
      v_contractor_id := v_member_contractor_id;
    ELSIF v_contractor_id IS DISTINCT FROM v_member_contractor_id THEN
      RAISE EXCEPTION '证照所属单位与人员当前项目归属不一致';
    END IF;
  END IF;
  IF v_contractor_id IS NULL AND p_employee_id IS NULL THEN RAISE EXCEPTION '资料必须关联外协单位或人员'; END IF;
  IF v_contractor_id IS NOT NULL
     AND NOT public.contractor_archive_project_company_allowed(p_project_id, v_contractor_id) THEN
    RAISE EXCEPTION '外协单位不属于该项目经营实体范围';
  END IF;
  IF p_valid_from IS NOT NULL AND p_valid_until IS NOT NULL AND p_valid_until < p_valid_from THEN
    RAISE EXCEPTION '资料有效期结束日期不能早于开始日期';
  END IF;
  IF length(COALESCE(btrim(p_certificate_no), '')) > 160 THEN RAISE EXCEPTION '证书编号过长'; END IF;
  PERFORM public.contractor_archive_assert_storage(p_storage_path, 'contractor-documents', p_project_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('contractor-document:' || p_storage_path, 0));
  SELECT * INTO v_document FROM public.contractor_documents WHERE storage_path = p_storage_path LIMIT 1;
  IF FOUND THEN
    IF v_document.project_id <> p_project_id THEN RAISE EXCEPTION '该资料附件已归档到其他项目'; END IF;
    RETURN jsonb_build_object('document_id', v_document.id, 'created', FALSE, 'status', v_document.review_status);
  END IF;
  INSERT INTO public.contractor_documents (
    project_id, contractor_id, employee_id, document_type, certificate_type,
    certificate_no, valid_from, valid_until, storage_path, review_status
  ) VALUES (
    p_project_id, v_contractor_id, p_employee_id, v_type, v_certificate_type,
    NULLIF(btrim(p_certificate_no), ''), p_valid_from, p_valid_until,
    p_storage_path, 'pending'
  ) RETURNING * INTO v_document;
  PERFORM public.training_refresh_external_admissions(p_project_id, p_contractor_id);
  RETURN jsonb_build_object('document_id', v_document.id, 'created', TRUE, 'status', v_document.review_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

CREATE OR REPLACE FUNCTION public.contractor_document_review(
  p_document_id UUID, p_status TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_document public.contractor_documents;
  v_status TEXT := lower(btrim(COALESCE(p_status, '')));
  v_note TEXT := NULLIF(btrim(p_note), '');
BEGIN
  SELECT * INTO v_document FROM public.contractor_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '资质或证照不存在'; END IF;
  IF NOT public.site_project_can_manage(v_document.project_id) THEN RAISE EXCEPTION '您无权审核该项目资质或证照'; END IF;
  IF v_status NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION '资料审核状态不合法'; END IF;
  IF v_status = 'rejected' AND v_note IS NULL THEN RAISE EXCEPTION '驳回时必须填写原因'; END IF;
  IF v_status = 'approved' AND v_document.revoked_at IS NOT NULL THEN RAISE EXCEPTION '已撤销资料不能重新审核为有效'; END IF;
  IF v_status = 'approved' AND v_document.valid_until IS NOT NULL AND v_document.valid_until < CURRENT_DATE THEN
    RAISE EXCEPTION '已过期资料不能审核为有效';
  END IF;
  IF length(COALESCE(v_note, '')) > 1000 THEN RAISE EXCEPTION '审核说明不能超过 1000 个字符'; END IF;
  IF v_document.review_status = v_status AND v_document.review_note IS NOT DISTINCT FROM v_note THEN
    RETURN jsonb_build_object('document_id', v_document.id, 'changed', FALSE, 'status', v_status);
  END IF;
  UPDATE public.contractor_documents
  SET review_status = v_status, reviewed_by = auth.uid(), reviewed_at = NOW(), review_note = v_note
  WHERE id = v_document.id;
  PERFORM public.training_refresh_external_admissions(v_document.project_id, v_document.contractor_id);
  RETURN jsonb_build_object('document_id', v_document.id, 'changed', TRUE, 'status', v_status);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.contractor_document_revoke(
  p_document_id UUID, p_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_document public.contractor_documents;
  v_reason TEXT := NULLIF(btrim(p_reason), '');
BEGIN
  SELECT * INTO v_document FROM public.contractor_documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '资质或证照不存在'; END IF;
  IF NOT public.site_project_can_manage(v_document.project_id) THEN RAISE EXCEPTION '您无权撤销该项目资质或证照'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION '撤销时必须填写原因'; END IF;
  IF length(v_reason) > 1000 THEN RAISE EXCEPTION '撤销原因不能超过 1000 个字符'; END IF;
  IF v_document.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('document_id', v_document.id, 'changed', FALSE, 'status', 'revoked');
  END IF;
  UPDATE public.contractor_documents
  SET review_status = 'rejected', reviewed_by = auth.uid(), reviewed_at = NOW(),
      review_note = v_reason, revoked_at = NOW(), revoked_by = auth.uid(), revocation_reason = v_reason
  WHERE id = v_document.id;
  PERFORM public.training_refresh_external_admissions(v_document.project_id, v_document.contractor_id);
  RETURN jsonb_build_object('document_id', v_document.id, 'changed', TRUE, 'status', 'revoked');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION
  public.contractor_contract_create(UUID, UUID, TEXT, TEXT, DATE, DATE, TEXT),
  public.contractor_contract_review(UUID, TEXT, TEXT),
  public.contractor_document_create(UUID, UUID, UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT),
  public.contractor_document_review(UUID, TEXT, TEXT),
  public.contractor_document_revoke(UUID, TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.contractor_contract_create(UUID, UUID, TEXT, TEXT, DATE, DATE, TEXT),
  public.contractor_contract_review(UUID, TEXT, TEXT),
  public.contractor_document_create(UUID, UUID, UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT),
  public.contractor_document_review(UUID, TEXT, TEXT),
  public.contractor_document_revoke(UUID, TEXT)
TO authenticated;

CREATE OR REPLACE FUNCTION public.training_certificate_reapproval_guard()
RETURNS TRIGGER AS $$
DECLARE v_relevant BOOLEAN := FALSE;
BEGIN
  IF NEW.document_type = 'special_certificate' AND NEW.project_id IS NOT NULL AND NEW.employee_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.site_project_members m
      WHERE m.project_id = NEW.project_id AND m.employee_id = NEW.employee_id
        AND NEW.certificate_type = ANY(m.special_work_types)
    ) INTO v_relevant;
    IF TG_OP = 'UPDATE' AND NOT v_relevant THEN
      SELECT EXISTS (
        SELECT 1 FROM public.site_project_members m
        WHERE m.project_id = NEW.project_id AND m.employee_id = NEW.employee_id
          AND OLD.certificate_type = ANY(m.special_work_types)
      ) INTO v_relevant;
    END IF;
  END IF;
  IF v_relevant AND (
      TG_OP = 'INSERT'
      OR NEW.review_status IS DISTINCT FROM OLD.review_status
      OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
      OR NEW.certificate_type IS DISTINCT FROM OLD.certificate_type
      OR NEW.certificate_no IS DISTINCT FROM OLD.certificate_no
      OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
      OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    ) THEN
    PERFORM public.training_request_personnel_reapproval(
      NEW.project_id, NEW.employee_id, ARRAY['特种作业证']::TEXT[]
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_certificate_reapproval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_certificate_reapproval_guard ON public.contractor_documents;
CREATE TRIGGER trg_training_certificate_reapproval_guard
  AFTER INSERT OR UPDATE ON public.contractor_documents
  FOR EACH ROW EXECUTE FUNCTION public.training_certificate_reapproval_guard();

CREATE OR REPLACE FUNCTION public.training_special_certificate_status(
  p_project_id UUID, p_employee_id UUID, p_member_id UUID DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_required TEXT[];
  v_type TEXT;
BEGIN
  SELECT m.special_work_types INTO v_required
  FROM public.site_project_members m
  WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
    AND (p_member_id IS NULL OR m.id = p_member_id)
    AND m.membership_type = 'external';
  IF NOT FOUND THEN RETURN 'not_required'; END IF;
  IF cardinality(v_required) = 0 THEN RETURN 'not_required'; END IF;
  FOREACH v_type IN ARRAY v_required LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.contractor_documents d
      WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id
        AND d.document_type = 'special_certificate' AND d.certificate_type = v_type
        AND d.review_status = 'approved' AND d.revoked_at IS NULL
        AND (d.valid_from IS NULL OR d.valid_from <= CURRENT_DATE)
        AND d.valid_until >= CURRENT_DATE
    ) THEN
      IF EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id AND d.document_type = 'special_certificate' AND d.certificate_type = v_type AND d.revoked_at IS NOT NULL) THEN RETURN 'revoked'; END IF;
      IF EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id AND d.document_type = 'special_certificate' AND d.certificate_type = v_type AND d.review_status = 'approved' AND d.revoked_at IS NULL AND d.valid_until < CURRENT_DATE) THEN RETURN 'expired'; END IF;
      IF EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.project_id = p_project_id AND d.employee_id = p_employee_id AND d.document_type = 'special_certificate' AND d.certificate_type = v_type AND d.review_status = 'pending' AND d.revoked_at IS NULL) THEN RETURN 'pending'; END IF;
      RETURN 'missing';
    END IF;
  END LOOP;
  RETURN 'valid';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_special_certificate_status(UUID, UUID, UUID)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_contractor_certificate_statuses(
  p_project_id UUID DEFAULT NULL
) RETURNS TABLE (
  project_id UUID,
  employee_id UUID,
  required_certificate TEXT,
  certificate_status TEXT,
  detail TEXT
) AS $$
  SELECT m.project_id, m.employee_id,
    NULLIF(array_to_string(m.special_work_types, '、'), ''),
    s.status,
    CASE s.status
      WHEN 'not_required' THEN '本项目未启用需持证特种作业'
      WHEN 'valid' THEN '本项目启用作业的匹配证照均已审核且在有效期内'
      WHEN 'expired' THEN '本项目启用作业的匹配证照已过期'
      WHEN 'pending' THEN '本项目启用作业的匹配证照尚待审核'
      WHEN 'revoked' THEN '本项目启用作业的匹配证照已撤销'
      ELSE '本项目启用作业尚未登记匹配证照'
    END
  FROM public.site_project_members m
  CROSS JOIN LATERAL (
    SELECT public.training_special_certificate_status(m.project_id, m.employee_id, m.id) AS status
  ) s
  WHERE m.membership_type = 'external' AND m.status = 'active'
    AND (p_project_id IS NULL OR m.project_id = p_project_id)
    AND public.site_project_can_read_management_data(m.project_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_contractor_certificate_statuses(UUID)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_contractor_certificate_statuses(UUID)
TO authenticated;

CREATE OR REPLACE FUNCTION public.training_external_compliance_reason(
  p_project_id UUID, p_employee_id UUID, p_member_id UUID DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
  v_member public.site_project_members;
  v_company_status TEXT;
  v_certificate_status TEXT;
  v_required TEXT;
BEGIN
  SELECT m.* INTO v_member
  FROM public.site_project_members m
  WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id
    AND (p_member_id IS NULL OR m.id = p_member_id);
  IF NOT FOUND OR v_member.membership_type <> 'external' THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.training_personnel_reapproval_requests r
    WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending'
  ) THEN RETURN '人员关键资料或证照变更待复核'; END IF;
  v_required := NULLIF(array_to_string(v_member.special_work_types, '、'), '');
  SELECT c.status INTO v_company_status FROM public.contractor_companies c WHERE c.id = v_member.contractor_id;
  IF v_company_status IS DISTINCT FROM 'active' THEN RETURN '外协单位尚未审核通过或已停用'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.contractor_contracts c
    WHERE c.project_id = p_project_id AND c.contractor_id = v_member.contractor_id
      AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE)
      AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.contractor_contracts c
      WHERE c.project_id = p_project_id AND c.contractor_id = v_member.contractor_id
        AND c.status = 'valid' AND c.end_date < CURRENT_DATE
    ) THEN RETURN '外协合同已到期'; END IF;
    RETURN '外协合同尚未审核通过';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.contractor_documents d
    WHERE d.project_id = p_project_id AND d.contractor_id = v_member.contractor_id
      AND d.document_type = 'qualification' AND d.review_status = 'approved'
      AND d.revoked_at IS NULL AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.contractor_documents d
      WHERE d.project_id = p_project_id AND d.contractor_id = v_member.contractor_id
        AND d.document_type = 'qualification' AND d.review_status = 'approved'
        AND d.revoked_at IS NULL AND d.valid_until < CURRENT_DATE
    ) THEN RETURN '外协单位资质已过期'; END IF;
    RETURN '外协单位资质尚未审核通过';
  END IF;
  v_certificate_status := public.training_special_certificate_status(p_project_id, p_employee_id, v_member.id);
  IF v_certificate_status = 'expired' THEN RETURN v_required || '特种作业证已过期'; END IF;
  IF v_certificate_status = 'pending' THEN RETURN v_required || '特种作业证尚待审核'; END IF;
  IF v_certificate_status = 'revoked' THEN RETURN v_required || '特种作业证已撤销'; END IF;
  IF v_certificate_status = 'missing' THEN RETURN '本项目启用作业尚未登记匹配的' || v_required || '特种作业证'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_external_compliance_reason(UUID, UUID, UUID)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.site_project_join_file_can_bind(
  p_storage_path TEXT, p_project_id UUID, p_invite_hash TEXT
) RETURNS BOOLEAN AS $$
  SELECT auth.uid() IS NOT NULL
    AND (storage.foldername(p_storage_path))[1] = 'training-admission'
    AND (storage.foldername(p_storage_path))[2] = 'join-applications'
    AND (storage.foldername(p_storage_path))[3] = p_project_id::TEXT
    AND (storage.foldername(p_storage_path))[4] = auth.uid()::TEXT
    AND lower((storage.foldername(p_storage_path))[5]) = lower(p_invite_hash)
    AND lower(p_storage_path) ~ '\.(pdf|png|jpe?g|webp)$'
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'certificates'
        AND o.name = p_storage_path
        AND o.owner_id = auth.uid()::TEXT
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage;

REVOKE ALL ON FUNCTION public.site_project_join_file_can_bind(TEXT, UUID, TEXT)
FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.site_project_join_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.project_join_applications a
    WHERE (a.photo_path = p_storage_path OR EXISTS (
      SELECT 1 FROM public.project_join_application_attachments f
      WHERE f.application_id = a.id AND f.storage_path = p_storage_path
    ))
      AND (storage.foldername(p_storage_path))[1] = 'training-admission'
      AND (storage.foldername(p_storage_path))[2] = 'join-applications'
      AND (storage.foldername(p_storage_path))[3] = a.project_id::TEXT
      AND (storage.foldername(p_storage_path))[4] = a.applicant_user_id::TEXT
      AND EXISTS (
        SELECT 1 FROM public.site_project_invites i
        WHERE i.project_id = a.project_id
          AND i.token_hash = lower((storage.foldername(p_storage_path))[5])
      )
      AND (
        a.applicant_user_id = auth.uid()
        OR public.site_project_can_read_management_data(a.project_id)
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage;

REVOKE ALL ON FUNCTION public.site_project_join_file_can_read(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_join_file_can_read(TEXT) TO authenticated;

-- 入场申请只收集“人员持有证照”附件，不再根据岗位名称强制上传或启用项目实际作业。
CREATE OR REPLACE FUNCTION public.site_project_apply(
  p_token TEXT, p_name TEXT, p_phone TEXT, p_id_number TEXT, p_position TEXT,
  p_contractor_name TEXT, p_contractor_code TEXT, p_photo_path TEXT,
  p_attachments JSONB DEFAULT '[]'::JSONB
) RETURNS UUID AS $$
DECLARE
  v_invite public.site_project_invites;
  v_project public.site_projects;
  v_company public.contractor_companies;
  v_application public.project_join_applications;
  v_employee public.training_employees;
  v_item JSONB;
  v_identity TEXT := upper(btrim(COALESCE(p_id_number, '')));
  v_token TEXT;
  v_key TEXT;
  v_review_path TEXT;
  v_status TEXT;
  v_source_entity UUID;
  v_company_entity UUID;
  v_cycle INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF v_identity !~ '^[1-9][0-9]{16}[0-9X]$' THEN RAISE EXCEPTION '请填写 18 位大陆居民身份证号'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL OR length(btrim(p_name)) > 100
     OR NULLIF(btrim(p_phone), '') IS NULL OR btrim(p_phone) !~ '^1[3-9][0-9]{9}$'
     OR NULLIF(btrim(p_position), '') IS NULL OR length(btrim(p_position)) > 100
     OR NULLIF(btrim(p_contractor_name), '') IS NULL OR length(btrim(p_contractor_name)) > 200 THEN
    RAISE EXCEPTION '姓名、手机号、工种或外协单位不符合要求';
  END IF;
  IF NULLIF(btrim(p_contractor_code), '') IS NOT NULL
     AND upper(btrim(p_contractor_code)) !~ '^[0-9A-Z]{18}$' THEN
    RAISE EXCEPTION '统一社会信用代码必须为 18 位数字或大写字母';
  END IF;
  IF NULLIF(btrim(p_photo_path), '') IS NULL
     OR lower(p_photo_path) !~ '\.(png|jpe?g|webp)$' THEN
    RAISE EXCEPTION '现场照片路径不符合要求';
  END IF;
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::JSONB)) <> 'array'
     OR jsonb_array_length(COALESCE(p_attachments, '[]'::JSONB)) > 3 THEN
    RAISE EXCEPTION '申请附件格式不正确';
  END IF;
  SELECT i.* INTO v_invite
  FROM public.site_project_invites i
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex')
    AND i.revoked_at IS NULL
    AND i.expires_at > NOW()
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效或已过期'; END IF;

  SELECT * INTO v_project FROM public.site_projects WHERE id = v_invite.project_id FOR SHARE;
  IF NOT FOUND OR v_project.status <> 'active' THEN
    RAISE EXCEPTION '项目当前未开放外协人员申请';
  END IF;
  IF NOT public.site_project_join_file_can_bind(p_photo_path, v_project.id, v_invite.token_hash) THEN
    RAISE EXCEPTION '现场照片不存在或不属于当前申请人、项目和邀请码';
  END IF;

  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key'
  LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
  v_token := encode(hmac(v_identity, v_key, 'sha256'), 'hex');

  -- 全局身份锁防止多个项目并发审核时创建第二个人员档案；项目锁保证申请幂等。
  PERFORM pg_advisory_xact_lock(hashtextextended('employee-identity:' || v_token, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('join-identity:' || v_project.id::text || ':' || v_token, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('join-applicant:' || v_project.id::text || ':' || auth.uid()::text, 0));

  SELECT * INTO v_application
  FROM public.project_join_applications a
  WHERE a.project_id = v_project.id
    AND a.id_number_digest = v_token
    AND a.status IN ('pending_project_review', 'pending_entity_review', 'approved')
  ORDER BY a.created_at, a.id
  LIMIT 1;
  IF FOUND THEN
    IF v_application.applicant_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION '该人员在本项目已有有效申请';
    END IF;
    RETURN v_application.id;
  END IF;

  SELECT * INTO v_application
  FROM public.project_join_applications a
  WHERE a.project_id = v_project.id
    AND a.applicant_user_id = auth.uid()
    AND a.status IN ('pending_project_review', 'pending_entity_review', 'approved')
  ORDER BY a.created_at, a.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '当前账号在本项目已有其他有效身份申请';
  END IF;

  SELECT * INTO v_employee
  FROM public.training_employees e
  WHERE e.id_number_match_token = v_token
  FOR UPDATE;
  IF FOUND AND v_employee.user_id IS NOT NULL AND v_employee.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION '该身份已绑定其他账号，请联系经营实体管理员核验';
  END IF;
  IF NOT FOUND AND EXISTS (
    SELECT 1 FROM public.training_employees e
    WHERE e.user_id = auth.uid()
      AND e.id_number_match_token IS DISTINCT FROM v_token
  ) THEN
    RAISE EXCEPTION '当前账号已绑定其他人员身份，请联系经营实体管理员核验';
  END IF;

  IF FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.site_project_members m
      WHERE m.project_id = v_project.id AND m.employee_id = v_employee.id AND m.status = 'active'
    ) THEN
      RAISE EXCEPTION '该人员已经是当前项目的有效成员';
    END IF;
    SELECT p.lead_entity_id INTO v_source_entity
    FROM public.site_project_members m
    JOIN public.site_projects p ON p.id = m.project_id
    WHERE m.employee_id = v_employee.id
      AND m.project_id <> v_project.id
    ORDER BY (m.status = 'active') DESC, m.joined_at DESC, m.id
    LIMIT 1;
    IF EXISTS (
      SELECT 1 FROM public.site_project_members m
      JOIN public.site_projects p ON p.id = m.project_id
      WHERE m.employee_id = v_employee.id
        AND m.project_id <> v_project.id
        AND p.lead_entity_id = v_project.lead_entity_id
    ) OR v_employee.department_id = v_project.lead_entity_id THEN
      v_review_path := 'same_entity_cross_project';
    ELSE
      v_review_path := 'cross_entity';
    END IF;
    v_status := 'pending_entity_review';
  ELSE
    v_review_path := 'first_project';
    v_status := 'pending_project_review';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'join-company:' || v_project.lead_entity_id::text || ':' || lower(btrim(p_contractor_name)), 0));
  SELECT * INTO v_company
  FROM public.contractor_companies c
  WHERE lower(btrim(c.name)) = lower(btrim(p_contractor_name))
    AND COALESCE(upper(btrim(c.unified_code)), '') = COALESCE(NULLIF(upper(btrim(p_contractor_code)), ''), '')
  ORDER BY c.created_at, c.id
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.contractor_companies(
      name, unified_code, managing_entity_id, status, created_by
    ) VALUES (
      btrim(p_contractor_name), NULLIF(upper(btrim(p_contractor_code)), ''),
      v_project.lead_entity_id, 'pending', auth.uid()
    ) RETURNING * INTO v_company;
  ELSIF v_company.status IN ('rejected', 'inactive') THEN
    RAISE EXCEPTION '该外协单位当前不可申请加入项目';
  ELSE
    v_company_entity := public.contractor_company_effective_entity(v_company.id);
    IF v_company_entity IS NULL OR v_company_entity IS DISTINCT FROM v_project.lead_entity_id THEN
      RAISE EXCEPTION '该外协单位归属无法确认或不属于目标项目经营实体';
    END IF;
  END IF;

  SELECT COALESCE(MAX(a.application_cycle), 0) + 1 INTO v_cycle
  FROM public.project_join_applications a
  WHERE a.project_id = v_project.id AND a.id_number_digest = v_token;

  PERFORM set_config('app.join_transition_source', 'site_project_apply', true);
  INSERT INTO public.project_join_applications(
    project_id, applicant_user_id, employee_id, name, phone,
    id_number_ciphertext, id_number_digest, position, photo_path,
    contractor_id, contractor_name_input, contractor_code_input,
    application_type, review_path, source_entity_id, target_entity_id,
    application_cycle, status, identity_resolved_at
  ) VALUES (
    v_project.id, auth.uid(), v_employee.id, btrim(p_name), btrim(p_phone),
    pgp_sym_encrypt(v_identity, v_key, 'cipher-algo=aes256, compress-algo=0'), v_token,
    btrim(p_position), p_photo_path, v_company.id, btrim(p_contractor_name),
    NULLIF(upper(btrim(p_contractor_code)), ''), 'external', v_review_path,
    v_source_entity, v_project.lead_entity_id, v_cycle, v_status, NOW()
  ) RETURNING * INTO v_application;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::JSONB)) LOOP
    IF COALESCE(v_item->>'type', '') NOT IN ('qualification', 'contract', 'special_certificate')
       OR NOT public.site_project_join_file_can_bind(v_item->>'path', v_project.id, v_invite.token_hash) THEN
      RAISE EXCEPTION '申请附件格式不正确';
    END IF;
    INSERT INTO public.project_join_application_attachments(
      application_id, attachment_type, original_name, storage_path
    ) VALUES (
      v_application.id, v_item->>'type', NULLIF(left(v_item->>'name', 160), ''), v_item->>'path'
    );
  END LOOP;
  RETURN v_application.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions;

CREATE OR REPLACE FUNCTION public.site_project_import_application_attachment(
  p_attachment_id UUID, p_certificate_type TEXT DEFAULT NULL,
  p_certificate_no TEXT DEFAULT NULL, p_valid_until DATE DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_file public.project_join_application_attachments;
  v_app public.project_join_applications;
  v_id UUID;
  v_certificate_type TEXT := NULLIF(btrim(p_certificate_type), '');
BEGIN
  SELECT * INTO v_file FROM public.project_join_application_attachments WHERE id = p_attachment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '申请附件不存在'; END IF;
  SELECT * INTO v_app FROM public.project_join_applications WHERE id = v_file.application_id FOR UPDATE;
  IF NOT FOUND OR v_app.status <> 'approved' OR v_app.employee_id IS NULL THEN RAISE EXCEPTION '请先完成入场申请审核后再转入台账'; END IF;
  IF NOT public.site_project_can_manage(v_app.project_id) THEN RAISE EXCEPTION '您无权转入该项目资料'; END IF;
  IF v_file.imported_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'kind', CASE WHEN v_file.imported_contract_id IS NOT NULL THEN 'contract' ELSE 'document' END,
      'id', COALESCE(v_file.imported_contract_id, v_file.imported_document_id), 'created', FALSE
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'certificates' AND o.name = v_file.storage_path) THEN
    RAISE EXCEPTION '申请附件文件不存在';
  END IF;
  IF v_file.attachment_type = 'contract' THEN
    IF v_app.contractor_id IS NULL THEN RAISE EXCEPTION '合同附件缺少外协单位关联'; END IF;
    INSERT INTO public.contractor_contracts(project_id, contractor_id, contract_name, storage_path, status)
    VALUES (v_app.project_id, v_app.contractor_id, COALESCE(NULLIF(v_file.original_name, ''), '外协申请合同附件'), v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
    UPDATE public.project_join_application_attachments SET imported_at = NOW(), imported_contract_id = v_id WHERE id = v_file.id;
    PERFORM public.training_refresh_external_admissions(v_app.project_id, v_app.contractor_id);
    RETURN jsonb_build_object('kind', 'contract', 'id', v_id, 'created', TRUE);
  END IF;
  IF v_file.attachment_type = 'special_certificate' THEN
    IF v_certificate_type NOT IN ('爆破', '电工', '焊工')
       OR NULLIF(btrim(p_certificate_no), '') IS NULL OR p_valid_until IS NULL THEN
      RAISE EXCEPTION '转入特种作业证时必须填写受支持的证书类型、编号和有效期';
    END IF;
    IF p_valid_until < CURRENT_DATE THEN RAISE EXCEPTION '特种作业证有效期不能早于今天'; END IF;
    INSERT INTO public.contractor_documents(project_id, contractor_id, employee_id, document_type, certificate_type, certificate_no, valid_until, storage_path, review_status)
    VALUES (v_app.project_id, v_app.contractor_id, v_app.employee_id, 'special_certificate', v_certificate_type, btrim(p_certificate_no), p_valid_until, v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
  ELSE
    IF v_app.contractor_id IS NULL THEN RAISE EXCEPTION '单位资质附件缺少外协单位关联'; END IF;
    INSERT INTO public.contractor_documents(project_id, contractor_id, document_type, storage_path, review_status)
    VALUES (v_app.project_id, v_app.contractor_id, 'qualification', v_file.storage_path, 'pending')
    RETURNING id INTO v_id;
  END IF;
  UPDATE public.project_join_application_attachments SET imported_at = NOW(), imported_document_id = v_id WHERE id = v_file.id;
  PERFORM public.training_refresh_external_admissions(v_app.project_id, v_app.contractor_id);
  RETURN jsonb_build_object('kind', 'document', 'id', v_id, 'created', TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

REVOKE ALL ON FUNCTION public.site_project_import_application_attachment(UUID, TEXT, TEXT, DATE)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_import_application_attachment(UUID, TEXT, TEXT, DATE)
TO authenticated;

CREATE OR REPLACE FUNCTION public.training_admission_readiness_checklist(
  p_project_id UUID, p_employee_id UUID
) RETURNS TABLE (
  condition_code TEXT, condition_name TEXT, condition_status TEXT,
  detail TEXT, next_action TEXT
) AS $$
BEGIN
  IF NOT public.site_project_can_read_management_data(p_project_id) THEN RAISE EXCEPTION '您无权查看该项目准入清单'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id AND m.status = 'active') THEN RAISE EXCEPTION '该人员不是项目在场成员'; END IF;
  RETURN QUERY
  WITH d AS (
    SELECT m.id AS member_id, m.membership_type, m.contractor_id,
      NULLIF(array_to_string(m.special_work_types, '、'), '') AS required_certificate,
      public.training_special_certificate_status(p_project_id, p_employee_id, m.id) AS certificate_status,
      a.id AS admission_id, a.status AS admission_status, a.blocked_reason,
      a.exam_required, a.exam_passed, a.final_signed_at, a.site_confirmed_at, a.valid_until,
      COALESCE(t.total, 0) AS task_total, COALESCE(t.done, 0) AS task_done,
      public.training_external_compliance_reason(p_project_id, p_employee_id, m.id) AS external_reason
    FROM public.site_project_members m
    LEFT JOIN LATERAL (
      SELECT x.* FROM public.training_admissions x
      WHERE x.project_id = m.project_id AND x.employee_id = m.employee_id
      ORDER BY x.created_at DESC LIMIT 1
    ) a ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::INT AS total, COUNT(*) FILTER (WHERE x.status = 'completed')::INT AS done
      FROM public.training_admission_tasks x WHERE x.admission_id = a.id
    ) t ON TRUE
    WHERE m.project_id = p_project_id AND m.employee_id = p_employee_id AND m.status = 'active'
  )
  SELECT 'personnel_review', '人员关键资料复核',
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN 'pending' ELSE 'passed' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN '身份证号、照片、岗位、所属单位或证照等资料已变更' ELSE '当前无待复核的关键资料变更' END,
      CASE WHEN EXISTS (SELECT 1 FROM public.training_personnel_reapproval_requests r WHERE r.project_id = p_project_id AND r.employee_id = p_employee_id AND r.status = 'pending') THEN '在“入场审核”完成资料复核' ELSE '无需处理' END
  UNION ALL SELECT 'training', '必修培训完成',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.task_total > 0 AND d.task_done = d.task_total THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '尚未发起项目准入培训' ELSE format('已完成 %s / %s 项必修培训', d.task_done, d.task_total) END,
      CASE WHEN d.admission_id IS NULL THEN '在“准入执行”下发培训包' WHEN d.task_done < d.task_total THEN '催办员工完成剩余课件' ELSE '无需处理' END FROM d
  UNION ALL SELECT 'exam', '综合准入考试',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN NOT d.exam_required OR d.exam_passed THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后生成考试' WHEN NOT d.exam_required THEN '本培训包未要求综合考试' WHEN d.exam_passed THEN '考试已通过' ELSE '待参加或通过补考' END,
      CASE WHEN d.admission_id IS NULL OR NOT d.exam_required OR d.exam_passed THEN '无需处理' ELSE '催办员工参加考试' END FROM d
  UNION ALL SELECT 'signature', '员工完整电子签字',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.final_signed_at IS NOT NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后签署' WHEN d.final_signed_at IS NOT NULL THEN '已完成电子签字' ELSE '待员工手写电子签字' END,
      CASE WHEN d.admission_id IS NULL OR d.final_signed_at IS NOT NULL THEN '无需处理' ELSE '催办员工完成全部层级签字' END FROM d
  UNION ALL SELECT 'site_confirm', '项目现场确认',
      CASE WHEN d.admission_id IS NULL THEN 'pending' WHEN d.site_confirmed_at IS NOT NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_id IS NULL THEN '待发起准入后确认' WHEN d.site_confirmed_at IS NOT NULL THEN '项目负责人或安全员已现场确认' ELSE '待项目负责人或安全员现场确认' END,
      CASE WHEN d.admission_id IS NULL OR d.site_confirmed_at IS NOT NULL THEN '无需处理' ELSE '上传现场照片并完成确认' END FROM d
  UNION ALL SELECT 'contractor_company', '外协单位审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN '外协单位已审核有效' ELSE '外协单位尚未审核通过或已停用' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = d.contractor_id AND c.status = 'active') THEN '无需处理' ELSE '在“外协与入场”审核外协单位' END FROM d
  UNION ALL SELECT 'contract', '项目合同审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN '项目合同已审核有效' WHEN EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND c.end_date < CURRENT_DATE) THEN '项目合同已到期' ELSE '项目合同尚未审核通过' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.project_id = p_project_id AND c.contractor_id = d.contractor_id AND c.status = 'valid' AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date >= CURRENT_DATE)) THEN '无需处理' ELSE '在“外协与入场”登记并审核项目合同' END FROM d
  UNION ALL SELECT 'qualification', '外协单位资质审核',
      CASE WHEN d.membership_type <> 'external' THEN 'not_required' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND x.revoked_at IS NULL AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.membership_type <> 'external' THEN '内部员工，不适用' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND x.revoked_at IS NULL AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN '单位资质已审核有效' WHEN EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND x.revoked_at IS NULL AND x.valid_until < CURRENT_DATE) THEN '单位资质已过期' ELSE '单位资质尚未审核通过' END,
      CASE WHEN d.membership_type <> 'external' OR EXISTS (SELECT 1 FROM public.contractor_documents x WHERE x.project_id = p_project_id AND x.contractor_id = d.contractor_id AND x.document_type = 'qualification' AND x.review_status = 'approved' AND x.revoked_at IS NULL AND (x.valid_until IS NULL OR x.valid_until >= CURRENT_DATE)) THEN '无需处理' ELSE '在“外协与入场”登记并审核单位资质' END FROM d
  UNION ALL SELECT 'special_certificate', '本项目实际特种作业证',
      CASE d.certificate_status WHEN 'not_required' THEN 'not_required' WHEN 'valid' THEN 'passed' ELSE 'pending' END,
      CASE d.certificate_status WHEN 'not_required' THEN '本项目未给该人员启用需持证特种作业' WHEN 'valid' THEN '本项目启用的' || d.required_certificate || '作业证照已审核有效' WHEN 'expired' THEN d.required_certificate || '作业所需证照已过期' WHEN 'pending' THEN d.required_certificate || '作业所需证照尚待审核' WHEN 'revoked' THEN d.required_certificate || '作业所需证照已撤销' ELSE '未登记本项目启用的' || d.required_certificate || '作业所需证照' END,
      CASE WHEN d.certificate_status IN ('not_required', 'valid') THEN '无需处理' ELSE '补充并审核本人匹配的' || d.required_certificate || '特种作业证' END FROM d
  UNION ALL SELECT 'result', '当前上岗结论',
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN 'passed' ELSE 'pending' END,
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN '当前满足上岗条件' ELSE COALESCE(d.external_reason, d.blocked_reason, '尚未满足全部准入条件') END,
      CASE WHEN d.admission_status = 'eligible' AND d.external_reason IS NULL THEN '无需处理' ELSE '按以上待处理项逐项完成' END FROM d;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_admission_readiness_checklist(UUID, UUID)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_admission_readiness_checklist(UUID, UUID)
TO authenticated;

CREATE OR REPLACE FUNCTION public.training_temporary_access_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.project_id = NEW.project_id AND m.employee_id = NEW.employee_id
      AND m.status = 'active' AND cardinality(m.special_work_types) > 0
  ) THEN
    RAISE EXCEPTION '当前项目已启用实际特种作业的人员禁止临时通行';
  END IF;
  IF NEW.expires_at > NEW.starts_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION '临时通行最长不得超过 24 小时';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_temporary_access_guard() FROM PUBLIC, anon, authenticated;

-- 所有最终调用已切换到项目+人员显式选择，删除旧的“岗位名称推断证书”入口。
DROP FUNCTION IF EXISTS public.training_required_special_certificate_type(TEXT);

CREATE OR REPLACE FUNCTION public.training_contractor_archive_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.contractor_contracts c
    WHERE c.storage_path = p_storage_path
      AND public.site_project_can_read_management_data(c.project_id)
  ) OR EXISTS (
    SELECT 1 FROM public.contractor_documents d
    WHERE d.storage_path = p_storage_path AND d.project_id IS NOT NULL
      AND public.site_project_can_read_management_data(d.project_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_admission_file_is_archived(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM public.contractor_contracts c WHERE c.storage_path = p_storage_path)
      OR EXISTS (SELECT 1 FROM public.contractor_documents d WHERE d.storage_path = p_storage_path)
      OR EXISTS (SELECT 1 FROM public.project_join_application_attachments f WHERE f.storage_path = p_storage_path)
      OR EXISTS (SELECT 1 FROM public.project_join_applications a WHERE a.photo_path = p_storage_path)
      OR EXISTS (SELECT 1 FROM public.training_admission_signatures s WHERE s.storage_path = p_storage_path)
      OR EXISTS (SELECT 1 FROM public.training_site_confirmations c WHERE c.photo_path = p_storage_path);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION
  public.training_contractor_archive_file_can_read(TEXT),
  public.training_admission_file_is_archived(TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.training_contractor_archive_file_can_read(TEXT),
  public.training_admission_file_is_archived(TEXT)
TO authenticated;

DROP POLICY IF EXISTS "cert_storage_read_admin" ON storage.objects;
CREATE POLICY "cert_storage_read_admin" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'certificates'
    AND public.training_is_company_admin()
    AND COALESCE((storage.foldername(name))[1], '') <> 'training-admission'
  );

DROP POLICY IF EXISTS training_admission_contractor_read ON storage.objects;
CREATE POLICY training_admission_contractor_read ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND (storage.foldername(name))[2] IN ('contractor-contracts', 'contractor-documents')
    AND public.training_contractor_archive_file_can_read(name)
  );

DROP POLICY IF EXISTS training_admission_project_update ON storage.objects;
CREATE POLICY training_admission_project_update ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
    AND NOT public.training_admission_file_is_archived(name)
  ) WITH CHECK (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
    AND NOT public.training_admission_file_is_archived(name)
  );

DROP POLICY IF EXISTS training_admission_project_delete ON storage.objects;
CREATE POLICY training_admission_project_delete ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'certificates'
    AND (storage.foldername(name))[1] = 'training-admission'
    AND public.training_admission_file_can_manage(name)
    AND NOT public.training_admission_file_is_archived(name)
  );

NOTIFY pgrst, 'reload schema';

COMMIT;

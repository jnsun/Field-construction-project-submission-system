-- D08-2A：人员身份加密、关键资料版本与所属外协单位关系历史。
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'training_admission_identity_key') THEN
    PERFORM vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'training_admission_identity_key',
      '培训准入人员身份证加密与匹配密钥'
    );
  END IF;
END $$;

ALTER TABLE public.training_employees
  ADD COLUMN IF NOT EXISTS id_number_ciphertext BYTEA,
  ADD COLUMN IF NOT EXISTS id_number_match_token TEXT,
  ADD COLUMN IF NOT EXISTS identity_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS identity_recorded BOOLEAN
    GENERATED ALWAYS AS (id_number_ciphertext IS NOT NULL) STORED;

-- 回填期间不把“明文转密文”误判为业务身份变更。
DROP TRIGGER IF EXISTS trg_training_employee_reapproval_guard ON public.training_employees;

DO $$
DECLARE
  v_key TEXT;
  v_collision_groups INTEGER;
  v_collision_employee_ids TEXT;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key'
  LIMIT 1;
  IF v_key IS NULL THEN
    RAISE EXCEPTION '身份证加密密钥未配置，v70 已停止且未清除任何明文数据';
  END IF;

  -- 旧版本允许同一身份证形成多个人员档案。先用私有 HMAC 发现碰撞，避免最后以裸 unique violation 失败。
  SELECT count(*), string_agg(array_to_string(employee_ids, ','), ';' ORDER BY employee_ids::TEXT)
  INTO v_collision_groups, v_collision_employee_ids
  FROM (
    SELECT array_agg(id ORDER BY id) AS employee_ids
    FROM public.training_employees
    WHERE NULLIF(btrim(id_number), '') IS NOT NULL OR id_number_match_token IS NOT NULL
    GROUP BY COALESCE(
      id_number_match_token,
      encode(hmac(upper(btrim(id_number)), v_key, 'sha256'), 'hex')
    )
    HAVING count(*) > 1
  ) collisions;
  IF v_collision_groups > 0 THEN
    RAISE EXCEPTION 'v70 身份冲突预检失败：collision_groups=% employee_ids=%（未输出身份证或身份指纹）',
      v_collision_groups, v_collision_employee_ids;
  END IF;

  UPDATE public.training_employees
  SET id_number_ciphertext = pgp_sym_encrypt(
        upper(btrim(id_number)), v_key, 'cipher-algo=aes256, compress-algo=0'),
      id_number_match_token = encode(hmac(upper(btrim(id_number)), v_key, 'sha256'), 'hex'),
      identity_updated_at = COALESCE(identity_updated_at, updated_at, NOW())
  WHERE NULLIF(btrim(id_number), '') IS NOT NULL
    AND (id_number_ciphertext IS NULL OR id_number_match_token IS NULL);

  IF EXISTS (
    SELECT 1 FROM public.training_employees
    WHERE NULLIF(btrim(id_number), '') IS NOT NULL
      AND (id_number_ciphertext IS NULL OR id_number_match_token IS NULL)
  ) THEN
    RAISE EXCEPTION '身份证安全回填未完整完成，v70 已停止且未清除明文数据';
  END IF;

  UPDATE public.training_employees
  SET id_number = NULL
  WHERE id_number IS NOT NULL;

  -- 既有入场申请的裸摘要统一替换为使用 Vault 密钥的 HMAC；无密文时清除旧摘要。
  UPDATE public.project_join_applications
  SET id_number_digest = CASE
    WHEN id_number_ciphertext IS NULL THEN NULL
    ELSE encode(hmac(pgp_sym_decrypt(id_number_ciphertext, v_key), v_key, 'sha256'), 'hex')
  END
  WHERE id_number_digest IS NOT NULL OR id_number_ciphertext IS NOT NULL;
END $$;

ALTER TABLE public.training_employees
  DROP CONSTRAINT IF EXISTS training_employees_id_number_plaintext_empty;
ALTER TABLE public.training_employees
  ADD CONSTRAINT training_employees_id_number_plaintext_empty CHECK (id_number IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_employees_identity_match
  ON public.training_employees(id_number_match_token)
  WHERE id_number_match_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.training_employee_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  name TEXT NOT NULL,
  gender TEXT,
  employee_no TEXT,
  department_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  position TEXT,
  job_grade TEXT,
  phone TEXT,
  hire_date DATE,
  emp_type TEXT NOT NULL,
  status TEXT NOT NULL,
  remark TEXT,
  photo_path TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  id_number_ciphertext BYTEA,
  id_number_match_token TEXT,
  identity_recorded BOOLEAN NOT NULL,
  source_created_at TIMESTAMPTZ NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('baseline', 'create', 'update')),
  change_source TEXT NOT NULL,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_training_employee_versions_history
  ON public.training_employee_versions(employee_id, version_no DESC);

INSERT INTO public.training_employee_versions (
  employee_id, version_no, name, gender, employee_no, department_id, position,
  job_grade, phone, hire_date, emp_type, status, remark, photo_path, user_id,
  id_number_ciphertext, id_number_match_token, identity_recorded,
  source_created_at, source_updated_at, change_kind, change_source, changed_by, changed_at
)
SELECT e.id, 1, e.name, e.gender, e.employee_no, e.department_id, e.position,
       e.job_grade, e.phone, e.hire_date, e.emp_type, e.status, e.remark, e.photo_path, e.user_id,
       e.id_number_ciphertext, e.id_number_match_token, e.id_number_ciphertext IS NOT NULL,
       e.created_at, e.updated_at, 'baseline', 'v70_backfill', e.created_by, e.created_at
FROM public.training_employees e
WHERE NOT EXISTS (
  SELECT 1 FROM public.training_employee_versions v WHERE v.employee_id = e.id
);

CREATE TABLE IF NOT EXISTS public.site_project_member_assignment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.site_project_members(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  previous_contractor_id UUID REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  contractor_id UUID REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  previous_work_type TEXT,
  work_type TEXT,
  effective_at TIMESTAMPTZ NOT NULL,
  change_reason TEXT,
  change_source TEXT NOT NULL,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_id, version_no)
);

CREATE INDEX IF NOT EXISTS idx_member_assignment_history_lookup
  ON public.site_project_member_assignment_history(employee_id, project_id, effective_at DESC);

INSERT INTO public.site_project_member_assignment_history (
  member_id, project_id, employee_id, version_no, previous_contractor_id,
  contractor_id, previous_work_type, work_type, effective_at,
  change_reason, change_source, changed_by, created_at
)
SELECT m.id, m.project_id, m.employee_id, 1, NULL, m.contractor_id, NULL, m.work_type,
       m.joined_at, '存量关系基线', 'v70_backfill', m.created_by, m.joined_at
FROM public.site_project_members m
WHERE NOT EXISTS (
  SELECT 1 FROM public.site_project_member_assignment_history h WHERE h.member_id = m.id
);

CREATE OR REPLACE FUNCTION public.d08_immutable_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '人员历史记录不可修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.d08_immutable_history_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_training_employee_versions_immutable ON public.training_employee_versions;
CREATE TRIGGER trg_training_employee_versions_immutable
  BEFORE UPDATE OR DELETE ON public.training_employee_versions
  FOR EACH ROW EXECUTE FUNCTION public.d08_immutable_history_guard();

DROP TRIGGER IF EXISTS trg_member_assignment_history_immutable ON public.site_project_member_assignment_history;
CREATE TRIGGER trg_member_assignment_history_immutable
  BEFORE UPDATE OR DELETE ON public.site_project_member_assignment_history
  FOR EACH ROW EXECUTE FUNCTION public.d08_immutable_history_guard();

CREATE OR REPLACE FUNCTION public.training_employee_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_source TEXT := COALESCE(NULLIF(current_setting('app.personnel_change_source', true), ''), 'database_update');
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
      NEW.name, NEW.gender, NEW.employee_no, NEW.department_id, NEW.position,
      NEW.job_grade, NEW.phone, NEW.hire_date, NEW.emp_type, NEW.status,
      NEW.remark, NEW.photo_path, NEW.user_id, NEW.id_number_ciphertext,
      NEW.id_number_match_token
    ) IS NOT DISTINCT FROM ROW(
      OLD.name, OLD.gender, OLD.employee_no, OLD.department_id, OLD.position,
      OLD.job_grade, OLD.phone, OLD.hire_date, OLD.emp_type, OLD.status,
      OLD.remark, OLD.photo_path, OLD.user_id, OLD.id_number_ciphertext,
      OLD.id_number_match_token
    ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.training_employee_versions WHERE employee_id = NEW.id;

  INSERT INTO public.training_employee_versions (
    employee_id, version_no, name, gender, employee_no, department_id, position,
    job_grade, phone, hire_date, emp_type, status, remark, photo_path, user_id,
    id_number_ciphertext, id_number_match_token, identity_recorded,
    source_created_at, source_updated_at, change_kind, change_source, changed_by
  ) VALUES (
    NEW.id, v_version, NEW.name, NEW.gender, NEW.employee_no, NEW.department_id, NEW.position,
    NEW.job_grade, NEW.phone, NEW.hire_date, NEW.emp_type, NEW.status, NEW.remark, NEW.photo_path, NEW.user_id,
    NEW.id_number_ciphertext, NEW.id_number_match_token, NEW.id_number_ciphertext IS NOT NULL,
    NEW.created_at, NEW.updated_at, CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
    v_source, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_employee_snapshot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_training_employee_snapshot ON public.training_employees;
CREATE TRIGGER trg_training_employee_snapshot
  AFTER INSERT OR UPDATE ON public.training_employees
  FOR EACH ROW EXECUTE FUNCTION public.training_employee_snapshot();

CREATE OR REPLACE FUNCTION public.site_project_member_assignment_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_version INTEGER;
  v_source TEXT := COALESCE(NULLIF(current_setting('app.member_assignment_source', true), ''), 'database_update');
  v_reason TEXT := NULLIF(current_setting('app.member_assignment_reason', true), '');
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.contractor_id IS NOT DISTINCT FROM OLD.contractor_id
     AND NEW.work_type IS NOT DISTINCT FROM OLD.work_type THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version_no), 0) + 1 INTO v_version
  FROM public.site_project_member_assignment_history WHERE member_id = NEW.id;

  INSERT INTO public.site_project_member_assignment_history (
    member_id, project_id, employee_id, version_no, previous_contractor_id,
    contractor_id, previous_work_type, work_type, effective_at,
    change_reason, change_source, changed_by
  ) VALUES (
    NEW.id, NEW.project_id, NEW.employee_id, v_version,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.contractor_id ELSE NULL END,
    NEW.contractor_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.work_type ELSE NULL END,
    NEW.work_type, CASE WHEN TG_OP = 'INSERT' THEN NEW.joined_at ELSE NOW() END,
    v_reason, v_source, auth.uid()
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_member_assignment_snapshot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_site_project_member_assignment_snapshot ON public.site_project_members;
CREATE TRIGGER trg_site_project_member_assignment_snapshot
  AFTER INSERT OR UPDATE OF contractor_id, work_type ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.site_project_member_assignment_snapshot();

-- 旧守卫在 UPDATE 时会把当前行自身误判为“另一单位关系”，导致合法 A→B 永远失败。
CREATE OR REPLACE FUNCTION public.site_project_member_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contractor_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.employee_id = NEW.employee_id
      AND m.id IS DISTINCT FROM NEW.id
      AND m.status = 'active'
      AND m.contractor_id IS NOT NULL
      AND m.contractor_id IS DISTINCT FROM NEW.contractor_id
  ) THEN
    RAISE EXCEPTION '同一外协人员不能同时归属多个外协单位；变更单位请先结束原有归属';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_member_guard() FROM PUBLIC, anon, authenticated;

-- 入场申请仍复用原密文字段，但摘要统一由数据库使用 Vault 密钥计算。
CREATE OR REPLACE FUNCTION public.training_join_identity_token_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_key TEXT;
  v_identity TEXT;
  v_token TEXT;
BEGIN
  IF NEW.id_number_ciphertext IS NULL THEN
    NEW.id_number_digest := NULL;
    RETURN NEW;
  END IF;
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key'
  LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
  v_identity := upper(btrim(pgp_sym_decrypt(NEW.id_number_ciphertext, v_key)));
  v_token := encode(hmac(v_identity, v_key, 'sha256'), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id::text || ':' || v_token, 0));
  IF EXISTS (
    SELECT 1 FROM public.project_join_applications a
    WHERE a.project_id = NEW.project_id
      AND a.id IS DISTINCT FROM NEW.id
      AND a.id_number_digest = v_token
      AND a.status IN ('pending_project_review', 'pending_entity_review', 'approved')
  ) THEN
    RAISE EXCEPTION '该身份证号已在本项目留存有效申请';
  END IF;
  NEW.id_number_digest := v_token;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions;

CREATE OR REPLACE FUNCTION public.training_employee_can_maintain(p_employee_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
    OR EXISTS (
      SELECT 1 FROM public.training_employees e
      WHERE e.id = p_employee_id
        AND e.department_id IS NOT NULL
        AND public.training_can_write(e.department_id)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_employee_can_maintain(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_employee_can_maintain(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_employee_identity_get(p_employee_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_employee public.training_employees;
  v_key TEXT;
BEGIN
  SELECT * INTO v_employee FROM public.training_employees WHERE id = p_employee_id;
  IF NOT FOUND THEN RAISE EXCEPTION '人员档案不存在'; END IF;
  IF NOT public.training_employee_can_maintain(p_employee_id) THEN
    RAISE EXCEPTION '您无权读取该人员的完整身份证号';
  END IF;
  IF v_employee.id_number_ciphertext IS NULL THEN
    RETURN jsonb_build_object('employee_id', p_employee_id, 'identity_recorded', FALSE, 'id_number', NULL);
  END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
  RETURN jsonb_build_object(
    'employee_id', p_employee_id,
    'identity_recorded', TRUE,
    'id_number', pgp_sym_decrypt(v_employee.id_number_ciphertext, v_key)
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault, extensions;

CREATE OR REPLACE FUNCTION public.training_employee_identity_plain(p_employee_id UUID)
RETURNS TEXT AS $$
DECLARE v_cipher BYTEA; v_key TEXT;
BEGIN
  SELECT id_number_ciphertext INTO v_cipher FROM public.training_employees WHERE id = p_employee_id;
  IF v_cipher IS NULL THEN RETURN NULL; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
  RETURN pgp_sym_decrypt(v_cipher, v_key);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault, extensions;

REVOKE ALL ON FUNCTION public.training_employee_identity_plain(UUID) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF to_regprocedure('public.training_admission_record_cards_v45_private(uuid)') IS NULL THEN
    ALTER FUNCTION public.training_admission_record_cards(UUID)
      RENAME TO training_admission_record_cards_v45_private;
  END IF;
  IF to_regprocedure('public.training_contractor_personnel_ledger_v45_private(uuid)') IS NULL THEN
    ALTER FUNCTION public.training_contractor_personnel_ledger(UUID)
      RENAME TO training_contractor_personnel_ledger_v45_private;
  END IF;
END $$;

REVOKE ALL ON FUNCTION
  public.training_admission_record_cards_v45_private(UUID),
  public.training_contractor_personnel_ledger_v45_private(UUID)
FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.training_admission_record_cards_v45_private(UUID)
  SET search_path = public, vault, extensions;
ALTER FUNCTION public.training_contractor_personnel_ledger_v45_private(UUID)
  SET search_path = public, vault, extensions;

CREATE OR REPLACE FUNCTION public.training_admission_record_cards(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  admission_id UUID, project_code TEXT, project_name TEXT, employee_name TEXT, employee_no TEXT,
  department_name TEXT, work_position TEXT, phone TEXT, id_number TEXT, contractor_name TEXT,
  admission_status TEXT, training_cycle_no INT, levels JSONB, signatures JSONB, retraining_cycles JSONB,
  final_signed_at TIMESTAMPTZ, site_confirmed_at TIMESTAMPTZ, valid_until DATE
) AS $$
BEGIN
  RETURN QUERY
  SELECT r.admission_id, r.project_code, r.project_name, r.employee_name, r.employee_no,
         r.department_name, r.work_position, r.phone,
         CASE WHEN identity.value IS NULL THEN NULL
              ELSE regexp_replace(identity.value, '^(.{3}).*(.{4})$', '\1***********\2') END,
         r.contractor_name, r.admission_status, r.training_cycle_no, r.levels, r.signatures,
         r.retraining_cycles, r.final_signed_at, r.site_confirmed_at, r.valid_until
  FROM public.training_admission_record_cards_v45_private(p_project_id) r
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      public.training_employee_identity_plain(a.employee_id), r.id_number
    ) AS value
    FROM public.training_admissions a WHERE a.id = r.admission_id
  ) identity ON TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_contractor_personnel_ledger(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, phone TEXT, id_number TEXT, work_position TEXT,
  contractor_name TEXT, unified_code TEXT, member_status TEXT, joined_at TIMESTAMPTZ,
  contract_no TEXT, contract_name TEXT, contract_status TEXT, special_certificates TEXT,
  certificate_status TEXT, admission_status TEXT, valid_until DATE
) AS $$
BEGIN
  RETURN QUERY
  SELECT r.project_code, r.project_name, r.employee_name, r.phone,
         CASE WHEN identity.value IS NULL THEN NULL
              ELSE regexp_replace(identity.value, '^(.{3}).*(.{4})$', '\1***********\2') END,
         r.work_position, r.contractor_name, r.unified_code, r.member_status, r.joined_at,
         r.contract_no, r.contract_name, r.contract_status, r.special_certificates,
         r.certificate_status, r.admission_status, r.valid_until
  FROM public.training_contractor_personnel_ledger_v45_private(p_project_id) r
  LEFT JOIN LATERAL (
    SELECT COALESCE(public.training_employee_identity_plain(m.employee_id), r.id_number) AS value
    FROM public.site_projects p
    JOIN public.site_project_members m ON m.project_id = p.id
    JOIN public.training_employees e ON e.id = m.employee_id
    WHERE p.project_code = r.project_code AND e.phone IS NOT DISTINCT FROM r.phone
    ORDER BY m.joined_at DESC LIMIT 1
  ) identity ON TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE public.training_employee_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_member_assignment_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS training_employee_versions_read ON public.training_employee_versions;
CREATE POLICY training_employee_versions_read ON public.training_employee_versions
  FOR SELECT TO authenticated USING (public.training_employee_can_maintain(employee_id));

DROP POLICY IF EXISTS site_project_member_assignment_history_read ON public.site_project_member_assignment_history;
CREATE POLICY site_project_member_assignment_history_read ON public.site_project_member_assignment_history
  FOR SELECT TO authenticated USING (public.site_project_can_manage(project_id));

DROP POLICY IF EXISTS "tr_emp_insert" ON public.training_employees;
DROP POLICY IF EXISTS "tr_emp_update" ON public.training_employees;
DROP POLICY IF EXISTS "tr_emp_delete" ON public.training_employees;

REVOKE ALL ON TABLE public.training_employee_versions, public.site_project_member_assignment_history
FROM anon, authenticated;
GRANT SELECT (
  id, employee_id, version_no, name, gender, employee_no, department_id, position,
  job_grade, phone, hire_date, emp_type, status, remark, photo_path, user_id,
  identity_recorded, source_created_at, source_updated_at, change_kind,
  change_source, changed_by, changed_at
) ON public.training_employee_versions TO authenticated;
GRANT SELECT ON public.site_project_member_assignment_history TO authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.training_employees FROM anon, authenticated;
GRANT SELECT (
  id, name, employee_no, department_id, position, phone, hire_date, emp_type,
  status, remark, created_by, created_at, updated_at, user_id, gender,
  job_grade, photo_path, identity_recorded, identity_updated_at
) ON public.training_employees TO authenticated;

REVOKE SELECT, UPDATE ON TABLE public.project_join_applications FROM authenticated;
GRANT SELECT (
  id, project_id, applicant_user_id, employee_id, name, phone, photo_path,
  contractor_id, contractor_name_input, contractor_code_input, position,
  application_type, status, review_note, project_reviewed_by, project_reviewed_at,
  entity_reviewed_by, entity_reviewed_at, created_at, updated_at
) ON public.project_join_applications TO authenticated;

REVOKE UPDATE, DELETE ON TABLE public.site_project_members FROM authenticated;

CREATE OR REPLACE FUNCTION public.training_change_member_assignment(
  p_member_id UUID,
  p_contractor_id UUID,
  p_work_type TEXT,
  p_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_member public.site_project_members;
  v_project public.site_projects;
  v_company public.contractor_companies;
  v_work_type TEXT := NULLIF(btrim(p_work_type), '');
  v_reason TEXT := NULLIF(btrim(p_reason), '');
  v_version INTEGER;
BEGIN
  SELECT * INTO v_member FROM public.site_project_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '项目人员关系不存在'; END IF;
  IF v_member.membership_type <> 'external' THEN RAISE EXCEPTION '只有外协人员可以变更所属外协单位'; END IF;
  IF NOT public.site_project_can_manage(v_member.project_id) THEN RAISE EXCEPTION '您无权修改该项目人员关系'; END IF;
  IF p_contractor_id IS NULL THEN RAISE EXCEPTION '所属外协单位不能为空'; END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN RAISE EXCEPTION '变更原因不能为空且不能超过 500 个字符'; END IF;
  IF v_work_type IS NULL OR length(v_work_type) > 100 THEN RAISE EXCEPTION '项目工种不能为空且不能超过 100 个字符'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_member.project_id;
  SELECT * INTO v_company FROM public.contractor_companies WHERE id = p_contractor_id;
  IF NOT FOUND OR v_company.status NOT IN ('pending', 'active') THEN RAISE EXCEPTION '目标外协单位不存在或当前不可用'; END IF;
  IF NOT public.training_is_company_admin()
     AND public.contractor_company_effective_entity(v_company.id) IS DISTINCT FROM v_project.lead_entity_id THEN
    RAISE EXCEPTION '目标外协单位归属无法确认或不属于该项目主责经营实体';
  END IF;

  IF v_member.contractor_id IS NOT DISTINCT FROM p_contractor_id
     AND v_member.work_type IS NOT DISTINCT FROM v_work_type THEN
    SELECT MAX(version_no) INTO v_version
    FROM public.site_project_member_assignment_history WHERE member_id = p_member_id;
    RETURN jsonb_build_object('member_id', p_member_id, 'changed', FALSE, 'version_no', v_version);
  END IF;

  PERFORM set_config('app.member_assignment_source', 'member_assignment_rpc', true);
  PERFORM set_config('app.member_assignment_reason', v_reason, true);
  UPDATE public.site_project_members
  SET contractor_id = p_contractor_id, work_type = v_work_type
  WHERE id = p_member_id;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_member.project_id, auth.uid(), 'contractor_assignment_changed', 'site_project_member', p_member_id,
          jsonb_build_object('from_contractor_id', v_member.contractor_id, 'to_contractor_id', p_contractor_id, 'reason', v_reason));
  SELECT MAX(version_no) INTO v_version
  FROM public.site_project_member_assignment_history WHERE member_id = p_member_id;
  RETURN jsonb_build_object('member_id', p_member_id, 'changed', TRUE, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 关键字段变更继续合并到既有待复核任务，但身份证比较改用安全匹配标识。
CREATE OR REPLACE FUNCTION public.training_employee_reapproval_guard()
RETURNS TRIGGER AS $$
DECLARE v_fields TEXT[] := ARRAY[]::TEXT[]; v_project UUID;
BEGIN
  IF NEW.id_number_match_token IS DISTINCT FROM OLD.id_number_match_token THEN v_fields := array_append(v_fields, '身份证号'); END IF;
  IF NEW.photo_path IS DISTINCT FROM OLD.photo_path THEN v_fields := array_append(v_fields, '人员照片'); END IF;
  IF NEW.position IS DISTINCT FROM OLD.position THEN v_fields := array_append(v_fields, '岗位/工种'); END IF;
  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN v_fields := array_append(v_fields, '所属部门'); END IF;
  IF array_length(v_fields, 1) IS NULL THEN RETURN NEW; END IF;
  FOR v_project IN SELECT project_id FROM public.site_project_members WHERE employee_id = NEW.id AND status = 'active' LOOP
    PERFORM public.training_request_personnel_reapproval(v_project, NEW.id, v_fields);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_employee_reapproval_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_training_employee_reapproval_guard ON public.training_employees;
CREATE TRIGGER trg_training_employee_reapproval_guard
  AFTER UPDATE OF id_number_match_token, photo_path, position, department_id ON public.training_employees
  FOR EACH ROW EXECUTE FUNCTION public.training_employee_reapproval_guard();

-- 项目经理/安全员仍可执行普通项目报表，但完整身份证只向公司级或主责经营实体管理员返回。
CREATE OR REPLACE FUNCTION public.training_join_application_identity(p_application_id UUID)
RETURNS TABLE (application_id UUID, employee_name TEXT, id_number TEXT) AS $$
DECLARE v_app public.project_join_applications; v_project public.site_projects; v_key TEXT;
BEGIN
  SELECT * INTO v_app FROM public.project_join_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场申请不存在'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_app.project_id;
  IF NOT public.training_is_company_admin()
     AND NOT (public.is_entity_manager() AND v_project.lead_entity_id = public.training_my_dept_id()) THEN
    RAISE EXCEPTION '您无权查看该申请的完整身份证号';
  END IF;
  IF v_app.id_number_ciphertext IS NULL THEN RAISE EXCEPTION '该申请尚未留存身份证号'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
  WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
  RETURN QUERY SELECT v_app.id, v_app.name, pgp_sym_decrypt(v_app.id_number_ciphertext, v_key);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault, extensions;


REVOKE ALL ON FUNCTION public.training_join_identity_token_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_training_join_identity_token ON public.project_join_applications;
CREATE TRIGGER trg_training_join_identity_token
  BEFORE INSERT OR UPDATE OF id_number_ciphertext, id_number_digest ON public.project_join_applications
  FOR EACH ROW EXECUTE FUNCTION public.training_join_identity_token_guard();

DO $$
BEGIN
  IF to_regprocedure('public.training_employee_create(text,text,text,uuid,text,text,text,text,date,text,text,text,text)') IS NULL
     AND to_regprocedure('public.training_employee_create(text,text,text,uuid,text,text,text,text,date,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.training_employee_create(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT)
      RENAME TO training_employee_create_v69_private;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.training_employee_create(
  p_name TEXT,
  p_gender TEXT DEFAULT NULL,
  p_employee_no TEXT DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_position TEXT DEFAULT NULL,
  p_job_grade TEXT DEFAULT NULL,
  p_id_number TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_hire_date DATE DEFAULT NULL,
  p_emp_type TEXT DEFAULT 'employee',
  p_status TEXT DEFAULT 'active',
  p_remark TEXT DEFAULT NULL,
  p_photo_path TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_name TEXT := NULLIF(btrim(p_name), '');
  v_identity TEXT := NULLIF(upper(btrim(p_id_number)), '');
  v_phone TEXT := NULLIF(btrim(p_phone), '');
  v_key TEXT;
  v_token TEXT;
  v_employee UUID;
  v_photo TEXT := NULLIF(btrim(p_photo_path), '');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF v_name IS NULL OR length(v_name) > 100 THEN RAISE EXCEPTION '姓名不能为空且不能超过 100 个字符'; END IF;
  IF p_department_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '经营实体管理员必须选择管辖范围内的部门'; END IF;
  IF p_department_id IS NOT NULL AND NOT public.training_can_write(p_department_id) THEN RAISE EXCEPTION '您无权在该部门创建人员档案'; END IF;
  IF p_gender IS NOT NULL AND p_gender NOT IN ('男', '女') THEN RAISE EXCEPTION '性别不合法'; END IF;
  IF COALESCE(p_emp_type, '') NOT IN ('employee', 'special', 'manager') THEN RAISE EXCEPTION '人员类型不合法'; END IF;
  IF COALESCE(p_status, '') NOT IN ('active', 'left') THEN RAISE EXCEPTION '人员状态不合法'; END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^1[3-9][0-9]{9}$' THEN RAISE EXCEPTION '手机号格式不正确'; END IF;
  IF v_identity IS NOT NULL AND v_identity !~ '^[1-9][0-9]{16}[0-9X]$' THEN RAISE EXCEPTION '身份证号必须为 18 位大陆居民身份证号'; END IF;
  IF v_photo IS NOT NULL AND (
       (storage.foldername(v_photo))[1] <> 'new-employees'
       OR (storage.foldername(v_photo))[2] <> auth.uid()::TEXT
       OR lower(v_photo) !~ '\.(png|jpe?g|webp)$'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects o
         WHERE o.bucket_id = 'avatars' AND o.name = v_photo AND o.owner_id = auth.uid()::TEXT
       )
     ) THEN
    RAISE EXCEPTION '人员照片不存在或不属于当前受控创建会话';
  END IF;

  IF v_identity IS NOT NULL THEN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
    WHERE name = 'training_admission_identity_key' LIMIT 1;
    IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
    v_token := encode(hmac(v_identity, v_key, 'sha256'), 'hex');
    PERFORM pg_advisory_xact_lock(hashtextextended('employee-identity:' || v_token, 0));
    IF EXISTS (SELECT 1 FROM public.training_employees WHERE id_number_match_token = v_token) THEN
      RAISE EXCEPTION '该身份证号已对应现有人员档案';
    END IF;
  END IF;

  PERFORM set_config('app.personnel_change_source', 'employee_create_rpc', true);
  INSERT INTO public.training_employees (
    name, gender, employee_no, department_id, position, job_grade,
    id_number, id_number_ciphertext, id_number_match_token, identity_updated_at,
    phone, hire_date, emp_type, status, remark, photo_path, created_by
  ) VALUES (
    v_name, NULLIF(btrim(p_gender), ''), NULLIF(btrim(p_employee_no), ''), p_department_id,
    NULLIF(btrim(p_position), ''), NULLIF(btrim(p_job_grade), ''), NULL,
    CASE WHEN v_identity IS NULL THEN NULL ELSE pgp_sym_encrypt(v_identity, v_key, 'cipher-algo=aes256, compress-algo=0') END,
    v_token, CASE WHEN v_identity IS NULL THEN NULL ELSE NOW() END,
    v_phone, p_hire_date, p_emp_type, p_status, NULLIF(btrim(p_remark), ''), v_photo, auth.uid()
  ) RETURNING id INTO v_employee;
  RETURN jsonb_build_object('employee_id', v_employee, 'created', TRUE, 'photo_path', v_photo);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions, storage;

DO $$
BEGIN
  IF to_regprocedure('public.training_employee_create_v69_private(text,text,text,uuid,text,text,text,text,date,text,text,text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.training_employee_create_v69_private(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.training_employee_update(
  p_employee_id UUID,
  p_name TEXT,
  p_gender TEXT DEFAULT NULL,
  p_employee_no TEXT DEFAULT NULL,
  p_department_id UUID DEFAULT NULL,
  p_position TEXT DEFAULT NULL,
  p_job_grade TEXT DEFAULT NULL,
  p_id_number TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_hire_date DATE DEFAULT NULL,
  p_emp_type TEXT DEFAULT 'employee',
  p_status TEXT DEFAULT 'active',
  p_remark TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_old public.training_employees;
  v_name TEXT := NULLIF(btrim(p_name), '');
  v_identity TEXT := NULLIF(upper(btrim(p_id_number)), '');
  v_phone TEXT := NULLIF(btrim(p_phone), '');
  v_key TEXT;
  v_token TEXT;
  v_identity_changed BOOLEAN := FALSE;
  v_changed BOOLEAN;
  v_version INTEGER;
BEGIN
  SELECT * INTO v_old FROM public.training_employees WHERE id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '人员档案不存在'; END IF;
  IF NOT public.training_employee_can_maintain(p_employee_id) THEN RAISE EXCEPTION '您无权修改该人员档案'; END IF;
  IF p_department_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '经营实体管理员不能把人员移出管辖部门'; END IF;
  IF p_department_id IS NOT NULL AND NOT public.training_can_write(p_department_id) THEN RAISE EXCEPTION '您无权把人员调整到该部门'; END IF;
  IF v_name IS NULL OR length(v_name) > 100 THEN RAISE EXCEPTION '姓名不能为空且不能超过 100 个字符'; END IF;
  IF p_gender IS NOT NULL AND p_gender NOT IN ('男', '女') THEN RAISE EXCEPTION '性别不合法'; END IF;
  IF COALESCE(p_emp_type, '') NOT IN ('employee', 'special', 'manager') THEN RAISE EXCEPTION '人员类型不合法'; END IF;
  IF COALESCE(p_status, '') NOT IN ('active', 'left') THEN RAISE EXCEPTION '人员状态不合法'; END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^1[3-9][0-9]{9}$' THEN RAISE EXCEPTION '手机号格式不正确'; END IF;
  IF v_identity IS NOT NULL AND v_identity !~ '^[1-9][0-9]{16}[0-9X]$' THEN RAISE EXCEPTION '身份证号必须为 18 位大陆居民身份证号'; END IF;

  IF v_identity IS NOT NULL THEN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
    WHERE name = 'training_admission_identity_key' LIMIT 1;
    IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置'; END IF;
    v_token := encode(hmac(v_identity, v_key, 'sha256'), 'hex');
    v_identity_changed := v_old.id_number_match_token IS DISTINCT FROM v_token;
    IF v_identity_changed THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('employee-identity:' || v_token, 0));
      IF EXISTS (SELECT 1 FROM public.training_employees WHERE id <> p_employee_id AND id_number_match_token = v_token) THEN
        RAISE EXCEPTION '该身份证号已对应其他人员档案';
      END IF;
    END IF;
  END IF;

  v_changed := ROW(
    v_old.name, v_old.gender, v_old.employee_no, v_old.department_id, v_old.position,
    v_old.job_grade, v_old.phone, v_old.hire_date, v_old.emp_type, v_old.status, v_old.remark
  ) IS DISTINCT FROM ROW(
    v_name, NULLIF(btrim(p_gender), ''), NULLIF(btrim(p_employee_no), ''), p_department_id,
    NULLIF(btrim(p_position), ''), NULLIF(btrim(p_job_grade), ''), v_phone,
    p_hire_date, p_emp_type, p_status, NULLIF(btrim(p_remark), '')
  ) OR v_identity_changed;
  IF NOT v_changed THEN
    SELECT MAX(version_no) INTO v_version FROM public.training_employee_versions WHERE employee_id = p_employee_id;
    RETURN jsonb_build_object('employee_id', p_employee_id, 'changed', FALSE, 'version_no', v_version);
  END IF;

  PERFORM set_config('app.personnel_change_source', 'employee_update_rpc', true);
  UPDATE public.training_employees
  SET name = v_name,
      gender = NULLIF(btrim(p_gender), ''),
      employee_no = NULLIF(btrim(p_employee_no), ''),
      department_id = p_department_id,
      position = NULLIF(btrim(p_position), ''),
      job_grade = NULLIF(btrim(p_job_grade), ''),
      phone = v_phone,
      hire_date = p_hire_date,
      emp_type = p_emp_type,
      status = p_status,
      remark = NULLIF(btrim(p_remark), ''),
      id_number_ciphertext = CASE WHEN v_identity_changed THEN pgp_sym_encrypt(v_identity, v_key, 'cipher-algo=aes256, compress-algo=0') ELSE id_number_ciphertext END,
      id_number_match_token = CASE WHEN v_identity_changed THEN v_token ELSE id_number_match_token END,
      identity_updated_at = CASE WHEN v_identity_changed THEN NOW() ELSE identity_updated_at END
  WHERE id = p_employee_id;
  SELECT MAX(version_no) INTO v_version FROM public.training_employee_versions WHERE employee_id = p_employee_id;
  RETURN jsonb_build_object('employee_id', p_employee_id, 'changed', TRUE, 'version_no', v_version, 'identity_changed', v_identity_changed);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions;

CREATE OR REPLACE FUNCTION public.training_avatar_file_can_read(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN (storage.foldername(p_storage_path))[1] = 'new-employees' THEN EXISTS (
      SELECT 1 FROM public.training_employees e
      WHERE e.photo_path = p_storage_path
        AND (
          e.user_id = auth.uid()
          OR e.id = (SELECT pr.employee_id FROM public.profiles pr WHERE pr.id = auth.uid())
          OR public.training_employee_can_maintain(e.id)
        )
    )
    WHEN (storage.foldername(p_storage_path))[1]
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN FALSE
    ELSE (
      (storage.foldername(p_storage_path))[1] = (
        SELECT pr.employee_id::TEXT FROM public.profiles pr WHERE pr.id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.training_employees e
        WHERE e.id = (storage.foldername(p_storage_path))[1]::UUID
          AND e.user_id = auth.uid()
      )
      OR public.training_employee_can_maintain((storage.foldername(p_storage_path))[1]::UUID)
    )
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage;

CREATE OR REPLACE FUNCTION public.training_avatar_file_can_insert(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL
      OR lower(p_storage_path) !~ '\.(png|jpe?g|webp)$'
      THEN FALSE
    WHEN (storage.foldername(p_storage_path))[1] = 'new-employees' THEN
      (storage.foldername(p_storage_path))[2] = auth.uid()::TEXT
      AND (public.training_is_company_admin() OR public.is_entity_manager())
    WHEN (storage.foldername(p_storage_path))[1]
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN FALSE
    ELSE (
      (storage.foldername(p_storage_path))[1] = (
        SELECT pr.employee_id::TEXT FROM public.profiles pr WHERE pr.id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.training_employees e
        WHERE e.id = (storage.foldername(p_storage_path))[1]::UUID
          AND e.user_id = auth.uid()
      )
      OR public.training_employee_can_maintain((storage.foldername(p_storage_path))[1]::UUID)
    )
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, storage;

CREATE OR REPLACE FUNCTION public.training_avatar_file_can_delete(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT auth.uid() IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.training_employees e WHERE e.photo_path = p_storage_path)
    AND NOT EXISTS (SELECT 1 FROM public.training_employee_versions v WHERE v.photo_path = p_storage_path);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_avatar_file_can_read(TEXT), public.training_avatar_file_can_insert(TEXT),
  public.training_avatar_file_can_delete(TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_avatar_file_can_read(TEXT), public.training_avatar_file_can_insert(TEXT),
  public.training_avatar_file_can_delete(TEXT)
TO authenticated;

DROP POLICY IF EXISTS avatars_read ON storage.objects;
DROP POLICY IF EXISTS avatars_write ON storage.objects;
DROP POLICY IF EXISTS avatars_update ON storage.objects;
DROP POLICY IF EXISTS avatars_delete ON storage.objects;
CREATE POLICY avatars_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'avatars' AND public.training_avatar_file_can_read(name)
);
CREATE POLICY avatars_write ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'avatars' AND public.training_avatar_file_can_insert(name)
);
CREATE POLICY avatars_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'avatars' AND owner_id = auth.uid()::TEXT
  AND public.training_avatar_file_can_delete(name)
);

CREATE OR REPLACE FUNCTION public.training_employee_photo_update(
  p_employee_id UUID, p_photo_path TEXT, p_reason TEXT
) RETURNS JSONB AS $$
DECLARE
  v_employee public.training_employees;
  v_reason TEXT := NULLIF(btrim(p_reason), '');
  v_version INTEGER;
BEGIN
  SELECT * INTO v_employee FROM public.training_employees WHERE id = p_employee_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '人员档案不存在'; END IF;
  IF NOT public.training_employee_can_maintain(p_employee_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles pr
       WHERE pr.id = auth.uid() AND pr.employee_id = p_employee_id
     )
     AND v_employee.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION '您无权修改该人员照片';
  END IF;
  IF v_reason IS NULL OR length(v_reason) > 500 THEN RAISE EXCEPTION '照片变更原因不能为空且不能超过 500 个字符'; END IF;
  IF NULLIF(btrim(p_photo_path), '') IS NULL
     OR (storage.foldername(p_photo_path))[1] <> p_employee_id::TEXT
     OR lower(p_photo_path) !~ '\.(png|jpe?g|webp)$'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects o
       WHERE o.bucket_id = 'avatars' AND o.name = p_photo_path AND o.owner_id = auth.uid()::TEXT
     ) THEN
    RAISE EXCEPTION '人员照片不存在或不属于当前受控上传';
  END IF;
  IF v_employee.photo_path IS NOT DISTINCT FROM p_photo_path THEN
    SELECT MAX(version_no) INTO v_version FROM public.training_employee_versions WHERE employee_id = p_employee_id;
    RETURN jsonb_build_object('employee_id', p_employee_id, 'photo_path', p_photo_path, 'changed', FALSE, 'version_no', v_version);
  END IF;
  PERFORM set_config('app.personnel_change_source', 'employee_photo_rpc', true);
  UPDATE public.training_employees SET photo_path = p_photo_path WHERE id = p_employee_id;
  INSERT INTO public.personnel_change_logs(employee_id, field, old_value, new_value, changed_by)
  VALUES (p_employee_id, 'photo_path', v_employee.photo_path, p_photo_path, auth.uid());
  SELECT MAX(version_no) INTO v_version FROM public.training_employee_versions WHERE employee_id = p_employee_id;
  RETURN jsonb_build_object('employee_id', p_employee_id, 'photo_path', p_photo_path, 'changed', TRUE, 'version_no', v_version);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

-- 保留原“员工自助修改手机号/照片”入口，但照片必须委托给同一受控绑定逻辑。
CREATE OR REPLACE FUNCTION public.employee_self_update(p_field TEXT, p_value TEXT)
RETURNS JSONB AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_emp_id UUID;
  v_old TEXT;
  v_new TEXT := NULLIF(btrim(COALESCE(p_value, '')), '');
  v_photo JSONB;
BEGIN
  SELECT COALESCE(
    (SELECT e.id FROM public.training_employees e WHERE e.user_id = v_uid ORDER BY e.updated_at DESC, e.id LIMIT 1),
    (SELECT pr.employee_id FROM public.profiles pr WHERE pr.id = v_uid)
  ) INTO v_emp_id;
  IF v_emp_id IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案，无法自助修改'; END IF;

  IF p_field = 'photo_path' THEN
    v_photo := public.training_employee_photo_update(v_emp_id, v_new, '员工本人更新照片');
    RETURN v_photo || jsonb_build_object('success', TRUE, 'field', 'photo_path');
  ELSIF p_field <> 'phone' THEN
    RAISE EXCEPTION '不允许自助修改该字段：%', p_field;
  END IF;

  IF v_new IS NULL OR v_new !~ '^1[3-9][0-9]{9}$' THEN
    RAISE EXCEPTION '手机号格式不正确（应为 11 位国内手机号）';
  END IF;
  IF EXISTS (SELECT 1 FROM public.training_employees WHERE phone = v_new AND id <> v_emp_id)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE phone = v_new AND employee_id <> v_emp_id) THEN
    RAISE EXCEPTION '该手机号已被其他员工或账号使用';
  END IF;
  SELECT phone INTO v_old FROM public.training_employees WHERE id = v_emp_id;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN jsonb_build_object('success', TRUE, 'field', 'phone', 'changed', FALSE);
  END IF;
  PERFORM set_config('app.personnel_change_source', 'employee_self_update', true);
  UPDATE public.training_employees SET phone = v_new, updated_at = NOW() WHERE id = v_emp_id;
  UPDATE public.profiles SET phone = v_new WHERE employee_id = v_emp_id;
  INSERT INTO public.personnel_change_logs(employee_id, field, old_value, new_value, changed_by)
  VALUES (v_emp_id, 'phone', v_old, v_new, v_uid);
  RETURN jsonb_build_object('success', TRUE, 'field', 'phone', 'changed', TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, storage;

REVOKE ALL ON FUNCTION public.employee_self_update(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.employee_self_update(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_employee_batch_create(p_people JSONB)
RETURNS JSONB AS $$
DECLARE
  v_item JSONB;
  v_count INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN
    RAISE EXCEPTION '请至少导入一名人员';
  END IF;
  IF jsonb_array_length(p_people) > 500 THEN RAISE EXCEPTION '单次最多导入 500 人'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    PERFORM public.training_employee_create(
      v_item->>'name', v_item->>'gender', v_item->>'employee_no',
      NULLIF(v_item->>'department_id', '')::UUID, v_item->>'position', v_item->>'job_grade',
      v_item->>'id_number', v_item->>'phone', NULLIF(v_item->>'hire_date', '')::DATE,
      COALESCE(NULLIF(v_item->>'emp_type', ''), 'employee'),
      COALESCE(NULLIF(v_item->>'status', ''), 'active'), v_item->>'remark'
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('created', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions;

REVOKE ALL ON FUNCTION
  public.training_employee_create(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT),
  public.training_employee_update(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT),
  public.training_employee_photo_update(UUID, TEXT, TEXT),
  public.training_employee_batch_create(JSONB),
  public.training_employee_identity_get(UUID),
  public.training_change_member_assignment(UUID, UUID, TEXT, TEXT),
  public.training_join_application_identity(UUID),
  public.training_admission_record_cards(UUID),
  public.training_contractor_personnel_ledger(UUID),
  public.training_employees_batch_delete(UUID[])
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.training_employee_create(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT),
  public.training_employee_update(UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT),
  public.training_employee_photo_update(UUID, TEXT, TEXT),
  public.training_employee_batch_create(JSONB),
  public.training_employee_identity_get(UUID),
  public.training_change_member_assignment(UUID, UUID, TEXT, TEXT),
  public.training_join_application_identity(UUID),
  public.training_admission_record_cards(UUID),
  public.training_contractor_personnel_ledger(UUID)
TO authenticated;

REVOKE ALL ON FUNCTION public.training_employees_batch_delete(UUID[]) FROM authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

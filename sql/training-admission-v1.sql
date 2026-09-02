-- 培训入场准入 v1
-- 只建立数据底座与安全约束，不执行任何数据迁移。
-- 依赖：schema.sql、department-tree.sql、training-management.sql、
--       training-online-v2.sql、personnel-center-v1.sql、certificate-management.sql。

CREATE SEQUENCE IF NOT EXISTS public.site_project_code_seq;

CREATE OR REPLACE FUNCTION public.next_site_project_code()
RETURNS TEXT AS $$
  SELECT 'XMBH-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.site_project_code_seq')::TEXT, 4, '0');
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public;

CREATE TABLE IF NOT EXISTS public.site_projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code      TEXT NOT NULL UNIQUE DEFAULT public.next_site_project_code(),
  name              TEXT NOT NULL,
  project_type      TEXT,
  location          TEXT,
  status            TEXT NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning', 'active', 'paused', 'pending_close', 'closed')),
  start_date        DATE,
  expected_end_date DATE,
  actual_end_date   DATE,
  lead_entity_id    UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  pause_started_at  TIMESTAMPTZ,
  pause_reason      TEXT,
  closed_at         TIMESTAMPTZ,
  closed_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  close_reason      TEXT,
  report_notes      TEXT,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_projects_lead ON public.site_projects(lead_entity_id);
CREATE INDEX IF NOT EXISTS idx_site_projects_status ON public.site_projects(status);

CREATE TABLE IF NOT EXISTS public.site_project_audit_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID REFERENCES public.site_projects(id) ON DELETE SET NULL,
  actor_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  detail       JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_project_audit_project
  ON public.site_project_audit_logs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.site_project_entities (
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  entity_id  UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  is_lead    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_site_project_entities_entity
  ON public.site_project_entities(entity_id);

CREATE TABLE IF NOT EXISTS public.site_project_roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('project_manager', 'safety_officer')),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_site_project_roles_user
  ON public.site_project_roles(user_id, project_id, active);

CREATE TABLE IF NOT EXISTS public.site_project_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_project_invites_project
  ON public.site_project_invites(project_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.contractor_companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  unified_code    TEXT,
  legal_representative TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'active', 'rejected', 'inactive')),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, unified_code)
);

CREATE TABLE IF NOT EXISTS public.contractor_contracts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  contractor_id UUID NOT NULL REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  contract_no  TEXT,
  contract_name TEXT,
  start_date   DATE,
  end_date     DATE,
  storage_path TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'valid', 'expired', 'terminated')),
  reviewed_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  review_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.contractor_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID REFERENCES public.contractor_companies(id) ON DELETE CASCADE,
  employee_id   UUID REFERENCES public.training_employees(id) ON DELETE CASCADE,
  project_id    UUID REFERENCES public.site_projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('qualification', 'special_certificate', 'other')),
  certificate_type TEXT,
  certificate_no TEXT,
  valid_from    DATE,
  valid_until   DATE,
  storage_path  TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (review_status IN ('pending', 'approved', 'rejected')),
  reviewed_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (contractor_id IS NOT NULL OR employee_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_contractor_documents_expiry
  ON public.contractor_documents(valid_until, review_status);

CREATE TABLE IF NOT EXISTS public.project_join_applications (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  applicant_user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_id           UUID REFERENCES public.training_employees(id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL,
  id_number_ciphertext  BYTEA,
  id_number_digest      TEXT,
  photo_path            TEXT,
  contractor_id         UUID REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  contractor_name_input TEXT,
  contractor_code_input TEXT,
  position              TEXT,
  application_type      TEXT NOT NULL DEFAULT 'external'
                        CHECK (application_type IN ('external', 'internal')),
  status                TEXT NOT NULL DEFAULT 'pending_project_review'
                        CHECK (status IN ('pending_project_review', 'pending_entity_review', 'approved', 'rejected', 'cancelled')),
  review_note           TEXT,
  project_reviewed_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  project_reviewed_at   TIMESTAMPTZ,
  entity_reviewed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  entity_reviewed_at    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_join_applications_project
  ON public.project_join_applications(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_join_applications_phone
  ON public.project_join_applications(phone);

CREATE TABLE IF NOT EXISTS public.site_project_members (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  contractor_id UUID REFERENCES public.contractor_companies(id) ON DELETE RESTRICT,
  application_id UUID REFERENCES public.project_join_applications(id) ON DELETE SET NULL,
  membership_type TEXT NOT NULL DEFAULT 'internal'
                  CHECK (membership_type IN ('internal', 'external', 'temporary')),
  work_type     TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'left', 'revoked')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at       TIMESTAMPTZ,
  left_reason   TEXT,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (project_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_site_project_members_employee
  ON public.site_project_members(employee_id, status);

CREATE OR REPLACE FUNCTION public.site_project_member_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contractor_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.employee_id = NEW.employee_id AND m.status = 'active'
      AND m.contractor_id IS NOT NULL AND m.contractor_id IS DISTINCT FROM NEW.contractor_id
  ) THEN
    RAISE EXCEPTION '同一外协人员不能同时归属多个外协单位；变更单位请先结束原有归属';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_site_project_member_guard ON public.site_project_members;
CREATE TRIGGER trg_site_project_member_guard
  BEFORE INSERT OR UPDATE ON public.site_project_members
  FOR EACH ROW EXECUTE FUNCTION public.site_project_member_guard();

CREATE TABLE IF NOT EXISTS public.training_admission_packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES public.site_projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  version_no      INT NOT NULL DEFAULT 1 CHECK (version_no > 0),
  source_document_path TEXT,
  review_note     TEXT,
  validity_years  NUMERIC(4,1) NOT NULL DEFAULT 1 CHECK (validity_years > 0),
  pause_retrain_days INT NOT NULL DEFAULT 180 CHECK (pause_retrain_days >= 0),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_review', 'published', 'archived')),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.training_admission_packages
  ADD COLUMN IF NOT EXISTS version_no INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_document_path TEXT,
  ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE TABLE IF NOT EXISTS public.training_admission_package_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id  UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE CASCADE,
  plan_id     UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE RESTRICT,
  level       TEXT NOT NULL CHECK (level IN ('company', 'entity', 'project', 'special')),
  required    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT NOT NULL DEFAULT 0,
  UNIQUE (package_id, plan_id)
);

CREATE TABLE IF NOT EXISTS public.training_admissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  member_id         UUID NOT NULL REFERENCES public.site_project_members(id) ON DELETE RESTRICT,
  employee_id       UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  package_id        UUID NOT NULL REFERENCES public.training_admission_packages(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'learning', 'exam_pending', 'exam_failed', 'pending_sign', 'pending_site_confirm', 'eligible', 'blocked', 'expired', 'project_closed')),
  exam_required     BOOLEAN NOT NULL DEFAULT TRUE,
  exam_passed      BOOLEAN NOT NULL DEFAULT FALSE,
  exam_score       NUMERIC(5,1),
  exam_attempts    INT NOT NULL DEFAULT 0,
  final_signed_at  TIMESTAMPTZ,
  site_confirmed_at TIMESTAMPTZ,
  eligible_from     TIMESTAMPTZ,
  valid_until       DATE,
  blocked_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_training_admissions_status
  ON public.training_admissions(project_id, status, valid_until);

CREATE TABLE IF NOT EXISTS public.training_admission_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id  UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE CASCADE,
  plan_id       UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE RESTRICT,
  level         TEXT NOT NULL CHECK (level IN ('company', 'entity', 'project', 'special')),
  assignment_id UUID REFERENCES public.training_assignments(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'learning', 'completed', 'expired')),
  progress      NUMERIC(5,1) NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  effective_hours NUMERIC(7,1) NOT NULL DEFAULT 0,
  signed_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  UNIQUE (admission_id, plan_id)
);

CREATE TABLE IF NOT EXISTS public.training_admission_signatures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id  UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  task_id       UUID REFERENCES public.training_admission_tasks(id) ON DELETE RESTRICT,
  signer_role   TEXT NOT NULL CHECK (signer_role IN ('employee', 'company_safety_head', 'entity_head', 'project_manager', 'safety_officer')),
  signer_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  storage_path  TEXT NOT NULL,
  signed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  record_hash   TEXT NOT NULL,
  device_info   TEXT,
  UNIQUE (admission_id, task_id, signer_role)
);

CREATE TABLE IF NOT EXISTS public.training_site_confirmations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id   UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  confirmer_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  photo_path     TEXT NOT NULL,
  latitude       NUMERIC(10,7),
  longitude      NUMERIC(10,7),
  location_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT,
  record_hash    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.training_temporary_access (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id  UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  employee_id   UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  project_id    UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  reason        TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  approved_by   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  revoked_at    TIMESTAMPTZ,
  CHECK (expires_at <= starts_at + INTERVAL '24 hours')
);

CREATE TABLE IF NOT EXISTS public.training_eligibility_certificates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id  UUID NOT NULL REFERENCES public.training_admissions(id) ON DELETE RESTRICT,
  certificate_no TEXT NOT NULL UNIQUE,
  verification_token_hash TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'valid'
                CHECK (status IN ('valid', 'expired', 'revoked', 'project_closed')),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until   DATE NOT NULL,
  pdf_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.project_reports
  ADD COLUMN IF NOT EXISTS site_project_id UUID REFERENCES public.site_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_project_reports_site_project
  ON public.project_reports(site_project_id, reporting_year, reporting_month);

ALTER TABLE public.training_admissions
  ADD COLUMN IF NOT EXISTS exam_required BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS exam_passed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS exam_score NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS exam_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS site_confirmed_at TIMESTAMPTZ;
ALTER TABLE public.training_admission_tasks
  ADD COLUMN IF NOT EXISTS assignment_id UUID REFERENCES public.training_assignments(id) ON DELETE SET NULL;
ALTER TABLE public.site_project_members ADD COLUMN IF NOT EXISTS work_type TEXT;

-- 幂等的更新时间维护。依赖 schema.sql 中的 update_updated_at()。
DROP TRIGGER IF EXISTS trg_site_projects_updated ON public.site_projects;
CREATE TRIGGER trg_site_projects_updated BEFORE UPDATE ON public.site_projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_contractor_companies_updated ON public.contractor_companies;
CREATE TRIGGER trg_contractor_companies_updated BEFORE UPDATE ON public.contractor_companies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_contractor_contracts_updated ON public.contractor_contracts;
CREATE TRIGGER trg_contractor_contracts_updated BEFORE UPDATE ON public.contractor_contracts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_join_applications_updated ON public.project_join_applications;
CREATE TRIGGER trg_join_applications_updated BEFORE UPDATE ON public.project_join_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_training_admission_packages_updated ON public.training_admission_packages;
CREATE TRIGGER trg_training_admission_packages_updated BEFORE UPDATE ON public.training_admission_packages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
DROP TRIGGER IF EXISTS trg_training_admissions_updated ON public.training_admissions;
CREATE TRIGGER trg_training_admissions_updated BEFORE UPDATE ON public.training_admissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 当前项目报送中的同名/同地点项目只作为候选，不自动合并正式项目。
CREATE OR REPLACE VIEW public.site_project_report_candidates AS
SELECT
  pr.department_id,
  pr.project_name,
  pr.construction_location,
  MAX(pr.reporting_year * 100 + pr.reporting_month) AS latest_reporting_month,
  MAX(pr.project_status) FILTER (WHERE pr.project_status IS NOT NULL) AS latest_status,
  COUNT(*)::INT AS report_count
FROM public.project_reports pr
WHERE pr.site_project_id IS NULL
GROUP BY pr.department_id, pr.project_name, pr.construction_location;

-- 项目权限辅助函数，内部使用 SECURITY DEFINER 避免 RLS 互相递归。
CREATE OR REPLACE FUNCTION public.site_project_can_read(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR EXISTS (
        SELECT 1 FROM public.site_projects p
        WHERE p.id = p_project_id
          AND public.training_can_read(p.lead_entity_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_entities pe
        WHERE pe.project_id = p_project_id
          AND public.training_can_read(pe.entity_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_roles r
        WHERE r.project_id = p_project_id AND r.user_id = auth.uid() AND r.active
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_members m
        JOIN public.training_employees e ON e.id = m.employee_id
        WHERE m.project_id = p_project_id AND m.status = 'active' AND e.user_id = auth.uid()
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.site_project_can_manage(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR EXISTS (
        SELECT 1 FROM public.site_projects p
        WHERE p.id = p_project_id AND public.training_can_write(p.lead_entity_id)
      )
      OR EXISTS (
        SELECT 1 FROM public.site_project_roles r
        WHERE r.project_id = p_project_id AND r.user_id = auth.uid()
          AND r.active AND r.role IN ('project_manager', 'safety_officer')
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.site_project_can_admin(p_project_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_is_company_admin()
      OR EXISTS (
        SELECT 1 FROM public.site_projects p
        WHERE p.id = p_project_id AND public.training_can_write(p.lead_entity_id)
      );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 项目状态、主责经营实体等变更必须留痕。
CREATE OR REPLACE FUNCTION public.site_project_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
  v_entity_id UUID;
  v_detail JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project_id := OLD.id;
    v_entity_id := OLD.id;
    v_detail := jsonb_build_object('old', to_jsonb(OLD));
  ELSE
    v_project_id := NEW.id;
    v_entity_id := NEW.id;
    v_detail := jsonb_build_object(
      'new', to_jsonb(NEW),
      'old', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
    );
  END IF;
  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (v_project_id, auth.uid(), lower(TG_OP), TG_TABLE_NAME, v_entity_id, v_detail);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_site_projects_audit ON public.site_projects;
CREATE TRIGGER trg_site_projects_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.site_projects
  FOR EACH ROW EXECUTE FUNCTION public.site_project_audit_trigger();

CREATE OR REPLACE FUNCTION public.training_temporary_access_guard()
RETURNS TRIGGER AS $$
DECLARE v_position TEXT;
BEGIN
  SELECT position INTO v_position FROM public.training_employees WHERE id = NEW.employee_id;
  IF COALESCE(v_position, '') ~ '(爆破|钻探|电工|焊工)' THEN
    RAISE EXCEPTION '爆破、钻探、电工、焊工等高风险岗位禁止临时通行';
  END IF;
  IF NEW.expires_at > NEW.starts_at + INTERVAL '24 hours' THEN
    RAISE EXCEPTION '临时通行最长不得超过 24 小时';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_training_temporary_access_guard ON public.training_temporary_access;
CREATE TRIGGER trg_training_temporary_access_guard
  BEFORE INSERT OR UPDATE ON public.training_temporary_access
  FOR EACH ROW EXECUTE FUNCTION public.training_temporary_access_guard();

ALTER TABLE public.site_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_join_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_admission_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_admission_package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_admission_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_admission_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_site_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_temporary_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_eligibility_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_project_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_projects_read ON public.site_projects;
CREATE POLICY site_projects_read ON public.site_projects
  FOR SELECT TO authenticated USING (public.site_project_can_read(id));
-- 项目创建/状态变更统一走下方 SECURITY DEFINER RPC，不开放 REST 直写。
DROP POLICY IF EXISTS site_projects_write ON public.site_projects;
DROP POLICY IF EXISTS site_projects_update ON public.site_projects;
DROP POLICY IF EXISTS site_projects_delete ON public.site_projects;

DROP POLICY IF EXISTS site_project_entities_read ON public.site_project_entities;
CREATE POLICY site_project_entities_read ON public.site_project_entities
  FOR SELECT TO authenticated USING (public.site_project_can_read(project_id));
DROP POLICY IF EXISTS site_project_entities_write ON public.site_project_entities;
-- 参与经营实体通过 site_project_set_entities() 统一维护。

DROP POLICY IF EXISTS site_project_roles_read ON public.site_project_roles;
CREATE POLICY site_project_roles_read ON public.site_project_roles
  FOR SELECT TO authenticated USING (public.site_project_can_read(project_id));
DROP POLICY IF EXISTS site_project_roles_write ON public.site_project_roles;
-- 项目经理/安全员任命后续通过受控 RPC 维护，避免普通管理员越权加角色。

DROP POLICY IF EXISTS site_project_invites_read ON public.site_project_invites;
CREATE POLICY site_project_invites_read ON public.site_project_invites
  FOR SELECT TO authenticated USING (public.site_project_can_manage(project_id));
DROP POLICY IF EXISTS site_project_invites_write ON public.site_project_invites;
-- 邀请码只能通过 site_project_refresh_invite() 生成或撤销。

DROP POLICY IF EXISTS contractor_companies_read ON public.contractor_companies;
CREATE POLICY contractor_companies_read ON public.contractor_companies
  FOR SELECT TO authenticated USING (public.training_is_company_admin() OR EXISTS (
    SELECT 1 FROM public.contractor_contracts c
    WHERE c.contractor_id = contractor_companies.id AND public.site_project_can_read(c.project_id)
  ));
DROP POLICY IF EXISTS contractor_companies_write ON public.contractor_companies;
CREATE POLICY contractor_companies_write ON public.contractor_companies
  FOR ALL TO authenticated USING (public.training_is_company_admin() OR public.is_entity_manager())
  WITH CHECK (public.training_is_company_admin() OR public.is_entity_manager());

DROP POLICY IF EXISTS contractor_contracts_all ON public.contractor_contracts;
CREATE POLICY contractor_contracts_all ON public.contractor_contracts
  FOR ALL TO authenticated USING (public.site_project_can_manage(project_id))
  WITH CHECK (public.site_project_can_manage(project_id));

DROP POLICY IF EXISTS contractor_documents_read ON public.contractor_documents;
CREATE POLICY contractor_documents_read ON public.contractor_documents
  FOR SELECT TO authenticated USING (
    public.training_is_company_admin()
    OR (project_id IS NOT NULL AND public.site_project_can_read(project_id))
  );
DROP POLICY IF EXISTS contractor_documents_write ON public.contractor_documents;
CREATE POLICY contractor_documents_write ON public.contractor_documents
  FOR ALL TO authenticated USING (
    public.training_is_company_admin()
    OR (project_id IS NOT NULL AND public.site_project_can_manage(project_id))
  ) WITH CHECK (
    public.training_is_company_admin()
    OR (project_id IS NOT NULL AND public.site_project_can_manage(project_id))
  );

DROP POLICY IF EXISTS project_join_applications_all ON public.project_join_applications;
CREATE POLICY project_join_applications_read ON public.project_join_applications
  FOR SELECT TO authenticated USING (
    public.site_project_can_manage(project_id) OR applicant_user_id = auth.uid()
  );
CREATE POLICY project_join_applications_insert ON public.project_join_applications
  FOR INSERT TO authenticated WITH CHECK (
    public.site_project_can_manage(project_id)
    OR (applicant_user_id = auth.uid() AND status = 'pending_project_review')
  );
CREATE POLICY project_join_applications_update ON public.project_join_applications
  FOR UPDATE TO authenticated USING (public.site_project_can_manage(project_id))
  WITH CHECK (public.site_project_can_manage(project_id));
CREATE POLICY project_join_applications_delete ON public.project_join_applications
  FOR DELETE TO authenticated USING (public.site_project_can_manage(project_id));

DROP POLICY IF EXISTS site_project_members_all ON public.site_project_members;
DROP POLICY IF EXISTS site_project_members_read ON public.site_project_members;
CREATE POLICY site_project_members_read ON public.site_project_members
  FOR SELECT TO authenticated USING (public.site_project_can_read(project_id));
DROP POLICY IF EXISTS site_project_members_write ON public.site_project_members;
CREATE POLICY site_project_members_write ON public.site_project_members
  FOR INSERT TO authenticated WITH CHECK (public.site_project_can_manage(project_id));
DROP POLICY IF EXISTS site_project_members_update ON public.site_project_members;
CREATE POLICY site_project_members_update ON public.site_project_members
  FOR UPDATE TO authenticated USING (public.site_project_can_manage(project_id))
  WITH CHECK (public.site_project_can_manage(project_id));
DROP POLICY IF EXISTS site_project_members_delete ON public.site_project_members;
CREATE POLICY site_project_members_delete ON public.site_project_members
  FOR DELETE TO authenticated USING (public.site_project_can_manage(project_id));

DROP POLICY IF EXISTS training_admission_read ON public.training_admissions;
CREATE POLICY training_admission_read ON public.training_admissions
  FOR SELECT TO authenticated USING (
    public.site_project_can_read(project_id)
    OR employee_id = public.training_my_employee_id()
  );
DROP POLICY IF EXISTS training_admission_manage ON public.training_admissions;

DROP POLICY IF EXISTS training_admission_packages_read ON public.training_admission_packages;
CREATE POLICY training_admission_packages_read ON public.training_admission_packages
  FOR SELECT TO authenticated USING (
    (project_id IS NULL AND public.training_is_company_admin())
    OR (project_id IS NOT NULL AND public.site_project_can_read(project_id))
  );
DROP POLICY IF EXISTS training_admission_packages_manage ON public.training_admission_packages;
CREATE POLICY training_admission_packages_manage ON public.training_admission_packages
  FOR ALL TO authenticated USING (
    (project_id IS NULL AND public.training_is_company_admin())
    OR (project_id IS NOT NULL AND public.site_project_can_admin(project_id))
  ) WITH CHECK (
    (project_id IS NULL AND public.training_is_company_admin())
    OR (project_id IS NOT NULL AND public.site_project_can_admin(project_id))
  );

DROP POLICY IF EXISTS training_admission_package_items_read ON public.training_admission_package_items;
CREATE POLICY training_admission_package_items_read ON public.training_admission_package_items
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admission_packages p
    WHERE p.id = package_id AND ((p.project_id IS NULL AND public.training_is_company_admin())
      OR (p.project_id IS NOT NULL AND public.site_project_can_read(p.project_id)))
  ));
DROP POLICY IF EXISTS training_admission_package_items_manage ON public.training_admission_package_items;
CREATE POLICY training_admission_package_items_manage ON public.training_admission_package_items
  FOR ALL TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admission_packages p
    WHERE p.id = package_id AND ((p.project_id IS NULL AND public.training_is_company_admin())
      OR (p.project_id IS NOT NULL AND public.site_project_can_admin(p.project_id)))
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM public.training_admission_packages p
    WHERE p.id = package_id AND ((p.project_id IS NULL AND public.training_is_company_admin())
      OR (p.project_id IS NOT NULL AND public.site_project_can_admin(p.project_id)))
  ));

DROP POLICY IF EXISTS training_admission_tasks_read ON public.training_admission_tasks;
CREATE POLICY training_admission_tasks_read ON public.training_admission_tasks
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admissions a
    WHERE a.id = admission_id AND (public.site_project_can_read(a.project_id)
      OR a.employee_id = public.training_my_employee_id())
  ));
DROP POLICY IF EXISTS training_admission_tasks_manage ON public.training_admission_tasks;

DROP POLICY IF EXISTS training_admission_signatures_read ON public.training_admission_signatures;
CREATE POLICY training_admission_signatures_read ON public.training_admission_signatures
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admissions a
    WHERE a.id = admission_id AND (public.site_project_can_read(a.project_id)
      OR a.employee_id = public.training_my_employee_id())
  ));
DROP POLICY IF EXISTS training_admission_signatures_manage ON public.training_admission_signatures;
-- 签字必须经后端校验签署人身份和记录哈希，暂不开放 REST 直写。

DROP POLICY IF EXISTS training_site_confirmations_read ON public.training_site_confirmations;
CREATE POLICY training_site_confirmations_read ON public.training_site_confirmations
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admissions a
    WHERE a.id = admission_id AND public.site_project_can_read(a.project_id)
  ));
DROP POLICY IF EXISTS training_site_confirmations_manage ON public.training_site_confirmations;
-- 现场确认必须通过 training_confirm_site()，避免伪造 confirmer_id/时间。

DROP POLICY IF EXISTS training_temporary_access_read ON public.training_temporary_access;
CREATE POLICY training_temporary_access_read ON public.training_temporary_access
  FOR SELECT TO authenticated USING (public.site_project_can_read(project_id));
DROP POLICY IF EXISTS training_temporary_access_manage ON public.training_temporary_access;
-- 临时通行后续通过受控接口创建，且由 guard 拦截高风险岗位。

DROP POLICY IF EXISTS training_eligibility_certificates_read ON public.training_eligibility_certificates;
CREATE POLICY training_eligibility_certificates_read ON public.training_eligibility_certificates
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.training_admissions a
    WHERE a.id = admission_id AND (public.site_project_can_read(a.project_id)
      OR a.employee_id = public.training_my_employee_id())
  ));
DROP POLICY IF EXISTS training_eligibility_certificates_manage ON public.training_eligibility_certificates;
-- 合格凭证由资格状态机签发，暂不开放 REST 直写。

DROP POLICY IF EXISTS site_project_audit_read ON public.site_project_audit_logs;
CREATE POLICY site_project_audit_read ON public.site_project_audit_logs
  FOR SELECT TO authenticated USING (project_id IS NOT NULL AND public.site_project_can_read(project_id));

GRANT SELECT ON public.site_project_report_candidates TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_site_project_code() TO authenticated;
GRANT SELECT ON public.site_project_audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.site_projects, public.site_project_entities, public.site_project_roles,
  public.site_project_invites, public.contractor_companies, public.contractor_contracts,
  public.contractor_documents, public.project_join_applications, public.site_project_members,
  public.training_admission_packages, public.training_admission_package_items,
  public.training_admissions, public.training_admission_tasks,
  public.training_admission_signatures, public.training_site_confirmations,
  public.training_temporary_access, public.training_eligibility_certificates
  TO authenticated;

-- 创建正式项目时同时建立主责经营实体关联，避免页面分两次写入造成半成品。
DROP FUNCTION IF EXISTS public.site_project_create(TEXT, TEXT, TEXT, DATE, DATE, UUID, TEXT);
CREATE FUNCTION public.site_project_create(
  p_name TEXT,
  p_project_type TEXT,
  p_location TEXT,
  p_start_date DATE,
  p_expected_end_date DATE,
  p_lead_entity_id UUID,
  p_report_notes TEXT DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE
  v_project public.site_projects;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL THEN RAISE EXCEPTION '项目名称不能为空'; END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN
    RAISE EXCEPTION '预计完工日期不能早于开工日期';
  END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN
    RAISE EXCEPTION '您无权在该经营实体下建立项目';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN
    RAISE EXCEPTION '主责单位必须是经营实体';
  END IF;
  INSERT INTO public.site_projects(name, project_type, location, start_date, expected_end_date,
                                    lead_entity_id, report_notes, created_by)
  VALUES (btrim(p_name), NULLIF(btrim(p_project_type), ''), NULLIF(btrim(p_location), ''),
          p_start_date, p_expected_end_date, p_lead_entity_id, NULLIF(btrim(p_report_notes), ''), auth.uid())
  RETURNING * INTO v_project;
  INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
  VALUES (v_project.id, p_lead_entity_id, TRUE);
  RETURN v_project;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_create(TEXT, TEXT, TEXT, DATE, DATE, UUID, TEXT) TO authenticated;

-- 项目核心字段和状态变更统一走该接口，关闭/暂停/复工/重新开启都要写原因。
DROP FUNCTION IF EXISTS public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT);
CREATE FUNCTION public.site_project_update(
  p_project_id UUID,
  p_name TEXT,
  p_project_type TEXT,
  p_location TEXT,
  p_status TEXT,
  p_start_date DATE,
  p_expected_end_date DATE,
  p_actual_end_date DATE,
  p_lead_entity_id UUID,
  p_reason TEXT DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE
  v_old public.site_projects;
  v_new public.site_projects;
BEGIN
  SELECT * INTO v_old FROM public.site_projects WHERE id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权维护该正式项目'; END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN
    RAISE EXCEPTION '您无权把主责经营实体变更为该单位';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN
    RAISE EXCEPTION '主责单位必须是经营实体';
  END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN
    RAISE EXCEPTION '预计完工日期不能早于开工日期';
  END IF;
  IF p_status IN ('paused', 'closed', 'pending_close') AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION '暂停、待关闭或关闭必须填写原因';
  END IF;
  IF v_old.status = 'closed' AND p_status <> 'closed'
     AND NULLIF(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION '项目重新开启必须填写原因';
  END IF;
  UPDATE public.site_projects
  SET name = btrim(p_name), project_type = NULLIF(btrim(p_project_type), ''),
      location = NULLIF(btrim(p_location), ''), status = p_status,
      start_date = p_start_date, expected_end_date = p_expected_end_date,
      actual_end_date = p_actual_end_date, lead_entity_id = p_lead_entity_id,
      pause_started_at = CASE WHEN p_status = 'paused' THEN COALESCE(v_old.pause_started_at, NOW()) ELSE NULL END,
      pause_reason = CASE WHEN p_status = 'paused' THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
      closed_at = CASE WHEN p_status = 'closed' THEN COALESCE(v_old.closed_at, NOW()) ELSE NULL END,
      closed_by = CASE WHEN p_status = 'closed' THEN auth.uid() ELSE NULL END,
      close_reason = CASE WHEN p_status IN ('closed', 'pending_close') THEN NULLIF(btrim(p_reason), '') ELSE NULL END,
      report_notes = COALESCE(NULLIF(btrim(p_reason), ''), v_old.report_notes)
  WHERE id = p_project_id
  RETURNING * INTO v_new;
  IF v_new.lead_entity_id <> v_old.lead_entity_id THEN
    UPDATE public.site_project_entities SET is_lead = FALSE WHERE project_id = p_project_id;
    INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
    VALUES (p_project_id, v_new.lead_entity_id, TRUE)
    ON CONFLICT (project_id, entity_id) DO UPDATE SET is_lead = TRUE;
  END IF;
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_update(UUID, TEXT, TEXT, TEXT, TEXT, DATE, DATE, DATE, UUID, TEXT) TO authenticated;

-- 将同一经营实体下同名同地点的历史月报批量挂到正式项目，绝不自动执行。
DROP FUNCTION IF EXISTS public.site_project_link_reports(UUID, UUID, TEXT, TEXT);
CREATE FUNCTION public.site_project_link_reports(
  p_project_id UUID, p_department_id UUID, p_project_name TEXT, p_location TEXT
) RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权关联该项目月报'; END IF;
  UPDATE public.project_reports
  SET site_project_id = p_project_id
  WHERE site_project_id IS NULL
    AND department_id = p_department_id
    AND project_name = p_project_name
    AND construction_location = p_location;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_link_reports(UUID, UUID, TEXT, TEXT) TO authenticated;

-- 维护多经营实体参与关系；主责经营实体必须同时存在且只能有一个。
DROP FUNCTION IF EXISTS public.site_project_set_entities(UUID, UUID[]);
CREATE FUNCTION public.site_project_set_entities(p_project_id UUID, p_entity_ids UUID[])
RETURNS VOID AS $$
DECLARE
  v_project public.site_projects;
  v_entity UUID;
BEGIN
  SELECT * INTO v_project FROM public.site_projects WHERE id = p_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION '正式项目不存在'; END IF;
  IF NOT public.site_project_can_admin(p_project_id) THEN RAISE EXCEPTION '您无权维护参与经营实体'; END IF;
  IF p_entity_ids IS NULL OR cardinality(p_entity_ids) = 0
     OR NOT (v_project.lead_entity_id = ANY(p_entity_ids)) THEN
    RAISE EXCEPTION '参与经营实体必须包含主责经营实体';
  END IF;
  FOREACH v_entity IN ARRAY p_entity_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = v_entity AND dept_type = 'entity') THEN
      RAISE EXCEPTION '参与单位必须全部是经营实体';
    END IF;
  END LOOP;
  DELETE FROM public.site_project_entities WHERE project_id = p_project_id;
  INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
  SELECT p_project_id, x, x = v_project.lead_entity_id
  FROM (SELECT DISTINCT unnest(p_entity_ids) AS x) AS unique_entities
  ON CONFLICT (project_id, entity_id) DO UPDATE SET is_lead = EXCLUDED.is_lead;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_set_entities(UUID, UUID[]) TO authenticated;

-- 项目邀请码：默认 7 天；刷新时旧邀请码立即失效，只返回本次明文一次。
DROP FUNCTION IF EXISTS public.site_project_refresh_invite(UUID);
CREATE FUNCTION public.site_project_refresh_invite(p_project_id UUID)
RETURNS JSONB AS $$
DECLARE v_token TEXT; v_expires TIMESTAMPTZ;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权刷新项目邀请码'; END IF;
  IF EXISTS (SELECT 1 FROM public.site_projects WHERE id = p_project_id AND status IN ('paused', 'closed', 'pending_close')) THEN
    RAISE EXCEPTION '项目暂停或关闭期间不能生成邀请码';
  END IF;
  UPDATE public.site_project_invites SET revoked_at = NOW()
  WHERE project_id = p_project_id AND revoked_at IS NULL;
  v_token := encode(gen_random_bytes(18), 'hex');
  v_expires := NOW() + INTERVAL '7 days';
  INSERT INTO public.site_project_invites(project_id, token_hash, expires_at, created_by)
  VALUES (p_project_id, encode(digest(v_token, 'sha256'), 'hex'), v_expires, auth.uid());
  RETURN jsonb_build_object('token', v_token, 'expires_at', v_expires);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_refresh_invite(UUID) TO authenticated;

-- 外协人员自助申请只接受邀请码；未建档单位先建为 pending，项目部审核后使用。
DROP FUNCTION IF EXISTS public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.site_project_apply(
  p_token TEXT, p_name TEXT, p_phone TEXT, p_position TEXT,
  p_contractor_name TEXT, p_contractor_code TEXT, p_photo_path TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_invite public.site_project_invites;
  v_project public.site_projects;
  v_company UUID;
  v_application UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  SELECT i.* INTO v_invite FROM public.site_project_invites i
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex')
    AND i.revoked_at IS NULL AND i.expires_at > NOW();
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效或已过期'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_invite.project_id;
  IF v_project.status <> 'active' THEN RAISE EXCEPTION '项目当前未开放外协人员申请'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL OR NULLIF(btrim(p_phone), '') IS NULL THEN
    RAISE EXCEPTION '姓名和手机号不能为空';
  END IF;
  IF NULLIF(btrim(p_contractor_name), '') IS NOT NULL THEN
    SELECT id INTO v_company FROM public.contractor_companies
    WHERE name = btrim(p_contractor_name)
      AND COALESCE(unified_code, '') = COALESCE(NULLIF(btrim(p_contractor_code), ''), '');
    IF v_company IS NULL THEN
      INSERT INTO public.contractor_companies(name, unified_code, status, created_by)
      VALUES (btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), ''), 'pending', auth.uid())
      RETURNING id INTO v_company;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.project_join_applications
             WHERE project_id = v_project.id AND applicant_user_id = auth.uid()
               AND status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN
    RAISE EXCEPTION '您已经申请过加入该项目';
  END IF;
  INSERT INTO public.project_join_applications(project_id, applicant_user_id, name, phone, position,
                                                photo_path, contractor_id, contractor_name_input, contractor_code_input)
  VALUES (v_project.id, auth.uid(), btrim(p_name), btrim(p_phone), NULLIF(btrim(p_position), ''),
          p_photo_path, v_company, NULLIF(btrim(p_contractor_name), ''), NULLIF(btrim(p_contractor_code), ''))
  RETURNING id INTO v_application;
  RETURN v_application;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- 为项目成员建立一套入场培训实例，并按培训包自动生成三级/专项任务。
DROP FUNCTION IF EXISTS public.training_start_admission(UUID, UUID, UUID);
CREATE FUNCTION public.training_start_admission(p_project_id UUID, p_employee_id UUID, p_package_id UUID)
RETURNS UUID AS $$
DECLARE v_admission UUID; v_member UUID; v_package public.training_admission_packages;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权发起该项目入场培训'; END IF;
  SELECT id INTO v_member FROM public.site_project_members
  WHERE project_id = p_project_id AND employee_id = p_employee_id AND status = 'active';
  IF v_member IS NULL THEN RAISE EXCEPTION '该人员不是项目在场成员'; END IF;
  SELECT * INTO v_package FROM public.training_admission_packages
  WHERE id = p_package_id AND status = 'published'
    AND (project_id IS NULL OR project_id = p_project_id);
  IF NOT FOUND THEN RAISE EXCEPTION '培训包不存在、未发布或不适用于该项目'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.training_admission_package_items i
    JOIN public.training_plans p ON p.id = i.plan_id
    WHERE i.package_id = p_package_id
      AND COALESCE(p.publish_status, '') <> 'published'
  ) THEN
    RAISE EXCEPTION '培训包包含尚未发布的培训计划，请先发布计划后再发起准入';
  END IF;
  INSERT INTO public.training_admissions(project_id, member_id, employee_id, package_id)
  VALUES (p_project_id, v_member, p_employee_id, p_package_id)
  ON CONFLICT (project_id, employee_id) DO UPDATE SET package_id = EXCLUDED.package_id, updated_at = NOW()
  RETURNING id INTO v_admission;
  -- 准入任务必须和员工端 assignments 对上，否则员工看不到对应课件。
  INSERT INTO public.training_assignments(plan_id, employee_id, user_id, department_id)
  SELECT i.plan_id, e.id, pr.id, e.department_id
  FROM public.training_admission_package_items i
  CROSS JOIN public.training_employees e
  LEFT JOIN public.profiles pr ON pr.employee_id = e.id
  WHERE i.package_id = p_package_id AND i.required AND e.id = p_employee_id
  ON CONFLICT (plan_id, employee_id) DO UPDATE
    SET user_id = EXCLUDED.user_id, department_id = EXCLUDED.department_id;
  INSERT INTO public.training_admission_tasks(admission_id, plan_id, level, assignment_id)
  SELECT v_admission, i.plan_id, i.level, a.id
  FROM public.training_admission_package_items i
  JOIN public.training_assignments a
    ON a.plan_id = i.plan_id AND a.employee_id = p_employee_id
  WHERE i.package_id = p_package_id AND i.required
  ON CONFLICT (admission_id, plan_id) DO UPDATE
    SET assignment_id = EXCLUDED.assignment_id;
  RETURN v_admission;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_start_admission(UUID, UUID, UUID) TO authenticated;

-- 现场确认必须附照片；定位为推荐信息，弱网时可待联网后补传。
DROP FUNCTION IF EXISTS public.training_confirm_site(UUID, TEXT, NUMERIC, NUMERIC, TEXT, TEXT);
CREATE FUNCTION public.training_confirm_site(
  p_admission_id UUID, p_photo_path TEXT, p_latitude NUMERIC DEFAULT NULL,
  p_longitude NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL, p_record_hash TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE v_project UUID; v_employee UUID;
BEGIN
  SELECT project_id, employee_id INTO v_project, v_employee
  FROM public.training_admissions WHERE id = p_admission_id;
  IF v_project IS NULL THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_project) THEN RAISE EXCEPTION '您无权进行现场确认'; END IF;
  IF NULLIF(btrim(p_photo_path), '') IS NULL THEN RAISE EXCEPTION '现场确认必须上传照片'; END IF;
  INSERT INTO public.training_site_confirmations(admission_id, confirmer_id, photo_path, latitude, longitude,
                                                 location_enabled, note, record_hash)
  VALUES (p_admission_id, auth.uid(), p_photo_path, p_latitude, p_longitude,
          p_latitude IS NOT NULL AND p_longitude IS NOT NULL, p_note, COALESCE(p_record_hash, md5(p_photo_path || NOW()::TEXT)));
  UPDATE public.training_admissions
  SET site_confirmed_at = NOW(), status = CASE WHEN status = 'eligible' THEN status ELSE 'pending_site_confirm' END,
      updated_at = NOW()
  WHERE id = p_admission_id;
  PERFORM public.training_recompute_admission(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_confirm_site(UUID, TEXT, NUMERIC, NUMERIC, TEXT, TEXT) TO authenticated;

-- 统一资格状态机：培训完成、考试通过、最终签字、现场确认缺一不可。
-- 项目暂停/关闭、人员离场、高风险证照缺失或过期时优先判为禁止。
DROP FUNCTION IF EXISTS public.training_recompute_admission(UUID);
CREATE FUNCTION public.training_recompute_admission(p_admission_id UUID)
RETURNS public.training_admissions AS $$
DECLARE
  v_a public.training_admissions;
  v_p public.site_projects;
  v_e public.training_employees;
  v_pkg public.training_admission_packages;
  v_total INT; v_done INT; v_has_cert BOOLEAN; v_final_signed BOOLEAN;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT (public.site_project_can_manage(v_a.project_id)
          OR v_a.employee_id = public.training_my_employee_id()) THEN
    RAISE EXCEPTION '您无权重新计算该人员的准入资格';
  END IF;
  SELECT * INTO v_p FROM public.site_projects WHERE id = v_a.project_id;
  SELECT * INTO v_e FROM public.training_employees WHERE id = v_a.employee_id;
  SELECT * INTO v_pkg FROM public.training_admission_packages WHERE id = v_a.package_id;
  SELECT COUNT(*)::INT, COUNT(*) FILTER (WHERE status = 'completed')::INT
    INTO v_total, v_done FROM public.training_admission_tasks WHERE admission_id = p_admission_id;
  SELECT EXISTS (
    SELECT 1 FROM public.contractor_documents d
    WHERE d.project_id = v_a.project_id AND d.employee_id = v_a.employee_id
      AND d.document_type = 'special_certificate' AND d.review_status = 'approved'
      AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
  ) INTO v_has_cert;
  SELECT EXISTS (
    SELECT 1 FROM public.training_admission_signatures s
    WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee'
  ) INTO v_final_signed;

  UPDATE public.training_admissions
  SET status = CASE
      WHEN v_p.status = 'closed' THEN 'project_closed'
      WHEN v_p.status IN ('paused', 'pending_close') OR v_a.member_id IS NULL THEN 'blocked'
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN 'blocked'
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN 'blocked'
      WHEN v_total = 0 OR v_done < v_total THEN CASE WHEN v_done > 0 THEN 'learning' ELSE 'pending' END
      WHEN v_a.exam_required AND NOT v_a.exam_passed THEN 'exam_pending'
      WHEN NOT v_final_signed THEN 'pending_sign'
      WHEN v_a.site_confirmed_at IS NULL THEN 'pending_site_confirm'
      ELSE 'eligible'
    END,
    blocked_reason = CASE
      WHEN v_p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
      WHEN v_p.status = 'closed' THEN '项目已关闭'
      WHEN EXISTS (SELECT 1 FROM public.site_project_members m WHERE m.id = v_a.member_id AND m.status <> 'active') THEN '人员已离开项目'
      WHEN COALESCE(v_e.position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT v_has_cert THEN '高风险岗位尚未审核通过特种作业证'
      ELSE NULL
    END,
    valid_until = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed)
                        AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL AND v_pkg.id IS NOT NULL
                   THEN (CURRENT_DATE + (v_pkg.validity_years::TEXT || ' years')::INTERVAL)::DATE
                   ELSE valid_until END,
    eligible_from = CASE WHEN v_total > 0 AND v_done = v_total AND (NOT v_a.exam_required OR v_a.exam_passed)
                              AND v_final_signed AND v_a.site_confirmed_at IS NOT NULL THEN COALESCE(eligible_from, NOW()) ELSE eligible_from END,
    updated_at = NOW()
  WHERE id = p_admission_id
  RETURNING * INTO v_a;
  RETURN v_a;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_recompute_admission(UUID) TO authenticated;

-- 手机手写签字统一入口：员工可签各级及最终记录，管理人员按项目角色签署。
DROP FUNCTION IF EXISTS public.training_admission_sign(UUID, UUID, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.training_admission_sign(
  p_admission_id UUID, p_task_id UUID, p_signer_role TEXT,
  p_storage_path TEXT, p_record_hash TEXT, p_device_info TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE v_a public.training_admissions; v_project UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NULLIF(btrim(p_storage_path), '') IS NULL OR NULLIF(btrim(p_record_hash), '') IS NULL THEN
    RAISE EXCEPTION '签字图片和记录哈希不能为空';
  END IF;
  v_project := v_a.project_id;
  IF p_signer_role = 'employee' THEN
    IF v_a.employee_id <> public.training_my_employee_id() THEN RAISE EXCEPTION '只能由本人签署员工记录'; END IF;
  ELSIF p_signer_role = 'company_safety_head' THEN
    IF NOT public.training_is_company_admin() THEN RAISE EXCEPTION '只有公司级管理员可以签署公司级记录'; END IF;
  ELSIF p_signer_role = 'entity_head' THEN
    IF NOT public.site_project_can_admin(v_project) THEN RAISE EXCEPTION '只有主责经营实体管理员可以签署'; END IF;
  ELSIF p_signer_role IN ('project_manager', 'safety_officer') THEN
    IF NOT EXISTS (SELECT 1 FROM public.site_project_roles r
                   WHERE r.project_id = v_project AND r.user_id = auth.uid()
                     AND r.active AND r.role = p_signer_role) THEN
      RAISE EXCEPTION '当前账号不是该项目的指定签署人';
    END IF;
  ELSE
    RAISE EXCEPTION '不支持的签署角色';
  END IF;
  IF p_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.training_admission_tasks t
    WHERE t.id = p_task_id AND t.admission_id = p_admission_id
  ) THEN RAISE EXCEPTION '签署的培训层级不属于该入场记录'; END IF;
  IF p_task_id IS NULL AND p_signer_role = 'employee' AND EXISTS (
    SELECT 1 FROM public.training_admission_signatures s
    WHERE s.admission_id = p_admission_id AND s.task_id IS NULL AND s.signer_role = 'employee'
  ) THEN RAISE EXCEPTION '完整准入记录已经签署'; END IF;
  INSERT INTO public.training_admission_signatures(admission_id, task_id, signer_role, signer_user_id,
                                                    storage_path, record_hash, device_info)
  VALUES (p_admission_id, p_task_id, p_signer_role, auth.uid(), p_storage_path, p_record_hash, p_device_info)
  ON CONFLICT (admission_id, task_id, signer_role) DO NOTHING;
  IF p_task_id IS NOT NULL THEN
    UPDATE public.training_admission_tasks SET signed_at = NOW() WHERE id = p_task_id;
  ELSE
    UPDATE public.training_admissions SET final_signed_at = NOW(), updated_at = NOW() WHERE id = p_admission_id;
  END IF;
  PERFORM public.training_recompute_admission(p_admission_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_sign(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

CREATE SEQUENCE IF NOT EXISTS public.training_certificate_no_seq;
DROP FUNCTION IF EXISTS public.training_issue_certificate(UUID);
CREATE FUNCTION public.training_issue_certificate(p_admission_id UUID)
RETURNS JSONB AS $$
DECLARE v_a public.training_admissions; v_no TEXT; v_token TEXT; v_id UUID;
BEGIN
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场培训记录不存在'; END IF;
  IF NOT public.site_project_can_manage(v_a.project_id) THEN RAISE EXCEPTION '您无权签发合格凭证'; END IF;
  PERFORM public.training_recompute_admission(p_admission_id);
  SELECT * INTO v_a FROM public.training_admissions WHERE id = p_admission_id;
  IF v_a.status <> 'eligible' THEN RAISE EXCEPTION '当前记录尚未满足可上岗条件'; END IF;
  SELECT certificate_no INTO v_no FROM public.training_eligibility_certificates
  WHERE admission_id = p_admission_id AND status = 'valid' AND valid_until >= CURRENT_DATE LIMIT 1;
  IF v_no IS NOT NULL THEN RETURN jsonb_build_object('certificate_no', v_no, 'valid_until', v_a.valid_until, 'existing', TRUE); END IF;
  v_no := 'DZHG-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('public.training_certificate_no_seq')::TEXT, 5, '0');
  v_token := encode(gen_random_bytes(18), 'hex');
  INSERT INTO public.training_eligibility_certificates(admission_id, certificate_no, verification_token_hash, valid_until)
  VALUES (p_admission_id, v_no, encode(digest(v_token, 'sha256'), 'hex'), v_a.valid_until)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('certificate_id', v_id, 'certificate_no', v_no, 'verification_token', v_token,
                            'valid_until', v_a.valid_until, 'label', '电子记录凭证');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_issue_certificate(UUID) TO authenticated;

-- 检查用固定三级教育台账；项目级管理员只能查询本人项目，公司/经营实体按权限查看。
DROP FUNCTION IF EXISTS public.training_admission_report(UUID);
CREATE FUNCTION public.training_admission_report(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, phone TEXT, work_position TEXT,
  contractor_name TEXT, company_done INT, entity_done INT, project_done INT, special_done INT,
  exam_score NUMERIC, admission_status TEXT, valid_until DATE, site_confirmed_at TIMESTAMPTZ
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '汇总台账查询需要公司级权限';
  END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id)
     AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '您无权查询该项目台账';
  END IF;
  RETURN QUERY
  SELECT p.project_code, p.name, e.name, e.phone, COALESCE(m.work_type, e.position),
         c.name,
         COALESCE(t.company_done, 0), COALESCE(t.entity_done, 0), COALESCE(t.project_done, 0), COALESCE(t.special_done, 0),
         a.exam_score, a.status, a.valid_until, a.site_confirmed_at
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  JOIN public.site_project_members m ON m.id = a.member_id
  LEFT JOIN public.contractor_companies c ON c.id = m.contractor_id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE level = 'company')::INT AS company_done,
           COUNT(*) FILTER (WHERE level = 'entity')::INT AS entity_done,
           COUNT(*) FILTER (WHERE level = 'project')::INT AS project_done,
           COUNT(*) FILTER (WHERE level = 'special')::INT AS special_done
    FROM public.training_admission_tasks t0
    WHERE t0.admission_id = a.id AND t0.status = 'completed'
  ) t ON TRUE
  WHERE (p_project_id IS NULL OR a.project_id = p_project_id)
  ORDER BY p.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_report(UUID) TO authenticated;

-- 固定签到表查询，和三级教育台账使用同一权限口径。
DROP FUNCTION IF EXISTS public.training_admission_signature_report(UUID);
CREATE FUNCTION public.training_admission_signature_report(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, level_name TEXT,
  signer_role TEXT, signed_at TIMESTAMPTZ, record_hash TEXT
) AS $$
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '签到表查询需要公司级权限';
  END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id)
     AND NOT public.training_is_company_admin() THEN
    RAISE EXCEPTION '您无权查询该项目签到表';
  END IF;
  RETURN QUERY
  SELECT p.project_code, p.name, e.name,
         COALESCE(t.level, '完整准入记录'), s.signer_role, s.signed_at, s.record_hash
  FROM public.training_admission_signatures s
  JOIN public.training_admissions a ON a.id = s.admission_id
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.training_admission_tasks t ON t.id = s.task_id
  WHERE (p_project_id IS NULL OR a.project_id = p_project_id)
  ORDER BY p.name, e.name, s.signed_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_admission_signature_report(UUID) TO authenticated;

-- 员工端只读当前项目资格；状态按项目和证照实时计算，确保“自动禁止”不依赖定时任务。
DROP FUNCTION IF EXISTS public.training_my_admission_status();
CREATE FUNCTION public.training_my_admission_status()
RETURNS TABLE (
  admission_id UUID,
  project_id UUID,
  project_code TEXT,
  project_name TEXT,
  project_location TEXT,
  project_status TEXT,
  work_position TEXT,
  status TEXT,
  blocked_reason TEXT,
  valid_until DATE,
  certificate_no TEXT,
  task_total INT,
  task_done INT,
  site_confirmed_at TIMESTAMPTZ
) AS $$
  SELECT a.id, p.id, p.project_code, p.name, p.location, p.status,
         e.position,
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN 'blocked'
           WHEN p.status = 'closed' THEN 'project_closed'
           WHEN (
             COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)'
             AND NOT EXISTS (
               SELECT 1 FROM public.contractor_documents d
               WHERE d.project_id = p.id AND d.employee_id = e.id
                 AND d.document_type = 'special_certificate'
                 AND d.review_status = 'approved'
                 AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
             )
           ) THEN 'blocked'
           WHEN EXISTS (
             SELECT 1 FROM public.contractor_documents d
             WHERE d.project_id = p.id AND d.employee_id = e.id
               AND d.document_type = 'special_certificate'
               AND d.review_status = 'approved'
               AND d.valid_until IS NOT NULL AND d.valid_until < CURRENT_DATE
           ) THEN 'blocked'
           WHEN a.status = 'eligible' AND (a.valid_until IS NULL OR a.valid_until >= CURRENT_DATE) THEN 'eligible'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN 'expired'
           ELSE a.status
         END,
         CASE
           WHEN p.status IN ('paused', 'pending_close') THEN '项目暂停或待关闭，须重新现场确认'
           WHEN p.status = 'closed' THEN '项目已关闭'
           WHEN (
             COALESCE(e.position, '') ~ '(爆破|钻探|电工|焊工)'
             AND NOT EXISTS (
               SELECT 1 FROM public.contractor_documents d
               WHERE d.project_id = p.id AND d.employee_id = e.id
                 AND d.document_type = 'special_certificate'
                 AND d.review_status = 'approved'
                 AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)
             )
           ) THEN '高风险岗位尚未审核通过特种作业证'
           WHEN EXISTS (
             SELECT 1 FROM public.contractor_documents d
             WHERE d.project_id = p.id AND d.employee_id = e.id
               AND d.document_type = 'special_certificate'
               AND d.review_status = 'approved'
               AND d.valid_until IS NOT NULL AND d.valid_until < CURRENT_DATE
           ) THEN '特种作业证已过期'
           WHEN a.valid_until IS NOT NULL AND a.valid_until < CURRENT_DATE THEN '培训合格凭证已过期'
           ELSE a.blocked_reason
         END,
         a.valid_until,
         c.certificate_no,
         COALESCE(t.task_total, 0), COALESCE(t.task_done, 0), a.site_confirmed_at
  FROM public.training_admissions a
  JOIN public.site_projects p ON p.id = a.project_id
  JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.training_eligibility_certificates c
    ON c.admission_id = a.id AND c.status = 'valid'
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::INT AS task_total,
           COUNT(*) FILTER (WHERE x.status = 'completed')::INT AS task_done
    FROM public.training_admission_tasks x WHERE x.admission_id = a.id
  ) t ON TRUE
  WHERE a.employee_id = public.training_my_employee_id()
  ORDER BY p.status = 'active' DESC, p.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION public.training_my_admission_status() TO authenticated;

-- 个人身份证号只允许经后端安全函数写入 id_number_ciphertext，
-- 不开放直写；在配置个人信息加密密钥前，不启用外协自助提交完整身份证号。

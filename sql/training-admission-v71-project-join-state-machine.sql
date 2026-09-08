-- D08-3：外协人员加入申请审核状态机、身份复用与数据库级幂等。
BEGIN;

ALTER TABLE public.project_join_applications
  ADD COLUMN IF NOT EXISTS review_path TEXT,
  ADD COLUMN IF NOT EXISTS source_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS target_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS application_cycle INTEGER,
  ADD COLUMN IF NOT EXISTS identity_resolved_at TIMESTAMPTZ;

UPDATE public.project_join_applications a
SET target_entity_id = p.lead_entity_id
FROM public.site_projects p
WHERE p.id = a.project_id
  AND a.target_entity_id IS NULL;

UPDATE public.project_join_applications a
SET source_entity_id = (
  SELECT p.lead_entity_id
  FROM public.site_project_members m
  JOIN public.site_projects p ON p.id = m.project_id
  WHERE m.employee_id = a.employee_id
    AND m.project_id <> a.project_id
  ORDER BY (m.status = 'active') DESC, m.joined_at DESC, m.id
  LIMIT 1
)
WHERE a.employee_id IS NOT NULL
  AND a.source_entity_id IS NULL;

UPDATE public.project_join_applications a
SET review_path = CASE
      WHEN a.employee_id IS NULL THEN 'first_project'
      WHEN EXISTS (
        SELECT 1
        FROM public.site_project_members m
        JOIN public.site_projects p ON p.id = m.project_id
        WHERE m.employee_id = a.employee_id
          AND m.project_id <> a.project_id
          AND p.lead_entity_id = a.target_entity_id
      ) THEN 'same_entity_cross_project'
      WHEN EXISTS (
        SELECT 1 FROM public.training_employees e
        WHERE e.id = a.employee_id AND e.department_id = a.target_entity_id
      ) THEN 'same_entity_cross_project'
      ELSE 'cross_entity'
    END,
    identity_resolved_at = COALESCE(a.identity_resolved_at, a.created_at)
WHERE a.review_path IS NULL;

WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY project_id, COALESCE(id_number_digest, applicant_user_id::text, id::text)
           ORDER BY created_at, id
         ) AS cycle_no
  FROM public.project_join_applications
)
UPDATE public.project_join_applications a
SET application_cycle = numbered.cycle_no
FROM numbered
WHERE numbered.id = a.id
  AND a.application_cycle IS NULL;

ALTER TABLE public.project_join_applications
  ALTER COLUMN review_path SET DEFAULT 'first_project',
  ALTER COLUMN review_path SET NOT NULL,
  ALTER COLUMN target_entity_id SET NOT NULL,
  ALTER COLUMN application_cycle SET DEFAULT 1,
  ALTER COLUMN application_cycle SET NOT NULL;

ALTER TABLE public.project_join_applications
  DROP CONSTRAINT IF EXISTS project_join_applications_review_path_check,
  DROP CONSTRAINT IF EXISTS project_join_applications_application_cycle_check;
ALTER TABLE public.project_join_applications
  ADD CONSTRAINT project_join_applications_review_path_check CHECK (
    review_path IN ('first_project', 'same_entity_cross_project', 'cross_entity')
  ),
  ADD CONSTRAINT project_join_applications_application_cycle_check CHECK (application_cycle > 0);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.project_join_applications
    WHERE id_number_digest IS NOT NULL
      AND status IN ('pending_project_review', 'pending_entity_review', 'approved')
    GROUP BY project_id, id_number_digest
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '存在同一人员同一项目的重复有效申请；v71 未修改历史数据，请先人工核验';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.project_join_applications
    WHERE applicant_user_id IS NOT NULL
      AND status IN ('pending_project_review', 'pending_entity_review', 'approved')
    GROUP BY project_id, applicant_user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '存在同一账号同一项目的重复有效申请；v71 未修改历史数据，请先人工核验';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_join_active_identity
  ON public.project_join_applications(project_id, id_number_digest)
  WHERE id_number_digest IS NOT NULL
    AND status IN ('pending_project_review', 'pending_entity_review', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_join_active_applicant
  ON public.project_join_applications(project_id, applicant_user_id)
  WHERE applicant_user_id IS NOT NULL
    AND status IN ('pending_project_review', 'pending_entity_review', 'approved');

CREATE TABLE IF NOT EXISTS public.project_join_application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES public.project_join_applications(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  project_id UUID NOT NULL REFERENCES public.site_projects(id) ON DELETE RESTRICT,
  employee_id UUID REFERENCES public.training_employees(id) ON DELETE RESTRICT,
  source_entity_id UUID REFERENCES public.departments(id) ON DELETE RESTRICT,
  target_entity_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  review_path TEXT NOT NULL CHECK (
    review_path IN ('first_project', 'same_entity_cross_project', 'cross_entity')
  ),
  application_cycle INTEGER NOT NULL CHECK (application_cycle > 0),
  from_status TEXT,
  to_status TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_source TEXT NOT NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  review_note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_project_join_application_events_history
  ON public.project_join_application_events(application_id, sequence_no);

INSERT INTO public.project_join_application_events (
  application_id, sequence_no, project_id, employee_id, source_entity_id,
  target_entity_id, review_path, application_cycle, from_status, to_status,
  event_type, event_source, actor_id, review_note, occurred_at
)
SELECT a.id, 1, a.project_id, a.employee_id, a.source_entity_id,
       a.target_entity_id, a.review_path, a.application_cycle, NULL, a.status,
       'baseline', 'v71_backfill',
       COALESCE(a.entity_reviewed_by, a.project_reviewed_by, a.applicant_user_id),
       a.review_note, a.created_at
FROM public.project_join_applications a
WHERE NOT EXISTS (
  SELECT 1 FROM public.project_join_application_events e WHERE e.application_id = a.id
);

CREATE OR REPLACE FUNCTION public.project_join_application_event_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '入场申请审核历史不可修改或删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.project_join_application_event_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_join_application_events_immutable ON public.project_join_application_events;
CREATE TRIGGER trg_project_join_application_events_immutable
  BEFORE UPDATE OR DELETE ON public.project_join_application_events
  FOR EACH ROW EXECUTE FUNCTION public.project_join_application_event_guard();

CREATE OR REPLACE FUNCTION public.project_join_application_event_snapshot()
RETURNS TRIGGER AS $$
DECLARE
  v_sequence INTEGER;
  v_source TEXT := COALESCE(NULLIF(current_setting('app.join_transition_source', true), ''), 'database_transition');
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
      NEW.employee_id, NEW.source_entity_id, NEW.target_entity_id, NEW.review_path,
      NEW.application_cycle, NEW.status, NEW.review_note,
      NEW.project_reviewed_by, NEW.project_reviewed_at,
      NEW.entity_reviewed_by, NEW.entity_reviewed_at
    ) IS NOT DISTINCT FROM ROW(
      OLD.employee_id, OLD.source_entity_id, OLD.target_entity_id, OLD.review_path,
      OLD.application_cycle, OLD.status, OLD.review_note,
      OLD.project_reviewed_by, OLD.project_reviewed_at,
      OLD.entity_reviewed_by, OLD.entity_reviewed_at
    ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_sequence
  FROM public.project_join_application_events
  WHERE application_id = NEW.id;

  INSERT INTO public.project_join_application_events (
    application_id, sequence_no, project_id, employee_id, source_entity_id,
    target_entity_id, review_path, application_cycle, from_status, to_status,
    event_type, event_source, actor_id, review_note
  ) VALUES (
    NEW.id, v_sequence, NEW.project_id, NEW.employee_id, NEW.source_entity_id,
    NEW.target_entity_id, NEW.review_path, NEW.application_cycle,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END, NEW.status,
    CASE
      WHEN TG_OP = 'INSERT' THEN 'submitted'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'status_transition'
      ELSE 'identity_resolution'
    END,
    v_source, auth.uid(), NEW.review_note
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.project_join_application_event_snapshot() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_join_application_event_snapshot ON public.project_join_applications;
CREATE TRIGGER trg_project_join_application_event_snapshot
  AFTER INSERT OR UPDATE OF employee_id, source_entity_id, target_entity_id, review_path,
    application_cycle, status, review_note, project_reviewed_by, project_reviewed_at,
    entity_reviewed_by, entity_reviewed_at
  ON public.project_join_applications
  FOR EACH ROW EXECUTE FUNCTION public.project_join_application_event_snapshot();

CREATE OR REPLACE FUNCTION public.project_join_application_delete_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '入场申请历史不得物理删除';
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION public.project_join_application_delete_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_join_application_delete_guard ON public.project_join_applications;
CREATE TRIGGER trg_project_join_application_delete_guard
  BEFORE DELETE ON public.project_join_applications
  FOR EACH ROW EXECUTE FUNCTION public.project_join_application_delete_guard();

ALTER TABLE public.project_join_application_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_join_application_events_read ON public.project_join_application_events;
CREATE POLICY project_join_application_events_read ON public.project_join_application_events
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.project_join_applications a
      WHERE a.id = application_id
        AND (
          a.applicant_user_id = auth.uid()
          OR public.site_project_can_read_management_data(a.project_id)
        )
    )
  );

REVOKE ALL ON TABLE public.project_join_application_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.project_join_application_events TO authenticated;

DROP POLICY IF EXISTS project_join_applications_insert ON public.project_join_applications;
DROP POLICY IF EXISTS project_join_applications_update ON public.project_join_applications;
DROP POLICY IF EXISTS project_join_applications_delete ON public.project_join_applications;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.project_join_applications FROM anon, authenticated;
GRANT SELECT (
  id, project_id, applicant_user_id, employee_id, name, phone, photo_path,
  contractor_id, contractor_name_input, contractor_code_input, position,
  application_type, review_path, source_entity_id, target_entity_id,
  application_cycle, status, review_note, project_reviewed_by, project_reviewed_at,
  entity_reviewed_by, entity_reviewed_at, identity_resolved_at, created_at, updated_at
) ON public.project_join_applications TO authenticated;

-- 不同项目可以保留不同外协单位归属；同一项目仍由 (project_id, employee_id) 唯一约束封堵重复关系。
CREATE OR REPLACE FUNCTION public.site_project_member_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contractor_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.site_project_members m
    WHERE m.project_id = NEW.project_id
      AND m.employee_id = NEW.employee_id
      AND m.id IS DISTINCT FROM NEW.id
      AND m.status = 'active'
      AND m.contractor_id IS NOT NULL
      AND m.contractor_id IS DISTINCT FROM NEW.contractor_id
  ) THEN
    RAISE EXCEPTION '同一项目内的外协人员不能同时归属多个外协单位';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_member_guard() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
CREATE FUNCTION public.site_project_apply(
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
     OR p_photo_path !~ '^training-admission/join-applications/' THEN
    RAISE EXCEPTION '现场照片路径不符合要求';
  END IF;
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::JSONB)) <> 'array'
     OR jsonb_array_length(COALESCE(p_attachments, '[]'::JSONB)) > 3 THEN
    RAISE EXCEPTION '申请附件格式不正确';
  END IF;
  IF COALESCE(p_position, '') ~ '(爆破|钻探|电工|焊工)'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::JSONB)) x
       WHERE x->>'type' = 'special_certificate'
     ) THEN
    RAISE EXCEPTION '高风险工种必须上传特种作业证附件';
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
  ELSIF v_company.managing_entity_id IS NOT NULL
        AND v_company.managing_entity_id IS DISTINCT FROM v_project.lead_entity_id THEN
    RAISE EXCEPTION '该外协单位不属于目标项目经营实体';
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
       OR COALESCE(v_item->>'path', '') !~ '^training-admission/join-applications/' THEN
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

CREATE OR REPLACE FUNCTION public.site_project_review_application(
  p_application_id UUID, p_action TEXT, p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_app public.project_join_applications;
  v_project public.site_projects;
  v_employee public.training_employees;
  v_member public.site_project_members;
  v_action TEXT := lower(btrim(COALESCE(p_action, '')));
  v_note TEXT := NULLIF(btrim(p_note), '');
  v_source_entity UUID;
  v_review_path TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF v_action NOT IN ('approve', 'reject') THEN RAISE EXCEPTION '审核动作仅支持 approve 或 reject'; END IF;
  IF v_action = 'reject' AND v_note IS NULL THEN RAISE EXCEPTION '驳回申请必须填写原因'; END IF;
  IF length(COALESCE(v_note, '')) > 1000 THEN RAISE EXCEPTION '审核说明不能超过 1000 个字符'; END IF;

  SELECT * INTO v_app FROM public.project_join_applications WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '入场申请不存在'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_app.project_id FOR SHARE;
  IF NOT FOUND OR v_project.status <> 'active' THEN RAISE EXCEPTION '项目未处于在建状态，不能审核入场'; END IF;

  -- 所有调用（包括重复审核）都重新读取当前权限，撤权后立即失效。
  IF v_app.review_path = 'first_project' THEN
    IF NOT public.site_project_can_manage(v_app.project_id) THEN RAISE EXCEPTION '您无权进行项目审核'; END IF;
  ELSE
    IF NOT public.is_entity_manager()
       OR public.training_my_dept_id() IS DISTINCT FROM v_app.target_entity_id THEN
      RAISE EXCEPTION '只有目标经营实体管理员可以审核该申请';
    END IF;
  END IF;

  IF v_app.status = 'approved' AND v_action = 'approve' THEN
    SELECT * INTO v_member FROM public.site_project_members
    WHERE project_id = v_app.project_id AND employee_id = v_app.employee_id;
    RETURN jsonb_build_object(
      'status', 'approved', 'review_path', v_app.review_path, 'changed', FALSE,
      'employee_id', v_app.employee_id, 'member_id', v_member.id
    );
  ELSIF v_app.status = 'rejected' AND v_action = 'reject' THEN
    RETURN jsonb_build_object('status', 'rejected', 'review_path', v_app.review_path, 'changed', FALSE);
  ELSIF v_app.status NOT IN ('pending_project_review', 'pending_entity_review') THEN
    RAISE EXCEPTION '当前申请状态不允许审核';
  END IF;

  IF v_app.review_path = 'first_project' THEN
    IF v_app.status <> 'pending_project_review' THEN RAISE EXCEPTION '申请状态与项目审核路径不一致'; END IF;
  ELSE
    IF v_app.status <> 'pending_entity_review' THEN RAISE EXCEPTION '申请状态与经营实体审核路径不一致'; END IF;
  END IF;

  PERFORM set_config('app.join_transition_source', 'site_project_review_application', true);
  IF v_action = 'reject' THEN
    UPDATE public.project_join_applications
    SET status = 'rejected', review_note = v_note,
        project_reviewed_by = CASE WHEN review_path = 'first_project' THEN auth.uid() ELSE project_reviewed_by END,
        project_reviewed_at = CASE WHEN review_path = 'first_project' THEN NOW() ELSE project_reviewed_at END,
        entity_reviewed_by = CASE WHEN review_path <> 'first_project' THEN auth.uid() ELSE entity_reviewed_by END,
        entity_reviewed_at = CASE WHEN review_path <> 'first_project' THEN NOW() ELSE entity_reviewed_at END,
        updated_at = NOW()
    WHERE id = v_app.id;
    RETURN jsonb_build_object('status', 'rejected', 'review_path', v_app.review_path, 'changed', TRUE);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('employee-identity:' || v_app.id_number_digest, 0));
  SELECT * INTO v_employee
  FROM public.training_employees e
  WHERE e.id_number_match_token = v_app.id_number_digest
  FOR UPDATE;

  -- 首次申请等待期间若该身份已在另一项目建档，必须重新归类并进入目标实体审核。
  IF v_app.review_path = 'first_project' AND FOUND THEN
    IF v_employee.user_id IS NOT NULL AND v_employee.user_id IS DISTINCT FROM v_app.applicant_user_id THEN
      RAISE EXCEPTION '该身份已绑定其他账号，请联系经营实体管理员核验';
    END IF;
    SELECT p.lead_entity_id INTO v_source_entity
    FROM public.site_project_members m
    JOIN public.site_projects p ON p.id = m.project_id
    WHERE m.employee_id = v_employee.id AND m.project_id <> v_app.project_id
    ORDER BY (m.status = 'active') DESC, m.joined_at DESC, m.id
    LIMIT 1;
    IF EXISTS (
      SELECT 1 FROM public.site_project_members m
      JOIN public.site_projects p ON p.id = m.project_id
      WHERE m.employee_id = v_employee.id
        AND m.project_id <> v_app.project_id
        AND p.lead_entity_id = v_app.target_entity_id
    ) OR v_employee.department_id = v_app.target_entity_id THEN
      v_review_path := 'same_entity_cross_project';
    ELSE
      v_review_path := 'cross_entity';
    END IF;
    UPDATE public.project_join_applications
    SET employee_id = v_employee.id, source_entity_id = v_source_entity,
        review_path = v_review_path, status = 'pending_entity_review',
        project_reviewed_by = auth.uid(), project_reviewed_at = NOW(),
        review_note = v_note, identity_resolved_at = NOW(), updated_at = NOW()
    WHERE id = v_app.id;
    RETURN jsonb_build_object(
      'status', 'pending_entity_review', 'review_path', v_review_path,
      'changed', TRUE, 'employee_id', v_employee.id
    );
  END IF;

  IF NOT FOUND THEN
    IF v_app.review_path <> 'first_project' THEN RAISE EXCEPTION '既有人员档案已不存在，不能继续经营实体审核'; END IF;
    PERFORM set_config('app.personnel_change_source', 'project_join_review', true);
    INSERT INTO public.training_employees(
      name, department_id, position, id_number, id_number_ciphertext,
      id_number_match_token, identity_updated_at, phone, emp_type, status,
      remark, photo_path, user_id, created_by
    ) VALUES (
      v_app.name, v_app.target_entity_id, v_app.position, NULL,
      v_app.id_number_ciphertext, v_app.id_number_digest, NOW(), v_app.phone,
      'employee', 'active', '外协人员（项目邀请码申请）',
      v_app.photo_path, v_app.applicant_user_id, auth.uid()
    ) RETURNING * INTO v_employee;
  ELSE
    IF v_employee.id IS DISTINCT FROM v_app.employee_id AND v_app.employee_id IS NOT NULL THEN
      RAISE EXCEPTION '申请关联人员与安全身份匹配结果不一致';
    END IF;
    IF v_employee.user_id IS NOT NULL AND v_employee.user_id IS DISTINCT FROM v_app.applicant_user_id THEN
      RAISE EXCEPTION '该身份已绑定其他账号，请联系经营实体管理员核验';
    END IF;
    IF v_employee.user_id IS NULL OR v_employee.photo_path IS DISTINCT FROM v_app.photo_path THEN
      PERFORM set_config('app.personnel_change_source', 'project_join_identity_and_photo_link', true);
      UPDATE public.training_employees
      SET user_id = COALESCE(user_id, v_app.applicant_user_id), photo_path = v_app.photo_path
      WHERE id = v_employee.id;
    END IF;
  END IF;

  -- 项目审核只延续既有行为：激活本次确认过的待审核单位，触发 v69 版本留痕。
  UPDATE public.contractor_companies
  SET status = 'active', reviewed_by = auth.uid(), reviewed_at = NOW(),
      review_note = '项目入场审核通过', updated_at = NOW()
  WHERE id = v_app.contractor_id AND status = 'pending';

  PERFORM set_config('app.member_assignment_source', 'project_join_review', true);
  PERFORM set_config('app.member_assignment_reason', '入场申请审核通过', true);
  INSERT INTO public.site_project_members(
    project_id, employee_id, contractor_id, application_id,
    membership_type, work_type, status, created_by
  ) VALUES (
    v_app.project_id, v_employee.id, v_app.contractor_id, v_app.id,
    'external', v_app.position, 'active', auth.uid()
  ) ON CONFLICT (project_id, employee_id) DO NOTHING
  RETURNING * INTO v_member;

  IF NOT FOUND THEN
    SELECT * INTO v_member FROM public.site_project_members
    WHERE project_id = v_app.project_id AND employee_id = v_employee.id FOR UPDATE;
    IF v_member.status <> 'active'
       OR v_member.contractor_id IS DISTINCT FROM v_app.contractor_id
       OR v_member.work_type IS DISTINCT FROM v_app.position THEN
      RAISE EXCEPTION '项目已存在不一致的人员关系，请先完成关系复核';
    END IF;
  END IF;

  UPDATE public.project_join_applications
  SET employee_id = v_employee.id, status = 'approved', review_note = v_note,
      project_reviewed_by = CASE WHEN review_path = 'first_project' THEN auth.uid() ELSE project_reviewed_by END,
      project_reviewed_at = CASE WHEN review_path = 'first_project' THEN NOW() ELSE project_reviewed_at END,
      entity_reviewed_by = CASE WHEN review_path <> 'first_project' THEN auth.uid() ELSE entity_reviewed_by END,
      entity_reviewed_at = CASE WHEN review_path <> 'first_project' THEN NOW() ELSE entity_reviewed_at END,
      identity_resolved_at = NOW(), updated_at = NOW()
  WHERE id = v_app.id;

  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
  VALUES (
    v_app.project_id, auth.uid(), 'approve', 'project_join_application', v_app.id,
    jsonb_build_object(
      'employee_id', v_employee.id, 'member_id', v_member.id,
      'contractor_id', v_app.contractor_id, 'review_path', v_app.review_path
    )
  );
  RETURN jsonb_build_object(
    'status', 'approved', 'review_path', v_app.review_path, 'changed', TRUE,
    'employee_id', v_employee.id, 'member_id', v_member.id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, extensions;

REVOKE ALL ON FUNCTION
  public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB),
  public.site_project_review_application(UUID, TEXT, TEXT)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB),
  public.site_project_review_application(UUID, TEXT, TEXT)
TO authenticated;

-- v46 后台批量建档会绕过安全身份与审核状态机，D08 起不再向客户端开放。
REVOKE ALL ON FUNCTION public.training_batch_add_contractor_members(UUID, UUID, JSONB)
FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;

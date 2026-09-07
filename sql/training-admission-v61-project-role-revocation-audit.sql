-- D07：项目角色撤销只影响后续请求，历史项目操作保留操作者和当时角色快照。
-- 权限仍由 site_project_can_manage() 实时读取 site_project_roles.active，不引入缓存。

CREATE OR REPLACE FUNCTION public.site_project_role_action_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
  v_actor_id UUID;
  v_actor_role TEXT;
  v_action TEXT;
BEGIN
  IF TG_TABLE_NAME = 'training_admission_reminders' THEN
    v_project_id := NEW.project_id;
    v_actor_id := NEW.created_by;
    v_action := 'project_reminder_created';
  ELSIF TG_TABLE_NAME = 'training_site_confirmations' THEN
    SELECT a.project_id INTO v_project_id
    FROM public.training_admissions a
    WHERE a.id = NEW.admission_id;
    v_actor_id := NEW.confirmer_id;
    v_action := 'site_confirmation_created';
  ELSIF TG_TABLE_NAME = 'training_verification_logs' THEN
    v_project_id := NEW.project_id;
    v_actor_id := NEW.verifier_id;
    v_action := 'site_verification_logged';
  ELSE
    RAISE EXCEPTION '不支持的项目角色操作审计来源：%', TG_TABLE_NAME;
  END IF;

  SELECT r.role INTO v_actor_role
  FROM public.site_project_roles r
  WHERE r.project_id = v_project_id
    AND r.user_id = v_actor_id
    AND r.active
    AND r.role IN ('project_manager', 'safety_officer')
  ORDER BY CASE r.role WHEN 'project_manager' THEN 1 ELSE 2 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    SELECT CASE
      WHEN p.role = 'admin' AND (p.is_super_admin IS TRUE OR p.admin_level = 'company') THEN 'company_admin'
      WHEN p.role = 'admin' AND p.admin_level = 'dept' THEN 'entity_admin'
      WHEN p.role = 'admin' THEN 'admin'
      ELSE COALESCE(p.role, 'unknown')
    END
    INTO v_actor_role
    FROM public.profiles p
    WHERE p.id = v_actor_id;
  END IF;

  INSERT INTO public.site_project_audit_logs(
    project_id, actor_id, action, entity_type, entity_id, detail
  ) VALUES (
    v_project_id,
    v_actor_id,
    v_action,
    TG_TABLE_NAME,
    NEW.id,
    jsonb_build_object(
      'actor_role_snapshot', COALESCE(v_actor_role, 'unknown'),
      'source_record_id', NEW.id,
      'source_table', TG_TABLE_NAME
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_role_action_audit_trigger()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_project_role_reminder_audit
  ON public.training_admission_reminders;
CREATE TRIGGER trg_project_role_reminder_audit
  AFTER INSERT ON public.training_admission_reminders
  FOR EACH ROW EXECUTE FUNCTION public.site_project_role_action_audit_trigger();

DROP TRIGGER IF EXISTS trg_project_role_site_confirmation_audit
  ON public.training_site_confirmations;
CREATE TRIGGER trg_project_role_site_confirmation_audit
  AFTER INSERT ON public.training_site_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.site_project_role_action_audit_trigger();

DROP TRIGGER IF EXISTS trg_project_role_verification_audit
  ON public.training_verification_logs;
CREATE TRIGGER trg_project_role_verification_audit
  AFTER INSERT ON public.training_verification_logs
  FOR EACH ROW EXECUTE FUNCTION public.site_project_role_action_audit_trigger();

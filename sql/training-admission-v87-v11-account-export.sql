-- D00-D13 V1.1 compatibility: governed account lifecycle and masked normal exports.
BEGIN;

CREATE TABLE IF NOT EXISTS public.account_subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE,
  employee_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO public.account_subjects(auth_user_id,employee_id)
SELECT p.id,p.employee_id FROM public.profiles p
ON CONFLICT(auth_user_id) DO UPDATE SET employee_id=COALESCE(EXCLUDED.employee_id,account_subjects.employee_id);

CREATE TABLE IF NOT EXISTS public.account_lifecycle (
  subject_id UUID PRIMARY KEY REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','disabled','frozen','closed')),
  reason TEXT,
  changed_by_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version_no INTEGER NOT NULL DEFAULT 1 CHECK(version_no>0)
);
INSERT INTO public.account_lifecycle(subject_id)
SELECT id FROM public.account_subjects ON CONFLICT(subject_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.training_account_profile_bootstrap() RETURNS TRIGGER AS $$
DECLARE v_subject UUID;
BEGIN
  INSERT INTO public.account_subjects(auth_user_id,employee_id) VALUES(NEW.id,NEW.employee_id)
  ON CONFLICT(auth_user_id) DO UPDATE SET employee_id=COALESCE(EXCLUDED.employee_id,account_subjects.employee_id)
  RETURNING id INTO v_subject;
  INSERT INTO public.account_lifecycle(subject_id) VALUES(v_subject) ON CONFLICT(subject_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_account_profile_bootstrap() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_account_profile_bootstrap ON public.profiles;
CREATE TRIGGER trg_training_account_profile_bootstrap AFTER INSERT OR UPDATE OF employee_id ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.training_account_profile_bootstrap();

CREATE TABLE IF NOT EXISTS public.account_lifecycle_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  old_status TEXT CHECK(old_status IS NULL OR old_status IN('active','disabled','frozen','closed')),
  new_status TEXT NOT NULL CHECK(new_status IN('active','disabled','frozen','closed')),
  operator_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE SET NULL,
  operator_role_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), request_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS account_lifecycle_history_request_idx
  ON public.account_lifecycle_history(subject_id,request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.account_high_privilege_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), target_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN('disable','freeze','close','grant_company_admin','revoke_company_admin')),
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected','used')),
  requested_by_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_by_subject_id UUID REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ
);

CREATE OR REPLACE FUNCTION public.training_current_account_subject_id()
RETURNS UUID AS $$ SELECT id FROM public.account_subjects WHERE auth_user_id=auth.uid() $$
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_current_account_subject_id() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_current_account_subject_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.training_account_roles(p_auth_user_id UUID DEFAULT auth.uid())
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'scope',x->>'role'),'[]'::jsonb) FROM (
    SELECT jsonb_build_object('role',CASE WHEN p.is_super_admin OR COALESCE(p.admin_level,'')='company' THEN 'company_admin'
      WHEN p.role='admin' AND p.admin_level='dept' THEN 'entity_admin'
      WHEN p.role='admin' AND p.admin_level='project' THEN 'project_admin' ELSE 'employee' END,
      'scope',CASE WHEN p.is_super_admin OR COALESCE(p.admin_level,'')='company' THEN 'company' ELSE 'entity' END,
      'scope_id',p.department_id) x FROM public.profiles p WHERE p.id=p_auth_user_id
    UNION ALL
    SELECT jsonb_build_object('role',r.role,'scope','project','scope_id',r.project_id)
    FROM public.site_project_roles r WHERE r.user_id=p_auth_user_id AND r.active
  ) q;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_roles(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_roles(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_account_is_active(p_auth_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN AS $$
  SELECT COALESCE((SELECT l.status='active' FROM public.account_subjects s JOIN public.account_lifecycle l ON l.subject_id=s.id
                   WHERE s.auth_user_id=p_auth_user_id),FALSE)
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_is_active(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_is_active(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_enforce_account_request() RETURNS VOID AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.training_account_is_active(auth.uid()) THEN
    RAISE EXCEPTION '[V11:account_inactive] 账号已冻结、停用或关闭' USING ERRCODE='42501';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_enforce_account_request() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_enforce_account_request() TO authenticated;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN
    EXECUTE 'ALTER ROLE authenticator SET pgrst.db_pre_request = ''public.training_enforce_account_request''';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.training_account_can_manage(p_target UUID)
RETURNS BOOLEAN AS $$
DECLARE v_target RECORD; v_me RECORD;
BEGIN
  SELECT * INTO v_target FROM public.profiles WHERE id=p_target;
  SELECT * INTO v_me FROM public.profiles WHERE id=auth.uid();
  IF v_target.id IS NULL OR v_me.id IS NULL OR NOT public.training_account_is_active(auth.uid()) THEN RETURN FALSE; END IF;
  IF public.training_is_company_admin() THEN RETURN TRUE; END IF;
  IF public.is_entity_manager() THEN
    RETURN v_target.department_id IN (SELECT public.account_visible_dept_ids());
  END IF;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_can_manage(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_account_request_high_privilege_action(p_target UUID,p_action TEXT,p_reason TEXT)
RETURNS UUID AS $$
DECLARE v_id UUID; v_target UUID;
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN
    RAISE EXCEPTION '[V11:account_forbidden] 仅有效公司级管理员可发起高权限账号操作';
  END IF;
  IF p_action NOT IN('disable','freeze','close','grant_company_admin','revoke_company_admin') OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION '[V11:account_invalid_request] 高权限操作及原因无效';
  END IF;
  SELECT id INTO v_target FROM public.account_subjects WHERE auth_user_id=p_target;
  IF v_target IS NULL THEN RAISE EXCEPTION '[V11:account_not_found] 账号不存在'; END IF;
  INSERT INTO public.account_high_privilege_approvals(target_subject_id,action,reason,requested_by_subject_id)
  VALUES(v_target,p_action,btrim(p_reason),public.training_current_account_subject_id()) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_request_high_privilege_action(UUID,TEXT,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_request_high_privilege_action(UUID,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_account_approve_high_privilege_action(p_approval_id UUID,p_approve BOOLEAN)
RETURNS JSONB AS $$
DECLARE v RECORD; v_me UUID:=public.training_current_account_subject_id();
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[V11:account_forbidden] 无审批权限'; END IF;
  SELECT * INTO v FROM public.account_high_privilege_approvals WHERE id=p_approval_id FOR UPDATE;
  IF v.id IS NULL OR v.status<>'pending' THEN RAISE EXCEPTION '[V11:approval_not_pending] 审批不存在或已处理'; END IF;
  IF v.requested_by_subject_id=v_me THEN RAISE EXCEPTION '[V11:dual_control_required] 发起人与审批人必须不同'; END IF;
  UPDATE public.account_high_privilege_approvals SET status=CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    reviewed_by_subject_id=v_me,reviewed_at=NOW() WHERE id=p_approval_id;
  RETURN jsonb_build_object('approval_id',p_approval_id,'status',CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_approve_high_privilege_action(UUID,BOOLEAN) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_approve_high_privilege_action(UUID,BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_profile_company_role_guard() RETURNS TRIGGER AS $$
DECLARE v_old_company BOOLEAN:=FALSE; v_new_company BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN v_old_company:=OLD.role='admin' AND (OLD.is_super_admin OR COALESCE(OLD.admin_level,'company')='company'); END IF;
  v_new_company:=NEW.role='admin' AND (NEW.is_super_admin OR COALESCE(NEW.admin_level,'company')='company');
  IF v_old_company IS DISTINCT FROM v_new_company AND current_setting('app.high_privilege_role_change',TRUE)<>'approved' THEN
    RAISE EXCEPTION '[V11:dual_control_required] 公司级管理员授权或撤销必须走独立审批';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public;
REVOKE ALL ON FUNCTION public.training_profile_company_role_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_profile_company_role_guard ON public.profiles;
CREATE TRIGGER trg_training_profile_company_role_guard BEFORE INSERT OR UPDATE OF role,admin_level,is_super_admin ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.training_profile_company_role_guard();

CREATE OR REPLACE FUNCTION public.training_account_apply_company_admin_role(p_approval_id UUID)
RETURNS JSONB AS $$
DECLARE v RECORD; v_target_user UUID; v_active_company INTEGER;
BEGIN
  IF NOT public.training_is_company_admin() OR NOT public.training_account_is_active(auth.uid()) THEN RAISE EXCEPTION '[V11:account_forbidden] 无高权限执行权限'; END IF;
  SELECT * INTO v FROM public.account_high_privilege_approvals WHERE id=p_approval_id AND status='approved'
    AND action IN('grant_company_admin','revoke_company_admin') FOR UPDATE;
  IF v.id IS NULL THEN RAISE EXCEPTION '[V11:approval_not_approved] 缺少有效独立审批'; END IF;
  SELECT auth_user_id INTO v_target_user FROM public.account_subjects WHERE id=v.target_subject_id;
  IF v_target_user IS NULL THEN RAISE EXCEPTION '[V11:account_not_found] 登录账号不存在'; END IF;
  IF v.action='revoke_company_admin' THEN
    SELECT count(*) INTO v_active_company FROM public.profiles p JOIN auth.users u ON u.id=p.id JOIN public.account_subjects s ON s.auth_user_id=p.id
      JOIN public.account_lifecycle l ON l.subject_id=s.id WHERE l.status='active' AND p.role='admin' AND (p.is_super_admin OR COALESCE(p.admin_level,'company')='company');
    IF v_active_company<=1 THEN RAISE EXCEPTION '[V11:last_company_admin] 不能撤销最后一个可用公司级管理员'; END IF;
  END IF;
  PERFORM set_config('app.high_privilege_role_change','approved',TRUE);
  UPDATE public.profiles SET role=CASE WHEN v.action='grant_company_admin' THEN 'admin' ELSE 'employee' END,
    admin_level=CASE WHEN v.action='grant_company_admin' THEN 'company' ELSE NULL END,
    is_super_admin=CASE WHEN v.action='grant_company_admin' THEN is_super_admin ELSE FALSE END WHERE id=v_target_user;
  UPDATE public.account_high_privilege_approvals SET status='used' WHERE id=v.id;
  INSERT INTO public.account_lifecycle_history(subject_id,old_status,new_status,operator_subject_id,operator_role_snapshot,reason)
  SELECT v.target_subject_id,l.status,l.status,public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),v.reason FROM public.account_lifecycle l WHERE l.subject_id=v.target_subject_id;
  RETURN jsonb_build_object('subject_id',v.target_subject_id,'action',v.action,'changed',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_apply_company_admin_role(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_apply_company_admin_role(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_account_set_status(p_user_id UUID,p_status TEXT,p_reason TEXT,p_request_id TEXT DEFAULT NULL,p_approval_id UUID DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_subject UUID; v_old TEXT; v_operator UUID:=public.training_current_account_subject_id(); v_target_role TEXT; v_target_level TEXT;
  v_target_super BOOLEAN; v_approval RECORD; v_company_count INTEGER;
BEGIN
  IF p_status NOT IN('active','disabled','frozen','closed') OR NULLIF(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION '[V11:account_invalid_status] 状态或原因无效';
  END IF;
  IF NOT public.training_account_can_manage(p_user_id) THEN RAISE EXCEPTION '[V11:account_forbidden] 无账号管理权限'; END IF;
  SELECT s.id,l.status,p.role,p.admin_level,p.is_super_admin INTO v_subject,v_old,v_target_role,v_target_level,v_target_super
  FROM public.account_subjects s JOIN public.account_lifecycle l ON l.subject_id=s.id JOIN public.profiles p ON p.id=s.auth_user_id
  WHERE s.auth_user_id=p_user_id FOR UPDATE OF l;
  IF v_subject IS NULL THEN RAISE EXCEPTION '[V11:account_not_found] 账号不存在'; END IF;
  IF p_user_id=auth.uid() AND p_status<>'active' THEN RAISE EXCEPTION '[V11:self_lock_forbidden] 不能停用当前账号'; END IF;
  IF v_old=p_status THEN RETURN jsonb_build_object('subject_id',v_subject,'status',v_old,'changed',FALSE); END IF;
  IF (v_target_super OR (v_target_role='admin' AND COALESCE(v_target_level,'company')='company')) AND p_status<>'active' THEN
    SELECT * INTO v_approval FROM public.account_high_privilege_approvals WHERE id=p_approval_id AND target_subject_id=v_subject
      AND action=CASE p_status WHEN 'disabled' THEN 'disable' WHEN 'frozen' THEN 'freeze' WHEN 'closed' THEN 'close' END AND status='approved' FOR UPDATE;
    IF v_approval.id IS NULL THEN
      RAISE EXCEPTION '[V11:dual_control_required] 公司级管理员操作需要另一名公司级管理员独立批准';
    END IF;
    SELECT count(*) INTO v_company_count FROM public.profiles p JOIN auth.users u ON u.id=p.id JOIN public.account_subjects s ON s.auth_user_id=p.id
      JOIN public.account_lifecycle l ON l.subject_id=s.id WHERE l.status='active' AND p.role='admin'
      AND (p.is_super_admin OR COALESCE(p.admin_level,'company')='company');
    IF v_company_count<=1 THEN RAISE EXCEPTION '[V11:last_company_admin] 不能停用最后一个可用公司级管理员'; END IF;
    UPDATE public.account_high_privilege_approvals SET status='used' WHERE id=v_approval.id;
  END IF;
  UPDATE public.account_lifecycle SET status=p_status,reason=btrim(p_reason),changed_by_subject_id=v_operator,changed_at=NOW(),version_no=version_no+1 WHERE subject_id=v_subject;
  INSERT INTO public.account_lifecycle_history(subject_id,old_status,new_status,operator_subject_id,operator_role_snapshot,reason,request_id)
  VALUES(v_subject,v_old,p_status,v_operator,public.training_account_roles(auth.uid()),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  UPDATE auth.users SET banned_until=CASE WHEN p_status='active' THEN NULL ELSE 'infinity'::timestamptz END WHERE id=p_user_id;
  DELETE FROM auth.refresh_tokens WHERE user_id=p_user_id::text;
  RETURN jsonb_build_object('subject_id',v_subject,'status',p_status,'changed',TRUE);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('subject_id',v_subject,'status',(SELECT status FROM public.account_lifecycle WHERE subject_id=v_subject),'changed',FALSE,'idempotent',TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.training_account_set_status(UUID,TEXT,TEXT,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_account_set_status(UUID,TEXT,TEXT,TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_dept_user(p_user_id UUID)
RETURNS JSONB AS $$
  SELECT public.training_account_set_status(p_user_id,'closed','管理员关闭登录身份','legacy-delete-'||p_user_id::text,NULL)
$$ LANGUAGE sql SECURITY DEFINER SET search_path=public;
REVOKE ALL ON FUNCTION public.delete_dept_user(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.delete_dept_user(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.certificate_normal_export(p_ids UUID[] DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v_rows JSONB;
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN RETURN '[]'::jsonb; END IF;
  EXECUTE $q$SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'department_id',c.department_id,'cert_name',c.cert_name,
    'cert_category',c.cert_category,'cert_type',c.cert_type,'cert_no',CASE WHEN c.cert_no IS NULL THEN NULL ELSE regexp_replace(c.cert_no,'^(.{2}).*(.{3})$','\1****\2') END,
    'issuing_authority',c.issuing_authority,'issue_date',c.issue_date,'valid_from',c.valid_from,'valid_until',c.valid_until,'is_long_term',c.is_long_term,
    'holder_name',c.holder_name,'holder_id_no',CASE WHEN c.holder_id_no IS NULL THEN NULL ELSE regexp_replace(c.holder_id_no,'^(.{3}).*(.{4})$','\1***********\2') END,
    'holder_position',c.holder_position,'status',c.status,'remark',c.remark,'created_at',c.created_at)),'[]'::jsonb)
    FROM public.certificates c WHERE ($1 IS NULL OR c.id=ANY($1))$q$ INTO v_rows USING p_ids;
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public;
REVOKE ALL ON FUNCTION public.certificate_normal_export(UUID[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.certificate_normal_export(UUID[]) TO authenticated;

ALTER TABLE public.account_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_lifecycle_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_high_privilege_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_subjects_read ON public.account_subjects FOR SELECT TO authenticated USING(auth_user_id=auth.uid() OR public.training_account_can_manage(auth_user_id));
CREATE POLICY account_lifecycle_read ON public.account_lifecycle FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.account_subjects s WHERE s.id=subject_id AND (s.auth_user_id=auth.uid() OR public.training_account_can_manage(s.auth_user_id))));
CREATE POLICY account_lifecycle_history_read ON public.account_lifecycle_history FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.account_subjects s WHERE s.id=subject_id AND (s.auth_user_id=auth.uid() OR public.training_account_can_manage(s.auth_user_id))));
CREATE POLICY account_approval_read ON public.account_high_privilege_approvals FOR SELECT TO authenticated USING(public.training_is_company_admin());
GRANT SELECT ON public.account_subjects,public.account_lifecycle,public.account_lifecycle_history,public.account_high_privilege_approvals TO authenticated;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.account_subjects,public.account_lifecycle,public.account_lifecycle_history,public.account_high_privilege_approvals FROM authenticated,anon;

COMMIT;

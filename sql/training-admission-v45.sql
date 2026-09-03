-- ============================================================================
-- 培训准入第四十五批：外协人员完整身份证加密档案与受控台账
-- 前置：training-admission-v1.sql 至 v44.sql 已执行。
-- 身份证仅以加密形式保存于入场申请档案；不得直接从普通表读取。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'training_admission_identity_key') THEN
    PERFORM vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'training_admission_identity_key', '培训准入外协人员身份证加密密钥');
  END IF;
END;
$$;

-- 申请入口：身份证必须为 18 位大陆居民身份证，数据库只保存密文与不可逆查重摘要。
DROP FUNCTION IF EXISTS public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB);
CREATE FUNCTION public.site_project_apply(
  p_token TEXT, p_name TEXT, p_phone TEXT, p_id_number TEXT, p_position TEXT,
  p_contractor_name TEXT, p_contractor_code TEXT, p_photo_path TEXT,
  p_attachments JSONB DEFAULT '[]'::JSONB
) RETURNS UUID AS $$
DECLARE
  v_invite public.site_project_invites; v_project public.site_projects; v_company UUID;
  v_status TEXT; v_application UUID; v_item JSONB; v_id_number TEXT; v_id_digest TEXT; v_key TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  v_id_number := upper(btrim(COALESCE(p_id_number, '')));
  IF v_id_number !~ '^[1-9][0-9]{16}[0-9X]$' THEN RAISE EXCEPTION '请填写 18 位大陆居民身份证号'; END IF;
  SELECT i.* INTO v_invite FROM public.site_project_invites i
  WHERE i.token_hash = encode(digest(btrim(p_token), 'sha256'), 'hex') AND i.revoked_at IS NULL AND i.expires_at > NOW();
  IF NOT FOUND THEN RAISE EXCEPTION '邀请码无效或已过期'; END IF;
  SELECT * INTO v_project FROM public.site_projects WHERE id = v_invite.project_id;
  IF v_project.status <> 'active' THEN RAISE EXCEPTION '项目当前未开放外协人员申请'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL OR NULLIF(btrim(p_phone), '') IS NULL OR NULLIF(btrim(p_position), '') IS NULL OR NULLIF(btrim(p_contractor_name), '') IS NULL THEN RAISE EXCEPTION '姓名、手机号、身份证号、工种和外协单位不能为空'; END IF;
  IF btrim(p_phone) !~ '^1[3-9][0-9]{9}$' OR NULLIF(btrim(p_photo_path), '') IS NULL OR p_photo_path !~ '^training-admission/join-applications/' THEN RAISE EXCEPTION '手机号或现场照片不符合要求'; END IF;
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::JSONB)) <> 'array' OR jsonb_array_length(COALESCE(p_attachments, '[]'::JSONB)) > 3 THEN RAISE EXCEPTION '申请附件格式不正确'; END IF;
  IF COALESCE(p_position, '') ~ '(爆破|钻探|电工|焊工)' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_attachments) x WHERE x->>'type' = 'special_certificate') THEN RAISE EXCEPTION '高风险工种必须上传特种作业证附件'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置，请联系系统管理员'; END IF;
  v_id_digest := encode(digest(v_id_number, 'sha256'), 'hex');
  IF EXISTS (SELECT 1 FROM public.project_join_applications WHERE project_id = v_project.id AND id_number_digest = v_id_digest AND status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN RAISE EXCEPTION '该身份证号已提交过本项目入场申请'; END IF;
  SELECT id, status INTO v_company, v_status FROM public.contractor_companies WHERE name = btrim(p_contractor_name) AND COALESCE(unified_code, '') = COALESCE(NULLIF(btrim(p_contractor_code), ''), '');
  IF v_company IS NULL THEN
    INSERT INTO public.contractor_companies(name, unified_code, status, created_by) VALUES (btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), ''), 'pending', auth.uid()) RETURNING id INTO v_company;
  ELSIF v_status IN ('rejected', 'inactive') THEN RAISE EXCEPTION '该外协单位当前不可申请加入项目'; END IF;
  IF EXISTS (SELECT 1 FROM public.project_join_applications WHERE project_id = v_project.id AND applicant_user_id = auth.uid() AND status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN RAISE EXCEPTION '您已经申请过加入该项目'; END IF;
  INSERT INTO public.project_join_applications(project_id, applicant_user_id, name, phone, id_number_ciphertext, id_number_digest, position, photo_path, contractor_id, contractor_name_input, contractor_code_input)
  VALUES (v_project.id, auth.uid(), btrim(p_name), btrim(p_phone), pgp_sym_encrypt(v_id_number, v_key, 'cipher-algo=aes256, compress-algo=0'), v_id_digest, btrim(p_position), p_photo_path, v_company, btrim(p_contractor_name), NULLIF(btrim(p_contractor_code), '')) RETURNING id INTO v_application;
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::JSONB)) LOOP
    IF COALESCE(v_item->>'type', '') NOT IN ('qualification', 'contract', 'special_certificate') OR COALESCE(v_item->>'path', '') !~ '^training-admission/join-applications/' THEN RAISE EXCEPTION '申请附件格式不正确'; END IF;
    INSERT INTO public.project_join_application_attachments(application_id, attachment_type, original_name, storage_path) VALUES (v_application, v_item->>'type', NULLIF(left(v_item->>'name', 160), ''), v_item->>'path');
  END LOOP;
  RETURN v_application;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.site_project_apply(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;

-- 审核人员按项目权限查看单笔完整身份证号；申请人和普通读取接口均无法取得明文。
CREATE OR REPLACE FUNCTION public.training_join_application_identity(p_application_id UUID)
RETURNS TABLE (application_id UUID, employee_name TEXT, id_number TEXT) AS $$
DECLARE v_app public.project_join_applications; v_key TEXT;
BEGIN
  SELECT * INTO v_app FROM public.project_join_applications WHERE id = p_application_id;
  IF NOT FOUND THEN RAISE EXCEPTION '入场申请不存在'; END IF;
  IF NOT public.site_project_can_manage(v_app.project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查看该申请的完整身份证号'; END IF;
  IF v_app.id_number_ciphertext IS NULL THEN RAISE EXCEPTION '该申请尚未留存身份证号'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置，请联系系统管理员'; END IF;
  RETURN QUERY SELECT v_app.id, v_app.name, pgp_sym_decrypt(v_app.id_number_ciphertext, v_key);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.training_join_application_identity(UUID) TO authenticated;

-- 固定三级教育记录卡：内部人员沿用既有档案号，外协人员从加密入场申请档案按权限带出。
DROP FUNCTION IF EXISTS public.training_admission_record_cards(UUID);
CREATE FUNCTION public.training_admission_record_cards(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  admission_id UUID, project_code TEXT, project_name TEXT, employee_name TEXT, employee_no TEXT,
  department_name TEXT, work_position TEXT, phone TEXT, id_number TEXT, contractor_name TEXT,
  admission_status TEXT, training_cycle_no INT, levels JSONB, signatures JSONB, retraining_cycles JSONB,
  final_signed_at TIMESTAMPTZ, site_confirmed_at TIMESTAMPTZ, valid_until DATE
) AS $$
DECLARE v_key TEXT;
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '汇总记录卡查询需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目记录卡'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  RETURN QUERY
  SELECT a.id, p.project_code, p.name, e.name, e.employee_no, d.name, e.position, e.phone,
         COALESCE(e.id_number, CASE WHEN app.id_number_ciphertext IS NOT NULL THEN pgp_sym_decrypt(app.id_number_ciphertext, v_key) END),
         cc.name, a.status, a.training_cycle_no,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('level', t.level, 'cycle_no', t.cycle_no, 'plan_title', tp.title, 'required_hours', tp.required_hours, 'completed_at', t.completed_at, 'employee_signed_at', (SELECT s.signed_at FROM public.training_admission_signatures s WHERE s.admission_id = a.id AND s.task_id = t.id AND s.signer_role = 'employee' ORDER BY s.signed_at DESC LIMIT 1), 'courses', COALESCE((SELECT jsonb_agg(c.title ORDER BY c.sort_order, c.created_at) FROM public.training_courses c WHERE c.plan_id = t.plan_id), '[]'::jsonb)) ORDER BY t.cycle_no, CASE t.level WHEN 'company' THEN 1 WHEN 'entity' THEN 2 WHEN 'project' THEN 3 ELSE 4 END, t.created_at) FROM public.training_admission_tasks t JOIN public.training_plans tp ON tp.id = t.plan_id WHERE t.admission_id = a.id), '[]'::jsonb),
         COALESCE((SELECT jsonb_object_agg(x.signer_role, x.signed_at) FROM (SELECT DISTINCT ON (s.signer_role) s.signer_role, s.signed_at FROM public.training_admission_signatures s WHERE s.admission_id = a.id AND s.task_id IS NULL AND s.cycle_no = a.training_cycle_no ORDER BY s.signer_role, s.signed_at DESC) x), '{}'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('cycle_no', rc.cycle_no, 'trigger_type', rc.trigger_type, 'reason', rc.reason, 'started_at', rc.started_at, 'old_package_title', oldp.title, 'new_package_title', newp.title) ORDER BY rc.cycle_no) FROM public.training_admission_retraining_cycles rc LEFT JOIN public.training_admission_packages oldp ON oldp.id = rc.old_package_id JOIN public.training_admission_packages newp ON newp.id = rc.new_package_id WHERE rc.admission_id = a.id), '[]'::jsonb),
         a.final_signed_at, a.site_confirmed_at, a.valid_until
  FROM public.training_admissions a JOIN public.site_projects p ON p.id = a.project_id JOIN public.training_employees e ON e.id = a.employee_id
  LEFT JOIN public.departments d ON d.id = e.department_id LEFT JOIN public.site_project_members m ON m.id = a.member_id
  LEFT JOIN public.project_join_applications app ON app.id = m.application_id LEFT JOIN public.contractor_companies cc ON cc.id = m.contractor_id
  WHERE p_project_id IS NULL OR a.project_id = p_project_id ORDER BY p.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.training_admission_record_cards(UUID) TO authenticated;

-- 外协人员台账也纳入完整身份证号，权限边界与记录卡一致。
DROP FUNCTION IF EXISTS public.training_contractor_personnel_ledger(UUID);
CREATE FUNCTION public.training_contractor_personnel_ledger(p_project_id UUID DEFAULT NULL)
RETURNS TABLE (
  project_code TEXT, project_name TEXT, employee_name TEXT, phone TEXT, id_number TEXT, work_position TEXT,
  contractor_name TEXT, unified_code TEXT, member_status TEXT, joined_at TIMESTAMPTZ,
  contract_no TEXT, contract_name TEXT, contract_status TEXT, special_certificates TEXT,
  certificate_status TEXT, admission_status TEXT, valid_until DATE
) AS $$
DECLARE v_key TEXT;
BEGIN
  IF p_project_id IS NULL AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '汇总外协人员台账需要公司级权限'; END IF;
  IF p_project_id IS NOT NULL AND NOT public.site_project_can_manage(p_project_id) AND NOT public.training_is_company_admin() THEN RAISE EXCEPTION '您无权查询该项目外协人员台账'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  RETURN QUERY
  SELECT p.project_code, p.name, e.name, e.phone, COALESCE(e.id_number, CASE WHEN app.id_number_ciphertext IS NOT NULL THEN pgp_sym_decrypt(app.id_number_ciphertext, v_key) END), COALESCE(m.work_type, e.position), cc.name, cc.unified_code, m.status, m.joined_at,
         ct.contract_no, ct.contract_name, ct.status, COALESCE(cert.certificate_text, '无'), COALESCE(cert.review_text, '未登记'), COALESCE(a.status, 'not_started'), a.valid_until
  FROM public.site_project_members m JOIN public.site_projects p ON p.id = m.project_id JOIN public.training_employees e ON e.id = m.employee_id JOIN public.contractor_companies cc ON cc.id = m.contractor_id
  LEFT JOIN public.project_join_applications app ON app.id = m.application_id
  LEFT JOIN LATERAL (SELECT c.contract_no, c.contract_name, c.status FROM public.contractor_contracts c WHERE c.project_id = m.project_id AND c.contractor_id = m.contractor_id ORDER BY c.created_at DESC LIMIT 1) ct ON TRUE
  LEFT JOIN LATERAL (SELECT string_agg(COALESCE(d.certificate_type, '特种作业证') || COALESCE('（' || d.certificate_no || '）', ''), '；' ORDER BY d.created_at DESC) AS certificate_text, CASE WHEN bool_or(d.review_status = 'approved' AND (d.valid_until IS NULL OR d.valid_until >= CURRENT_DATE)) THEN '已审核有效' WHEN count(d.id) > 0 THEN '待审核/已失效' ELSE '未登记' END AS review_text FROM public.contractor_documents d WHERE d.project_id = m.project_id AND d.employee_id = m.employee_id AND d.document_type = 'special_certificate') cert ON TRUE
  LEFT JOIN public.training_admissions a ON a.project_id = m.project_id AND a.employee_id = m.employee_id
  WHERE m.membership_type = 'external' AND (p_project_id IS NULL OR m.project_id = p_project_id) ORDER BY p.name, cc.name, e.name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.training_contractor_personnel_ledger(UUID) TO authenticated;

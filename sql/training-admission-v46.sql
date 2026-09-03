-- ============================================================================
-- 培训准入第四十六批：项目部后台建档与批量导入的加密身份证档案
-- 前置：training-admission-v1.sql 至 v45.sql 已执行。
-- ============================================================================

DROP FUNCTION IF EXISTS public.training_batch_add_contractor_members(UUID, UUID, JSONB);
CREATE FUNCTION public.training_batch_add_contractor_members(
  p_project_id UUID, p_contractor_id UUID, p_people JSONB
)
RETURNS TABLE (row_no INT, employee_id UUID, member_id UUID, result_code TEXT, result_message TEXT) AS $$
DECLARE
  v_item JSONB; v_row INT := 0; v_employee UUID; v_member UUID; v_application UUID;
  v_name TEXT; v_phone TEXT; v_position TEXT; v_id_number TEXT; v_id_digest TEXT;
  v_existing_name TEXT; v_lead_entity UUID; v_key TEXT;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权为该项目导入外协人员'; END IF;
  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN RAISE EXCEPTION '请至少导入一名人员'; END IF;
  IF jsonb_array_length(p_people) > 300 THEN RAISE EXCEPTION '单次最多导入 300 人，请分批处理'; END IF;
  SELECT lead_entity_id INTO v_lead_entity FROM public.site_projects WHERE id = p_project_id AND status = 'active';
  IF v_lead_entity IS NULL THEN RAISE EXCEPTION '项目不存在或未处于在建状态，不能导入人员'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contractor_companies c WHERE c.id = p_contractor_id AND c.status IN ('pending', 'active')) THEN RAISE EXCEPTION '外协单位不存在、已驳回或已停用'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置，请联系系统管理员'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_row := v_row + 1; row_no := v_row; employee_id := NULL; member_id := NULL; result_code := NULL; result_message := NULL;
    v_name := NULLIF(btrim(v_item->>'name'), ''); v_phone := NULLIF(btrim(v_item->>'phone'), '');
    v_position := NULLIF(btrim(v_item->>'position'), ''); v_id_number := upper(btrim(COALESCE(v_item->>'id_number', '')));
    IF v_name IS NULL OR v_phone IS NULL OR v_position IS NULL OR v_id_number = '' THEN
      result_code := 'failed'; result_message := '姓名、手机号、身份证号和工种不能为空'; RETURN NEXT; CONTINUE;
    END IF;
    IF v_phone !~ '^1[3-9][0-9]{9}$' THEN result_code := 'failed'; result_message := '手机号格式不正确'; RETURN NEXT; CONTINUE; END IF;
    IF v_id_number !~ '^[1-9][0-9]{16}[0-9X]$' THEN result_code := 'failed'; result_message := '身份证号必须为 18 位大陆居民身份证号'; RETURN NEXT; CONTINUE; END IF;
    v_id_digest := encode(digest(v_id_number, 'sha256'), 'hex');
    IF EXISTS (SELECT 1 FROM public.project_join_applications a WHERE a.project_id = p_project_id AND a.id_number_digest = v_id_digest AND a.status IN ('pending_project_review', 'pending_entity_review', 'approved')) THEN
      result_code := 'failed'; result_message := '该身份证号已在本项目建档'; RETURN NEXT; CONTINUE;
    END IF;
    BEGIN
      SELECT e.id, e.name INTO v_employee, v_existing_name FROM public.training_employees e WHERE e.phone = v_phone ORDER BY e.created_at LIMIT 1;
      IF FOUND AND v_existing_name <> v_name THEN result_code := 'failed'; result_message := '该手机号已存在且姓名不一致，请核对身份信息'; RETURN NEXT; CONTINUE; END IF;
      IF NOT FOUND THEN
        INSERT INTO public.training_employees(name, phone, position, department_id, emp_type, status, remark, created_by)
        VALUES (v_name, v_phone, v_position, v_lead_entity, 'employee', 'active', '外协人员（项目部后台建档）', auth.uid())
        RETURNING id INTO v_employee;
        result_code := 'created'; result_message := '已建立加密身份证档案并加入项目';
      ELSE
        result_code := 'reused'; result_message := '已复用原有人员档案并补充本项目加密身份证档案';
      END IF;
      INSERT INTO public.project_join_applications(
        project_id, employee_id, name, phone, id_number_ciphertext, id_number_digest, position,
        contractor_id, contractor_name_input, contractor_code_input, application_type, status,
        review_note, project_reviewed_by, project_reviewed_at
      )
      SELECT p_project_id, v_employee, v_name, v_phone,
             pgp_sym_encrypt(v_id_number, v_key, 'cipher-algo=aes256, compress-algo=0'), v_id_digest, v_position,
             c.id, c.name, c.unified_code, 'external', 'approved', '项目部后台建档', auth.uid(), NOW()
      FROM public.contractor_companies c WHERE c.id = p_contractor_id
      RETURNING id INTO v_application;
      INSERT INTO public.site_project_members(project_id, employee_id, contractor_id, application_id, membership_type, work_type, status, joined_at, left_at, left_reason, created_by)
      VALUES (p_project_id, v_employee, p_contractor_id, v_application, 'external', v_position, 'active', NOW(), NULL, NULL, auth.uid())
      ON CONFLICT (project_id, employee_id) DO UPDATE
        SET contractor_id = EXCLUDED.contractor_id, application_id = EXCLUDED.application_id, membership_type = 'external', work_type = EXCLUDED.work_type,
            status = 'active', joined_at = EXCLUDED.joined_at, left_at = NULL, left_reason = NULL
      RETURNING id INTO v_member;
      employee_id := v_employee; member_id := v_member;
      IF EXISTS (SELECT 1 FROM public.training_admissions a WHERE a.project_id = p_project_id AND a.employee_id = v_employee) THEN
        PERFORM public.training_recompute_admission((SELECT a.id FROM public.training_admissions a WHERE a.project_id = p_project_id AND a.employee_id = v_employee));
      END IF;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN result_code := 'failed'; result_message := SQLERRM; RETURN NEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.training_batch_add_contractor_members(UUID, UUID, JSONB) TO authenticated;

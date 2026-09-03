-- ============================================================================
-- 培训准入第四十七批：历史外协人员加密身份证档案补录
-- 前置：training-admission-v1.sql 至 v46.sql 已执行。
-- 仅补录当前项目已存在的外协人员；明文不进入 training_employees 或审计日志。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.training_backfill_contractor_identities(
  p_project_id UUID, p_people JSONB
)
RETURNS TABLE (row_no INT, employee_id UUID, application_id UUID, result_code TEXT, result_message TEXT) AS $$
DECLARE
  v_item JSONB; v_row INT := 0; v_employee UUID; v_member UUID; v_application UUID;
  v_name TEXT; v_phone TEXT; v_id_number TEXT; v_id_digest TEXT; v_key TEXT; v_existing_cipher BYTEA;
BEGIN
  IF NOT public.site_project_can_manage(p_project_id) THEN RAISE EXCEPTION '您无权补录该项目的外协人员档案'; END IF;
  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN RAISE EXCEPTION '请至少补录一名人员'; END IF;
  IF jsonb_array_length(p_people) > 300 THEN RAISE EXCEPTION '单次最多补录 300 人，请分批处理'; END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'training_admission_identity_key' LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION '身份证加密密钥未配置，请联系系统管理员'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_people) LOOP
    v_row := v_row + 1; row_no := v_row; employee_id := NULL; application_id := NULL; result_code := NULL; result_message := NULL;
    v_name := NULLIF(btrim(v_item->>'name'), ''); v_phone := NULLIF(btrim(v_item->>'phone'), ''); v_id_number := upper(btrim(COALESCE(v_item->>'id_number', '')));
    IF v_name IS NULL OR v_phone IS NULL OR v_id_number = '' THEN result_code := 'failed'; result_message := '姓名、手机号和身份证号不能为空'; RETURN NEXT; CONTINUE; END IF;
    IF v_phone !~ '^1[3-9][0-9]{9}$' THEN result_code := 'failed'; result_message := '手机号格式不正确'; RETURN NEXT; CONTINUE; END IF;
    IF v_id_number !~ '^[1-9][0-9]{16}[0-9X]$' THEN result_code := 'failed'; result_message := '身份证号必须为 18 位大陆居民身份证号'; RETURN NEXT; CONTINUE; END IF;
    v_id_digest := encode(digest(v_id_number, 'sha256'), 'hex');
    BEGIN
      SELECT m.id, e.id, m.application_id INTO v_member, v_employee, v_application
      FROM public.site_project_members m JOIN public.training_employees e ON e.id = m.employee_id
      WHERE m.project_id = p_project_id AND m.membership_type = 'external' AND m.status IN ('active', 'left')
        AND e.name = v_name AND e.phone = v_phone
      ORDER BY m.joined_at DESC LIMIT 1;
      IF v_member IS NULL THEN result_code := 'failed'; result_message := '未找到本项目在场且姓名、手机号均匹配的外协人员'; RETURN NEXT; CONTINUE; END IF;
      IF EXISTS (SELECT 1 FROM public.project_join_applications a WHERE a.project_id = p_project_id AND a.id_number_digest = v_id_digest AND a.id IS DISTINCT FROM v_application) THEN
        result_code := 'failed'; result_message := '该身份证号已在本项目其他人员档案中留存'; RETURN NEXT; CONTINUE;
      END IF;
      IF v_application IS NOT NULL THEN
        SELECT id_number_ciphertext INTO v_existing_cipher FROM public.project_join_applications WHERE id = v_application FOR UPDATE;
        IF v_existing_cipher IS NOT NULL THEN result_code := 'already_recorded'; result_message := '该人员已留存加密身份证档案，未修改'; employee_id := v_employee; application_id := v_application; RETURN NEXT; CONTINUE; END IF;
        UPDATE public.project_join_applications
        SET id_number_ciphertext = pgp_sym_encrypt(v_id_number, v_key, 'cipher-algo=aes256, compress-algo=0'), id_number_digest = v_id_digest,
            review_note = COALESCE(NULLIF(review_note, ''), '历史外协档案补录'), updated_at = NOW()
        WHERE id = v_application;
      ELSE
        INSERT INTO public.project_join_applications(
          project_id, employee_id, name, phone, id_number_ciphertext, id_number_digest, position,
          contractor_id, contractor_name_input, contractor_code_input, application_type, status,
          review_note, project_reviewed_by, project_reviewed_at
        )
        SELECT m.project_id, e.id, e.name, e.phone,
               pgp_sym_encrypt(v_id_number, v_key, 'cipher-algo=aes256, compress-algo=0'), v_id_digest, COALESCE(m.work_type, e.position),
               c.id, c.name, c.unified_code, 'external', 'approved', '历史外协档案补录', auth.uid(), NOW()
        FROM public.site_project_members m JOIN public.training_employees e ON e.id = m.employee_id
        JOIN public.contractor_companies c ON c.id = m.contractor_id
        WHERE m.id = v_member
        RETURNING id INTO v_application;
        UPDATE public.site_project_members SET application_id = v_application WHERE id = v_member;
      END IF;
      INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, entity_id, detail)
      VALUES (p_project_id, auth.uid(), 'identity_backfill', 'project_join_application', v_application,
              jsonb_build_object('employee_id', v_employee, 'identity_recorded', TRUE));
      employee_id := v_employee; application_id := v_application; result_code := 'recorded'; result_message := '已加密留存身份证档案'; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN result_code := 'failed'; result_message := SQLERRM; RETURN NEXT;
    END;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;
GRANT EXECUTE ON FUNCTION public.training_backfill_contractor_identities(UUID, JSONB) TO authenticated;

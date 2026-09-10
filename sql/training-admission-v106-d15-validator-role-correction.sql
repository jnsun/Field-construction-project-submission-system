-- D15 R02-2B: SECURITY DEFINER must authorize the PostgREST JWT role, not function-owner current_user.
BEGIN;
CREATE OR REPLACE FUNCTION public.training_signature_record_file_validation(
  p_challenge_id UUID,p_detected_mime_type TEXT,p_actual_size_bytes BIGINT,p_actual_width INTEGER,
  p_actual_height INTEGER,p_content_sha256 TEXT,p_validator_version TEXT
) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements;
  v_object storage.objects; v_subject UUID; v_existing public.training_signature_file_validations; v_new public.training_signature_file_validations;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role',TRUE),'')<>'service_role' THEN
    RAISE EXCEPTION '[D15:signature_forbidden] 仅受控文件验证服务可写入验证事实' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_challenge FROM public.training_signature_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字 challenge 不存在'; END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION '[D15:signature_challenge_expired] 签字 challenge 已失效';
  END IF;
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=v_challenge.requirement_id;
  SELECT * INTO v_object FROM storage.objects WHERE bucket_id=v_challenge.storage_bucket AND name=v_challenge.storage_path;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 未找到本 challenge 的签字图片'; END IF;
  SELECT id INTO v_subject FROM public.account_subjects
    WHERE auth_user_id::text=COALESCE(v_object.owner_id,v_object.owner::text) AND id=v_challenge.signer_subject_id;
  IF v_subject IS NULL THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 文件所有者与签字人不一致'; END IF;
  IF p_detected_mime_type NOT IN('image/png','image/jpeg') OR p_actual_size_bytes NOT BETWEEN 1 AND 2097152
    OR p_actual_width NOT BETWEEN 64 AND 4096 OR p_actual_height NOT BETWEEN 32 AND 4096
    OR lower(COALESCE(p_content_sha256,'')) !~ '^[0-9a-f]{64}$' OR NULLIF(btrim(p_validator_version),'') IS NULL THEN
    RAISE EXCEPTION '[D15:signature_file_invalid] 真实图片验证结果无效';
  END IF;
  SELECT * INTO v_existing FROM public.training_signature_file_validations WHERE challenge_id=v_challenge.id;
  IF FOUND THEN
    IF v_existing.storage_object_id=v_object.id AND v_existing.storage_object_updated_at=v_object.updated_at
      AND v_existing.storage_object_version IS NOT DISTINCT FROM v_object.version
      AND v_existing.detected_mime_type=p_detected_mime_type AND v_existing.actual_size_bytes=p_actual_size_bytes
      AND v_existing.actual_width=p_actual_width AND v_existing.actual_height=p_actual_height
      AND v_existing.content_sha256=lower(p_content_sha256) THEN
      RETURN to_jsonb(v_existing)||jsonb_build_object('idempotent',TRUE);
    END IF;
    RAISE EXCEPTION '[D15:signature_file_mismatch] 文件验证后发生变化';
  END IF;
  INSERT INTO public.training_signature_file_validations(requirement_id,challenge_id,uploader_subject_id,storage_object_id,
    storage_bucket,storage_path,storage_object_version,storage_object_updated_at,detected_mime_type,actual_size_bytes,
    actual_width,actual_height,content_sha256,validation_status,validator_version)
  VALUES(v_req.id,v_challenge.id,v_subject,v_object.id,v_challenge.storage_bucket,v_challenge.storage_path,v_object.version,
    v_object.updated_at,p_detected_mime_type,p_actual_size_bytes,p_actual_width,p_actual_height,lower(p_content_sha256),'valid',btrim(p_validator_version))
  RETURNING * INTO v_new;
  RETURN to_jsonb(v_new)||jsonb_build_object('idempotent',FALSE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;
REVOKE ALL ON FUNCTION public.training_signature_record_file_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_signature_record_file_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT) TO service_role;
COMMIT;

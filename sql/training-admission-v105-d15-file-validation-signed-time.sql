-- D15 R02-2B: authoritative image-byte validation and signed_at-bound evidence digest.
BEGIN;

CREATE TABLE public.training_signature_file_validations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.training_signature_requirements(id) ON DELETE RESTRICT,
  challenge_id UUID NOT NULL UNIQUE REFERENCES public.training_signature_challenges(id) ON DELETE RESTRICT,
  uploader_subject_id UUID NOT NULL REFERENCES public.account_subjects(id) ON DELETE RESTRICT,
  storage_object_id UUID NOT NULL,
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  storage_object_version TEXT,
  storage_object_updated_at TIMESTAMPTZ NOT NULL,
  detected_mime_type TEXT NOT NULL CHECK(detected_mime_type IN('image/png','image/jpeg')),
  actual_size_bytes BIGINT NOT NULL CHECK(actual_size_bytes BETWEEN 1 AND 2097152),
  actual_width INTEGER NOT NULL CHECK(actual_width BETWEEN 64 AND 4096),
  actual_height INTEGER NOT NULL CHECK(actual_height BETWEEN 32 AND 4096),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  validation_status TEXT NOT NULL CHECK(validation_status='valid'),
  validator_version TEXT NOT NULL CHECK(btrim(validator_version)<>''),
  validated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX training_signature_file_validation_object_idx
  ON public.training_signature_file_validations(storage_object_id,storage_object_version,content_sha256);

ALTER TABLE public.training_signature_results
  ADD COLUMN file_validation_id UUID REFERENCES public.training_signature_file_validations(id) ON DELETE RESTRICT,
  ADD COLUMN file_content_sha256 TEXT CHECK(file_content_sha256 IS NULL OR file_content_sha256 ~ '^[0-9a-f]{64}$');

CREATE TRIGGER trg_training_signature_file_validation_immutable BEFORE UPDATE OR DELETE
  ON public.training_signature_file_validations FOR EACH ROW
  EXECUTE FUNCTION public.training_signature_history_immutable_guard();

CREATE FUNCTION public.training_signature_file_validation_context(p_challenge_id UUID) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements; v_auth JSONB;
BEGIN
  SELECT * INTO v_challenge FROM public.training_signature_challenges WHERE id=p_challenge_id;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字 challenge 不存在'; END IF;
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=v_challenge.requirement_id;
  v_auth:=public.training_signature_authority_internal(v_req);
  IF (v_auth->>'subject_id')::uuid<>v_challenge.signer_subject_id THEN
    RAISE EXCEPTION '[D15:signature_forbidden] 签字人不匹配' USING ERRCODE='42501';
  END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION '[D15:signature_challenge_expired] 签字 challenge 已失效';
  END IF;
  RETURN jsonb_build_object('requirement_id',v_req.id,'challenge_id',v_challenge.id,
    'storage_bucket',v_challenge.storage_bucket,'storage_path',v_challenge.storage_path,
    'max_bytes',2097152,'allowed_mime_types',jsonb_build_array('image/png','image/jpeg'));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public;

CREATE FUNCTION public.training_signature_record_file_validation(
  p_challenge_id UUID,p_detected_mime_type TEXT,p_actual_size_bytes BIGINT,p_actual_width INTEGER,
  p_actual_height INTEGER,p_content_sha256 TEXT,p_validator_version TEXT
) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements;
  v_object storage.objects; v_subject UUID; v_existing public.training_signature_file_validations; v_new public.training_signature_file_validations;
BEGIN
  IF current_user<>'service_role' AND COALESCE(current_setting('request.jwt.claim.role',TRUE),'')<>'service_role' THEN
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

CREATE OR REPLACE FUNCTION public.training_signature_submit(p_challenge_id UUID,p_nonce TEXT,p_idempotency_key TEXT,p_device JSONB DEFAULT '{}'::jsonb) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements; v_existing public.training_signature_results;
  v_auth JSONB; v_base_evidence JSONB; v_evidence JSONB; v_base_digest TEXT; v_digest TEXT; v_object storage.objects;
  v_validation public.training_signature_file_validations; v_result public.training_signature_results;
  v_now TIMESTAMPTZ:=clock_timestamp(); v_signed_at_utc TEXT;
BEGIN
  IF NULLIF(btrim(p_idempotency_key),'') IS NULL OR NULLIF(btrim(p_nonce),'') IS NULL OR jsonb_typeof(COALESCE(p_device,'{}'::jsonb))<>'object' THEN
    RAISE EXCEPTION '[D15:signature_file_invalid] 提交参数无效'; END IF;
  SELECT * INTO v_challenge FROM public.training_signature_challenges WHERE id=p_challenge_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_requirement_not_found] 签字 challenge 不存在'; END IF;
  SELECT * INTO v_req FROM public.training_signature_requirements WHERE id=v_challenge.requirement_id FOR UPDATE;
  SELECT * INTO v_existing FROM public.training_signature_results WHERE requirement_id=v_req.id;
  IF FOUND THEN RETURN jsonb_build_object('status','signed','reason_code','signature_already_completed','idempotent',TRUE,'result_id',v_existing.id,
    'signed_at',v_existing.signed_at,'evidence_digest',v_existing.evidence_digest); END IF;
  IF v_challenge.used_at IS NOT NULL OR v_challenge.expires_at<=v_now THEN RAISE EXCEPTION '[D15:signature_challenge_expired] 签字 challenge 已失效'; END IF;
  IF v_challenge.nonce_hash<>public.training_signature_digest_internal(to_jsonb(p_nonce)) THEN RAISE EXCEPTION '[D15:signature_file_mismatch] challenge 不匹配'; END IF;
  v_auth:=public.training_signature_authority_internal(v_req);
  IF (v_auth->>'subject_id')::uuid<>v_challenge.signer_subject_id THEN RAISE EXCEPTION '[D15:signature_forbidden] 签字人不匹配' USING ERRCODE='42501'; END IF;
  IF public.training_signature_prerequisite_internal(v_req)<>'ready' THEN RAISE EXCEPTION '[D15:signature_prerequisite_not_met] 签字前置已变化'; END IF;
  v_base_evidence:=public.training_signature_evidence_internal(v_req,v_auth);
  v_base_digest:=public.training_signature_digest_internal(v_base_evidence);
  IF v_base_digest<>v_challenge.evidence_digest THEN RAISE EXCEPTION '[D15:signature_evidence_changed] 证据已变化，请重新确认'; END IF;
  SELECT * INTO v_validation FROM public.training_signature_file_validations
    WHERE challenge_id=v_challenge.id AND requirement_id=v_req.id AND uploader_subject_id=v_challenge.signer_subject_id AND validation_status='valid';
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_file_invalid] 签字图片尚未经过真实内容验证'; END IF;
  SELECT * INTO v_object FROM storage.objects WHERE id=v_validation.storage_object_id
    AND bucket_id=v_validation.storage_bucket AND name=v_validation.storage_path;
  IF NOT FOUND OR v_object.updated_at<>v_validation.storage_object_updated_at
    OR v_object.version IS DISTINCT FROM v_validation.storage_object_version
    OR COALESCE(v_object.owner_id,v_object.owner::text)<>auth.uid()::text THEN
    RAISE EXCEPTION '[D15:signature_file_mismatch] 已验证签字图片已变化或不属于当前签字人';
  END IF;
  v_signed_at_utc:=to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_evidence:=v_base_evidence||jsonb_build_object('signature_signed_at',v_signed_at_utc,'signature_file_validation',
    jsonb_build_object('validation_id',v_validation.id,'storage_object_id',v_validation.storage_object_id,
      'detected_mime_type',v_validation.detected_mime_type,'actual_size_bytes',v_validation.actual_size_bytes,
      'actual_width',v_validation.actual_width,'actual_height',v_validation.actual_height,
      'content_sha256',v_validation.content_sha256,'validator_version',v_validation.validator_version,'validated_at',v_validation.validated_at));
  v_digest:=public.training_signature_digest_internal(v_evidence);
  INSERT INTO public.training_signature_results(requirement_id,challenge_id,signer_subject_id,signer_auth_user_id,signer_role_snapshot,signer_scope_snapshot,
    signer_display_snapshot,storage_bucket,storage_path,mime_type,file_size_bytes,image_width,image_height,evidence_digest,evidence_snapshot,signed_at,idempotency_key,device_snapshot,
    file_validation_id,file_content_sha256)
  VALUES(v_req.id,v_challenge.id,v_challenge.signer_subject_id,auth.uid(),v_auth->>'role',v_auth->'scope',v_evidence->'signer'->'display',v_validation.storage_bucket,
    v_validation.storage_path,v_validation.detected_mime_type,v_validation.actual_size_bytes,v_validation.actual_width,v_validation.actual_height,v_digest,v_evidence,v_now,
    btrim(p_idempotency_key),COALESCE(p_device,'{}'::jsonb),v_validation.id,v_validation.content_sha256) RETURNING * INTO v_result;
  PERFORM set_config('app.training_signature_mutation','on',TRUE);
  UPDATE public.training_signature_requirements SET status='signed',resolved_at=v_now,status_reason='signed' WHERE id=v_req.id;
  UPDATE public.training_signature_challenges SET used_at=v_now WHERE id=v_challenge.id;
  INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_req.id,'signed',v_result.signer_subject_id,'signed',jsonb_build_object('result_id',v_result.id,'evidence_digest',v_digest,'file_validation_id',v_validation.id,'signer_role',v_result.signer_role_snapshot));
  RETURN jsonb_build_object('status','signed','reason_code','signature_completed','idempotent',FALSE,'result_id',v_result.id,'signed_at',v_result.signed_at,'evidence_digest',v_digest);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.training_signature_results WHERE requirement_id=v_req.id OR (signer_subject_id=(v_auth->>'subject_id')::uuid AND idempotency_key=btrim(p_idempotency_key)) ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status','signed','reason_code','signature_already_completed','idempotent',TRUE,'result_id',v_existing.id,'signed_at',v_existing.signed_at,'evidence_digest',v_existing.evidence_digest); END IF;
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;

ALTER TABLE public.training_signature_file_validations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_signature_file_validations FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.training_signature_file_validation_context(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_signature_file_validation_context(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.training_signature_record_file_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.training_signature_record_file_validation(UUID,TEXT,BIGINT,INTEGER,INTEGER,TEXT,TEXT) TO service_role;

COMMENT ON TABLE public.training_signature_file_validations IS 'Immutable D15 server-side decoded image facts; ordinary clients cannot create or alter validation.';
COMMIT;

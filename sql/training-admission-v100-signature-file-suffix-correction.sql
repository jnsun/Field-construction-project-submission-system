-- D15 forward correction for the v98 submit-function suffix expression.
BEGIN;
CREATE OR REPLACE FUNCTION public.training_signature_submit(p_challenge_id UUID,p_nonce TEXT,p_idempotency_key TEXT,p_device JSONB DEFAULT '{}'::jsonb) RETURNS JSONB AS $$
DECLARE v_challenge public.training_signature_challenges; v_req public.training_signature_requirements; v_existing public.training_signature_results;
  v_auth JSONB; v_evidence JSONB; v_digest TEXT; v_object RECORD; v_mime TEXT; v_size BIGINT; v_width INTEGER; v_height INTEGER; v_result public.training_signature_results; v_now TIMESTAMPTZ:=clock_timestamp();
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
  v_evidence:=public.training_signature_evidence_internal(v_req,v_auth); v_digest:=public.training_signature_digest_internal(v_evidence);
  IF v_digest<>v_challenge.evidence_digest THEN RAISE EXCEPTION '[D15:signature_evidence_changed] 证据已变化，请重新确认'; END IF;
  SELECT o.* INTO v_object FROM storage.objects o WHERE o.bucket_id=v_challenge.storage_bucket AND o.name=v_challenge.storage_path;
  IF NOT FOUND THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 未找到本 challenge 的签字图片'; END IF;
  IF COALESCE(v_object.owner_id,v_object.owner::text)<>auth.uid()::text THEN RAISE EXCEPTION '[D15:signature_file_mismatch] 签字图片不属于当前签字人'; END IF;
  v_mime:=lower(COALESCE(v_object.metadata->>'mimetype',v_object.metadata->>'contentType',''));
  v_size:=COALESCE((v_object.metadata->>'size')::bigint,0);
  v_width:=COALESCE((v_object.user_metadata->>'width')::integer,0); v_height:=COALESCE((v_object.user_metadata->>'height')::integer,0);
  IF v_mime NOT IN('image/png','image/jpeg') OR v_size NOT BETWEEN 1 AND 2097152 OR v_width NOT BETWEEN 64 AND 4096 OR v_height NOT BETWEEN 32 AND 4096
    OR lower(v_challenge.storage_path) !~ '\.(png|jpe?g)$' THEN RAISE EXCEPTION '[D15:signature_file_invalid] 签字图片格式、大小或尺寸无效'; END IF;
  INSERT INTO public.training_signature_results(requirement_id,challenge_id,signer_subject_id,signer_auth_user_id,signer_role_snapshot,signer_scope_snapshot,
    signer_display_snapshot,storage_bucket,storage_path,mime_type,file_size_bytes,image_width,image_height,evidence_digest,evidence_snapshot,signed_at,idempotency_key,device_snapshot)
  VALUES(v_req.id,v_challenge.id,v_challenge.signer_subject_id,auth.uid(),v_auth->>'role',v_auth->'scope',v_evidence->'signer'->'display',v_challenge.storage_bucket,
    v_challenge.storage_path,v_mime,v_size,v_width,v_height,v_digest,v_evidence,v_now,btrim(p_idempotency_key),COALESCE(p_device,'{}'::jsonb)) RETURNING * INTO v_result;
  PERFORM set_config('app.training_signature_mutation','on',TRUE);
  UPDATE public.training_signature_requirements SET status='signed',resolved_at=v_now,status_reason='signed' WHERE id=v_req.id;
  UPDATE public.training_signature_challenges SET used_at=v_now WHERE id=v_challenge.id;
  INSERT INTO public.training_signature_requirement_events(requirement_id,event_type,actor_subject_id,reason,detail)
    VALUES(v_req.id,'signed',v_result.signer_subject_id,'signed',jsonb_build_object('result_id',v_result.id,'evidence_digest',v_digest,'signer_role',v_result.signer_role_snapshot));
  RETURN jsonb_build_object('status','signed','reason_code','signature_completed','idempotent',FALSE,'result_id',v_result.id,'signed_at',v_result.signed_at,'evidence_digest',v_digest);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.training_signature_results WHERE requirement_id=v_req.id OR (signer_subject_id=(v_auth->>'subject_id')::uuid AND idempotency_key=btrim(p_idempotency_key)) ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('status','signed','reason_code','signature_already_completed','idempotent',TRUE,'result_id',v_existing.id,'signed_at',v_existing.signed_at,'evidence_digest',v_existing.evidence_digest); END IF;
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage;
COMMIT;

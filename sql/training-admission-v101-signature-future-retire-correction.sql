-- D15 forward correction: retiring a future policy version keeps a valid date range.
BEGIN;
CREATE OR REPLACE FUNCTION public.training_signature_policy_retire(p_policy_version_id UUID,p_reason TEXT,p_request_id TEXT DEFAULT NULL) RETURNS JSONB AS $$
DECLARE v public.training_signature_policy_versions;
BEGIN
  PERFORM public.training_signature_require_company_admin();
  SELECT * INTO v FROM public.training_signature_policy_versions WHERE id=p_policy_version_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'published' OR NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION '[D15:signature_policy_invalid] 只能停用已发布版本且必须填写原因'; END IF;
  PERFORM set_config('app.training_signature_policy_lifecycle','on',TRUE);
  UPDATE public.training_signature_policy_versions SET status='retired',effective_to=GREATEST(CURRENT_DATE,effective_from),retired_by=public.training_current_account_subject_id(),retired_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
  INSERT INTO public.training_signature_policy_audit_logs(policy_id,policy_version_id,action,operator_subject_id,operator_roles_snapshot,after_state,reason,request_id)
    VALUES(v.policy_id,v.id,'retire',public.training_current_account_subject_id(),public.training_account_roles(auth.uid()),to_jsonb(v),btrim(p_reason),NULLIF(btrim(p_request_id),''));
  RETURN to_jsonb(v);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
COMMIT;

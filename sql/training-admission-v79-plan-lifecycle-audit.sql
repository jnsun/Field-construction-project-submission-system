-- D09-3：送审、签发、批量签发、发布、撤回与版本事件统一留痕。
BEGIN;

ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS publication_note TEXT,
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS withdrawn_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS withdraw_reason TEXT;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_publish_status_check;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_publish_status_check
  CHECK (publish_status IN ('draft','published','withdrawn','closed'));

CREATE TABLE IF NOT EXISTS public.training_plan_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','signed','rejected','published','withdrawn','version_cloned')),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT,
  version_no INT NOT NULL,
  version_summary JSONB NOT NULL,
  batch_id UUID
);
CREATE INDEX IF NOT EXISTS idx_training_plan_events_plan ON public.training_plan_events(plan_id,occurred_at);
ALTER TABLE public.training_plan_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS training_plan_events_select ON public.training_plan_events;
CREATE POLICY training_plan_events_select ON public.training_plan_events FOR SELECT TO authenticated
  USING (public.training_plan_admin_can_read(plan_id) OR plan_id IN (SELECT public.training_my_plan_ids()));
REVOKE ALL ON TABLE public.training_plan_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.training_plan_events TO authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_version_summary(p_plan_id UUID)
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'plan_id',p.id,'title',p.title,'version_no',p.version_no,'level',p.level,
    'department_id',p.department_id,'site_project_id',p.site_project_id,'special_type',p.special_type,
    'hours',p.hours,'required_hours',p.required_hours,
    'course_count',(SELECT count(*) FROM public.training_courses c WHERE c.plan_id=p.id)
  ) FROM public.training_plans p WHERE p.id=p_plan_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_plan_version_summary(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_can_approve(p_plan_id UUID)
RETURNS BOOLEAN AS $$ SELECT public.training_plan_admin_can_read(p_plan_id); $$
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_plan_can_approve(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.training_plan_can_approve(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_plan_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF public.training_plan_is_locked(OLD.id) THEN RAISE EXCEPTION '已送审、签发、发布或形成培训历史的计划不可删除，请新建版本'; END IF;
    RETURN OLD;
  END IF;
  IF current_setting('app.training_lifecycle_write',TRUE)='D09_CONTROLLED' THEN RETURN NEW; END IF;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status OR NEW.approval_note IS DISTINCT FROM OLD.approval_note
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.publish_status IS DISTINCT FROM OLD.publish_status OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by IS DISTINCT FROM OLD.published_by OR NEW.publication_note IS DISTINCT FROM OLD.publication_note
     OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by
     OR NEW.withdraw_reason IS DISTINCT FROM OLD.withdraw_reason THEN
    RAISE EXCEPTION '审批、发布和撤回字段只能通过受控流程修改';
  END IF;
  IF public.training_plan_is_locked(OLD.id) THEN RAISE EXCEPTION '已送审、签发、发布或形成培训历史的计划不可直接修改，请新建版本'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_request_plan_approval(p_plan_id UUID)
RETURNS VOID AS $$
DECLARE v public.training_plans%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v.publish_status<>'draft' OR v.approval_status NOT IN ('draft','rejected') THEN RAISE EXCEPTION '只有草稿或被驳回计划可以送审'; END IF;
  IF NOT public.training_plan_row_can_write(v.level,v.department_id,v.site_project_id) THEN RAISE EXCEPTION '您无权送审该培训计划'; END IF;
  IF v.hours IS NULL OR v.required_hours IS NULL THEN RAISE EXCEPTION '送审前必须填写计划学时和要求学时'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.training_courses WHERE plan_id=p_plan_id) THEN RAISE EXCEPTION '请至少添加一份课件后再送审'; END IF;
  PERFORM set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
  UPDATE public.training_plans SET approval_status='pending_review',submitted_at=now(),submitted_by=auth.uid(),approved_at=NULL,approved_by=NULL,approval_note=NULL WHERE id=p_plan_id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(p_plan_id,'submitted',auth.uid(),NULL,v.version_no,public.training_plan_version_summary(p_plan_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_approve_plan(p_plan_id UUID,p_approved BOOLEAN,p_note TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE v public.training_plans%ROWTYPE; v_note TEXT:=NULLIF(btrim(p_note),'');
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v.approval_status<>'pending_review' THEN RAISE EXCEPTION '只有待审核计划可以签发或驳回'; END IF;
  IF NOT public.training_plan_can_approve(p_plan_id) THEN RAISE EXCEPTION '您无权签发该层级培训计划'; END IF;
  IF v_note IS NULL THEN RAISE EXCEPTION '签发或驳回必须填写意见'; END IF;
  PERFORM set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
  UPDATE public.training_plans SET approval_status=CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
    approval_note=v_note,approved_at=CASE WHEN p_approved THEN now() ELSE NULL END,
    approved_by=CASE WHEN p_approved THEN auth.uid() ELSE NULL END WHERE id=p_plan_id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(p_plan_id,CASE WHEN p_approved THEN 'signed' ELSE 'rejected' END,auth.uid(),v_note,v.version_no,public.training_plan_version_summary(p_plan_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_batch_approve_plans(p_items JSONB)
RETURNS JSONB AS $$
DECLARE item JSONB; v_id UUID; v_note TEXT; v_batch UUID:=gen_random_uuid(); v_results JSONB:='[]';
BEGIN
  IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items)=0 THEN RAISE EXCEPTION '批量签发明细不能为空'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_id:=(item->>'plan_id')::UUID; v_note:=NULLIF(btrim(item->>'note'),'');
    IF v_note IS NULL THEN RAISE EXCEPTION '每个批量签发项都必须填写意见'; END IF;
    PERFORM public.training_approve_plan(v_id,TRUE,v_note);
    UPDATE public.training_plan_events SET batch_id=v_batch WHERE id=(SELECT id FROM public.training_plan_events WHERE plan_id=v_id AND event_type='signed' ORDER BY occurred_at DESC LIMIT 1);
    v_results:=v_results||jsonb_build_array(jsonb_build_object('plan_id',v_id,'status','signed','note',v_note));
  END LOOP;
  RETURN jsonb_build_object('batch_id',v_batch,'results',v_results);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_publish_plan(p_plan_id UUID,p_note TEXT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE v public.training_plans%ROWTYPE; v_count INT:=0; v_record UUID; v_note TEXT:=NULLIF(btrim(p_note),'');
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF NOT public.training_plan_row_can_write(v.level,v.department_id,v.site_project_id) THEN RAISE EXCEPTION '无权限发布该计划'; END IF;
  IF v.approval_status<>'approved' OR v.publish_status<>'draft' THEN RAISE EXCEPTION '只有已签发草稿可以发布'; END IF;
  IF v_note IS NULL THEN RAISE EXCEPTION '发布必须填写说明'; END IF;
  IF v.level='special' THEN
    v_count:=0;
  ELSIF v.level='project' THEN
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
      SELECT v.id,m.employee_id,e.user_id,e.department_id FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id
      WHERE m.project_id=v.site_project_id AND m.status='active' AND e.status='active' ON CONFLICT(plan_id,employee_id) DO NOTHING;
    GET DIAGNOSTICS v_count=ROW_COUNT;
  ELSE
    WITH RECURSIVE seed(id) AS (
      SELECT department_id FROM public.training_plan_targets WHERE plan_id=v.id
      UNION SELECT v.department_id WHERE v.level='entity' AND NOT EXISTS(SELECT 1 FROM public.training_plan_targets WHERE plan_id=v.id)
      UNION ALL SELECT d.id FROM public.departments d JOIN seed s ON d.parent_id=s.id
    )
    INSERT INTO public.training_assignments(plan_id,employee_id,user_id,department_id)
      SELECT v.id,e.id,e.user_id,e.department_id FROM public.training_employees e
      WHERE e.status='active' AND (v.level='company' AND NOT EXISTS(SELECT 1 FROM public.training_plan_targets WHERE plan_id=v.id) OR e.department_id IN(SELECT id FROM seed WHERE id IS NOT NULL))
      ON CONFLICT(plan_id,employee_id) DO NOTHING;
    GET DIAGNOSTICS v_count=ROW_COUNT;
  END IF;
  INSERT INTO public.training_records(plan_id,title,train_date,hours,trainer,location,department_id,content,source)
    VALUES(v.id,v.title,COALESCE(v.start_date,CURRENT_DATE),v.required_hours,v.trainer,v.location,v.department_id,v.content,'auto') RETURNING id INTO v_record;
  PERFORM set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
  UPDATE public.training_plans SET publish_status='published',published_at=now(),published_by=auth.uid(),publication_note=v_note WHERE id=v.id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(v.id,'published',auth.uid(),v_note,v.version_no,public.training_plan_version_summary(v.id));
  RETURN jsonb_build_object('success',TRUE,'assigned',v_count,'record_id',v_record,'version_summary',public.training_plan_version_summary(v.id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_withdraw_plan(p_plan_id UUID,p_reason TEXT)
RETURNS JSONB AS $$
DECLARE v public.training_plans%ROWTYPE; v_reason TEXT:=NULLIF(btrim(p_reason),'');
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION '撤回必须填写原因'; END IF;
  IF NOT public.training_plan_row_can_write(v.level,v.department_id,v.site_project_id) THEN RAISE EXCEPTION '您无权撤回该计划'; END IF;
  IF v.approval_status NOT IN ('pending_review','approved') AND v.publish_status<>'published' THEN RAISE EXCEPTION '当前状态不允许撤回'; END IF;
  PERFORM set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
  UPDATE public.training_plans SET
    approval_status=CASE WHEN v.publish_status='published' THEN approval_status ELSE 'draft' END,
    publish_status=CASE WHEN v.publish_status='published' THEN 'withdrawn' ELSE 'draft' END,
    withdrawn_at=now(),withdrawn_by=auth.uid(),withdraw_reason=v_reason WHERE id=v.id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(v.id,'withdrawn',auth.uid(),v_reason,v.version_no,public.training_plan_version_summary(v.id));
  RETURN jsonb_build_object('plan_id',v.id,'previous_approval_status',v.approval_status,'previous_publish_status',v.publish_status,'status','withdrawn');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_clone_plan_version(p_plan_id UUID)
RETURNS UUID AS $$
DECLARE v public.training_plans%ROWTYPE; v_new UUID; v_version INT;
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF NOT public.training_plan_row_can_write(v.level,v.department_id,v.site_project_id) THEN RAISE EXCEPTION '您无权复制该培训计划版本'; END IF;
  SELECT COALESCE(max(version_no),0)+1 INTO v_version FROM public.training_plans WHERE id=p_plan_id OR supersedes_plan_id=p_plan_id;
  INSERT INTO public.training_plans(title,category,level,department_id,site_project_id,special_type,parent_plan_id,plan_year,hours,trainer,location,target_desc,content,require_exam,status,remark,required_hours,publish_status,exam_mode,approval_status,created_by,version_no,supersedes_plan_id)
    VALUES(v.title||'（v'||v_version||'）',v.category,v.level,v.department_id,v.site_project_id,v.special_type,v.parent_plan_id,EXTRACT(YEAR FROM CURRENT_DATE)::INT,v.hours,v.trainer,v.location,v.target_desc,v.content,v.require_exam,'planned',v.remark,v.required_hours,'draft',v.exam_mode,'draft',auth.uid(),v_version,p_plan_id) RETURNING id INTO v_new;
  INSERT INTO public.training_plan_targets(plan_id,department_id,due_date) SELECT v_new,department_id,NULL FROM public.training_plan_targets WHERE plan_id=p_plan_id;
  INSERT INTO public.training_courses(plan_id,title,course_type,file_path,file_url,content,page_count,duration_sec,required,sort_order,library_id)
    SELECT v_new,title,course_type,file_path,file_url,content,page_count,duration_sec,required,sort_order,library_id FROM public.training_courses WHERE plan_id=p_plan_id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(v_new,'version_cloned',auth.uid(),'由版本 v'||v.version_no||' 创建',v_version,public.training_plan_version_summary(v_new));
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS public.training_publish_plan(UUID);
DROP FUNCTION IF EXISTS public.training_batch_approve_plans(UUID[]);
REVOKE ALL ON FUNCTION public.training_batch_approve_plans(JSONB),public.training_publish_plan(UUID,TEXT),public.training_withdraw_plan(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_request_plan_approval(UUID),public.training_approve_plan(UUID,BOOLEAN,TEXT),public.training_batch_approve_plans(JSONB),public.training_publish_plan(UUID,TEXT),public.training_withdraw_plan(UUID,TEXT),public.training_clone_plan_version(UUID) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;

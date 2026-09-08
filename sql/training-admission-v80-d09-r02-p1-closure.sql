-- D09 R02：关闭项目范围、审批/Storage、有效学时与版本 lineage 四个 P1。
BEGIN;

-- read / manage / approve 使用独立能力；项目能力复用 D07 权威函数。
CREATE OR REPLACE FUNCTION public.training_plan_scope_can_read(
  p_level TEXT, p_department_id UUID, p_site_project_id UUID
) RETURNS BOOLEAN AS $$
  SELECT CASE p_level
    WHEN 'company' THEN public.training_is_company_admin()
    WHEN 'entity' THEN public.is_admin() AND p_department_id IS NOT NULL
                       AND public.training_can_read(p_department_id)
    WHEN 'project' THEN p_site_project_id IS NOT NULL
                        AND public.site_project_can_read(p_site_project_id)
    WHEN 'special' THEN CASE WHEN p_site_project_id IS NOT NULL
      THEN public.site_project_can_read(p_site_project_id)
      ELSE public.is_admin() AND p_department_id IS NOT NULL
           AND public.training_can_read(p_department_id) END
    ELSE FALSE
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_plan_row_can_write(
  p_level TEXT, p_department_id UUID, p_site_project_id UUID
) RETURNS BOOLEAN AS $$
  SELECT CASE p_level
    WHEN 'company' THEN p_department_id IS NULL AND p_site_project_id IS NULL
                        AND public.training_is_company_admin()
    WHEN 'entity' THEN p_department_id IS NOT NULL AND p_site_project_id IS NULL
                       AND public.is_admin() AND public.training_can_write(p_department_id)
    WHEN 'project' THEN p_department_id IS NULL AND p_site_project_id IS NOT NULL
                        AND public.site_project_can_manage(p_site_project_id)
    WHEN 'special' THEN (p_department_id IS NOT NULL AND p_site_project_id IS NULL
                          AND public.is_admin() AND public.training_can_write(p_department_id))
                     OR (p_department_id IS NULL AND p_site_project_id IS NOT NULL
                          AND public.site_project_can_manage(p_site_project_id))
    ELSE FALSE
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_plan_can_manage(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id=p_plan_id
      AND public.training_plan_row_can_write(p.level,p.department_id,p.site_project_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_learner_can_read_plan(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.training_plans p
    JOIN public.training_assignments a ON a.plan_id=p.id
    WHERE p.id=p_plan_id AND p.publish_status='published'
      AND (a.user_id=auth.uid() OR a.employee_id=public.training_my_employee_id())
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_plan_admin_can_read(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.training_plans p
    WHERE p.id=p_plan_id
      AND public.training_plan_scope_can_read(p.level,p.department_id,p.site_project_id)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.training_plan_can_approve(p_plan_id UUID)
RETURNS BOOLEAN AS $$ SELECT public.training_plan_can_manage(p_plan_id); $$
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.training_plan_scope_can_read(TEXT,UUID,UUID),
  public.training_plan_row_can_write(TEXT,UUID,UUID),public.training_plan_can_manage(UUID),
  public.training_learner_can_read_plan(UUID),public.training_plan_admin_can_read(UUID),
  public.training_plan_can_approve(UUID)
FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_plan_scope_can_read(TEXT,UUID,UUID),
  public.training_plan_row_can_write(TEXT,UUID,UUID),public.training_plan_can_manage(UUID),
  public.training_learner_can_read_plan(UUID),public.training_plan_admin_can_read(UUID),
  public.training_plan_can_approve(UUID)
TO authenticated;

DROP POLICY IF EXISTS tr_plan_select ON public.training_plans;
CREATE POLICY tr_plan_select ON public.training_plans FOR SELECT TO authenticated USING (
  public.training_plan_scope_can_read(level,department_id,site_project_id)
  OR public.training_learner_can_read_plan(id)
);

DROP POLICY IF EXISTS tr_plan_insert ON public.training_plans;
CREATE POLICY tr_plan_insert ON public.training_plans FOR INSERT TO authenticated
  WITH CHECK (public.training_plan_row_can_write(level,department_id,site_project_id));
DROP POLICY IF EXISTS tr_plan_update ON public.training_plans;
CREATE POLICY tr_plan_update ON public.training_plans FOR UPDATE TO authenticated
  USING (public.training_plan_row_can_write(level,department_id,site_project_id))
  WITH CHECK (public.training_plan_row_can_write(level,department_id,site_project_id));
DROP POLICY IF EXISTS tr_plan_delete ON public.training_plans;
CREATE POLICY tr_plan_delete ON public.training_plans FOR DELETE TO authenticated
  USING (public.training_plan_row_can_write(level,department_id,site_project_id));

-- 管理员/项目角色按计划读取；学员只读已发布且已分配的课件。
CREATE OR REPLACE FUNCTION public.training_can_read_course(p_plan_id UUID)
RETURNS BOOLEAN AS $$
  SELECT public.training_plan_admin_can_read(p_plan_id)
      OR public.training_learner_can_read_plan(p_plan_id);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_can_read_course(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_can_read_course(UUID) TO authenticated;

DROP POLICY IF EXISTS tr_course_write ON public.training_courses;
DROP POLICY IF EXISTS tr_course_insert ON public.training_courses;
DROP POLICY IF EXISTS tr_course_update ON public.training_courses;
DROP POLICY IF EXISTS tr_course_delete ON public.training_courses;
CREATE POLICY tr_course_insert ON public.training_courses FOR INSERT TO authenticated
  WITH CHECK (public.training_plan_can_manage(plan_id));
CREATE POLICY tr_course_update ON public.training_courses FOR UPDATE TO authenticated
  USING (public.training_plan_can_manage(plan_id))
  WITH CHECK (public.training_plan_can_manage(plan_id));
CREATE POLICY tr_course_delete ON public.training_courses FOR DELETE TO authenticated
  USING (public.training_plan_can_manage(plan_id));

CREATE OR REPLACE FUNCTION public.training_library_can_manage(p_library_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.training_library l WHERE l.id=p_library_id
      AND public.is_admin()
      AND ((l.scope='company' AND public.training_is_company_admin())
        OR (l.department_id IS NOT NULL AND public.training_can_write(l.department_id)))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_library_can_manage(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_library_can_manage(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.training_course_file_can_manage(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT NOT public.training_course_file_is_locked(p_storage_path) AND (
    public.training_course_file_owned_unlinked(p_storage_path)
    OR EXISTS (SELECT 1 FROM public.training_courses c WHERE c.file_path=p_storage_path
      AND public.training_plan_can_manage(c.plan_id))
    OR EXISTS (SELECT 1 FROM public.training_library l WHERE l.storage_path=p_storage_path
      AND public.training_library_can_manage(l.id))
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_course_file_can_manage(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_manage(TEXT) TO authenticated;

-- 项目角色上传路径以 plan UUID 开头；既有管理员临时上传保持兼容。
CREATE OR REPLACE FUNCTION public.training_course_file_can_write(p_storage_path TEXT)
RETURNS BOOLEAN AS $$
  SELECT public.is_admin()
      OR (CASE WHEN (storage.foldername(p_storage_path))[1]
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN public.training_plan_can_manage(((storage.foldername(p_storage_path))[1])::UUID)
        ELSE FALSE END)
      OR ((storage.foldername(p_storage_path))[1]='signatures' AND EXISTS (
        SELECT 1 FROM public.training_assignments a
        WHERE a.id::TEXT=split_part(storage.filename(p_storage_path),'_',1)
          AND (a.user_id=auth.uid() OR a.employee_id=public.training_my_employee_id())
      ));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_course_file_can_write(TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_course_file_can_write(TEXT) TO authenticated;

-- 学习进度只能写入仍处于 published 的计划。
CREATE OR REPLACE FUNCTION public.training_save_course_progress(
  p_course_id UUID,p_progress NUMERIC,p_position NUMERIC
) RETURNS JSONB AS $$
DECLARE
  v_emp UUID; v_asg public.training_assignments%ROWTYPE; v_plan_id UUID;
  v_finished BOOLEAN; v_prog NUMERIC; v_total INT:=0; v_done INT:=0;
  v_avg NUMERIC:=0; v_all_done BOOLEAN:=FALSE; v_record_id UUID;
  v_hours NUMERIC; v_exam_mode TEXT;
BEGIN
  v_emp:=public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案，请联系管理员'; END IF;
  SELECT a.* INTO v_asg FROM public.training_assignments a
  JOIN public.training_courses c ON c.id=p_course_id AND c.plan_id=a.plan_id
  JOIN public.training_plans p ON p.id=a.plan_id AND p.publish_status='published'
  WHERE a.employee_id=v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划未发布、已撤回或您不在参训范围内'; END IF;
  v_plan_id:=v_asg.plan_id;
  v_prog:=LEAST(GREATEST(COALESCE(p_progress,0),0),100);
  v_finished:=v_prog>=90;
  INSERT INTO public.training_course_progress(
    assignment_id,course_id,employee_id,progress,max_position,finished,finished_at
  ) VALUES(v_asg.id,p_course_id,v_emp,v_prog,COALESCE(p_position,0),v_finished,
    CASE WHEN v_finished THEN now() END)
  ON CONFLICT(course_id,employee_id) DO UPDATE SET
    progress=GREATEST(public.training_course_progress.progress,v_prog),
    max_position=GREATEST(public.training_course_progress.max_position,COALESCE(p_position,0)),
    finished=public.training_course_progress.finished OR v_finished,
    finished_at=COALESCE(public.training_course_progress.finished_at,CASE WHEN v_finished THEN now() END),
    updated_at=now();
  SELECT count(*),count(*) FILTER(WHERE cp.finished),COALESCE(avg(COALESCE(cp.progress,0)),0)
    INTO v_total,v_done,v_avg FROM public.training_courses c
    LEFT JOIN public.training_course_progress cp ON cp.course_id=c.id AND cp.employee_id=v_emp
    WHERE c.plan_id=v_plan_id AND c.required;
  v_all_done:=(v_total>0 AND v_done=v_total);
  SELECT required_hours,COALESCE(exam_mode,'none') INTO v_hours,v_exam_mode
    FROM public.training_plans WHERE id=v_plan_id;
  UPDATE public.training_assignments SET
    status=CASE WHEN v_all_done AND v_exam_mode='none' THEN 'completed'
                WHEN v_avg>0 THEN 'learning' ELSE status END,
    exam_status=CASE WHEN v_all_done AND v_exam_mode='auto' AND exam_status='none'
                     THEN 'pending' ELSE exam_status END,
    progress=v_avg,
    completed_at=CASE WHEN v_all_done AND v_exam_mode='none' THEN COALESCE(completed_at,now()) ELSE completed_at END,
    hours_earned=CASE WHEN v_all_done AND v_exam_mode='none' THEN COALESCE(v_hours,hours_earned) ELSE hours_earned END,
    updated_at=now() WHERE id=v_asg.id;
  IF v_all_done AND v_exam_mode='none' THEN
    SELECT id INTO v_record_id FROM public.training_records
      WHERE plan_id=v_plan_id AND source='auto' LIMIT 1;
    IF v_record_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.training_participants WHERE record_id=v_record_id AND employee_id=v_emp
    ) THEN
      INSERT INTO public.training_participants(record_id,employee_id,employee_name,department_id,signed,result)
        SELECT v_record_id,e.id,e.name,e.department_id,TRUE,'pass'
        FROM public.training_employees e WHERE e.id=v_emp;
      UPDATE public.training_records SET participant_count=(
        SELECT count(*) FROM public.training_participants WHERE record_id=v_record_id
      ) WHERE id=v_record_id;
    END IF;
  END IF;
  RETURN jsonb_build_object('progress',round(v_avg,1),'total',v_total,'done',v_done,'completed',v_all_done);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_save_course_progress(UUID,NUMERIC,NUMERIC) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_save_course_progress(UUID,NUMERIC,NUMERIC) TO authenticated;

-- 首次心跳只建会话；后续锁行并只按真实服务器间隔计时。
CREATE OR REPLACE FUNCTION public.training_course_heartbeat(
  p_session_id UUID,p_course_id UUID,p_delta_sec INT,
  p_position NUMERIC DEFAULT NULL,p_progress NUMERIC DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_emp UUID; v_log public.training_study_logs%ROWTYPE; v_sid UUID:=p_session_id;
  v_gap NUMERIC:=0; v_credit INT:=0; v_saved JSONB; v_now_sec INT:=0;
  v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  v_emp:=public.training_my_employee_id();
  IF v_emp IS NULL THEN RAISE EXCEPTION '当前账号未绑定员工档案，请联系管理员'; END IF;
  IF p_delta_sec IS NULL OR p_delta_sec<=0 OR p_delta_sec>60 THEN RAISE EXCEPTION '心跳参数非法'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.training_assignments a
    JOIN public.training_courses c ON c.id=p_course_id AND c.plan_id=a.plan_id
    JOIN public.training_plans p ON p.id=a.plan_id AND p.publish_status='published'
    WHERE a.employee_id=v_emp
  ) THEN RAISE EXCEPTION '培训计划未发布、已撤回或您不在参训范围内'; END IF;

  IF v_sid IS NULL THEN
    INSERT INTO public.training_study_logs(id,employee_id,course_id,last_beat_at)
      VALUES(gen_random_uuid(),v_emp,p_course_id,v_now) RETURNING * INTO v_log;
    v_sid:=v_log.id;
  ELSE
    SELECT * INTO v_log FROM public.training_study_logs WHERE id=v_sid FOR UPDATE;
    IF NOT FOUND OR v_log.employee_id<>v_emp OR v_log.course_id<>p_course_id THEN
      RAISE EXCEPTION '学习会话无效或不属于当前账号和课件';
    END IF;
    IF v_log.closed THEN RAISE EXCEPTION '学习会话已关闭'; END IF;
    IF v_log.last_beat_at IS NULL OR v_log.last_beat_at<v_now-interval '5 minutes' THEN
      UPDATE public.training_study_logs SET closed=TRUE WHERE id=v_sid;
      INSERT INTO public.training_study_logs(id,employee_id,course_id,last_beat_at)
        VALUES(gen_random_uuid(),v_emp,p_course_id,v_now) RETURNING * INTO v_log;
      v_sid:=v_log.id;
    ELSE
      v_gap:=GREATEST(EXTRACT(EPOCH FROM (v_now-v_log.last_beat_at)),0);
      v_credit:=LEAST(p_delta_sec,FLOOR(v_gap)::INT,60);
      UPDATE public.training_study_logs SET
        beats=beats+CASE WHEN v_credit>0 THEN 1 ELSE 0 END,
        effective_sec=effective_sec+v_credit,last_beat_at=v_now
      WHERE id=v_sid RETURNING effective_sec INTO v_now_sec;
    END IF;
  END IF;
  IF p_progress IS NOT NULL THEN
    v_saved:=public.training_save_course_progress(p_course_id,p_progress,COALESCE(p_position,0));
  END IF;
  IF v_now_sec=0 THEN SELECT effective_sec INTO v_now_sec FROM public.training_study_logs WHERE id=v_sid; END IF;
  RETURN jsonb_build_object('session_id',v_sid,'counted',v_credit>0,
    'credited_seconds',v_credit,'effective_sec',v_now_sec,
    'progress',v_saved->'progress','completed',v_saved->'completed');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_course_heartbeat(UUID,UUID,INT,NUMERIC,NUMERIC) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_course_heartbeat(UUID,UUID,INT,NUMERIC,NUMERIC) TO authenticated;

-- 稳定版本根：先检查旧链，再沿完整祖先链回填，绝不静默重编号。
ALTER TABLE public.training_plans
  ADD COLUMN IF NOT EXISTS version_root_id UUID REFERENCES public.training_plans(id) ON DELETE RESTRICT;

DO $$
DECLARE v_start UUID; v_current UUID; v_parent UUID; v_root UUID; v_seen UUID[];
BEGIN
  PERFORM set_config('app.training_lifecycle_write','D09_CONTROLLED',TRUE);
  FOR v_start IN SELECT id FROM public.training_plans LOOP
    v_current:=v_start; v_seen:=ARRAY[]::UUID[];
    LOOP
      IF v_current=ANY(v_seen) THEN RAISE EXCEPTION '培训计划版本链存在环，v80 已停止且未改写历史'; END IF;
      v_seen:=array_append(v_seen,v_current);
      SELECT supersedes_plan_id INTO v_parent FROM public.training_plans WHERE id=v_current;
      IF v_parent IS NULL THEN v_root:=v_current; EXIT; END IF;
      v_current:=v_parent;
    END LOOP;
    UPDATE public.training_plans SET version_root_id=v_root
    WHERE id=v_start AND version_root_id IS DISTINCT FROM v_root;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.training_plans GROUP BY version_root_id,version_no HAVING count(*)>1) THEN
    RAISE EXCEPTION '同一培训计划版本链存在重复版本号，v80 已停止且未重编号历史';
  END IF;
  PERFORM set_config('app.training_lifecycle_write','',TRUE);
END $$;

ALTER TABLE public.training_plans ALTER COLUMN version_root_id SET NOT NULL;
ALTER TABLE public.training_plans DROP CONSTRAINT IF EXISTS training_plans_version_root_version_key;
ALTER TABLE public.training_plans ADD CONSTRAINT training_plans_version_root_version_key
  UNIQUE(version_root_id,version_no);

CREATE OR REPLACE FUNCTION public.training_plan_version_identity_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.version_root_id,NEW.version_no,NEW.supersedes_plan_id)
     IS DISTINCT FROM (OLD.version_root_id,OLD.version_no,OLD.supersedes_plan_id) THEN
    RAISE EXCEPTION '计划版本根、版本号和前序版本不可直接修改';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.supersedes_plan_id IS NULL THEN
      IF NEW.version_no<>1 THEN RAISE EXCEPTION '新计划根版本号必须为 1'; END IF;
      IF NEW.version_root_id IS NULL THEN NEW.version_root_id:=NEW.id; END IF;
      IF NEW.version_root_id<>NEW.id THEN RAISE EXCEPTION '新计划根必须引用自身'; END IF;
    ELSIF current_setting('app.training_version_write',TRUE)<>'D09_CONTROLLED' THEN
      RAISE EXCEPTION '后续版本只能通过受控克隆流程创建';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_plan_version_identity_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS trg_training_plan_version_identity_guard ON public.training_plans;
CREATE TRIGGER trg_training_plan_version_identity_guard
  BEFORE INSERT OR UPDATE OF version_root_id,version_no,supersedes_plan_id ON public.training_plans
  FOR EACH ROW EXECUTE FUNCTION public.training_plan_version_identity_guard();

CREATE OR REPLACE FUNCTION public.training_plan_version_summary(p_plan_id UUID)
RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'plan_id',p.id,'version_root_id',p.version_root_id,'title',p.title,'version_no',p.version_no,
    'level',p.level,'department_id',p.department_id,'site_project_id',p.site_project_id,
    'special_type',p.special_type,'hours',p.hours,'required_hours',p.required_hours,
    'course_count',(SELECT count(*) FROM public.training_courses c WHERE c.plan_id=p.id)
  ) FROM public.training_plans p WHERE p.id=p_plan_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_plan_version_summary(UUID) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.training_clone_plan_version(p_plan_id UUID)
RETURNS UUID AS $$
DECLARE v public.training_plans%ROWTYPE; v_new UUID; v_root UUID; v_version INT;
BEGIN
  SELECT * INTO v FROM public.training_plans WHERE id=p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION '培训计划不存在'; END IF;
  IF NOT public.training_plan_can_manage(p_plan_id) THEN RAISE EXCEPTION '您无权复制该培训计划版本'; END IF;
  v_root:=v.version_root_id;
  PERFORM 1 FROM public.training_plans WHERE id=v_root FOR UPDATE;
  SELECT max(version_no)+1 INTO v_version FROM public.training_plans WHERE version_root_id=v_root;
  PERFORM set_config('app.training_version_write','D09_CONTROLLED',TRUE);
  INSERT INTO public.training_plans(
    title,category,level,department_id,site_project_id,special_type,parent_plan_id,plan_year,
    hours,trainer,location,target_desc,content,require_exam,status,remark,required_hours,
    publish_status,exam_mode,approval_status,created_by,version_no,supersedes_plan_id,version_root_id
  ) VALUES(v.title||'（v'||v_version||'）',v.category,v.level,v.department_id,v.site_project_id,
    v.special_type,v.parent_plan_id,EXTRACT(YEAR FROM CURRENT_DATE)::INT,v.hours,v.trainer,v.location,
    v.target_desc,v.content,v.require_exam,'planned',v.remark,v.required_hours,'draft',v.exam_mode,
    'draft',auth.uid(),v_version,p_plan_id,v_root) RETURNING id INTO v_new;
  INSERT INTO public.training_plan_targets(plan_id,department_id,due_date)
    SELECT v_new,department_id,NULL FROM public.training_plan_targets WHERE plan_id=p_plan_id;
  INSERT INTO public.training_courses(plan_id,title,course_type,file_path,file_url,content,page_count,duration_sec,required,sort_order,library_id)
    SELECT v_new,title,course_type,file_path,file_url,content,page_count,duration_sec,required,sort_order,library_id
    FROM public.training_courses WHERE plan_id=p_plan_id;
  INSERT INTO public.training_plan_events(plan_id,event_type,actor_id,note,version_no,version_summary)
    VALUES(v_new,'version_cloned',auth.uid(),'由版本 v'||v.version_no||' 创建',v_version,
      public.training_plan_version_summary(v_new));
  RETURN v_new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.training_clone_plan_version(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.training_clone_plan_version(UUID) TO authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;

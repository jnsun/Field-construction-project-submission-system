-- D07：数据库层强制每个项目最多 2 名有效项目经理。
-- 项目行事务锁让同一项目的角色写入串行执行，避免并发请求同时通过计数检查。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.site_project_roles r
    WHERE r.role = 'project_manager' AND r.active
    GROUP BY r.project_id
    HAVING count(*) > 2
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '已有项目存在超过 2 名有效项目经理，无法启用人数限制',
      CONSTRAINT = 'site_project_roles_max_two_active_project_managers';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.site_project_role_limit_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_current_id UUID;
  v_project_ids UUID[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_current_id := OLD.id;
    v_project_ids := ARRAY[OLD.project_id, NEW.project_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_project_ids := ARRAY[OLD.project_id];
  ELSE
    v_project_ids := ARRAY[NEW.project_id];
  END IF;

  -- 所有角色写入都锁定项目主记录；同一项目的并发事务只能逐个继续。
  PERFORM 1
  FROM public.site_projects p
  WHERE p.id = ANY(v_project_ids)
  ORDER BY p.id
  FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.site_project_roles r
    WHERE r.project_id = NEW.project_id
      AND r.user_id = NEW.user_id
      AND r.role = NEW.role
      AND (v_current_id IS NULL OR r.id <> v_current_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = '同一人员不能重复分配同一项目角色',
      CONSTRAINT = 'site_project_roles_project_id_user_id_role_key';
  END IF;

  IF NEW.role = 'project_manager' AND NEW.active AND (
    SELECT count(*)
    FROM public.site_project_roles r
    WHERE r.project_id = NEW.project_id
      AND r.role = 'project_manager'
      AND r.active
      AND (v_current_id IS NULL OR r.id <> v_current_id)
  ) >= 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '每个项目最多指定 2 名有效项目经理',
      CONSTRAINT = 'site_project_roles_max_two_active_project_managers';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_role_limit_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_site_project_role_limit_guard ON public.site_project_roles;
CREATE TRIGGER trg_site_project_role_limit_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.site_project_roles
  FOR EACH ROW EXECUTE FUNCTION public.site_project_role_limit_guard();

CREATE OR REPLACE FUNCTION public.site_project_set_roles(p_project_id UUID, p_roles JSONB)
RETURNS VOID AS $$
DECLARE
  v_roles JSONB := COALESCE(p_roles, '[]'::JSONB);
BEGIN
  IF NOT public.is_entity_manager()
     OR NOT EXISTS (
       SELECT 1
       FROM public.site_projects p
       WHERE p.id = p_project_id
         AND p.lead_entity_id = public.training_my_dept_id()
     ) THEN
    RAISE EXCEPTION '仅项目主责经营实体管理员可以任命项目角色';
  END IF;

  -- 与表触发器使用同一把项目锁，确保整组替换不会和其他角色写入交错。
  PERFORM 1 FROM public.site_projects p WHERE p.id = p_project_id FOR UPDATE;

  IF jsonb_typeof(v_roles) <> 'array' THEN
    RAISE EXCEPTION '项目角色参数格式不正确';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    WHERE COALESCE(r->>'role', '') NOT IN ('project_manager', 'safety_officer')
       OR NULLIF(r->>'user_id', '') IS NULL
       OR (r->>'user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION '项目角色仅支持项目经理和安全员，且必须指定有效账号';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    GROUP BY r->>'user_id', r->>'role'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = '同一人员不能重复分配同一项目角色',
      CONSTRAINT = 'site_project_roles_project_id_user_id_role_key';
  END IF;

  IF (SELECT count(*)
      FROM jsonb_array_elements(v_roles) r
      WHERE r->>'role' = 'project_manager') > 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '每个项目最多指定 2 名有效项目经理',
      CONSTRAINT = 'site_project_roles_max_two_active_project_managers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.profiles pr WHERE pr.id = (r->>'user_id')::UUID
    )
  ) THEN
    RAISE EXCEPTION '指定的项目角色账号不存在';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    JOIN public.profiles pr ON pr.id = (r->>'user_id')::UUID
    LEFT JOIN public.training_employees e ON e.id = pr.employee_id
    WHERE e.id IS NULL OR e.status <> 'active'
  ) THEN
    RAISE EXCEPTION '项目角色只能分配给已绑定档案的在职人员';
  END IF;

  IF EXISTS (
    WITH RECURSIVE allowed_departments(id) AS (
      SELECT p.lead_entity_id
      FROM public.site_projects p
      WHERE p.id = p_project_id
      UNION
      SELECT d.id
      FROM public.departments d
      JOIN allowed_departments parent ON d.parent_id = parent.id
    )
    SELECT 1
    FROM jsonb_array_elements(v_roles) r
    JOIN public.profiles pr ON pr.id = (r->>'user_id')::UUID
    JOIN public.training_employees e ON e.id = pr.employee_id
    WHERE e.department_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM allowed_departments allowed WHERE allowed.id = e.department_id
       )
  ) THEN
    RAISE EXCEPTION '不能跨经营实体分配项目角色';
  END IF;

  DELETE FROM public.site_project_roles WHERE project_id = p_project_id;
  INSERT INTO public.site_project_roles(project_id, user_id, role, active, assigned_by)
  SELECT p_project_id, (r->>'user_id')::UUID, r->>'role', TRUE, auth.uid()
  FROM jsonb_array_elements(v_roles) r;

  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, detail)
  VALUES (p_project_id, auth.uid(), 'set_roles', 'site_project_roles', jsonb_build_object('roles', v_roles));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_set_roles(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_set_roles(UUID, JSONB) TO authenticated;

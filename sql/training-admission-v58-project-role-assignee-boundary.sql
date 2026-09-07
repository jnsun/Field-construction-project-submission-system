-- D07：项目角色只能分配给项目经营实体范围内的在职人员。
-- 继续复用现有 site_project_set_roles RPC，避免页面校验被直接接口调用绕过。

CREATE OR REPLACE FUNCTION public.site_project_set_roles(p_project_id UUID, p_roles JSONB)
RETURNS VOID AS $$
DECLARE
  v_roles JSONB := COALESCE(p_roles, '[]'::JSONB);
BEGIN
  IF NOT public.site_project_can_admin(p_project_id) THEN
    RAISE EXCEPTION '仅主责经营实体管理员或公司管理员可以任命项目角色';
  END IF;

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

  IF (SELECT COUNT(DISTINCT r->>'user_id')
      FROM jsonb_array_elements(v_roles) r
      WHERE r->>'role' = 'project_manager') > 2 THEN
    RAISE EXCEPTION '每个项目最多指定 2 名项目经理';
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
  FROM (SELECT DISTINCT value AS r FROM jsonb_array_elements(v_roles)) x;

  INSERT INTO public.site_project_audit_logs(project_id, actor_id, action, entity_type, detail)
  VALUES (p_project_id, auth.uid(), 'set_roles', 'site_project_roles', jsonb_build_object('roles', v_roles));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_set_roles(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_set_roles(UUID, JSONB) TO authenticated;

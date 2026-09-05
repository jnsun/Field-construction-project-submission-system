-- D06：项目主体和初始参与经营实体在同一个受控 RPC 事务中创建。
BEGIN;

DROP FUNCTION IF EXISTS public.site_project_create(TEXT, TEXT, TEXT, DATE, DATE, UUID, TEXT);

CREATE FUNCTION public.site_project_create(
  p_name TEXT,
  p_project_type TEXT,
  p_location TEXT,
  p_start_date DATE,
  p_expected_end_date DATE,
  p_lead_entity_id UUID,
  p_report_notes TEXT DEFAULT NULL,
  p_entity_ids UUID[] DEFAULT NULL
) RETURNS public.site_projects AS $$
DECLARE
  v_project public.site_projects;
  v_entity_ids UUID[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION '请先登录'; END IF;
  IF NULLIF(btrim(p_name), '') IS NULL THEN RAISE EXCEPTION '项目名称不能为空'; END IF;
  IF p_start_date IS NOT NULL AND p_expected_end_date IS NOT NULL AND p_expected_end_date < p_start_date THEN
    RAISE EXCEPTION '预计完工日期不能早于开工日期';
  END IF;
  IF NOT public.training_is_company_admin() AND NOT public.training_can_write(p_lead_entity_id) THEN
    RAISE EXCEPTION '您无权在该经营实体下建立项目';
  END IF;

  v_entity_ids := ARRAY(
    SELECT DISTINCT entity_id
    FROM unnest(COALESCE(p_entity_ids, ARRAY[]::UUID[]) || ARRAY[p_lead_entity_id]) AS entity_id
    WHERE entity_id IS NOT NULL
  );

  IF NOT EXISTS (SELECT 1 FROM public.departments WHERE id = p_lead_entity_id AND dept_type = 'entity') THEN
    RAISE EXCEPTION '主责单位必须是经营实体';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(v_entity_ids) AS requested(entity_id)
    LEFT JOIN public.departments d ON d.id = requested.entity_id
    WHERE d.id IS NULL OR d.dept_type <> 'entity'
  ) THEN
    RAISE EXCEPTION '参与单位必须全部是经营实体';
  END IF;

  INSERT INTO public.site_projects(name, project_type, location, start_date, expected_end_date,
                                    lead_entity_id, report_notes, created_by)
  VALUES (btrim(p_name), NULLIF(btrim(p_project_type), ''), NULLIF(btrim(p_location), ''),
          p_start_date, p_expected_end_date, p_lead_entity_id, NULLIF(btrim(p_report_notes), ''), auth.uid())
  RETURNING * INTO v_project;

  INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
  SELECT v_project.id, entity_id, entity_id = p_lead_entity_id
  FROM unnest(v_entity_ids) AS entity_id;

  RETURN v_project;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.site_project_create(TEXT, TEXT, TEXT, DATE, DATE, UUID, TEXT, UUID[])
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_project_create(TEXT, TEXT, TEXT, DATE, DATE, UUID, TEXT, UUID[])
TO authenticated;

COMMIT;

-- P1-11: forward-correct databases that already recorded an earlier v90 scope definition.
BEGIN;

ALTER TABLE public.training_plans
  DROP CONSTRAINT IF EXISTS training_plans_scope_check;

ALTER TABLE public.training_plans
  ADD CONSTRAINT training_plans_scope_check CHECK(
    (level='company' AND department_id IS NULL AND site_project_id IS NULL AND special_type IS NULL)
    OR (level='entity' AND department_id IS NOT NULL AND site_project_id IS NULL AND special_type IS NULL)
    OR (level='project' AND special_type IS NULL AND (
      (training_category='project_induction' AND third_level_mode IS NULL AND department_id IS NULL AND site_project_id IS NOT NULL)
      OR (training_category='basic_three_level' AND third_level_mode='basic_project' AND department_id IS NOT NULL AND site_project_id IS NULL)
      OR (training_category='basic_three_level' AND third_level_mode='actual_project' AND department_id IS NULL AND site_project_id IS NOT NULL)
    ))
    OR (level='special' AND special_type IS NOT NULL AND btrim(special_type)<>'' AND ((department_id IS NOT NULL)<>(site_project_id IS NOT NULL)))
  ) NOT VALID;

COMMIT;

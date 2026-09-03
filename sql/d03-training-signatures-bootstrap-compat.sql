-- D03 empty-database compatibility bridge.
-- training-online-v2.sql configures Storage policies referencing this table,
-- while both prerequisites are created later in the normal feature sequence.
CREATE TABLE IF NOT EXISTS public.training_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.training_plans(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'learning', 'completed', 'overdue')),
  progress NUMERIC(5,1) NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ,
  hours_earned NUMERIC(5,1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, employee_id)
);

CREATE TABLE IF NOT EXISTS public.training_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID UNIQUE REFERENCES public.training_assignments(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.training_employees(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_info TEXT
);

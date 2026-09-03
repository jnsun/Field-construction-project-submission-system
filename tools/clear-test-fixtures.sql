BEGIN;
DO $$ BEGIN
  IF current_setting('app.safety_test_confirmation', true) <> 'D02_TEST_ONLY' THEN RAISE EXCEPTION 'Refusing cleanup without D02_TEST_ONLY confirmation.'; END IF;
END $$;
DELETE FROM public.training_employees e USING public.safety_test_fixture_registry r WHERE r.table_name='training_employees' AND r.record_id=e.id AND r.run_key='D02-TEST-20260903';
DELETE FROM public.safety_test_fixture_registry WHERE run_key='D02-TEST-20260903';
COMMIT;

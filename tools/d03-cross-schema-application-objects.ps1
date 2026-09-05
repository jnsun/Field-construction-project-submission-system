. (Join-Path $PSScriptRoot "d03-psql.ps1")

function Get-D03CanonicalAuthUserProfileTriggerSql {
  param([string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot))

  $schemaFile = Join-Path $RepositoryRoot 'sql\schema.sql'
  $schema = Get-Content -LiteralPath $schemaFile -Raw
  $pattern = '(?ms)^DROP TRIGGER IF EXISTS on_auth_user_created ON auth\.users;\r?\nCREATE TRIGGER on_auth_user_created\s+AFTER INSERT ON auth\.users\s+FOR EACH ROW EXECUTE FUNCTION public\.handle_new_user\(\);'
  $match = [regex]::Match($schema, $pattern)
  if (-not $match.Success) { throw 'The canonical auth.users profile trigger definition is missing from sql/schema.sql.' }
  return $match.Value
}

function Invoke-D03CrossSchemaSql {
  param([string]$DatabaseUrl, [string]$OutputDirectory, [string]$Label, [string]$Sql)

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $sqlFile = Join-Path $OutputDirectory "$Label.sql"
  Set-Content -LiteralPath $sqlFile -Encoding utf8 -Value $Sql
  $result = Invoke-D03PsqlChecked -DatabaseUrl $DatabaseUrl -Arguments @('-X', '-A', '-t', '-q', '-P', 'pager=off', '-f', $sqlFile) -OutputDirectory $OutputDirectory -Label $Label
  return [string]$result.stdout
}

function Assert-D03ApplicationCrossSchemaDependencies {
  param([string]$DatabaseUrl, [string]$OutputDirectory, [string]$Label)

  $rowsJson = Invoke-D03CrossSchemaSql -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label "$Label-cross-schema-dependencies" -Sql @'
SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.relation_schema, x.relation_name, x.trigger_name), '[]'::json)::text
FROM (
  SELECT n.nspname AS relation_schema, c.relname AS relation_name, t.tgname AS trigger_name,
         p.oid::regprocedure::text AS function_identity, t.tgenabled AS enabled
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND pn.nspname = 'public'
    AND n.nspname <> 'public'
) x;
'@
  $rowsText = [string]$rowsJson
  if ([string]::IsNullOrWhiteSpace($rowsText)) {
    throw 'Cross-schema dependency query returned no JSON payload.'
  }
  $rows = @($rowsText.Trim() | ConvertFrom-Json)
  if ($rows.Count -ne 1 -or $rows[0].relation_schema -ne 'auth' -or $rows[0].relation_name -ne 'users' -or $rows[0].trigger_name -ne 'on_auth_user_created' -or $rows[0].function_identity -ne 'handle_new_user()' -or $rows[0].enabled -ne 'O') {
    $actual = ($rows | ConvertTo-Json -Compress -Depth 4)
    throw "Unexpected cross-schema dependency on public application objects: $actual"
  }
  return $rows[0]
}

function Restore-D03ApplicationCrossSchemaObjects {
  param([string]$DatabaseUrl, [string]$OutputDirectory, [string]$Label, [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot))

  [void](Invoke-D03CrossSchemaSql -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label "$Label-cross-schema-precheck" -Sql @'
DO $$
BEGIN
  IF to_regprocedure('public.handle_new_user()') IS NULL THEN
    RAISE EXCEPTION 'public.handle_new_user() is missing before cross-schema trigger restore';
  END IF;
END $$;
'@)
  $triggerSql = Get-D03CanonicalAuthUserProfileTriggerSql -RepositoryRoot $RepositoryRoot
  [void](Invoke-D03CrossSchemaSql -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label "$Label-cross-schema-restore" -Sql $triggerSql)
  return Assert-D03ApplicationCrossSchemaDependencies -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label $Label
}

function Test-D03ApplicationCrossSchemaObjects {
  param([string]$DatabaseUrl, [string]$OutputDirectory, [string]$Label)

  $dependency = Assert-D03ApplicationCrossSchemaDependencies -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label "$Label-cross-schema-assert"
  [void](Invoke-D03CrossSchemaSql -DatabaseUrl $DatabaseUrl -OutputDirectory $OutputDirectory -Label "$Label-cross-schema-profile-probe" -Sql @'
BEGIN;
DO $$
DECLARE v_user_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change, email_change_token_new,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_user_id,
    'authenticated', 'authenticated', 'd03-cross-schema-probe@example.invalid',
    '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
    now(), '', '', '', '',
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'auth.users profile trigger did not create a profile';
  END IF;
END $$;
ROLLBACK;
'@)
  return [pscustomobject]@{
    relation_schema = $dependency.relation_schema
    relation_name = $dependency.relation_name
    trigger_name = $dependency.trigger_name
    function_identity = $dependency.function_identity
    enabled = $dependency.enabled
    trigger_count = 1
    anonymous_profile_probe = 'passed_and_rolled_back'
  }
}

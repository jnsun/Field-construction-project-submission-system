param(
  [string]$DatabaseUrl = $env:SAFETY_TEST_DB_URL,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9]{20}$')][string]$TestProjectRef,
  [Parameter(Mandatory = $true)][string]$TestConfirmation,
  [string]$EnvironmentName = $env:SAFETY_ENV,
  [string]$OutputDir = 'test-results/d03'
)

$ErrorActionPreference = 'Stop'

if ($TestConfirmation -ne 'D03_TEST_ONLY') { throw 'Refusing notification-settings RPC verification without D03_TEST_ONLY confirmation.' }
if ($EnvironmentName -ne 'test') { throw 'Notification-settings RPC verification requires SAFETY_ENV=test.' }
if ([string]::IsNullOrWhiteSpace($DatabaseUrl) -or $DatabaseUrl -match 'YOUR-|PASSWORD|<|>') { throw 'DatabaseUrl is missing or still contains a placeholder.' }

$psql = Get-Command psql -ErrorAction Stop
$uri = [uri]$DatabaseUrl
$separator = $uri.UserInfo.IndexOf(':')
if ($separator -lt 0) { throw 'DatabaseUrl does not contain database credentials.' }
if ($uri.AbsolutePath.Trim('/') -ne 'postgres' -or ($uri.Host -ne "db.${TestProjectRef}.supabase.co" -and $uri.Host -notmatch '(^|\.)pooler\.supabase\.com$')) {
  throw 'DatabaseUrl must target the dedicated Supabase test project or its pooler.'
}

$password = [uri]::UnescapeDataString($uri.UserInfo.Substring($separator + 1))
$safeUrl = "postgresql://postgres@db.${TestProjectRef}.supabase.co:5432/postgres?sslmode=require&connect_timeout=15"
$originalPgPassword = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
$originalPgClientEncoding = [Environment]::GetEnvironmentVariable('PGCLIENTENCODING', 'Process')
$env:PGPASSWORD = $password
$env:PGCLIENTENCODING = 'UTF8'
$runDir = Join-Path $OutputDir ('notification-settings-rpc-' + (Get-Date).ToString('yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

function Invoke-Check {
  param([string]$Label, [string]$Sql)

  $file = Join-Path $runDir "$Label.sql"
  $stdout = Join-Path $runDir "$Label.stdout.log"
  $stderr = Join-Path $runDir "$Label.stderr.log"
  Set-Content -LiteralPath $file -Encoding utf8 -Value $Sql
  & $psql.Source $safeUrl -X -A -t -q -P pager=off -v ON_ERROR_STOP=1 -f $file 1> $stdout 2> $stderr
  if ($LASTEXITCODE -ne 0) { throw "$Label failed; see its test-result logs." }
  return Get-Content -LiteralPath $stdout -Raw
}

try {
  $companyId = (& $psql.Source $safeUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT id FROM public.profiles WHERE lower(email) LIKE 'd02-company-%@example.invalid' ORDER BY id LIMIT 1;").Trim()
  $employeeId = (& $psql.Source $safeUrl -Atq -v ON_ERROR_STOP=1 -c "SELECT id FROM public.profiles WHERE lower(email) LIKE 'd02-employee-%@example.invalid' ORDER BY id LIMIT 1;").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($companyId) -or [string]::IsNullOrWhiteSpace($employeeId)) {
    throw 'Required D02 anonymous company and employee fixtures are unavailable.'
  }

  $metadata = Invoke-Check -Label 'metadata' -Sql @'
SELECT json_build_object(
  'rls_enabled', (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'training_admission_notification_settings'),
  'policy_count', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_admission_notification_settings'),
  'anon_direct_write_or_read', has_table_privilege('anon', 'public.training_admission_notification_settings', 'SELECT') OR has_table_privilege('anon', 'public.training_admission_notification_settings', 'INSERT') OR has_table_privilege('anon', 'public.training_admission_notification_settings', 'UPDATE') OR has_table_privilege('anon', 'public.training_admission_notification_settings', 'DELETE'),
  'authenticated_direct_write_or_read', has_table_privilege('authenticated', 'public.training_admission_notification_settings', 'SELECT') OR has_table_privilege('authenticated', 'public.training_admission_notification_settings', 'INSERT') OR has_table_privilege('authenticated', 'public.training_admission_notification_settings', 'UPDATE') OR has_table_privilege('authenticated', 'public.training_admission_notification_settings', 'DELETE'),
  'get_security_definer', (SELECT prosecdef FROM pg_proc WHERE oid = 'public.training_get_notification_settings()'::regprocedure),
  'update_security_definer', (SELECT prosecdef FROM pg_proc WHERE oid = 'public.training_update_notification_settings(integer,integer,integer)'::regprocedure),
  'get_search_path', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.training_get_notification_settings()'::regprocedure),
  'update_search_path', (SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.training_update_notification_settings(integer,integer,integer)'::regprocedure),
  'authenticated_get_execute', has_function_privilege('authenticated', 'public.training_get_notification_settings()', 'EXECUTE'),
  'authenticated_update_execute', has_function_privilege('authenticated', 'public.training_update_notification_settings(integer,integer,integer)', 'EXECUTE'),
  'anon_get_execute', has_function_privilege('anon', 'public.training_get_notification_settings()', 'EXECUTE'),
  'anon_update_execute', has_function_privilege('anon', 'public.training_update_notification_settings(integer,integer,integer)', 'EXECUTE'),
  'get_arguments', pg_get_function_identity_arguments('public.training_get_notification_settings()'::regprocedure),
  'update_arguments', pg_get_function_identity_arguments('public.training_update_notification_settings(integer,integer,integer)'::regprocedure)
);
'@
  $details = $metadata.Trim() | ConvertFrom-Json
  if ($details.rls_enabled -ne $true -or $details.policy_count -ne 0 -or $details.anon_direct_write_or_read -or $details.authenticated_direct_write_or_read) { throw 'Notification settings direct-table access boundary is incorrect.' }
  if (-not $details.get_security_definer -or -not $details.update_security_definer -or $details.get_search_path -notmatch 'search_path=public' -or $details.update_search_path -notmatch 'search_path=public') { throw 'Notification settings RPC SECURITY DEFINER or search_path is incorrect.' }
  if (-not $details.authenticated_get_execute -or -not $details.authenticated_update_execute -or $details.anon_get_execute -or $details.anon_update_execute) { throw 'Notification settings RPC EXECUTE grants are incorrect.' }
  if ($details.get_arguments -ne '' -or $details.update_arguments -match 'uuid') { throw 'Notification settings RPC exposes an unexpected scope parameter.' }

  $companyPositiveSql = @'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '__ACTOR_ID__', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.training_get_notification_settings()) <> 1 THEN RAISE EXCEPTION 'Company settings RPC did not return one row'; END IF;
  PERFORM public.training_update_notification_settings(7, 30, 9);
END;
$$;
ROLLBACK;
'@.Replace('__ACTOR_ID__', $companyId)
  [void](Invoke-Check -Label 'company-positive' -Sql $companyPositiveSql)

  $employeeNegativeSql = @'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '__ACTOR_ID__', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.training_get_notification_settings();
    RAISE EXCEPTION 'Expected read denial was not raised' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM <> U&'\53EA\6709\516C\53F8\5B89\5168\751F\4EA7\90E8\53EF\67E5\770B\63D0\9192\8BBE\7F6E' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.training_update_notification_settings(7, 30, 9);
    RAISE EXCEPTION 'Expected update denial was not raised' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM <> U&'\53EA\6709\516C\53F8\5B89\5168\751F\4EA7\90E8\53EF\4FEE\6539\63D0\9192\8BBE\7F6E' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
'@.Replace('__ACTOR_ID__', $employeeId)
  [void](Invoke-Check -Label 'employee-negative' -Sql $employeeNegativeSql)

  $companyInputValidationSql = @'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '__ACTOR_ID__', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.training_update_notification_settings(-1, 30, 9);
    RAISE EXCEPTION 'Expected parameter rejection was not raised' USING ERRCODE = 'P0002';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> 'P0001' OR SQLERRM <> U&'\63D0\9192\53C2\6570\8D85\51FA\5141\8BB8\8303\56F4' THEN RAISE; END IF;
  END;
END;
$$;
ROLLBACK;
'@.Replace('__ACTOR_ID__', $companyId)
  [void](Invoke-Check -Label 'company-input-validation' -Sql $companyInputValidationSql)

  [pscustomobject]@{
    status = 'passed'
    environment = 'test'
    fixture_source = 'D02 anonymous company and employee profiles'
    direct_table_access = 'anon/authenticated denied'
    rpc_company_role = 'read and update allowed inside rolled-back transaction'
    rpc_employee_role = 'read and update denied'
    scope_parameter_boundary = 'no company_id, employee_id, or UUID function parameter'
    input_validation = 'out-of-range update rejected'
    metadata = $details
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runDir 'result.json') -Encoding utf8
  Write-Output "D03 notification settings RPC verification passed: $runDir"
}
finally {
  if ($null -eq $originalPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
  else { $env:PGPASSWORD = $originalPgPassword }
  if ($null -eq $originalPgClientEncoding) { Remove-Item Env:PGCLIENTENCODING -ErrorAction SilentlyContinue }
  else { $env:PGCLIENTENCODING = $originalPgClientEncoding }
}

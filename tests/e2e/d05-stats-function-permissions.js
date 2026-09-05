/** D05 targeted verification for statistics SECURITY DEFINER execution boundaries. */
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
} = require('./d04-test-environment');

const EXTERNAL_SIGNATURES = [
  'stats_alert_ack(uuid[])',
  'stats_alert_inbox(boolean)',
  'stats_alert_sync()',
  'stats_export_records(uuid,uuid)',
  'stats_overdue_list(uuid,integer)',
  'stats_overview(uuid,date,date)',
  'stats_set_cert_target(uuid,integer)',
  'stats_set_settings(numeric,integer)',
];
const INTERNAL_SIGNATURES = [
  'stats_can_access(uuid)',
  'stats_scope_depts(uuid)',
];

const results = [];

function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

async function request(baseUrl, anonKey, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: response.status, json };
}

async function login(baseUrl, anonKey, email, password) {
  const response = await request(baseUrl, anonKey, '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token) {
    throw new Error('隔离测试管理员登录失败');
  }
  return response.json.access_token;
}

function isExecuteDenied(response) {
  return (response.status === 401 || response.status === 403)
    && response.json?.code === '42501';
}

function readAclInventory(boundary) {
  const sql = `
WITH expected(signature, exposure) AS (
  VALUES
    ('stats_alert_ack(uuid[])', 'external'),
    ('stats_alert_inbox(boolean)', 'external'),
    ('stats_alert_sync()', 'external'),
    ('stats_can_access(uuid)', 'internal'),
    ('stats_export_records(uuid,uuid)', 'external'),
    ('stats_overdue_list(uuid,integer)', 'external'),
    ('stats_overview(uuid,date,date)', 'external'),
    ('stats_scope_depts(uuid)', 'internal'),
    ('stats_set_cert_target(uuid,integer)', 'external'),
    ('stats_set_settings(numeric,integer)', 'external')
), actual AS (
  SELECT p.oid,
         p.oid::regprocedure::text AS signature,
         p.prosecdef,
         pg_get_userbyid(p.proowner) AS owner,
         p.proconfig,
         EXISTS (
           SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
           WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
         ) AS public_execute,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname LIKE 'stats\\_%' ESCAPE '\\'
), joined AS (
  SELECT e.signature, e.exposure, a.*
    FROM expected e
    LEFT JOIN actual a USING (signature)
)
SELECT json_build_object(
  'expected_count', (SELECT count(*) FROM expected),
  'actual_count', (SELECT count(*) FROM actual),
  'matched_count', (SELECT count(*) FROM joined WHERE oid IS NOT NULL),
  'security_definer_count', (SELECT count(*) FROM joined WHERE prosecdef),
  'postgres_owner_count', (SELECT count(*) FROM joined WHERE owner='postgres'),
  'safe_search_path_count', (SELECT count(*) FROM joined WHERE proconfig=ARRAY['search_path=public']::text[]),
  'public_execute_count', (SELECT count(*) FROM joined WHERE public_execute),
  'anon_execute_count', (SELECT count(*) FROM joined WHERE anon_execute),
  'external_authenticated_count', (SELECT count(*) FROM joined WHERE exposure='external' AND authenticated_execute),
  'internal_authenticated_count', (SELECT count(*) FROM joined WHERE exposure='internal' AND authenticated_execute)
)::text;
`;
  return JSON.parse(runPsqlScalar(boundary.databaseUrl, sql));
}

async function main() {
  // Shared D04 gate must complete before the first real API request.
  const boundary = validateTestBoundary();
  const fixtureMarkers = assertD02FixtureMarker(boundary);
  console.log(`PASS D05-STATS-GATE isolated_test fixture_markers=${fixtureMarkers}`);

  const inventory = readAclInventory(boundary);
  check('D05-STATS-AC01 exact function inventory',
    inventory.expected_count === 10 && inventory.actual_count === 10 && inventory.matched_count === 10,
    `expected=${inventory.expected_count} actual=${inventory.actual_count} matched=${inventory.matched_count}`);
  check('D05-STATS-AC02 all functions remain hardened definers',
    inventory.security_definer_count === 10
      && inventory.postgres_owner_count === 10
      && inventory.safe_search_path_count === 10,
    `definer=${inventory.security_definer_count} owner=${inventory.postgres_owner_count} path=${inventory.safe_search_path_count}`);
  check('D05-STATS-AC03 PUBLIC and anon have no EXECUTE',
    inventory.public_execute_count === 0 && inventory.anon_execute_count === 0,
    `public=${inventory.public_execute_count} anon=${inventory.anon_execute_count}`);
  check('D05-STATS-AC04 authenticated has only external RPC EXECUTE',
    inventory.external_authenticated_count === EXTERNAL_SIGNATURES.length
      && inventory.internal_authenticated_count === 0,
    `external=${inventory.external_authenticated_count} internal=${inventory.internal_authenticated_count}`);

  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const anonymous = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/stats_overview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_dept: null, p_from: null, p_to: null }),
  });
  check('D05-STATS-AC05 anonymous external RPC denied', isExecuteDenied(anonymous),
    `status=${anonymous.status} code=${anonymous.json?.code || 'none'}`);

  const token = await login(
    boundary.apiOrigin,
    anonKey,
    required('SAFETY_TEST_ADMIN_EMAIL'),
    required('SAFETY_TEST_ADMIN_PASSWORD'),
  );
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const overview = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/stats_overview', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ p_dept: null, p_from: null, p_to: null }),
  });
  const validOverview = overview.status === 200
    && overview.json?.total
    && Array.isArray(overview.json?.depts)
    && overview.json?.settings;
  check('D05-STATS-AC06 authenticated external RPC and legitimate overview result', !!validOverview,
    `status=${overview.status} code=${overview.json?.code || 'none'}`);

  for (const helper of INTERNAL_SIGNATURES) {
    const name = helper.slice(0, helper.indexOf('('));
    const response = await request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ p_dept: null }),
    });
    check(`D05-STATS-AC07 authenticated internal helper denied: ${helper}`, isExecuteDenied(response),
      `status=${response.status} code=${response.json?.code || 'none'}`);
  }

  const failed = results.filter(result => !result.pass);
  console.log(JSON.stringify({ suite: 'D05-STATS-PERMISSIONS', passed: results.length - failed.length, failed: failed.length }));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(`D05 statistics permission test stopped: ${error.message}`);
  process.exitCode = 2;
});

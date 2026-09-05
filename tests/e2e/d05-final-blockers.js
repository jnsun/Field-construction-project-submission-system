/** Targeted regression for the three blockers from the failed D05 FINAL. */
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
} = require('./d04-test-environment');
const {
  SAFE_DEFINER_SEARCH_PATHS,
  securityDefinerHasSafePathSql,
} = require('./d05-security-acceptance-helpers');
const {
  cleanupScopeFixture,
  countScopeFixtureResidue,
  createScopeFixture,
} = require('./d05-scope-fixture');

const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

async function request(baseUrl, anonKey, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
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
  if (response.status !== 200 || !response.json?.access_token) throw new Error('隔离测试账号登录失败');
  return response.json.access_token;
}

function isDatabaseDenial(response) {
  return (response.status === 400 || response.status === 403)
    && (response.json?.code === '42501' || response.json?.code === 'P0001');
}

function readDefinerPathStatus(boundary) {
  const sql = `
WITH definers AS (
  SELECT p.*
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
)
SELECT json_build_object(
  'unsafe', (SELECT count(*) FROM definers p WHERE NOT (${securityDefinerHasSafePathSql('p')})),
  'rls_auto_pg_catalog', (
    SELECT count(*) FROM definers p
    WHERE p.proname='rls_auto_enable'
      AND 'search_path=pg_catalog'=ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
  )
)::text;
`;
  return JSON.parse(runPsqlScalar(boundary.databaseUrl, sql));
}

async function main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const fixtureMarkers = assertD02FixtureMarker(boundary);
  console.log(`PASS D05-BLOCKERS-GATE isolated_test fixture_markers=${fixtureMarkers}`);

  let fixture = null;
  let residue = -1;
  try {
    const definer = readDefinerPathStatus(boundary);
    check('D05-BLOCKER-A fixed safe pg_catalog search_path is accepted',
      SAFE_DEFINER_SEARCH_PATHS.includes('search_path=pg_catalog')
        && definer.rls_auto_pg_catalog === 1
        && definer.unsafe === 0,
      `rls_auto_pg_catalog=${definer.rls_auto_pg_catalog} unsafe=${definer.unsafe}`);

    fixture = createScopeFixture(boundary);
    check('D05-BLOCKER-C minimal cross-scope fixture created', true,
      'reused_entities=2 new_projects=1 new_roles=1');

    const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const entityToken = await login(
      boundary.apiOrigin,
      anonKey,
      required('SAFETY_TEST_ENTITY_EMAIL'),
      required('SAFETY_TEST_ENTITY_PASSWORD'),
    );
    const headers = { Authorization: `Bearer ${entityToken}`, 'Content-Type': 'application/json' };

    const departmentIds = [fixture.legal_entity_id, fixture.outside_entity_id].join(',');
    const directory = await request(
      boundary.apiOrigin,
      anonKey,
      `/rest/v1/departments?id=in.(${departmentIds})&select=id,code`,
      { headers },
    );
    const directoryIds = new Set(Array.isArray(directory.json) ? directory.json.map(item => item.id) : []);
    check('D05-BLOCKER-B authenticated department directory legitimately includes both entities',
      directory.status === 200
        && directoryIds.has(fixture.legal_entity_id)
        && directoryIds.has(fixture.outside_entity_id),
      `status=${directory.status} rows=${directoryIds.size}`);

    const legalRead = await request(
      boundary.apiOrigin,
      anonKey,
      `/rest/v1/site_projects?id=eq.${fixture.legal_project_id}&select=id`,
      { headers },
    );
    check('D05-BLOCKER-C1 legal project scope succeeds',
      legalRead.status === 200 && Array.isArray(legalRead.json) && legalRead.json.length === 1,
      `status=${legalRead.status} rows=${Array.isArray(legalRead.json) ? legalRead.json.length : -1}`);

    const outsideRead = await request(
      boundary.apiOrigin,
      anonKey,
      `/rest/v1/site_projects?id=eq.${fixture.outsideProjectId}&select=id`,
      { headers },
    );
    check('D05-BLOCKER-C2 cross-project table read is RLS-filtered',
      outsideRead.status === 200 && Array.isArray(outsideRead.json) && outsideRead.json.length === 0,
      `status=${outsideRead.status} rows=${Array.isArray(outsideRead.json) ? outsideRead.json.length : -1}`);

    const deniedInvite = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/site_project_refresh_invite', {
      method: 'POST', headers,
      body: JSON.stringify({ p_project_id: fixture.outsideProjectId }),
    });
    check('D05-BLOCKER-C3 cross-project invite operation is denied', isDatabaseDenial(deniedInvite),
      `status=${deniedInvite.status} code=${deniedInvite.json?.code || 'none'}`);

    const deniedReport = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/training_admission_report', {
      method: 'POST', headers,
      body: JSON.stringify({ p_project_id: fixture.outsideProjectId }),
    });
    check('D05-BLOCKER-C4 cross-project report is denied', isDatabaseDenial(deniedReport),
      `status=${deniedReport.status} code=${deniedReport.json?.code || 'none'}`);

    const deniedStats = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/stats_export_records', {
      method: 'POST', headers,
      body: JSON.stringify({ p_plan: null, p_dept: fixture.outside_entity_id }),
    });
    check('D05-BLOCKER-C5 directory visibility does not grant cross-entity data access',
      deniedStats.status === 403 && deniedStats.json?.code === '42501',
      `status=${deniedStats.status} code=${deniedStats.json?.code || 'none'}`);
  } catch (error) {
    check('D05-BLOCKERS infrastructure and execution', false, error.message);
  } finally {
    if (fixture) {
      try {
        cleanupScopeFixture(boundary, fixture);
        residue = countScopeFixtureResidue(boundary, fixture);
        check('D05-BLOCKER-D temporary fixture cleanup leaves zero residue', residue === 0,
          `residue=${residue}`);
      } catch (error) {
        check('D05-BLOCKER-D temporary fixture cleanup leaves zero residue', false, error.message);
      }
    }
  }

  const failed = results.filter(item => !item.pass);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(JSON.stringify({
    suite: 'D05-FINAL-BLOCKERS',
    passed: results.length - failed.length,
    failed: failed.length,
    residue,
    elapsed_ms: Number(elapsedMs.toFixed(0)),
  }));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => {
  console.error(`FAIL D05-FINAL-BLOCKERS ${error.message}`);
  process.exitCode = 2;
});

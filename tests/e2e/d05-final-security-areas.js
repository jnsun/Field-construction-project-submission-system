/** D05 final read-only and negative checks for the remaining security areas. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
} = require('./d04-test-environment');
const { securityDefinerHasSafePathSql } = require('./d05-security-acceptance-helpers');

const root = path.resolve(__dirname, '..', '..');
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

function isExecuteDenied(response) {
  return (response.status === 401 || response.status === 403) && response.json?.code === '42501';
}

function migrationCheck(version) {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'),
    'utf8',
  ));
  const entry = manifest.migrations.find(item => item.version === version);
  if (!entry) return false;
  const source = fs.readFileSync(path.join(root, 'sql', entry.file), 'utf8').replace(/\r\n/g, '\n');
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  return digest === entry.sha256;
}

function readDatabaseSecurity(boundary) {
  const sql = `
WITH secured_tables(name) AS (
  VALUES ('profiles'), ('departments'), ('training_employees')
), sensitive_functions(signature) AS (
  VALUES
    ('public.site_project_invite_summary(text)'),
    ('public.site_project_refresh_invite(uuid)'),
    ('public.stats_export_records(uuid,uuid)'),
    ('public.training_admission_annual_stats(integer,uuid)'),
    ('public.training_admission_record_cards(uuid)'),
    ('public.training_admission_report(uuid)'),
    ('public.training_admission_signature_report(uuid)'),
    ('public.training_contractor_personnel_ledger(uuid)'),
    ('public.training_verify_certificate(text)'),
    ('public.training_verify_temporary_access(text)'),
    ('public.training_verify_visitor_notice(text)')
), definer_functions AS (
  SELECT p.*
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef
)
SELECT json_build_object(
  'secured_tables_rls', (
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (SELECT name FROM secured_tables) AND c.relrowsecurity
  ),
  'profiles_select', has_table_privilege('authenticated','public.profiles','SELECT'),
  'departments_select', has_table_privilege('authenticated','public.departments','SELECT'),
  'employees_all_dml', has_table_privilege('authenticated','public.training_employees','SELECT,INSERT,UPDATE,DELETE'),
  'secured_policy_commands', (
    SELECT count(*) FROM pg_policies
    WHERE schemaname='public' AND tablename IN (SELECT name FROM secured_tables)
  ),
  'definer_count', (SELECT count(*) FROM definer_functions),
  'definer_public_execute', (
    SELECT count(*) FROM definer_functions p WHERE EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f',p.proowner))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
    )
  ),
  'definer_anon_execute', (
    SELECT count(*) FROM definer_functions p WHERE has_function_privilege('anon',p.oid,'EXECUTE')
  ),
  'definer_unsafe_path', (
    SELECT count(*) FROM definer_functions p
    WHERE NOT (${securityDefinerHasSafePathSql('p')})
  ),
  'private_buckets', (
    SELECT count(*) FROM storage.buckets
    WHERE id IN ('avatars','certificates','training-courses') AND public=false
  ),
  'storage_rls', (
    SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='storage' AND c.relname='objects'
  ),
  'storage_anon_policies', (
    SELECT count(*) FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND roles && ARRAY['anon'::name,'public'::name]
  ),
  'sensitive_function_count', (
    SELECT count(*) FROM sensitive_functions WHERE to_regprocedure(signature) IS NOT NULL
  ),
  'sensitive_anon_execute', (
    SELECT count(*) FROM sensitive_functions
    WHERE to_regprocedure(signature) IS NOT NULL
      AND has_function_privilege('anon',to_regprocedure(signature),'EXECUTE')
  )
)::text;
`;
  return JSON.parse(runPsqlScalar(boundary.databaseUrl, sql));
}

async function main() {
  const boundary = validateTestBoundary();
  const fixtureMarkers = assertD02FixtureMarker(boundary);
  console.log(`PASS D05-FINAL-AREAS-GATE isolated_test fixture_markers=${fixtureMarkers}`);

  check('D05-FINAL-AC01 v51 manifest checksum', migrationCheck(51));
  check('D05-FINAL-AC02 v52 manifest checksum', migrationCheck(52));

  const db = readDatabaseSecurity(boundary);
  check('D05-FINAL-AC03 v51 table grants and RLS remain active',
    db.secured_tables_rls === 3
      && db.profiles_select === true
      && db.departments_select === true
      && db.employees_all_dml === true
      && db.secured_policy_commands >= 7,
    `rls=${db.secured_tables_rls} policies=${db.secured_policy_commands}`);
  check('D05-FINAL-AC04 all public SECURITY DEFINER functions are hardened',
    db.definer_count > 0
      && db.definer_public_execute === 0
      && db.definer_anon_execute === 0
      && db.definer_unsafe_path === 0,
    `total=${db.definer_count} public=${db.definer_public_execute} anon=${db.definer_anon_execute} unsafe_path=${db.definer_unsafe_path}`);
  check('D05-FINAL-AC05 private file buckets and storage RLS',
    db.private_buckets === 3 && db.storage_rls === true && db.storage_anon_policies === 0,
    `private_buckets=${db.private_buckets} anon_policies=${db.storage_anon_policies}`);
  check('D05-FINAL-AC06 export/QR/invite functions are not anonymous',
    db.sensitive_function_count === 11 && db.sensitive_anon_execute === 0,
    `functions=${db.sensitive_function_count} anon=${db.sensitive_anon_execute}`);

  const clientSources = [
    'js/modules/qualification/admin.js',
    'js/modules/qualification/certs.js',
    'js/modules/stats/stats.js',
    'js/modules/training/admission-operations.js',
    'js/modules/training/admission-review.js',
    'js/modules/training/admission-verify.js',
    'js/modules/training/contractors.js',
    'js/modules/training/mine.js',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  check('D05-FINAL-AC07 private files use signed URLs, not public URLs',
    clientSources.includes('createSignedUrl(') && !clientSources.includes('getPublicUrl('));

  const configSource = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(root, 'js', 'auth.js'), 'utf8');
  check('D05-FINAL-AC08 browser auth/session uses public config only',
    configSource.includes('runtimeConfig.anonKey')
      && configSource.includes('persistSession: true')
      && authSource.includes('sb.auth.getSession()')
      && authSource.includes('sb.auth.signOut()')
      && !/(service_role|JWT_SECRET|DATABASE_PASSWORD|DB_PASSWORD)/i.test(`${configSource}\n${authSource}`));

  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const invalidSession = await request(boundary.apiOrigin, anonKey, '/rest/v1/profiles?select=id&limit=1', {
    headers: { Authorization: 'Bearer d05.invalid.session' },
  });
  check('D05-FINAL-AC09 invalid session is rejected', invalidSession.status === 401,
    `status=${invalidSession.status} code=${invalidSession.json?.code || 'none'}`);

  const anonymousSignedUrl = await request(
    boundary.apiOrigin,
    anonKey,
    '/storage/v1/object/sign/certificates/d05-final/nonexistent.pdf',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    },
  );
  check('D05-FINAL-AC10 anonymous signed URL request is denied',
    [400, 401, 403].includes(anonymousSignedUrl.status) && !anonymousSignedUrl.json?.signedURL,
    `status=${anonymousSignedUrl.status}`);

  for (const [rpc, body] of [
    ['site_project_invite_summary', { p_token: 'D05-FINAL-INVALID' }],
    ['training_verify_temporary_access', { p_pass_code: 'D05-FINAL-INVALID' }],
    ['training_verify_visitor_notice', { p_pass_code: 'D05-FINAL-INVALID' }],
  ]) {
    const response = await request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${rpc}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    check(`D05-FINAL-AC11 anonymous RPC denied: ${rpc}`, isExecuteDenied(response),
      `status=${response.status} code=${response.json?.code || 'none'}`);
  }

  const adminToken = await login(
    boundary.apiOrigin,
    anonKey,
    required('SAFETY_TEST_ADMIN_EMAIL'),
    required('SAFETY_TEST_ADMIN_PASSWORD'),
  );
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

  const allowedStatsExport = await request(boundary.apiOrigin, anonKey, '/rest/v1/rpc/stats_export_records', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ p_plan: null, p_dept: null }),
  });
  check('D05-FINAL-AC12 authorized statistics export remains available',
    allowedStatsExport.status === 200 && Array.isArray(allowedStatsExport.json?.rows),
    `status=${allowedStatsExport.status}`);

  const failed = results.filter(item => !item.pass);
  console.log(JSON.stringify({ suite: 'D05-FINAL-SECURITY-AREAS', passed: results.length - failed.length, failed: failed.length }));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(error => {
  console.error(`FAIL D05-FINAL-SECURITY-AREAS ${error.message}`);
  process.exitCode = 2;
});

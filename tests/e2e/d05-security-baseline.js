/** D05 negative API checks. Uses only local SAFETY_* test variables. */
const { required } = require('./test-config');

const baseUrl = required('SAFETY_SUPABASE_URL');
const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
const entityEmail = required('SAFETY_TEST_ENTITY_EMAIL');
const entityPassword = required('SAFETY_TEST_ENTITY_PASSWORD');
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { apikey: anonKey, ...(options.headers || {}) },
  });
  const body = await response.text();
  return { status: response.status, body };
}

async function login() {
  const response = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: entityEmail, password: entityPassword }),
  });
  if (response.status !== 200) throw new Error('test entity login failed');
  return JSON.parse(response.body).access_token;
}

async function main() {
  const anonymousProfiles = await request('/rest/v1/profiles?select=id&limit=1');
  record('D05-AC01', anonymousProfiles.status === 401 || anonymousProfiles.status === 403 || anonymousProfiles.body === '[]', 'anonymous profile read denied');

  const anonymousCertificate = await request('/rest/v1/rpc/training_verify_certificate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_certificate_no: 'D05-NOT-A-REAL-CODE' }),
  });
  record('D05-AC02', anonymousCertificate.status === 401 || anonymousCertificate.status === 403, 'anonymous QR verification denied');

  const token = await login();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const entityRecords = await request('/rest/v1/training_employees?select=id&limit=50', { headers: authHeaders });
  record('D05-AC03', entityRecords.status === 401 || entityRecords.status === 403 || entityRecords.body === '[]', 'entity direct personnel table read denied');

  const visibleProfiles = await request('/rest/v1/profiles?select=id&limit=50', { headers: authHeaders });
  const profileCount = visibleProfiles.status === 200 ? JSON.parse(visibleProfiles.body).length : 0;
  record('D05-AC04', visibleProfiles.status === 401 || visibleProfiles.status === 403 || profileCount <= 1, 'entity cannot enumerate unrelated profiles');

  const forgedSignatureWrite = await request('/rest/v1/training_signatures', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ employee_id: '00000000-0000-0000-0000-000000000000', assignment_id: '00000000-0000-0000-0000-000000000000', storage_path: 'd05/forbidden.png' }),
  });
  record('D05-AC05', forgedSignatureWrite.status === 401 || forgedSignatureWrite.status === 403 || forgedSignatureWrite.status === 409, 'forged signature write denied');

  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({ suite: 'D05', passed: results.length - failed.length, failed: failed.length }));
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error(`FAIL D05-RUNNER ${error.message}`); process.exit(2); });

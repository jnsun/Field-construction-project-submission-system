/** D05 targeted security checks. Uses only the isolated SAFETY_* test environment. */
const { required } = require('./test-config');
const {
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
} = require('./d04-test-environment');

const results = [];

function responseCode(result) {
  return result && result.json && typeof result.json === 'object'
    ? String(result.json.code || '')
    : '';
}

function isPermissionStatus(status) {
  return status === 401 || status === 403;
}

function isEmptyArray(result) {
  return result.status === 200 && Array.isArray(result.json) && result.json.length === 0;
}

function classifyLegalAccess(result, validateBusinessResult, tablePrivilegePresent = true) {
  const code = responseCode(result);
  if (!tablePrivilegePresent) return { ok: false, kind: 'table_privilege_missing' };
  if (result.status >= 200 && result.status < 300) {
    return validateBusinessResult(result.json)
      ? { ok: true, kind: 'legal_access_succeeded' }
      : { ok: false, kind: 'business_result_invalid' };
  }
  if (result.status === 403 && code === '42501') {
    return { ok: false, kind: 'legal_access_denied' };
  }
  if (result.status === 401) return { ok: false, kind: 'authentication_failed' };
  return { ok: false, kind: 'unexpected_error' };
}

function classifyExpectedDenial(result, tablePrivilegePresent = true) {
  const code = responseCode(result);
  if (!tablePrivilegePresent) return { ok: false, kind: 'table_privilege_missing' };
  if (isEmptyArray(result)) return { ok: true, kind: 'rls_rows_filtered' };
  if (result.status === 403 && code === '42501') {
    return { ok: true, kind: 'permission_rule_denied' };
  }
  return { ok: false, kind: 'unexpected_error' };
}

function classifyAnonymousDenial(result) {
  const code = responseCode(result);
  if (isEmptyArray(result)) return { ok: true, kind: 'anonymous_rows_filtered' };
  if (isPermissionStatus(result.status) && code === '42501') {
    return { ok: true, kind: 'anonymous_permission_denied' };
  }
  return { ok: false, kind: 'unexpected_error' };
}

function classifyClosedDirectTable(result, tablePrivilegePresent) {
  const code = responseCode(result);
  if (tablePrivilegePresent) return { ok: false, kind: 'unexpected_direct_table_privilege' };
  if (result.status === 403 && code === '42501') {
    return { ok: true, kind: 'direct_table_access_closed' };
  }
  return { ok: false, kind: 'unexpected_error' };
}

function record(id, classification, result) {
  results.push({ id, ok: classification.ok, kind: classification.kind });
  console.log(
    `${classification.ok ? 'PASS' : 'FAIL'} ${id} kind=${classification.kind}`
    + ` status=${result.status} code=${responseCode(result) || 'none'}`,
  );
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
  if (response.status !== 200 || !response.json || !response.json.access_token || !response.json.user?.id) {
    throw new Error('隔离测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

function readRequiredPrivileges(boundary, scalarQuery = runPsqlScalar) {
  const sql = `SELECT json_build_object(
    'profiles_select', has_table_privilege('authenticated', 'public.profiles', 'SELECT'),
    'departments_select', has_table_privilege('authenticated', 'public.departments', 'SELECT'),
    'employees_select', has_table_privilege('authenticated', 'public.training_employees', 'SELECT'),
    'signatures_insert', has_table_privilege('authenticated', 'public.training_signatures', 'INSERT')
  );`;
  const value = JSON.parse(scalarQuery(boundary.databaseUrl, sql));
  return {
    profilesSelect: value.profiles_select === true,
    departmentsSelect: value.departments_select === true,
    employeesSelect: value.employees_select === true,
    signaturesInsert: value.signatures_insert === true,
  };
}

function visibleDepartmentIds(departments, rootId) {
  if (!rootId || !Array.isArray(departments)) return new Set();
  const visible = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const department of departments) {
      if (department && visible.has(department.parent_id) && !visible.has(department.id)) {
        visible.add(department.id);
        changed = true;
      }
    }
  }
  return visible;
}

async function main() {
  // This gate must finish before the first live API request.
  const boundary = validateTestBoundary();
  const fixtureMarkers = assertD02FixtureMarker(boundary);
  console.log(`PASS D05-GATE isolated_test fixture_markers=${fixtureMarkers}`);

  const baseUrl = boundary.apiOrigin;
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const entityEmail = required('SAFETY_TEST_ENTITY_EMAIL');
  const entityPassword = required('SAFETY_TEST_ENTITY_PASSWORD');
  const adminEmail = required('SAFETY_TEST_ADMIN_EMAIL');
  const adminPassword = required('SAFETY_TEST_ADMIN_PASSWORD');
  const privileges = readRequiredPrivileges(boundary);

  const anonymousProfiles = await request(baseUrl, anonKey, '/rest/v1/profiles?select=id&limit=1');
  record('D05-AC01', classifyAnonymousDenial(anonymousProfiles), anonymousProfiles);

  const anonymousCertificate = await request(baseUrl, anonKey, '/rest/v1/rpc/training_verify_certificate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_certificate_no: 'D05-NOT-A-REAL-CODE' }),
  });
  record('D05-AC02', classifyAnonymousDenial(anonymousCertificate), anonymousCertificate);

  const entity = await login(baseUrl, anonKey, entityEmail, entityPassword);
  const admin = await login(baseUrl, anonKey, adminEmail, adminPassword);
  if (entity.userId === admin.userId) throw new Error('隔离测试管理员与经营实体账号不能相同');
  const entityHeaders = { Authorization: `Bearer ${entity.token}` };
  const adminHeaders = { Authorization: `Bearer ${admin.token}` };

  const ownProfile = await request(
    baseUrl,
    anonKey,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(entity.userId)}&select=id,department_id`,
    { headers: entityHeaders },
  );
  const ownProfileClass = classifyLegalAccess(
    ownProfile,
    rows => Array.isArray(rows) && rows.length === 1 && rows[0].id === entity.userId && !!rows[0].department_id,
    privileges.profilesSelect,
  );
  record('D05-AC03', ownProfileClass, ownProfile);

  const entityDepartmentId = ownProfileClass.ok ? ownProfile.json[0].department_id : null;
  const departments = await request(
    baseUrl,
    anonKey,
    '/rest/v1/departments?select=id,parent_id&limit=1000',
    { headers: entityHeaders },
  );
  const departmentsClass = classifyLegalAccess(
    departments,
    rows => Array.isArray(rows) && !!entityDepartmentId && rows.some(row => row.id === entityDepartmentId),
    privileges.departmentsSelect,
  );
  record('D05-AC04', departmentsClass, departments);

  const visibleIds = departmentsClass.ok
    ? visibleDepartmentIds(departments.json, entityDepartmentId)
    : new Set();
  const employees = await request(
    baseUrl,
    anonKey,
    '/rest/v1/training_employees?select=id,department_id&limit=50',
    { headers: entityHeaders },
  );
  const employeesClass = classifyLegalAccess(
    employees,
    rows => Array.isArray(rows) && rows.length > 0 && visibleIds.size > 0
      && rows.every(row => row.department_id && visibleIds.has(row.department_id)),
    privileges.employeesSelect,
  );
  record('D05-AC05', employeesClass, employees);

  const unrelatedProfile = await request(
    baseUrl,
    anonKey,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(admin.userId)}&select=id`,
    { headers: entityHeaders },
  );
  record(
    'D05-AC06',
    classifyExpectedDenial(unrelatedProfile, privileges.profilesSelect),
    unrelatedProfile,
  );

  const allEmployees = await request(
    baseUrl,
    anonKey,
    '/rest/v1/training_employees?select=id,department_id&limit=1000',
    { headers: adminHeaders },
  );
  const outsideEmployee = allEmployees.status === 200 && Array.isArray(allEmployees.json)
    ? allEmployees.json.find(row => row.department_id && !visibleIds.has(row.department_id))
    : null;
  const outsideEmployeeRead = outsideEmployee
    ? await request(
      baseUrl,
      anonKey,
      `/rest/v1/training_employees?id=eq.${encodeURIComponent(outsideEmployee.id)}&select=id`,
      { headers: entityHeaders },
    )
    : { status: allEmployees.status, json: { code: 'D05-NO-OUTSIDE-FIXTURE' } };
  record(
    'D05-AC07',
    outsideEmployee
      ? classifyExpectedDenial(outsideEmployeeRead, privileges.employeesSelect)
      : { ok: false, kind: 'business_fixture_missing' },
    outsideEmployeeRead,
  );

  const forgedSignatureWrite = await request(baseUrl, anonKey, '/rest/v1/training_signatures', {
    method: 'POST',
    headers: { ...entityHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      employee_id: '00000000-0000-0000-0000-000000000000',
      assignment_id: '00000000-0000-0000-0000-000000000000',
      storage_path: 'd05/forbidden.png',
    }),
  });
  record(
    'D05-AC08',
    classifyClosedDirectTable(forgedSignatureWrite, privileges.signaturesInsert),
    forgedSignatureWrite,
  );

  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({ suite: 'D05', passed: results.length - failed.length, failed: failed.length }));
  process.exitCode = failed.length ? 1 : 0;
}

module.exports = {
  classifyAnonymousDenial,
  classifyClosedDirectTable,
  classifyExpectedDenial,
  classifyLegalAccess,
  readRequiredPrivileges,
  visibleDepartmentIds,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`FAIL D05-RUNNER ${error.message}`);
    process.exitCode = 2;
  });
}

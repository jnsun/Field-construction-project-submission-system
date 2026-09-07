/** D07 R02 targeted regression: company read and project daily-management split. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { required } = require('./test-config');
const { assertD02FixtureMarker, validateTestBoundary } = require('./d04-test-environment');

const root = path.resolve(__dirname, '..', '..');
const v64Path = path.join(root, 'sql', 'training-admission-v64-company-read-management-split.sql');
const v65Path = path.join(root, 'sql', 'training-admission-v65-r02-permission-split-completion.sql');
const v66Path = path.join(root, 'sql', 'training-admission-v66-company-read-execute-and-evidence.sql');
const v67Path = path.join(root, 'sql', 'training-admission-v67-project-write-boundary.sql');
const v68Path = path.join(root, 'sql', 'training-admission-v68-recompute-and-join-upload-boundary.sql');
const storageInitializerPath = path.join(root, 'sql', 'd03-storage-application-config.sql');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function safeDiagnosticMessage(error) {
  return String(error?.message || error || 'unknown')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-db-url>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .slice(0, 240);
}

async function loggedStep(name, operationType, operation) {
  const startedAt = new Date();
  console.log(`STEP_START name=${name} started_at=${startedAt.toISOString()} operation=${operationType}`);
  try {
    const value = await operation();
    const endedAt = new Date();
    const httpStatus = value && Number.isInteger(value.status) ? ` http_status=${value.status}` : '';
    console.log(`STEP_END name=${name} started_at=${startedAt.toISOString()} ended_at=${endedAt.toISOString()} exit_code=0 operation=${operationType}${httpStatus}`);
    return value;
  } catch (error) {
    const endedAt = new Date();
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    console.log(`STEP_END name=${name} started_at=${startedAt.toISOString()} ended_at=${endedAt.toISOString()} exit_code=${exitCode} operation=${operationType} error=${safeDiagnosticMessage(error)}`);
    throw error;
  }
}

async function diagnosedStep(databaseUrl, name, operationType, operation) {
  await loggedStep(`${name}_LIVE_BEFORE`, 'SQL SELECT 1', () => {
    if (runPsql(databaseUrl, 'SELECT 1;') !== '1') throw new Error('连接存活检查未返回 1');
  });
  let value;
  let operationError;
  try {
    value = await loggedStep(name, operationType, operation);
  } catch (error) {
    operationError = error;
  }
  let afterError;
  try {
    await loggedStep(`${name}_LIVE_AFTER`, 'SQL SELECT 1', () => {
      if (runPsql(databaseUrl, 'SELECT 1;') !== '1') throw new Error('连接存活检查未返回 1');
    });
  } catch (error) {
    afterError = error;
  }
  if (operationError) throw operationError;
  if (afterError) throw afterError;
  return value;
}

function literal(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql, encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const detail = stderr.split(/\r?\n/).slice(-1)[0] || 'unknown';
    const error = new Error(`D07 R02 测试库操作失败：${detail}`);
    error.exitCode = Number.isInteger(result.status) ? result.status : 1;
    error.transientConnection = /server closed the connection unexpectedly|before or while processing the request|connection.*(?:closed|terminated)|timeout expired/i.test(stderr);
    throw error;
  }
  return String(result.stdout || '').trim();
}

async function ensureDatabaseAlive(databaseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (runPsql(databaseUrl, 'SELECT 1;') === '1') return;
      throw new Error('连接存活检查未返回 1');
    } catch (error) {
      lastError = error;
      if (!error.transientConnection || attempt === 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function applySqlFile(databaseUrl, filePath, label) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', filePath], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`D07 ${label} 应用失败`);
    error.exitCode = Number.isInteger(result.status) ? result.status : 1;
    throw error;
  }
}

function applyMigrations(databaseUrl) {
  applySqlFile(databaseUrl, v64Path, 'v64 测试迁移');
  applySqlFile(databaseUrl, v65Path, 'v65 测试迁移');
  applySqlFile(databaseUrl, v66Path, 'v66 测试迁移');
  applySqlFile(databaseUrl, v67Path, 'v67 测试迁移');
}

async function request(baseUrl, anonKey, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 200 || !response.json?.access_token || !response.json?.user?.id) {
    throw new Error('D07 R02 测试账号登录失败');
  }
  return { token: response.json.access_token, userId: response.json.user.id };
}

async function restRows(boundary, anonKey, token, table, ids) {
  const response = await request(boundary.apiOrigin, anonKey,
    `/rest/v1/${table}?select=id&id=in.(${ids.join(',')})`,
    { headers: { Authorization: `Bearer ${token}` } });
  return response.status === 200 && Array.isArray(response.json) ? response.json : null;
}

async function rpc(boundary, anonKey, token, name, body = {}) {
  return request(boundary.apiOrigin, anonKey, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function denied(response, message = '') {
  return [400, 401, 403].includes(response.status)
    && (!message || String(response.json?.message || '') === message);
}

function success(response) { return response.status >= 200 && response.status < 300; }

function readBase(databaseUrl) {
  const raw = runPsql(databaseUrl, `SELECT json_build_object(
    'project_a', (SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'),
    'lead_entity', (SELECT id FROM public.departments WHERE code='D02-ENT-A'),
    'outside_entity', (SELECT id FROM public.departments WHERE code='D02-ENT-B'),
    'contractor', (SELECT id FROM public.contractor_companies ORDER BY created_at LIMIT 1),
    'member_id', (SELECT id FROM public.site_project_members WHERE project_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL') ORDER BY joined_at LIMIT 1),
    'member_employee', (SELECT employee_id FROM public.site_project_members WHERE project_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL') ORDER BY joined_at LIMIT 1),
    'external_member', (SELECT m.id FROM public.site_project_members m JOIN public.training_employees e ON e.id=m.employee_id WHERE m.project_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL') AND e.employee_no='D02-007' AND m.membership_type='external'),
    'company_actor', (SELECT row_to_json(x) FROM (
      SELECT p.id, p.role, p.admin_level, p.is_super_admin, p.department_id, p.employee_id
      FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-001'
    ) x),
    'entity_actor', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-002'),
    'assignable_user', (SELECT p.id FROM public.profiles p JOIN public.training_employees e ON e.id=p.employee_id WHERE e.employee_no='D02-004'),
    'ordinary_employee', (SELECT id FROM public.training_employees WHERE employee_no='D02-009'),
    'external_employee', (SELECT id FROM public.training_employees WHERE employee_no='D02-007'),
    'role_count', (SELECT count(*) FROM public.site_project_roles WHERE project_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL')),
    'invite_count', (SELECT count(*) FROM public.site_project_invites WHERE project_id=(SELECT id FROM public.site_projects WHERE project_code='D02-NORMAL'))
  )::text;`);
  const base = JSON.parse(raw);
  if (!base.project_a || !base.lead_entity || !base.outside_entity || !base.contractor
      || !base.member_id || !base.member_employee || !base.external_member || !base.company_actor?.id || !base.entity_actor
      || !base.assignable_user || !base.ordinary_employee || !base.external_employee
      || base.role_count !== 0 || base.invite_count !== 0) {
    throw new Error('D02 夹具不满足 D07 R02 安全复用条件');
  }
  return base;
}

function createFixture(databaseUrl, f) {
  runPsql(databaseUrl, `
BEGIN;
INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes)
VALUES (${literal(f.projectX)}::uuid, ${literal(`D07-R02-X-${f.suffix}`)}, ${literal(`[D07-TEST] R02 跨实体 ${f.suffix}`)}, 'active', ${literal(f.outsideEntity)}::uuid, 'D07-TEST');
INSERT INTO public.site_project_entities(project_id, entity_id, is_lead)
VALUES (${literal(f.projectX)}::uuid, ${literal(f.outsideEntity)}::uuid, true);
INSERT INTO public.training_employees(id, name, employee_no, department_id, position, emp_type, status, remark)
VALUES (${literal(f.visitorEmployee)}::uuid, ${literal(`[D07-TEST] R02 访客 ${f.suffix}`)}, ${literal(`D07-R02-V-${f.suffix}`)}, ${literal(f.outsideEntity)}::uuid, '访客', 'employee', 'active', 'D07-TEST');
INSERT INTO public.training_admission_packages(id, project_id, title, status, created_by)
VALUES (${literal(f.packageId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(`[D07-TEST] R02 培训包 ${f.suffix}`)}, 'published', ${literal(f.entityActor)}::uuid);
INSERT INTO public.training_admissions(id, project_id, member_id, employee_id, package_id, status)
VALUES
  (${literal(f.admissionId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.memberId)}::uuid, ${literal(f.memberEmployee)}::uuid, ${literal(f.packageId)}::uuid, 'pending'),
  (${literal(f.externalAdmissionId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.externalMember)}::uuid, ${literal(f.externalEmployee)}::uuid, ${literal(f.packageId)}::uuid, 'pending');
INSERT INTO public.site_project_invites(id, project_id, token_hash, expires_at, created_by)
VALUES
  (${literal(f.inviteA)}::uuid, ${literal(f.projectA)}::uuid, ${literal(`d07-r02-a-${f.suffix}`)}, now()+interval '1 day', ${literal(f.entityActor)}::uuid),
  (${literal(f.inviteX)}::uuid, ${literal(f.projectX)}::uuid, ${literal(`d07-r02-x-${f.suffix}`)}, now()+interval '1 day', ${literal(f.entityActor)}::uuid);
INSERT INTO public.contractor_contracts(id, project_id, contractor_id, contract_no, contract_name, status)
VALUES (${literal(f.contractId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.contractor)}::uuid, ${literal(`D07-R02-${f.suffix}`)}, 'D07 R02', 'pending');
INSERT INTO public.project_join_applications(id, project_id, applicant_user_id, employee_id, name, phone, photo_path, position, status)
VALUES (${literal(f.applicationId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.entityActor)}::uuid, ${literal(f.memberEmployee)}::uuid, 'D07 R02', '13900007771', ${literal(f.joinPhoto)}, '测试', 'pending_project_review');
INSERT INTO public.project_join_application_attachments(id, application_id, attachment_type, original_name, storage_path)
VALUES (${literal(f.attachmentId)}::uuid, ${literal(f.applicationId)}::uuid, 'qualification', 'd07-r02.pdf', ${literal(f.joinAttachment)});
INSERT INTO public.training_admission_reminders(id, project_id, admission_id, employee_id, message, created_by, event_key)
VALUES (${literal(f.reminderId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.admissionId)}::uuid, ${literal(f.memberEmployee)}::uuid, 'D07 R02', ${literal(f.entityActor)}::uuid, ${literal(`d07-r02-${f.suffix}`)});
INSERT INTO public.training_verification_logs(id, project_id, employee_id, verifier_id, credential_type, result_status, code_suffix, reason)
VALUES
  (${literal(f.verificationA)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.memberEmployee)}::uuid, ${literal(f.entityActor)}::uuid, 'certificate', 'blocked', 'R02A01', 'D07 R02'),
  (${literal(f.verificationX)}::uuid, ${literal(f.projectX)}::uuid, ${literal(f.visitorEmployee)}::uuid, ${literal(f.entityActor)}::uuid, 'visitor', 'blocked', 'R02X01', 'D07 R02');
INSERT INTO public.training_personnel_reapproval_requests(id, project_id, employee_id, changed_fields, status, requested_by)
VALUES (${literal(f.reapprovalId)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.memberEmployee)}::uuid, ARRAY['position'], 'pending', ${literal(f.entityActor)}::uuid);
COMMIT;`);
}

function setEntityDepartment(databaseUrl, actorId, departmentId) {
  runPsql(databaseUrl, `UPDATE public.profiles SET department_id=${literal(departmentId)}::uuid, updated_at=now()
    WHERE id=${literal(actorId)}::uuid;`);
}

async function uploadStorage(boundary, anonKey, token, storagePath) {
  const response = await request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': storagePath.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        'x-upsert': 'false',
      },
      body: Buffer.from('D07 R02 isolated fixture'),
    });
  if (!success(response)) throw new Error(`D07 R02 Storage 上传失败：status=${response.status}`);
}

async function createStorageFixture(boundary, databaseUrl, anonKey, entityToken, f) {
  createStorageCleanupPolicy(databaseUrl, f);
  for (const storagePath of f.storagePaths.slice(0, 5)) {
    await uploadStorage(boundary, anonKey, entityToken, storagePath);
  }
  setEntityDepartment(databaseUrl, f.entityActor, f.outsideEntity);
  try {
    await uploadStorage(boundary, anonKey, entityToken, f.crossPath);
  } finally {
    setEntityDepartment(databaseUrl, f.entityActor, f.leadEntity);
  }
}

function createStorageCleanupPolicy(databaseUrl, f) {
  runPsql(databaseUrl, `DROP POLICY IF EXISTS d07_r02_storage_cleanup ON storage.objects;
    CREATE POLICY d07_r02_storage_cleanup ON storage.objects FOR DELETE TO authenticated
    USING (owner_id=auth.uid()::text AND name LIKE ${literal(`%${f.suffix}%`)});`);
}

async function removeStorageFixture(boundary, databaseUrl, anonKey, entityToken, f) {
  try {
    const remove = paths => request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${entityToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    });
    const existingPaths = runPsql(databaseUrl, `SELECT name FROM storage.objects
      WHERE bucket_id='certificates' AND name IN (${f.storagePaths.map(storagePath => literal(storagePath)).join(',')})
      ORDER BY name;`).split(/\r?\n/).filter(Boolean);
    setEntityDepartment(databaseUrl, f.entityActor, f.leadEntity);
    const projectPaths = f.storagePaths.slice(0, 5).filter(storagePath => existingPaths.includes(storagePath));
    if (projectPaths.length) {
      const projectFiles = await remove(projectPaths);
      if (!success(projectFiles)) throw new Error(`D07 R02 Storage 项目文件清理失败：status=${projectFiles.status}`);
    }
    setEntityDepartment(databaseUrl, f.entityActor, f.outsideEntity);
    if (existingPaths.includes(f.crossPath)) {
      const crossFile = await remove([f.crossPath]);
      if (!success(crossFile)) throw new Error(`D07 R02 Storage 跨实体文件清理失败：status=${crossFile.status}`);
    }
  } finally {
    setEntityDepartment(databaseUrl, f.entityActor, f.leadEntity);
    runPsql(databaseUrl, 'DROP POLICY IF EXISTS d07_r02_storage_cleanup ON storage.objects;');
  }
}

function switchActor(databaseUrl, f, employeeId, departmentId, role = 'employee', adminLevel = null) {
  runPsql(databaseUrl, `UPDATE public.profiles SET role=${literal(role)}, admin_level=${adminLevel ? literal(adminLevel) : 'NULL'},
    is_super_admin=false, department_id=${literal(departmentId)}::uuid, employee_id=${literal(employeeId)}::uuid, updated_at=now()
    WHERE id=${literal(f.companyActor.id)}::uuid;`);
}

function restoreActor(databaseUrl, f) {
  const a = f.companyActor;
  runPsql(databaseUrl, `UPDATE public.profiles SET role=${literal(a.role)}, admin_level=${a.admin_level == null ? 'NULL' : literal(a.admin_level)},
    is_super_admin=${a.is_super_admin ? 'true' : 'false'}, department_id=${a.department_id ? `${literal(a.department_id)}::uuid` : 'NULL'},
    employee_id=${a.employee_id ? `${literal(a.employee_id)}::uuid` : 'NULL'}, updated_at=now()
    WHERE id=${literal(a.id)}::uuid;`);
}

function setProjectRole(databaseUrl, f, role = null, projectId = f.projectA) {
  runPsql(databaseUrl, `DELETE FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid) AND user_id=${literal(f.companyActor.id)}::uuid;
    ${role ? `INSERT INTO public.site_project_roles(id, project_id, user_id, role, active, assigned_by)
      VALUES (${literal(crypto.randomUUID())}::uuid, ${literal(projectId)}::uuid, ${literal(f.companyActor.id)}::uuid, ${literal(role)}, true, ${literal(f.entityActor)}::uuid);` : ''}`);
}

async function readOnlyRpcResults(boundary, anonKey, token, f) {
  return Promise.all([
    rpc(boundary, anonKey, token, 'training_admission_readiness_checklist', {
      p_project_id: f.projectA, p_employee_id: f.memberEmployee,
    }),
    rpc(boundary, anonKey, token, 'training_admission_timeline', {
      p_project_id: f.projectA, p_employee_id: f.memberEmployee,
    }),
    rpc(boundary, anonKey, token, 'training_admission_evidence', {
      p_project_id: f.projectA, p_employee_id: f.memberEmployee,
    }),
  ]);
}

function admissionSnapshot(databaseUrl, admissionId) {
  return runPsql(databaseUrl, `SELECT json_build_object('status', status, 'blocked_reason', blocked_reason,
    'updated_at', updated_at)::text FROM public.training_admissions WHERE id=${literal(admissionId)}::uuid;`);
}

async function storageReadableCount(boundary, anonKey, token, paths) {
  const responses = await Promise.all(paths.map(storagePath => request(
    boundary.apiOrigin,
    anonKey,
    `/storage/v1/object/sign/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 60 }),
    },
  )));
  return responses.filter(response => response.status === 200 && response.json?.signedURL).length;
}

async function publicReadCount(boundary, anonKey, token, f) {
  const checks = await Promise.all([
    restRows(boundary, anonKey, token, 'site_project_invites', [f.inviteA]),
    restRows(boundary, anonKey, token, 'contractor_contracts', [f.contractId]),
    restRows(boundary, anonKey, token, 'project_join_applications', [f.applicationId]),
    restRows(boundary, anonKey, token, 'project_join_application_attachments', [f.attachmentId]),
    restRows(boundary, anonKey, token, 'training_admission_reminders', [f.reminderId]),
    restRows(boundary, anonKey, token, 'training_verification_logs', [f.verificationA]),
    restRows(boundary, anonKey, token, 'training_personnel_reapproval_requests', [f.reapprovalId]),
  ]);
  return checks.every(rows => rows?.length === 1) ? checks.length : 0;
}

function verifyWeb() {
  const files = ['training.js', 'projects.js', 'admission-operations.js', 'admission-review.js', 'contractors.js', 'admission-verify.js'];
  const source = files.map(file => fs.readFileSync(path.join(root, 'js', 'modules', 'training', file), 'utf8')).join('\n');
  const context = {
    Auth: { currentUser: { id: 'user' }, currentProfile: {}, isAdmin: () => true, isSuperAdmin: () => false },
    Utils: { escapeHtml: value => String(value ?? '') }, sb: {}, console,
    document: { getElementById: () => null },
  };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'js/modules/training/training.js'), 'utf8')}\nthis.TrainingModule = TrainingModule;`, context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'js/modules/training/admission-operations.js'), 'utf8')}\nthis.TrainingAdmissionOperations = TrainingAdmissionOperations;`, context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'js/modules/training/admission-review.js'), 'utf8')}\nthis.TrainingAdmissionReview = TrainingAdmissionReview;`, context);
  vm.runInContext(`${fs.readFileSync(path.join(root, 'js/modules/training/contractors.js'), 'utf8')}\nthis.TrainingContractors = TrainingContractors;`, context);
  const module = context.TrainingModule;
  const projectA = { id: 'a', lead_entity_id: 'ent-a', status: 'active' };
  const projectX = { id: 'x', lead_entity_id: 'ent-b', status: 'active' };
  module.state.depts = [{ id: 'ent-a', dept_type: 'entity' }, { id: 'ent-b', dept_type: 'entity' }];
  context.Auth.isAdmin = () => module.state.profile.role === 'admin';

  const toolbarFor = (profile, roles, projects) => {
    module.state.profile = profile;
    module.state.fieldRoles = roles;
    const toolbar = { innerHTML: '' };
    context.document.getElementById = id => id === 'admission-op-toolbar' ? toolbar : null;
    context.TrainingAdmissionOperations.state.projects = projects;
    context.TrainingAdmissionOperations.state.filter = '';
    context.TrainingAdmissionOperations.renderToolbar();
    return toolbar.innerHTML;
  };

  const companyProfile = { role: 'admin', admin_level: 'company', department_id: 'company' };
  const outsideProfile = { role: 'admin', admin_level: 'dept', department_id: 'ent-b' };
  const leadProfile = { role: 'admin', admin_level: 'dept', department_id: 'ent-a' };
  const employeeProfile = { role: 'employee', admin_level: null, department_id: 'ent-a' };
  const managerRoles = [{ project_id: 'a', role: 'project_manager', active: true }];
  const safetyRoles = [{ project_id: 'a', role: 'safety_officer', active: true }];
  const companyToolbar = toolbarFor(companyProfile, [], [projectA]);
  const outsideToolbar = toolbarFor(outsideProfile, [], [projectA]);
  const leadToolbar = toolbarFor(leadProfile, [], [projectA]);
  const managerToolbar = toolbarFor(employeeProfile, managerRoles, [projectA]);
  const safetyToolbar = toolbarFor(employeeProfile, safetyRoles, [projectA]);

  const rowFor = (profile, roles) => {
    module.state.profile = profile;
    module.state.fieldRoles = roles;
    context.TrainingAdmissionOperations.state.projects = [projectA, projectX];
    context.TrainingAdmissionOperations.state.packages = [];
    context.TrainingAdmissionOperations.state.signatures = [];
    context.TrainingAdmissionOperations.state.accesses = [];
    return context.TrainingAdmissionOperations.row({
      m: { project_id: 'a', employee_id: 'employee-a', membership_type: 'internal' },
      e: { id: 'employee-a', name: '测试人员', position: '测试岗位' },
      a: null,
    });
  };
  const companyRow = rowFor(companyProfile, []);
  const outsideRow = rowFor(outsideProfile, []);
  const leadRow = rowFor(leadProfile, []);
  const managerRow = rowFor(employeeProfile, managerRoles);
  const safetyRow = rowFor(employeeProfile, safetyRoles);

  module.state.profile = companyProfile;
  module.state.fieldRoles = [];
  const company = !module.canManageProject(projectA) && !module.canManageAnyProject([projectA])
    && !/generateDueReminders|openBatchRemind|openStartForm/.test(companyToolbar);
  module.state.profile = outsideProfile;
  const outside = !module.canManageProject(projectA) && module.canManageProject(projectX)
    && !/generateDueReminders|openBatchRemind|openStartForm/.test(outsideToolbar);
  module.state.profile = leadProfile;
  const lead = module.canManageProject(projectA) && !module.canManageProject(projectX)
    && /generateDueReminders/.test(leadToolbar);
  module.state.profile = employeeProfile;
  module.state.fieldRoles = managerRoles;
  const manager = module.canManageProject(projectA) && !module.canManageProject(projectX)
    && /openStartForm/.test(managerToolbar);
  module.state.fieldRoles = safetyRoles;
  const safety = module.canManageProject(projectA) && !module.canManageProject(projectX)
    && /openBatchRemind/.test(safetyToolbar);
  const readWriteSplit = /openReadiness|openTimeline/.test(companyRow)
    && !/openStartForm|recompute|openConfirm|openTemporary/.test(companyRow)
    && !/openReadiness|openTimeline|openStartForm/.test(outsideRow)
    && [leadRow, managerRow, safetyRow].every(row => /openReadiness/.test(row) && /openStartForm/.test(row));

  context.TrainingAdmissionReview.state.projects = [projectA, projectX];
  module.state.profile = companyProfile;
  module.state.fieldRoles = [];
  const companyReview = !/TrainingAdmissionReview\.review/.test(context.TrainingAdmissionReview.actionButtons({ id: 'app', project_id: 'a', status: 'pending_project_review' }));
  module.state.profile = outsideProfile;
  const outsideReview = !/TrainingAdmissionReview\.review/.test(context.TrainingAdmissionReview.actionButtons({ id: 'app', project_id: 'a', status: 'pending_project_review' }));
  module.state.profile = leadProfile;
  const leadReview = /TrainingAdmissionReview\.review/.test(context.TrainingAdmissionReview.actionButtons({ id: 'app', project_id: 'a', status: 'pending_project_review' }));

  const entries = /p\.status === 'active' && TrainingModule\.canManageProject\(p\)/.test(source)
    && /TrainingModule\.canManageProject\(this\.project\(app\.project_id\)\)/.test(source)
    && /TrainingModule\.canManageProject\(this\.project\(m\.project_id\)\)/.test(source)
    && /TrainingModule\.canManageProject\(this\.project\(d\.project_id\)\)/.test(source)
    && /TrainingModule\.canManageAnyProject\(this\.state\.projects\)/.test(source)
    && /const canManage = TrainingModule\.canManageAnyProject\(this\.state\.projects\)/.test(source)
    && !/canManageAdmission\(/.test(source);
  return { company: company && companyReview, outside: outside && outsideReview, lead: lead && leadReview, manager, safety, entries, readWriteSplit };
}

function residueCount(databaseUrl, f) {
  const businessResidue = Number.parseInt(runPsql(databaseUrl, `SELECT
    (SELECT count(*) FROM storage.objects WHERE name IN (${f.storagePaths.map(storagePath => literal(storagePath)).join(',')}))
    + (SELECT count(*) FROM public.site_projects WHERE id=${literal(f.projectX)}::uuid)
    + (SELECT count(*) FROM public.training_employees WHERE id=${literal(f.visitorEmployee)}::uuid)
    + (SELECT count(*) FROM public.training_admission_packages WHERE id=${literal(f.packageId)}::uuid)
    + (SELECT count(*) FROM public.training_admissions WHERE id IN (${literal(f.admissionId)}::uuid, ${literal(f.externalAdmissionId)}::uuid))
    + (SELECT count(*) FROM public.site_project_invites WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid))
    + (SELECT count(*) FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid) AND user_id=${literal(f.companyActor.id)}::uuid)
    + (SELECT count(*) FROM public.contractor_contracts WHERE id=${literal(f.contractId)}::uuid)
    + (SELECT count(*) FROM public.project_join_applications WHERE id=${literal(f.applicationId)}::uuid)
    + (SELECT count(*) FROM public.project_join_application_attachments WHERE id=${literal(f.attachmentId)}::uuid)
    + (SELECT count(*) FROM public.training_admission_reminders WHERE id=${literal(f.reminderId)}::uuid)
    + (SELECT count(*) FROM public.training_verification_logs WHERE id IN (${literal(f.verificationA)}::uuid, ${literal(f.verificationX)}::uuid))
    + (SELECT count(*) FROM public.training_personnel_reapproval_requests WHERE id=${literal(f.reapprovalId)}::uuid);`), 10);
  return businessResidue + auditResidueCount(databaseUrl, f);
}

function auditResidueCount(databaseUrl, f) {
  const ids = (f.cleanupAuditEntityIds || [f.projectX]).map(id => `${literal(id)}::uuid`).join(',');
  return Number.parseInt(runPsql(databaseUrl, `SELECT count(*) FROM public.site_project_audit_logs
    WHERE entity_id IN (${ids})
       OR (entity_type='site_projects' AND action='delete'
           AND detail->'old'->>'project_code'=${literal(`D07-R02-X-${f.suffix}`)}
           AND detail->'old'->>'report_notes'='D07-TEST');`), 10);
}

function cleanup(databaseUrl, f) {
  restoreActor(databaseUrl, f);
  const entityIds = runPsql(databaseUrl, `SELECT COALESCE(string_agg(id::text, ','), '') FROM (
    SELECT id FROM public.site_project_invites WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid)
    UNION SELECT id FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid) AND user_id=${literal(f.companyActor.id)}::uuid
    UNION SELECT ${literal(f.projectX)}::uuid
  ) x;`).split(',').filter(Boolean);
  f.cleanupAuditEntityIds = entityIds;
  runPsql(databaseUrl, `
BEGIN;
DELETE FROM public.training_personnel_reapproval_requests WHERE id=${literal(f.reapprovalId)}::uuid;
DELETE FROM public.training_verification_logs WHERE id IN (${literal(f.verificationA)}::uuid, ${literal(f.verificationX)}::uuid);
DELETE FROM public.training_admission_reminders WHERE id=${literal(f.reminderId)}::uuid;
DELETE FROM public.project_join_application_attachments WHERE id=${literal(f.attachmentId)}::uuid;
DELETE FROM public.project_join_applications WHERE id=${literal(f.applicationId)}::uuid;
DELETE FROM public.contractor_contracts WHERE id=${literal(f.contractId)}::uuid;
DELETE FROM public.training_admissions WHERE id IN (${literal(f.admissionId)}::uuid, ${literal(f.externalAdmissionId)}::uuid);
DELETE FROM public.training_admission_packages WHERE id=${literal(f.packageId)}::uuid;
DELETE FROM public.site_project_roles WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid) AND user_id=${literal(f.companyActor.id)}::uuid;
DELETE FROM public.site_project_invites WHERE project_id IN (${literal(f.projectA)}::uuid, ${literal(f.projectX)}::uuid);
DELETE FROM public.site_project_entities WHERE project_id=${literal(f.projectX)}::uuid;
DELETE FROM public.site_projects WHERE id=${literal(f.projectX)}::uuid;
DELETE FROM public.training_employees WHERE id=${literal(f.visitorEmployee)}::uuid;
COMMIT;`);
  // 项目删除审计由延迟触发器在事务提交时写入，必须在提交后的独立事务中精确清理测试实体。
  runPsql(databaseUrl, `DELETE FROM public.site_project_audit_logs
    WHERE entity_id IN (${entityIds.map(id => `${literal(id)}::uuid`).join(',')});`);
  return residueCount(databaseUrl, f);
}

function removeOrphanedD07R02Audit(databaseUrl) {
  runPsql(databaseUrl, `DELETE FROM public.site_project_audit_logs
    WHERE action='delete'
      AND entity_type='site_projects'
      AND project_id IS NULL
      AND detail->'old'->>'project_code' LIKE 'D07-R02-X-%'
      AND detail->'old'->>'report_notes'='D07-TEST';`);
}

function cleanupResidueBreakdown(databaseUrl, f) {
  return JSON.parse(runPsql(databaseUrl, `SELECT json_build_object(
    'storage', (SELECT count(*) FROM storage.objects WHERE name IN (${f.storagePaths.map(storagePath => literal(storagePath)).join(',')})),
    'business',
      (SELECT count(*) FROM public.site_projects WHERE id=${literal(f.projectX)}::uuid)
      + (SELECT count(*) FROM public.training_employees WHERE id=${literal(f.visitorEmployee)}::uuid)
      + (SELECT count(*) FROM public.training_admission_packages WHERE id=${literal(f.packageId)}::uuid)
      + (SELECT count(*) FROM public.training_admissions WHERE id IN (${literal(f.admissionId)}::uuid, ${literal(f.externalAdmissionId)}::uuid))
      + (SELECT count(*) FROM public.site_project_invites WHERE token_hash LIKE ${literal(`d07-r02-%-${f.suffix}`)})
      + (SELECT count(*) FROM public.contractor_contracts WHERE id=${literal(f.contractId)}::uuid)
      + (SELECT count(*) FROM public.project_join_applications WHERE id=${literal(f.applicationId)}::uuid)
      + (SELECT count(*) FROM public.project_join_application_attachments WHERE id=${literal(f.attachmentId)}::uuid)
      + (SELECT count(*) FROM public.training_admission_reminders WHERE id=${literal(f.reminderId)}::uuid)
      + (SELECT count(*) FROM public.training_verification_logs WHERE id IN (${literal(f.verificationA)}::uuid, ${literal(f.verificationX)}::uuid))
      + (SELECT count(*) FROM public.training_personnel_reapproval_requests WHERE id=${literal(f.reapprovalId)}::uuid),
    'policy', (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='d07_r02_storage_cleanup'),
    'audit', (SELECT count(*) FROM public.site_project_audit_logs
      WHERE action='delete' AND entity_type='site_projects' AND project_id IS NULL
        AND detail->'old'->>'project_code' LIKE 'D07-R02-X-%'
        AND detail->'old'->>'report_notes'='D07-TEST')
  )::text;`));
}

async function storageUploadFocusedMain() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  check('D07-R02-UPLOAD-00 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 最小上传初始化');
  const base = readBase(boundary.databaseUrl);
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const [company, entity] = await Promise.all([
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
    login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
  ]);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const objectPath = `training-admission/join-applications/${crypto.randomUUID()}/photo/D07R02-${suffix}.png`;
  const anonPath = `training-admission/join-applications/${crypto.randomUUID()}/photo/D07R02-${suffix}-ANON.png`;
  const ordinaryPath = `signatures/${crypto.randomUUID()}_${suffix}.png`;
  const upload = pathName => request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${pathName.split('/').map(encodeURIComponent).join('/')}`,
    { method: 'POST', headers: { Authorization: `Bearer ${entity.token}`, 'Content-Type': 'image/png', 'x-upsert': 'false' }, body: Buffer.from('D07 R02 upload smoke') });
  let primaryUpload;
  let deleteResponse;
  try {
    primaryUpload = await upload(objectPath);
    check('D07-R02-UPLOAD-A 首次上传成功', success(primaryUpload), `status=${primaryUpload.status}`);

    const anonUpload = await request(boundary.apiOrigin, anonKey,
      `/storage/v1/object/certificates/${anonPath.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'POST', headers: { Authorization: `Bearer ${anonKey}`, 'Content-Type': 'image/png', 'x-upsert': 'false' }, body: Buffer.from('D07 R02 anon deny') });

    const actor = { companyActor: base.company_actor, leadEntity: base.lead_entity };
    switchActor(boundary.databaseUrl, actor, base.ordinary_employee, base.lead_entity);
    let ordinaryUpload;
    try {
      ordinaryUpload = await request(boundary.apiOrigin, anonKey,
        `/storage/v1/object/training-courses/${ordinaryPath.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'POST', headers: { Authorization: `Bearer ${company.token}`, 'Content-Type': 'image/png', 'x-upsert': 'false' }, body: Buffer.from('D07 R02 ordinary deny') });
    } finally {
      restoreActor(boundary.databaseUrl, actor);
    }
    check('D07-R02-UPLOAD-B anon 与无权账号未获得额外上传权限', !success(anonUpload) && !success(ordinaryUpload),
      `anon=${anonUpload.status} ordinary=${ordinaryUpload.status}`);
  } finally {
    restoreActor(boundary.databaseUrl, { companyActor: base.company_actor });
    const exists = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT count(*) FROM storage.objects
      WHERE bucket_id='certificates' AND name=${literal(objectPath)};`), 10);
    if (exists > 0) {
      deleteResponse = await request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
        method: 'DELETE', headers: { Authorization: `Bearer ${company.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [objectPath] }),
      });
    }
  }
  const residue = Number.parseInt(runPsql(boundary.databaseUrl, `SELECT
    (SELECT count(*) FROM storage.objects WHERE (bucket_id='certificates' AND name IN (${literal(objectPath)},${literal(anonPath)}))
      OR (bucket_id='training-courses' AND name=${literal(ordinaryPath)}))
    + (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='d07_r02_storage_cleanup');`), 10);
  check('D07-R02-UPLOAD-C 上传对象可删除且无 Storage/临时策略残留', success(primaryUpload) && success(deleteResponse) && residue === 0,
    `delete=${deleteResponse?.status || '-'} residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_UPLOAD_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

async function cleanupFailureFocusedMain() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  check('D07-R02-CLEANUP-00 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  removeOrphanedD07R02Audit(boundary.databaseUrl);
  const base = readBase(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
  const f = {
    suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
    contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
    companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
    ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
    projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
    contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
    verificationX: ids[11], reapprovalId: ids[12], externalAdmissionId: ids[19],
  };
  f.joinPhoto = `training-admission/join-applications/${suffix}/photo.png`;
  f.joinAttachment = `training-admission/join-applications/${suffix}/attachment.pdf`;
  f.contractPath = `training-admission/contractor-contracts/${f.projectA}/${suffix}.pdf`;
  f.confirmationPath = `training-admission/site-confirmations/${f.projectA}/${suffix}.png`;
  f.signaturePath = `training-admission/signatures/${f.admissionId}/${suffix}.png`;
  f.crossPath = `training-admission/contractor-documents/${f.projectX}/${suffix}.pdf`;
  f.storagePaths = [f.joinPhoto, f.joinAttachment, f.contractPath, f.confirmationPath, f.signaturePath, f.crossPath];
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  const entity = await login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD'));
  let expectedFailure = false;
  try {
    createFixture(boundary.databaseUrl, f);
    createStorageCleanupPolicy(boundary.databaseUrl, f);
    throw new Error('D07 R02 人为触发夹具失败');
  } catch (error) {
    expectedFailure = error.message === 'D07 R02 人为触发夹具失败';
  } finally {
    await removeStorageFixture(boundary, boundary.databaseUrl, anonKey, entity.token, f);
    cleanup(boundary.databaseUrl, f);
  }
  const residue = cleanupResidueBreakdown(boundary.databaseUrl, f);
  check('D07-R02-CLEANUP-A 人为失败后业务/Storage/策略/测试审计残留均为零', expectedFailure
    && residue.business === 0 && residue.storage === 0 && residue.policy === 0 && residue.audit === 0,
  `business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_CLEANUP_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

async function v66PreAssertionDiagnosticMain() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  let base;
  let f;
  let anonKey = '';
  let company;
  let entity;
  let fixtureStarted = false;
  let storageSetupStarted = false;
  let diagnosticError;
  let residue = { storage: 0, business: 0, policy: 0, audit: 0 };

  try {
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_01_FIXTURE_GATE', 'SQL fixture marker SELECT',
      () => assertD02FixtureMarker(boundary));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_02_APPLY_V64', 'PSQL FILE v64',
      () => applySqlFile(boundary.databaseUrl, v64Path, 'v64 诊断迁移'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_03_APPLY_V65', 'PSQL FILE v65',
      () => applySqlFile(boundary.databaseUrl, v65Path, 'v65 诊断迁移'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_04_APPLY_V66', 'PSQL FILE v66',
      () => applySqlFile(boundary.databaseUrl, v66Path, 'v66 诊断迁移'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_05_STORAGE_INITIALIZER_BEFORE', 'PSQL FILE Storage initializer',
      () => applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 诊断前初始化'));
    base = await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_06_READ_BASE', 'SQL fixture base SELECT',
      () => readBase(boundary.databaseUrl));
    await loggedStep('D07_DIAG_07_BUILD_LOCAL_FIXTURE', 'LOCAL memory only', () => {
      const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
      f = {
        suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
        contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
        companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
        ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
        projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
        contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
        verificationX: ids[11], reapprovalId: ids[12], externalAdmissionId: ids[19],
      };
      f.joinPhoto = `training-admission/join-applications/${suffix}/photo.png`;
      f.joinAttachment = `training-admission/join-applications/${suffix}/attachment.pdf`;
      f.contractPath = `training-admission/contractor-contracts/${f.projectA}/${suffix}.pdf`;
      f.confirmationPath = `training-admission/site-confirmations/${f.projectA}/${suffix}.png`;
      f.signaturePath = `training-admission/signatures/${f.admissionId}/${suffix}.png`;
      f.crossPath = `training-admission/contractor-documents/${f.projectX}/${suffix}.pdf`;
      f.storagePaths = [f.joinPhoto, f.joinAttachment, f.contractPath, f.confirmationPath, f.signaturePath, f.crossPath];
    });
    await loggedStep('D07_DIAG_08_LOAD_PUBLIC_TEST_CONFIG', 'LOCAL environment presence only', () => {
      anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    });
    company = await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_09_LOGIN_COMPANY', 'HTTP Auth login',
      () => login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')));
    entity = await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_10_LOGIN_ENTITY', 'HTTP Auth login',
      () => login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')));
    fixtureStarted = true;
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_11_CREATE_BUSINESS_FIXTURE', 'SQL transactional INSERT fixture',
      () => createFixture(boundary.databaseUrl, f));
    storageSetupStarted = true;
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_12_CREATE_TEMP_DELETE_POLICY', 'SQL application policy DDL',
      () => createStorageCleanupPolicy(boundary.databaseUrl, f));
    for (const [index, storagePath] of f.storagePaths.slice(0, 5).entries()) {
      await diagnosedStep(boundary.databaseUrl, `D07_DIAG_${13 + index}_UPLOAD_${index + 1}`, 'HTTP Storage upload',
        () => uploadStorage(boundary, anonKey, entity.token, storagePath));
    }
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_18_SWITCH_ENTITY_OUTSIDE', 'SQL profile test-scope UPDATE',
      () => setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity));
    try {
      await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_19_UPLOAD_CROSS_ENTITY', 'HTTP Storage upload',
        () => uploadStorage(boundary, anonKey, entity.token, f.crossPath));
    } finally {
      await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_20_RESTORE_ENTITY', 'SQL profile restore UPDATE',
        () => setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity));
    }
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_21_STORAGE_INITIALIZER_AFTER', 'PSQL FILE Storage initializer',
      () => applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 恢复初始化'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_22_FUNCTION_ACL_READ', 'SQL function ACL SELECT', () => runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'public',has_function_privilege('public','public.training_is_company_admin()','EXECUTE'),
      'anon',has_function_privilege('anon','public.training_is_company_admin()','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.training_is_company_admin()','EXECUTE'))::text;`));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_23_RPC_COMPANY_ADMIN', 'HTTP RPC training_is_company_admin',
      () => rpc(boundary, anonKey, company.token, 'training_is_company_admin'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_24_RPC_ANON', 'HTTP RPC training_is_company_admin',
      () => rpc(boundary, anonKey, anonKey, 'training_is_company_admin'));
    await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_25_SWITCH_COMPANY_TO_ORDINARY', 'SQL profile test-scope UPDATE',
      () => switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity));
    try {
      await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_26_RPC_ORDINARY', 'HTTP RPC training_is_company_admin',
        () => rpc(boundary, anonKey, company.token, 'training_is_company_admin'));
    } finally {
      await diagnosedStep(boundary.databaseUrl, 'D07_DIAG_27_RESTORE_COMPANY', 'SQL profile restore UPDATE',
        () => restoreActor(boundary.databaseUrl, f));
    }
    console.log('DIAG_PRE_ASSERTION_COMPLETE first_permission_assertion_not_executed=true');
  } catch (error) {
    diagnosticError = error;
    console.log(`DIAG_FIRST_FAILURE error=${safeDiagnosticMessage(error)}`);
  } finally {
    if (base && f) {
      try {
        restoreActor(boundary.databaseUrl, f);
        setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
        if (storageSetupStarted && entity?.token) await removeStorageFixture(boundary, boundary.databaseUrl, anonKey, entity.token, f);
        if (fixtureStarted) cleanup(boundary.databaseUrl, f);
        residue = cleanupResidueBreakdown(boundary.databaseUrl, f);
      } catch (cleanupError) {
        console.log(`DIAG_CLEANUP_FAILURE error=${safeDiagnosticMessage(cleanupError)}`);
        if (!diagnosticError) diagnosticError = cleanupError;
      }
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D07_R02_PREASSERT_DIAG_SUMMARY status=${diagnosticError ? 'FAIL' : 'PASS'} business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (diagnosticError) process.exitCode = 1;
}

async function databaseConnectionMinimalMain() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  const anonKey = required('SAFETY_SUPABASE_ANON_KEY');
  await loggedStep('D07_DB_MIN_01_LIVE_BEFORE', 'SQL SELECT 1 retry-safe',
    () => ensureDatabaseAlive(boundary.databaseUrl));
  await loggedStep('D07_DB_MIN_02_LOGIN_ENTITY', 'HTTP Auth login',
    () => login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')));
  await loggedStep('D07_DB_MIN_03_LIVE_AFTER', 'SQL SELECT 1 retry-safe',
    () => ensureDatabaseAlive(boundary.databaseUrl));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`D07_DB_CONNECTION_MINIMAL_SUMMARY status=PASS residue=0 elapsed_ms=${elapsedMs.toFixed(0)}`);
}

async function focusedV66Main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  check('D07-R02-V66-00 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigrations(boundary.databaseUrl);
  applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 测试前初始化');
  const base = readBase(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
  const f = {
    suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
    contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
    companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
    ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
    projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
    contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
    verificationX: ids[11], reapprovalId: ids[12], storageJoinPhoto: ids[13], storageJoinAttachment: ids[14],
    storageContract: ids[15], storageConfirmation: ids[16], storageSignature: ids[17], storageCross: ids[18],
    externalAdmissionId: ids[19],
  };
  f.joinPhoto = `training-admission/join-applications/${suffix}/photo.png`;
  f.joinAttachment = `training-admission/join-applications/${suffix}/attachment.pdf`;
  f.contractPath = `training-admission/contractor-contracts/${f.projectA}/${suffix}.pdf`;
  f.confirmationPath = `training-admission/site-confirmations/${f.projectA}/${suffix}.png`;
  f.signaturePath = `training-admission/signatures/${f.admissionId}/${suffix}.png`;
  f.crossPath = `training-admission/contractor-documents/${f.projectX}/${suffix}.pdf`;
  f.storagePaths = [f.joinPhoto, f.joinAttachment, f.contractPath, f.confirmationPath, f.signaturePath, f.crossPath];
  let residue = -1;
  let anonKey = '';
  let entityToken = '';
  let storageSetupStarted = false;

  try {
    anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    entityToken = entity.token;
    await ensureDatabaseAlive(boundary.databaseUrl);
    createFixture(boundary.databaseUrl, f);
    storageSetupStarted = true;
    await createStorageFixture(boundary, boundary.databaseUrl, anonKey, entity.token, f);
    applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 恢复初始化');

    const acl = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'public',has_function_privilege('public','public.training_is_company_admin()','EXECUTE'),
      'anon',has_function_privilege('anon','public.training_is_company_admin()','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.training_is_company_admin()','EXECUTE'))::text;`));
    const companyCheck = await rpc(boundary, anonKey, company.token, 'training_is_company_admin');
    const anonCheck = await rpc(boundary, anonKey, anonKey, 'training_is_company_admin');
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryCheck = await rpc(boundary, anonKey, company.token, 'training_is_company_admin');
    restoreActor(boundary.databaseUrl, f);
    check('D07-R02-V66-A 函数仅向 authenticated 开放且不产生角色提升', !acl.public && !acl.anon && acl.authenticated
      && success(companyCheck) && companyCheck.json === true
      && success(ordinaryCheck) && ordinaryCheck.json === false && !success(anonCheck),
    `company=${companyCheck.status} ordinary=${ordinaryCheck.status} anon=${anonCheck.status}`);

    const companyStorage = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryStorage = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths);
    switchActor(boundary.databaseUrl, f, f.visitorEmployee, f.outsideEntity, 'admin', 'dept');
    const outsideStorageA = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths.slice(0, 5));
    const outsideStorageX = await storageReadableCount(boundary, anonKey, company.token, [f.crossPath]);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerStorageA = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths.slice(0, 5));
    const managerStorageX = await storageReadableCount(boundary, anonKey, company.token, [f.crossPath]);
    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyStorageA = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths.slice(0, 5));
    const anonStorage = await storageReadableCount(boundary, anonKey, anonKey, f.storagePaths);
    setProjectRole(boundary.databaseUrl, f);
    restoreActor(boundary.databaseUrl, f);
    check('D07-R02-V66-B Storage 公司级只读恢复且跨项目/跨实体不放宽', companyStorage === 6
      && ordinaryStorage === 0 && outsideStorageA === 0 && outsideStorageX === 1
      && managerStorageA === 5 && managerStorageX === 0 && safetyStorageA === 5 && anonStorage === 0,
    `company=${companyStorage}/6 ordinary=${ordinaryStorage}/6 outsideA=${outsideStorageA}/5 managerA=${managerStorageA}/5 safetyA=${safetyStorageA}/5 anon=${anonStorage}/6`);

    const companyEvidence = await rpc(boundary, anonKey, company.token, 'training_admission_evidence', {
      p_project_id: f.projectA, p_employee_id: f.memberEmployee,
    });
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryEvidence = await rpc(boundary, anonKey, company.token, 'training_admission_evidence', {
      p_project_id: f.projectA, p_employee_id: f.memberEmployee,
    });
    restoreActor(boundary.databaseUrl, f);
    check('D07-R02-V66-C 电子证据只读 RPC 最小复现通过', success(companyEvidence) && Array.isArray(companyEvidence.json)
      && denied(ordinaryEvidence, '您无权查看该项目人员的准入电子证据'),
    `company_http=${companyEvidence.status} ordinary_http=${ordinaryEvidence.status} ordinary_code=${ordinaryEvidence.json?.code || '-'}`);

    const entityRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    setProjectRole(boundary.databaseUrl, f);
    restoreActor(boundary.databaseUrl, f);
    const snapshotBeforeDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    const companyRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossEntityRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager', f.projectX);
    const unauthorizedRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', {
      p_project_id: f.projectA, p_contractor_id: f.contractor,
    });
    const snapshotAfterDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    check('D07-R02-V66-D 写 RPC 合法/拒绝组合及失败原子性通过', success(entityRefresh) && success(managerRefresh) && success(safetyRefresh)
      && denied(companyRefresh, '您无权刷新该项目外协资格')
      && denied(crossEntityRefresh, '您无权刷新该项目外协资格')
      && denied(unauthorizedRefresh, '您无权刷新该项目外协资格')
      && snapshotBeforeDenied === snapshotAfterDenied);
  } finally {
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    if (storageSetupStarted) await removeStorageFixture(boundary, boundary.databaseUrl, anonKey, entityToken, f);
    residue = cleanup(boundary.databaseUrl, f);
    for (let attempt = 0; residue > 0 && attempt < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      residue = residueCount(boundary.databaseUrl, f);
    }
  }

  check('D07-R02-V66-E 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_V66_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

async function focusedV67Main() {
  const started = process.hrtime.bigint();
  const storageOnly = process.argv.includes('--v67-storage-focused') || process.argv.includes('--v67-storage-delete-focused');
  const storageDeleteOnly = process.argv.includes('--v67-storage-delete-focused');
  const boundary = validateTestBoundary();
  check('D07-R02-V67-00 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigrations(boundary.databaseUrl);
  applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage v67 恢复初始化');
  const base = readBase(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const ids = Array.from({ length: 30 }, () => crypto.randomUUID());
  const f = {
    suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
    contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
    companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
    ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
    projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
    contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
    verificationX: ids[11], reapprovalId: ids[12], externalAdmissionId: ids[19],
    documentIds: ids.slice(20, 24),
  };
  const storageBase = `training-admission/contractor-documents/${f.projectA}/D07-V67-${suffix}.pdf`;
  const storageCandidates = ['company', 'cross', 'ordinary', 'anon'].map(label =>
    `training-admission/contractor-documents/${f.projectA}/D07-V67-${suffix}-${label}.pdf`);
  const managerPath = `training-admission/contractor-documents/${f.projectA}/D07-V67-${suffix}-manager.pdf`;
  const safetyPath = `training-admission/contractor-documents/${f.projectA}/D07-V67-${suffix}-safety.pdf`;
  f.storagePaths = [storageBase, managerPath, safetyPath, ...storageCandidates];
  let anonKey = '';
  let entityToken = '';
  let residue = { business: -1, storage: -1, policy: -1, audit: -1 };

  const restMutation = (token, method, id, body) => request(boundary.apiOrigin, anonKey,
    `/rest/v1/contractor_documents${id ? `?id=eq.${encodeURIComponent(id)}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: body == null ? undefined : JSON.stringify(body),
    });
  const inserted = response => success(response) && Array.isArray(response.json) && response.json.length === 1;
  const blockedMutation = response => denied(response)
    || (success(response) && Array.isArray(response.json) && response.json.length === 0);
  const docPayload = id => ({
    id, project_id: f.projectA, contractor_id: f.contractor, document_type: 'qualification',
    storage_path: `training-admission/contractor-documents/${f.projectA}/${id}.pdf`, review_status: 'pending',
  });
  const documentFingerprint = id => runPsql(boundary.databaseUrl,
    `SELECT row_to_json(x)::text FROM (SELECT id, project_id, review_status, review_note, storage_path FROM public.contractor_documents WHERE id=${literal(id)}::uuid) x;`);
  const storageUpload = (token, storagePath, content, upsert = false) => request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'x-upsert': String(upsert) },
      body: Buffer.from(content),
    });
  const storageDelete = (token, storagePath) => request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [storagePath] }),
  });
  const storageFingerprint = storagePath => runPsql(boundary.databaseUrl,
    `SELECT COALESCE(json_build_object('id',id,'name',name,'updated_at',updated_at,'metadata',metadata)::text,'') FROM storage.objects WHERE bucket_id='certificates' AND name=${literal(storagePath)};`);
  const deniedStorageTriple = async (token, candidatePath) => {
    const before = storageFingerprint(storageBase);
    const upload = await storageUpload(token, candidatePath, 'blocked upload');
    const update = await storageUpload(token, storageBase, 'blocked overwrite payload', true);
    const remove = await storageDelete(token, storageBase);
    const after = storageFingerprint(storageBase);
    return {
      pass: denied(upload) && denied(update) && (denied(remove) || success(remove)) && before && before === after,
      status: [upload.status, update.status, remove.status], fingerprint: Boolean(before && before === after),
    };
  };
  const exerciseRoleStorage = async (token, storagePath) => {
    const upload = await storageUpload(token, storagePath, 'legal upload');
    const update = await storageUpload(token, storagePath, 'legal overwrite with changed length', true);
    const remove = await storageDelete(token, storagePath);
    return {
      pass: success(upload) && success(update) && success(remove) && storageFingerprint(storagePath) === '',
      status: [upload.status, update.status, remove.status],
    };
  };
  const cleanupStorage = async () => {
    const exact = f.storagePaths.map(storagePath => literal(storagePath)).join(',');
    runPsql(boundary.databaseUrl, `DROP POLICY IF EXISTS d07_v67_storage_cleanup ON storage.objects;
      CREATE POLICY d07_v67_storage_cleanup ON storage.objects FOR DELETE TO authenticated USING (bucket_id='certificates' AND name IN (${exact}));`);
    try {
      const existing = runPsql(boundary.databaseUrl, `SELECT name FROM storage.objects WHERE bucket_id='certificates' AND name IN (${exact}) ORDER BY name;`)
        .split(/\r?\n/).filter(Boolean);
      if (existing.length) {
        const response = await request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
          method: 'DELETE', headers: { Authorization: `Bearer ${entityToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: existing }),
        });
        if (!success(response)) throw new Error(`D07 v67 Storage 清理失败：status=${response.status}`);
      }
    } finally {
      runPsql(boundary.databaseUrl, 'DROP POLICY IF EXISTS d07_v67_storage_cleanup ON storage.objects;');
    }
  };

  try {
    anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    entityToken = entity.token;
    check('D07-R02-V67-01 测试账号与夹具一致', company.userId === f.companyActor.id && entity.userId === f.entityActor);
    createFixture(boundary.databaseUrl, f);
    if (!storageOnly) {
    runPsql(boundary.databaseUrl, `UPDATE public.training_admissions SET status='eligible', valid_until=current_date-1,
      retrain_required=false, retrain_reason=NULL, blocked_reason=NULL, updated_at=now()
      WHERE id IN (${literal(f.admissionId)}::uuid,${literal(f.externalAdmissionId)}::uuid);`);

    const entityRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const entityRecompute = await rpc(boundary, anonKey, entity.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const managerRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const safetyRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    setProjectRole(boundary.databaseUrl, f);
    restoreActor(boundary.databaseUrl, f);

    runPsql(boundary.databaseUrl, `UPDATE public.training_admissions SET status='pending', retrain_required=false,
      retrain_reason=NULL, blocked_reason='D07-V67-FINGERPRINT', updated_at='2026-01-01T00:00:00Z'
      WHERE id=${literal(f.externalAdmissionId)}::uuid;`);
    const admissionBeforeDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    const companyRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const companyRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const crossRecompute = await rpc(boundary, anonKey, entity.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager', f.projectX);
    const unauthorizedRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_expired_admissions', { p_project_id: f.projectA });
    const unauthorizedRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.externalAdmissionId });
    setProjectRole(boundary.databaseUrl, f);
    restoreActor(boundary.databaseUrl, f);
    const admissionAfterDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    check('D07-R02-V67-A 两个写 RPC 按具体项目鉴权且失败原子',
      [entityRefresh, entityRecompute, managerRefresh, managerRecompute, safetyRefresh, safetyRecompute].every(success)
      && denied(companyRefresh) && denied(companyRecompute) && denied(crossRefresh) && denied(crossRecompute)
      && denied(unauthorizedRefresh) && denied(unauthorizedRecompute)
      && admissionBeforeDenied === admissionAfterDenied);

    const legalDocInsert = await restMutation(entity.token, 'POST', '', docPayload(f.documentIds[0]));
    const legalDocUpdate = await restMutation(entity.token, 'PATCH', f.documentIds[0], { review_note: 'D07 V67 legal update' });
    const documentBeforeDenied = documentFingerprint(f.documentIds[0]);
    const companyDocInsert = await restMutation(company.token, 'POST', '', docPayload(f.documentIds[1]));
    const companyDocUpdate = await restMutation(company.token, 'PATCH', f.documentIds[0], { review_note: 'company denied' });
    const companyDocDelete = await restMutation(company.token, 'DELETE', f.documentIds[0]);
    const companyDocRead = await restRows(boundary, anonKey, company.token, 'contractor_documents', [f.documentIds[0]]);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossDocInsert = await restMutation(entity.token, 'POST', '', docPayload(f.documentIds[2]));
    const crossDocUpdate = await restMutation(entity.token, 'PATCH', f.documentIds[0], { review_note: 'cross denied' });
    const crossDocDelete = await restMutation(entity.token, 'DELETE', f.documentIds[0]);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryDocInsert = await restMutation(company.token, 'POST', '', docPayload(f.documentIds[3]));
    const ordinaryDocUpdate = await restMutation(company.token, 'PATCH', f.documentIds[0], { review_note: 'ordinary denied' });
    const ordinaryDocDelete = await restMutation(company.token, 'DELETE', f.documentIds[0]);
    restoreActor(boundary.databaseUrl, f);
    const documentAfterDenied = documentFingerprint(f.documentIds[0]);
    const legalDocDelete = await restMutation(entity.token, 'DELETE', f.documentIds[0]);
    check('D07-R02-V67-B contractor_documents 项目写 RLS 收口且只读不回退',
      inserted(legalDocInsert) && inserted(legalDocUpdate) && inserted(legalDocDelete)
      && blockedMutation(companyDocInsert) && blockedMutation(companyDocUpdate) && blockedMutation(companyDocDelete)
      && blockedMutation(crossDocInsert) && blockedMutation(crossDocUpdate) && blockedMutation(crossDocDelete)
      && blockedMutation(ordinaryDocInsert) && blockedMutation(ordinaryDocUpdate) && blockedMutation(ordinaryDocDelete)
      && companyDocRead?.length === 1 && documentBeforeDenied === documentAfterDenied);
    }

    if (storageDeleteOnly) {
      const upload = await storageUpload(entity.token, storageBase, 'delete boundary fixture');
      const before = storageFingerprint(storageBase);
      const blockedDelete = await storageDelete(company.token, storageBase);
      const after = storageFingerprint(storageBase);
      const legalDelete = await storageDelete(entity.token, storageBase);
      check('D07-R02-V67-C1 Storage 未授权 DELETE 为零行操作且对象保持不变', success(upload)
        && (denied(blockedDelete) || success(blockedDelete)) && before && before === after
        && success(legalDelete) && storageFingerprint(storageBase) === '',
      `upload=${upload.status} blocked_delete=${blockedDelete.status} legal_delete=${legalDelete.status} fingerprint=${Boolean(before && before === after)}`);
    } else {
    const entityUpload = await storageUpload(entity.token, storageBase, 'entity legal upload');
    const entityUpdate = await storageUpload(entity.token, storageBase, 'entity legal overwrite with changed length', true);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerStorage = await exerciseRoleStorage(company.token, managerPath);
    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyStorage = await exerciseRoleStorage(company.token, safetyPath);
    setProjectRole(boundary.databaseUrl, f);
    restoreActor(boundary.databaseUrl, f);
    const companyRead = await storageReadableCount(boundary, anonKey, company.token, [storageBase]);
    const companyStorageDenied = await deniedStorageTriple(company.token, storageCandidates[0]);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossStorageDenied = await deniedStorageTriple(entity.token, storageCandidates[1]);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryStorageDenied = await deniedStorageTriple(company.token, storageCandidates[2]);
    restoreActor(boundary.databaseUrl, f);
    const anonStorageDenied = await deniedStorageTriple(anonKey, storageCandidates[3]);
    const entityDelete = await storageDelete(entity.token, storageBase);
    check('D07-R02-V67-C Storage upload/update/delete 项目权限矩阵通过', success(entityUpload) && success(entityUpdate)
      && success(entityDelete) && managerStorage.pass && safetyStorage.pass && companyStorageDenied.pass && crossStorageDenied.pass
      && ordinaryStorageDenied.pass && anonStorageDenied.pass && companyRead === 1 && storageFingerprint(storageBase) === '',
    `entity=${entityUpload.status}/${entityUpdate.status}/${entityDelete.status} manager=${managerStorage.status.join('/')} safety=${safetyStorage.status.join('/')} company=${companyStorageDenied.status.join('/')}:${companyStorageDenied.fingerprint} cross=${crossStorageDenied.status.join('/')}:${crossStorageDenied.fingerprint} ordinary=${ordinaryStorageDenied.status.join('/')}:${ordinaryStorageDenied.fingerprint} anon=${anonStorageDenied.status.join('/')}:${anonStorageDenied.fingerprint} read=${companyRead}`);
    }
  } finally {
    restoreActor(boundary.databaseUrl, f);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f);
    if (entityToken) await cleanupStorage();
    runPsql(boundary.databaseUrl, `DELETE FROM public.contractor_documents WHERE id IN (${f.documentIds.map(id => `${literal(id)}::uuid`).join(',')});`);
    cleanup(boundary.databaseUrl, f);
    residue = {
      business: residueCount(boundary.databaseUrl, f) + Number.parseInt(runPsql(boundary.databaseUrl,
        `SELECT count(*) FROM public.contractor_documents WHERE id IN (${f.documentIds.map(id => `${literal(id)}::uuid`).join(',')});`), 10),
      storage: Number.parseInt(runPsql(boundary.databaseUrl,
        `SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name IN (${f.storagePaths.map(storagePath => literal(storagePath)).join(',')});`), 10),
      policy: Number.parseInt(runPsql(boundary.databaseUrl,
        "SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='d07_v67_storage_cleanup';"), 10),
      audit: auditResidueCount(boundary.databaseUrl, f),
    };
  }

  check('D07-R02-V67-D 业务、Storage、临时策略和测试审计残留为零',
    residue.business === 0 && residue.storage === 0 && residue.policy === 0 && residue.audit === 0,
    `business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_V67_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

async function focusedV68Main() {
  const started = process.hrtime.bigint();
  const boundary = validateTestBoundary();
  check('D07-R02-V68-00 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigrations(boundary.databaseUrl);
  applySqlFile(boundary.databaseUrl, v68Path, 'v68 测试迁移');
  applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage v68 恢复初始化');

  const base = readBase(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const ids = Array.from({ length: 30 }, () => crypto.randomUUID());
  const f = {
    suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
    contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
    companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
    ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
    projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
    contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
    verificationX: ids[11], reapprovalId: ids[12], externalAdmissionId: ids[13], ownMember: ids[14], ownAdmission: ids[15],
    triggerPlan: ids[16], triggerAssignment: ids[17], triggerTask: ids[18],
  };
  const inviteToken = `d07-v68-${suffix.toLowerCase()}-${crypto.randomBytes(12).toString('hex')}`;
  const inviteProof = crypto.createHash('sha256').update(inviteToken.trim()).digest('hex');
  const invalidProof = crypto.createHash('sha256').update(`invalid-${suffix}`).digest('hex');
  let anonKey = '';
  let company;
  let entity;
  let storagePaths = [];
  let cleanupPolicy = false;
  let fixtureCreated = false;
  let residue = { business: -1, storage: -1, policy: -1, audit: -1 };

  const storageUpload = (token, storagePath, content = 'D07 v68 join upload') => request(boundary.apiOrigin, anonKey,
    `/storage/v1/object/certificates/${storagePath.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'x-upsert': 'false' },
      body: Buffer.from(content),
    });
  const storageFingerprint = storagePath => runPsql(boundary.databaseUrl,
    `SELECT COALESCE(json_build_object('id',id,'name',name,'updated_at',updated_at,'metadata',metadata)::text,'') FROM storage.objects WHERE bucket_id='certificates' AND name=${literal(storagePath)};`);
  try {
    anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    check('D07-R02-V68-01 测试账号与夹具一致', company.userId === f.companyActor.id && entity.userId === f.entityActor);
    createFixture(boundary.databaseUrl, f);
    fixtureCreated = true;
    runPsql(boundary.databaseUrl, `
      UPDATE public.site_project_invites SET token_hash=${literal(inviteProof)}, revoked_at=NULL, expires_at=now()+interval '1 day' WHERE id=${literal(f.inviteA)}::uuid;
      INSERT INTO public.site_project_members(id, project_id, employee_id, membership_type, work_type, status, joined_at, created_by)
      VALUES (${literal(f.ownMember)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.ordinaryEmployee)}::uuid, 'internal', 'D07-V68', 'active', now(), ${literal(f.entityActor)}::uuid);
      INSERT INTO public.training_plans(id,title,category,level,department_id,plan_year,plan_month,hours,target_desc,content,status,remark,require_exam,exam_mode)
      VALUES (${literal(f.triggerPlan)}::uuid, ${literal(`[D07-TEST] V68 ${suffix}`)}, 'D07-TEST', 'project', ${literal(f.leadEntity)}::uuid, 2026, 9, 1, 'D07 V68', 'D07 V68', 'ongoing', 'D07-TEST', false, 'none');
      INSERT INTO public.training_assignments(id,plan_id,employee_id,user_id,department_id,status,progress,exam_status)
      VALUES (${literal(f.triggerAssignment)}::uuid, ${literal(f.triggerPlan)}::uuid, ${literal(f.ordinaryEmployee)}::uuid, ${literal(f.companyActor.id)}::uuid, ${literal(f.leadEntity)}::uuid, 'pending', 0, 'none');
      INSERT INTO public.training_admissions(id,project_id,member_id,employee_id,package_id,status,exam_required,exam_assignment_id)
      VALUES (${literal(f.ownAdmission)}::uuid, ${literal(f.projectA)}::uuid, ${literal(f.ownMember)}::uuid, ${literal(f.ordinaryEmployee)}::uuid, ${literal(f.packageId)}::uuid, 'pending', true, ${literal(f.triggerAssignment)}::uuid);
      INSERT INTO public.training_admission_tasks(id,admission_id,plan_id,level,assignment_id,status,progress)
      VALUES (${literal(f.triggerTask)}::uuid, ${literal(f.ownAdmission)}::uuid, ${literal(f.triggerPlan)}::uuid, 'project', ${literal(f.triggerAssignment)}::uuid, 'pending', 0);`);

    const entityRecompute = await rpc(boundary, anonKey, entity.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyRecompute = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    setProjectRole(boundary.databaseUrl, f);

    runPsql(boundary.databaseUrl, `UPDATE public.training_admissions SET status='pending', blocked_reason='D07-V68-FINGERPRINT', updated_at='2026-01-01T00:00:00Z' WHERE id=${literal(f.ownAdmission)}::uuid;`);
    const beforeDenied = admissionSnapshot(boundary.databaseUrl, f.ownAdmission);
    const ordinaryOwn = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    restoreActor(boundary.databaseUrl, f);
    runPsql(boundary.databaseUrl, `UPDATE public.profiles SET employee_id=${literal(f.ordinaryEmployee)}::uuid, updated_at=now() WHERE id=${literal(f.companyActor.id)}::uuid;`);
    const companyOwn = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    restoreActor(boundary.databaseUrl, f);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossEntity = await rpc(boundary, anonKey, entity.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager', f.projectX);
    const unauthorizedRole = await rpc(boundary, anonKey, company.token, 'training_recompute_admission', { p_admission_id: f.ownAdmission });
    setProjectRole(boundary.databaseUrl, f);
    const afterDenied = admissionSnapshot(boundary.databaseUrl, f.ownAdmission);
    check('D07-R02-V68-A 公开重算 RPC 严格按目标 project_id 鉴权且拒绝保持原子',
      [entityRecompute, managerRecompute, safetyRecompute].every(success)
      && [ordinaryOwn, companyOwn, crossEntity, unauthorizedRole].every(response => denied(response))
      && beforeDenied === afterDenied,
    `lead=${entityRecompute.status} manager=${managerRecompute.status} safety=${safetyRecompute.status} ordinary_own=${ordinaryOwn.status} company_own=${companyOwn.status} cross=${crossEntity.status} unauthorized=${unauthorizedRole.status} unchanged=${beforeDenied === afterDenied}`);

    runPsql(boundary.databaseUrl, `UPDATE public.training_assignments SET status='completed', progress=100, hours_earned=1, completed_at=now() WHERE id=${literal(f.triggerAssignment)}::uuid;`);
    const learningState = runPsql(boundary.databaseUrl, `SELECT t.status||'|'||a.status FROM public.training_admission_tasks t JOIN public.training_admissions a ON a.id=t.admission_id WHERE t.id=${literal(f.triggerTask)}::uuid;`);
    runPsql(boundary.databaseUrl, `UPDATE public.training_assignments SET exam_status='passed', exam_score=90, exam_attempts=1 WHERE id=${literal(f.triggerAssignment)}::uuid;`);
    const examState = runPsql(boundary.databaseUrl, `SELECT exam_passed::text||'|'||exam_score::text||'|'||status FROM public.training_admissions WHERE id=${literal(f.ownAdmission)}::uuid;`);
    const acl = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
      'public',has_function_privilege('public','public.training_recompute_admission_internal(uuid)','EXECUTE'),
      'anon',has_function_privilege('anon','public.training_recompute_admission_internal(uuid)','EXECUTE'),
      'authenticated',has_function_privilege('authenticated','public.training_recompute_admission_internal(uuid)','EXECUTE'))::text;`));
    check('D07-R02-V68-B 学习和考试内部重算正常且内部函数无客户端 EXECUTE',
      learningState === 'completed|exam_pending' && examState === 'true|90.0|pending_sign'
      && !acl.public && !acl.anon && !acl.authenticated,
    `learning_state=${learningState} exam_state=${examState} acl=${JSON.stringify(acl)}`);

    const inviteSummary = await rpc(boundary, anonKey, company.token, 'site_project_invite_summary', { p_token: inviteToken });
    const summaryProject = inviteSummary.json?.[0]?.project_id;
    const prefix = `training-admission/join-applications/${f.projectA}/${company.userId}/${inviteProof}`;
    const legalPath = `${prefix}/D07-V68-${suffix}-legal.png`;
    const invalidPath = `training-admission/join-applications/${f.projectA}/${company.userId}/${invalidProof}/D07-V68-${suffix}-invalid.png`;
    const wrongProjectPath = `training-admission/join-applications/${f.projectX}/${company.userId}/${inviteProof}/D07-V68-${suffix}-wrong-project.png`;
    const forgedUidPath = `training-admission/join-applications/${f.projectA}/${crypto.randomUUID()}/${inviteProof}/D07-V68-${suffix}-forged-uid.png`;
    const revokedPath = `${prefix}/D07-V68-${suffix}-revoked.png`;
    const companyPath = `${prefix}/D07-V68-${suffix}-company.png`;
    const crossPath = `training-admission/join-applications/${f.projectA}/${entity.userId}/${inviteProof}/D07-V68-${suffix}-cross.png`;
    const anonPath = `training-admission/join-applications/${f.projectA}/${crypto.randomUUID()}/${inviteProof}/D07-V68-${suffix}-anon.png`;
    storagePaths = [legalPath, invalidPath, wrongProjectPath, forgedUidPath, revokedPath, companyPath, crossPath, anonPath];
    f.storagePaths = storagePaths;
    runPsql(boundary.databaseUrl, `DROP POLICY IF EXISTS d07_v68_storage_cleanup ON storage.objects;
      CREATE POLICY d07_v68_storage_cleanup ON storage.objects FOR DELETE TO authenticated USING (bucket_id='certificates' AND name LIKE ${literal(`%D07-V68-${suffix}%`)});`);
    cleanupPolicy = true;

    const legalUpload = await storageUpload(company.token, legalPath);
    const beforeStorageDenied = storageFingerprint(legalPath);
    const noInvite = await storageUpload(company.token, invalidPath);
    const wrongProject = await storageUpload(company.token, wrongProjectPath);
    const forgedUid = await storageUpload(company.token, forgedUidPath);
    runPsql(boundary.databaseUrl, `UPDATE public.site_project_invites SET revoked_at=now() WHERE id=${literal(f.inviteA)}::uuid;`);
    const revokedInvite = await storageUpload(company.token, revokedPath);
    runPsql(boundary.databaseUrl, `UPDATE public.site_project_invites SET revoked_at=NULL WHERE id=${literal(f.inviteA)}::uuid;`);
    restoreActor(boundary.databaseUrl, f);
    const companyUpload = await storageUpload(company.token, companyPath);
    const companyRead = await storageReadableCount(boundary, anonKey, company.token, [legalPath]);
    const crossAdminUpload = await storageUpload(entity.token, crossPath);
    const anonUpload = await storageUpload(anonKey, anonPath);
    const afterStorageDenied = storageFingerprint(legalPath);
    check('D07-R02-V68-C 有效邀请码的 project_id、uid 和路径证明一致时允许上传',
      success(inviteSummary) && summaryProject === f.projectA && success(legalUpload) && Boolean(beforeStorageDenied),
    `summary=${inviteSummary.status} upload=${legalUpload.status} project_match=${summaryProject === f.projectA}`);
    check('D07-R02-V68-D 未验证邀请码、错项目、伪造 uid、撤销邀请码及无权角色均拒绝',
      [noInvite, wrongProject, forgedUid, revokedInvite, companyUpload, crossAdminUpload, anonUpload].every(response => !success(response))
      && beforeStorageDenied === afterStorageDenied && companyRead === 1,
    `no_invite=${noInvite.status} wrong_project=${wrongProject.status} forged_uid=${forgedUid.status} revoked=${revokedInvite.status} company=${companyUpload.status} cross=${crossAdminUpload.status} anon=${anonUpload.status} unchanged=${beforeStorageDenied === afterStorageDenied} company_read=${companyRead}`);

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sql', 'training-admission-v17-v49.manifest.json'), 'utf8'));
    const entry = manifest.migrations.find(item => item.version === 68);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(v68Path, 'utf8').replace(/\r\n/g, '\n')).digest('hex').toUpperCase();
    check('D07-R02-V68-E v68 manifest、schema、连续性和 SHA-256 正确',
      manifest.schema === 'd03-training-admission-v17-v68'
      && manifest.migrations.length === 52
      && manifest.migrations.every((item, index) => item.version === index + 17)
      && entry?.file === path.basename(v68Path) && entry.sha256 === digest);
  } finally {
    restoreActor(boundary.databaseUrl, f);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f);
    if (cleanupPolicy) {
      try {
        const existing = runPsql(boundary.databaseUrl, `SELECT name FROM storage.objects WHERE bucket_id='certificates' AND name IN (${storagePaths.map(item => literal(item)).join(',')}) ORDER BY name;`).split(/\r?\n/).filter(Boolean);
        if (existing.length && company) {
          const remove = () => request(boundary.apiOrigin, anonKey, '/storage/v1/object/certificates', {
            method: 'DELETE', headers: { Authorization: `Bearer ${company.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefixes: existing }),
          });
          await remove();
          if (runPsql(boundary.databaseUrl, `SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name IN (${existing.map(item => literal(item)).join(',')});`) !== '0') {
            await new Promise(resolve => setTimeout(resolve, 300));
            await remove();
          }
        }
      } finally {
        runPsql(boundary.databaseUrl, 'DROP POLICY IF EXISTS d07_v68_storage_cleanup ON storage.objects;');
      }
    }
    if (fixtureCreated) {
      runPsql(boundary.databaseUrl, `
        DELETE FROM public.training_admission_tasks WHERE id=${literal(f.triggerTask)}::uuid;
        DELETE FROM public.training_admissions WHERE id=${literal(f.ownAdmission)}::uuid;
        DELETE FROM public.training_assignments WHERE id=${literal(f.triggerAssignment)}::uuid;
        DELETE FROM public.site_project_members WHERE id=${literal(f.ownMember)}::uuid;
        DELETE FROM public.training_plans WHERE id=${literal(f.triggerPlan)}::uuid;`);
      cleanup(boundary.databaseUrl, f);
      runPsql(boundary.databaseUrl, `DELETE FROM public.site_project_audit_logs WHERE entity_id IN (${literal(f.ownMember)}::uuid,${literal(f.ownAdmission)}::uuid,${literal(f.triggerPlan)}::uuid,${literal(f.triggerAssignment)}::uuid,${literal(f.triggerTask)}::uuid);`);
    }
    residue = {
      business: fixtureCreated ? residueCount(boundary.databaseUrl, f) + Number.parseInt(runPsql(boundary.databaseUrl, `SELECT
        (SELECT count(*) FROM public.site_project_members WHERE id=${literal(f.ownMember)}::uuid)
        +(SELECT count(*) FROM public.training_admissions WHERE id=${literal(f.ownAdmission)}::uuid)
        +(SELECT count(*) FROM public.training_assignments WHERE id=${literal(f.triggerAssignment)}::uuid)
        +(SELECT count(*) FROM public.training_admission_tasks WHERE id=${literal(f.triggerTask)}::uuid)
        +(SELECT count(*) FROM public.training_plans WHERE id=${literal(f.triggerPlan)}::uuid);`), 10) : 0,
      storage: storagePaths.length ? Number.parseInt(runPsql(boundary.databaseUrl, `SELECT count(*) FROM storage.objects WHERE bucket_id='certificates' AND name IN (${storagePaths.map(item => literal(item)).join(',')});`), 10) : 0,
      policy: Number.parseInt(runPsql(boundary.databaseUrl, "SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='d07_v68_storage_cleanup';"), 10),
      audit: fixtureCreated ? auditResidueCount(boundary.databaseUrl, f) : 0,
    };
  }

  check('D07-R02-V68-F 业务、Storage、临时策略和测试审计残留为零',
    residue.business === 0 && residue.storage === 0 && residue.policy === 0 && residue.audit === 0,
  `business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_V68_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} business=${residue.business} storage=${residue.storage} policy=${residue.policy} audit=${residue.audit} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

async function main() {
  const started = process.hrtime.bigint();
  if (process.argv.includes('--web-only')) {
    const web = verifyWeb();
    check('D07-R02-B 公司级管理员 Web 日常管理入口隐藏', web.company && web.entries);
    check('D07-R02-C 非主责实体管理员按 project_id 隐藏入口', web.outside);
    check('D07-R02-D4 主责实体管理员、项目经理和安全员 Web 入口不回退', web.lead && web.manager && web.safety);
    check('D07-R02-D5 Web 只读按钮与管理按钮按 project_id 分离', web.readWriteSplit);
    const failed = results.filter(item => !item.pass);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`D07_R02_WEB_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_ms=${elapsedMs.toFixed(0)}`);
    if (failed.length) process.exitCode = 1;
    return;
  }
  const boundary = validateTestBoundary();
  check('D07-R02-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);
  applyMigrations(boundary.databaseUrl);
  applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 测试前初始化');
  const base = readBase(boundary.databaseUrl);
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
  const f = {
    suffix, projectA: base.project_a, leadEntity: base.lead_entity, outsideEntity: base.outside_entity,
    contractor: base.contractor, memberId: base.member_id, memberEmployee: base.member_employee, externalMember: base.external_member,
    companyActor: base.company_actor, entityActor: base.entity_actor, assignableUser: base.assignable_user,
    ordinaryEmployee: base.ordinary_employee, externalEmployee: base.external_employee,
    projectX: ids[0], visitorEmployee: ids[1], packageId: ids[2], admissionId: ids[3], inviteA: ids[4], inviteX: ids[5],
    contractId: ids[6], applicationId: ids[7], attachmentId: ids[8], reminderId: ids[9], verificationA: ids[10],
    verificationX: ids[11], reapprovalId: ids[12], storageJoinPhoto: ids[13], storageJoinAttachment: ids[14],
    storageContract: ids[15], storageConfirmation: ids[16], storageSignature: ids[17], storageCross: ids[18],
    externalAdmissionId: ids[19],
  };
  f.joinPhoto = `training-admission/join-applications/${suffix}/photo.png`;
  f.joinAttachment = `training-admission/join-applications/${suffix}/attachment.pdf`;
  f.contractPath = `training-admission/contractor-contracts/${f.projectA}/${suffix}.pdf`;
  f.confirmationPath = `training-admission/site-confirmations/${f.projectA}/${suffix}.png`;
  f.signaturePath = `training-admission/signatures/${f.admissionId}/${suffix}.png`;
  f.crossPath = `training-admission/contractor-documents/${f.projectX}/${suffix}.pdf`;
  f.storageIds = ids.slice(13);
  f.storagePaths = [f.joinPhoto, f.joinAttachment, f.contractPath, f.confirmationPath, f.signaturePath, f.crossPath];
  let residue = -1;
  let anonKey = '';
  let entityToken = '';
  let storageSetupStarted = false;

  try {
    anonKey = required('SAFETY_SUPABASE_ANON_KEY');
    const [company, entity] = await Promise.all([
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ADMIN_EMAIL'), required('SAFETY_TEST_ADMIN_PASSWORD')),
      login(boundary.apiOrigin, anonKey, required('SAFETY_TEST_ENTITY_EMAIL'), required('SAFETY_TEST_ENTITY_PASSWORD')),
    ]);
    entityToken = entity.token;
    await ensureDatabaseAlive(boundary.databaseUrl);
    check('D07-R02-00 测试账号与夹具一致', company.userId === f.companyActor.id && entity.userId === f.entityActor);
    createFixture(boundary.databaseUrl, f);
    storageSetupStarted = true;
    await createStorageFixture(boundary, boundary.databaseUrl, anonKey, entity.token, f);

    const v64 = fs.readFileSync(v64Path, 'utf8');
    const v65 = fs.readFileSync(v65Path, 'utf8');
    const initializer = fs.readFileSync(storageInitializerPath, 'utf8');
    check('D07-R02-A1 v64/v65 读取与管理函数保持分离',
      /site_project_can_read_management_data/.test(v64)
      && !/CREATE OR REPLACE FUNCTION public\.site_project_can_manage/.test(v64 + v65)
      && /training_refresh_external_admissions[\s\S]*site_project_can_manage\(p_project_id\)/.test(v65));

    const companyReadsBefore = await publicReadCount(boundary, anonKey, company.token, f);
    const companyStorageBefore = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths);
    const companyRpcReadsBefore = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    check('D07-R02-A2 Storage 初始化前公司级批准范围只读正常', companyReadsBefore === 7
      && companyStorageBefore === 6 && companyRpcReadsBefore.every(success),
    `tables=${companyReadsBefore}/7 storage=${companyStorageBefore}/6 rpc=${companyRpcReadsBefore.filter(success).length}/3`);

    applySqlFile(boundary.databaseUrl, storageInitializerPath, 'Storage 恢复初始化');
    const companyReadsAfter = await publicReadCount(boundary, anonKey, company.token, f);
    const companyStorageAfter = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths);
    const companyRpcReadsAfter = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    check('D07-R02-A3 Storage 恢复初始化后公司级只读不回退', companyReadsAfter === 7
      && companyStorageAfter === 6 && companyRpcReadsAfter.every(success)
      && /site_project_can_read_management_data/.test(initializer),
    `tables=${companyReadsAfter}/7 storage=${companyStorageAfter}/6 rpc=${companyRpcReadsAfter.filter(success).length}/3`);

    const [companyInvite, companyRemind, companyVerify, companyAssign, companyExternalRefresh] = await Promise.all([
      rpc(boundary, anonKey, company.token, 'site_project_refresh_invite', { p_project_id: f.projectA }),
      rpc(boundary, anonKey, company.token, 'training_generate_due_reminders', { p_project_id: f.projectA }),
      rpc(boundary, anonKey, company.token, 'training_log_verification', { p_project_id: f.projectA, p_employee_id: f.memberEmployee, p_credential_type: 'certificate', p_result_status: 'blocked', p_reason: 'D07 R02', p_code: 'R02DENY' }),
      rpc(boundary, anonKey, company.token, 'site_project_set_roles', { p_project_id: f.projectA, p_roles: [{ user_id: f.assignableUser, role: 'project_manager' }] }),
      rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor }),
    ]);
    check('D07-R02-B1 公司级管理员日常管理仍拒绝',
      denied(companyInvite, '您无权刷新项目邀请码')
      && denied(companyRemind, '您无权生成该项目提醒')
      && denied(companyVerify, '您无权记录该项目的现场核验')
      && denied(companyAssign, '仅项目主责经营实体管理员可以任命项目角色')
      && denied(companyExternalRefresh, '您无权刷新该项目外协资格'));

    const entityRead = await publicReadCount(boundary, anonKey, entity.token, f);
    const entityInvite = await rpc(boundary, anonKey, entity.token, 'site_project_refresh_invite', { p_project_id: f.projectA });
    const entityExternalRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const entityRpcReads = await readOnlyRpcResults(boundary, anonKey, entity.token, f);
    const entityStorageA = await storageReadableCount(boundary, anonKey, entity.token, f.storagePaths.slice(0, 5));
    const entityStorageX = await storageReadableCount(boundary, anonKey, entity.token, [f.crossPath]);
    const entityCross = await restRows(boundary, anonKey, entity.token, 'training_verification_logs', [f.verificationX]);
    const entityCrossInvite = await rpc(boundary, anonKey, entity.token, 'site_project_refresh_invite', { p_project_id: f.projectX });
    check('D07-R02-B2 主责实体管理员合法路径正常且跨实体拒绝', entityRead === 7 && success(entityInvite)
      && success(entityExternalRefresh) && entityRpcReads.every(success) && entityStorageA === 5 && entityStorageX === 0
      && entityCross?.length === 0 && denied(entityCrossInvite, '您无权刷新项目邀请码'));

    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.outsideEntity);
    const crossEntityRefresh = await rpc(boundary, anonKey, entity.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const crossEntityReads = await readOnlyRpcResults(boundary, anonKey, entity.token, f);
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    check('D07-R02-B3 非主责经营实体管理员不能伪造 project_id', denied(crossEntityRefresh, '您无权刷新该项目外协资格')
      && crossEntityReads.every(response => denied(response)));

    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    setProjectRole(boundary.databaseUrl, f, 'project_manager');
    const managerRead = await publicReadCount(boundary, anonKey, company.token, f);
    const managerCross = await restRows(boundary, anonKey, company.token, 'training_verification_logs', [f.verificationX]);
    const managerInvite = await rpc(boundary, anonKey, company.token, 'site_project_refresh_invite', { p_project_id: f.projectA });
    const managerRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const managerRpcReads = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    const managerStorageA = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths.slice(0, 5));
    const managerStorageX = await storageReadableCount(boundary, anonKey, company.token, [f.crossPath]);
    check('D07-R02-B4 项目经理自己项目读写正常且跨项目拒绝', managerRead === 7 && managerCross?.length === 0
      && success(managerInvite) && success(managerRefresh) && managerRpcReads.every(success)
      && managerStorageA === 5 && managerStorageX === 0);

    setProjectRole(boundary.databaseUrl, f, 'safety_officer');
    const safetyRead = await publicReadCount(boundary, anonKey, company.token, f);
    const safetyInvite = await rpc(boundary, anonKey, company.token, 'site_project_refresh_invite', { p_project_id: f.projectA });
    const safetyRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const safetyRpcReads = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    check('D07-R02-B5 安全员自己项目合法路径正常', safetyRead === 7 && success(safetyInvite)
      && success(safetyRefresh) && safetyRpcReads.every(success));

    const snapshotBeforeDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    setProjectRole(boundary.databaseUrl, f, 'project_manager', f.projectX);
    const unauthorizedManager = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const unauthorizedManagerRead = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    setProjectRole(boundary.databaseUrl, f, 'safety_officer', f.projectX);
    const unauthorizedSafety = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    check('D07-R02-B6 未授权项目经理/安全员跨 project_id 均被拒绝', denied(unauthorizedManager, '您无权刷新该项目外协资格')
      && denied(unauthorizedSafety, '您无权刷新该项目外协资格') && unauthorizedManagerRead.every(response => denied(response)));

    setProjectRole(boundary.databaseUrl, f);
    switchActor(boundary.databaseUrl, f, f.ordinaryEmployee, f.leadEntity);
    const ordinaryRead = await publicReadCount(boundary, anonKey, company.token, f);
    const ordinaryStorage = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths);
    const ordinaryRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const ordinaryRpcReads = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    switchActor(boundary.databaseUrl, f, f.externalEmployee, f.leadEntity);
    const externalRead = await publicReadCount(boundary, anonKey, company.token, f);
    const externalRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const externalRpcReads = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    switchActor(boundary.databaseUrl, f, f.visitorEmployee, f.outsideEntity);
    const visitorRead = await publicReadCount(boundary, anonKey, company.token, f);
    const visitorRefresh = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    const visitorRpcReads = await readOnlyRpcResults(boundary, anonKey, company.token, f);
    const anonStorage = await storageReadableCount(boundary, anonKey, anonKey, f.storagePaths);
    check('D07-R02-C1 普通员工、外协、访客和 anon 未获得额外权限', ordinaryRead === 0 && ordinaryStorage === 0
      && externalRead === 0 && visitorRead === 0 && anonStorage === 0
      && denied(ordinaryRefresh) && denied(externalRefresh) && denied(visitorRefresh)
      && ordinaryRpcReads.every(response => denied(response))
      && externalRpcReads.every(response => denied(response))
      && visitorRpcReads.every(response => denied(response)));

    switchActor(boundary.databaseUrl, f, f.visitorEmployee, f.outsideEntity, 'admin', 'dept');
    const outsideAdminStorageA = await storageReadableCount(boundary, anonKey, company.token, f.storagePaths.slice(0, 5));
    const outsideAdminStorageX = await storageReadableCount(boundary, anonKey, company.token, [f.crossPath]);
    const outsideAdminRefreshA = await rpc(boundary, anonKey, company.token, 'training_refresh_external_admissions', { p_project_id: f.projectA, p_contractor_id: f.contractor });
    check('D07-R02-C2 Storage 初始化后跨实体仍按 project_id 隔离', outsideAdminStorageA === 0
      && outsideAdminStorageX === 1 && denied(outsideAdminRefreshA, '您无权刷新该项目外协资格'));

    const snapshotAfterDenied = admissionSnapshot(boundary.databaseUrl, f.externalAdmissionId);
    check('D07-R02-C3 被拒绝请求不修改原准入状态', snapshotAfterDenied === snapshotBeforeDenied);

    if (!process.argv.includes('--service-only')) {
      const web = verifyWeb();
      check('D07-R02-B 公司级管理员 Web 日常管理入口隐藏', web.company && web.entries);
      check('D07-R02-C 非主责实体管理员按 project_id 隐藏入口', web.outside);
      check('D07-R02-D4 主责实体管理员、项目经理和安全员 Web 入口不回退', web.lead && web.manager && web.safety);
      check('D07-R02-D5 Web 只读按钮与管理按钮按 project_id 分离', web.readWriteSplit);
    }
  } finally {
    setEntityDepartment(boundary.databaseUrl, f.entityActor, f.leadEntity);
    if (storageSetupStarted) await removeStorageFixture(boundary, boundary.databaseUrl, anonKey, entityToken, f);
    residue = cleanup(boundary.databaseUrl, f);
    for (let attempt = 0; residue > 0 && attempt < 10; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      residue = residueCount(boundary.databaseUrl, f);
    }
  }

  check('D07-R02-F 测试数据残留为零', residue === 0, `residue=${residue}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const failed = results.filter(item => !item.pass);
  console.log(`D07_R02_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} residue=${residue} elapsed_ms=${elapsedMs.toFixed(0)}`);
  if (failed.length) process.exitCode = 1;
}

const selectedMain = process.argv.includes('--storage-upload-focused') ? storageUploadFocusedMain
  : process.argv.includes('--cleanup-failure-focused') ? cleanupFailureFocusedMain
    : process.argv.includes('--v66-preassert-diagnose') ? v66PreAssertionDiagnosticMain
      : process.argv.includes('--db-connection-minimal') ? databaseConnectionMinimalMain
    : process.argv.includes('--v66-focused') ? focusedV66Main
      : process.argv.includes('--v68-focused') ? focusedV68Main
        : process.argv.includes('--v67-p1-focused') || process.argv.includes('--v67-storage-focused')
        || process.argv.includes('--v67-storage-delete-focused') ? focusedV67Main : main;
selectedMain().catch(error => {
  console.error(`D07 R02 targeted test failed: ${error.message}`);
  process.exit(1);
});

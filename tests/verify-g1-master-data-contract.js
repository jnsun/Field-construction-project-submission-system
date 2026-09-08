/** D08-5: G1 master-data machine contract against the isolated database and source. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { assertD02FixtureMarker, validateTestBoundary } = require('./e2e/d04-test-environment');

const root = path.resolve(__dirname, '..');
const contractPath = path.join(root, 'docs', 'contracts', 'G1-master-data-api-v1.json');
const results = [];

function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
}

function runPsql(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '')
      .replaceAll(databaseUrl, '[database-url-redacted]')
      .trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`G1 契约数据库核验失败${detail ? `：${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function source(...names) {
  return names.map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
}

function contractRpc(contract, name) {
  return contract.rpcs.find(item => item.name === name);
}

function splitSqlArguments(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") {
      if (quoted && text[i + 1] === "'") { i += 1; continue; }
      quoted = !quoted;
    } else if (!quoted && '([{'.includes(ch)) {
      depth += 1;
    } else if (!quoted && ')]}'.includes(ch)) {
      depth -= 1;
    } else if (!quoted && ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function sqlLiteralValue(expression) {
  const stringValue = expression.match(/^'((?:''|[^'])*)'(?:\s*::[a-z_][a-z0-9_]*)?$/i)?.[1];
  if (stringValue !== undefined) return stringValue.replace(/''/g, "'");
  if (/^TRUE$/i.test(expression)) return true;
  if (/^FALSE$/i.test(expression)) return false;
  return undefined;
}

function jsonbReturnBranches(definition) {
  const branches = [];
  const matcher = /\bRETURN\s+jsonb_build_object\s*\(/ig;
  let match;
  while ((match = matcher.exec(definition))) {
    const start = matcher.lastIndex;
    let depth = 1;
    let quoted = false;
    let end = -1;
    for (let i = start; i < definition.length; i += 1) {
      const ch = definition[i];
      if (ch === "'") {
        if (quoted && definition[i + 1] === "'") { i += 1; continue; }
        quoted = !quoted;
      } else if (!quoted && ch === '(') {
        depth += 1;
      } else if (!quoted && ch === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) throw new Error('无法解析 jsonb_build_object 返回分支');
    const args = splitSqlArguments(definition.slice(start, end));
    if (args.length % 2 !== 0) throw new Error('jsonb_build_object 返回参数不是键值对');
    const keys = [];
    const literals = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].match(/^'([^']+)'$/)?.[1];
      if (!key) throw new Error(`无法解析 JSON 返回键：${args[i]}`);
      keys.push(key);
      const literal = sqlLiteralValue(args[i + 1]);
      if (literal !== undefined) literals[key] = literal;
    }
    branches.push({ keys, literals });
    matcher.lastIndex = end + 1;
  }
  return branches;
}

function normalizedKeySets(keySets) {
  return [...new Set(keySets.map(keys => keys.slice().sort().join(',')))].sort();
}

function declaredResultKeySets(rpc) {
  const schema = rpc?.result_schema;
  if (!schema || schema.type !== 'object') return [];
  const branches = schema.variants?.length ? schema.variants : [schema];
  return branches.map(branch => [...(branch.required || []), ...(branch.optional || [])]);
}

function validateResultSchema(rpc) {
  const schema = rpc?.result_schema;
  if (!schema || schema.type !== 'object' || schema.additional_properties !== false) return false;
  const fields = Object.keys(schema.properties || {});
  const rootFields = [...(schema.required || []), ...(schema.optional || [])];
  if (new Set(rootFields).size !== rootFields.length
      || normalizedKeySets([fields])[0] !== normalizedKeySets([rootFields])[0]
      || normalizedKeySets([fields])[0] !== normalizedKeySets([rpc.result_fields || []])[0]) return false;
  if (!fields.every(field => {
    const spec = schema.properties[field];
    return ['string', 'boolean', 'integer', 'number', 'object', 'array'].includes(spec?.type)
      && typeof spec.nullable === 'boolean'
      && (!spec.format || (spec.type === 'string' && spec.format === 'uuid'));
  })) return false;
  return (schema.variants || []).every(variant => {
    const branchFields = [...(variant.required || []), ...(variant.optional || [])];
    return variant.name && variant.when && new Set(branchFields).size === branchFields.length
      && branchFields.every(field => fields.includes(field))
      && Object.keys(variant.when).every(field => (variant.required || []).includes(field));
  });
}

function runtimeValueMatches(value, spec) {
  if (value === null) return spec.nullable === true;
  if (spec.type === 'integer') return Number.isInteger(value);
  if (spec.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (spec.type === 'array') return Array.isArray(value);
  if (spec.type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  if (typeof value !== spec.type) return false;
  return spec.format !== 'uuid' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateRuntimeResults(rpc, samples) {
  if (!validateResultSchema(rpc) || !Array.isArray(samples) || samples.length === 0) return false;
  const schema = rpc.result_schema;
  const fields = Object.keys(schema.properties);
  const keySets = samples.map(sample => Object.keys(sample));
  const presentInEvery = fields.filter(field => samples.every(sample => Object.hasOwn(sample, field)));
  const presentInSome = fields.filter(field => samples.some(sample => Object.hasOwn(sample, field)));
  const optional = presentInSome.filter(field => !presentInEvery.includes(field));
  if (normalizedKeySets([schema.required])[0] !== normalizedKeySets([presentInEvery])[0]
      || normalizedKeySets([schema.optional])[0] !== normalizedKeySets([optional])[0]
      || normalizedKeySets([fields])[0] !== normalizedKeySets([presentInSome])[0]) return false;

  for (const field of fields) {
    const values = samples.filter(sample => Object.hasOwn(sample, field)).map(sample => sample[field]);
    if (values.some(value => !runtimeValueMatches(value, schema.properties[field]))) return false;
    if (schema.properties[field].nullable !== values.some(value => value === null)) return false;
  }

  const variants = schema.variants || [];
  if (!variants.length) return normalizedKeySets(keySets)[0] === normalizedKeySets([schema.required])[0];
  return samples.every(sample => variants.filter(variant =>
    Object.entries(variant.when).every(([field, value]) => sample[field] === value)
      && normalizedKeySets([Object.keys(sample)])[0] === normalizedKeySets([[
        ...(variant.required || []), ...(variant.optional || []),
      ]])[0]).length === 1)
    && variants.every(variant => samples.some(sample =>
      Object.entries(variant.when).every(([field, value]) => sample[field] === value)));
}

function runtimeResultSamples(databaseUrl) {
  const value = runPsql(databaseUrl, `
    BEGIN;
    CREATE TEMP TABLE g1_runtime_results(name TEXT NOT NULL, result JSONB NOT NULL) ON COMMIT DROP;
    DO $fixture$
    DECLARE
      v_actor UUID;
      v_entity UUID;
      v_employee UUID;
      v_existing_employee UUID := gen_random_uuid();
      v_company UUID := gen_random_uuid();
      v_approve_project UUID := gen_random_uuid();
      v_reject_project UUID := gen_random_uuid();
      v_reclass_project UUID := gen_random_uuid();
      v_approve_app UUID := gen_random_uuid();
      v_reject_app UUID := gen_random_uuid();
      v_reclass_app UUID := gen_random_uuid();
      v_run TEXT := replace(gen_random_uuid()::TEXT, '-', '');
      v_employee_no TEXT;
      v_photo_path TEXT;
      v_key TEXT;
      v_identity_approve TEXT := 'G1-APPROVE-' || gen_random_uuid()::TEXT;
      v_identity_reject TEXT := 'G1-REJECT-' || gen_random_uuid()::TEXT;
      v_identity_reclass TEXT := 'G1-RECLASS-' || gen_random_uuid()::TEXT;
      v_create JSONB;
      v_token_approve TEXT;
      v_token_reject TEXT;
      v_token_reclass TEXT;
    BEGIN
      SELECT p.id, p.department_id INTO v_actor, v_entity
      FROM public.profiles p
      JOIN public.training_employees e ON e.id = p.employee_id
      WHERE e.employee_no = 'D02-002';
      IF v_actor IS NULL OR v_entity IS NULL THEN RAISE EXCEPTION 'G1 运行时夹具缺少 D02 实体管理员'; END IF;
      PERFORM set_config('request.jwt.claim.sub', v_actor::TEXT, TRUE);
      SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
      WHERE name = 'training_admission_identity_key' LIMIT 1;
      IF v_key IS NULL THEN RAISE EXCEPTION 'G1 运行时夹具缺少身份密钥'; END IF;

      v_employee_no := 'G1-' || left(v_run, 12);
      v_create := public.training_employee_create(
        '[G1-TEST] 返回契约', NULL, v_employee_no, v_entity, '初始岗位', NULL,
        NULL, NULL, NULL, 'employee', 'active', 'G1 runtime contract', NULL);
      v_employee := (v_create->>'employee_id')::UUID;
      INSERT INTO g1_runtime_results VALUES ('training_employee_create', v_create);
      INSERT INTO g1_runtime_results VALUES ('training_employee_update',
        public.training_employee_update(v_employee, '[G1-TEST] 返回契约', NULL, v_employee_no,
          v_entity, '初始岗位', NULL, NULL, NULL, NULL, 'employee', 'active', 'G1 runtime contract'));
      INSERT INTO g1_runtime_results VALUES ('training_employee_update',
        public.training_employee_update(v_employee, '[G1-TEST] 返回契约', NULL, v_employee_no,
          v_entity, '变更岗位', NULL, NULL, NULL, NULL, 'employee', 'active', 'G1 runtime contract'));

      v_photo_path := v_employee::TEXT || '/g1-' || v_run || '.jpg';
      INSERT INTO storage.objects(bucket_id, name, owner_id) VALUES ('avatars', v_photo_path, v_actor::TEXT);
      INSERT INTO g1_runtime_results VALUES ('training_employee_photo_update',
        public.training_employee_photo_update(v_employee, v_photo_path, 'G1 changed 分支'));
      INSERT INTO g1_runtime_results VALUES ('training_employee_photo_update',
        public.training_employee_photo_update(v_employee, v_photo_path, 'G1 no-op 分支'));

      v_token_approve := encode(hmac(upper(btrim(v_identity_approve)), v_key, 'sha256'), 'hex');
      v_token_reject := encode(hmac(upper(btrim(v_identity_reject)), v_key, 'sha256'), 'hex');
      v_token_reclass := encode(hmac(upper(btrim(v_identity_reclass)), v_key, 'sha256'), 'hex');
      INSERT INTO public.site_projects(id, project_code, name, status, lead_entity_id, report_notes, created_by) VALUES
        (v_approve_project, 'G1-A-' || left(v_run, 8), '[G1-TEST] 审核通过', 'active', v_entity, 'G1 runtime contract', v_actor),
        (v_reject_project, 'G1-R-' || left(v_run, 8), '[G1-TEST] 审核拒绝', 'active', v_entity, 'G1 runtime contract', v_actor),
        (v_reclass_project, 'G1-C-' || left(v_run, 8), '[G1-TEST] 审核重分类', 'active', v_entity, 'G1 runtime contract', v_actor);
      INSERT INTO public.site_project_entities(project_id, entity_id, is_lead) VALUES
        (v_approve_project, v_entity, TRUE), (v_reject_project, v_entity, TRUE), (v_reclass_project, v_entity, TRUE);
      INSERT INTO public.contractor_companies(id, name, managing_entity_id, status, created_by)
      VALUES (v_company, '[G1-TEST] 外协单位 ' || left(v_run, 8), v_entity, 'active', v_actor);
      INSERT INTO public.training_employees(
        id, name, employee_no, department_id, position, id_number, id_number_ciphertext,
        id_number_match_token, identity_updated_at, emp_type, status, remark, created_by)
      VALUES (v_existing_employee, '[G1-TEST] 已有人员', 'G1-E-' || left(v_run, 10), v_entity,
        '已有岗位', NULL, pgp_sym_encrypt(v_identity_reclass, v_key, 'cipher-algo=aes256, compress-algo=0'),
        v_token_reclass, NOW(), 'employee', 'active', 'G1 runtime contract', v_actor);
      PERFORM set_config('app.join_transition_source', 'g1_runtime_fixture', TRUE);
      INSERT INTO public.project_join_applications(
        id, project_id, applicant_user_id, employee_id, name, phone, id_number_ciphertext,
        id_number_digest, position, photo_path, contractor_id, contractor_name_input,
        application_type, review_path, target_entity_id, application_cycle, status, identity_resolved_at)
      VALUES
        (v_approve_app, v_approve_project, NULL, NULL, '[G1-TEST] 新人员', '13000000001',
          pgp_sym_encrypt(v_identity_approve, v_key, 'cipher-algo=aes256, compress-algo=0'), v_token_approve,
          '普工', 'g1-runtime/approve.jpg', v_company, '[G1-TEST] 外协单位', 'external',
          'first_project', v_entity, 1, 'pending_project_review', NOW()),
        (v_reject_app, v_reject_project, NULL, NULL, '[G1-TEST] 拒绝人员', '13000000002',
          pgp_sym_encrypt(v_identity_reject, v_key, 'cipher-algo=aes256, compress-algo=0'), v_token_reject,
          '普工', 'g1-runtime/reject.jpg', v_company, '[G1-TEST] 外协单位', 'external',
          'first_project', v_entity, 1, 'pending_project_review', NOW()),
        (v_reclass_app, v_reclass_project, NULL, NULL, '[G1-TEST] 已有人员', '13000000003',
          pgp_sym_encrypt(v_identity_reclass, v_key, 'cipher-algo=aes256, compress-algo=0'), v_token_reclass,
          '普工', 'g1-runtime/reclass.jpg', v_company, '[G1-TEST] 外协单位', 'external',
          'first_project', v_entity, 1, 'pending_project_review', NOW());

      INSERT INTO g1_runtime_results VALUES ('site_project_review_application',
        public.site_project_review_application(v_approve_app, 'approve', 'G1 approve'));
      INSERT INTO g1_runtime_results VALUES ('site_project_review_application',
        public.site_project_review_application(v_approve_app, 'approve', 'G1 approve'));
      INSERT INTO g1_runtime_results VALUES ('site_project_review_application',
        public.site_project_review_application(v_reject_app, 'reject', 'G1 reject'));
      INSERT INTO g1_runtime_results VALUES ('site_project_review_application',
        public.site_project_review_application(v_reject_app, 'reject', 'G1 reject'));
      INSERT INTO g1_runtime_results VALUES ('site_project_review_application',
        public.site_project_review_application(v_reclass_app, 'approve', 'G1 reclass'));
    END $fixture$;
    SELECT json_object_agg(name, results)::TEXT FROM (
      SELECT name, json_agg(result ORDER BY ctid) AS results FROM g1_runtime_results GROUP BY name
    ) samples;
    ROLLBACK;
  `);
  return JSON.parse(value);
}

function main() {
  const started = process.hrtime.bigint();
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  check('G1-01 machine-readable contract 可解析且已冻结',
    contract.contract_id === 'G1-master-data-api-v1'
      && contract.contract_version === '1.0.0'
      && contract.status === 'frozen_pass');

  check('G1-02 沿用单一契约且未伪造生成类型或 Mock',
    contract.generated_artifacts?.status === 'not_present_in_repository'
      && contract.generated_artifacts.types === null
      && contract.generated_artifacts.mocks === null);

  const requiredDomains = ['project', 'project_role', 'contractor_company', 'personnel', 'personnel_assignment', 'join_application', 'contractor_archive', 'certificate_gate'];
  const domains = new Set(contract.rpcs.map(item => item.domain));
  check('G1-03 D06+D07+D08 主数据域已覆盖', requiredDomains.every(item => domains.has(item)));

  const boundary = validateTestBoundary();
  check('G1-GATE 隔离测试边界', assertD02FixtureMarker(boundary) > 0);

  const identities = contract.rpcs.map(item => item.db_identity);
  const identityValues = identities.map(item => `(${sqlLiteral(item)})`).join(',');
  const missingFunctions = runPsql(boundary.databaseUrl, `
    WITH required(identity) AS (VALUES ${identityValues})
    SELECT COALESCE(string_agg(identity, ','), '')
    FROM required WHERE to_regprocedure(identity) IS NULL;
  `);
  check('G1-04 契约 RPC 与实际数据库对象一致', missingFunctions === '', missingFunctions);

  const fieldRows = contract.resources.flatMap(resource =>
    resource.public_fields.map(field => [resource.name, field]));
  for (const [table, column] of fieldRows) {
    if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_]+$/.test(column)) throw new Error('契约字段名不安全');
  }
  const fieldValues = fieldRows.map(([table, column]) => `(${sqlLiteral(table)},${sqlLiteral(column)})`).join(',');
  const missingFields = runPsql(boundary.databaseUrl, `
    WITH required(table_name, column_name) AS (VALUES ${fieldValues})
    SELECT COALESCE(string_agg(table_name || '.' || column_name, ','), '')
    FROM required r WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
    );
  `);
  check('G1-05 REST 资源字段与实际数据库列一致', missingFields === '', missingFields);

  const projectConstraint = runPsql(boundary.databaseUrl, `
    SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conrelid='public.site_projects'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%planning%' LIMIT 1;
  `);
  check('G1-06 项目状态集合及项目角色集合稳定',
    contract.enums.project_status.join(',') === 'planning,active,paused,pending_close,closed'
      && contract.enums.project_role.join(',') === 'project_manager,safety_officer'
      && ['planning', 'active', 'paused', 'pending_close', 'closed'].every(value => projectConstraint.includes(value)));

  const d08Sql = source(
    'sql/training-admission-v69-contractor-company-versioning.sql',
    'sql/training-admission-v70-personnel-identity-history.sql',
    'sql/training-admission-v71-project-join-state-machine.sql',
    'sql/training-admission-v72-contractor-archive-and-certificate-compliance.sql',
    'sql/training-admission-v73-project-member-insert-boundary.sql'
  );
  check('G1-07 项目级钻探字段、受控入口与全员范围已冻结',
    contract.enums.drilling_requirement_code[0] === 'drilling_project_training'
      && contract.rpcs.some(item => item.name === 'site_project_set_drilling_operation')
      && contract.rpcs.some(item => item.name === 'training_project_drilling_training_scope')
      && d08Sql.includes('site_projects\n  ADD COLUMN IF NOT EXISTS includes_drilling')
      && d08Sql.includes("THEN 'drilling_project_training'::TEXT"));

  check('G1-08 钻探不属于个人证照或人员级特殊作业',
    contract.enums.certificate_type.join(',') === '爆破,电工,焊工'
      && contract.enums.special_work_type.join(',') === '爆破,电工,焊工'
      && !contract.enums.certificate_type.includes('钻探')
      && !contract.enums.special_work_type.includes('钻探')
      && /certificate_type IN \('爆破', '电工', '焊工'\)/.test(d08Sql)
      && /special_work_types <@ ARRAY\['爆破', '电工', '焊工'\]/.test(d08Sql));

  const publicResponseFields = contract.resources.flatMap(item => item.public_fields)
    .concat(contract.rpcs.filter(item => !item.sensitive_result).flatMap(item => item.result_fields || []));
  const forbidden = new Set(contract.privacy.forbidden_default_response_fields);
  check('G1-09 普通响应不暴露身份证密文、私有 HMAC 或 Vault 字段',
    !publicResponseFields.some(field => forbidden.has(field))
      && contract.privacy.project_role_full_identity === false
      && contractRpc(contract, 'training_contractor_personnel_ledger')?.identity_result.startsWith('always masked'));

  const sensitiveNames = contract.rpcs.filter(item => item.sensitive_result).map(item => item.name).sort();
  const sensitivePrivileges = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
    'employee_cipher', has_column_privilege('authenticated', 'public.training_employees', 'id_number_ciphertext', 'SELECT'),
    'employee_hmac', has_column_privilege('authenticated', 'public.training_employees', 'id_number_match_token', 'SELECT'),
    'application_cipher', has_column_privilege('authenticated', 'public.project_join_applications', 'id_number_ciphertext', 'SELECT'),
    'application_hmac', has_column_privilege('authenticated', 'public.project_join_applications', 'id_number_digest', 'SELECT')
  )::text;`));
  check('G1-10 完整身份只列出受控接口且敏感列无普通 SELECT',
    sensitiveNames.join(',') === 'training_employee_identity_get,training_join_application_identity'
      && Object.values(sensitivePrivileges).every(value => value === false));

  const joinConstraint = runPsql(boundary.databaseUrl, `
    SELECT string_agg(pg_get_constraintdef(oid), ' ') FROM pg_constraint
    WHERE conrelid='public.project_join_applications'::regclass AND contype='c';
  `);
  check('G1-11 首次、同实体、跨实体路径及申请状态进入契约',
    contract.enums.join_review_path.join(',') === 'first_project,same_entity_cross_project,cross_entity'
      && contract.enums.join_application_status.every(value => joinConstraint.includes(value))
      && ['first_project', 'same_entity_cross_project', 'cross_entity'].every(value => d08Sql.includes(value)));

  const idempotencyDb = JSON.parse(runPsql(boundary.databaseUrl, `SELECT json_build_object(
    'identity_unique', to_regclass('public.uq_training_employees_identity_match') IS NOT NULL,
    'join_identity_unique', to_regclass('public.uq_project_join_active_identity') IS NOT NULL,
    'join_applicant_unique', to_regclass('public.uq_project_join_active_applicant') IS NOT NULL,
    'member_unique', EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='site_project_members'
        AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%project_id%' AND indexdef LIKE '%employee_id%'
    )
  )::text;`));
  check('G1-12 申请、审核、人员和成员幂等语义与并发控制已冻结',
    Object.values(idempotencyDb).every(Boolean)
      && d08Sql.includes('pg_advisory_xact_lock')
      && d08Sql.includes("'changed', FALSE")
      && contract.idempotency.client_prohibitions.length === 2
      && runPsql(boundary.databaseUrl,
        "SELECT has_function_privilege('authenticated','public.training_batch_add_contractor_members(uuid,uuid,jsonb)','EXECUTE');") === 'f');

  const actualMessages = [
    '请先登录', '项目当前未开放外协人员申请', '邀请码无效或已过期',
    '该人员在本项目已有有效申请', '当前账号在本项目已有其他有效身份申请',
    '该身份已绑定其他账号，请联系经营实体管理员核验', '申请关联人员与安全身份匹配结果不一致'
  ];
  const reasonCases = new Set(contract.reason_contract.map(item => item.case));
  check('G1-13 稳定状态/原因仅映射真实 wire 或实际状态字段',
    actualMessages.every(message => d08Sql.includes(message))
      && ['unauthenticated', 'forbidden', 'project_paused', 'project_closed', 'invite_invalid_or_expired',
        'duplicate_or_idempotent_existing_application', 'identity_conflict', 'pending_project_review',
        'pending_entity_review', 'cross_entity_review_required', 'certificate_missing_or_type_mismatch',
        'certificate_expired', 'certificate_pending_review', 'certificate_revoked',
        'special_work_not_required', 'drilling_project_scope'].every(item => reasonCases.has(item)));

  const storagePolicyCount = Number(runPsql(boundary.databaseUrl, `
    SELECT count(*) FROM pg_policies WHERE schemaname='storage'
      AND policyname IN ('training_admission_contractor_read','training_admission_project_update','training_admission_project_delete');
  `));
  const contractorWeb = source('js/modules/training/contractors.js');
  check('G1-14 文件元数据、权限、归档限制和 300 秒签名 URL 已冻结',
    contract.file_access.signed_url_ttl_seconds === 300
      && contract.file_access.metadata_resources.length === 3
      && storagePolicyCount === 3
      && contract.file_access.upload_binding.includes('auth.uid')
      && d08Sql.includes('site_project_join_file_can_bind')
      && d08Sql.includes('o.owner_id = auth.uid()::TEXT')
      && /createSignedUrl\(path,\s*300\)/.test(contractorWeb));

  const securityDefinerIssues = runPsql(boundary.databaseUrl, `
    WITH required(identity) AS (VALUES ${identityValues}), f AS (
      SELECT identity, p.prosecdef, COALESCE(array_to_string(p.proconfig, ','), '') AS config
      FROM required r JOIN pg_proc p ON p.oid=to_regprocedure(r.identity)
    ) SELECT COALESCE(string_agg(identity, ','), '') FROM f
      WHERE NOT prosecdef OR config NOT LIKE '%search_path=%';
  `);
  check('G1-15 公开 RPC 均为固定 search_path 的 SECURITY DEFINER', securityDefinerIssues === '', securityDefinerIssues);

  const shapeNames = [
    'contractor_company_create', 'contractor_company_update', 'contractor_company_review',
    'training_employee_create', 'training_employee_update', 'training_employee_photo_update',
    'contractor_contract_create', 'contractor_contract_review', 'contractor_document_create',
    'contractor_document_review', 'contractor_document_revoke', 'site_project_review_application',
  ];
  const shapeDefinitions = Object.fromEntries(shapeNames.map(name => {
    const identity = contractRpc(contract, name)?.db_identity;
    const encoded = identity ? runPsql(boundary.databaseUrl,
      `SELECT encode(convert_to(pg_get_functiondef(to_regprocedure(${sqlLiteral(identity)})), 'UTF8'), 'base64');`) : '';
    return [name, encoded ? Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8') : ''];
  }));
  const shapesMatch = shapeNames.every(name => {
    const rpc = contractRpc(contract, name);
    const actualBranches = jsonbReturnBranches(shapeDefinitions[name]);
    const variants = rpc?.result_schema?.variants || [];
    const branchShapeMatch = variants.length
      ? actualBranches.length === variants.length
        && actualBranches.every(branch => variants.some(variant =>
          normalizedKeySets([branch.keys])[0] === normalizedKeySets([[
            ...(variant.required || []), ...(variant.optional || []),
          ]])[0]
          && Object.entries(variant.when).every(([field, value]) => branch.literals[field] === value)))
        && variants.every(variant => actualBranches.some(branch =>
          normalizedKeySets([branch.keys])[0] === normalizedKeySets([[
            ...(variant.required || []), ...(variant.optional || []),
          ]])[0]
          && Object.entries(variant.when).every(([field, value]) => branch.literals[field] === value)))
      : normalizedKeySets(actualBranches.map(branch => branch.keys)).join('|')
        === normalizedKeySets(declaredResultKeySets(rpc)).join('|');
    return validateResultSchema(rpc) && branchShapeMatch;
  });
  const archiveNames = ['contractor_contract_create', 'contractor_contract_review',
    'contractor_document_create', 'contractor_document_review'];
  const actualApplyReturn = runPsql(boundary.databaseUrl, `SELECT pg_get_function_result(
    to_regprocedure('public.site_project_apply(text,text,text,text,text,text,text,text,jsonb)'));`);
  const reviewAuthorization = contractRpc(contract, 'site_project_review_application')?.authorization || '';
  const memberInsertBoundary = runPsql(boundary.databaseUrl,
    "SELECT has_table_privilege('authenticated','public.site_project_members','INSERT');");
  check('G1-15A 核心 JSONB 每个返回分支、字段类型及 required/optional 与实际函数一致', shapesMatch
    && archiveNames.every(name => !/'version_no'\s*,/i.test(shapeDefinitions[name]))
    && !/'contractor_id'\s*,/i.test(shapeDefinitions.contractor_company_create)
    && actualApplyReturn === 'uuid'
    && contractRpc(contract, 'site_project_apply')?.result_schema?.format === 'uuid'
    && contract.result_contract_semantics?.['result_schema.variants']?.includes('exact successful branch shapes')
    && contractRpc(contract, 'site_project_review_application')?.result_schema?.request_context_fields_not_echoed?.includes('application_id')
    && !/'application_id'\s*,/i.test(shapeDefinitions.site_project_review_application)
    && reviewAuthorization.includes('target lead-entity manager')
    && reviewAuthorization.includes('project_manager/safety_officer')
    && /IF v_app\.review_path = 'first_project'[\s\S]*site_project_can_manage\(v_app\.project_id\)/i.test(shapeDefinitions.site_project_review_application)
    && memberInsertBoundary === 'f'
    && contract.resources.find(item => item.name === 'site_project_members')?.access.includes('no direct INSERT/UPDATE/DELETE'));

  const runtimeSamples = runtimeResultSamples(boundary.databaseUrl);
  const runtimeNames = [
    'training_employee_create', 'training_employee_photo_update',
    'training_employee_update', 'site_project_review_application',
  ];
  check('G1-15B 人员及审核 RPC 实际返回类型、nullable 与全部成功分支符合契约',
    runtimeNames.every(name => validateRuntimeResults(contractRpc(contract, name), runtimeSamples[name])));

  const mutatedType = structuredClone(contract);
  contractRpc(mutatedType, 'training_employee_create').result_schema.properties.employee_id.type = 'integer';
  delete contractRpc(mutatedType, 'training_employee_create').result_schema.properties.employee_id.format;
  const mutatedNullable = structuredClone(contract);
  contractRpc(mutatedNullable, 'training_employee_create').result_schema.properties.photo_path.nullable = false;
  const mutatedRequired = structuredClone(contract);
  const reviewSchema = contractRpc(mutatedRequired, 'site_project_review_application').result_schema;
  reviewSchema.required.push('employee_id');
  reviewSchema.optional = reviewSchema.optional.filter(field => field !== 'employee_id');
  check('G1-15C 故意破坏 type、nullable 或 required 时 verifier 均会失败',
    !validateRuntimeResults(contractRpc(mutatedType, 'training_employee_create'), runtimeSamples.training_employee_create)
      && !validateRuntimeResults(contractRpc(mutatedNullable, 'training_employee_create'), runtimeSamples.training_employee_create)
      && !validateRuntimeResults(contractRpc(mutatedRequired, 'site_project_review_application'), runtimeSamples.site_project_review_application));
  const runtimeResidue = Number(runPsql(boundary.databaseUrl, `SELECT
    (SELECT count(*) FROM public.site_projects WHERE report_notes='G1 runtime contract')
    + (SELECT count(*) FROM public.training_employees WHERE remark='G1 runtime contract')
    + (SELECT count(*) FROM public.contractor_companies WHERE name LIKE '[G1-TEST] 外协单位 %')
    + (SELECT count(*) FROM public.project_join_applications WHERE name LIKE '[G1-TEST] %')
    + (SELECT count(*) FROM storage.objects WHERE name LIKE '%/g1-%');`));
  check('G1-15D 运行时返回契约夹具事务回滚且测试残留为零', runtimeResidue === 0,
    `residue=${runtimeResidue}`);

  check('G1-16 D12/D30/D31 可直接消费且无需猜内部结构',
    contract.cross_line_inputs.D12.project_drilling_source === 'site_projects.includes_drilling'
      && contract.cross_line_inputs.D12.drilling_scope_rpc === 'training_project_drilling_training_scope'
      && contract.cross_line_inputs.D30.rules.some(rule => rule.includes('private HMAC'))
      && contract.cross_line_inputs.D31.apply_rpc === 'site_project_apply');

  const handoffs = [
    'docs/handoffs/D07-project-role-permissions.md',
    'docs/handoffs/D08-contractor-personnel-archive.md',
    'docs/handoffs/G1-master-data-api-v1.md',
  ];
  const traceability = source('docs/requirements-traceability.md', 'docs/01-requirement-traceability-matrix.md');
  check('G1-17 D07/D08/G1 交接和需求追踪已收口',
    handoffs.every(item => fs.existsSync(path.join(root, item)))
      && traceability.includes('6ceb5a4ea3338fd812c774e5ae6cea18dd506bd0')
      && traceability.includes('G1-master-data-api-v1 frozen'));

  const internalPlainRpc = runPsql(boundary.databaseUrl,
    "SELECT has_function_privilege('authenticated', 'public.training_employee_identity_plain(uuid)', 'EXECUTE');");
  const serialized = JSON.stringify(contract);
  check('G1-18 契约不含秘密、真实身份或内部解密入口',
    internalPlainRpc === 'f'
      && !serialized.includes('training_employee_identity_plain')
      && !/service[_ -]?role[^\"]*[:=][^\"]{8}/i.test(serialized)
      && !/signedUrl\"\s*:\s*\"https?:/i.test(serialized)
      && !/[1-9][0-9]{16}[0-9X]/.test(serialized));

  const failed = results.filter(item => !item.pass);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`G1_MASTER_DATA_CONTRACT_SUMMARY total=${results.length} passed=${results.length - failed.length} failed=${failed.length} elapsed_s=${elapsed.toFixed(2)}`);
  if (failed.length) process.exitCode = 1;
}

module.exports = { runtimeResultSamples, validateRuntimeResults };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`G1 contract verification failed: ${error.message}`);
    process.exit(1);
  }
}

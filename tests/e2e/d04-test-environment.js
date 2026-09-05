const { spawnSync } = require('child_process');
const { required } = require('./test-config');

const D02_FIXTURE_RUN_KEY = 'D02-TEST-20260903';

function validateTestBoundary() {
  const environment = required('SAFETY_ENV');
  const apiUrl = new URL(required('SAFETY_SUPABASE_URL'));
  const databaseUrl = new URL(required('SAFETY_TEST_DB_URL'));
  const projectRef = apiUrl.hostname.split('.')[0];
  const databaseUser = decodeURIComponent(databaseUrl.username);

  if (environment !== 'test') throw new Error('SAFETY_ENV 不是 test，拒绝运行真实测试。');
  if (apiUrl.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(apiUrl.hostname)) {
    throw new Error('Supabase API 地址不符合隔离测试门禁。');
  }
  if (!/pooler\.supabase\.com$/.test(databaseUrl.hostname) || !databaseUser.includes(projectRef)) {
    throw new Error('API 与测试数据库项目标识不一致，拒绝运行。');
  }

  return { apiOrigin: apiUrl.origin, databaseUrl: databaseUrl.toString() };
}

function runPsqlScalar(databaseUrl, sql) {
  const result = spawnSync('psql', [databaseUrl, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error('无法只读核验 D02 测试夹具标记。');
  }
  return String(result.stdout || '').trim();
}

function assertD02FixtureMarker(boundary, scalarQuery = runPsqlScalar) {
  const sql = `SELECT count(*) FROM public.safety_test_fixture_registry WHERE run_key='${D02_FIXTURE_RUN_KEY}';`;
  const count = Number.parseInt(scalarQuery(boundary.databaseUrl, sql), 10);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`未发现 ${D02_FIXTURE_RUN_KEY} 测试夹具标记，拒绝发起真实测试。`);
  }
  return count;
}

module.exports = {
  D02_FIXTURE_RUN_KEY,
  assertD02FixtureMarker,
  runPsqlScalar,
  validateTestBoundary,
};

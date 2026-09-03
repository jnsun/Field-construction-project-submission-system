const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const required = [
  ['docs/02-dual-track-ownership.md', ['track/web-backend', 'track/miniprogram', 'integration/dual-track', 'miniprogram/**', 'C01']],
  ['docs/handoffs/README.md', ['不可变交接记录', 'docs/contracts/change-requests/']],
  ['docs/handoffs/D02-shared-baseline.md', ['D02-AC01', '未冻结', 'Mock']],
  ['docs/changes/C01-template.md', ['当前消费契约版本', '幂等键', '安全 Mock']],
  ['docs/contracts/change-requests/README.md', ['CR-<任务>-<序号>.md', '-response.md']],
  ['docs/02-local-test-environment.md', ['development', 'test', 'staging', 'production', 'safety_test_fixture_registry']],
  ['.env.example', ['SAFETY_ENV', 'SAFETY_TEST_DB_URL', 'SAFETY_QR_TEST_SIGNING_KEY']],
  ['.gitignore', ['.env', 'backups/', 'test-results/']],
  ['tools/backup-test-db.ps1', ['ExpectedProjectRef', 'pg_dump']],
  ['tools/restore-test-db.ps1', ['pg_restore', 'test|staging|dev']],
  ['tools/clear-test-fixtures.sql', ['D02_TEST_ONLY', 'safety_test_fixture_registry']]
];

for (const [relative, snippets] of required) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`Missing ${relative}`);
  const content = fs.readFileSync(file, 'utf8');
  for (const snippet of snippets) {
    if (!content.includes(snippet)) throw new Error(`${relative} is missing ${snippet}`);
  }
}

console.log(`D02 baseline verification passed: ${required.length} files checked.`);

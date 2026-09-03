/**
 * D04 training-admission smoke baseline.
 *
 * No test account or key is stored here. With SAFETY_ENV=test and the existing
 * D02 account variables present, the runner invokes the established API checks.
 * Without them it still validates the UI/SQL entry points and reports live cases
 * as environment-blocked rather than passing them.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const node = process.execPath;
const requiredLive = [
  'SAFETY_SUPABASE_URL', 'SAFETY_SUPABASE_ANON_KEY',
  'SAFETY_TEST_ADMIN_EMAIL', 'SAFETY_TEST_ADMIN_PASSWORD',
  'SAFETY_TEST_ENTITY_EMAIL', 'SAFETY_TEST_ENTITY_PASSWORD',
];
const results = [];

function record(id, status, detail, severity = 'P2') {
  results.push({ id, status, severity, detail });
  console.log(`${status.toUpperCase()} ${id} [${severity}] ${detail}`);
}

function contains(file, text) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return source.includes(text);
}

function staticCase(id, file, text, requirement) {
  const exists = fs.existsSync(path.join(root, file));
  const ok = exists && contains(file, text);
  record(id, ok ? 'passed' : 'failed', ok
    ? `${requirement}; entry found in ${file}`
    : `${requirement}; missing ${text} in ${file}`, ok ? 'P3' : 'P1');
}

function runExisting(name, requirement) {
  const child = spawnSync(node, [path.join(__dirname, name)], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${child.stdout || ''}${child.stderr || ''}`.replace(/[\r\n]+/g, ' ').slice(0, 500);
  record(`D04-LIVE-${name}`, child.status === 0 ? 'passed' : 'failed',
    `${requirement}; exit=${child.status}; ${output}`, child.status === 0 ? 'P2' : 'P1');
}

function main() {
  // Static entry-point coverage maps the T25 main path without inventing data.
  staticCase('D04-S01', 'index.html', 'js/modules/training/training.js', 'T25-AC01 training entry');
  staticCase('D04-S02', 'js/modules/training/projects.js', 'site_project', 'T25-AC01 project register');
  staticCase('D04-S03', 'js/modules/training/admission-review.js', 'join', 'T25-AC02 contractor application');
  staticCase('D04-S04', 'js/modules/training/courses.js', 'saveGeneratedHtml', 'T25-AC01 course publishing');
  staticCase('D04-S05', 'js/modules/training/mine.js', 'exam', 'T25-AC01 study and exam');
  staticCase('D04-S06', 'js/modules/training/admission-operations.js', 'confirm', 'T25-AC01 signature/site confirmation');
  staticCase('D04-S07', 'js/modules/training/admission-verify.js', 'verify', 'T25-AC07 certificate QR verification');
  staticCase('D04-S08', 'js/modules/training/admission-reports.js', 'report', 'T25-AC07 reports');
  staticCase('D04-S09', 'js/modules/training/admission-visitors.js', 'visitor', 'T25-AC06 leader visitor');
  staticCase('D04-S10', 'sql/training-admission-v11.sql', 'temporary_access', 'T25-AC06 temporary access');
  staticCase('D04-S11', 'sql/training-admission-v1.sql', "'paused'", 'T25-AC05 pause/resume/close');
  staticCase('D04-S12', 'sql/training-admission-v10.sql', 'training_admission_special_rules', 'T25-AC04 high-risk role');

  const missing = requiredLive.filter(name => !String(process.env[name] || '').trim());
  if (process.env.SAFETY_ENV !== 'test' || missing.length) {
    record('D04-LIVE-GATE', 'blocked',
      `T25-AC01~AC07 live API smoke not run: require SAFETY_ENV=test and local variables ${missing.join(', ') || 'SAFETY_ENV=test'}.`, 'P1');
  } else {
    runExisting('verify-dept-fix.js', 'T25-AC03 cross-entity role baseline');
    runExisting('verify-people.js', 'T25-AC01 employee account and authority baseline');
    runExisting('verify-stats.js', 'T25-AC07 report authority baseline');
  }

  const failed = results.filter(item => item.status === 'failed');
  const blocked = results.filter(item => item.status === 'blocked');
  console.log(JSON.stringify({ suite: 'D04', passed: results.length - failed.length - blocked.length, failed: failed.length, blocked: blocked.length, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main();

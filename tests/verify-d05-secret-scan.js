/**
 * D05 secret scan for the current Web/backend checkout.
 * Findings intentionally contain only a relative path and a secret type.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const findings = new Map();

function normalize(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function isExcluded(file) {
  return file === '.git'
    || file.startsWith('.git/')
    || file === 'node_modules'
    || file.startsWith('node_modules/')
    || file === 'docs/plans'
    || file.startsWith('docs/plans/');
}

function addFinding(file, type) {
  const key = `${normalize(file)}\0${type}`;
  findings.set(key, { path: normalize(file), type });
}

function isPlaceholder(value) {
  const normalized = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  return !normalized
    || /^(?:set_locally|change[-_ ]?me|replace[-_ ]?me|example|dummy|test|your[-_<]|<)/i.test(normalized)
    || /^\$\{[^}]+\}$/.test(normalized)
    || /^\$\(/.test(normalized)
    || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
    || /^`[^`]+`$/.test(normalized)
    || /^(?:jwt|service)$/.test(normalized)
    || /^(?:process\.env|import\.meta\.env|runtimeConfig|globalThis|window)\b/.test(normalized)
    || /(?:example\.invalid|your-test-project|user:password@host)/i.test(normalized);
}

function assignedValues(text, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:^|[\\t {;,])["']?${escaped}["']?[\\t ]*[:=][\\t ]*([^\\t \\r\\n,;}]+)`, 'gim');
  return [...text.matchAll(regex)].map(match => match[1]);
}

function isClientSurface(file) {
  return /^(?:js\/|dist\/|build\/|public\/)/i.test(file)
    || /^[^/]+\.html?$/i.test(file)
    || /(?:vite|webpack|rollup|parcel)(?:\.[^/]*)?\.config\.[cm]?[jt]s$/i.test(file);
}

function inspect(file, text, tracked) {
  const normalized = normalize(file);
  const client = isClientSurface(normalized);

  if (tracked && /(^|\/)\.env(?:\.|$)/i.test(normalized) && !/\.example$/i.test(normalized)) {
    addFinding(normalized, 'TRACKED_ENV_FILE');
  }

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    addFinding(normalized, 'PRIVATE_KEY');
  }
  if (/\bsb_secret_[A-Za-z0-9_-]{16,}\b/.test(text)) {
    addFinding(normalized, 'SUPABASE_SECRET_KEY');
  }

  const secretAssignments = [
    ['JWT_SIGNING_SECRET', ['JWT_SECRET', 'SUPABASE_JWT_SECRET', 'JWT_SIGNING_KEY', 'JWT_SIGNING_SECRET']],
    ['SERVICE_ROLE_KEY', ['SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']],
    ['DATABASE_CREDENTIAL', ['DATABASE_URL', 'DB_PASSWORD', 'DATABASE_PASSWORD']],
    ['APPLICATION_SIGNING_SECRET', ['SIGNING_SECRET', 'SIGNING_KEY', 'QR_SIGNING_SECRET', 'QR_SIGNING_KEY']],
  ];
  for (const [type, identifiers] of secretAssignments) {
    for (const identifier of identifiers) {
      for (const value of assignedValues(text, identifier)) {
        if (!isPlaceholder(value)) addFinding(normalized, type);
      }
      if (client && new RegExp(`\\b${identifier}\\b`).test(text)) {
        addFinding(normalized, `CLIENT_${type}_REFERENCE`);
      }
    }
  }

  if (client && /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)) {
    addFinding(normalized, 'BROWSER_JWT_LITERAL');
  }
}

function readText(file) {
  const absolute = path.join(root, file);
  let stat;
  try { stat = fs.statSync(absolute); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

function gitFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('无法读取 Git tracked 文件清单。');
  return String(result.stdout || '').split('\0').filter(Boolean).map(normalize);
}

function untrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('无法读取 Git untracked 文件清单。');
  return String(result.stdout || '').split('\0').filter(Boolean).map(normalize);
}

function walk(directory, select, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = normalize(path.relative(root, absolute));
    if (isExcluded(relative)) continue;
    if (entry.isDirectory()) walk(absolute, select, output);
    else if (entry.isFile() && select(relative)) output.push(relative);
  }
  return output;
}

function main() {
  const tracked = gitFiles();
  const trackedSet = new Set(tracked);
  const untracked = untrackedFiles();
  const extraEnvironmentFiles = walk(root, file => /(^|\/)\.env(?:\.|$)/i.test(file));
  const extraLogFiles = walk(root, file => /\.log$/i.test(file));
  const extraBuildFiles = ['dist', 'build', 'public']
    .flatMap(directory => walk(path.join(root, directory), () => true));
  const files = [...new Set([...tracked, ...untracked, ...extraEnvironmentFiles, ...extraLogFiles, ...extraBuildFiles])]
    .filter(file => !isExcluded(file));

  for (const file of files) {
    const text = readText(file);
    if (text !== null) inspect(file, text, trackedSet.has(file));
  }

  const ordered = [...findings.values()].sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
  for (const finding of ordered) console.error(`SECRET_SCAN_FAIL path=${finding.path} type=${finding.type}`);
  console.log(`D05_SECRET_SCAN tracked=${tracked.length} untracked=${untracked.length} env_files=${extraEnvironmentFiles.length} log_files=${extraLogFiles.length} build_files=${extraBuildFiles.length} findings=${ordered.length}`);
  process.exitCode = ordered.length ? 1 : 0;
}

try {
  main();
} catch (error) {
  console.error(`D05_SECRET_SCAN_ERROR type=SCANNER_INFRASTRUCTURE message=${error.message}`);
  process.exitCode = 2;
}

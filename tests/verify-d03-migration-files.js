const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlDir = path.join(root, 'sql');
const failures = [];

function verifyManifest(file, firstVersion, lastVersion) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sqlDir, file), 'utf8'));
  const expectedLength = lastVersion - firstVersion + 1;
  if (manifest.migrations.length !== expectedLength) failures.push(`${file} must contain exactly v${firstVersion}-v${lastVersion}.`);
  for (let expected = firstVersion; expected <= lastVersion; expected += 1) {
    const migration = manifest.migrations[expected - firstVersion];
    if (!migration || migration.version !== expected) {
      failures.push(`${file} is missing or misorders v${expected}.`);
      continue;
    }
  const filePath = path.join(sqlDir, migration.file);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing ${migration.file}.`);
    continue;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const digestSource = source.replace(/\r\n/g, '\n');
  const digest = crypto.createHash('sha256').update(digestSource).digest('hex').toUpperCase();
  if (digest !== migration.sha256) failures.push(`Checksum changed for ${migration.file}; update the manifest after review.`);
  if (/\bDROP\s+TABLE\b/i.test(source) || /\bTRUNCATE\b/i.test(source)) failures.push(`${migration.file} contains destructive table SQL.`);
  const executable = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const definers = (executable.match(/SECURITY\s+DEFINER/gi) || []).length;
  const fixedPaths = (executable.match(/SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*public(?:\s*,\s*(?:extensions|vault|storage))*/gi) || []).length;
  if (definers !== fixedPaths) failures.push(`${migration.file} has SECURITY DEFINER without fixed public search_path.`);
  if (/GRANT\s+EXECUTE[\s\S]*?\bTO\s+(?:PUBLIC|anon)\b/i.test(source)) failures.push(`${migration.file} grants RPC execution to PUBLIC or anon.`);
  }
  return manifest;
}

const v1v16 = verifyManifest('training-admission-v1-v16.manifest.json', 1, 16);
const v17v49 = verifyManifest('training-admission-v17-v49.manifest.json', 17, 73);

for (const file of v1v16.bootstrapFilesForEmptyDatabase) {
  if (!fs.existsSync(path.join(sqlDir, file))) failures.push(`Bootstrap prerequisite missing: ${file}.`);
}
if (!fs.existsSync(path.join(sqlDir, v1v16.postMigrationHardening))) failures.push('D03 hardening SQL is missing.');
if (/DROP\s+TABLE\s+IF\s+EXISTS\s+d03_data_fingerprint/i.test(fs.readFileSync(path.join(sqlDir, 'd03-data-fingerprint.sql'), 'utf8'))) failures.push('D03 fingerprint must not drop a persistent table.');
if (!fs.existsSync(path.join(root, 'tests', 'compare-d03-fingerprints.js'))) failures.push('D03 historical fingerprint comparator is missing.');
if (!fs.existsSync(path.join(root, 'tests', 'compare-d03-schema-inventory.js'))) failures.push('D03 schema inventory comparator is missing.');
if (!fs.existsSync(path.join(sqlDir, 'd03-v0-historical-anonymous-seed.sql'))) failures.push('D03 v0 anonymous historical seed is missing.');
if (!fs.existsSync(path.join(root, 'tools', 'run-d03-disposable-replay-recovery.ps1'))) failures.push('D03 disposable replay and recovery entrypoint is missing.');
if (failures.length) {
  console.error('D03 migration file verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`D03 migration file verification passed: ${v1v16.migrations.length + v17v49.migrations.length} versions, ${v1v16.bootstrapFilesForEmptyDatabase.length} bootstrap files.`);

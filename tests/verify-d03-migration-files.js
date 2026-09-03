const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sqlDir = path.join(root, 'sql');
const manifest = JSON.parse(fs.readFileSync(path.join(sqlDir, 'training-admission-v1-v16.manifest.json'), 'utf8'));
const failures = [];

if (manifest.migrations.length !== 16) failures.push('Manifest must contain exactly v1-v16.');
for (let expected = 1; expected <= 16; expected += 1) {
  const migration = manifest.migrations[expected - 1];
  if (!migration || migration.version !== expected) {
    failures.push(`Missing or misordered migration v${expected}.`);
    continue;
  }
  const filePath = path.join(sqlDir, migration.file);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing ${migration.file}.`);
    continue;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const digest = crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
  if (digest !== migration.sha256) failures.push(`Checksum changed for ${migration.file}; update the manifest after review.`);
  if (/\bDROP\s+TABLE\b/i.test(source) || /\bTRUNCATE\b/i.test(source)) failures.push(`${migration.file} contains destructive table SQL.`);
  const executable = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const definers = (executable.match(/SECURITY\s+DEFINER/gi) || []).length;
  const fixedPaths = (executable.match(/SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*public/gi) || []).length;
  if (definers !== fixedPaths) failures.push(`${migration.file} has SECURITY DEFINER without fixed public search_path.`);
  if (/GRANT\s+EXECUTE[\s\S]*?\bTO\s+(?:PUBLIC|anon)\b/i.test(source)) failures.push(`${migration.file} grants RPC execution to PUBLIC or anon.`);
}

for (const file of manifest.bootstrapFilesForEmptyDatabase) {
  if (!fs.existsSync(path.join(sqlDir, file))) failures.push(`Bootstrap prerequisite missing: ${file}.`);
}
if (!fs.existsSync(path.join(sqlDir, manifest.postMigrationHardening))) failures.push('D03 hardening SQL is missing.');
if (failures.length) {
  console.error('D03 migration file verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log(`D03 migration file verification passed: ${manifest.migrations.length} versions, ${manifest.bootstrapFilesForEmptyDatabase.length} bootstrap files.`);

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'config', 'd03-storage-application-boundary.json');
const initializerPath = path.join(root, 'sql', 'd03-storage-application-config.sql');
const archivePath = path.join(root, 'tools', 'd03-archive.ps1');
const failures = [];

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (JSON.stringify(manifest.archive_scope) !== JSON.stringify(['public'])) failures.push('D03 archive scope must be public only.');
if (!fs.existsSync(initializerPath)) failures.push('Storage application initializer is missing.');
const initializer = fs.existsSync(initializerPath) ? fs.readFileSync(initializerPath, 'utf8') : '';
const archive = fs.readFileSync(archivePath, 'utf8');
if (!/--schema=public/.test(archive) || /--schema=storage/.test(archive)) failures.push('Shared archive helper must dump public only.');

for (const bucket of manifest.application_buckets) {
  const sourcePath = path.join(root, bucket.source);
  if (!fs.existsSync(sourcePath)) failures.push(`Missing bucket source: ${bucket.source}`);
  else if (!fs.readFileSync(sourcePath, 'utf8').includes(`'${bucket.id}'`)) failures.push(`Bucket ${bucket.id} is not evidenced by ${bucket.source}.`);
  if (!initializer.includes(`'${bucket.id}'`)) failures.push(`Initializer does not reconstruct bucket ${bucket.id}.`);
}
for (const policy of manifest.application_policies) {
  const sourcePath = path.join(root, policy.source);
  if (!fs.existsSync(sourcePath)) failures.push(`Missing policy source: ${policy.source}`);
  else if (!new RegExp(`CREATE\\s+POLICY\\s+\\"?${policy.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\"?\\s+ON\\s+storage\\.objects`, 'i').test(fs.readFileSync(sourcePath, 'utf8'))) failures.push(`Policy ${policy.name} is not evidenced by ${policy.source}.`);
  if (!new RegExp(`CREATE\\s+POLICY\\s+\\"?${policy.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\"?\\s+ON\\s+storage\\.objects`, 'i').test(initializer)) failures.push(`Initializer does not reconstruct policy ${policy.name}.`);
}
if (manifest.application_storage_indexes.length !== 0 || manifest.application_storage_grants.length !== 0) failures.push('Unexpected unverified Storage indexes or grants in D03 manifest.');
if (failures.length) { console.error('D03 Storage boundary verification failed:'); failures.forEach((failure) => console.error(`- ${failure}`)); process.exit(1); }
console.log(`D03 Storage boundary verification passed: ${manifest.application_buckets.length} buckets, ${manifest.application_policies.length} policies, public-only archive.`);

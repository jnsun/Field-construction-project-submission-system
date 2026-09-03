const fs = require('fs');

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error('Usage: node tests/compare-d03-fingerprints.js <before.csv> <after.csv>');

function readFingerprint(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.replace(/^\uFEFF/, '') === 'table_schema,table_name,row_count,row_hash');
  if (headerIndex === -1) throw new Error(`${file} has an unexpected fingerprint header`);
  return new Map(lines.slice(headerIndex + 1).filter(Boolean).map((line) => {
    const [schema, table, count, hash] = line.split(',');
    return [`${schema}.${table}`, { count, hash }];
  }));
}

const before = readFingerprint(beforeFile);
const after = readFingerprint(afterFile);
for (const [table, snapshot] of before) {
  const current = after.get(table);
  if (!current) throw new Error(`Historical table disappeared: ${table}`);
  if (current.count !== snapshot.count) throw new Error(`Historical row count changed for ${table}: ${snapshot.count} -> ${current.count}`);
  if (current.hash !== snapshot.hash) throw new Error(`Historical row hash changed for ${table}`);
}
console.log(`D03 historical fingerprint comparison passed: ${before.size} tables preserved.`);

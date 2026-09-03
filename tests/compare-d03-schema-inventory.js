const fs = require('fs');

const [expectedFile, actualFile] = process.argv.slice(2);
if (!expectedFile || !actualFile) throw new Error('Usage: node tests/compare-d03-schema-inventory.js <expected.csv> <actual.csv>');

function rows(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.replace(/^\uFEFF/, '') === 'category,object_name,details');
  if (headerIndex === -1) throw new Error(`${file} has an unexpected schema inventory header`);
  return lines.slice(headerIndex + 1).filter(Boolean).sort();
}

const expected = rows(expectedFile);
const actual = rows(actualFile);
if (expected.length !== actual.length || expected.some((row, index) => row !== actual[index])) {
  throw new Error(`Schema inventory differs after restore: expected ${expected.length} rows, got ${actual.length}`);
}
console.log(`D03 schema inventory comparison passed: ${expected.length} objects preserved.`);

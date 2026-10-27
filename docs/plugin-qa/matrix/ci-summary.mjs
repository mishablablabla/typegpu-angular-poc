// Markdown summary of a harness results file for the GitHub step summary. Usage: node ci-summary.mjs <results.jsonl> <label>
import { existsSync, readFileSync } from 'node:fs';

const [file, label = ''] = process.argv.slice(2);
console.log(`### ${label}`);
if (!file || !existsSync(file)) {
  console.log('No results file (the harness did not get that far).');
  process.exit(0);
}
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const count = (status) => rows.filter((row) => row.status === status).length;
console.log(`pass ${count('pass')}, fail ${count('fail')}, skip ${count('skip')}, error ${count('error')} of ${rows.length}`);
console.log('');
console.log('| id | category | expected | status | seconds | detail |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) {
  const detail = String(row.detail ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`| ${row.id} | ${row.category} | ${row.expected} | ${row.status} | ${(row.ms / 1000).toFixed(0)} | ${detail} |`);
}

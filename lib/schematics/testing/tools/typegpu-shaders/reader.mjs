// Test helper: reads every file of an output folder in a tight loop until a stop file appears, and prints how many it read and which
// reads were torn (empty or truncated files, JSON that does not parse): what another process's build would see.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, stop] = process.argv.slice(2);
let reads = 0;
const torn = {};
// Never spin forever (found by QA: a failing test deleted its folder before writing the stop file, and this loop then ran at 100% CPU as an
// orphan): it also ends when its parent is gone, when the folder it reads is gone, or after two minutes.
const parent = process.ppid;
const deadline = Date.now() + 120_000;
let tick = 0;
const abandoned = () => process.ppid !== parent || !existsSync(out) || Date.now() > deadline;
while (!existsSync(stop) && !(++tick % 200 === 0 && abandoned())) {
  let names = [];
  try {
    names = readdirSync(out);
  } catch {
    continue;
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(out, name), 'utf8');
    } catch {
      continue; // being replaced or removed: fine
    }
    reads++;
    let problem;
    if (name.endsWith('.js')) {
      if (!text.includes('sourceMappingURL=')) problem = `${name} truncated`;
    } else if (name.endsWith('.map') || name === '.manifest.json') {
      try {
        JSON.parse(text);
      } catch {
        problem = `${name} not JSON`;
      }
    } else if (name.endsWith('.d.ts') && text.length === 0) problem = `${name} empty`;
    if (problem) torn[problem] = (torn[problem] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ reads, torn }));

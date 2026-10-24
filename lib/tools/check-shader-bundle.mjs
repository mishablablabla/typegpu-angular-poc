// CI check for `'use gpu'` shaders: run after `ng build` (also the production configuration, which the
// `ng test` tripwire spec does not cover).
//   node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs dist/<app>/browser
// Exits 1 and lists every `'use gpu'` directive in the output that was not wrapped with TypeGPU metadata
// (the symptom of a shader module the build plugin did not transform).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node check-shader-bundle.mjs <build output directory, e.g. dist/app/browser>');
  process.exit(2);
}

const untransformed = [];
let directives = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(join(dir, file), 'utf8');
  for (const match of source.matchAll(/["']use gpu["']\s*;/g)) {
    directives++;
    // A transformed function is `<ident>.f = function/arrow { 'use gpu'; ...`: the wrapper precedes the directive.
    const before = source.slice(Math.max(0, match.index - 260), match.index);
    if (!/[\w$]+\.f\s*=\s*(?:async\s+)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)\s*=>|[\w$]+\s*=>)\s*\{\s*$/.test(before)) {
      const line = source.slice(0, match.index).split('\n').length;
      untransformed.push(`${file}:${line}  ...${before.slice(-60).replace(/\s+/g, ' ')}`);
    }
  }
}

if (untransformed.length > 0) {
  console.error(`${untransformed.length} of ${directives} 'use gpu' directive(s) were not transformed:`);
  untransformed.forEach((u) => console.error('  ' + u));
  console.error('Check the shader plugin setup in angular.json (also in the configuration you built) and the import specifiers.');
  process.exit(1);
}
console.log(`ok: ${directives} 'use gpu' directive(s) in ${dir}, all transformed`);

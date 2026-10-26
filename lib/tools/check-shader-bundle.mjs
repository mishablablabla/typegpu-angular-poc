#!/usr/bin/env node
// CI check for `'use gpu'` shaders: run after `ng build` (also the production configuration, which the
// `ng test` tripwire spec does not cover).
//   node node_modules/@typegpu-poc/angular/tools/check-shader-bundle.mjs [--allow-empty] <dir> [<dir>...]
//   e.g. dist/<app>/browser  (or dist/<app> to include localized builds and the SSR server bundle)
// Scans every .js / .mjs / .cjs file under the directories (recursively). Exits
//   0  every `'use gpu'` directive found is wrapped with TypeGPU metadata (= the build plugin transformed it)
//   1  at least one directive was not transformed, or no directive was found at all (see --allow-empty)
//   2  bad usage, or a directory that does not exist / is not a directory
// A directive is the string `'use gpu'` as the first statement of a function; the same text inside a string,
// template literal, comment or regular expression does not count.
//
// Zero directives is an error by default: it usually means the wrong directory was scanned, or the build did
// not contain the shaders. Pass --allow-empty when an app legitimately has none yet (for example right after
// `ng add`, before the first shader component exists): the tool then only warns and exits 0.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { scanUseGpu } from './use-gpu-scan.mjs';

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const USAGE = 'Usage: node check-shader-bundle.mjs [--allow-empty] <build output directory, e.g. dist/app/browser> [<directory>...]';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`${USAGE}\n\nExit codes: 0 all 'use gpu' directives transformed; 1 an untransformed directive (or none at all, unless --allow-empty); 2 bad usage or a missing directory.`);
  process.exit(0);
}
const allowEmpty = args.includes('--allow-empty');
const unknownFlags = args.filter((a) => a.startsWith('--') && a !== '--allow-empty');
const dirs = args.filter((a) => !a.startsWith('--'));
if (unknownFlags.length > 0 || dirs.length === 0) {
  if (unknownFlags.length) console.error(`check-shader-bundle: unknown option ${unknownFlags.join(', ')}`);
  console.error(USAGE);
  process.exit(2);
}

/** All script files below `dir`, sorted; symbolic links to directories are not followed. */
function scriptFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scriptFiles(path));
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
  }
  return files;
}

const untransformed = [];
let directives = 0;
let scanned = 0;
for (const dir of dirs) {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    console.error(`check-shader-bundle: directory not found: ${resolve(dir)} (run the build first, or check the path)`);
    process.exit(2);
  }
  if (!stats.isDirectory()) {
    console.error(`check-shader-bundle: not a directory: ${resolve(dir)} (pass the build output directory)`);
    process.exit(2);
  }
  const files = scriptFiles(dir);
  scanned += files.length;
  console.log(`check-shader-bundle: scanning ${files.length} script file(s) under ${resolve(dir)}`);
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('use gpu')) continue; // cheap pre-filter: no directive can be in a file without the text
    for (const directive of scanUseGpu(source)) {
      directives++;
      if (!directive.transformed) {
        untransformed.push({
          file: relative(process.cwd(), file) || file,
          line: directive.line,
          context: source.slice(Math.max(0, directive.index - 60), directive.index).replace(/\s+/g, ' '),
        });
      }
    }
  }
}

if (untransformed.length > 0) {
  console.error(`${untransformed.length} of ${directives} 'use gpu' directive(s) were not transformed:`);
  const shown = untransformed.slice(0, 50);
  shown.forEach((u) => console.error(`  ${u.file}:${u.line}  ...${u.context}`));
  if (untransformed.length > shown.length) console.error(`  ... and ${untransformed.length - shown.length} more`);
  console.error('Possible causes:');
  console.error('  - the shader plugin is missing from the build configuration you built (angular.json: build.options.plugins and configurations[*].plugins)');
  console.error('  - the module is not named *.gpu.ts, or was imported through a path the plugin does not see (see the plugin docs)');
  console.error("  - with the prebuild (`typegpu-shaders`): an application file imports a shader module by a relative path instead of '@shaders/...'. Run `typegpu-shaders check`");
  console.error("  - with the prebuild: a shader module (or a helper of one) is imported through a tsconfig `paths` alias or a `baseUrl` path other than '@shaders/...': import it as '@shaders/...' (the static `typegpu-shaders check` cannot see aliases)");
  const workers = [...new Set(untransformed.map((u) => u.file))].filter((f) => /(^|[\\/._-])worker([\\/._-]|$)/i.test(f));
  if (workers.length > 0) {
    console.error(
      `  - Web Workers are not supported: Angular's application builder does not pass user esbuild plugins to worker bundles (${workers.join(', ')}). Keep shaders out of workers.`,
    );
  } else {
    console.error('  - the code is in a Web Worker bundle (not supported: the application builder does not pass user esbuild plugins to workers)');
  }
  process.exit(1);
}

if (directives === 0) {
  const where = dirs.map((d) => resolve(d)).join(', ');
  if (allowEmpty) {
    console.warn(`warning: no 'use gpu' directive in ${scanned} script file(s) under ${where}; nothing was checked (--allow-empty).`);
    process.exit(0);
  }
  console.error(
    `error: no 'use gpu' directive in ${scanned} script file(s) under ${where}, so nothing was checked. ` +
      `Wrong directory, or the build has no shader code yet? If the app really has no shader yet (right after ng add), run again with --allow-empty.`,
  );
  process.exit(1);
}
console.log(`ok: ${directives} 'use gpu' directive(s) in ${scanned} file(s) under ${dirs.join(', ')}, all transformed`);

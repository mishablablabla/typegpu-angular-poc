#!/usr/bin/env node
// Verifies the packed library: the tarball is the thing consumers install, so check IT, not lib/dist.
//
//   node scripts/verify-package.mjs [<tarball>] [--source lib/package.json] [--installed app/node_modules/@typegpu-poc/angular]
//                                   [--lock app/package-lock.json] [--compare <other.tgz>] [--print-integrity] [--no-mode-checks]
// --compare:   report how another tarball (e.g. packed on Windows) differs: files, content (fails) and modes (reported, never fails).
// --installed: also check that the package npm installed into a consumer is byte-identical to the tarball (same files, same content).
// --lock:      also check that a lockfile that pins the tarball's integrity matches it (only for a design that commits that integrity).
//
// <tarball> defaults to lib/typegpu-poc-angular-<version>.tgz. No dependencies: the tarball is read in memory (no `tar` binary, so no
// GNU-tar "C:\path" host-syntax trouble on Windows runners, and nothing is written to disk). Exit code 1 on any failure.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const bool = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const printIntegrity = bool('--print-integrity');
const noModeChecks = bool('--no-mode-checks');
// Paths given on the command line are relative to the current directory; the defaults are relative to the repository root.
const fromCwd = (value, fallback) => (value === undefined ? resolve(root, fallback) : resolve(process.cwd(), value));
const sourcePath = fromCwd(flag('--source'), 'lib/package.json');
const installedArg = flag('--installed');
const compareArg = flag('--compare');
const lockArg = flag('--lock');
const lockPath = lockArg ? resolve(process.cwd(), lockArg) : undefined;
const sourceManifest = JSON.parse(readFileSync(sourcePath, 'utf8'));
const tarballPath = fromCwd(args[0], `lib/${sourceManifest.name.replace(/^@/, '').replace('/', '-')}-${sourceManifest.version}.tgz`);

const modeChecks = !noModeChecks; // modes live in the tarball, so this is OS-independent; skip only for a tarball deliberately packed on Windows
const failures = [];
const fail = (message) => failures.push(message);
const check = (condition, message) => condition || fail(message);

// ---- read the tarball (ustar + pax + GNU long names) ----------------------------------------------------------------------------------
const raw = readFileSync(tarballPath);
const integrity = `sha512-${createHash('sha512').update(raw).digest('base64')}`;

function readTar(buffer) {
  const files = new Map(); // path (without the leading "package/") -> { data, mode }
  const text = (start, length) => buffer.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  let offset = 0;
  let pendingPath;
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const name = text(offset, 100);
    const mode = Number.parseInt(text(offset + 100, 8).trim() || '0', 8);
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = text(offset + 156, 1) || '0';
    const prefix = text(offset + 345, 155);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      // pax extended header: "<len> key=value\n" records
      for (const record of body.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(record);
        if (m) pendingPath = m[1];
      }
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      pendingPath = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    if (type !== '0' && type !== '7') {
      fail(`tarball entry ${path}: unexpected type '${type}' (only regular files belong in a package)`);
      continue;
    }
    check(!files.has(path), `tarball entry ${path}: duplicated`);
    files.set(path, { data: Buffer.from(body), mode });
  }
  return files;
}

const entries = readTar(gunzipSync(raw));
const files = new Map();
for (const [path, entry] of entries) {
  if (!path.startsWith('package/') || path.split('/').includes('..') || path.includes('\\')) {
    fail(`tarball entry ${path}: outside package/ or not a POSIX relative path`);
    continue;
  }
  files.set(path.slice('package/'.length), entry);
}
const has = (path) => files.has(posix.normalize(path.replace(/^\.\//, '')));
const json = (path) => {
  try {
    return JSON.parse(files.get(path).data.toString('utf8'));
  } catch (error) {
    fail(`${path}: not valid JSON (${error.message})`);
    return undefined;
  }
};

// ---- 1. files the runtime needs ------------------------------------------------------------------------------------------------------
const required = [
  'package.json',
  'README.md',
  'builders.json',
  'schematics/collection.json',
  'schematics/package.json', // {"type":"commonjs"}: without it the compiled schematics are loaded as ESM and fail
  'fesm2022/typegpu-poc-angular.mjs',
  'fesm2022/typegpu-poc-angular-testing.mjs',
  'types/typegpu-poc-angular.d.ts',
  'types/typegpu-poc-angular-testing.d.ts',
  'tools/typegpu-shaders.esbuild.mjs',
  'tools/check-shader-bundle.mjs',
  'tools/use-gpu-scan.mjs',
  'tools/typegpu-shaders/cli.mjs',
  'tools/typegpu-shaders/index.mjs',
];
for (const path of required) check(has(path), `missing required file: ${path}`);

// Everything shipped from source directories must really be in the tarball (catches an assets glob that silently stopped matching).
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const libDir = dirname(sourcePath);
for (const dir of ['tools', 'builders']) {
  if (!existsSync(join(libDir, dir))) continue;
  for (const file of walk(join(libDir, dir))) {
    const rel = relative(libDir, file).split(sep).join('/');
    check(has(rel), `source file ${rel} is not in the tarball`);
    if (has(rel)) check(Buffer.compare(readFileSync(file), files.get(rel).data) === 0, `${rel}: tarball content differs from the source file`);
  }
}
if (existsSync(join(libDir, 'schematics'))) {
  for (const file of walk(join(libDir, 'schematics'))) {
    const rel = relative(libDir, file).split(sep).join('/');
    const isTemplate = rel.split('/').includes('files') && !rel.includes('/testing/');
    const isShippedJson = rel.endsWith('.json') && !rel.startsWith('schematics/testing/') && !rel.endsWith('tsconfig.json');
    if (isTemplate || isShippedJson) check(has(rel), `source file ${rel} is not in the tarball`);
    // Compiled schematics: every non-spec, non-testing .ts has a .js next to it.
    if (rel.endsWith('.ts') && !rel.endsWith('.spec.ts') && !rel.endsWith('.d.ts') && !rel.startsWith('schematics/testing/') && !rel.includes('/files/')) {
      check(has(rel.replace(/\.ts$/, '.js')), `compiled schematic missing: ${rel.replace(/\.ts$/, '.js')}`);
    }
  }
}

// ---- 2. nothing that must not ship ---------------------------------------------------------------------------------------------------
for (const path of files.keys()) {
  if (/\.spec\.(ts|js|mjs|cjs)(\.map)?$|(^|\/)testing\/(fixtures|builders|tools)\/|(^|\/)node_modules\/|\.tsbuildinfo$|(^|\/)\.(npmignore|git|DS_Store)/.test(path)) {
    fail(`must not ship: ${path}`);
  }
}
const machinePaths = /(\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/private\/tmp|\/var\/folders|[A-Za-z]:\\\\?(Users|a)\\|\/home\/runner|\/Desktop\/)/;
for (const [path, { data }] of files) {
  if (/\.(mjs|cjs|js|json|ts|md|template|map)$/.test(path) === false) continue;
  const content = data.toString('utf8');
  if (path.endsWith('.map')) {
    // source maps hold relative "../" sources; absolute machine paths would make the tarball differ per machine
    if (machinePaths.test(content)) fail(`${path}: contains an absolute machine path`);
    continue;
  }
  if (path !== 'README.md' && machinePaths.test(content)) fail(`${path}: contains an absolute machine path (${machinePaths.exec(content)[0]})`);
  if (content.includes('\r')) fail(`${path}: contains CR characters (CRLF checkout/emit leaked into the package; the tarball would differ per OS)`);
}

// ---- 3. manifest ------------------------------------------------------------------------------------------------------------------------
const manifest = files.has('package.json') ? json('package.json') : undefined;
if (manifest) {
  const binTargets = new Set(Object.values(manifest.bin ?? {}).map((p) => posix.normalize(p)));
  const exportTargets = [];
  const collect = (value, where) => {
    if (typeof value === 'string') exportTargets.push([value, where]);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) collect(inner, `${where}.${key}`);
  };
  collect(manifest.exports, 'exports');
  for (const key of ['module', 'typings', 'types', 'main', 'schematics', 'builders']) if (manifest[key]) exportTargets.push([manifest[key], key]);
  for (const [name, target] of Object.entries(manifest.bin ?? {})) exportTargets.push([target, `bin.${name}`]);
  for (const [target, where] of exportTargets) check(has(target), `package.json ${where} -> ${target}: not in the tarball`);

  check(manifest.name === sourceManifest.name && manifest.version === sourceManifest.version, 'package.json name/version differ from the source manifest');
  // Fields ng-packagr must carry over unchanged from lib/package.json; it adds module/typings/exports/type and drops scripts/devDependencies.
  for (const key of ['name', 'version', 'license', 'description', 'private', 'sideEffects', 'dependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin', 'schematics', 'builders', 'ng-add', 'engines']) {
    check(JSON.stringify(sortKeys(manifest[key])) === JSON.stringify(sortKeys(sourceManifest[key])), `package.json "${key}" differs from ${relative(process.cwd(), sourcePath)}`);
  }
  for (const key of ['scripts', 'devDependencies']) check(!(key in manifest), `package.json must not contain "${key}"`);
  check(manifest.type === 'module' && Boolean(manifest.exports?.['.']) && Boolean(manifest.exports?.['./testing']), 'package.json: type/exports (".", "./testing") missing');

  // bin: shebang, LF, executable bit (npm adds the bit to bin entries when packing; Windows checkouts do not have it, so check the tarball).
  for (const target of binTargets) {
    const entry = files.get(target);
    if (!entry) continue;
    check(entry.data.toString('utf8').startsWith('#!/usr/bin/env node\n'), `bin ${target}: must start with "#!/usr/bin/env node" followed by LF`);
    // npm does NOT add the bit for a bin written as "./tools/x.mjs" (pacote compares the raw string), so it is whatever the packing checkout had.
    // A Windows checkout has no exec bit, so a tarball packed there differs from a POSIX one: pack on Linux, reuse the artifact elsewhere
    // (use --no-mode-checks only to inspect a Windows-packed tarball).
    if (modeChecks) check((entry.mode & 0o111) === 0o111, `bin ${target}: not executable in the tarball (mode ${entry.mode.toString(8)})`);
  }
  // Every other file must be 0644 or the tarball differs between a Windows and a POSIX pack.
  if (modeChecks) for (const [path, { mode }] of files) if (!binTargets.has(path) && mode !== 0o644) fail(`${path}: mode ${mode.toString(8)} (expected 644; modes must not depend on the packing OS)`);

  // Runtime imports must be declared or provided by the Angular CLI that runs the schematics/builders.
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), manifest.name]);
  const providedByCli = new Set(['@angular-devkit/schematics', '@schematics/angular', '@angular-devkit/core', '@angular-devkit/architect', '@angular/build']);
  for (const [path, { data }] of files) {
    if (!/^(schematics|builders|tools|fesm2022)\/.*\.(js|cjs|mjs)$/.test(path)) continue;
    for (const m of data.toString('utf8').matchAll(/(?:require\(|from\s+|import\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      check(declared.has(pkg) || providedByCli.has(pkg), `${path}: imports "${spec}", which is neither a dependency, a peer, nor provided by the Angular CLI`);
    }
  }
}

// ---- 4. schematics collection and builders manifest: every referenced file exists and exports what is named ----------------------------
const resolveModule = (base, ref) => {
  const target = posix.join(posix.dirname(base), ref);
  return ['', '.js', '.cjs', '.mjs', '/index.js'].map((ext) => target + ext).find((candidate) => files.has(candidate));
};
if (files.has('schematics/collection.json')) {
  const collection = json('schematics/collection.json');
  for (const [name, schematic] of Object.entries(collection?.schematics ?? {})) {
    const [file, exportName] = String(schematic.factory).split('#');
    const module = resolveModule('schematics/collection.json', file);
    if (!module) fail(`collection.json: schematic "${name}" factory ${schematic.factory} has no file in the tarball`);
    else if (exportName && !new RegExp(`exports\\.${exportName}\\b|exports\\.${exportName}\\s*=`).test(files.get(module).data.toString('utf8'))) fail(`collection.json: ${module} does not export "${exportName}"`);
    if (schematic.schema) {
      const schemaPath = posix.join('schematics', schematic.schema.replace(/^\.\//, ''));
      check(has(schemaPath), `collection.json: schematic "${name}" schema ${schematic.schema} not in the tarball`);
      if (has(schemaPath)) json(schemaPath);
    }
  }
}
if (files.has('builders.json')) {
  const builders = json('builders.json');
  for (const [name, builder] of Object.entries(builders?.builders ?? {})) {
    check(has(builder.implementation), `builders.json: "${name}" implementation ${builder.implementation} not in the tarball`);
    check(has(builder.schema), `builders.json: "${name}" schema ${builder.schema} not in the tarball`);
    if (has(builder.schema)) json(builder.schema.replace(/^\.\//, ''));
  }
}
for (const [path] of files) if (path.endsWith('.json') && !path.endsWith('.map')) json(path); // every JSON file parses

// ---- 5. (optional) the committed lockfile describes this exact tarball ----------------------------------------------------------------
// Only for the design where app/package-lock.json pins the tarball's integrity; the pack is byte-reproducible (see the CI notes).
if (lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const entry = lock.packages?.[`node_modules/${sourceManifest.name}`];
  check(Boolean(entry), `${relative(process.cwd(), lockPath)}: no entry for ${sourceManifest.name}`);
  if (entry) {
    check(entry.integrity === integrity, `${relative(process.cwd(), lockPath)}: integrity ${entry.integrity} != packed tarball ${integrity}`);
  }
}

// ---- 7. (optional) how does another tarball differ (experiment: Windows pack vs Linux pack) -----------------------------------------
if (compareArg) {
  const other = new Map([...readTar(gunzipSync(readFileSync(resolve(process.cwd(), compareArg))))].map(([path, entry]) => [path.replace(/^package\//, ''), entry]));
  for (const path of files.keys()) if (!other.has(path)) fail(`--compare: ${path} is only in ${relative(process.cwd(), tarballPath)}`);
  for (const path of other.keys()) if (!files.has(path)) fail(`--compare: ${path} is only in ${compareArg}`);
  for (const [path, { data, mode }] of files) {
    const twin = other.get(path);
    if (!twin) continue;
    if (Buffer.compare(data, twin.data) !== 0) fail(`--compare: ${path} has different content (${data.length} vs ${twin.data.length} bytes)`);
    else if (mode !== twin.mode) console.error(`note: ${path} has mode ${mode.toString(8)} vs ${twin.mode.toString(8)} (a different mode alone changes the tarball hash)`);
  }
}

// ---- 6. (optional) what npm installed is what was packed ---------------------------------------------------------------------------
if (installedArg) {
  const installedRoot = resolve(process.cwd(), installedArg);
  if (!existsSync(installedRoot)) fail(`--installed ${installedArg}: directory does not exist`);
  else {
    if (lstatSync(installedRoot).isSymbolicLink()) fail(`${installedArg} is a symlink: peers would resolve from the library's own node_modules (duplicate Angular); install a copy`);
    const installed = new Map(walk(installedRoot).map((file) => [relative(installedRoot, file).split(sep).join('/'), file]));
    for (const [path, { data }] of files) {
      if (!installed.has(path)) fail(`installed package lacks ${path}`);
      else if (Buffer.compare(readFileSync(installed.get(path)), data) !== 0) fail(`installed ${path} differs from the tarball`);
    }
    for (const path of installed.keys()) if (!files.has(path)) fail(`installed package has ${path}, which is not in the tarball`);
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

const list = [...files.keys()].sort();
if (failures.length > 0) {
  console.error(`verify-package: ${failures.length} problem(s) in ${relative(process.cwd(), tarballPath)} (${list.length} files)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
// --print-integrity: stdout carries only the integrity (for `$(...)`), the report goes to stderr
if (printIntegrity) {
  console.log(integrity);
  console.error(`verify-package: ok, ${list.length} files`);
} else console.log(`verify-package: ok, ${list.length} files, ${integrity}`);

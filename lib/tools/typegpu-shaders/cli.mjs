#!/usr/bin/env node
// typegpu-shaders: prebuild the project's TypeGPU shader modules (`*.gpu.ts` and what they import) into plain JavaScript plus declarations,
// outside the application's own build. See the package README ("Shader prebuild").
import { relative } from 'node:path';
import { runCommand } from './command.mjs';
import { resolveConfig } from './config.mjs';
import { createBuilder } from './build.mjs';
import { checkShaders } from './check.mjs';
import { watchShaders } from './watch.mjs';
import { computeClosure } from './graph.mjs';
import { formatDiagnostic } from './diagnostics.mjs';

const TAG = '[typegpu-shaders]';
const USAGE = `Usage: typegpu-shaders <command> [options] [-- <command to run>]

Commands
  build              Transform the shader modules into <out>/ (JavaScript, declarations, source maps). Exit 1 on any error.
  watch              Build, then rebuild after every change. A failing module is replaced by an error banner + throw until fixed.
  check              Verify <out>/ matches the sources and the application imports it correctly. Exit 1 otherwise.
  run -- <cmd...>    build, then run <cmd> (for example: ng build). Exits 1 without running <cmd> if the build fails.
  dev -- <cmd...>    watch while <cmd> runs (for example: ng serve). Stops when <cmd> ends.

Options
  --root <dir>       Project root (default: the current folder)
  --src <dir>        Folder with the shader modules (default: src)
  --out <dir>        Output folder (default: shaders-dist)
  --suffix <text>    Entry point file suffix (default: .gpu.ts)
  --alias <prefix>   Import prefix of the generated modules (default: @shaders/)
  --tsconfig <file>  tsconfig for the declarations (default: tsconfig.app.json, then tsconfig.json)
  --config <file>    JSON config (default: typegpu-shaders.config.json if present)
  --fix-imports      check: rewrite relative imports of shader modules to the alias
`;

function parse(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  const [command, ...flags] = own;
  const options = {};
  let fixImports = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--fix-imports') fixImports = true;
    else if (/^--(root|src|out|suffix|alias|tsconfig|config)$/.test(flag)) {
      if (flags[i + 1] === undefined) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = flags[++i];
    } else throw new Error(`Unknown option ${flag}`);
  }
  return { command, options, fixImports, rest };
}

function report(result, previous) {
  if (result.diagnostics.length) {
    for (const d of result.diagnostics) console.error(formatDiagnostic(d) + '\n');
    console.error(`${TAG} ${result.diagnostics.length} error(s).`);
  } else {
    console.log(`${TAG} ${result.files.length} modules (${result.ms} ms)${previous && !previous.ok ? ' - recovered' : ''}`);
  }
}

async function main() {
  const { command, options, fixImports, rest } = parse(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  if ((command === 'run' || command === 'dev') && rest.length === 0) throw new Error(`${command} needs a command after "--", for example: typegpu-shaders ${command} -- ng ${command === 'run' ? 'build' : 'serve'}`);
  const config = resolveConfig(options);

  if (command === 'build') {
    const result = await createBuilder(config).run({ stubs: false });
    report(result);
    return result.ok ? 0 : 1;
  }
  if (command === 'check') {
    const { ok, problems, fixed } = checkShaders(options, { fixImports });
    if (fixed) console.log(`${TAG} rewrote relative shader imports in ${fixed} file(s).`);
    for (const problem of problems) console.error(`${TAG} ${problem.message}`);
    if (ok) console.log(`${TAG} ${relative(config.root, config.out) || config.out} is up to date; no stray or unresolved shader imports.`);
    return ok ? 0 : 1;
  }
  // `run` and `dev` wrap another command (usually `ng build`/`ng serve`): a project that has no shader module yet must not fail
  // because of that, so the command just runs. `build` and `check` stay strict.
  const empty = (command === 'run' || command === 'dev') && computeClosure(config).entries.length === 0;
  if (empty) console.log(`${TAG} no "*${config.suffix}" modules under ${relative(config.root, config.src) || '.'}: nothing to build, running the command as it is`);
  if (command === 'run') {
    const result = empty ? { ok: true, diagnostics: [], files: [], ms: 0 } : await createBuilder(config).run({ stubs: false });
    if (!empty) report(result);
    if (!result.ok) {
      console.error(`${TAG} not running "${rest.join(' ')}": the shader build failed.`);
      return 1;
    }
    return await runCommand(rest, config.root);
  }
  if (command === 'dev' && empty) return await runCommand(rest, config.root);
  if (command === 'watch' || command === 'dev') {
    // `dev`: this process (not the watcher) handles the signals: the command gets them first, the stubs are removed once it has ended
    const watcher = watchShaders({ ...options, handleSignals: command === 'watch' }, { onBuild: (result, previous) => report(result, previous) });
    const first = await watcher.ready;
    if (command === 'watch') {
      console.log(`${TAG} watching ${relative(config.root, config.src) || '.'} (Ctrl+C to stop)`);
      const stop = () => {
        watcher.close();
        process.exit(0);
      };
      for (const signal of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
      return await new Promise(() => {});
    }
    if (!first.ok) console.error(`${TAG} the first build failed; the failing module shows its error in the page until it is fixed.`);
    try {
      return await runCommand(rest, config.root);
    } finally {
      watcher.close();
    }
  }
  throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`${TAG} ${error.message}`);
    process.exit(2);
  },
);

#!/usr/bin/env node
// typegpu-siblings generate | verify | watch | clean [--root <dir>] [--src <dir>]. The Angular builders do all of this themselves; the command is for
// scripts, editors and CI that want the files without a build.
import { relative } from 'node:path';
import { formatDiagnostic, generate, inspect, resolveConfig, verify } from './index.mjs';
import { removeGenerated } from './files.mjs';
import { watchSiblings } from './watch.mjs';

const TAG = '[typegpu-siblings]';
const [command, ...flags] = process.argv.slice(2);
const options = {};
for (let i = 0; i < flags.length; i++) {
  if (!/^--(root|src|suffix)$/.test(flags[i]) || flags[i + 1] === undefined) (console.error(`Usage: typegpu-siblings generate|verify|watch|clean [--root <dir>] [--src <dir>] [--suffix <text>]`), process.exit(2));
  options[flags[i].slice(2)] = flags[++i];
}
const config = resolveConfig(options);
const show = (result) => {
  result.diagnostics.forEach((d) => console.error(`${TAG} ${formatDiagnostic(d)}`));
  console.log(`${TAG} ${result.files.length} shader module(s), ${result.built} generated (${result.ms} ms)`);
};

if (command === 'generate') {
  const result = await generate(config);
  show(result);
  process.exit(result.ok ? 0 : 1);
} else if (command === 'verify') {
  const problems = verify(config);
  problems.forEach((p) => console.error(`${TAG} ${p.file}: ${p.text}`));
  if (!problems.length) console.log(`${TAG} every generated file is current`);
  process.exit(problems.length ? 1 : 0);
} else if (command === 'watch') {
  watchSiblings(config, { onBuild: show });
  console.log(`${TAG} watching ${relative(config.root, config.src) || '.'} (Ctrl+C to stop)`);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else if (command === 'clean') {
  const { found } = inspect(config);
  const removed = found.generated.filter((path) => removeGenerated(config, path)).length;
  console.log(`${TAG} removed ${removed} generated file(s)`);
} else {
  console.error('Usage: typegpu-siblings generate|verify|watch|clean [--root <dir>] [--src <dir>] [--suffix <text>]');
  process.exit(2);
}

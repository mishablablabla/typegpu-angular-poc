// A throwaway project for the shader prebuild tests: a few sources, a tsconfig, and the package's own node_modules (esbuild, TypeScript,
// Babel, unplugin-typegpu, typegpu) linked in, because the tool uses the project's copies.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The tool reports paths relative to the project the way the platform writes them ('src\\wave.gpu.ts' on Windows); the tests compare them as POSIX.
export const posix = (text: string) => text.replaceAll('\\', '/');

export const CLI = join(__dirname, '../../../../tools/typegpu-shaders/cli.mjs');
const NODE_MODULES = join(__dirname, '../../../../node_modules');

export const MODEL = `export const state = { count: 0 };\nexport const SCALE = 3;\n`;
export const SHADER = `import tgpu, { d, std } from 'typegpu';
import { SCALE, state } from './model';

export const wave = tgpu.fn([d.f32], d.f32)((x) => {
  'use gpu';
  return std.sin(x) * SCALE;
});

export const touch = () => ++state.count;
`;
export const MAIN = `import { wave } from '@shaders/wave.gpu';\nimport { state } from '@shaders/model';\nexport const used = [wave, state];\n`;
/** A `'use gpu'` function the transform cannot handle (no position in the error, only the file). */
export const BAD_SHADER = `${SHADER}\nexport const bad = (x: number) => {\n  'use gpu';\n  try {\n    return x;\n  } catch (e) {\n    return 0;\n  }\n};\n`;

export type Project = ReturnType<typeof createProject>;

export function createProject(files: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'typegpu-shaders-')));
  symlinkSync(NODE_MODULES, join(root, 'node_modules'));
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module' }),
    'tsconfig.app.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'preserve', moduleResolution: 'bundler', skipLibCheck: true, isolatedModules: true, types: [] },
      include: ['src/**/*.ts'],
    }),
    'src/model.ts': MODEL,
    'src/wave.gpu.ts': SHADER,
    'src/app/main.ts': MAIN,
    ...files,
  };
  const project = {
    root,
    path: (...parts: string[]) => join(root, ...parts),
    write(path: string, text: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    },
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
    exists: (path: string) => existsSync(join(root, path)),
    remove: (path: string) => rmSync(join(root, path), { recursive: true, force: true }),
    /** Import a generated module (a new URL every time, so Node does not serve a cached copy). */
    import: (path: string) => import(/* @vite-ignore */ `${pathToFileURL(join(root, path)).href}?t=${Date.now()}${Math.random()}`),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const [path, text] of Object.entries(all)) project.write(path, text);
  return project;
}

export async function waitFor(condition: () => boolean, what: string, timeout = 20_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

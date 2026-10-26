// What the freshness key covers, and what the closure reaches (mutation testing of the QA run: none of this was protected).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { checkShaders, buildShaders, resolveConfig } from '../../../../tools/typegpu-shaders/index.mjs';
// @ts-expect-error plain ES module without types
import { computeClosure } from '../../../../tools/typegpu-shaders/graph.mjs';
// @ts-expect-error plain ES module without types
import { computeHash } from '../../../../tools/typegpu-shaders/manifest.mjs';
// @ts-expect-error plain ES module without types
import { watchShaders } from '../../../../tools/typegpu-shaders/index.mjs';
import { createProject, SHADER, type Project } from './project';

let project: Project;
beforeEach(() => {
  project = createProject();
});
afterEach(() => project.dispose());

const VERSIONS = { tool: 'tool@1', typegpu: '0.12.8', unplugin: '0.12.6', esbuild: '0.28.2', typescript: '6.0.3', babel: '7.29.7' };
const hashOf = (versions = VERSIONS, mutate?: (config: Record<string, unknown>) => void) => {
  const config = resolveConfig({ root: project.root });
  const files = computeClosure(config).files; // the closure of the real configuration; only the hash sees the changed setting
  mutate?.(config);
  return computeHash(config, files, versions);
};

describe('the freshness key', () => {
  it('is stable for the same inputs', () => {
    expect(hashOf()).toBe(hashOf());
  });

  it.each(Object.keys(VERSIONS))('changes with the %s version (a dependency upgrade must rebuild)', (key) => {
    expect(hashOf({ ...VERSIONS, [key]: `${(VERSIONS as Record<string, string>)[key]}-other` })).not.toBe(hashOf());
  });

  it('changes with the suffix that selects shader modules, and with the content or the path of a module', () => {
    expect(hashOf(VERSIONS, (config) => (config['suffix'] = '.shader.ts'))).not.toBe(hashOf());
    const before = hashOf();
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 4;\n');
    expect(hashOf()).not.toBe(before);
    project.write('src/model.ts', 'export const state = { count: 0 };\nexport const SCALE = 3;\n');
    expect(hashOf()).toBe(before);
    // the same bytes under another name are another module (the output names follow the path)
    const renamed = hashOf();
    project.write('src/wave2.gpu.ts', project.read('src/wave.gpu.ts'));
    project.remove('src/wave.gpu.ts');
    expect(hashOf()).not.toBe(renamed);
  });
});

describe('the closure of shader modules', () => {
  beforeEach(() => {
    // wave.gpu.ts -> helper.ts -> deep/model2.ts : two levels below the shader
    project.write('src/deep/model2.ts', 'export const BASE = 3;\n');
    project.write('src/helper.ts', "import { BASE } from './deep/model2';\nexport const twice = BASE * 2;\n");
    project.write('src/wave.gpu.ts', SHADER.replace("import { SCALE, state } from './model';", "import { state } from './model';\nimport { twice } from './helper';\nconst SCALE = twice;"));
  });

  it('reaches modules several levels deep, and an edit that deep makes the output stale and is rebuilt', async () => {
    const config = resolveConfig({ root: project.root });
    const names = computeClosure(config).files.map((file: string) => file.slice(config.src.length + 1));
    expect(names).toEqual(['deep/model2.ts', 'helper.ts', 'model.ts', 'wave.gpu.ts']);
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    for (const name of ['deep/model2', 'helper', 'model', 'wave.gpu']) expect(project.exists(`shaders-dist/${name}.js`), name).toBe(true);
    project.write('src/deep/model2.ts', 'export const BASE = 5;\n');
    expect(checkShaders({ root: project.root }).problems.map((p: { code: string }) => p.code)).toContain('stale');
    expect((await buildShaders({ root: project.root })).ok).toBe(true);
    expect(project.read('shaders-dist/deep/model2.js')).toContain('BASE = 5');
  });
});

describe('a watcher leaves no process listeners behind', () => {
  it.each(['exit', 'SIGINT', 'SIGTERM'])('%s', (event) => {
    const before = process.listenerCount(event);
    const watcher = watchShaders({ root: project.root }, {});
    watcher.close();
    expect(process.listenerCount(event)).toBe(before);
  });
});

// The option schemas of the wrapper builders (builders/schemas/*.json) are ONE copy for Angular 20, 21 and 22. The CLI fills defaults from
// that copy and the official builder then validates the filled options against its own schema, so the copy must not carry a default that
// only some majors know. Found by the QA run: `ssr.platform: 'node'` (Angular 22's name for 20/21's `ssr.experimentalPlatform`) made every
// Angular 20/21 SSR build through the wrappers fail with a schema error.
import { schema } from '@angular-devkit/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module without types
import { ACCEPTED, unionOf } from '../../../scripts/schema-union.mjs';

const BUILDERS = join(__dirname, '..', '..', '..', 'builders');
const FIXTURES = join(__dirname, '..', 'fixtures', 'angular-build');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const copy = (name: string) => json(join(BUILDERS, 'schemas', `${name}.json`));
const official = (name: string, major: number) => json(join(FIXTURES, major === 22 ? `${name}.schema.json` : `${name}.${major}.schema.json`));
const delegate = require(join(BUILDERS, 'delegate.cjs')) as { optionsFor: (options: Record<string, unknown>, raw: Record<string, unknown>) => Record<string, unknown> };
const NAMES = ['application', 'dev-server', 'karma', 'unit-test'];

async function validate(schemaToUse: object, transform: unknown, options: unknown) {
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(transform as never);
  return (await registry.compile(schemaToUse as never))(options as never);
}

describe('the committed copies are the union of the three majors (regenerate with scripts/sync-builder-schemas.mjs)', () => {
  it.each(NAMES)('%s', (name) => {
    const united = unionOf([20, 21, 22].map((major) => official(name, major)), { noDefaults: name === 'unit-test', accept: (ACCEPTED as Record<string, object>)[name] });
    const { $id, title, $comment, ...committed } = copy(name);
    void $id;
    void title;
    void $comment;
    const { $id: a, title: b, $comment: c, ...expected } = united;
    void a;
    void b;
    void c;
    expect(committed).toEqual(expected);
  });
});

describe('a property that is not in every major has no default in the copy', () => {
  const ssr = (copy('application').properties.ssr.oneOf as { type: string; properties?: Record<string, { default?: unknown }> }[]).find((alternative) => alternative.type === 'object')!;

  it('ssr.platform (22) and ssr.experimentalPlatform (20, 21) are both known, neither with a default', () => {
    expect(Object.keys(ssr.properties!)).toEqual(expect.arrayContaining(['entry', 'platform', 'experimentalPlatform']));
    expect(ssr.properties!['platform']).not.toHaveProperty('default');
    expect(ssr.properties!['experimentalPlatform']).not.toHaveProperty('default');
  });

  it.each([20, 21, 22])('options filled the way the CLI fills a third-party builder validate against the schema of Angular %i (an SSR application)', async (major) => {
    const input = { tsConfig: 'tsconfig.app.json', browser: 'src/main.ts', server: 'src/main.server.ts', ssr: { entry: 'src/server.ts' }, security: { allowedHosts: [] } };
    const filled = await validate(copy('application'), schema.transforms.addUndefinedDefaults, JSON.parse(JSON.stringify(input)));
    expect(filled.success).toBe(true);
    const forOfficial = delegate.optionsFor(filled.data as Record<string, unknown>, input);
    const result = await validate(official('application', major), schema.transforms.addUndefinedObjectDefaults, forOfficial);
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it.each([
    [20, 'experimentalPlatform'],
    [21, 'experimentalPlatform'],
    [22, 'platform'],
  ])('an option the project sets itself (Angular %i: ssr.%s) passes through the copy to the official schema', async (major, key) => {
    const input = { tsConfig: 'tsconfig.app.json', browser: 'src/main.ts', ssr: { entry: 'src/server.ts', [key]: 'neutral' } };
    const filled = await validate(copy('application'), schema.transforms.addUndefinedDefaults, JSON.parse(JSON.stringify(input)));
    expect(filled.success, JSON.stringify(filled.errors)).toBe(true);
    const result = await validate(official('application', major), schema.transforms.addUndefinedObjectDefaults, delegate.optionsFor(filled.data as Record<string, unknown>, input));
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });
});

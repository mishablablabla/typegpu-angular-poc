import { describe, expect, it } from 'vitest';
import type { Type } from '@angular/core';
import type { ExampleDefinition, Variant } from './example.model';
import { EXAMPLES, findExample } from './registry';

const VARIANTS: Variant[] = ['integration', 'manual'];

/** The names of a component's inputs, read from its compiled definition. */
function inputNames(component: Type<unknown>): string[] {
  const definition = (component as unknown as { ɵcmp: { inputs: Record<string, unknown> } }).ɵcmp;
  return Object.keys(definition.inputs);
}

describe.each(EXAMPLES.map((example) => [example.id, example] as const))('example %s', (_id, example: ExampleDefinition) => {
  it('is findable and has a thumbnail, a description and highlights', () => {
    expect(findExample(example.id)).toBe(example);
    expect(example.thumbnail).toMatch(/^thumbnails\/[\w-]+\.jpg$/);
    expect(example.description.length).toBeGreaterThan(40);
    expect(example.highlights.length).toBeGreaterThan(0);
  });

  it.each(VARIANTS)('has real, non-empty sources for the %s version', (variant) => {
    const files = example.sources[variant];
    expect(files.length).toBeGreaterThan(1);
    expect(new Set(files.map((file) => file.path)).size).toBe(files.length);
    for (const file of files) expect(file.code.length, file.path).toBeGreaterThan(100);
    // The first tab is the component itself.
    expect(files[0]!.path).toMatch(variant === 'integration' ? /\.integrated\.ts$/ : /\.manual\.ts$/);
  });

  it('writes the integrated version with the library and the manual one without it', () => {
    const [integrated] = example.sources.integration;
    const [manual] = example.sources.manual;
    expect(integrated!.code).toContain('@typegpu-poc/angular');
    expect(integrated!.code).toContain('injectFrame');
    expect(manual!.code).not.toContain('@typegpu-poc/angular');
    expect(manual!.code).toContain('requestAnimationFrame');
    expect(example.sources.manual.map((file) => file.path)).toContain('manual-gpu.ts');
  });

  it('shows the same shader and the same shared application files in both versions', () => {
    const byPath = (variant: Variant) => new Map(example.sources[variant].map((file) => [file.path, file.code]));
    const integration = byPath('integration');
    const manual = byPath('manual');
    for (const [path, code] of integration) {
      if (path.endsWith('.gpu.ts') || example.sources.integration.find((file) => file.path === path)?.shared) {
        expect(manual.get(path), path).toBe(code);
      }
    }
  });

  it('gives both scenes exactly the inputs the controls need', () => {
    const params = example.createParams();
    const expected = [...Object.keys(params), ...(example.setsParams ? ['setParam'] : [])].sort();
    for (const variant of VARIANTS) expect(inputNames(example.scenes[variant]).sort(), variant).toEqual(expected);
  });

  it('has a control for every parameter, with valid values', () => {
    const params = example.createParams();
    for (const control of example.controls) {
      const parameter = params[control.key];
      expect(parameter, control.key).toBeDefined();
      if (control.kind === 'select') expect(control.options).toContain(parameter!());
      if (control.kind === 'slider') {
        expect(parameter!() as number).toBeGreaterThanOrEqual(control.min);
        expect(parameter!() as number).toBeLessThanOrEqual(control.max);
      }
      if (control.kind === 'button') expect(parameter!()).toBe(0);
    }
  });

  it('creates fresh signals for every visit', () => {
    const first = example.createParams();
    const second = example.createParams();
    for (const key of Object.keys(first)) expect(first[key], key).not.toBe(second[key]);
  });
});

describe('the registry', () => {
  it('has unique ids', () => {
    expect(new Set(EXAMPLES.map((example) => example.id)).size).toBe(EXAMPLES.length);
  });

  it('lists the examples in the showcase order', () => {
    expect(EXAMPLES.map((example) => example.id)).toEqual(['matrix', 'neural-flow', 'autoscaler', 'the-core', 'life', 'risk-field']);
  });

  it('knows nothing about unknown ids', () => {
    expect(findExample('nope')).toBeUndefined();
    expect(findExample(null)).toBeUndefined();
  });
});

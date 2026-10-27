import { describe, expect, it } from 'vitest';
import { convertToParamMap } from '@angular/router';
import { EXAMPLES, findExample } from './registry';
import { isCanonical, resolveViewState, viewQuery } from './example-url-state';

const params = (record: Record<string, string | string[]>) => convertToParamMap(record);
const life = findExample('life')!;

describe('resolveViewState', () => {
  it('defaults to the integrated version and the first file', () => {
    expect(resolveViewState(life, params({}))).toEqual({ variant: 'integration', file: undefined });
  });

  it('reads the manual variant and a file that variant has', () => {
    expect(resolveViewState(life, params({ variant: 'manual', file: 'manual-gpu.ts' }))).toEqual({ variant: 'manual', file: 'manual-gpu.ts' });
  });

  it('treats any other variant as the default, and drops a file the variant does not have', () => {
    expect(resolveViewState(life, params({ variant: 'bogus' })).variant).toBe('integration');
    expect(resolveViewState(life, params({ variant: 'Manual' })).variant).toBe('integration');
    expect(resolveViewState(life, params({ file: 'manual-gpu.ts' })).file).toBeUndefined();
    expect(resolveViewState(life, params({ variant: 'manual', file: 'life.integrated.ts' })).file).toBeUndefined();
    expect(resolveViewState(life, params({ file: 'nope.ts' })).file).toBeUndefined();
  });

  it('every file of every example is a valid choice for its own variant', () => {
    for (const example of EXAMPLES) {
      for (const variant of ['integration', 'manual'] as const) {
        for (const file of example.sources[variant]) {
          expect(resolveViewState(example, params(variant === 'manual' ? { variant, file: file.path } : { file: file.path })), `${example.id} ${variant} ${file.path}`).toEqual({ variant, file: file.path });
        }
      }
    }
  });
});

describe('viewQuery and isCanonical', () => {
  it('leaves the default out of the URL and keeps what was chosen', () => {
    expect(viewQuery({ variant: 'integration', file: undefined })).toEqual({ variant: null, file: null });
    expect(viewQuery({ variant: 'manual', file: 'life.gpu.ts' })).toEqual({ variant: 'manual', file: 'life.gpu.ts' });
  });

  it('knows a URL that says exactly that, and one with invalid, stale, explicit-default or repeated values', () => {
    const wanted = viewQuery({ variant: 'manual', file: 'life.gpu.ts' });
    expect(isCanonical(params({ variant: 'manual', file: 'life.gpu.ts' }), wanted)).toBe(true);
    expect(isCanonical(params({ variant: 'manual' }), wanted)).toBe(false);
    expect(isCanonical(params({ variant: ['manual', 'x'], file: 'life.gpu.ts' }), wanted)).toBe(false);
    const none = viewQuery({ variant: 'integration', file: undefined });
    expect(isCanonical(params({}), none)).toBe(true);
    expect(isCanonical(params({ variant: 'integration' }), none)).toBe(false);
    expect(isCanonical(params({ variant: 'bogus' }), none)).toBe(false);
    expect(isCanonical(params({ file: 'x' }), none)).toBe(false);
  });
});

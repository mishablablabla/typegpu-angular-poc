// @vitest-environment node
import { describe, expect, it } from 'vitest';

describe('server safety', () => {
  it('can be imported where there is no window, document or navigator.gpu', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    const api = await import('@typegpu-poc/angular');
    // The public surface, nothing more (FrameLoop is internal).
    expect(Object.keys(api).sort()).toEqual(
      ['TgpuCanvas', 'TgpuReady', 'TypeGpu', 'injectBuffer', 'injectFrame', 'injectMutable', 'injectReadonly', 'injectRoot', 'injectUniform', 'provideTypeGpu'].sort(),
    );
  });
});

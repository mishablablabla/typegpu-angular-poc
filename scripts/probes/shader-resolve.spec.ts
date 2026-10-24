// Probe: the generated shader, as transformed by the build plugin, resolves to WGSL with the installed
// typegpu / unplugin-typegpu pair. Run by scripts/acceptance-clean-consumer.sh (the generated spec fakes the GPU).
import tgpu, { d } from 'typegpu';
import { sceneFragment } from './app/my-canvas/my-canvas.gpu';

describe('generated shader', () => {
  it('resolves to WGSL', () => {
    const time = tgpu.const(d.f32, 1);
    const tint = tgpu.const(d.vec3f, d.vec3f(1, 0.5, 0.25));
    const wgsl = tgpu.resolve([sceneFragment(time, tint)]);
    console.log('[probe] wgsl bytes:', wgsl.length);
    expect(wgsl).toContain('@fragment');
    expect(wgsl).toContain('sin(');
  });
});

import { signal } from '@angular/core';
import type { ExampleDefinition } from '../example.model';
import { CoreIntegrated } from './core.integrated';
import { CoreManual } from './core.manual';
import { DEFAULTS } from './core.model';
import gpuSource from './core.gpu.ts?source';
import integratedSource from './core.integrated.ts?source';
import manualSource from './core.manual.ts?source';
import modelSource from './core.model.ts?source';
import panelSource from './core.panel.ts?source';
import uniformsSource from './core.uniforms.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const CORE: ExampleDefinition = {
  id: 'the-core',
  folder: 'core',
  title: 'THE CORE',
  description:
    'A fictional magnetic-confinement reactor, drawn entirely by the GPU: forty thousand plasma particles following helical field lines, seventy-two field lines of their own, and the coils and vessel that hold them. Move over the plasma and it answers: waves spread from the pointer, particles and field lines bend, a pulse circles the ring. Press and drag to steer a vortex. An artistic simulation, not a physical fusion model.',
  tags: ['compute', 'particles', 'atomics', 'interaction'],
  app: true,
  setsParams: true,
  highlights: [
    'Nothing is rasterized as geometry: four compute passes (particles, field lines, coils and vessel, the rings of the pushes) splat light into one grid with atomics, a fifth fades it into trails and moves it out, and one fragment shader adds the bloom. The grid has a fixed size, and the canvas asks the library for a pixel-ratio limit, so a retina screen does not make the picture four times as expensive.',
    'The camera, the pointer and the disturbances it makes are one piece of state. Two uniforms mirror it (the camera and the canvas size; the recent pushes and the vortex) and a third mirrors the three controls: no pointer handler touches a GPU resource.',
    'Three buffers (particles, light, the picture) and four uniforms belong to the component. The frame callback only advances the state, writes the clock and runs the passes.',
    'Reset, resizing, reduced motion, cleanup of the buffers and listeners the component owns, and a lost device are handled in the same few places as in the other examples.',
  ],
  thumbnail: 'thumbnails/the-core.jpg',
  createParams: () => ({
    confinement: signal<number>(DEFAULTS.confinement),
    energy: signal<number>(DEFAULTS.energy),
    instability: signal<number>(DEFAULTS.instability),
    reset: signal(0),
  }),
  controls: [
    { kind: 'slider', key: 'confinement', label: 'Magnetic confinement', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'energy', label: 'Plasma energy', min: 0, max: 1, step: 0.01 },
    { kind: 'slider', key: 'instability', label: 'Instability', min: 0, max: 1, step: 0.01 },
    { kind: 'button', key: 'reset', label: 'Reset' },
  ],
  scenes: { integration: CoreIntegrated, manual: CoreManual },
  sources: {
    integration: [
      { path: 'core.integrated.ts', code: integratedSource },
      { path: 'core.gpu.ts', code: gpuSource },
      { path: 'core.model.ts', code: modelSource, shared: true },
      { path: 'core.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'core.panel.ts', code: panelSource, shared: true },
    ],
    manual: [
      { path: 'core.manual.ts', code: manualSource },
      { path: 'core.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
      { path: 'core.model.ts', code: modelSource, shared: true },
      { path: 'core.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'core.panel.ts', code: panelSource, shared: true },
    ],
  },
};

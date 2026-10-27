import { signal } from '@angular/core';
import { prefersReducedMotion } from '../../shared/reduced-motion';
import type { ExampleDefinition } from '../example.model';
import { LifeIntegrated } from './life.integrated';
import { LifeManual } from './life.manual';
import gpuSource from './life.gpu.ts?source';
import integratedSource from './life.integrated.ts?source';
import manualSource from './life.manual.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const LIFE: ExampleDefinition = {
  id: 'life',
  folder: 'life',
  title: 'Game of Life',
  description: 'A cellular automaton computed on the GPU: two read-write storage bindings, three compute kernels and a draw pass. Paint cells with the pointer; hold Shift to erase.',
  tags: ['compute', 'simulation', 'storage buffer', 'pointer'],
  highlights: [
    'Both generations are read-write storage bindings (injectMutable) owned by the component: they are destroyed with it, also when the page navigates away mid-frame. (TypeGPU\u2019s own 12-byte helper buffer for each guarded compute pipeline is not among them: it lives as long as the shared GPU root.)',
    'The edge mode is a uniform mirrored from a signal; buttons and sliders reach the simulation without change detection.',
    'The simulation steps run inside the shared frame loop, which stops when the example is replaced.',
    'Device loss is not a special case in the example: the gate recreates the whole simulation after Reconnect.',
  ],
  thumbnail: 'thumbnails/life.jpg',
  createParams: () => ({
    // Autoplay is motion: with "reduce motion" set, the board waits for the user to press play (or Step).
    running: signal(!prefersReducedMotion()),
    speed: signal(18),
    brush: signal(3),
    edges: signal('wrap around'),
    stepOnce: signal(0),
    randomize: signal(0),
    clear: signal(0),
  }),
  controls: [
    { kind: 'toggle', key: 'running', label: 'running' },
    { kind: 'slider', key: 'speed', label: 'steps / s', min: 1, max: 60, step: 1 },
    { kind: 'slider', key: 'brush', label: 'brush', min: 1, max: 10, step: 1 },
    { kind: 'select', key: 'edges', label: 'edges', options: ['wrap around', 'dead edges'] },
    { kind: 'button', key: 'stepOnce', label: 'Step' },
    { kind: 'button', key: 'randomize', label: 'Randomize' },
    { kind: 'button', key: 'clear', label: 'Clear' },
  ],
  scenes: { integration: LifeIntegrated, manual: LifeManual },
  sources: {
    integration: [
      { path: 'life.integrated.ts', code: integratedSource },
      { path: 'life.gpu.ts', code: gpuSource },
    ],
    manual: [
      { path: 'life.manual.ts', code: manualSource },
      { path: 'life.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
    ],
  },
};

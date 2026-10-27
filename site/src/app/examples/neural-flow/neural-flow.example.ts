import { signal } from '@angular/core';
import type { ExampleDefinition } from '../example.model';
import { NeuralFlowIntegrated } from './neural-flow.integrated';
import { NeuralFlowManual } from './neural-flow.manual';
import { DEFAULTS, STATES } from './neural-flow.model';
import gpuSource from './neural-flow.gpu.ts?source';
import integratedSource from './neural-flow.integrated.ts?source';
import manualSource from './neural-flow.manual.ts?source';
import modelSource from './neural-flow.model.ts?source';
import panelSource from './neural-flow.panel.ts?source';
import readbackSource from './neural-flow.readback.ts?source';
import uniformsSource from './neural-flow.uniforms.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const NEURAL_FLOW: ExampleDefinition = {
  id: 'neural-flow',
  folder: 'neural-flow',
  title: 'Neural flow',
  description:
    'A procedural brain with its neural connections, drawn and simulated by the GPU: two folded hemispheres with a fissure between them, the four lobes and a temporal lobe tucked under the lateral fissure, the central, frontal, parietal and temporal sulci with the small folds of the cortex between them, a cerebellum with its fine ridges and a brainstem with its pons, thousands of neurons just under the cortex, and the fibres between them, bundled the way real tracts are and coloured by kind: short arcs that follow the folds, association tracts between the lobes (ice), the arched corpus callosum (violet), and the thalamocortical radiations that fan out from the centre (gold). A pulse is a bright head with a long tail, and a fibre keeps glowing for a moment after it has passed. Click the brain and the neurons under the pointer fire at once; a wave spreads, then travels along the fibres, across the callosum to the other hemisphere. An illustrative model with synthetic activity: not a diagnostic tool and not a validated neuroscience simulation.',
  tags: ['neuroscience', 'compute', 'atomics', 'simulation'],
  app: true,
  setsParams: true,
  highlights: [
    'The whole network lives on the GPU: one compute pass delivers the pulses that arrive in a frame (integer atomics add up the weights at the target), another lets every neuron leak, fire and rest, and fires the ones a click\u2019s wave has reached. The brain, its fibres and the topology are uploaded once; after that only uniforms cross over.',
    'The brain is a signed distance field, evaluated on the CPU for picking (the shared function that finds the surface under the pointer is the one the tests check) and sampled once into a point shell the GPU draws, each point six times a little apart: the facing side lit from above so the gyri stand out as relief, dark folds, and a bright rim like a shell lit from inside. The major sulci are baked into a small volume at start-up; the small folds are bent noise.',
    'Pulses are not objects: a pulse on a fibre is drawn from the time its source last fired and the fibre\u2019s delay (proportional to its length), so tens of thousands of them cost nothing to store.',
    'The camera, the pointer, the selection and the controls are mirrored into three uniforms from signals; the buffers, the pipelines and the frame loop belong to the component, and a throttled read of the neurons (a few times a second) feeds the inspector. A TypeScript reference simulator follows the same rules and is what the unit tests check.',
  ],
  thumbnail: 'thumbnails/neural-flow.jpg',
  createParams: () => ({
    mode: signal<string>(DEFAULTS.state),
    frequency: signal<number>(DEFAULTS.frequency),
    connectivity: signal<number>(DEFAULTS.connectivity),
    stimulation: signal<number>(DEFAULTS.stimulation),
    reset: signal(0),
  }),
  controls: [
    { kind: 'select', key: 'mode', label: 'State', options: STATES },
    { kind: 'slider', key: 'frequency', label: 'Signal frequency (Hz)', min: 0.3, max: 3, step: 0.05 },
    { kind: 'slider', key: 'connectivity', label: 'Connectivity', min: 0.2, max: 1, step: 0.01 },
    { kind: 'slider', key: 'stimulation', label: 'Stimulation (click strength)', min: 0, max: 1, step: 0.01 },
    { kind: 'button', key: 'reset', label: 'Reset' },
  ],
  scenes: { integration: NeuralFlowIntegrated, manual: NeuralFlowManual },
  sources: {
    integration: [
      { path: 'neural-flow.integrated.ts', code: integratedSource },
      { path: 'neural-flow.gpu.ts', code: gpuSource },
      { path: 'neural-flow.model.ts', code: modelSource, shared: true },
      { path: 'neural-flow.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'neural-flow.readback.ts', code: readbackSource, shared: true },
      { path: 'neural-flow.panel.ts', code: panelSource, shared: true },
    ],
    manual: [
      { path: 'neural-flow.manual.ts', code: manualSource },
      { path: 'neural-flow.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
      { path: 'neural-flow.model.ts', code: modelSource, shared: true },
      { path: 'neural-flow.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'neural-flow.readback.ts', code: readbackSource, shared: true },
      { path: 'neural-flow.panel.ts', code: panelSource, shared: true },
    ],
  },
};

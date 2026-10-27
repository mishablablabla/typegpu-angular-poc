import { signal } from '@angular/core';
import type { ExampleDefinition } from '../example.model';
import { AutoscalerIntegrated } from './autoscaler.integrated';
import { AutoscalerManual } from './autoscaler.manual';
import { DEFAULTS, POLICIES, POLICY_NAMES } from './autoscaler.model';
import gpuSource from './autoscaler.gpu.ts?source';
import integratedSource from './autoscaler.integrated.ts?source';
import manualSource from './autoscaler.manual.ts?source';
import modelSource from './autoscaler.model.ts?source';
import motionSource from './autoscaler.motion.ts?source';
import panelSource from './autoscaler.panel.ts?source';
import uniformsSource from './autoscaler.uniforms.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const AUTOSCALER: ExampleDefinition = {
  id: 'autoscaler',
  folder: 'autoscaler',
  title: 'Autoscaler',
  description: `A living map of a small cloud platform: eight services, their replicas, and thousands of requests streaming between them, all drawn by the GPU. Raise the traffic and watch pressure build, replicas start and take over; crash one and watch the requests find another way. Compare policies: ${POLICIES.Reactive.summary.toLowerCase()} ${POLICIES.Conservative.summary} A synthetic, deterministic model, not a Kubernetes controller.`,
  tags: ['cloud infrastructure', 'compute', 'particles', 'simulation'],
  app: true,
  setsParams: true,
  highlights: [
    'The platform is a plain deterministic simulation. Its snapshot is a signal; two readonly buffers (the nodes of the map and its links) mirror it, so a new replica appears on the GPU because a signal changed, not because someone wrote to a buffer.',
    'Several thousand requests live on the GPU: one compute kernel moves them from a replica to a replica, slower where the receiver is overloaded, and splats their light with atomics. The CPU never sees a request.',
    'The traffic, the policy and the failure button are plain inputs. The frame callback feeds them to the simulation, writes the clock and runs three passes.',
    'Three buffers and two uniforms belong to the component and are released with it (TypeGPU\u2019s helper buffers of the guarded compute pipelines stay with the shared GPU root); the canvas follows its CSS size with a limit on the pixel ratio; a lost device shows the same recoverable state as the other examples.',
  ],
  thumbnail: 'thumbnails/autoscaler.jpg',
  createParams: () => ({
    traffic: signal<number>(DEFAULTS.traffic),
    policy: signal<string>(DEFAULTS.policy),
    failure: signal(0),
    reset: signal(0),
  }),
  controls: [
    { kind: 'slider', key: 'traffic', label: 'Traffic load', min: 0, max: 1, step: 0.01 },
    { kind: 'select', key: 'policy', label: 'Autoscaling policy', options: POLICY_NAMES },
    { kind: 'button', key: 'failure', label: 'Inject failure' },
    { kind: 'button', key: 'reset', label: 'Reset' },
  ],
  scenes: { integration: AutoscalerIntegrated, manual: AutoscalerManual },
  sources: {
    integration: [
      { path: 'autoscaler.integrated.ts', code: integratedSource },
      { path: 'autoscaler.gpu.ts', code: gpuSource },
      { path: 'autoscaler.model.ts', code: modelSource, shared: true },
      { path: 'autoscaler.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'autoscaler.motion.ts', code: motionSource, shared: true },
      { path: 'autoscaler.panel.ts', code: panelSource, shared: true },
    ],
    manual: [
      { path: 'autoscaler.manual.ts', code: manualSource },
      { path: 'autoscaler.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
      { path: 'autoscaler.model.ts', code: modelSource, shared: true },
      { path: 'autoscaler.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'autoscaler.motion.ts', code: motionSource, shared: true },
      { path: 'autoscaler.panel.ts', code: panelSource, shared: true },
    ],
  },
};

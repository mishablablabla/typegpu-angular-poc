import { signal } from '@angular/core';
import type { ExampleDefinition } from '../example.model';
import { RiskFieldIntegrated } from './risk-field.integrated';
import { RiskFieldManual } from './risk-field.manual';
import { DEFAULTS, SCENARIOS } from './risk-field.model';
import gpuSource from './risk-field.gpu.ts?source';
import integratedSource from './risk-field.integrated.ts?source';
import manualSource from './risk-field.manual.ts?source';
import modelSource from './risk-field.model.ts?source';
import panelSource from './risk-field.panel.ts?source';
import uniformsSource from './risk-field.uniforms.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const RISK_FIELD: ExampleDefinition = {
  id: 'risk-field',
  folder: 'risk-field',
  title: 'Risk field',
  description:
    'A risk landscape of a two-asset portfolio, long or short. The floor is the weight in each asset, and the valley across it is the hedge; the height and colour are a synthetic one-day 99% value-at-risk, computed per ray step in a fragment shader from the volatility, the correlation and a stress scenario. Orbit, zoom, and click to inspect an allocation. An illustrative model, not a prediction of real losses.',
  tags: ['quantitative finance', 'ray marching', 'heightfield', 'synthetic model'],
  app: true,
  setsParams: true,
  highlights: [
    'There is no mesh to rebuild: the surface is the model’s formula evaluated in the fragment shader, so a control only has to change three numbers. Two signals-derived uniforms carry them (the eased surface parameters, and the camera with the canvas size).',
    'Controls and scenarios ease: a signal holds the numbers the surface is made of and moves towards the target a little every frame, and the uniform that mirrors it is rewritten only while it moves.',
    'The same `risk` formula runs on the CPU for the inspector, the hover readout and the click picking, and is unit tested there; the shader uses an identical copy.',
    'Three uniforms are owned by the component and the canvas limits its pixel ratio with one option, so a retina screen does not multiply the cost of the ray marching.',
  ],
  thumbnail: 'thumbnails/risk-field.jpg',
  createParams: () => ({
    volatility: signal<number>(DEFAULTS.volatility),
    correlation: signal<number>(DEFAULTS.correlation),
    scenario: signal<string>(DEFAULTS.scenario),
    reset: signal(0),
  }),
  controls: [
    { kind: 'slider', key: 'volatility', label: 'Volatility (% a year)', min: 8, max: 60, step: 1 },
    { kind: 'slider', key: 'correlation', label: 'Correlation', min: -0.6, max: 0.95, step: 0.01 },
    { kind: 'select', key: 'scenario', label: 'Stress scenario', options: SCENARIOS },
    { kind: 'button', key: 'reset', label: 'Reset' },
  ],
  scenes: { integration: RiskFieldIntegrated, manual: RiskFieldManual },
  sources: {
    integration: [
      { path: 'risk-field.integrated.ts', code: integratedSource },
      { path: 'risk-field.gpu.ts', code: gpuSource },
      { path: 'risk-field.model.ts', code: modelSource, shared: true },
      { path: 'risk-field.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'risk-field.panel.ts', code: panelSource, shared: true },
    ],
    manual: [
      { path: 'risk-field.manual.ts', code: manualSource },
      { path: 'risk-field.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
      { path: 'risk-field.model.ts', code: modelSource, shared: true },
      { path: 'risk-field.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'risk-field.panel.ts', code: panelSource, shared: true },
    ],
  },
};

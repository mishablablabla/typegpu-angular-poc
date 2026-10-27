import { signal } from '@angular/core';
import type { ExampleDefinition } from '../example.model';
import { MatrixIntegrated } from './matrix.integrated';
import { MatrixManual } from './matrix.manual';
import { DEFAULTS, PALETTES, SOURCES } from './matrix.model';
import gpuSource from './matrix.gpu.ts?source';
import integratedSource from './matrix.integrated.ts?source';
import manualSource from './matrix.manual.ts?source';
import modelSource from './matrix.model.ts?source';
import panelSource from './matrix.panel.ts?source';
import personSource from './matrix.person.ts?source';
import faceSource from './matrix.face.ts?source';
import sequenceSource from './matrix.sequence.ts?source';
import endingSource from './matrix.ending.ts?source';
import segmenterSource from './segmentation/segmenter.ts?source';
import maskSource from './segmentation/mask.ts?source';
import postprocessSource from './segmentation/postprocess.gpu.ts?source';
import cropSource from './segmentation/crop.ts?source';
import sourceSource from './matrix.source.ts?source';
import uniformsSource from './matrix.uniforms.ts?source';
import manualGpuSource from '../manual/manual-gpu.ts?source';

export const MATRIX: ExampleDefinition = {
  id: 'matrix',
  folder: 'matrix',
  title: 'Matrix mirror',
  description:
    'Your camera, rewritten as code. Everything behind you becomes falling Matrix code that follows the room (bright places and edges show through), and you become glyphs in other colours. A neural network (MediaPipe selfie segmentation) runs as TypeGPU compute shaders on every new frame and tells where you are, so there is no empty background to capture and nothing to step out of; the silhouette is cut along the mask, pixel by pixel, whatever the glyph size. Click anywhere: the code cracks open around the pointer (Cursor reach sets how far), the room behind you shows as the real picture, and the part of you inside turns into waves of colour, until the crack closes again. Click on the face, if you dare. It starts with a demo scene, so the page never asks for your camera on its own: choose Source: Camera to use it. Everything stays on your device.',
  tags: ['camera', 'external texture', 'compute', 'neural network', 'interaction', 'easter egg'],
  app: true,
  setsParams: true,
  highlights: [
    'The video frame is imported as an external texture inside the frame callback, every frame, and bound to two passes: a compute pass that runs the segmentation network (92 layers as GPU dispatches) and filters its mask, and a render pass that draws the glyphs. Nothing is copied through the CPU, not even the mask.',
    'The network sees the whole frame (letterboxed into its 256 by 256 input, averaged from four taps per pixel), and its output is resampled into a mask over the video frame whose soft edge is snapped to the picture\u2019s edges by a joint bilateral filter. The shader samples that mask per pixel, not per glyph, so a smaller Glyph size is a finer silhouette at no extra cost.',
    'The state (source, pointer and ripples) lives in signals; three uniforms mirror it and the controls, so no handler touches a GPU resource. The frame callback only advances time and runs the passes; the network runs only when the video has a new frame.',
    'The network\u2019s buffers, its mask texture, the uniforms, the canvas observer and the frame loop are released with the component, and so is the camera: one cleanup path, whatever way the component is destroyed. The canvas asks the library for a pixel-ratio limit, so a retina screen does not make the picture four times as expensive.',
    'The example starts with a procedural demo scene, so the browser asks for the camera only after the user picks Source: Camera. A denied or missing camera switches the Source control back to the demo, which is played through the same video element and the same texture path: one code path for both.',
  ],
  thumbnail: 'thumbnails/matrix.jpg',
  createParams: () => ({
    source: signal<string>(DEFAULTS.source),
    palette: signal<string>(DEFAULTS.palette),
    speed: signal<number>(DEFAULTS.speed),
    cutoff: signal<number>(DEFAULTS.cutoff),
    reach: signal<number>(DEFAULTS.reach),
    glyph: signal<number>(DEFAULTS.glyph),
    mirror: signal<boolean>(DEFAULTS.mirror),
    reset: signal(0),
  }),
  controls: [
    { kind: 'select', key: 'source', label: 'Source', options: SOURCES },
    { kind: 'select', key: 'palette', label: 'Your colours', options: PALETTES },
    { kind: 'slider', key: 'speed', label: 'Rain speed', min: 0.2, max: 3, step: 0.05 },
    { kind: 'slider', key: 'glyph', label: 'Glyph size', min: 7, max: 24, step: 1 },
    { kind: 'slider', key: 'reach', label: 'Cursor reach', min: 0.1, max: 1.5, step: 0.01 },
    { kind: 'slider', key: 'cutoff', label: 'Person cut-off', min: 0.25, max: 0.75, step: 0.01 },
    { kind: 'toggle', key: 'mirror', label: 'Mirror' },
    { kind: 'button', key: 'reset', label: 'Reset' },
  ],
  scenes: { integration: MatrixIntegrated, manual: MatrixManual },
  sources: {
    integration: [
      { path: 'matrix.integrated.ts', code: integratedSource },
      { path: 'matrix.gpu.ts', code: gpuSource },
      { path: 'matrix.model.ts', code: modelSource, shared: true },
      { path: 'matrix.person.ts', code: personSource, shared: true },
      { path: 'matrix.face.ts', code: faceSource, shared: true },
      { path: 'matrix.sequence.ts', code: sequenceSource, shared: true },
      { path: 'matrix.ending.ts', code: endingSource, shared: true },
      { path: 'segmentation/segmenter.ts', code: segmenterSource, shared: true },
      { path: 'segmentation/mask.ts', code: maskSource, shared: true },
      { path: 'segmentation/postprocess.gpu.ts', code: postprocessSource, shared: true },
      { path: 'segmentation/crop.ts', code: cropSource, shared: true },
      { path: 'matrix.source.ts', code: sourceSource, shared: true },
      { path: 'matrix.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'matrix.panel.ts', code: panelSource, shared: true },
    ],
    manual: [
      { path: 'matrix.manual.ts', code: manualSource },
      { path: 'matrix.gpu.ts', code: gpuSource },
      { path: 'manual-gpu.ts', code: manualGpuSource },
      { path: 'matrix.model.ts', code: modelSource, shared: true },
      { path: 'matrix.person.ts', code: personSource, shared: true },
      { path: 'matrix.face.ts', code: faceSource, shared: true },
      { path: 'matrix.sequence.ts', code: sequenceSource, shared: true },
      { path: 'matrix.ending.ts', code: endingSource, shared: true },
      { path: 'segmentation/segmenter.ts', code: segmenterSource, shared: true },
      { path: 'segmentation/mask.ts', code: maskSource, shared: true },
      { path: 'segmentation/postprocess.gpu.ts', code: postprocessSource, shared: true },
      { path: 'segmentation/crop.ts', code: cropSource, shared: true },
      { path: 'matrix.source.ts', code: sourceSource, shared: true },
      { path: 'matrix.uniforms.ts', code: uniformsSource, shared: true },
      { path: 'matrix.panel.ts', code: panelSource, shared: true },
    ],
  },
};

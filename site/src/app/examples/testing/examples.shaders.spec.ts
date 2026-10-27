// The shader gate: every example, in both implementations, is mounted on TypeGPU's REAL root (over a recording device, see
// example-device.ts) and every pipeline it creates is resolved to WGSL. That catches what the lifecycle specs (a stand-in root
// that never looks at a shader) cannot: a kernel that does not compile to WGSL, a binding the shader cannot use, a function that
// resolves to `undefined`, a scene that wires a different buffer than the other implementation.
//
// What it does NOT do: validate the WGSL with a WebGPU compiler (Tint or naga). Neither is available in the test run; the text is
// only checked structurally (see `structureProblems`). A browser or Dawn run is the proof that the WGSL is valid.
import { TestBed } from '@angular/core/testing';
import { ErrorHandler } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tgpu } from 'typegpu';
import { installManualAnimationFrames, type ManualAnimationFrames } from '@typegpu-poc/angular/testing';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { installBrowserStubs, type BrowserStubs } from './example-env';
import { createRecordingDevice, stubWebGpuGlobals, webgpuContext } from './example-device';
import { frameQueue, mount, pump } from './example-harness';
import { installFakeGpu, type FakeGpu } from './example-gpu';

/** The pipelines each scene creates (the same in both implementations): a change here is a change to the example's GPU work. */
const PIPELINES: Record<string, { compute: number; render: number }> = {
  matrix: { compute: 61, render: 1 }, // 5 of its own, and 56 specialisations of the network's layers
  'neural-flow': { compute: 6, render: 1 },
  autoscaler: { compute: 2, render: 1 },
  'the-core': { compute: 5, render: 1 },
  life: { compute: 3, render: 1 },
  'risk-field': { compute: 0, render: 1 },
};

type Kind = 'compute' | 'render';

/** Things that mean a shader did not come out right, found in the text alone. Empty when nothing is wrong. */
function structureProblems(code: string, kind: Kind): string[] {
  const problems: string[] = [];
  const stripped = code.replace(/\/\/[^\n]*/g, '');
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']] as const) {
    const opens = stripped.split(open).length - 1;
    const closes = stripped.split(close).length - 1;
    if (opens !== closes) problems.push(`unbalanced ${open}${close}: ${opens} opening, ${closes} closing`);
  }
  for (const bad of ['undefined', '\\[object', 'NaN', 'null']) if (new RegExp(`(^|[^\\w.])${bad}`).test(stripped)) problems.push(`contains "${bad.replace('\\', '')}"`);
  if (kind === 'compute') {
    if (!/@compute\b/.test(stripped)) problems.push('no @compute entry point');
    if (!/@workgroup_size\(/.test(stripped)) problems.push('no @workgroup_size');
  } else {
    if (!/@vertex\b/.test(stripped)) problems.push('no @vertex entry point');
    if (!/@fragment\b/.test(stripped)) problems.push('no @fragment entry point');
  }
  // Two resources on one binding point is a shader that cannot be created.
  const bindings = [...stripped.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/g)].map((match) => `${match[1]}:${match[2]}`);
  if (new Set(bindings).size !== bindings.length) problems.push(`a binding point is used twice: ${bindings.join(', ')}`);
  return problems;
}

let frames: ManualAnimationFrames;
let stubs: BrowserStubs | undefined;
let gpuFake: FakeGpu | undefined;
const handleError = vi.fn();

beforeEach(() => {
  frames = frameQueue.current = installManualAnimationFrames();
});
afterEach(() => {
  frames.restore();
  gpuFake?.restore();
  stubs?.restore();
  vi.unstubAllGlobals();
});

interface Resolved {
  kind: Kind;
  code: string;
}

/** Runs the example for a few frames on the real root and returns the WGSL of every pipeline it created. */
async function resolvePipelines(exampleId: string, variant: Variant): Promise<Resolved[]> {
  const example = EXAMPLES.find((candidate) => candidate.id === exampleId)!;
  stubs = installBrowserStubs({ webgpuContext });
  stubWebGpuGlobals();
  gpuFake = installFakeGpu(true);
  gpuFake.queue.push(createRecordingDevice());
  handleError.mockClear();

  // `createGuardedComputePipeline` ends in `createComputePipeline`, so these see every pipeline of the root; pipelines of a
  // specialised root (`root.with(slot, value)`, which MATRIX MIRROR's network uses for every layer shape) come from its own class.
  const probe = tgpu.initFromDevice({ device: {} as GPUDevice });
  const classes = [Object.getPrototypeOf(probe), Object.getPrototypeOf(probe.with(tgpu.slot(0), 0))] as Record<string, (...args: unknown[]) => unknown>[];
  const patched: { target: Record<string, (...args: unknown[]) => unknown>; name: string; original: (...args: unknown[]) => unknown }[] = [];
  const created: { kind: Kind; pipeline: unknown }[] = [];
  for (const target of classes) {
    for (const kind of ['compute', 'render'] as const) {
      const name = kind === 'compute' ? 'createComputePipeline' : 'createRenderPipeline';
      const original = target[name]!;
      patched.push({ target, name, original });
      target[name] = function (this: unknown, ...args: unknown[]) {
        const pipeline = original.apply(this, args);
        created.push({ kind, pipeline });
        return pipeline;
      };
    }
  }

  try {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: ErrorHandler, useValue: { handleError } }] });
    const { fixture } = mount(example, variant);
    await pump(fixture, 12);
    fixture.destroy();
    expect(handleError).not.toHaveBeenCalled();
    // Resolving builds TypeGPU's own helper resources, which need the WebGPU globals too.
    return created.map(({ kind, pipeline }) => ({ kind, code: tgpu.resolve([pipeline as never]) }));
  } finally {
    for (const { target, name, original } of patched) target[name] = original;
    gpuFake.restore();
    stubs.restore();
    vi.unstubAllGlobals();
  }
}

describe.each(EXAMPLES.map((example) => example.id))('shaders of example %s', (id) => {
  it('every pipeline of both implementations resolves to well-formed WGSL, and both resolve to the same WGSL', async () => {
    const byVariant = {} as Record<Variant, Resolved[]>;
    for (const variant of ['integration', 'manual'] as const) {
      const resolved = (byVariant[variant] = await resolvePipelines(id, variant));
      const count = (kind: Kind) => resolved.filter((entry) => entry.kind === kind).length;
      expect({ compute: count('compute'), render: count('render') }, `${variant}: pipelines created`).toEqual(PIPELINES[id]);
      for (const { kind, code } of resolved) {
        expect(code.length, `${variant} ${kind}`).toBeGreaterThan(100);
        expect(structureProblems(code, kind), `${variant} ${kind} pipeline`).toEqual([]);
      }
    }
    // The manual version is the same scene written by hand: it must hand TypeGPU the same shaders.
    const sorted = (variant: Variant) => byVariant[variant].map((entry) => entry.code).sort();
    expect(sorted('manual')).toEqual(sorted('integration'));
  });
});

describe('structureProblems', () => {
  const compute = '@group(0) @binding(0) var<storage, read_write> a: array<u32>;\n@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) { a[0] = 1; }';

  it('accepts a well-formed compute shader', () => {
    expect(structureProblems(compute, 'compute')).toEqual([]);
  });

  it('finds an unbalanced brace, an unresolved value, a missing entry point and a doubled binding', () => {
    expect(structureProblems(compute.slice(0, -1), 'compute')).toEqual([expect.stringMatching(/unbalanced \{\}/)]);
    expect(structureProblems(compute.replace('a[0] = 1', 'a[0] = undefined'), 'compute')).toEqual([expect.stringMatching(/undefined/)]);
    expect(structureProblems(compute.replace('@compute', ''), 'compute')).toEqual([expect.stringMatching(/@compute/)]);
    expect(structureProblems(`${compute}\n@group(0) @binding(0) var<uniform> b: u32;`, 'compute')).toEqual([expect.stringMatching(/used twice/)]);
    expect(structureProblems(compute, 'render')).toHaveLength(2);
  });
});

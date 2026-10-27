// A recording GPU device for the shader gate (examples.shaders.spec.ts). Unlike `createExampleRoot`, which replaces TypeGPU's root,
// this lets the REAL TypeGPU root run on top of it: TypeGPU builds the pipelines for real, resolves every shader to WGSL
// and hands that WGSL to `device.createShaderModule`, where it is recorded. Nothing runs on a GPU, and nothing validates WGSL.
import { vi } from 'vitest';
import { deepStub, type Stub } from './example-root';

export interface ShaderModule {
  label: string;
  code: string;
}

export interface RecordingDevice {
  readonly device: GPUDevice;
  /** Every shader module that was created, in order. */
  readonly shaders: ShaderModule[];
}

/** The limits TypeGPU reads when it creates pipelines (the WebGPU defaults). */
const LIMITS = { maxBindGroups: 4, maxBindingsPerBindGroup: 1000, maxStorageBuffersPerShaderStage: 8, maxUniformBuffersPerShaderStage: 12, maxStorageBufferBindingSize: 134217728, maxUniformBufferBindingSize: 65536 };

export function createRecordingDevice(): RecordingDevice {
  const shaders: ShaderModule[] = [];
  const base: Record<string, unknown> = {
    features: new Set<string>(),
    limits: LIMITS,
    lost: new Promise(() => undefined),
    destroy: () => undefined,
    createShaderModule: (descriptor: { label?: string; code: string }) => {
      shaders.push({ label: descriptor.label ?? '<unnamed>', code: descriptor.code });
      return deepStub('shaderModule');
    },
    // A buffer that can be filled at creation and written to; the contents are nobody's business.
    createBuffer: (descriptor: { size: number; usage: number; label?: string; mappedAtCreation?: boolean }) => {
      const buffer = {
        size: descriptor.size,
        usage: descriptor.usage,
        label: descriptor.label ?? '',
        mapState: descriptor.mappedAtCreation ? 'mapped' : 'unmapped',
        getMappedRange: () => new ArrayBuffer(descriptor.size),
        unmap: () => void (buffer.mapState = 'unmapped'),
        mapAsync: () => Promise.resolve(),
        destroy: () => undefined,
      };
      return buffer;
    },
  };
  const device = new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as string];
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return deepStub(`device.${property}`);
    },
  }) as unknown as GPUDevice;
  return { device, shaders };
}

/** A canvas context (`canvas.getContext('webgpu')`) that accepts everything. */
export const webgpuContext = (): Stub => deepStub('context');

/** The usage flags TypeGPU reads from the WebGPU globals (node has none). The values are the ones of the WebGPU specification. */
export function stubWebGpuGlobals(): void {
  vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 });
  vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 });
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 });
}

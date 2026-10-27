// From the raw output of the network to a mask of the person that the picture can sample: a filter over time, a prior that
// removes stray blobs, and a resampling into a texture that covers the video frame. All of it is compute on the GPU; the mask
// never touches the CPU.
import { d } from 'typegpu';
import type { SampledFlag, StorageFlag, TgpuBindGroup, TgpuBuffer, TgpuComputePipeline, TgpuRoot, TgpuTexture, TgpuTextureView } from 'typegpu';
import { cropData, type CropRect } from './crop';
import {
  MODEL_PIXELS,
  POST_PROCESS_WORKGROUPS,
  PostProcessParams,
  REFINE_WORKGROUP_SIZE,
  RefineParams,
  personCorePriorKernel,
  priorLayout,
  rowProfileKernel,
  rowsLayout,
  refineFrameLayout,
  refineKernel,
  refineLayout,
  temporalAccumulatorKernel,
  temporalLayout,
} from './postprocess.gpu';
import type { MaskBuffer } from './kernels/types';

/** The mask is a texture over the whole video frame; its long side has this many pixels. */
export const MASK_LONG_SIDE = 480;

export type SampledMaskView = TgpuTextureView<d.WgslTexture2d<d.F32>>;
type MaskTexture = TgpuTexture<{ size: readonly [number, number]; format: 'rgba16float' }> & StorageFlag & SampledFlag;
type StorageMaskView = TgpuTextureView<d.WgslStorageTexture2d<'rgba16float', 'write-only'>>;
type FloatBuffer = TgpuBuffer<d.WgslArray<d.F32>> & StorageFlag;

interface MaskTarget {
  readonly size: readonly [number, number];
  readonly texture: MaskTexture;
  readonly sampleView: SampledMaskView;
  readonly storageView: StorageMaskView;
  readonly workgroups: readonly [number, number];
}

/** The size of the mask texture for a frame of this shape. */
export function maskSize(width: number, height: number): readonly [number, number] {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return aspect >= 1 ? [MASK_LONG_SIDE, Math.max(1, Math.round(MASK_LONG_SIDE / aspect))] : [Math.max(1, Math.round(MASK_LONG_SIDE * aspect)), MASK_LONG_SIDE];
}

export class MaskPostProcessor {
  private readonly root: TgpuRoot;
  private readonly owned: { destroy(): void }[] = [];
  private readonly temporalParams;
  private readonly refineParams;
  private readonly history: FloatBuffer;
  private readonly temporal: FloatBuffer;
  private temporalStage: Stage | undefined;
  private readonly priorStage: Stage;
  private readonly rowsStage: Stage;
  private readonly rows;
  private readonly refinePipeline: TgpuComputePipeline;
  private readonly sampler;
  private readonly priorMask: FloatBuffer;
  private target: MaskTarget;
  private refineBindGroup: TgpuBindGroup<typeof refineLayout.entries> | undefined;
  private initialized = false;

  /** The mask starts empty (nobody is a person); `connect` attaches the network whose output it filters. */
  constructor(root: TgpuRoot, width = 1, height = 1) {
    this.root = root;
    const buffer = (): FloatBuffer => {
      const created = root.createBuffer(d.arrayOf(d.f32, MODEL_PIXELS)).$usage('storage');
      this.owned.push(created);
      return created;
    };
    this.history = buffer();
    this.temporal = buffer();
    this.priorMask = buffer();
    this.temporalParams = root.createBuffer(PostProcessParams, { initialized: 0 }).$usage('uniform');
    this.refineParams = root.createBuffer(RefineParams, { origin: d.vec2f(), size: d.vec2f(1, 1), edgeAware: 1 }).$usage('uniform');
    this.owned.push(this.temporalParams, this.refineParams);
    this.sampler = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.priorStage = {
      pipeline: root.createComputePipeline({ compute: personCorePriorKernel }),
      bindGroup: root.createBindGroup(priorLayout, { src: this.temporal, dst: this.priorMask }),
    };
    this.rows = root.createBuffer(d.arrayOf(d.vec2f, 256)).$usage('storage');
    this.owned.push(this.rows);
    this.rowsStage = {
      pipeline: root.createComputePipeline({ compute: rowProfileKernel }),
      bindGroup: root.createBindGroup(rowsLayout, { src: this.priorMask, rows: this.rows }),
    };
    this.refinePipeline = root.createComputePipeline({ compute: refineKernel });
    this.target = this.createTarget(...maskSize(width, height));
  }

  /** Attaches the raw output of the network. */
  connect(rawMask: MaskBuffer): void {
    this.temporalStage = {
      pipeline: this.root.createComputePipeline({ compute: temporalAccumulatorKernel }),
      bindGroup: this.root.createBindGroup(temporalLayout, { params: this.temporalParams, raw: rawMask, historyLogits: this.history, filtered: this.temporal }),
    };
  }

  /** The mask over the video frame: red channel, 0 (background) to 1 (person), in the frame's own orientation. */
  get maskView(): SampledMaskView {
    return this.target.sampleView;
  }

  /** Forget the history (a new picture is not a continuation of the old one). */
  reset(): void {
    this.initialized = false;
  }

  /** Makes the mask texture fit a frame of this size; true when it was replaced (a bind group built from it is stale). */
  resize(width: number, height: number): boolean {
    const [w, h] = maskSize(width, height);
    const [currentW, currentH] = this.target.size;
    if (w === currentW && h === currentH) return false;
    const next = this.createTarget(w, h);
    this.target.texture.destroy();
    this.target = next;
    this.refineBindGroup = undefined;
    return true;
  }

  /** What the mask holds in each of its 256 rows (person pixels, and the sum of their columns), read back from the GPU. */
  async readRows(): Promise<{ count: number; sumX: number }[]> {
    const rows = await this.rows.read();
    return Array.from({ length: 256 }, (_, y) => ({ count: rows[y]!.x, sumX: rows[y]!.y }));
  }

  /** Records the filtering and the resampling after a run of the network. */
  encode(pass: GPUComputePassEncoder, frame: GPUExternalTexture, crop: CropRect): void {
    if (!this.temporalStage) return;
    this.temporalParams.write({ initialized: this.initialized ? 1 : 0 });
    run(pass, this.temporalStage, POST_PROCESS_WORKGROUPS);
    this.initialized = true;
    run(pass, this.priorStage, POST_PROCESS_WORKGROUPS);
    run(pass, this.rowsStage, 1);

    const { origin, size } = cropData(crop);
    this.refineParams.write({ origin, size, edgeAware: 1 });
    this.refineBindGroup ??= this.root.createBindGroup(refineLayout, { params: this.refineParams, src: this.priorMask, output: this.target.storageView });
    this.refinePipeline
      .with(pass)
      .with(this.refineBindGroup)
      .with(this.root.createBindGroup(refineFrameLayout, { frame, sampler: this.sampler }))
      .dispatchWorkgroups(this.target.workgroups[0], this.target.workgroups[1]);
  }

  destroy(): void {
    this.target.texture.destroy();
    for (const resource of this.owned.splice(0)) resource.destroy();
  }

  private createTarget(width: number, height: number): MaskTarget {
    const texture = this.root.createTexture({ size: [width, height], format: 'rgba16float' }).$usage('storage', 'sampled');
    return {
      size: [width, height],
      texture,
      sampleView: texture.createView(),
      storageView: texture.createView(d.textureStorage2d('rgba16float', 'write-only')),
      workgroups: [Math.ceil(width / REFINE_WORKGROUP_SIZE), Math.ceil(height / REFINE_WORKGROUP_SIZE)],
    };
  }
}

interface Stage {
  pipeline: TgpuComputePipeline;
  bindGroup: TgpuBindGroup;
}

function run(pass: GPUComputePassEncoder, stage: Stage, workgroups: number): void {
  stage.pipeline.with(pass).with(stage.bindGroup).dispatchWorkgroups(workgroups);
}

// The person segmenter: the network of `bundle.ts` run as compute dispatches, fed by a kernel that turns the current video frame
// (an external texture) into the network's input. The network writes one probability per pixel of a 256 by 256 square into a
// buffer. Everything is owned by the instance and released by `destroy()`.
import { d } from 'typegpu';
import type { TgpuBindGroup, TgpuRoot } from 'typegpu';
import { loadSegmenterPlan, type SegmenterPlan } from './bundle';
import { FrameCrop, cropData, type CropRect } from './crop';
import { createSegmenterDispatches } from './kernels/dispatches';
import { cropLayout, frameLayout, inputLayout, MODEL_PIXELS, preprocessKernel } from './preprocess.gpu';
import { WORKGROUP_SIZE, type KernelHandle, type MaskBuffer, type PackedWeightsBuffer, type Vec4Buffer } from './kernels/types';

export class SelfieSegmenter {
  /** Loads the model file and builds the pipelines. The buffers it creates are released by `destroy()`. */
  static async create(root: TgpuRoot, url: string | URL, signal?: AbortSignal): Promise<SelfieSegmenter> {
    const plan = await loadSegmenterPlan(url, signal);
    signal?.throwIfAborted();
    return new SelfieSegmenter(root, plan);
  }

  /** The probability of "person" for every pixel of the network's square input (256 by 256). */
  readonly maskBuffer: MaskBuffer;

  private readonly root: TgpuRoot;
  private readonly owned: { destroy(): void }[] = [];
  private readonly input: Vec4Buffer;
  private readonly dispatches: KernelHandle[];
  private readonly preprocess;
  private readonly cropBuffer;
  private readonly cropBindGroup;
  private readonly inputBindGroup: TgpuBindGroup<typeof inputLayout.entries>;
  private readonly sampler;

  private constructor(root: TgpuRoot, plan: SegmenterPlan) {
    this.root = root;
    const own = <T extends { destroy(): void }>(resource: T): T => {
      this.owned.push(resource);
      return resource;
    };
    this.maskBuffer = own(root.createBuffer(d.arrayOf(d.f32, plan.slotSizesVec4[1]!)).$usage('storage'));
    const slots = plan.slotSizesVec4.map((size, slot) =>
      slot === 1 ? (this.maskBuffer as unknown as Vec4Buffer) : own(root.createBuffer(d.arrayOf(d.vec4f, size)).$usage('storage')),
    );
    this.input = slots[0]!;
    const weights: PackedWeightsBuffer = own(root.createBuffer(d.arrayOf(d.u32, plan.weights.byteLength / Uint32Array.BYTES_PER_ELEMENT)).$usage('storage'));
    weights.write(plan.weights);
    this.dispatches = createSegmenterDispatches(root, plan.dispatches, slots, this.maskBuffer, weights, this.owned);

    this.cropBuffer = own(root.createBuffer(FrameCrop).$usage('uniform'));
    this.cropBindGroup = root.createBindGroup(cropLayout, { crop: this.cropBuffer });
    this.inputBindGroup = root.createBindGroup(inputLayout, { dst: this.input });
    this.preprocess = root.createComputePipeline({ compute: preprocessKernel });
    this.sampler = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** Records one run of the network on the frame into the compute pass: the frame, then every layer. */
  encode(pass: GPUComputePassEncoder, frame: GPUExternalTexture, crop: CropRect): void {
    this.cropBuffer.write(cropData(crop));
    this.preprocess
      .with(pass)
      .with(this.cropBindGroup)
      .with(this.root.createBindGroup(frameLayout, { frame, sampler: this.sampler }))
      .with(this.inputBindGroup)
      .dispatchWorkgroups(Math.ceil(MODEL_PIXELS / WORKGROUP_SIZE));
    for (const handle of this.dispatches) {
      handle.pipeline.with(pass).with(handle.bindGroup).dispatchWorkgroups(handle.workgroups);
    }
  }

  destroy(): void {
    for (const resource of this.owned.splice(0)) resource.destroy();
  }
}

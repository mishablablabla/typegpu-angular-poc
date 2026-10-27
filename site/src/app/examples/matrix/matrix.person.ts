// Who is a person, for both implementations of MATRIX MIRROR: the neural network of `segmentation/`, its filtering, and the
// mask texture the fragment shader reads. The class owns its GPU resources and gives them back in `destroy()`; the two
// implementations differ in how they tie that call to the life of the component, not in what happens here.
import type { TgpuRoot } from 'typegpu';
import { estimateHead, type CropArea, type Face } from './matrix.face';
import { MODEL_URL, needsInference, type ModelStatus } from './matrix.model';
import { letterboxCrop } from './segmentation/crop';
import { MaskPostProcessor, type SampledMaskView } from './segmentation/mask';
import { SelfieSegmenter } from './segmentation/segmenter';

/** The head is looked for again when this many milliseconds have passed since the last time (and no read is pending). */
const HEAD_EVERY_MS = 120;

export class PersonMask {
  status: ModelStatus = 'loading';
  /** The head of the person, as the mask last showed it (in pixels of the mask, with the crop it was made with). */
  head: { readonly face: Face; readonly crop: CropArea } | undefined;

  private readonly aborter = new AbortController();
  private readonly mask: MaskPostProcessor;
  private segmenter: SelfieSegmenter | undefined;
  private lastRun = -1;
  private lastRead = -Infinity;
  private reading = false;
  private destroyed = false;

  /** Starts fetching the model; `onChange` is called when it is ready or failed. */
  constructor(
    private readonly root: TgpuRoot,
    private readonly onChange: () => void,
  ) {
    // Until the model arrives the mask texture is empty: nobody is a person yet.
    this.mask = new MaskPostProcessor(root);
    void this.load();
  }

  /** The mask over the whole video frame (the red channel). It is replaced when the video changes its size. */
  get view(): SampledMaskView {
    return this.mask.maskView;
  }

  /** A new picture: the next run starts from nothing, not from the history of the last one. */
  restart(): void {
    this.lastRun = -1;
    this.head = undefined;
    this.mask.reset();
  }

  /** Runs the network on the frame, if the video has a new one since the last run. */
  update(frame: GPUExternalTexture, video: { width: number; height: number }, frameId: number): void {
    const segmenter = this.segmenter;
    if (!segmenter || this.destroyed) return;
    this.mask.resize(video.width, video.height);
    if (!needsInference(frameId, this.lastRun)) return;
    this.lastRun = frameId;
    const crop = letterboxCrop(video.width, video.height);
    const encoder = this.root.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    segmenter.encode(pass, frame, crop);
    this.mask.encode(pass, frame, crop);
    pass.end();
    this.root.device.queue.submit([encoder.finish()]);
    // The only thing read back from the GPU: a few kilobytes, a few times a second, never two reads at once.
    if (!this.reading && performance.now() - this.lastRead >= HEAD_EVERY_MS) this.findHead(crop);
  }

  private findHead(crop: CropArea): void {
    this.reading = true;
    this.lastRead = performance.now();
    this.mask
      .readRows()
      .then((rows) => {
        if (!this.destroyed) {
          const face = estimateHead(rows);
          this.head = face && { face, crop };
        }
      })
      .catch(() => undefined)
      .finally(() => (this.reading = false));
  }

  destroy(): void {
    this.destroyed = true;
    this.aborter.abort();
    this.segmenter?.destroy();
    this.mask.destroy();
  }

  private async load(): Promise<void> {
    try {
      const segmenter = await SelfieSegmenter.create(this.root, new URL(MODEL_URL, document.baseURI), this.aborter.signal);
      if (this.destroyed) return segmenter.destroy();
      this.segmenter = segmenter;
      this.mask.connect(segmenter.maskBuffer);
      this.status = 'ready';
    } catch (error) {
      if (this.destroyed) return;
      console.error('Matrix mirror: the person model could not be loaded', error);
      this.status = 'failed';
    }
    this.onChange();
  }
}

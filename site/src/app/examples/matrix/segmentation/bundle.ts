// The model file of the person segmenter and how to read it. The network is MediaPipe's selfie segmenter (Google, Apache 2.0),
// repackaged by the TypeGPU project into an `SSG1` container that lists the layers as GPU dispatches; the licence and the notice
// travel with the file (`assets/selfie-segmentation`). This reader and the kernels that run the plan are adapted from TypeGPU's
// own `selfie-segmentation` example (MIT); the reader uses a `DataView` so the example needs no extra dependency.

export const OpKind = { Conv: 0, DwConv: 1, AvgPool: 2, Resize2x: 3, Add: 4, Mul: 5, Head: 6 } as const;
export type OpKind = (typeof OpKind)[keyof typeof OpKind];

export const Activation = { None: 0, Relu: 1, HardSwish: 2, Sigmoid: 3 } as const;
export type Activation = (typeof Activation)[keyof typeof Activation];

export const BroadcastFlag = { H: 1, W: 2, C: 4 } as const;

export type Size2 = readonly [width: number, height: number];
export type Shape3 = readonly [width: number, height: number, channels: number];
export type DispatchSlots = readonly [srcA: number, srcB: number, dst: number];

/** One layer of the network, as one compute dispatch. */
export interface DispatchRecord {
  opKind: OpKind;
  slots: DispatchSlots;
  input: Shape3;
  output: Shape3;
  kernel: Size2;
  stride: Size2;
  pad: Size2;
  /** Where the weights and the bias start in the weights buffer, in vec4 units (negative: none). */
  weights: number;
  bias: number;
  activation: Activation;
  flags: number;
}

export interface SegmenterPlan {
  /** The size of every intermediate buffer, in vec4. */
  slotSizesVec4: number[];
  weights: ArrayBuffer;
  dispatches: DispatchRecord[];
}

const HEADER_WORDS = 10;
const RECORD_WORDS = 22;

export async function loadSegmenterPlan(url: string | URL, signal?: AbortSignal): Promise<SegmenterPlan> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Fetch ${String(url)}: ${response.status} ${response.statusText}`);
  return parseSegmenterPlan(await response.arrayBuffer());
}

export function parseSegmenterPlan(buffer: ArrayBuffer): SegmenterPlan {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SSG1') throw new Error(`Unsupported model file (magic ${JSON.stringify(magic)})`);
  // magic, then: version, input w/h, output w/h, slot count, dispatch count, weights offset and length, bytes per vec4.
  const word = (index: number) => view.getUint32(4 + index * 4, true);
  const slotCount = word(5);
  const dispatchCount = word(6);
  const weightsOffset = word(7);
  const weightsLength = word(8);
  const bytesPerVec4 = word(9);

  const slotsAt = 4 + HEADER_WORDS * 4;
  const slotSizesVec4 = Array.from({ length: slotCount }, (_, i) => view.getUint32(slotsAt + i * 4, true));

  const recordsAt = slotsAt + slotCount * 4;
  const vec4Offset = (offset: number) => (offset < 0 ? offset : offset / bytesPerVec4);
  const dispatches: DispatchRecord[] = [];
  for (let i = 0; i < dispatchCount; i++) {
    const at = recordsAt + i * RECORD_WORDS * 4;
    const i32 = (n: number) => view.getInt32(at + n * 4, true);
    const u32 = (n: number) => view.getUint32(at + n * 4, true);
    dispatches.push({
      opKind: i32(0) as OpKind,
      slots: [i32(1), i32(2), i32(3)],
      input: [u32(4), u32(5), u32(6)],
      output: [u32(7), u32(8), u32(9)],
      kernel: [u32(10), u32(11)],
      stride: [u32(12), u32(13)],
      pad: [u32(14), u32(15)],
      weights: vec4Offset(i32(16)),
      bias: vec4Offset(i32(18)),
      activation: u32(20) as Activation,
      flags: u32(21),
    });
  }
  return { slotSizesVec4, weights: buffer.slice(weightsOffset, weightsOffset + weightsLength), dispatches };
}

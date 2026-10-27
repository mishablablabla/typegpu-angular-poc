// Where the head is, found from the person mask alone (no face detector): the GPU counts the person's pixels in every row of the
// mask, and this module reads that profile, estimates the head from it (the top of the person, down to where the shoulders
// begin), and moves the result between the three spaces involved: the mask (256 by 256 pixels), the video frame (0..1) and the
// canvas (0..1, which shows the frame covering it, mirrored or not). Plain TypeScript, no GPU, no Angular.

/** What one row of the mask holds: how many pixels are person, and the sum of their columns. */
export interface RowStat {
  readonly count: number;
  readonly sumX: number;
}

/** The head in pixels of the mask: its middle (`x`), the row of the eyes, and its size. */
export interface Face {
  readonly x: number;
  readonly eyesY: number;
  readonly width: number;
  readonly height: number;
  /** Row of the top of the head. */
  readonly top: number;
}

const MIN_ROW = 3;
const MIN_ROWS = 24;
const MIN_AREA = 600;

/** A row counts as person when at least this many of its pixels are (a stray pixel is not a head). */
export const hasPerson = (rows: readonly RowStat[]): boolean => {
  const solid = rows.filter((row) => row.count >= MIN_ROW);
  return solid.length >= MIN_ROWS && solid.reduce((sum, row) => sum + row.count, 0) >= MIN_AREA;
};

/**
 * The head of the first (topmost) person in the profile, or `undefined` when there is no person. The width of the person per
 * row grows to the widest point of the head, narrows to the neck (or does not), and then jumps at the shoulders: the head ends
 * where the width passes 1.3 times that peak, or where it falls under 0.7 of it (the neck). With no such sign the head is taken to be
 * 40 % of what is visible. The eyes are 42 % of the way down the head.
 */
export function estimateHead(rows: readonly RowStat[]): Face | undefined {
  if (!hasPerson(rows)) return undefined;
  const top = rows.findIndex((row) => row.count >= MIN_ROW);
  let bottom = rows.length - 1;
  while (bottom > top && rows[bottom]!.count < MIN_ROW) bottom--;
  const visible = bottom - top + 1;

  const smooth = rows.map((_, y) => {
    let sum = 0;
    let n = 0;
    for (let k = -2; k <= 2; k++) {
      const row = rows[y + k];
      if (row) {
        sum += row.count;
        n++;
      }
    }
    return sum / n;
  });

  let headBottom = Math.min(bottom, top + Math.round(visible * 0.4));
  const limit = Math.min(bottom, top + Math.round(visible * 0.65));
  const start = top + Math.max(6, Math.round(visible * 0.1));
  for (let y = start; y <= limit; y++) {
    // The widest the head has been, up to a few rows ago (the width of the row itself must not be its own reference).
    let peak = 0;
    for (let k = top; k <= y - 4; k++) peak = Math.max(peak, smooth[k]!);
    const width = smooth[y]!;
    if (width > peak * 1.3) {
      headBottom = y - 1;
      break;
    }
    // A neck: the width fell well below the peak, so the chin is here.
    if (width < peak * 0.7) {
      headBottom = y;
      break;
    }
  }
  let peakWidth = 0;
  for (let y = top; y <= headBottom; y++) peakWidth = Math.max(peakWidth, smooth[y]!);

  // A head is not much taller than 1.5 times its width: more means the width was not found (an arm at the level of the head).
  const height = Math.max(8, Math.min(headBottom - top + 1, Math.round(peakWidth * 1.6)));
  let weight = 0;
  let sumX = 0;
  for (let y = top; y <= Math.min(bottom, top + height - 1); y++) {
    weight += rows[y]!.count;
    sumX += rows[y]!.sumX;
  }
  if (weight === 0) return undefined;
  // A face is narrower than it is tall: a wider peak is a shoulder or an arm in the rows of the head, not the head.
  return { x: sumX / weight, eyesY: top + height * 0.42, width: Math.max(8, Math.min(peakWidth, height * 0.8)), height, top };
}

// ---- Between the spaces -----------------------------------------------------------------------------------------------

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The part of the video frame the network saw, in frame units (see `segmentation/crop.ts`). */
export interface CropArea {
  readonly origin: Point;
  readonly size: Point;
}

export const MODEL_SIZE = 256;

/** A position in the mask (pixels) as a position in the video frame (0..1). */
export const maskToVideo = (point: Point, crop: CropArea): Point => ({
  x: crop.origin.x + (point.x / MODEL_SIZE) * crop.size.x,
  y: crop.origin.y + (point.y / MODEL_SIZE) * crop.size.y,
});

/** The other way. */
export const videoToMask = (point: Point, crop: CropArea): Point => ({
  x: ((point.x - crop.origin.x) / crop.size.x) * MODEL_SIZE,
  y: ((point.y - crop.origin.y) / crop.size.y) * MODEL_SIZE,
});

/** What the canvas shows: the video covering it, and mirrored or not. The same arithmetic as `videoUv` in the shader. */
export interface View {
  readonly canvasAspect: number;
  readonly videoAspect: number;
  readonly mirror: boolean;
}

/** A position on the canvas (0..1) as a position in the video frame (0..1). */
export function canvasToVideo(point: Point, view: View): Point {
  const wide = view.canvasAspect <= view.videoAspect;
  const x = wide ? (point.x - 0.5) * (view.canvasAspect / view.videoAspect) + 0.5 : point.x;
  const y = wide ? point.y : (point.y - 0.5) * (view.videoAspect / view.canvasAspect) + 0.5;
  return { x: view.mirror ? 1 - x : x, y };
}

/** A position in the video frame as a position on the canvas. */
export function videoToCanvas(point: Point, view: View): Point {
  const wide = view.canvasAspect <= view.videoAspect;
  const x = view.mirror ? 1 - point.x : point.x;
  return wide ? { x: (x - 0.5) * (view.videoAspect / view.canvasAspect) + 0.5, y: point.y } : { x, y: (point.y - 0.5) * (view.canvasAspect / view.videoAspect) + 0.5 };
}

/** The head as a box on the canvas, in fractions of the canvas: its eyes, and its size. */
export interface FaceBox {
  readonly eyes: Point;
  readonly width: number;
  readonly height: number;
}

export function faceOnCanvas(face: Face, crop: CropArea, view: View): FaceBox {
  const eyes = videoToCanvas(maskToVideo({ x: face.x, y: face.eyesY }, crop), view);
  const topLeft = videoToCanvas(maskToVideo({ x: face.x - face.width / 2, y: face.top }, crop), view);
  const bottomRight = videoToCanvas(maskToVideo({ x: face.x + face.width / 2, y: face.top + face.height }, crop), view);
  return { eyes, width: Math.abs(bottomRight.x - topLeft.x), height: Math.abs(bottomRight.y - topLeft.y) };
}

/**
 * Did a click on the canvas (0..1) land on the face itself? The face is the ellipse of the estimate and no more: a click beside
 * it, even one whose reach covers the face, is an ordinary click (the face is then coloured like the rest of the body).
 */
export function hitsHead(face: Face, click: Point, crop: CropArea, view: View): boolean {
  const at = videoToMask(canvasToVideo(click, view), crop);
  const centerY = face.top + face.height / 2;
  const dx = (at.x - face.x) / (face.width * 0.5);
  const dy = (at.y - centerY) / (face.height * 0.5);
  return dx * dx + dy * dy <= 1;
}

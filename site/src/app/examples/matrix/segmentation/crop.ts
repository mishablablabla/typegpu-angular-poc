// Which part of the video frame the network looks at. The network takes a square of 256 by 256 pixels, and a camera frame is
// not square: the crop says where that square lies in the frame, in units of the frame (0..1 across and down). It may reach
// beyond the frame, and the part outside is padding. `letterboxCrop` keeps the whole frame in view, so nobody is cut off.
import { d } from 'typegpu';

export const FrameCrop = d.struct({ origin: d.vec2f, size: d.vec2f });

export interface CropRect {
  readonly origin: { readonly x: number; readonly y: number };
  readonly size: { readonly x: number; readonly y: number };
}

/** The square that contains the whole frame, centred on it. */
export function letterboxCrop(width: number, height: number): CropRect {
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return aspect >= 1
    ? { origin: { x: 0, y: 0.5 - aspect / 2 }, size: { x: 1, y: aspect } }
    : { origin: { x: 0.5 - 1 / aspect / 2, y: 0 }, size: { x: 1 / aspect, y: 1 } };
}

export const cropData = (crop: CropRect): d.InferInput<typeof FrameCrop> => ({
  origin: d.vec2f(crop.origin.x, crop.origin.y),
  size: d.vec2f(crop.size.x, crop.size.y),
});

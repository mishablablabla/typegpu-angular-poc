// What the shaders read, built from the application state. Shared by both implementations of MATRIX MIRROR: the same numbers
// go to the same uniforms whichever way the GPU resources are managed.
import { d } from 'typegpu';
import { Clock, Effects, Params, View } from './matrix.gpu';
import type { SequenceLook } from './matrix.sequence';
import { MAX_RIPPLES, clampCutoff, clampGlyph, clampReach, clampSpeed, paletteIndex, type Fx } from './matrix.model';

/** The canvas and the video. */
export function viewData(canvas: { width: number; height: number } | undefined, video: { width: number; height: number }, mirror: boolean, glyph: number): d.InferInput<typeof View> {
  return { size: d.vec2f(canvas?.width ?? 1, canvas?.height ?? 1), video: d.vec2f(video.width, video.height), cell: clampGlyph(glyph), mirror: mirror ? 1 : 0 };
}

export function paramsData(speed: number, cutoff: number, reach: number, palette: string, reduced: boolean): d.InferInput<typeof Params> {
  return { speed: clampSpeed(speed), cutoff: clampCutoff(cutoff), reach: clampReach(reach), palette: paletteIndex(palette), reduced: reduced ? 1 : 0 };
}

/** Time (the step is capped, so a stalled tab does not make the rain jump). */
export function clockData(time: number, deltaSeconds: number): d.InferInput<typeof Clock> {
  return { time, dt: Math.min(deltaSeconds, 0.05) };
}

const NO_RIPPLE = { center: d.vec2f(), birth: -1000, seed: 0 };

/** The pointer, the recent clicks (padded to the size the shader expects), and what the hidden ending is doing to the picture. */
export function effectsData(fx: Fx, look: SequenceLook = { chaos: 0, glitch: 0, openY: 1, openX: 1, dot: 0 }): d.InferInput<typeof Effects> {
  const ripples = fx.ripples.map((ripple) => ({ center: d.vec2f(ripple.x, ripple.y), birth: ripple.birth, seed: ripple.seed }));
  while (ripples.length < MAX_RIPPLES) ripples.push(NO_RIPPLE);
  return { pointer: d.vec2f(fx.pointer.x, fx.pointer.y), hover: fx.hover, chaos: look.chaos, crt: d.vec3f(look.openY, look.openX, look.dot), glitch: look.glitch, ripples };
}

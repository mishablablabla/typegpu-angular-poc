// The application logic of MATRIX MIRROR: parameters, the state of the person model, the pointer and its ripples, and the
// procedural demo person. Plain TypeScript with no Angular and no GPU: both implementations of the example drive this same
// code, and the numbers it produces are what the shaders read.

import { clamp } from './matrix.math';

export const SOURCES = ['Demo', 'Camera'] as const;
export type SourceKind = (typeof SOURCES)[number];

export const PALETTES = ['Ice', 'Magenta', 'Amber', 'Rainbow'] as const;
export type PaletteName = (typeof PALETTES)[number];

/** The page starts with the demo: the browser asks for the camera only when the user picks it (a click), never on load. */
export const DEFAULTS = { source: 'Demo', palette: 'Ice', speed: 1, cutoff: 0.5, reach: 0.3, glyph: 10, mirror: true } as const;

/** Where the model file is, relative to the page (the build copies it with the other assets). */
export const MODEL_URL = 'assets/selfie-segmentation/selfie_segmenter.ssgbin';

/**
 * The canvas never has more than this many pixels per CSS pixel: the glyph grid is the resolution of the picture, so a
 * retina screen would only make the fragment shader several times more expensive.
 */
export const MAX_PIXEL_RATIO = 1;

export const MAX_RIPPLES = 4;



export const paletteIndex = (name: string): number => Math.max(0, PALETTES.indexOf(name as PaletteName));
export const clampSpeed = (speed: number): number => clamp(speed, 0.2, 3);
/** The level of the person mask that counts as "person". */
export const clampCutoff = (cutoff: number): number => clamp(cutoff, 0.25, 0.75);
/** How far around the pointer the real picture shows instead of the code, in canvas heights. */
export const clampReach = (reach: number): number => clamp(reach, 0.1, 1.5);
/** The size of one glyph in canvas pixels (whole pixels: the glyph grid is drawn on the pixel grid). */
export const clampGlyph = (glyph: number): number => Math.round(clamp(glyph, 7, 24));

// ---- The video source and the model --------------------------------------------------------------------------------------

export type SourceStatus = 'idle' | 'starting' | 'live' | 'denied' | 'unavailable';

/** The person model is a file of about 220 kB, fetched when the example opens. */
export type ModelStatus = 'loading' | 'ready' | 'failed';

/** What the HUD says about the picture source and the model. */
export function statusText(status: SourceStatus, kind: SourceKind, model: ModelStatus = 'ready'): string {
  if (model === 'failed') return 'The person model could not be loaded: showing the picture as rain only';
  const suffix = model === 'loading' ? ' · loading the person model…' : '';
  if (kind === 'Demo') return (status === 'live' ? 'Demo scene: a synthetic person. Set Source to Camera to use yours.' : 'Starting the demo scene…') + suffix;
  switch (status) {
    case 'live':
      return 'Camera live' + suffix;
    case 'starting':
      return 'Waiting for the camera…';
    case 'denied':
      return 'Camera permission was denied';
    case 'unavailable':
      return 'No camera available';
    default:
      return 'Camera off';
  }
}

/** Camera trouble means the example has nothing to show but the demo. */
export const needsFallback = (status: SourceStatus, kind: SourceKind): boolean => kind === 'Camera' && (status === 'denied' || status === 'unavailable');

/** The network runs when there is a new picture for it (a camera at 30 frames a second does not need 60 runs). */
export const needsInference = (frameId: number, lastRun: number): boolean => frameId !== lastRun;

// ---- Pointer ----------------------------------------------------------------------------------------------------------

/** A click: where it was, when, and a number that makes its cracks different from the cracks of the other clicks. */
export interface Ripple {
  readonly x: number;
  readonly y: number;
  readonly birth: number;
  readonly seed: number;
}

/** The pointer over the picture (0..1 across and down) and the ripples its clicks made. */
export interface Fx {
  readonly pointer: { readonly x: number; readonly y: number };
  readonly inside: boolean;
  /** Eases to 1 while the pointer is over the picture and back to 0 when it leaves. */
  readonly hover: number;
  readonly ripples: readonly Ripple[];
  /** Has the user done anything? (the hint fades) */
  readonly used: boolean;
}

/** A click opens the picture for this long: it grows at once, holds for `RIPPLE_HOLD`, and then closes again, shard by shard. */
export const RIPPLE_LIFETIME = 3.4;
export const RIPPLE_HOLD = 1.5;

export const initialFx = (): Fx => ({ pointer: { x: 0.5, y: 0.5 }, inside: false, hover: 0, ripples: [], used: false });

export const pointerMove = (fx: Fx, x: number, y: number): Fx => ({ ...fx, pointer: { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }, inside: true, used: true });

export const pointerDown = (fx: Fx, x: number, y: number, now: number): Fx => ({
  ...pointerMove(fx, x, y),
  ripples: [...fx.ripples, { x: clamp(x, 0, 1), y: clamp(y, 0, 1), birth: now, seed: Math.floor(now * 977 + fx.ripples.length * 131 + x * 313 + y * 719) % 997 }].slice(-MAX_RIPPLES),
});

export const pointerLeave = (fx: Fx): Fx => ({ ...fx, inside: false });

export function advanceFx(fx: Fx, deltaSeconds: number, now: number): Fx {
  const target = fx.inside ? 1 : 0;
  const hover = Math.abs(target - fx.hover) < 0.002 ? target : fx.hover + (target - fx.hover) * Math.min(1, deltaSeconds * 8);
  const ripples = fx.ripples.length > 0 && now - fx.ripples[0]!.birth > RIPPLE_LIFETIME ? fx.ripples.filter((ripple) => now - ripple.birth <= RIPPLE_LIFETIME) : fx.ripples;
  return hover === fx.hover && ripples === fx.ripples ? fx : { ...fx, hover, ripples };
}

// ---- The demo person --------------------------------------------------------------------------------------------------

export interface DemoPose {
  /** Horizontal centre of the person (0..1 across the picture); beyond 1.2 the person is out of the picture. */
  readonly x: number;
  /** Arm angles in radians (0 hangs down, positive raises the arm outwards). */
  readonly leftArm: number;
  readonly rightArm: number;
  /** Walking phase, for the legs, and a small sway of the body. */
  readonly step: number;
  readonly sway: number;
}

/** How far the demo person has walked in, 0..1, `seconds` after the picture started. */
export const WALK_IN_SECONDS = 3.5;
export const demoPresence = (seconds: number): number => clamp(seconds / WALK_IN_SECONDS, 0, 1);

/** `presence` runs 0..1: the person walks in from the right and then stays, swaying and waving. */
export function demoPose(time: number, presence: number): DemoPose {
  const walk = 1 - Math.pow(1 - clamp(presence, 0, 1), 3);
  const x = 1.35 - walk * 0.85 + Math.sin(time * 0.45) * 0.12 * walk;
  return {
    x,
    leftArm: 0.25 + Math.sin(time * 1.3) * 0.2,
    rightArm: 0.9 + Math.sin(time * 3.1) * 0.7 * walk,
    step: presence < 1 ? time * 6 : 0,
    sway: Math.sin(time * 0.9) * 0.03,
  };
}

export const isPersonVisible = (pose: DemoPose): boolean => pose.x < 1.2;

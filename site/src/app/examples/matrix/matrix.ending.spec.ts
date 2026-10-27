// The hidden ending: finding the head in a mask profile, moving points between the spaces, the sequence of phases, and what
// a click does. All plain TypeScript: no GPU and no Angular are needed to say that the ending starts on the face and nowhere else.
import { describe, expect, it, vi } from 'vitest';
import { Ending } from './matrix.ending';
import {
  canvasToVideo,
  estimateHead,
  faceOnCanvas,
  hasPerson,
  hitsHead,
  maskToVideo,
  videoToCanvas,
  videoToMask,
  type CropArea,
  type Face,
  type RowStat,
  type View,
} from './matrix.face';
import type { PersonMask } from './matrix.person';
import {
  BOOT_SECONDS,
  CHAOS_SECONDS,
  ERROR_SECONDS,
  LINE,
  PROMISE,
  SECONDS_PER_LETTER,
  SHUTDOWN_SECONDS,
  answer,
  idleSequence,
  isBusy,
  isDark,
  sequenceLook,
  startSequence,
  stepSequence,
  typedText,
  typingSeconds,
} from './matrix.sequence';

/** A person of 256 rows: from `top` a head (an ellipse of this width and height) on a neck and then shoulders and a body. */
function profile({ top = 30, headWidth = 50, headHeight = 60, neck = true, centre = 128 } = {}): RowStat[] {
  const row = (width: number) => ({ count: Math.max(0, Math.round(width)), sumX: Math.max(0, Math.round(width)) * centre });
  return Array.from({ length: 256 }, (_, y) => {
    if (y < top) return row(0);
    const t = y - top;
    if (t < headHeight) {
      const u = (t + 0.5) / headHeight;
      return row(headWidth * Math.sqrt(Math.max(0, 1 - Math.pow(2 * u - 1, 2))));
    }
    if (t < headHeight + 8) return row(neck ? headWidth * 0.5 : headWidth * 0.9);
    if (t < headHeight + 30) return row(headWidth * (neck ? 0.5 : 0.9) + (t - headHeight - 8) * 5);
    return row(headWidth * 2.6);
  });
}

describe('finding the head in a mask profile', () => {
  it('needs a person: an empty mask, or a few stray pixels, has no head', () => {
    expect(estimateHead(Array.from({ length: 256 }, () => ({ count: 0, sumX: 0 })))).toBeUndefined();
    const stray = Array.from({ length: 256 }, (_, y) => ({ count: y === 100 ? 3 : 0, sumX: y === 100 ? 300 : 0 }));
    expect(hasPerson(stray)).toBe(false);
    expect(estimateHead(stray)).toBeUndefined();
  });

  it('finds the top, the middle, the width and the eyes of a head with a neck', () => {
    const face = estimateHead(profile())!;
    expect(face.top).toBe(30);
    expect(face.x).toBeCloseTo(128, 0);
    expect(face.width).toBeGreaterThan(40);
    expect(face.width).toBeLessThan(56);
    // The head is 60 rows tall and the estimate ends at the neck, give or take the rows the smoothing blurs.
    expect(face.height).toBeGreaterThan(48);
    expect(face.height).toBeLessThan(75);
    expect(face.eyesY).toBeGreaterThan(face.top + face.height * 0.3);
    expect(face.eyesY).toBeLessThan(face.top + face.height * 0.55);
  });

  it('finds a head that sits straight on the shoulders (no neck) where the width jumps', () => {
    const face = estimateHead(profile({ neck: false }))!;
    expect(face.top).toBe(30);
    expect(face.height).toBeGreaterThan(40);
    expect(face.height).toBeLessThan(90);
  });

  it('follows the head sideways and down', () => {
    expect(estimateHead(profile({ centre: 60 }))!.x).toBeCloseTo(60, 0);
    expect(estimateHead(profile({ top: 90 }))!.top).toBe(90);
  });
});

describe('moving between the spaces', () => {
  const crop: CropArea = { origin: { x: 0, y: -0.39 }, size: { x: 1, y: 1.78 } };
  const views: View[] = [
    { canvasAspect: 1, videoAspect: 16 / 9, mirror: true },
    { canvasAspect: 16 / 9, videoAspect: 16 / 9, mirror: false },
    { canvasAspect: 2.5, videoAspect: 16 / 9, mirror: true },
    { canvasAspect: 0.6, videoAspect: 16 / 9, mirror: false },
  ];

  it('goes between the mask and the video and back', () => {
    const point = { x: 77, y: 140 };
    const back = videoToMask(maskToVideo(point, crop), crop);
    expect(back.x).toBeCloseTo(point.x);
    expect(back.y).toBeCloseTo(point.y);
    expect(maskToVideo({ x: 0, y: 0 }, crop)).toEqual({ x: 0, y: -0.39 });
    expect(maskToVideo({ x: 256, y: 256 }, crop).y).toBeCloseTo(1.39);
  });

  it.each(views.map((view) => [JSON.stringify(view), view] as const))('goes between the canvas and the video and back (%s)', (_name, view) => {
    for (const point of [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.3 }, { x: 0.45, y: 0.5 }]) {
      const back = videoToCanvas(canvasToVideo(point, view), view);
      expect(back.x).toBeCloseTo(point.x);
      expect(back.y).toBeCloseTo(point.y);
    }
  });

  it('mirrors: a person on the left of the frame is on the right of a mirrored canvas', () => {
    const view: View = { canvasAspect: 16 / 9, videoAspect: 16 / 9, mirror: true };
    expect(videoToCanvas({ x: 0.2, y: 0.5 }, view).x).toBeCloseTo(0.8);
    expect(videoToCanvas({ x: 0.2, y: 0.5 }, { ...view, mirror: false }).x).toBeCloseTo(0.2);
  });

  it('puts the eyes and the size of the head on the canvas, and hits the head and not the body', () => {
    const view: View = { canvasAspect: 16 / 9, videoAspect: 16 / 9, mirror: false };
    const face: Face = { x: 128, eyesY: 56, width: 40, height: 50, top: 35 };
    const box = faceOnCanvas(face, crop, view);
    expect(box.eyes.x).toBeCloseTo(0.5);
    expect(box.width).toBeCloseTo(40 / 256);
    expect(hitsHead(face, videoToCanvas(maskToVideo({ x: 128, y: 60 }, crop), view), crop, view)).toBe(true);
    expect(hitsHead(face, videoToCanvas(maskToVideo({ x: 128, y: 140 }, crop), view), crop, view)).toBe(false);
    expect(hitsHead(face, videoToCanvas(maskToVideo({ x: 200, y: 60 }, crop), view), crop, view)).toBe(false);
  });

  it('only the face itself starts the ending: a click beside it, or just above or under it, does not', () => {
    const view: View = { canvasAspect: 16 / 9, videoAspect: 16 / 9, mirror: false };
    const face: Face = { x: 128, eyesY: 56, width: 40, height: 50, top: 35 };
    const at = (x: number, y: number) => hitsHead(face, videoToCanvas(maskToVideo({ x, y }, crop), view), crop, view);
    expect(at(128 + 15, 60)).toBe(true);
    expect(at(128 + 26, 60)).toBe(false);
    expect(at(128, 35 - 6)).toBe(false);
    expect(at(128, 35 + 50 + 6)).toBe(false);
  });

  it('a head is never wider than 0.8 of its height, whatever the rows of the head hold', () => {
    // An arm at the level of the head: 110 wide rows beside a head of 40.
    const rows = profile({ headWidth: 40, headHeight: 50 }).map((row, y) => (y >= 40 && y < 60 ? { count: row.count + 70, sumX: row.sumX + 70 * 128 } : row));
    const face = estimateHead(rows)!;
    expect(face.width).toBeLessThanOrEqual(face.height * 0.8 + 1e-9);
  });
});

describe('the sequence', () => {
  const box = { eyes: { x: 0.5, y: 0.4 }, width: 0.1, height: 0.2 };

  it('runs on by itself to the question, and waits there for the answer', () => {
    let sequence = startSequence(10, box);
    expect(sequence.phase).toBe('error');
    expect(stepSequence(sequence, 10 + ERROR_SECONDS - 0.1)).toBe(sequence);
    sequence = stepSequence(sequence, 10 + ERROR_SECONDS + 0.001);
    expect(sequence.phase).toBe('chaos');
    sequence = stepSequence(sequence, sequence.since + CHAOS_SECONDS + 0.001);
    expect(sequence.phase).toBe('shutdown');
    sequence = stepSequence(sequence, sequence.since + SHUTDOWN_SECONDS + 0.001);
    expect(sequence.phase).toBe('confirm');
    expect(stepSequence(sequence, 1e6)).toBe(sequence);
    expect(sequence.face).toBe(box);
  });

  it('answers only the question; the answer starts the typing, which waits for the picture before it turns on', () => {
    expect(answer(startSequence(0, box), 5).phase).toBe('error');
    const confirm = { phase: 'confirm', since: 20, face: box } as const;
    const typing = answer(confirm, 21);
    expect(typing).toMatchObject({ phase: 'typing', since: 21 });
    expect(stepSequence(typing, 21 + typingSeconds() + 5, false).phase).toBe('typing');
    const boot = stepSequence(typing, 21 + typingSeconds() + 0.001, true);
    expect(boot.phase).toBe('boot');
    expect(stepSequence(boot, boot.since + BOOT_SECONDS + 0.001).phase).toBe('idle');
  });

  it('types the sentence letter by letter, then holds it', () => {
    const typing = { phase: 'typing', since: 0 } as const;
    expect(typedText(typing, 0)).toBe('');
    expect(typedText(typing, 5 * SECONDS_PER_LETTER + 0.001)).toBe(PROMISE.slice(0, 5));
    expect(typedText(typing, PROMISE.length * SECONDS_PER_LETTER + 10)).toBe(PROMISE);
    expect(typedText({ phase: 'idle', since: 0 }, 3)).toBe('');
  });

  it('is busy and dark exactly when it should be', () => {
    expect(isBusy(idleSequence())).toBe(false);
    expect(isBusy(startSequence(0, box))).toBe(true);
    expect(isDark({ phase: 'confirm', since: 0 })).toBe(true);
    expect(isDark({ phase: 'typing', since: 0 })).toBe(true);
    expect(isDark({ phase: 'shutdown', since: 0 })).toBe(false);
    expect(isDark({ phase: 'boot', since: 0 })).toBe(false);
  });

  it('looks: calm and open when idle, madder as it goes, collapsing to a line, then a dot, then dark; turning on is the reverse', () => {
    const at = (phase: 'error' | 'chaos' | 'shutdown' | 'confirm' | 'typing' | 'boot' | 'idle', seconds: number) => sequenceLook({ phase, since: 0 }, seconds);
    expect(at('idle', 5)).toMatchObject({ chaos: 0, glitch: 0, openY: 1, openX: 1 });
    expect(at('error', 0).chaos).toBe(0);
    expect(at('chaos', 5).chaos).toBe(1);
    expect(at('chaos', 5).chaos).toBeGreaterThan(at('error', ERROR_SECONDS).chaos);
    const collapse = (t: number) => at('shutdown', t * SHUTDOWN_SECONDS);
    expect(collapse(0)).toMatchObject({ openY: 1, openX: 1 });
    expect(collapse(0.4).openY).toBeCloseTo(LINE);
    expect(collapse(0.4).openX).toBe(1);
    expect(collapse(0.75).openX).toBeCloseTo(0);
    expect(collapse(0.75).dot).toBe(1);
    expect(collapse(1).dot).toBeCloseTo(0);
    let previous = 1;
    for (let t = 0; t <= 0.4; t += 0.05) {
      expect(collapse(t).openY).toBeLessThanOrEqual(previous + 1e-9);
      previous = collapse(t).openY;
    }
    expect(at('confirm', 3)).toMatchObject({ openY: 0, openX: 0, dot: 0, chaos: 0 });
    expect(at('typing', 3)).toMatchObject({ openY: 0, openX: 0 });
    const boot = (t: number) => at('boot', t * BOOT_SECONDS);
    expect(boot(0)).toMatchObject({ openX: 0, glitch: 1 });
    expect(boot(1)).toMatchObject({ openY: 1, openX: 1, glitch: 0, chaos: 0 });
    expect(boot(0.5).glitch).toBeLessThan(boot(0.1).glitch);
    expect(boot(0.9).openY).toBeGreaterThanOrEqual(boot(0.7).openY);
  });
});

describe('the ending object', () => {
  const view: View = { canvasAspect: 16 / 9, videoAspect: 16 / 9, mirror: false };
  const crop: CropArea = { origin: { x: 0, y: -0.39 }, size: { x: 1, y: 1.78 } };
  const face: Face = { x: 128, eyesY: 56, width: 40, height: 50, top: 35 };
  const person = (head: PersonMask['head']) => ({ head }) as unknown as PersonMask;
  const onHead = videoToCanvas(maskToVideo({ x: 128, y: 60 }, crop), view);
  const onBody = videoToCanvas(maskToVideo({ x: 128, y: 150 }, crop), view);

  it('starts on a click on the head, and on no other', () => {
    const ending = new Ending();
    expect(ending.click(1, onBody, view, person({ face, crop }))).toBe(false);
    expect(ending.click(1, onHead, view, person(undefined))).toBe(false);
    expect(ending.busy).toBe(false);
    expect(ending.click(1, onHead, view, person({ face, crop }))).toBe(true);
    expect(ending.busy).toBe(true);
    expect(ending.sequence.face!.eyes.x).toBeCloseTo(0.5);
    expect(ending.click(2, onHead, view, person({ face, crop }))).toBe(false);
  });

  it('turns the camera off when the screen goes black, and on when the sentence starts, once each', () => {
    const ending = new Ending();
    const hooks = { cameraOff: vi.fn(), cameraOn: vi.fn() };
    ending.click(0, onHead, view, person({ face, crop }));
    let now = 0;
    for (; now < 20 && ending.sequence.phase !== 'confirm'; now += 0.05) ending.frame(now, true, hooks);
    expect(ending.sequence.phase).toBe('confirm');
    expect(ending.dark).toBe(true);
    for (let i = 0; i < 10; i++) ending.frame(now + i, false, hooks);
    expect(hooks.cameraOff).toHaveBeenCalledTimes(1);
    expect(hooks.cameraOn).not.toHaveBeenCalled();
    ending.answer(now);
    ending.frame(now, false, hooks);
    expect(hooks.cameraOn).toHaveBeenCalledTimes(1);
    ending.frame(now + 60, false, hooks);
    expect(ending.sequence.phase).toBe('typing');
    ending.frame(now + 61, true, hooks);
    expect(ending.sequence.phase).toBe('boot');
    for (let t = now + 61; t < now + 70; t += 0.1) ending.frame(t, true, hooks);
    expect(ending.sequence.phase).toBe('idle');
    expect(ending.busy).toBe(false);
    expect(hooks.cameraOff).toHaveBeenCalledTimes(1);
    expect(hooks.cameraOn).toHaveBeenCalledTimes(1);
  });
});

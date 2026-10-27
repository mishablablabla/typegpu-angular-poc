// The hidden ending of MATRIX MIRROR, as a pure state machine. A click on the head puts ERROR on the eyes; the picture then goes
// mad, collapses like an old television, and a question appears on the black screen. "Go back" types a sentence, and the picture
// comes back the way a television turns on, through a glitch. The scene advances it every frame and the shaders and the panel
// read what it says. No Angular, no GPU.
import { clamp01 } from './matrix.math';
import type { FaceBox } from './matrix.face';

export type Phase =
  /** Nothing is going on. */
  | 'idle'
  /** ERROR sits on the eyes, glitching. */
  | 'error'
  /** The picture goes mad. */
  | 'chaos'
  /** It collapses to a line, then a dot, then nothing. */
  | 'shutdown'
  /** Black: the question, and two buttons. The camera is off. */
  | 'confirm'
  /** The sentence is typed on the black screen; the picture is restarted meanwhile. */
  | 'typing'
  /** The picture turns on, through a glitch. */
  | 'boot';

export interface Sequence {
  readonly phase: Phase;
  readonly since: number;
  /** The head at the click: where ERROR goes. */
  readonly face?: FaceBox;
}

export const ERROR_SECONDS = 1.7;
export const CHAOS_SECONDS = 2.6;
export const SHUTDOWN_SECONDS = 1.25;
export const BOOT_SECONDS = 1.5;
export const SECONDS_PER_LETTER = 0.05;
export const TYPING_HOLD_SECONDS = 1;

export const QUESTION = 'Are you sure you want to go back?';
export const QUESTION_DETAIL = 'The code will stop, and you will wake up and forget what you saw.';
export const PROMISE = "I hope you won't break the rules again.";

export const idleSequence = (): Sequence => ({ phase: 'idle', since: 0 });

export const startSequence = (now: number, face: FaceBox): Sequence => ({ phase: 'error', since: now, face });

/** Ends of the phases that run by themselves. */
export function stepSequence(sequence: Sequence, now: number, ready = true): Sequence {
  const elapsed = now - sequence.since;
  switch (sequence.phase) {
    case 'error':
      return elapsed >= ERROR_SECONDS ? { ...sequence, phase: 'chaos', since: now } : sequence;
    case 'chaos':
      return elapsed >= CHAOS_SECONDS ? { ...sequence, phase: 'shutdown', since: now } : sequence;
    case 'shutdown':
      return elapsed >= SHUTDOWN_SECONDS ? { ...sequence, phase: 'confirm', since: now } : sequence;
    case 'typing':
      // The picture must be back before it turns on.
      return elapsed >= typingSeconds() && ready ? { ...sequence, phase: 'boot', since: now } : sequence;
    case 'boot':
      return elapsed >= BOOT_SECONDS ? idleSequence() : sequence;
    default:
      return sequence;
  }
}

/** The answers to the question: both lead on through the typing, which restarts the picture. */
export const answer = (sequence: Sequence, now: number): Sequence => (sequence.phase === 'confirm' ? { ...sequence, phase: 'typing', since: now } : sequence);

export const typingSeconds = (): number => PROMISE.length * SECONDS_PER_LETTER + TYPING_HOLD_SECONDS;

/** The part of the sentence typed so far. */
export const typedText = (sequence: Sequence, now: number): string => (sequence.phase === 'typing' ? PROMISE.slice(0, Math.floor(clamp01((now - sequence.since) / (PROMISE.length * SECONDS_PER_LETTER)) * PROMISE.length)) : '');

/** Nothing else on the page may react while this is going on. */
export const isBusy = (sequence: Sequence): boolean => sequence.phase !== 'idle';

/** The picture is off (black behind the question and the typing): the camera need not run. */
export const isDark = (sequence: Sequence): boolean => sequence.phase === 'confirm' || sequence.phase === 'typing';

// ---- What the shader reads ----------------------------------------------------------------------------------------------

export interface SequenceLook {
  /** 0..1: how mad the picture is. */
  readonly chaos: number;
  /** 0..1: tearing and noise. */
  readonly glitch: number;
  /** How much of the height and the width of the picture is on (1 is all of it), and how bright the dot is when nothing else is. */
  readonly openY: number;
  readonly openX: number;
  readonly dot: number;
}

const OPEN: SequenceLook = { chaos: 0, glitch: 0, openY: 1, openX: 1, dot: 0 };
const CLOSED: SequenceLook = { chaos: 0, glitch: 0, openY: 0, openX: 0, dot: 0 };
/** The line of a television that has collapsed in height, as a share of the height. */
export const LINE = 0.006;

const ease = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const smooth = (t: number) => clamp01(t) * clamp01(t) * (3 - 2 * clamp01(t));

/** The collapse: first the height (to a line), then the width (to a dot), then the dot goes out. `t` is 0..1. */
function collapse(t: number): Pick<SequenceLook, 'openY' | 'openX' | 'dot'> {
  if (t < 0.4) return { openY: 1 - ease(t / 0.4) * (1 - LINE), openX: 1, dot: 1 };
  if (t < 0.75) return { openY: LINE, openX: 1 - ease((t - 0.4) / 0.35), dot: 1 };
  return { openY: LINE, openX: 0, dot: 1 - smooth((t - 0.75) / 0.25) };
}

/** Turning on is the collapse run backwards. */
const expand = (t: number): Pick<SequenceLook, 'openY' | 'openX' | 'dot'> => collapse(1 - clamp01(t));

export function sequenceLook(sequence: Sequence, now: number): SequenceLook {
  const elapsed = Math.max(0, now - sequence.since);
  switch (sequence.phase) {
    case 'error':
      return { ...OPEN, chaos: 0.25 * smooth(elapsed / ERROR_SECONDS), glitch: 0.5 + 0.3 * Math.sin(elapsed * 40) };
    case 'chaos':
      return { ...OPEN, chaos: 0.25 + 0.75 * smooth(elapsed / (CHAOS_SECONDS * 0.6)), glitch: 0.8 };
    case 'shutdown': {
      const t = elapsed / SHUTDOWN_SECONDS;
      return { chaos: 1 - 0.5 * smooth(t), glitch: 0.8 * (1 - smooth(t)), ...collapse(t) };
    }
    case 'confirm':
    case 'typing':
      return CLOSED;
    case 'boot': {
      const t = elapsed / BOOT_SECONDS;
      return { chaos: 0.4 * (1 - smooth(t)), glitch: 1 - smooth(t), ...expand(t) };
    }
    default:
      return OPEN;
  }
}

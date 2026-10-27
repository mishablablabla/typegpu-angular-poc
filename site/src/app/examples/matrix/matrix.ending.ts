// The hidden ending of MATRIX MIRROR as one object both implementations hold: the sequence of `matrix.sequence.ts`, and what
// has to happen to the picture source and the network at its turning points (the camera goes off while the screen is black,
// and starts again while the sentence is typed). It owns no Angular and no GPU resource.
import { faceOnCanvas, hitsHead, type Point, type View } from './matrix.face';
import type { PersonMask } from './matrix.person';
import { answer, idleSequence, isBusy, isDark, sequenceLook, startSequence, stepSequence, typedText, type Phase, type Sequence, type SequenceLook } from './matrix.sequence';

/** What the scene does at the turning points. */
export interface EndingHooks {
  /** The screen went black: the camera is not needed. */
  cameraOff(): void;
  /** The sentence starts to be typed: the camera and the network start from nothing. */
  cameraOn(): void;
}

export class Ending {
  sequence: Sequence = idleSequence();
  private shown: Phase = 'idle';

  get busy(): boolean {
    return isBusy(this.sequence);
  }

  /** The picture is black (behind the question and the sentence). */
  get dark(): boolean {
    return isDark(this.sequence);
  }

  /** A click on the canvas (0..1). When it lands on the head the ending starts and this is true; otherwise it is an ordinary click. */
  click(now: number, point: Point, view: View, person: PersonMask): boolean {
    const head = person.head;
    if (this.busy || !head || !hitsHead(head.face, point, head.crop, view)) return false;
    this.sequence = startSequence(now, faceOnCanvas(head.face, head.crop, view));
    return true;
  }

  /** "Go back": the answer to the question. */
  answer(now: number): void {
    this.sequence = answer(this.sequence, now);
  }

  /** Advances the sequence (`ready`: the picture is back, so it may turn on) and tells what it does to the picture. */
  frame(now: number, ready: boolean, hooks: EndingHooks): SequenceLook {
    this.sequence = stepSequence(this.sequence, now, ready);
    if (this.sequence.phase !== this.shown) {
      this.shown = this.sequence.phase;
      if (this.shown === 'confirm') hooks.cameraOff();
      if (this.shown === 'typing') hooks.cameraOn();
    }
    return sequenceLook(this.sequence, now);
  }

  /** The part of the sentence typed so far. */
  typed(now: number): string {
    return typedText(this.sequence, now);
  }
}

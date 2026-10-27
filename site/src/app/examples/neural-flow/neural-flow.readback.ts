// How the interface learns what the neurons are doing: the state lives on the GPU, so the page asks for it a few times a
// second (one read of the neurons' buffer at a time), never every frame. Plain TypeGPU, no Angular: both implementations of
// NEURAL FLOW use it.
import type { TgpuBuffer } from 'typegpu';
import type { Neurons } from './neural-flow.gpu';
import { NEURONS, REFRACTORY } from './neural-flow.model';

export interface Activity {
  /** The share of neurons that fired within the last quarter second. */
  readonly firing: number;
  /** The selected neuron: how recently and how strongly it fired (0..1), and its potential. */
  readonly level: number;
  readonly potential: number;
}

export const QUIET: Activity = { firing: 0, level: 0, potential: 0 };

const INTERVAL = 0.2;

export class ActivityReader {
  private pending = false;
  private lastAsked = -Infinity;
  private disposed = false;

  constructor(
    private readonly neurons: TgpuBuffer<typeof Neurons>,
    private readonly onActivity: (activity: Activity) => void,
  ) {}

  /** Asks for the neurons (at most five times a second, and never while a read is still on its way). */
  poll(wallSeconds: number, simTime: number, selected: number): void {
    if (this.disposed || this.pending || wallSeconds - this.lastAsked < INTERVAL) return;
    this.lastAsked = wallSeconds;
    this.pending = true;
    this.neurons.read().then(
      (neurons) => {
        this.pending = false;
        if (this.disposed) return;
        let recent = 0;
        for (let i = 0; i < NEURONS; i++) if (simTime - neurons[i]!.spike < 0.25) recent++;
        const chosen = selected >= 0 ? neurons[selected] : undefined;
        this.onActivity({
          firing: recent / NEURONS,
          level: chosen ? Math.exp(-Math.max(0, simTime - chosen.spike) / (REFRACTORY * 1.3)) * (chosen.spike > -100 ? 1 : 0) : 0,
          potential: chosen?.v ?? 0,
        });
      },
      () => {
        // The buffer was destroyed (or the device lost) while the read was on its way: nothing to report.
        this.pending = false;
      },
    );
  }

  dispose(): void {
    this.disposed = true;
  }
}

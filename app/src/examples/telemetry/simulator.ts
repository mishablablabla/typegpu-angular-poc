// Synthetic bedside-monitor data. Pure TypeScript, no Angular, no GPU: unit-testable on its own.
// Eight channels share a ring buffer (`channels * count` floats, channel-major). Values are in [-1, 1].

export const CHANNEL_NAMES = ['ECG II', 'ECG V1', 'SpO2 pleth', 'Resp', 'ABP', 'CVP', 'EtCO2', 'EEG'] as const;
export const CHANNELS = CHANNEL_NAMES.length;
export const SAMPLES = 1024;
export const SAMPLE_RATE = 250;

/** Deterministic pseudo-random numbers so tests and screenshots are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));

export class TelemetrySimulator {
  /** Ring buffer, channel-major: sample `i` of channel `c` is at `c * SAMPLES + (head + i) % SAMPLES`. */
  readonly samples = new Float32Array(CHANNELS * SAMPLES);
  /** Index of the oldest sample in every channel's ring. */
  head = 0;
  /** Latest value per channel. */
  readonly latest = new Float32Array(CHANNELS);
  /** Channels whose absolute value exceeded `threshold` recently (latched for `HOLD_SECONDS`). */
  readonly alarmUntil = new Float64Array(CHANNELS);

  static readonly HOLD_SECONDS = 1.5;

  #time = 0;
  #carry = 0;
  readonly #random: () => number;

  constructor(seed = 1) {
    this.#random = mulberry32(seed);
  }

  /** Value of channel `c` at time `t` seconds. */
  signal(c: number, t: number, noise: number): number {
    const beat = (t * 1.2) % 1; // 72 bpm
    switch (c) {
      case 0:
        return 0.15 * gauss(beat, 0.2, 0.03) + 0.9 * gauss(beat, 0.4, 0.008) - 0.2 * gauss(beat, 0.38, 0.01) + 0.25 * gauss(beat, 0.7, 0.05) + noise * 0.03;
      case 1:
        return -0.5 * gauss(beat, 0.4, 0.01) + 0.4 * gauss(beat, 0.55, 0.04) + noise * 0.03;
      case 2:
        return 0.7 * gauss(beat, 0.5, 0.12) - 0.3 + noise * 0.01;
      case 3:
        return 0.5 * Math.sin(2 * Math.PI * 0.25 * t) + noise * 0.01;
      case 4:
        return 0.6 * gauss(beat, 0.45, 0.1) - 0.1 + noise * 0.01;
      case 5:
        return 0.2 * Math.sin(2 * Math.PI * 0.25 * t + 1) + 0.1 * gauss(beat, 0.5, 0.05) + noise * 0.01;
      case 6:
        return Math.max(-0.8, Math.min(0.5, 2 * Math.sin(2 * Math.PI * 0.25 * t))) * 0.5 + noise * 0.01;
      default:
        return 0.15 * Math.sin(2 * Math.PI * 9 * t) + 0.1 * Math.sin(2 * Math.PI * 4.3 * t) + noise * 0.15;
    }
  }

  /** Advances the simulation by `dtSeconds`; returns how many samples were produced per channel. */
  step(dtSeconds: number, threshold: number): number {
    this.#carry += Math.min(dtSeconds, 0.25) * SAMPLE_RATE;
    const produced = Math.floor(this.#carry);
    this.#carry -= produced;

    for (let n = 0; n < produced; n++) {
      this.#time += 1 / SAMPLE_RATE;
      for (let c = 0; c < CHANNELS; c++) {
        let value = this.signal(c, this.#time, this.#random() * 2 - 1);
        // An artifact now and then on the EEG channel, to give the alarm something to do.
        if (c === 7 && this.#time % 9 < 0.12) value += 0.9;
        value = Math.max(-1, Math.min(1, value));
        this.samples[c * SAMPLES + this.head] = value;
        this.latest[c] = value;
        if (Math.abs(value) > threshold) this.alarmUntil[c] = this.#time + TelemetrySimulator.HOLD_SECONDS;
      }
      this.head = (this.head + 1) % SAMPLES;
    }
    return produced;
  }

  alarms(): boolean[] {
    return Array.from(this.alarmUntil, (until) => until > this.#time);
  }
}

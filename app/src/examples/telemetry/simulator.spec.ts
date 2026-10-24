import { describe, expect, it } from 'vitest';
import { CHANNELS, SAMPLES, SAMPLE_RATE, TelemetrySimulator } from './simulator';

describe('TelemetrySimulator', () => {
  it('is deterministic for a seed', () => {
    const a = new TelemetrySimulator(7);
    const b = new TelemetrySimulator(7);
    a.step(1, 0.95);
    b.step(1, 0.95);
    expect(Array.from(a.samples)).toEqual(Array.from(b.samples));
  });

  it('produces SAMPLE_RATE samples per second, carrying fractions over', () => {
    const sim = new TelemetrySimulator();
    let produced = 0;
    for (let i = 0; i < 100; i++) produced += sim.step(0.0166, 0.95);
    expect(produced).toBeGreaterThanOrEqual(Math.floor(100 * 0.0166 * SAMPLE_RATE) - 1);
    expect(produced).toBeLessThanOrEqual(Math.ceil(100 * 0.0166 * SAMPLE_RATE));
  });

  it('wraps the ring buffer and keeps values in range', () => {
    const sim = new TelemetrySimulator();
    sim.step(0.25, 0.95);
    sim.step(0.25, 0.95);
    sim.step(0.25, 0.95);
    sim.step(0.25, 0.95);
    sim.step(0.25, 0.95);
    expect(sim.head).toBeGreaterThanOrEqual(0);
    expect(sim.head).toBeLessThan(SAMPLES);
    expect(sim.samples.length).toBe(CHANNELS * SAMPLES);
    expect(Math.max(...sim.samples)).toBeLessThanOrEqual(1);
    expect(Math.min(...sim.samples)).toBeGreaterThanOrEqual(-1);
  });

  it('latches an alarm for a while and then clears it', () => {
    const sim = new TelemetrySimulator();
    // The EEG artifact happens at t % 9 < 0.12; step to just before and through it with a low threshold.
    for (let i = 0; i < 40; i++) sim.step(0.25, 0.95); // 10 s: artifact at t=9..9.12 has happened
    const loud = new TelemetrySimulator();
    for (let i = 0; i < 4; i++) loud.step(0.25, 0.1); // threshold below any signal level
    expect(loud.alarms().some(Boolean)).toBe(true);
    for (let i = 0; i < 8; i++) loud.step(0.25, 2); // nothing exceeds 2; the hold expires (2 s > 1.5 s)
    expect(loud.alarms().some(Boolean)).toBe(false);
  });
});

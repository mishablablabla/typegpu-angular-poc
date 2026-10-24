// Measurement harness: the SAME signal input mirrored two ways.
// A = `{ from }` (sampled per frame), B = `effect(() => uniform.write(...))`.
// `?demo=sync` exposes `window.__sync` so a browser session can measure when each value reaches a uniform.
import { Component, effect, input, signal } from '@angular/core';
import { d } from 'typegpu';
import { TgpuReady, injectFrame, injectUniform } from '@typegpu-poc/angular';

interface SyncEvent {
  kind: 'frame' | 'writeA' | 'writeB' | 'trigger';
  frame: number;
  value?: number;
}
export interface SyncProbe {
  events: SyncEvent[];
  frame: number;
  setSignal(value: number): void;
}

@Component({ selector: 'app-sync-case', template: '' })
export class SyncCase {
  readonly value = input.required<number>();

  constructor() {
    const log = (globalThis as unknown as { __sync: SyncProbe }).__sync;
    const a = injectUniform(d.f32, { from: this.value });
    const b = injectUniform(d.f32);
    const spy = (kind: 'writeA' | 'writeB', target: { write(v: number): void }) => {
      const write = target.write.bind(target);
      target.write = (v: number) => {
        log.events.push({ kind, frame: log.frame, value: v });
        write(v);
      };
    };
    spy('writeA', a);
    spy('writeB', b);
    effect(() => b.write(this.value()));
    injectFrame(() => {
      log.frame++;
      log.events.push({ kind: 'frame', frame: log.frame });
    });
  }
}

@Component({
  selector: 'app-sync-host',
  imports: [SyncCase, TgpuReady],
  template: `
    <input id="sync-slider" type="range" min="0" max="1000" [value]="value()" (input)="value.set(+$any($event.target).value)" />
    <app-sync-case *tgpuReady [value]="value()" />
  `,
})
export class SyncHost {
  readonly value = signal(0);
  constructor() {
    const probe: SyncProbe = {
      events: [],
      frame: 0,
      setSignal: (v) => {
        probe.events.push({ kind: 'trigger', frame: probe.frame, value: v });
        this.value.set(v);
      },
    };
    (globalThis as unknown as { __sync: SyncProbe }).__sync = probe;
  }
}

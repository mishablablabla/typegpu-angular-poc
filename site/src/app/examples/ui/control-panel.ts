import { Component, ElementRef, input, output, viewChild } from '@angular/core';
import type { WritableSignal } from '@angular/core';
import type { ControlSpec, ExampleParams } from '../example.model';
import { FpsCounter } from './fps-counter';

/** The "Control panel" of the TypeGPU examples page: one row per parameter, edited through the example's signals. */
@Component({
  selector: 'app-control-panel',
  imports: [FpsCounter],
  template: `
    <section class="panel" aria-label="Control panel">
      <div class="head">
        <h2>Control panel</h2>
        @if (fullscreen()) {
          <button type="button" class="button small" (click)="hide.emit()" aria-label="Hide controls">Hide</button>
        }
      </div>
      <div class="rows">
        <button type="button" class="button wide" #toggle (click)="fullscreenToggle.emit()">{{ fullscreen() ? 'Exit fullscreen' : 'Open fullscreen' }}</button>
        @for (control of controls(); track control.key) {
          @switch (control.kind) {
            @case ('slider') {
              <label class="label" [for]="'c-' + control.key">{{ control.label }}</label>
              <div class="slider" [style.--fill]="fill(control) + '%'">
                <input
                  #range
                  type="range"
                  [id]="'c-' + control.key"
                  [min]="control.min"
                  [max]="control.max"
                  [step]="control.step"
                  [value]="number(control.key)()"
                  (input)="number(control.key).set(range.valueAsNumber)"
                />
                <span class="value">{{ number(control.key)() }}</span>
              </div>
            }
            @case ('select') {
              <label class="label" [for]="'c-' + control.key">{{ control.label }}</label>
              <select #choice class="select" [id]="'c-' + control.key" [value]="text(control.key)()" (change)="text(control.key).set(choice.value)">
                @for (option of control.options; track option) {
                  <option [value]="option" [selected]="option === text(control.key)()">{{ option }}</option>
                }
              </select>
            }
            @case ('toggle') {
              <label class="label" [for]="'c-' + control.key">{{ control.label }}</label>
              <label class="toggle">
                <input #check type="checkbox" class="sr-only" [id]="'c-' + control.key" [checked]="flag(control.key)()" (change)="flag(control.key).set(check.checked)" />
                <span class="knob"></span>
              </label>
            }
            @case ('button') {
              <button type="button" class="button wide" (click)="press(control.key)">{{ control.label }}</button>
            }
          }
        }
      </div>
      <div class="foot"><app-fps-counter /></div>
    </section>
  `,
  styles: `
    :host { display: block; min-height: 0; }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      height: 100%;
      min-height: 0;
      background: var(--ex-panel);
      border: 1px solid var(--ex-border);
      color: var(--sl-color-text);
    }
    :host-context([data-theme='light']) .panel { color: var(--ex-title); }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 1rem 1rem 0; }
    h2 { margin: 0; font-size: 1.25rem; font-weight: 500; line-height: 1.3; color: var(--ex-title); }
    .rows {
      display: grid;
      grid-template-columns: minmax(0, 0.3fr) minmax(0, 0.7fr);
      align-content: start;
      align-items: start;
      gap: 0.75rem;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 0.25rem 1rem 0.5rem;
    }
    .label { align-self: center; font-size: 0.875rem; line-height: 1.25; color: var(--ex-title); }
    .wide { grid-column: span 2; }
    .button {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.625rem 1.25rem;
      border: 1px solid var(--ex-border);
      background: var(--ex-button);
      color: var(--ex-button-text);
      font-size: 0.875rem;
      cursor: pointer;
      transition: background-color 150ms, border-color 150ms, color 150ms;
    }
    .button:hover { border-color: var(--accent-200); background: var(--ex-button-hover); }
    :host-context([data-theme='light']) .button:hover { border-color: var(--accent-600); }
    .button.small { padding: 0.25rem 0.75rem; }
    .slider {
      position: relative;
      height: 1.75rem;
      overflow: hidden;
      border-radius: 6px;
      background: linear-gradient(to right, var(--gradient-purple), var(--gradient-blue)) 0 0 / var(--fill) 100% no-repeat, var(--ex-track);
    }
    .slider input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      opacity: 0;
      cursor: ew-resize;
      touch-action: none;
    }
    .value { position: absolute; inset: 0; display: grid; place-items: center; font-size: 0.75rem; pointer-events: none; color: var(--ex-title); }
    .slider:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .select {
      height: 1.75rem;
      width: 100%;
      padding: 0 0.6rem;
      border: 1px solid var(--ex-border);
      border-radius: 6px;
      background: var(--ex-field);
      color: var(--ex-title);
      font-size: 0.875rem;
    }
    .select:hover { border-color: var(--sl-color-gray-3); }
    .toggle { display: grid; justify-items: end; align-items: center; height: 1.75rem; cursor: pointer; }
    .knob {
      position: relative;
      width: 2.75rem;
      height: 1.5rem;
      border-radius: 9999px;
      background: var(--ex-track);
      transition: background 150ms;
    }
    .knob::after {
      content: '';
      position: absolute;
      top: 2px;
      inset-inline-start: 2px;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 9999px;
      background: var(--sl-color-gray-3);
      transition: transform 150ms, background 150ms;
    }
    .toggle:has(input:checked) .knob { background: linear-gradient(135deg, var(--gradient-purple), var(--gradient-blue)); }
    .toggle:has(input:checked) .knob::after { transform: translateX(1.25rem); background: #fff; }
    .toggle:has(input:focus-visible) .knob { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
    .foot { padding: 0 1rem 1rem; }
  `,
})
export class ControlPanel {
  readonly controls = input.required<readonly ControlSpec[]>();
  readonly params = input.required<ExampleParams>();
  readonly fullscreen = input(false);
  readonly fullscreenToggle = output<void>();
  readonly hide = output<void>();
  private readonly toggle = viewChild.required<ElementRef<HTMLButtonElement>>('toggle');

  /** The fullscreen button is the one control that is always there: focus returns to it when fullscreen ends. */
  focusToggle(): void {
    this.toggle().nativeElement.focus();
  }

  protected number(key: string): WritableSignal<number> {
    return this.params()[key] as WritableSignal<number>;
  }

  protected text(key: string): WritableSignal<string> {
    return this.params()[key] as WritableSignal<string>;
  }

  protected flag(key: string): WritableSignal<boolean> {
    return this.params()[key] as WritableSignal<boolean>;
  }

  protected fill(control: Extract<ControlSpec, { kind: 'slider' }>): number {
    return ((this.number(control.key)() - control.min) / (control.max - control.min)) * 100;
  }

  /** A button row only counts clicks; a scene reacts to the counter changing. */
  protected press(key: string): void {
    this.number(key).update((count) => count + 1);
  }
}

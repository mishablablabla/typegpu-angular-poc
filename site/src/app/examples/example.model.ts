import type { Type, WritableSignal } from '@angular/core';

/** What a control panel row edits. Buttons count their clicks, so a scene can react to the change. */
export type ControlSpec =
  | { kind: 'slider'; key: string; label: string; min: number; max: number; step: number }
  | { kind: 'select'; key: string; label: string; options: readonly string[] }
  | { kind: 'toggle'; key: string; label: string }
  | { kind: 'button'; key: string; label: string };

export type ParamSignal = WritableSignal<number> | WritableSignal<string> | WritableSignal<boolean>;
export type ExampleParams = Record<string, ParamSignal>;

export type Variant = 'integration' | 'manual';

export interface SourceFile {
  /** Shown on the file tab, e.g. `life.integrated.ts`. */
  path: string;
  code: string;
  /** Identical in both implementations (application code, not GPU plumbing): shown, but not counted. */
  shared?: boolean;
}

/** An example scene is a component that draws with the parameters it is given. */
export interface ExampleScene<P extends ExampleParams> {
  readonly params: () => P;
}

export interface ExampleDefinition {
  /** The route segment: `/examples/<id>`. */
  id: string;
  /** The folder under `src/app/examples` with this example's files; used for the "Source on GitHub" link. */
  folder: string;
  title: string;
  description: string;
  tags: readonly string[];
  /** What the integration changes in this example, in one sentence (shown above the source). */
  highlights: readonly string[];
  thumbnail: string;
  /** A compact application with its own layout: the preview gets more room on narrow screens. */
  app?: boolean;
  /** The scene receives `setParam(key, value)` to edit a control from inside (e.g. picking a machine in a list). */
  setsParams?: boolean;
  createParams(): ExampleParams;
  controls: readonly ControlSpec[];
  /** The scene written with the integration, and the same scene written without it. */
  scenes: Record<Variant, Type<unknown>>;
  sources: Record<Variant, readonly SourceFile[]>;
}

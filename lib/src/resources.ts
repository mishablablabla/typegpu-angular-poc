import { DestroyRef, afterNextRender, effect, inject, untracked, type Signal } from '@angular/core';
import type {
  d,
  TgpuBuffer,
  TgpuMutable,
  TgpuReadonly,
  TgpuUniform,
  ValidateBufferSchema,
  ValidateStorageSchema,
  ValidateUniformSchema,
} from 'typegpu';
import { FrameLoop } from './frame';
import { boundToRoot } from './root-binding';
import { TypeGpu, injectRoot } from './type-gpu';

/** Options shared by the `inject*` resource functions. */
export interface ResourceOptions<TSchema extends d.AnyData> {
  /** Value written at creation. */
  initial?: d.InferInput<NoInfer<TSchema>>;
  /**
   * Mirror a signal into the resource. The signal is read once per animation frame, before
   * frame callbacks run, and written only when its value changed **by `Object.is`**.
   * It is never read at construction, and sampling starts after the owner's first render; a
   * required `input()` that still has no value is skipped until it has one.
   *
   * **Replace, don't mutate.** Pushing into an array or editing a property of an object that the
   * signal already holds is invisible here (same identity), so nothing is uploaded. Set a new
   * value (`signal.set([...items])`, `signal.update((v) => ({ ...v, x }))`; typed arrays and
   * vectors: a new instance) or write the buffer yourself. There is no deep comparison and no
   * proxy, by design. `Object.is` also means: `NaN` is equal to itself (no rewrite), and `-0` is
   * different from `0` (one harmless extra write).
   *
   * Cost and loop: while a `from` resource lives (and its GPU root is ready) the shared
   * animation loop keeps running, one `Object.is` per resource per frame, even when nothing
   * changes. It is deliberate: sampling happens before the frame callbacks of the same tick, so a
   * value set before the frame is always written in that frame; waking the loop from an `effect`
   * would add an ordering question (docs/DECISIONS.md D4; the earlier "late in 15 of 30 trials"
   * measurement could not be reproduced).
   * Without `from` resources and active frame callbacks the loop requests no frames at all.
   *
   * If a write throws (for example the value does not fit the schema) the error goes to
   * `ErrorHandler` once and this resource stops mirroring until its owner is recreated; other
   * resources and frame callbacks keep running.
   */
  from?: Signal<d.InferInput<NoInfer<TSchema>>>;
}

interface Writable<TValue> {
  write(value: TValue): void;
}

/** Wires `from` sampling and cleanup for any buffer-backed resource. */
function own<TResource extends Writable<TValue>, TValue>(
  resource: TResource,
  destroy: () => void,
  from: Signal<TValue> | undefined,
): TResource {
  const destroyRef = inject(DestroyRef);
  try {
    destroyRef.onDestroy(destroy);
  } catch (error) {
    // The owner is already destroyed (e.g. `runInInjectionContext` on the injector of a destroyed
    // component): Angular refuses the cleanup, so nobody would ever release the buffer made just before.
    destroy();
    throw error;
  }

  if (from) {
    const gpu = inject(TypeGpu);
    const loop = inject(FrameLoop);
    const NOT_WRITTEN = Symbol('not written');
    let last: TValue | typeof NOT_WRITTEN = NOT_WRITTEN;
    const ready = boundToRoot(gpu);
    let remove: (() => void) | undefined;
    destroyRef.onDestroy(() => remove?.());
    // The shared loop idles while the GPU is not ready; wake it when it is again.
    effect(() => {
      if (ready()) loop.wake();
    });
    // Sampling starts after the owner's first render, when its signal inputs have values, and
    // only while the GPU is ready (a lost device's buffers are never written).
    afterNextRender(() => {
      remove = loop.addSampler(
        () => {
          let value: TValue;
          try {
            value = untracked(from);
          } catch (error) {
            // NG0950 (documented): a required input has no value yet. Try again next frame; anything else is a bug and propagates.
            if (error instanceof Error && error.message.startsWith('NG0950')) return;
            throw error;
          }
          if (!Object.is(value, last)) {
            last = value;
            resource.write(value);
          }
        },
        ready,
      );
    });
  }
  return resource;
}

/** A uniform owned by the surrounding injection context: destroyed with it. */
export function injectUniform<TSchema extends d.AnyWgslData>(
  schema: ValidateUniformSchema<TSchema>,
  options: ResourceOptions<TSchema> = {},
): TgpuUniform<TSchema> {
  const uniform = injectRoot().createUniform(schema, options.initial);
  return own(uniform, () => uniform.buffer.destroy(), options.from);
}

/** A storage buffer binding (read-write in shaders) owned by the surrounding injection context. */
export function injectMutable<TSchema extends d.AnyWgslData>(
  schema: ValidateStorageSchema<TSchema>,
  options: ResourceOptions<TSchema> = {},
): TgpuMutable<TSchema> {
  const mutable = injectRoot().createMutable(schema, options.initial);
  return own(mutable, () => mutable.buffer.destroy(), options.from);
}

/** A storage buffer binding (read-only in shaders) owned by the surrounding injection context. */
export function injectReadonly<TSchema extends d.AnyWgslData>(
  schema: ValidateStorageSchema<TSchema>,
  options: ResourceOptions<TSchema> = {},
): TgpuReadonly<TSchema> {
  const readonly = injectRoot().createReadonly(schema, options.initial);
  return own(readonly, () => readonly.buffer.destroy(), options.from);
}

/** A raw buffer owned by the surrounding injection context. Add usages with `.$usage()`. */
export function injectBuffer<TSchema extends d.AnyData>(
  schema: ValidateBufferSchema<TSchema>,
  options: ResourceOptions<TSchema> = {},
): TgpuBuffer<TSchema> {
  const buffer = injectRoot().createBuffer(schema, options.initial);
  return own(buffer, () => buffer.destroy(), options.from);
}

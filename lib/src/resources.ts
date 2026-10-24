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
   * frame callbacks run, and written only when its value (by `Object.is`) changed.
   * It is never read at construction, and sampling starts after the owner's first render; a
   * required `input()` that still has no value is skipped until it has one.
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
  destroyRef.onDestroy(destroy);

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

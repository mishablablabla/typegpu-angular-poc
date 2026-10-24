import { computed, type Signal } from '@angular/core';
import type { TgpuRoot } from 'typegpu';
import type { TypeGpu } from './type-gpu';

/**
 * `true` only while `gpu` is ready **with the root this was created under** (or, if created
 * before any root existed, the first root that becomes ready). After device loss it turns false
 * and stays false even when `retry()` produces a new root: whatever was created for the old
 * root (buffers, pipelines, the callback closing over them) must not be used with the new one.
 * Owners behind `*tgpuReady` are recreated for the new root instead.
 */
export function boundToRoot(gpu: TypeGpu): Signal<boolean> {
  let bound: TgpuRoot | undefined = gpu.root();
  return computed(() => {
    const root = gpu.root();
    if (!root) return false;
    bound ??= root;
    return root === bound;
  });
}

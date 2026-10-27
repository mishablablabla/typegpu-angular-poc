import { DestroyRef, inject, signal, type Signal } from '@angular/core';

const QUERY = '(prefers-reduced-motion: reduce)';

/** Is the user asking the system for less motion right now? (A one-off read: use `injectReducedMotion` for something that lives.) */
export const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia(QUERY).matches;

/**
 * A signal that follows the system setting while the injection context lives: the listener is removed when it is destroyed.
 * Call it in a constructor or field initializer.
 */
export function injectReducedMotion(): Signal<boolean> {
  const reduced = signal(prefersReducedMotion());
  if (typeof matchMedia === 'function') {
    const query = matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => reduced.set(event.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
  }
  return reduced.asReadonly();
}

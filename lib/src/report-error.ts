import type { ErrorHandler } from '@angular/core';

/**
 * Reports `error` through `handler`. A handler that throws itself must never take the library down
 * with it (it would stop the shared frame loop or leave a rejected promise nobody awaits), so its
 * failure is written to `console.error` together with the original error: never swallowed silently.
 * Internal.
 */
export function reportError(handler: ErrorHandler, error: unknown): void {
  try {
    handler.handleError(error);
  } catch (handlerError) {
    console.error(
      '[typegpu-angular] ErrorHandler.handleError threw while reporting an error. The library carries on.',
      { reported: error, thrownByHandler: handlerError },
    );
  }
}

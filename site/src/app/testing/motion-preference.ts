// A stand-in for the system's "reduce motion" setting that a test can flip while components run (jsdom has no `matchMedia`).
import { vi } from 'vitest';

export interface MotionPreference {
  /** The "prefers-reduced-motion" media query list. */
  readonly query: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  readonly listeners: Set<(event: MediaQueryListEvent) => void>;
  /** Changes the setting and tells every listener, like the browser does. */
  set(value: boolean): void;
}

/** Installs `matchMedia`; undo with `vi.unstubAllGlobals()`. */
export function installMotionPreference(initial: boolean): MotionPreference {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  let reduced = initial;
  const query = {
    get matches() {
      return reduced;
    },
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
  };
  const other = { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
  vi.stubGlobal('matchMedia', (text: string) => (text.includes('prefers-reduced-motion') ? query : other));
  return {
    query,
    listeners,
    set(value: boolean) {
      reduced = value;
      for (const listener of [...listeners]) listener({ matches: value } as MediaQueryListEvent);
    },
  };
}

// The console-noise gate: a spec fails when the code under test writes to `console.error` or `console.warn` and the spec did not
// say it expects that. Angular reports a lot through those two (a duplicated @for key, a failed binding, an unhandled error), so
// silence here means those problems were not hit. Installed for every spec by `src/test-setup.ts`.
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

const allowed: RegExp[] = [];

/** Declares that the running test expects console output matching `pattern` (it is swallowed). Reset after every test. */
export function allowConsole(pattern: RegExp): void {
  allowed.push(pattern);
}

const format = (args: unknown[]): string => args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' ');

/** Messages that were not allowed, and the sink for the ones that were. Exported for the gate's own spec. */
export function unexpectedMessages(messages: readonly string[], patterns: readonly RegExp[]): string[] {
  return messages.filter((message) => !patterns.some((pattern) => pattern.test(message)));
}

export function installConsoleGate(): void {
  let messages: string[] = [];
  let spies: MockInstance[] = [];

  beforeEach(() => {
    messages = [];
    allowed.length = 0;
    spies = (['error', 'warn'] as const).map((method) => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void messages.push(`console.${method}: ${format(args)}`)));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    const unexpected = unexpectedMessages(messages, allowed);
    allowed.length = 0;
    if (unexpected.length > 0) {
      throw new Error(`The test wrote to the console without declaring it (use allowConsole(/pattern/) if that is expected):\n${unexpected.map((message) => message.slice(0, 400)).join('\n')}`);
    }
  });
}

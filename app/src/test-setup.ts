// Global test setup (angular.json `test.options.setupFiles`): an unexpected `console.error` or `console.warn` fails the test.
//
// Angular and the library report real problems this way (NG0xxx warnings, an `ErrorHandler` that threw, a
// canvas without CSS size...), and they used to scroll past unnoticed. A test that expects a message says so by
// mocking the method itself, which is the natural way to assert on it anyway:
//
//   const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
//   ...
//   expect(warn).toHaveBeenCalledTimes(1);
//
// A mock that swallows the call also keeps it away from this guard; a spy that calls through does not.
import { afterEach, beforeEach } from 'vitest';

type Method = 'error' | 'warn';
const METHODS: Method[] = ['error', 'warn'];
const originals = {} as Record<Method, (...args: unknown[]) => void>;
let unexpected: string[] = [];

beforeEach(() => {
  unexpected = [];
  for (const method of METHODS) {
    originals[method] = console[method];
    console[method] = (...args: unknown[]) => {
      unexpected.push(`console.${method}(${args.map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg, errorsAsText))).join(' ')})`);
    };
  }
});

afterEach(() => {
  for (const method of METHODS) console[method] = originals[method];
  const messages = unexpected;
  unexpected = [];
  if (messages.length > 0) {
    throw new Error(
      `Unexpected console output during the test (mock console.error / console.warn with vi.spyOn(...).mockImplementation if it is expected):\n${messages.join('\n')}`,
    );
  }
});

function errorsAsText(_key: string, value: unknown): unknown {
  return value instanceof Error ? (value.stack ?? value.message) : value;
}

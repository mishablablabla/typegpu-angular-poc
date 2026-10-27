import { describe, expect, it } from 'vitest';
import { allowConsole, unexpectedMessages } from './console-gate';

describe('the console gate', () => {
  it('lets through only what a test declared', () => {
    const messages = ['console.error: NG0955: duplicated keys', 'console.warn: something else'];
    expect(unexpectedMessages(messages, [])).toEqual(messages);
    expect(unexpectedMessages(messages, [/NG0955/])).toEqual(['console.warn: something else']);
    expect(unexpectedMessages(messages, [/NG0955/, /something/])).toEqual([]);
  });

  it('swallows declared output so the test passes', () => {
    allowConsole(/expected noise/);
    console.warn('this is expected noise');
    console.error('an expected noise too');
  });
});

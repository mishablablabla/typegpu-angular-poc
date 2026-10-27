import { describe, expect, it } from 'vitest';
import type { DocBlock } from '../doc-blocks';
import { ANGULAR_DOC } from './angular-docs';

/** Every piece of prose and code of the page as one string (tags included: the checks look for words). */
const textOf = (block: DocBlock): string => {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'html':
      return block.html;
    case 'list':
      return block.items.join('\n');
    case 'code':
      return block.code;
    case 'tabs':
      return block.tabs.map((tab) => tab.code).join('\n');
    case 'callout':
      return `${block.title ?? ''} ${block.html}`;
    case 'table':
      return [...block.head, ...block.rows.flat()].join('\n');
  }
};
const PAGE = ANGULAR_DOC.map(textOf).join('\n');
const PLAIN = PAGE.replace(/<\/?(strong|em)>/g, '');
const headings = ANGULAR_DOC.flatMap((block) => (block.kind === 'heading' ? [block.id] : []));

// The page states what the integration is and what was verified where. These checks keep the claims that must not drift
// (status, modes, ranges) next to the facts in lib/README.md, and keep removed claims removed.
describe('the typegpu-angular page keeps its claims honest', () => {
  it('says it is experimental and never calls it production-ready without a negation', () => {
    expect(PLAIN).toMatch(/experimental proof of concept, not production-ready/);
    for (const [, before] of PLAIN.matchAll(/(.{0,25})production-ready/gi)) expect(before, 'a claim of production readiness').toMatch(/not |No |never /i);
  });

  it('describes both shader modes and what ng add writes', () => {
    for (const id of ['shader-modes', 'pipeline', 'prebuild', 'limitations', 'verified']) expect(headings).toContain(id);
    for (const text of ['--shaders prebuild', '@shaders/', 'shaders-dist', 'extract-i18n', 'Web Workers', '["module","production"]', 'relative']) expect(PAGE).toContain(text);
  });

  it('states the declared Angular and Node ranges and the evidence per platform', () => {
    expect(PAGE).toContain('Angular 20, 21 or 22');
    expect(PAGE).toContain('^20.19.0 || ^22.12.0 || &gt;=24.0.0');
    for (const text of ['Linux', 'Windows', 'by hand on macOS', 'Safari', 'Firefox']) expect(PAGE).toContain(text);
  });

  it('does not repeat claims that are outdated', () => {
    expect(PAGE).not.toMatch(/tested with Node 24\.21/);
    expect(PAGE).not.toMatch(/on macOS \(arm64\) with Node 24\.21\.0/);
    expect(PAGE).not.toMatch(/two copies/i);
  });

  it('marks the line counts as indicative and not re-measured', () => {
    expect(PAGE).toMatch(/indicative, not a benchmark/);
    expect(PAGE).toMatch(/not re-measured/);
  });
});

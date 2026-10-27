import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Highlighter, plain } from '../../shared/highlighter';
import type { Variant } from '../example.model';
import { EXAMPLES } from '../registry';
import { countCodeLines, SourceViewer } from './source-viewer';

describe('countCodeLines', () => {
  it('skips blank lines and comments', () => {
    expect(countCodeLines('// a\n\nconst a = 1;\n/** doc */\n  \nconst b = 2;\n')).toBe(2);
  });

  it('skips multi-line block comments, however they are written', () => {
    expect(countCodeLines('/**\n * Docs\n * more\n */\nconst a = 1;\n/* x\n y */\nconst b = 2;')).toBe(2);
  });

  it('counts a line of code with a trailing comment, and indented code', () => {
    expect(countCodeLines('  const a = 1; // why\n\tconst b = 2;')).toBe(2);
  });

  it('counts nothing for an empty or comment-only file', () => {
    expect(countCodeLines('')).toBe(0);
    expect(countCodeLines('// one\n// two\n/* three */')).toBe(0);
  });

  it('does not treat a string with slashes as a comment', () => {
    expect(countCodeLines("const url = 'https://example.com';")).toBe(1);
  });
});

afterEach(() => TestBed.resetTestingModule());

function create(exampleId: string, variant: Variant, file?: string): ComponentFixture<SourceViewer> {
  TestBed.configureTestingModule({ providers: [{ provide: Highlighter, useValue: { html: (code: string) => Promise.resolve(plain(code)) } }] });
  const example = EXAMPLES.find((candidate) => candidate.id === exampleId)!;
  const fixture = TestBed.createComponent(SourceViewer);
  fixture.componentRef.setInput('sources', example.sources);
  fixture.componentRef.setInput('variant', variant);
  fixture.componentRef.setInput('file', file);
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ComponentFixture<SourceViewer>) => fixture.nativeElement as HTMLElement;
const tabs = (fixture: ComponentFixture<SourceViewer>) => [...el(fixture).querySelectorAll<HTMLButtonElement>('[role=tab]')];
const selected = (fixture: ComponentFixture<SourceViewer>) => tabs(fixture).filter((tab) => tab.getAttribute('aria-selected') === 'true');

describe('SourceViewer line counts', () => {
  it.each(EXAMPLES.map((example) => [example.id] as const))('%s: each version counts only its component file, not the shader, shared files or manual-gpu.ts', (id) => {
    const example = EXAMPLES.find((candidate) => candidate.id === id)!;
    const fixture = create(id, 'integration');
    const shown = [...el(fixture).querySelectorAll('.radio .count')].map((node) => node.textContent?.trim());
    const counted = (variant: Variant) => example.sources[variant].filter((file) => !file.path.endsWith('.gpu.ts') && !file.shared && file.path !== 'manual-gpu.ts');
    for (const variant of ['integration', 'manual'] as const) {
      // One file per version is counted, and it is the component (the first tab).
      expect(counted(variant).map((file) => file.path), variant).toEqual([example.sources[variant][0]!.path]);
    }
    expect(shown).toEqual([`${countCodeLines(counted('integration')[0]!.code)} lines`, `${countCodeLines(counted('manual')[0]!.code)} lines`]);
    // The root file is reported on its own.
    const root = example.sources.manual.find((file) => file.path === 'manual-gpu.ts')!;
    expect(el(fixture).querySelector('.note')!.textContent).toContain(`manual-gpu.ts (${countCodeLines(root.code)} lines`);
  });

  it('is honest about what the numbers mean', () => {
    const note = el(create('life', 'integration')).querySelector('.note')!.textContent!.replace(/\s+/g, ' ');
    expect(note).toMatch(/component file/);
    expect(note).toMatch(/Not counted:.*shader.*shared application files/);
    expect(note).toMatch(/manual-gpu\.ts \(\d+ lines/);
    expect(note).toMatch(/and the library itself/);
    expect(note).toMatch(/behave exactly like the integrated ones/);
    expect(note).toMatch(/dirty-checking caches.*stand in for from/);
    expect(note).toMatch(/commit\(\)/);
    expect(note).toMatch(/indicative, not as a measure/);
  });
});

describe('SourceViewer file selection', () => {
  it('shows the first file when none is requested', () => {
    const fixture = create('life', 'integration');
    expect(selected(fixture).map((tab) => tab.textContent?.trim())).toEqual(['life.integrated.ts']);
    expect(el(fixture).querySelector('.code')!.textContent).toContain('LifeScene');
  });

  it('shows the requested file, and falls back to the first one when this version does not have it', () => {
    expect(selected(create('life', 'manual', 'manual-gpu.ts')).map((tab) => tab.textContent?.trim())).toEqual(['manual-gpu.ts']);
    TestBed.resetTestingModule();
    expect(selected(create('life', 'integration', 'manual-gpu.ts')).map((tab) => tab.textContent?.trim())).toEqual(['life.integrated.ts']);
    TestBed.resetTestingModule();
    expect(selected(create('life', 'manual', 'nope.ts')).map((tab) => tab.textContent?.trim())).toEqual(['life.manual.ts']);
  });

  it('lists the files of the shown version only', () => {
    expect(tabs(create('life', 'manual')).map((tab) => tab.textContent?.trim())).toEqual(['life.manual.ts', 'life.gpu.ts', 'manual-gpu.ts']);
  });
});

describe('SourceViewer accessibility', () => {
  it('has a native radio group for the implementation: one name, one checked, labelled', () => {
    const fixture = create('life', 'manual');
    const group = el(fixture).querySelector('[role=radiogroup]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('impl-label');
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radios).toHaveLength(2);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    for (const radio of radios) expect(radio.closest('label')!.textContent).toMatch(/integration/i);
  });

  it('emits the variant when a radio is chosen', () => {
    const fixture = create('life', 'integration');
    const changes: Variant[] = [];
    fixture.componentInstance.variantChange.subscribe((variant) => changes.push(variant));
    const radios = el(fixture).querySelectorAll<HTMLInputElement>('input[type=radio]');
    radios[1]!.click();
    expect(changes).toEqual(['manual']);
  });

  it('has tabs with a roving tabindex, each tab controlling the one tabpanel that the selected tab labels', () => {
    const fixture = create('life', 'manual', 'life.gpu.ts');
    const list = tabs(fixture);
    expect(list.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(selected(fixture)).toHaveLength(1);
    const panel = el(fixture).querySelector<HTMLElement>('[role=tabpanel]')!;
    expect(panel).not.toBeNull();
    for (const tab of list) expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selected(fixture)[0]!.id);
    expect(new Set(list.map((tab) => tab.id)).size).toBe(list.length);
    expect(panel.tabIndex).toBe(0); // a scrollable region that keyboard users can reach
    expect(el(fixture).querySelector('[role=tablist]')!.getAttribute('aria-label')).toBeTruthy();
  });

  it('moves between the tabs with the arrow keys, Home and End, and focuses the tab it selects', async () => {
    const fixture = create('life', 'manual');
    const chosen: string[] = [];
    fixture.componentInstance.fileChange.subscribe((path) => chosen.push(path));
    const list = el(fixture).querySelector('[role=tablist]')!;
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      tabs(fixture)[0]!.dispatchEvent(event);
      return event;
    };
    expect(list).not.toBeNull();
    expect(press('ArrowRight').defaultPrevented).toBe(true);
    expect(press('ArrowLeft').defaultPrevented).toBe(true); // wraps to the last
    expect(press('End').defaultPrevented).toBe(true);
    expect(press('Home').defaultPrevented).toBe(true);
    expect(press('a').defaultPrevented).toBe(false);
    expect(chosen).toEqual(['life.gpu.ts', 'manual-gpu.ts', 'manual-gpu.ts', 'life.manual.ts']);
    await fixture.whenStable();
    expect(document.activeElement).toBe(tabs(fixture)[0]);
  });

  it('announces a copy through a status region, not by renaming the button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    try {
      const fixture = create('life', 'integration');
      const status = el(fixture).querySelector('[role=status]')!;
      const button = el(fixture).querySelector<HTMLButtonElement>('button.copy')!;
      expect(status.textContent?.trim()).toBe('');
      const label = button.getAttribute('aria-label');
      button.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(writeText).toHaveBeenCalledOnce();
      expect(status.textContent).toContain('Copied');
      expect(button.getAttribute('aria-label')).toBe(label);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

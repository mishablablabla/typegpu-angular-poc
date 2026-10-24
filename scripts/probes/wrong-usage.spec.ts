// Probe for the error codes the README's Troubleshooting table names. Run by scripts/verify-diagnostics.sh
// inside a configured app; it prints what Angular and the library really say.
import { Component, ErrorHandler, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TgpuCanvas, TypeGpu, injectFrame, injectRoot, injectUniform, provideTypeGpu } from '@typegpu-poc/angular';
import { d } from 'typegpu';

const seen: string[] = [];
const note = (label: string, text: string) => {
  seen.push(`${label}: ${text.split('\n')[0]}`);
  console.log(`[probe] ${label}: ${text.split('\n')[0].slice(0, 160)}`);
};

describe('wrong usage', () => {
  it('NG0203: injectFrame outside an injection context', () => {
    let message = '';
    try { injectFrame(() => undefined); } catch (e) { message = (e as Error).message; }
    note('injectFrame outside context', message);
    expect(message).toContain('NG0203');
  });

  it('injectUniform while the GPU is not ready names the state', () => {
    TestBed.configureTestingModule({});
    let message = '';
    try { TestBed.runInInjectionContext(() => injectUniform(d.f32)); } catch (e) { message = (e as Error).message; }
    note('injectUniform not ready', message);
    expect(message).toMatch(/injectRoot\(\) was called while the GPU is "idle"/);
  });

  it('NG0303: *tgpuReady without TgpuReady in imports', () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')));
    @Component({ selector: 'app-child', template: '' })
    class Child {}
    // the shape of the README quick start: the gate sits on a component element
    @Component({ selector: 'app-no-ready-import', imports: [Child], template: `<app-child *tgpuReady="let root; else fb" /><ng-template #fb></ng-template>` })
    class NoReadyImport {}
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: () => new Promise(() => undefined) })] });
    // TestBed reports unknown properties as a thrown error; a running app only logs it with console.error.
    try { TestBed.createComponent(NoReadyImport).detectChanges(); } catch (e) { errors.push((e as Error).message); }
    spy.mockRestore();
    const hit = errors.find((e) => e.includes('NG0303')) ?? `(no NG0303; got: ${errors.join(' | ') || 'nothing'})`;
    note('missing TgpuReady import (runtime)', hit);
    expect(hit).toMatch(/NG0303: Can't bind to 'tgpuReadyElse'/);
  });

  it('NG0951: viewChild.required(TgpuCanvas) without TgpuCanvas in imports', () => {
    @Component({ selector: 'app-no-canvas-import', template: `<canvas tgpuCanvas></canvas>` })
    class NoCanvasImport { readonly canvas = viewChild.required(TgpuCanvas); }
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(NoCanvasImport);
    fixture.detectChanges();
    let message = '';
    try { fixture.componentInstance.canvas(); } catch (e) { message = (e as Error).message; }
    note('missing TgpuCanvas import', message);
    expect(message).toContain('NG0951');
  });

  it('the state of a failed init is on the service (what the README says to read)', async () => {
    const boom = new Error('probe failure');
    TestBed.configureTestingModule({ providers: [provideTypeGpu({ createRoot: () => Promise.reject(boom) }), { provide: ErrorHandler, useValue: { handleError: () => undefined } }] });
    const gpu = TestBed.inject(TypeGpu);
    TestBed.tick();
    await new Promise((r) => setTimeout(r));
    const state = gpu.state();
    expect(state.status).toBe('failed');
    expect(state.status === 'failed' && state.error).toBe(boom);
    TestBed.runInInjectionContext(() => { try { injectRoot(); } catch (e) { note('injectRoot when failed', (e as Error).message); } });
  });
});

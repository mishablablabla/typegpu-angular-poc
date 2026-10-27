# `@typegpu/react` vs this Angular integration

Source read: `packages/typegpu-react/src/**` at 0.12.2 in the TypeGPU monorepo (read-only), its tests and docs page (`apps/typegpu-docs/.../ecosystem/typegpu-react/index.mdx`). Public API = `src/shared-exports.ts` + `src/browser/index.ts`; `useRender` exists internally but is **not exported** (it has an open TODO and reads `navigator.gpu` at module load); the `react-native/` branch (worklets) is out of scope here.

## API map

| React API | What it actually does | Same problem in Angular? | Angular equivalent | Semantics |
|---|---|---|---|---|
| `<Root>` / `useRoot` / `useRootOrError` / `useRootWithStatus` | One `TgpuRoot` per provider via context; `tgpu.init()` runs on first read; React Suspense (`use`) waits for it; `useBailOnServer` throws on the server so a Suspense/`ClientOnly` boundary shows a fallback. A provider unmounting never destroys the root (Dawn crash). | Yes (shared async root, no GPU on server) | `TypeGpu` service (`providedIn: 'root'`) with one `state` signal; `*tgpuReady` gate; `injectRoot()` | **Different.** Async state is a signal, not a thrown promise; server stays `idle` instead of throwing; same non-destroy policy; adds `unsupported` / `failed` / `lost` as states and `retry()` |
| `useUniform` / `useBuffer` / `useMutable` / `useReadonly` | `useState` holds the resource; `useStableSchema` (`schemasEqualStructurally`) + root change detection recreate it **during render** (destroying the old one); cleanup is deferred 200 ms (`useDeferredCleanup`) because StrictMode mounts effects twice | Cleanup yes; render-phase recreation and StrictMode no | `injectUniform` / `injectBuffer` / `injectMutable` / `injectReadonly` | **Different.** Create once, destroy on `DestroyRef` immediately (no timer); schema is fixed per owner (recreate the owner to change it) |
| `useMirroredUniform` | Writes the new value **during render** when it differs from the previous one; returns an object with `$` and a private `$buffer` symbol so `useBindGroup` can unwrap it | Mirroring React state into a uniform: yes | `injectUniform(schema, { from: signal })` | **Different.** Sampled once per frame before frame callbacks, `Object.is` gated; returns the plain `TgpuUniform` (works in `.$uses`, bind groups, everything) so no wrapper type or symbol exists |
| `useFrame` | One `requestAnimationFrame` loop **per hook call**; latest-callback ref; `{deltaSeconds, elapsedSeconds}` allocated per frame; a throwing callback is not caught (rAF is already re-queued) | Yes | `injectFrame(cb)` | **Different.** One shared loop; per-callback timing; reused info object (no per-frame allocation); outside `NgZone`; throwing callback is stopped and reported through `ErrorHandler`; `pause()/resume()` |
| `useConfigureContext` | Ref callback that calls `root.configureContext`, `ResizeObserver` (`devicePixelContentBoxSize`, DPR fallback), `onResize`, `autoResize`; careful handling of "canvas resized externally" (`lastNotified`); reconfigures on root change | Yes, the hardest part | `canvas[tgpuCanvas]` directive | **Same behaviours, different shape.** Same resize math (device pixels, DPR fallback), same "compare with the real canvas size" rule; `context` and `size` are signals; reconfigures on options or root change; works on the server as a plain canvas |
| `useBindGroup` | Rebuilds a bind group on every render (TODO #2461), unwrapping `$buffer` | Yes, but cheaper | none: call `root.createBindGroup` in a `computed` or once | **No equivalent.** Bind groups hold no GPU memory needing explicit release, and Angular components do not re-run |
| `useStableEvent` | Latest-callback with stable identity | React-specific | none | **Not needed** (closures are not stale in Angular) |
| `ClientOnly` | Mounts children after hydration, `Suspense` boundary | Server/browser split: yes | `*tgpuReady` (also the async boundary) | **Different.** The gate renders the same fallback on server and first client render, so hydration matches |
| `useRender` (internal) | Not public | n/a | none | not ported |

## Assumptions in the React code that must not be copied

- Render-phase side effects (writing uniforms, recreating buffers) and the 200 ms deferred cleanup exist because of render replays and StrictMode double effects. Angular components are constructed once per instance.
- `useFrame` per hook means N consumers = N loops.
- No handling of `device.lost` anywhere (neither in `@typegpu/react` nor in `typegpu` 0.12.8 source: grep for `lost` finds only comments).
- Errors from `tgpu.init` are only visible by throwing into an error boundary.

## Concrete differences that can be shown (not claims of general superiority)

| Topic | React package | This PoC | Evidence |
|---|---|---|---|
| Animation loops for N consumers | N | 1 | independent experiment (rAF registrations constant for 1, 5 and 20 consumers); `frame.spec.ts` ("shares one loop") cannot detect N loops |
| Signal/prop -> uniform timing | write on render (before the frame that follows) | value visible to the same frame's callbacks | `resources.spec.ts`; React behaviour not re-measured here |
| Missing WebGPU | error thrown to a boundary | `unsupported` state, no error | `type-gpu.spec.ts`, real-browser run (`nogpu.html`) |
| Device loss | not handled | `lost` state, content torn down, manual `retry()` | `ready.spec.ts` (fake), real device `destroy()` in browser |
| Init after unmount | root kept, not destroyed | late root released (no surfaces exist) | `type-gpu.spec.ts` |
| Per-frame allocation | new `{delta, elapsed}` each frame | reused object | `frame.spec.ts` |
| Testing | `typegpu-testing-utility` (monorepo-private) | `createFakeTypeGpu()` shipped in the package | `lib/testing` |

Not claimed: bundle size, performance under load, React Native support (none here), or that frame-sampled mirroring is faster than effects (it is more predictable; see D4 in DECISIONS.md).

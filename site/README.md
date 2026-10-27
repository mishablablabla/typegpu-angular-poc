# Showcase site

> **Status.** The site is part of an **experimental proof of concept**, not production-ready and not published; the library it shows is not on npm.
> `.github/workflows/site.yml` builds and tests it against the tarball packed from the same commit; publishing to GitHub Pages is manual (`DEPLOY.md`).
> Last built and tested locally against a tarball packed from the repository on 2026-10-27: 405 specs in 26 files,
> production build and the shader bundle check green (117 `'use gpu'` directives, all transformed). Rendering was looked at in one WebGPU
> Chromium only (macOS); Safari and Firefox are unverified. The line counts and measurements the site cites come from earlier rounds and
> were **not re-measured** in the latest round.

Documentation and live examples for the Angular integration (`@typegpu/angular`, published here as the local
package `@typegpu-poc/angular`; neither name is on npm), styled after the TypeGPU docs. It is an Angular application: no other framework,
no CSS framework.

- **Docs**: `/docs/ecosystem/typegpu-angular` (installation with `ng add`, first component, the two shader modes (plugin by default,
  prebuild experimental), resources, canvas and frames, init and errors, testing, compatibility with what is verified where, limitations).
  It mirrors `lib/README.md`; if the two disagree, the README of the library wins. The sidebar shows the TypeGPU navigation; only this page is implemented.
- **Examples**: `/examples`. Every example runs for real and has a source viewer with two modes, **With integration**
  and **Without integration**. Both are working components with the same inputs and the same visible behavior; the
  viewer shows the actual files (imported with `?source`, so the text is never a copy). The mode and file are kept in
  the URL (`?variant=manual&file=...`).

| Example | What it shows |
| --- | --- |
| Matrix mirror | external texture (camera or a built-in demo scene), an on-GPU person-segmentation network (MediaPipe selfie segmenter as compute shaders), pointer ripples; starts on the demo, the camera only after the user picks it |
| Neural flow | a procedural brain with neurons and fibres simulated and drawn on the GPU |
| Autoscaler | a map of cloud services with requests as GPU particles and scaling policies |
| THE CORE | fusion-reactor plasma: compute particles and field lines splatted with atomics, pointer disturbances, camera |
| Game of Life | compute pipelines over a pair of storage buffers |
| Risk field | a ray-marched value-at-risk landscape in one fragment shader |

Each example page also has an **Open fullscreen** mode. It is only a layout state of the same page (the scene, its canvas and its
state stay the same; Escape or the toggle leaves it, and leaving the page always does).

The "Source on GitHub" links are built from `REPOSITORY_URL` in `src/app/examples/repository.ts`
(`https://github.com/mishablablabla/typegpu-angular-poc`) and the `folder` of each example definition; they point at
`.../tree/main/site/src/app/examples/<folder>`: they work once `site/` is on the `main` branch of that repository (until then, on the branch of the pull request that adds it, they 404). The tests check that every link names a
real folder of `src/app/examples`, so they are right once the folder is there.

The viewer's line counts (from earlier rounds, not re-measured in the latest one) cover the scene file of each version only: about 28% fewer lines for the integrated version on average (24.8-31.6%), roughly 14-25% under lazier or normalised counting, about 10% across everything an example ships (shader, model and panel files). They depend on formatting and are indicative, not a benchmark; the manual versions reproduce the integration's behavior (change-detection caches, cleanup, the frame loop).

All data in the examples is synthetic and generated locally.

## Run it

The site depends on the **packed library** next to it, and the docs page also reads the component generator's templates from `../lib/schematics/` at build time. The library is **not** in `package.json` or in the lockfile (the same design as `app/`, `docs/DECISIONS.md` D11: a lockfile entry for a locally packed tarball can never match a rebuilt one): pack it fresh and add it with `--no-save`.

```bash
(cd ../lib && npm ci && npm run pack)                                  # creates ../lib/typegpu-poc-angular-0.0.1.tgz
npm ci                                                                 # third-party packages from the lockfile
npm install --no-save ../lib/typegpu-poc-angular-0.0.1.tgz             # the packed library, into node_modules only
npm start                                                              # http://localhost:4200
```

Repeat the `--no-save` line after every library change and after every `npm ci` or `npm install` (they remove the library again).

WebGPU is required to see the examples (recent Chrome or Edge; Safari and Firefox are not verified). Without it each example shows a
recoverable "not available" state instead of failing.

Deploying to GitHub Pages: `DEPLOY.md` (base href `/typegpu-angular-poc/`, the `404.html` fallback; the workflow builds on every change and publishes only when started manually with `deploy: true`, after the owner enabled Pages).

## Checks

```bash
npm test                # unit tests (405 in 26 files): simulators, registry, example lifecycles on a fake root, shader gate, URL state,
                        # fullscreen, search dialog, accessibility smoke tests (a console.error/warn fails a test unless it
                        # is declared with allowConsole()), and a guard for the claims of the docs page (status, modes, ranges)
npm run build           # production build
npm run check:shaders   # production build, then verifies the shader code in the bundle (must print "all transformed")
```

(`npm test` is `ng test`, which watches; add `-- --watch=false` for a single run. Set `NG_CLI_ANALYTICS=false` in scripts.)

The **shader gate** (`examples.shaders.spec.ts`) mounts every example in both implementations on TypeGPU's real root over a
recording device, resolves every pipeline to WGSL, checks its structure and that both implementations produce the same WGSL. It does
not validate the WGSL with a WebGPU compiler (none is available in the test run); a browser or Dawn run does that. The recording device is the trick that lets the real TypeGPU root build pipelines in Node (`tgpu.resolve` then yields WGSL), so shaders can be gated in a unit test without a GPU.

The site itself is built in the plugin mode, as `ng add` leaves it: `angular.json` also carries the resolve `conditions` that `ng add` writes into the
`production` and `development` configurations.

## Layout

- `src/app/docs`: sidebar, page frame, content blocks and the Angular page.
- `src/app/examples`: gallery, example page, control panel, source viewer, one folder per example
  (`*.gpu.ts` shader, `*.integrated.ts`, `*.manual.ts`, plus shared model/panel files marked `shared` in the viewer).
- `src/app/examples/manual/manual-gpu.ts`: the GPU root written by hand for the "without integration" versions.
- `tools/source-text.esbuild.mjs`: esbuild plugin behind `import code from './file.ts?source'`.

# Deploying the showcase to GitHub Pages

`.github/workflows/site.yml` builds and tests the site on every pull request and push that touches `site/` or `lib/`. **Publishing is manual and switched off by default:** run the workflow with `workflow_dispatch` and `deploy: true` after the repository owner has enabled Pages (Settings > Pages > Source: **GitHub Actions**). The URL will be `https://mishablablabla.github.io/typegpu-angular-poc/`. Nothing publishes by itself, and nothing in the workflow changes repository settings.

## What the build needs (all done by the workflow)

| Need | Value |
| --- | --- |
| Base href | `/typegpu-angular-poc/` (a project page is served below the repository name; `src/index.html` has `<base href="/">` for `ng serve`) |
| Build | `npx ng build --configuration production --base-href /typegpu-angular-poc/` (from `site/`); output `dist/site/browser` |
| SPA fallback | `index.html` is copied to `404.html`: Pages answers unknown paths (`/typegpu-angular-poc/examples/life` opened directly or reloaded) with `404.html` and status 404, and the Angular router renders the route. An empty `.nojekyll` is added as a precaution |
| The library | the tarball packed from the same commit: `site/package.json` does **not** list the library and neither does the lockfile (`docs/DECISIONS.md` D11): `npm ci`, then `npm install --no-save ../lib/typegpu-poc-angular-*.tgz`. The docs page also reads the generator templates from `../lib/schematics/` at build time, so the job needs the whole repository checkout |
| Node | 24 |

Locally: `(cd lib && npm ci && npm run pack) && cd site && npm ci && npm install --no-save ../lib/typegpu-poc-angular-*.tgz && npx ng test --watch=false`. A later plain `npm install`/`npm ci` in `site/` removes the library again.

Assets (`brand/`, `thumbnails/`, `assets/selfie-segmentation/...`) are referenced relatively and the segmentation model is fetched against `document.baseURI`, so they follow the base href. A static server that maps the prefix and serves `404.html` for unknown paths reproduced the deep links locally (`/docs/ecosystem/typegpu-angular`, `/examples`, `/examples/life`).

## What to say on the page about WebGPU

The examples need WebGPU. Verified with Chromium-based browsers (Chrome, Edge); **Safari and Firefox were not verified**, and a machine
without a usable GPU shows each example's "not available" state instead of failing (the examples are written that way, the docs page
describes the states). Suggested wording for the gallery and the example pages, where WebGPU is needed:

> The examples run on your GPU through WebGPU. They were checked in Chrome and Edge. Safari and Firefox have not been tested; if
> your browser has no WebGPU you will see a message instead of the scene. The data is synthetic and generated in your browser.

The site does not show this notice today; adding it is a small change in `src/app/examples/example-gallery.ts` (and the example page).

## Checked locally (2026-10-27, macOS arm64, Node 24.21.0, npm 11.19.0)

- `ng build --configuration production --base-href /typegpu-angular-poc/` builds; `index.html` has `<base href="/typegpu-angular-poc/">`.
- `index.html` copied to `404.html`, `dist/site/browser` served by a small Node static server that maps the prefix and answers unknown paths with
  `404.html` and status 404 (what Pages does), on a port started for the check and stopped afterwards: `/typegpu-angular-poc/` 200;
  `favicon.svg`, `brand/*.svg`, `thumbnails/*.jpg`, `assets/selfie-segmentation/selfie_segmenter.ssgbin` and the main bundle 200;
  `/typegpu-angular-poc/docs/ecosystem/typegpu-angular`, `/examples` and `/examples/life` 404 with a body identical to `index.html`; `/` outside the prefix 404.
- In the in-app Chromium (WebGPU available) the deep links `/typegpu-angular-poc/docs/ecosystem/typegpu-angular` and `/typegpu-angular-poc/examples/life`
  opened directly rendered: the docs page with all its headings, and Game of Life drawing on the canvas, with the thumbnails and logos loaded.
- The CI sequence above was run in a scratch clone of the committed repository with `site/` copied in: `npm ci`, the tarball installed with `--no-save`
  (byte-identical to the packed one), 405 specs pass, the production build with the base href succeeds, the shader bundle check passes.
- Not checked: a real Pages deployment, `.nojekyll`, Safari or Firefox, other browsers' handling of a 404 status with a body.

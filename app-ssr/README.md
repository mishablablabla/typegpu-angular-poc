# app-ssr

The gradient feature of `app/` with `@angular/ssr` and hydration, to check the library on the server: the GPU state stays `idle` during server rendering and the client hydrates without mismatches.

```sh
npm install --no-save ../lib/typegpu-poc-angular-*.tgz   # after scripts/build-lib-and-install.sh
npx ng build --configuration development
NG_ALLOWED_HOSTS=localhost PORT=4403 node dist/app/server/server.mjs
```

Open `http://localhost:4403`; the browser console reports `Angular hydrated ... 0 component(s) were skipped`.

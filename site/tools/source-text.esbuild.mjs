// esbuild plugin: `import source from './file.ts?source'` yields the file's text, so the examples page can show
// the code it actually runs. Angular's compiler plugin loads every path that ends in a script extension, whatever
// the namespace, so the virtual path keeps the `?source` suffix and the real path is recovered in `onLoad`.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SUFFIX = '?source';

export default {
  name: 'source-text',
  setup(build) {
    build.onResolve({ filter: /\?source$/ }, (args) => {
      const file = resolve(args.resolveDir, args.path.slice(0, -SUFFIX.length));
      return { path: file + SUFFIX, namespace: 'source-text', watchFiles: [file] };
    });
    build.onLoad({ filter: /.*/, namespace: 'source-text' }, async (args) => {
      const file = args.path.slice(0, -SUFFIX.length);
      return {
        // Stored as base64: a shader source shown as text must not contain a literal 'use gpu' directive in the bundle
        // (the minifier would write one back), which `check-shader-bundle.mjs` would take for a shader the plugin missed.
        contents: `export default new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(Buffer.from(await readFile(file, 'utf8')).toString('base64'))}), (c) => c.charCodeAt(0)));`,
        loader: 'js',
        watchFiles: [file],
      };
    });
  },
};

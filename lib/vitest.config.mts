import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // real-fs.spec.ts changes the working directory, which a worker thread cannot do
    pool: 'forks',
    include: ['schematics/**/*.spec.ts'],
    // creates the private temporary folder, and fails the run when a spec leaves a folder of ours in it
    globalSetup: ['schematics/testing/global-setup.ts'],
    // A test builds real projects (TypeScript program, esbuild, Babel) and spawns real processes: on a loaded CI machine that takes
    // several times as long (a `beforeAll` build hit "Hook timed out in 10000ms"). The hooks get the same room as the tests.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});

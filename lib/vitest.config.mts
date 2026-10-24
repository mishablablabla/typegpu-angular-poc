import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['schematics/**/*.spec.ts'], testTimeout: 30_000 },
});

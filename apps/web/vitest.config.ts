import { configDefaults, defineConfig } from 'vitest/config';

// Tests default to the node environment (lib/state/api are renderer-free by
// design). Component tests opt into jsdom with a `@vitest-environment jsdom`
// docblock pragma per file.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});

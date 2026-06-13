import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the package's react-jsx (automatic runtime) so tsx test files and
  // components transform the same way under vitest's esbuild.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
  },
});

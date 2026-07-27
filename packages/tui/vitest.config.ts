import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the package's react-jsx (automatic runtime) so tsx test files and
  // components transform the same way under Vitest's Oxc transformer.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
  },
});

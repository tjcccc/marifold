import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the package's react-jsx (automatic runtime) so tsx test files and
  // components transform the same way under Vitest's Oxc transformer.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    // Ink falls back to the real terminal's size when a test stdout has none;
    // pin it so layout tests don't depend on the terminal running them.
    env: { COLUMNS: '100', LINES: '24' },
  },
});

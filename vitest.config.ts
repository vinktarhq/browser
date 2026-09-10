import { defineConfig } from 'vitest/config';

/**
 * Unit tests run in Node with no DOM by default. A file that needs a window opts in with
 * `// @vitest-environment happy-dom` at its top, so the core stays honest about not touching one.
 * Real browsers are the Playwright suite (`npm run test:e2e`), kept separate because it needs the
 * browsers installed and takes a minute where this takes seconds.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

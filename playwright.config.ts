import { defineConfig, devices } from '@playwright/test';

/**
 * Real browsers against the built bundle and an in-process ingest stand-in. What this catches
 * that happy-dom cannot: beacon delivery on unload, `keepalive` limits, `CompressionStream`
 * availability, shadow-DOM click targets, and the three engines' stack formats.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  retries: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});

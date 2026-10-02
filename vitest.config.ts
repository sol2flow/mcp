import { defineConfig } from 'vitest/config';

// Four suites (README.md → Tests): unit, protocol and contract run in `make test` / `make check` against the fake API in
// test/fake-api; integration runs against a real app (make test-integration).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      { test: { name: 'protocol', include: ['test/protocol/**/*.test.ts'], testTimeout: 20_000 } },
      { test: { name: 'contract', include: ['test/contract/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

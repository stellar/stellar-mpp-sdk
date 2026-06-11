import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Live testnet integration tier only — requires network access and funded
    // accounts. The deterministic mocked tier runs in the default config / `make check`.
    include: ['sdk/src/**/integration/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})

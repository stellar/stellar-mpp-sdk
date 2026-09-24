import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests plus the deterministic (mocked-RPC) integration tier. The live
    // testnet tier under integration/live/** is excluded — run it via
    // `pnpm test:integration` (vitest.integration.config.ts).
    include: ['sdk/src/**/*.test.ts', 'examples/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/live/**'],
  },
})

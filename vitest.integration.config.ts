import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['sdk/src/**/integration/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})

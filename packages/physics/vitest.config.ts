import { defineConfig } from 'vitest/config'

// The physics package is headless by contract (REQUIREMENTS §10): node
// environment only, no DOM, no rendering dependency.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

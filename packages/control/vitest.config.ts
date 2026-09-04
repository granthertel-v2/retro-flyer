import { defineConfig } from 'vitest/config'

// The control package is headless by design. It is the only part of Day 2 that can
// have ground truth (REQUIREMENTS §4 applies to it; feel does not), so it must never
// acquire a rendering dependency — that is what keeps it testable in CI.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

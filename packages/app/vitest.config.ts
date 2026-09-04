import { defineConfig } from 'vitest/config'

// Only the pure modules are tested here: the §8.2 terrain source and the §8.3 seam.
// Neither imports three.js, so these run in node with no DOM. The renderer itself is
// verified by looking at it, which is what the Day 2 checkpoints are for.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})

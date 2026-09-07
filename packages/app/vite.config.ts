import { defineConfig } from 'vite'

// The physics and control packages are consumed as TypeScript source through npm
// workspaces rather than as built artefacts. That keeps the whole project one
// compilation unit — a type error in the aero model shows up here, at build time,
// instead of at runtime behind a stale .d.ts.
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // three.js is 500 kB of the bundle on its own and is not going to be split into
    // anything useful — there is one scene and it is needed on the first frame.
    // Raised so a genuine size regression is still visible over the noise.
    chunkSizeWarningLimit: 700,
  },
})

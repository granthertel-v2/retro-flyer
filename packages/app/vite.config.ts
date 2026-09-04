import { defineConfig } from 'vite'

// The physics and control packages are consumed as TypeScript source through npm
// workspaces rather than as built artefacts. That keeps the whole project one
// compilation unit — a type error in the aero model shows up here, at build time,
// instead of at runtime behind a stale .d.ts.
export default defineConfig({
  base: './',
  server: { port: 5173 },
  build: { target: 'es2022', outDir: 'dist' },
})

/**
 * Build the hawk-failover plugin: lib/index.js (ESM, for the host loader).
 * Host-side function plugin only — there is no browser half. The bundle
 * imports no bare specifiers (node builtins and local code only), so the
 * profile's node_modules needs nothing beyond the linked package itself.
 */
import { defineConfig } from 'tsdown'

const nodeEnv = process.env.NODE_ENV ?? 'production'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  dts: false,
  define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
})

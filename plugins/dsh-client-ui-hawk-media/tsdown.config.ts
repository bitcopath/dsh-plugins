/**
 * Build both halves of the hawk-media plugin:
 * - lib/index.js  — node half (ESM, for the host loader)
 * - lib/client.js — browser half (CJS closure factory handed to
 *                   window.__ModuleLoader__.load; externals resolve from the
 *                   platform module table the shell seeds: react,
 *                   react/jsx-runtime, cordis, dsh-client-ui-slots,
 *                   dsh-client-ui-primitives).
 *
 * Source of truth is src/ — lib/ is generated. Keep them in step with
 * `npm run build` (never hand-edit lib/).
 */
import { defineConfig } from 'tsdown'

// Client-modules entry id — the npm package name (client-modules keys the boot
// graph, the /plugins/<id>/client.js route and the __ModuleLoader__
// registration by the loader entry's package name). NOT the cordis plugin id,
// which stays 'hawk-media' in cordis.patch.yml.
const PKG_ID = 'dsh-client-ui-hawk-media'

export default defineConfig([
  // Node half: lib/index.js (ESM). Imports only node builtins plus ./shared.js,
  // so the bundle carries no bare specifiers the profile must resolve.
  {
    entry: { index: 'src/host.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    dts: false,
  },
  // Browser half: lib/client.js (CJS closure factory). Externals stay in the
  // module table; everything else inlines. `type: module` in package.json would
  // make tsdown emit .cjs here — outExtensions pins .js because the harness
  // route serves exports["./client"] verbatim.
  {
    entry: { client: 'src/client/index.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    dts: false,
    external: [
      /^react($|\/)/,
      /^react-dom($|\/)/,
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    outExtensions: () => ({ js: '.js' }),
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: {
      // The client plugin needs the platform React, which only the factory's
      // `require` can reach — so the plugin object is built here, not at the
      // factory's top level.
      js: `var __hawkPlugin = module.exports.createClient(require("react"));\nmodule.exports.apply = __hawkPlugin.apply;\nmodule.exports.inject = __hawkPlugin.inject;\nreturn module.exports; } });`,
    },
  },
])

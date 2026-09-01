/**
 * Bundles the bridge into a CommonJS module the Electron main process can
 * require. Electron's main process runs Node but not the TypeScript type
 * stripping the CLI relies on, so the .ts sources are compiled here.
 *
 * Supabase URL and publishable key are baked in the same way the standalone exe
 * bakes them -- see bridge/build.mjs for why that's safe.
 */

import { build } from 'esbuild';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeSrc = resolve(here, '..', 'bridge', 'src');

function readEnvValues() {
  const keys = [
    'SUPABASE_URL', 'VITE_SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY',
  ];
  const found = {};
  for (const dir of [resolve(here, '..'), resolve(here, '..', 'bridge'), here]) {
    const path = join(dir, '.env');
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && keys.includes(m[1]) && !found[m[1]]) {
        found[m[1]] = m[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
      }
    }
  }
  return {
    url: found.SUPABASE_URL || found.VITE_SUPABASE_URL || '',
    key: found.SUPABASE_PUBLISHABLE_KEY || found.VITE_SUPABASE_PUBLISHABLE_KEY || '',
  };
}

const env = readEnvValues();
if (!env.url || !env.key) {
  console.warn('! No Supabase config found to bake in; the app will need a .env at runtime.');
}

mkdirSync(join(here, 'dist'), { recursive: true });

// One entry re-exporting everything the main process touches.
await build({
  stdin: {
    contents: `
      export { createBridge } from './runner.ts';
      export { redeemPairingCode, fetchState } from './api.ts';
      export { readConfig, writeConfig, CONFIG_PATH } from './config.ts';
      export { supabaseEnv } from './config.ts';
      import { supabaseEnv as _env } from './config.ts';
      export const supabaseUrl = (() => { try { return _env().url; } catch { return null; } })();
    `,
    resolveDir: bridgeSrc,
    sourcefile: 'bridge-entry.ts',
    loader: 'ts',
  },
  outfile: join(here, 'dist', 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['node:sea'],
  define: {
    __BAKED_SUPABASE_URL__: JSON.stringify(env.url),
    __BAKED_SUPABASE_KEY__: JSON.stringify(env.key),
  },
  legalComments: 'none',
});

console.log('Bundled desktop/dist/bridge.cjs');

/**
 * Builds rotorops-bridge.exe -- a single executable with Node embedded.
 *
 *   node build.mjs
 *
 * Three steps: bundle the TypeScript to one CommonJS file, turn that into a
 * Node SEA blob, then inject the blob into a copy of node.exe.
 *
 * The Supabase URL and *publishable* key are baked in so the exe is standalone.
 * That key is public by design -- the web app already ships it in client JS,
 * and every table behind it is protected by row-level security. A .env next to
 * the exe still overrides it.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const EXE = join(dist, 'rotorops-bridge.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Read Supabase config out of the nearest .env so it can be baked in. */
function readEnvValues() {
  const keys = ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY'];
  const found = {};
  for (const dir of [here, resolve(here, '..'), resolve(here, '..', '..')]) {
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
    url: process.env.SUPABASE_URL || found.SUPABASE_URL || found.VITE_SUPABASE_URL || '',
    key:
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      found.SUPABASE_PUBLISHABLE_KEY ||
      found.VITE_SUPABASE_PUBLISHABLE_KEY ||
      '',
  };
}

const step = (n, msg) => console.log(`\n[${n}/4] ${msg}`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const env = readEnvValues();
if (!env.url || !env.key) {
  console.warn(
    '! No Supabase config found to bake in.\n' +
      '  The exe will need a .env beside it, or SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY set.',
  );
} else {
  console.log(`Baking in Supabase project: ${env.url}`);
}

// ---------------------------------------------------------------------------
step(1, 'Bundling to a single CommonJS file...');
await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile: join(dist, 'bundle.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  // node:sea is provided by the host at runtime, not something to bundle.
  external: ['node:sea'],
  define: {
    __BAKED_SUPABASE_URL__: JSON.stringify(env.url),
    __BAKED_SUPABASE_KEY__: JSON.stringify(env.key),
  },
  legalComments: 'none',
  minify: false,
});
console.log(`    bundle.cjs  ${(statSync(join(dist, 'bundle.cjs')).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------------------
step(2, 'Generating the SEA blob...');
const seaConfig = join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: join(dist, 'bundle.cjs'),
      output: join(dist, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// ---------------------------------------------------------------------------
step(3, 'Copying the Node runtime...');
copyFileSync(process.execPath, EXE);
console.log(`    ${EXE}`);

// ---------------------------------------------------------------------------
step(4, 'Injecting the blob...');
execFileSync(
  process.execPath,
  [
    join(here, 'node_modules', 'postject', 'dist', 'cli.js'),
    EXE,
    'NODE_SEA_BLOB',
    join(dist, 'sea-prep.blob'),
    '--sentinel-fuse',
    FUSE,
  ],
  { stdio: 'inherit' },
);

rmSync(join(dist, 'sea-prep.blob'), { force: true });
rmSync(seaConfig, { force: true });

console.log(
  `\nBuilt ${EXE}  (${(statSync(EXE).size / 1024 / 1024).toFixed(0)} MB)\n\n` +
    'Run it:\n' +
    '  dist\\rotorops-bridge.exe          pair on first launch, then watch the sim\n' +
    '  dist\\rotorops-bridge.exe probe    check which SimVars your install exposes\n',
);

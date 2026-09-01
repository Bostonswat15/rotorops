/**
 * Bridge configuration.
 *
 * Has to work two ways: from source during development, and from a single .exe
 * that may live anywhere on disk. So nothing here resolves paths relative to a
 * source file -- it walks up from the running script/exe, then falls back to
 * values baked in at build time.
 *
 * The device token is the only secret, and it lives in the user profile
 * directory rather than next to the exe.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

// Replaced by esbuild at build time. Undefined when running from source.
declare const __BAKED_SUPABASE_URL__: string;
declare const __BAKED_SUPABASE_KEY__: string;

const baked = {
  url: typeof __BAKED_SUPABASE_URL__ === 'string' ? __BAKED_SUPABASE_URL__ : '',
  key: typeof __BAKED_SUPABASE_KEY__ === 'string' ? __BAKED_SUPABASE_KEY__ : '',
};

/** True when running as a packaged single executable. */
export const isPackaged = (() => {
  try {
    return (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
})();

export const CONFIG_DIR = join(
  process.env.APPDATA || join(homedir(), '.config'),
  'RotorOps',
);
export const CONFIG_PATH = join(CONFIG_DIR, 'bridge.json');

export type BridgeConfig = {
  deviceToken?: string;
  deviceId?: string;
  companyId?: string;
};

/**
 * Minimal .env reader. First file to define a key wins, so the search order
 * below is a precedence order.
 */
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    if (process.env[key]) continue;
    process.env[key] = m[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
}

/** Directories worth checking for a .env, nearest first. */
function envSearchDirs(): string[] {
  const dirs: string[] = [];
  const seeds = [
    // In a SEA build argv[1] is undefined, so execPath is what locates the exe.
    isPackaged ? dirname(process.execPath) : '',
    process.argv[1] ? dirname(resolve(process.argv[1])) : '',
    process.cwd(),
  ].filter(Boolean);

  for (const seed of seeds) {
    let dir = seed;
    // Walk up a few levels: bridge/src -> bridge -> repo root.
    for (let i = 0; i < 4; i++) {
      if (!dirs.includes(dir)) dirs.push(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return dirs;
}

let envLoaded = false;
function ensureEnv() {
  if (envLoaded) return;
  envLoaded = true;
  for (const dir of envSearchDirs()) loadEnvFile(join(dir, '.env'));
}

export function supabaseEnv() {
  ensureEnv();
  const url =
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || baked.url;
  const key =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    baked.key;

  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY.\n' +
        `Searched for a .env in:\n${envSearchDirs().map((d) => `  ${d}`).join('\n')}`,
    );
  }
  return { url: url.replace(/\/+$/, ''), key };
}

export const SCENE_OBJECTS_PATH = join(CONFIG_DIR, 'scene-objects.json');

/**
 * User-authored mapping from mission role/scene to SimObject titles.
 *
 * Lets custom 3D models be used for scene dressing without rebuilding the
 * bridge -- add the model to the sim as a SimObject, name it here, done.
 * Returns null when absent or malformed, and the built-in keyword matching
 * takes over.
 */
export function readSceneObjects(): unknown | null {
  if (!existsSync(SCENE_OBJECTS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SCENE_OBJECTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function readConfig(): BridgeConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as BridgeConfig;
  } catch {
    return {};
  }
}

export function writeConfig(patch: BridgeConfig) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

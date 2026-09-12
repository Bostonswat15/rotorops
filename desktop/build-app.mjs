/**
 * Builds the web app for the desktop shell.
 *
 * The project's default Nitro preset targets Cloudflare Workers, which produces
 * a Worker module rather than something that can listen on a port -- it starts
 * and exits silently. The desktop app runs the server locally, so it needs the
 * node-server preset instead.
 *
 * Setting the variable here keeps it cross-platform; `NITRO_PRESET=... npm run`
 * is not valid syntax on Windows cmd.
 *
 * This is why `npm start` runs this rather than the root `npm run build`:
 * the root script builds a Worker, the desktop shell loads it, nothing
 * listens, and the window shows "app server did not start" with no clue
 * that the preset was the problem.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

console.log('Building the web app with the node-server preset...');
const child = spawn(npx, ['vite', 'build'], {
  cwd: root,
  env: { ...process.env, NITRO_PRESET: 'node-server' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 1));

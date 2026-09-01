/**
 * Zips the built app for sharing.
 *
 * electron-builder's NSIS installer needs symlink privileges Windows only
 * grants to admins (or with Developer Mode on), which fails here -- so the
 * unpacked folder is what gets distributed. It has to travel whole: the exe
 * alone is useless without its 188 sibling files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'dist', 'win-unpacked');
const out = join(here, 'dist', 'RotorOps.zip');

if (!existsSync(src)) {
  console.error('No build found. Run:  npx electron-builder --win --dir');
  process.exit(1);
}

console.log('Compressing (this takes a minute)...');
execFileSync(
  'powershell',
  ['-NoProfile', '-Command',
   `Compress-Archive -Path '${src}\*' -DestinationPath '${out}' -Force -CompressionLevel Optimal`],
  { stdio: 'inherit' },
);

console.log(`\n${out}`);
console.log(`${(statSync(out).size / 1024 / 1024).toFixed(0)} MB\n`);
console.log('Send that to a friend. They extract it anywhere and run RotorOps.exe.');
console.log('It already knows your Supabase project, so they only need an invite code.');

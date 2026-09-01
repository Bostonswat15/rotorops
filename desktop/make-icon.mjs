/**
 * Generates desktop/icon.png -- a 256x256 rotor mark.
 *
 * Written by hand with zlib rather than pulling in an image library: it's a few
 * filled shapes, and electron-builder needs at least 256px for a Windows icon.
 * The tray uses it too; an empty nativeImage renders as an invisible tray icon,
 * which leaves the app running with no way to quit it.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const here = dirname(fileURLToPath(import.meta.url));

// Palette roughly matching the app: near-black plate, amber rotor.
const BG = [16, 18, 22, 255];
const FG = [245, 166, 35, 255];
const DIM = [245, 166, 35, 120];

const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Simple source-over so anti-aliased edges blend into the plate.
  const alpha = a / 255;
  px[i] = Math.round(px[i] * (1 - alpha) + r * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + g * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + b * alpha);
  px[i + 3] = Math.max(px[i + 3], a);
}

const c = SIZE / 2;

// Rounded background plate.
const radius = 48;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.max(radius - x, x - (SIZE - 1 - radius), 0);
    const dy = Math.max(radius - y, y - (SIZE - 1 - radius), 0);
    if (Math.hypot(dx, dy) <= radius) set(x, y, BG);
  }
}

/** Filled rotated bar, centred on the hub. */
function bar(angleDeg, length, thickness, colour) {
  const a = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  for (let t = -length; t <= length; t += 0.25) {
    for (let w = -thickness; w <= thickness; w += 0.25) {
      const x = c + ux * t - uy * w;
      const y = c + uy * t + ux * w;
      set(Math.round(x), Math.round(y), colour);
    }
  }
}

// Main rotor: two crossed blades, plus softer blades suggesting rotation.
bar(20, 104, 5, FG);
bar(-20, 104, 5, FG);
bar(72, 96, 3, DIM);
bar(-72, 96, 3, DIM);

// Hub.
for (let y = -18; y <= 18; y++) {
  for (let x = -18; x <= 18; x++) {
    if (Math.hypot(x, y) <= 18) set(c + x, c + y, FG);
  }
}
for (let y = -8; y <= 8; y++) {
  for (let x = -8; x <= 8; x++) {
    if (Math.hypot(x, y) <= 8) set(c + x, c + y, BG);
  }
}

// Tail boom.
for (let t = 0; t < 86; t++) {
  for (let w = -4; w <= 4; w++) {
    set(Math.round(c + t), Math.round(c + 58 + w * 0.6), FG);
  }
}

// --- PNG encoding ----------------------------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c2 = n;
      for (let k = 0; k < 8; k++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
      crcTable[n] = c2;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // no filter
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(join(here, 'icon.png'), png);
console.log(`Wrote desktop/icon.png (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);

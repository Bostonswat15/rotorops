/**
 * Real road geometry, for putting vehicles on the carriageway.
 *
 * A roadside scene used to scatter its traffic on random bearings across a
 * ~190 m circle. The bridge knows nothing about terrain, so a lorry landed in
 * the lake beside "the bypass" and a fire engine in the trees -- the scene
 * point itself is on a real OSM road, but nothing else was.
 *
 * So staging asks OpenStreetMap for the drivable way nearest the scene and
 * lines vehicles up along it. MSFS builds its roads from the same data, which
 * is what makes an OSM polyline a fair stand-in for where the tarmac is.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.ts';
import type { LatLon } from './search.ts';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const TIMEOUT_MS = 10_000;

/** Anything a car drives on; footpaths and tracks are deliberately left out. */
const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

type Lookup = { kind: 'road'; line: LatLon[] } | { kind: 'none' } | { kind: 'error' };

/**
 * One lookup, telling apart "no road here" from "OSM could not be reached".
 *
 * Both mirrors are asked at once and the first good answer wins. Measured
 * from this machine, each mirror in turn hung for 12 s or rate-limited with a
 * 429 on some requests while the other answered in 2-5 s; asking them one
 * after the other spent the whole budget on whichever was having a bad
 * moment. The loser is cancelled as soon as there is a winner.
 */
async function lookup(lat: number, lon: number, radiusM: number): Promise<Lookup> {
  const query =
    `[out:json][timeout:10];` +
    `way(around:${Math.round(radiusM)},${lat},${lon})["highway"~"^(${DRIVABLE})$"];` +
    `out geom;`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const ways = await Promise.any(ENDPOINTS.map((url) => queryMirror(url, query, controller.signal)));
    return ways.length === 0 ? { kind: 'none' } : { kind: 'road', line: nearestLine(ways, { lat, lon }) };
  } catch {
    // Every mirror failed or timed out.
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** The polyline of the drivable way nearest a point, or null for either kind of miss. */
export async function fetchRoadNear(lat: number, lon: number, radiusM = 200): Promise<LatLon[] | null> {
  const r = await lookup(lat, lon, radiusM);
  return r.kind === 'road' ? r.line : null;
}

// --- Cache -------------------------------------------------------------------

const CACHE_PATH = join(CONFIG_DIR, 'road-cache.json');
/** Scene point -> its road, or [] for a confirmed "no road here". */
type Cache = Record<string, [number, number][]>;
const keyOf = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

function readCache(): Cache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

function remember(lat: number, lon: number, line: LatLon[] | null) {
  try {
    const cache = readCache();
    cache[keyOf(lat, lon)] = (line ?? []).map((p) => [p.lat, p.lon]);
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // A cache that cannot be written just means asking again next time.
  }
}

/** Waits between attempts: now, then backing off to a couple of minutes. */
const RETRY_DELAYS_MS = [0, 15_000, 30_000, 60_000, 120_000];

/**
 * The road at a scene, surviving a bad moment on OSM.
 *
 * A single 10 s attempt made one slow request decide the whole scene:
 * measured, the lookup timed out, the fallback piled five vehicles into a
 * 10 m heap, and a scene that had a perfectly good road looked broken. Now a
 * failure is retried with backoff for a few minutes, and a real answer --
 * including "there is no road here" -- is written to disk, so a restart or a
 * re-arm places the scene instantly and never asks OSM twice.
 *
 * `stillWanted` lets the caller give up early, when the scene it was for has
 * been cleared. Resolves to null when there is no road or the retries ran
 * out; the caller leaves the vehicles out either way.
 */
export async function roadWithRetry(
  lat: number,
  lon: number,
  stillWanted: () => boolean,
  log: (message: string) => void,
): Promise<LatLon[] | null> {
  const cached = readCache()[keyOf(lat, lon)];
  if (cached) return cached.length >= 2 ? cached.map(([la, lo]) => ({ lat: la, lon: lo })) : null;

  for (const [attempt, delay] of RETRY_DELAYS_MS.entries()) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (!stillWanted()) return null;
    const r = await lookup(lat, lon, 200);
    if (r.kind === 'road') {
      remember(lat, lon, r.line);
      return r.line;
    }
    if (r.kind === 'none') {
      remember(lat, lon, null);
      return null;
    }
    const next = RETRY_DELAYS_MS[attempt + 1];
    if (next !== undefined) log(`Road lookup failed (OSM busy) -- retrying in ${next / 1000} s.`);
  }
  return null;
}

/** One mirror's answer. Throws on anything but a usable response, so Promise.any skips it. */
async function queryMirror(url: string, query: string, signal: AbortSignal): Promise<LatLon[][]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass answers a bare request with 406.
      'User-Agent': 'RotorOps-bridge/0.1 (MSFS scene placement)',
    },
    body: 'data=' + encodeURIComponent(query),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.elements ?? [])
    .filter((e: any) => Array.isArray(e.geometry) && e.geometry.length >= 2)
    .map((e: any) => e.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })));
}

/** A metre-scale flat projection around an origin -- plenty over a few hundred metres. */
function projector(origin: LatLon) {
  const kx = Math.cos((origin.lat * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  return {
    to: (p: LatLon) => ({ x: (p.lon - origin.lon) * kx, y: (p.lat - origin.lat) * ky }),
    from: (x: number, y: number): LatLon => ({ lat: origin.lat + y / ky, lon: origin.lon + x / kx }),
  };
}

/** Closest point on segment ab to p, with its parameter along the segment. */
function closestOnSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
}

/** The line passing closest to a point. */
export function nearestLine(lines: LatLon[][], p: LatLon): LatLon[] {
  const proj = projector(p);
  const origin = { x: 0, y: 0 };
  let best = lines[0];
  let bestD = Infinity;
  for (const line of lines) {
    const xy = line.map(proj.to);
    for (let i = 0; i < xy.length - 1; i++) {
      const c = closestOnSegment(origin, xy[i], xy[i + 1]);
      if (c.d < bestD) {
        bestD = c.d;
        best = line;
      }
    }
  }
  return best;
}

/**
 * A position on the road, relative to where a point meets it.
 *
 * `alongM` walks along the line from the point nearest `origin` (negative
 * goes back towards the start of the way); `sideM` steps off the centreline,
 * positive to the right of the direction of travel. `heading` is that
 * direction, so a vehicle placed here faces along the road rather than across
 * it.
 */
export function placeAlongRoad(
  line: LatLon[],
  origin: LatLon,
  alongM: number,
  sideM: number,
): LatLon & { heading: number } {
  const proj = projector(origin);
  const xy = line.map(proj.to);
  if (xy.length < 2) return { ...origin, heading: 0 };

  // Cumulative distance to each vertex, and where the origin meets the line.
  const cum = [0];
  for (let i = 1; i < xy.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total === 0) return { ...origin, heading: 0 };

  let atS = 0;
  let bestD = Infinity;
  for (let i = 0; i < xy.length - 1; i++) {
    const c = closestOnSegment({ x: 0, y: 0 }, xy[i], xy[i + 1]);
    if (c.d < bestD) {
      bestD = c.d;
      atS = cum[i] + c.t * (cum[i + 1] - cum[i]);
    }
  }

  // Not clamped. OSM splits a road into short ways at every junction -- a
  // live lookup in Squamish came back four vertices long -- so walking 14 m
  // and 28 m back both hit the end of the way and put two vehicles on the
  // same spot. Past either end, carry on along the end segment instead: at
  // the few tens of metres a scene spans, that is still the carriageway.
  const s = atS + alongM;
  let j = 0;
  while (j < xy.length - 2 && cum[j + 1] < s) j++;
  const segLen = cum[j + 1] - cum[j] || 1;
  const dx = (xy[j + 1].x - xy[j].x) / segLen;
  const dy = (xy[j + 1].y - xy[j].y) / segLen;
  // Distance from this segment's start, which may be negative before the
  // first vertex or beyond the segment after the last.
  const u = s - cum[j];

  const x = xy[j].x + dx * u + dy * sideM;
  const y = xy[j].y + dy * u - dx * sideM;
  const heading = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return { ...proj.from(x, y), heading };
}

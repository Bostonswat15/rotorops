/**
 * Real-world features from OpenStreetMap.
 *
 * MSFS builds its powerlines, roads and coastlines from OSM data, so querying
 * OSM gives us the same geometry the sim rendered. A powerline patrol can then
 * follow an actual named transmission line that physically exists in the world
 * you're flying over, rather than an invented string of waypoints.
 *
 * Overpass is a free public service with a usage policy: queries are kept
 * small, bounded, and infrequent (generation only, never per-frame). Every
 * failure path returns empty so contract generation carries on without it.
 */

const OVERPASS = "https://overpass-api.de/api/interpreter";
const TIMEOUT_MS = 20_000;

export type LatLon = { lat: number; lon: number };

export type PowerLine = {
  id: number;
  /** Operator's name for the line, when OSM has one. */
  name: string | null;
  operator: string | null;
  voltage: string | null;
  geometry: LatLon[];
};

/** Degrees of latitude per nautical mile. */
const DEG_PER_NM = 1 / 60;

function bbox(centre: LatLon, radiusNm: number) {
  const dLat = radiusNm * DEG_PER_NM;
  // Longitude degrees shrink towards the poles.
  const dLon = dLat / Math.max(0.15, Math.cos((centre.lat * Math.PI) / 180));
  return [centre.lat - dLat, centre.lon - dLon, centre.lat + dLat, centre.lon + dLon]
    .map((n) => n.toFixed(4))
    .join(",");
}

async function overpass(query: string): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json?.elements) ? json.elements : [];
  } catch {
    // Offline, rate-limited, or slow -- the caller falls back to synthetic sites.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transmission lines within `radiusNm` of a point, longest first.
 *
 * Long lines make better patrols: more to inspect, and less chance the route
 * doubles back on itself.
 */
export async function findPowerLines(centre: LatLon, radiusNm = 40): Promise<PowerLine[]> {
  const elements = await overpass(
    `[out:json][timeout:20];way["power"="line"](${bbox(centre, radiusNm)});out geom 40;`,
  );

  return elements
    .filter((e) => Array.isArray(e.geometry) && e.geometry.length >= 4)
    .map((e) => ({
      id: e.id,
      name: e.tags?.name ?? null,
      operator: e.tags?.["operator:short"] ?? e.tags?.operator ?? null,
      voltage: e.tags?.voltage ?? null,
      geometry: e.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })),
    }))
    .sort((a, b) => b.geometry.length - a.geometry.length);
}

export type Aerodrome = { icao: string; lat: number; lon: number };

/**
 * Airfields within `radiusNm`, from OSM.
 *
 * The sim bridge already reports airports from MSFS's facility cache, but only
 * after it has run at least once and the cache has filled. Querying OSM as well
 * means a freshly generated contract can name its nearest field immediately,
 * and picks up small strips the facility cache sometimes misses.
 *
 * Falls back to the field's name when OSM has no ICAO, which is common for
 * private strips -- a name is still more use than nothing.
 */
export async function findAerodromes(centre: LatLon, radiusNm = 60): Promise<Aerodrome[]> {
  const b = bbox(centre, radiusNm);
  const elements = await overpass(
    `[out:json][timeout:20];(node["aeroway"="aerodrome"](${b});way["aeroway"="aerodrome"](${b}););out center 120;`,
  );

  return elements
    .map((e) => {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      const t = e.tags ?? {};
      const icao: string | null = t.icao ?? t.faa ?? t.ref ?? t.name ?? null;
      if (typeof lat !== "number" || typeof lon !== "number" || !icao) return null;
      return { icao: String(icao), lat, lon };
    })
    .filter((a): a is Aerodrome => a !== null);
}

/** Great-circle distance in nautical miles. */
export function nmBetween(a: LatLon, b: LatLon) {
  const R = 3440.065;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a polyline, in nautical miles. */
export function pathLengthNm(points: LatLon[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += nmBetween(points[i - 1], points[i]);
  return total;
}

/**
 * Thin a line down to `count` inspection points, evenly spaced by distance
 * rather than by node index -- OSM nodes cluster where a line changes bearing,
 * so sampling by index would bunch the waypoints around corners.
 */
export function samplePath(points: LatLon[], count: number): LatLon[] {
  if (points.length <= count) return points;
  const total = pathLengthNm(points);
  if (total === 0) return points.slice(0, count);

  const step = total / (count - 1);
  const out: LatLon[] = [points[0]];
  let walked = 0;
  let target = step;

  for (let i = 1; i < points.length && out.length < count - 1; i++) {
    const seg = nmBetween(points[i - 1], points[i]);
    while (walked + seg >= target && out.length < count - 1) {
      const frac = seg === 0 ? 0 : (target - walked) / seg;
      out.push({
        lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * frac,
        lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * frac,
      });
      target += step;
    }
    walked += seg;
  }

  out.push(points[points.length - 1]);
  return out;
}

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

/**
 * Run a query, returning null if Overpass could not be reached.
 *
 * The null/empty distinction matters: an empty result is Overpass telling us
 * there is genuinely nothing there, while null means we never got an answer.
 * Callers that gate content on absence -- "there is no water near this base" --
 * must not treat a timeout as proof of a desert.
 */
async function overpass(query: string, timeoutMs = TIMEOUT_MS): Promise<any[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json?.elements) ? json.elements : [];
  } catch {
    // Offline, rate-limited, or slow.
    return null;
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
  const elements = (await overpass(
    `[out:json][timeout:20];way["power"="line"](${bbox(centre, radiusNm)});out geom 40;`,
  )) ?? [];

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
  const elements = (await overpass(
    `[out:json][timeout:20];(node["aeroway"="aerodrome"](${b});way["aeroway"="aerodrome"](${b}););out center 120;`,
  )) ?? [];

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

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * The water near a base, as MSFS sees it.
 *
 * Without this the app has no idea whether a base is coastal, so it happily
 * generated "vessel in distress" contracts in the middle of Kansas. MSFS builds
 * its coastlines, lakes and rivers from the same OSM data queried here, so
 * water found here is water you can actually ditch a boat in.
 *
 * Returns null when Overpass could not be reached -- see `overpass` above for
 * why that is not the same as "no water".
 */
export type WaterFeatures = {
  /** Coastline ways in OSM order. By convention land is left, water is right. */
  coastline: LatLon[][];
  /** Closed water polygons, as centre plus half-diagonal in nm. */
  lakes: { centre: LatLon; radiusNm: number; ring: LatLon[] }[];
  rivers: LatLon[][];
  beaches: LatLon[][];
};

/** Bounding circle of a polyline: centre, and half its diagonal in nm. */
function extentOf(points: LatLon[]) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return {
    centre: { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 },
    radiusNm: nmBetween({ lat: minLat, lon: minLon }, { lat: maxLat, lon: maxLon }) / 2,
  };
}

const isClosed = (p: LatLon[]) =>
  p.length > 3 && p[0].lat === p[p.length - 1].lat && p[0].lon === p[p.length - 1].lon;

/** Initial bearing from a to b, in degrees. */
export function bearingBetween(a: LatLon, b: LatLon) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export async function findWater(centre: LatLon, radiusNm = 60): Promise<WaterFeatures | null> {
  const b = bbox(centre, radiusNm);
  // One union query per contract batch. `natural=water` catches lakes and
  // reservoirs; rivers are queried separately because they are line features
  // and a riverbank scene wants the centreline, not a polygon.
  // Two `out` statements, one query. Coastline gets its own budget because it
  // is what every offshore placement is checked against, and a single shared
  // cap let 118 river ways crowd it out -- which is how vessels ended up in
  // Fall River.
  const elements = await overpass(
    `[out:json][timeout:60];` +
      `way["natural"="coastline"](${b});out geom 3000;` +
      `(way["natural"="water"](${b});` +
      `way["waterway"="river"](${b});` +
      `way["natural"="beach"](${b}););` +
      `out geom 800;`,
    // Broad area lookups against the public instance measure 15-20s. This runs
    // once per base and the result is cached, so a generous budget is cheaper
    // than aborting and leaving the base's water unknown.
    60_000,
  );
  if (elements === null) return null;

  const out: WaterFeatures = { coastline: [], lakes: [], rivers: [], beaches: [] };

  for (const e of elements) {
    if (!Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const ring: LatLon[] = e.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon }));
    const t = e.tags ?? {};

    if (t.natural === "coastline") {
      out.coastline.push(ring);
    } else if (t.natural === "beach") {
      out.beaches.push(ring);
    } else if (t.waterway === "river") {
      out.rivers.push(ring);
    } else if (t.natural === "water") {
      // Only closed ways: a lake mapped as a multipolygon arrives here as
      // disconnected fragments, and the centroid of a fragment is not water.
      if (!isClosed(ring)) continue;
      const { centre: c, radiusNm: r } = extentOf(ring);
      if (r >= 0.15) out.lakes.push({ centre: c, radiusNm: r, ring });
    }
  }

  return out;
}

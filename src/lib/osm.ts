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

/** Hospital names that are not an emergency receiving facility. */
const NON_ACUTE =
  /rehab|psychiatr|behavio|veterinar|animal|nursing|hospice|dental|chiroprac|podiatr|convalesc|long[- ]term/i;

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
  const elements = await overpass(
    `[out:json][timeout:20];way["power"="line"](${bbox(centre, radiusNm)});out geom 40;`,
  );
  // Thrown, not empty: the session cache keeps whatever resolves, so an empty
  // answer from a 504 left every patrol off the board until the app restarted.
  if (!elements) throw new Error("Overpass unavailable for power lines");

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

/**
 * Transmission towers within `radiusNm`, from OSM.
 *
 * MSFS 2024 builds its powerline scenery from the same OSM data, so these
 * coordinates are where the sim actually draws its pylons -- there is no
 * SimConnect API that will report scenery positions, and this is the closest
 * thing to asking the sim directly.
 *
 * Worth a query of its own rather than reusing a line's geometry: measured
 * against real data near CYSE, only about a quarter of a `power=line` way's
 * vertices are tagged `power=tower`. The rest are shape points where the
 * line simply changes direction, with nothing standing there at all.
 *
 * Its own `out` budget, deliberately: towers outnumber lines by hundreds to
 * one, so a shared budget returns nothing but towers and starves the ways.
 */
export async function findPowerTowers(centre: LatLon, radiusNm = 40): Promise<LatLon[]> {
  const elements = await overpass(
    `[out:json][timeout:25];node["power"~"^(tower|portal)$"](${bbox(centre, radiusNm)});out 2000;`,
  );
  // Thrown for the same reason as findPowerLines; the caller carries on without towers.
  if (!elements) throw new Error("Overpass unavailable for power towers");
  return elements
    .filter((e) => typeof e.lat === "number" && typeof e.lon === "number")
    .map((e) => ({ lat: e.lat, lon: e.lon }));
}

export type Aerodrome = {
  icao: string;
  lat: number;
  lon: number;
  /** Longest land runway in feet. 0 when every mapped runway is water; null when none is mapped. */
  runway_ft: number | null;
  /** That runway's surface tag ("grass", "asphalt"), when it has one. */
  surface: string | null;
};

const FT_PER_NM = 6076.12;
/** A lone runway shorter than this is a model-aircraft field, not a strip. */
const STRIP_MIN_FT = 800;
/** Lone runways this close together are one strip (crossing or parallel). */
const STRIP_MERGE_NM = 0.5;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * A name for a strip OSM doesn't name, from where it lies: "Grass strip 12 nm NE".
 * It stands in for an ident on the card and in "Land at ..."; the landing
 * itself is judged on the strip's stored position.
 */
function stripName(centre: LatLon, at: LatLon, surface: string | null): string {
  const nm = Math.max(1, Math.round(nmBetween(centre, at)));
  const rad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(rad(at.lon - centre.lon)) * Math.cos(rad(at.lat));
  const x =
    Math.cos(rad(centre.lat)) * Math.sin(rad(at.lat)) -
    Math.sin(rad(centre.lat)) * Math.cos(rad(at.lat)) * Math.cos(rad(at.lon - centre.lon));
  const brg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const word = (surface ?? "").split(/[;:_]/)[0].trim().toLowerCase();
  const kind =
    surfaceClass(surface) === "unpaved" && word
      ? `${word.charAt(0).toUpperCase()}${word.slice(1)} strip`
      : surfaceClass(surface) === "paved"
        ? "Paved strip"
        : "Strip";
  return `${kind} ${nm} nm ${COMPASS[Math.round(brg / 45) % 8]}`;
}
/** A runway this far from a field's centre can still be its runway; the nearest field wins. */
const RUNWAY_MATCH_NM = 3;
const PAVED = /^(asphalt|concrete|paved|bitumen|tarmac|chipseal|metal|paving_stones|sett)/;
const UNPAVED =
  /^(grass|dirt|gravel|fine_gravel|ground|unpaved|earth|soil|sand|compacted|turf|mud|clay|laterite|coral|shells?|pebblestone|rock|snow|ice|salt)/;

/** What a runway's surface tag means for landing on it. Null when it has none, or one this doesn't know. */
export function surfaceClass(surface: string | null | undefined): "paved" | "unpaved" | "water" | null {
  const s = (surface ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("water")) return "water";
  if (PAVED.test(s)) return "paved";
  if (UNPAVED.test(s)) return "unpaved";
  return null;
}

/** A way from an `out tags geom` query. */
type OsmWay = { geometry?: { lat?: unknown; lon?: unknown }[]; tags?: Record<string, string> };

const wayPoints = (e: OsmWay): LatLon[] =>
  Array.isArray(e.geometry)
    ? e.geometry.filter((p): p is LatLon => typeof p?.lat === "number" && typeof p?.lon === "number")
    : [];

/**
 * A mapped runway's length in feet: the longest span of its drawn nodes, which
 * serves for a centreline and a runway drawn as an area alike, else its
 * `length` tag (metres, unless it says feet).
 */
function runwayFeet(e: OsmWay): number | null {
  const pts = wayPoints(e);
  let longest = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) longest = Math.max(longest, nmBetween(pts[i], pts[j]));
  }
  if (longest > 0) return Math.round(longest * FT_PER_NM);
  const tag = String(e.tags?.length ?? "");
  const n = parseFloat(tag);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(/ft|'/i.test(tag) ? n : n * 3.28084);
}

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
 *
 * Each field also gets its longest land runway and that runway's surface, so a
 * bush job can go to a grass strip and an airliner job can't. The sim's
 * facility list carries neither. Runways are a second query, run after the
 * fields rather than beside them: Overpass allows two requests at a time per
 * address, and a failed runway lookup should cost the runway data, not the
 * fields.
 *
 * Relations too: larger airports are often mapped as multipolygons (Ottawa's
 * CYOW is), and a node-and-way query never saw them.
 *
 * Grass strips (2026-09-15): farm and bush strips are mostly mapped as
 * `aeroway=airstrip`, or as nothing but a runway with no aerodrome around it.
 * Both count now: an airstrip is a field, a drawn airstrip is also a runway,
 * and a land runway no field claims becomes a strip of its own, named for
 * where it lies. The field list is no longer cut at 400, which dropped strips
 * near the base in busy areas (Overpass returns by id, not by distance).
 */
export async function findAerodromes(
  centre: LatLon,
  radiusNm = 60,
  /** Skip the runway query. A helicopter doesn't need it, and it's the slow half. */
  withRunways = true,
): Promise<Aerodrome[]> {
  const b = bbox(centre, radiusNm);
  const elements = (await overpass(
    `[out:json][timeout:25];(node["aeroway"~"^(aerodrome|airstrip)$"](${b});way["aeroway"~"^(aerodrome|airstrip)$"](${b});relation["aeroway"="aerodrome"](${b}););out center 1500;`,
  )) ?? [];

  // Unnamed strips are named once their runway, and so their surface, is known.
  const unnamed = new Set<Aerodrome>();
  const fields = elements
    .map((e): Aerodrome | null => {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      const t = e.tags ?? {};
      if (typeof lat !== "number" || typeof lon !== "number") return null;
      const icao: string | null = t.icao ?? t.faa ?? t.ref ?? t.name ?? null;
      const strip = t.aeroway === "airstrip";
      if (!icao && !strip) return null;
      // An airstrip node can carry its own length and surface; a drawn one is
      // measured below with the runways.
      const ft = strip && e.type === "node" ? runwayFeet({ tags: t }) : null;
      const field: Aerodrome = {
        icao: String(icao ?? ""),
        lat,
        lon,
        runway_ft: ft,
        surface: strip ? (t.surface ?? null) : null,
      };
      if (!icao) unnamed.add(field);
      return field;
    })
    .filter((a): a is Aerodrome => a !== null);

  const nameStrips = (list: Aerodrome[]) => {
    const used = new Set(list.filter((f) => !unnamed.has(f)).map((f) => f.icao.toUpperCase()));
    for (const f of list) {
      if (!unnamed.has(f)) continue;
      const name = stripName(centre, f, f.surface);
      let unique = name;
      for (let n = 2; used.has(unique.toUpperCase()); n++) unique = `${name} (${n})`;
      used.add(unique.toUpperCase());
      f.icao = unique;
    }
    return list;
  };
  if (!withRunways) return nameStrips(fields);

  const runways = (await overpass(
    `[out:json][timeout:25];way["aeroway"~"^(runway|airstrip)$"](${b});out tags geom;`,
    30_000,
  )) ?? [];

  const waterOnly = new Set<Aerodrome>();
  const lone: Aerodrome[] = [];
  for (const r of runways as OsmWay[]) {
    const pts = wayPoints(r);
    if (pts.length === 0) continue;
    const mid = {
      lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
      lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
    };
    const surface: string | null = r.tags?.surface ?? null;
    const ft = runwayFeet(r);
    let owner: Aerodrome | null = null;
    let ownerNm = RUNWAY_MATCH_NM;
    for (const f of fields) {
      const d = nmBetween(f, mid);
      if (d <= ownerNm) {
        ownerNm = d;
        owner = f;
      }
    }
    if (!owner) {
      // A strip with no field drawn around it: a farm or bush strip. Water
      // lanes and model-aircraft runways aren't.
      if (surfaceClass(surface) === "water" || ft === null || ft < STRIP_MIN_FT) continue;
      const tagText = Object.entries(r.tags ?? {}).flat().join(" ");
      if (/model/i.test(tagText)) continue;
      lone.push({ icao: "", lat: mid.lat, lon: mid.lon, runway_ft: ft, surface });
      continue;
    }

    if (surfaceClass(surface) === "water") {
      waterOnly.add(owner);
      continue;
    }
    if (ft === null) continue;
    if (owner.runway_ft === null || ft > owner.runway_ft) {
      owner.runway_ft = ft;
      owner.surface = surface;
    }
  }
  // A seaplane base: runways mapped, none of them land.
  for (const f of waterOnly) if (f.runway_ft === null) f.runway_ft = 0;

  // Longest first, so a strip drawn as two crossing runways keeps its longer one.
  for (const s of lone.sort((x, y) => (y.runway_ft ?? 0) - (x.runway_ft ?? 0))) {
    if (fields.some((f) => nmBetween(f, s) <= STRIP_MERGE_NM)) continue;
    unnamed.add(s);
    fields.push(s);
  }

  return nameStrips(fields);
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
// Placement sites
// ---------------------------------------------------------------------------

/**
 * The ground around a base, as MSFS sees it.
 *
 * Everything a contract needs to be put somewhere real. Without it the app had
 * no idea whether a base was coastal, so it cheerfully generated "vessel in
 * distress" in the middle of Kansas; and it had no idea where a road was, so a
 * motorway pile-up landed in a paddock two miles from an airfield.
 *
 * MSFS builds its coastlines, water, roads and buildings from the same OSM data
 * queried here, so a road found here is a road you can actually put a
 * helicopter down on.
 *
 * Returns null when Overpass could not be reached -- see `overpass` above for
 * why that is not the same as "nothing here".
 */
export type SiteFeatures = {
  /** Coastline ways in OSM order. By convention land is left, water is right. */
  coastline: LatLon[][];
  /** Closed water polygons, as centre plus half-diagonal in nm. */
  lakes: { centre: LatLon; radiusNm: number; ring: LatLon[] }[];
  rivers: LatLon[][];
  beaches: LatLon[][];
  /** Motorway, trunk and primary carriageways -- somewhere to put a crash. */
  roads: { ref: string | null; geometry: LatLon[] }[];
  /**
   * Mapped cliff faces -- somewhere a climber can actually be stuck.
   *
   * A cliff rescue used to be placed by stepping a random 0.6-3.6 nm off an
   * airfield, which on a fjord coast is open water half the time: "Black
   * Point" went into Howe Sound. Measured, OSM maps 400+ cliffs within 40 nm
   * of Squamish, the nearest being the Chief 4.4 nm from the field.
   */
  /** Undefined when the cliff lookup failed: unknown, not "no cliffs here". */
  cliffs?: LatLon[][];
  /** Somewhere to take the casualty that isn't your own hangar. */
  hospitals: { lat: number; lon: number; name: string; emergency: boolean }[];
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

export async function findSites(centre: LatLon, radiusNm = 60): Promise<SiteFeatures | null> {
  const b = bbox(centre, radiusNm);
  // One union query per contract batch. `natural=water` catches lakes and
  // reservoirs; rivers are queried separately because they are line features
  // and a riverbank scene wants the centreline, not a polygon.
  // Two `out` statements, one query. Coastline gets its own budget because it
  // is what every offshore placement is checked against, and a single shared
  // cap let 118 river ways crowd it out -- which is how vessels ended up in
  // Fall River.
  //
  // Cliffs are asked for alongside rather than inside this query. It already
  // runs 15-20 s against the public instance; anything added to one union
  // is something that can push the whole scan into a timeout, and then the
  // base loses its roads, water and hospitals for the sake of its cliffs.
  const cliffsP = findCliffs(centre, radiusNm);
  const elements = await overpass(
    `[out:json][timeout:60];` +
      `way["natural"="coastline"](${b});out geom 3000;` +
      `(way["natural"="water"](${b});` +
      `way["waterway"="river"](${b});` +
      `way["natural"="beach"](${b}););` +
      `out geom 800;` +
      // Roads a helicopter can be closed onto, and hospitals to deliver to.
      // Both get their own budget for the same reason coastline does.
      //
      // Two passes, because a cap plus Overpass's id ordering is not the same
      // as "the nearest roads". Asked once over the whole box, the 400 that
      // came back were all 30+ nm away in Boston while the trunk road running
      // past the airfield was cut. The tight pass guarantees the near field.
      `way["highway"~"^(motorway|trunk|primary)$"](around:${Math.round(radiusNm * 0.3 * 1852)},${centre.lat},${centre.lon});out geom 250;` +
      `way["highway"~"^(motorway|trunk|primary)$"](${b});out geom 400;` +
      `(way["amenity"="hospital"](${b});node["amenity"="hospital"](${b}););` +
      `out center 80;`,
    // Broad area lookups against the public instance measure 15-20s. This runs
    // once per base and the result is cached, so a generous budget is cheaper
    // than aborting and leaving the base's water unknown.
    60_000,
  );
  if (elements === null) return null;

  const out: SiteFeatures = {
    coastline: [], lakes: [], rivers: [], beaches: [], roads: [], hospitals: [],
  };

  const seenRoads = new Set<number>();

  for (const e of elements) {
    const t = e.tags ?? {};

    // Hospitals arrive as a node or as a way with `out center`, so they are
    // handled before the geometry requirement below.
    if (t.amenity === "hospital") {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      const name: string = t.name ?? "the receiving hospital";
      // OSM tags rehab units, psychiatric hospitals and long-term care the same
      // way it tags a trauma centre. None of them take a helicopter casualty,
      // and "deliver to Hebrew Rehabilitation Center" reads as a bug.
      const acute = !NON_ACUTE.test(name) && t.emergency !== "no";
      if (typeof lat === "number" && typeof lon === "number" && acute) {
        out.hospitals.push({ lat, lon, name, emergency: t.emergency === "yes" });
      }
      continue;
    }

    if (!Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const ring: LatLon[] = e.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon }));

    if (t.highway) {
      if (seenRoads.has(e.id)) continue;
      seenRoads.add(e.id);
      out.roads.push({ ref: t.ref ?? t.name ?? null, geometry: ring });
    } else if (t.natural === "coastline") {
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

  // Null from the cliff lookup is "could not ask", recorded as unknown.
  out.cliffs = (await cliffsP) ?? undefined;
  return out;
}

/**
 * Mapped cliff faces around a point, or null when Overpass could not be reached.
 *
 * Near field first, for the same reason as roads: around Squamish the wide
 * pass alone hit its 400 cap, and a cap in id order is not the nearest 400.
 * Kept separate from `findSites` so a slow cliff lookup never costs a base its
 * roads and water, and so a base scanned before cliffs existed can have just
 * its cliffs filled in -- a fraction of a full rescan.
 */
export async function findCliffs(centre: LatLon, radiusNm = 60): Promise<LatLon[][] | null> {
  const b = bbox(centre, radiusNm);
  const elements = await overpass(
    `[out:json][timeout:40];` +
      `way["natural"="cliff"](around:${Math.round(radiusNm * 0.4 * 1852)},${centre.lat},${centre.lon});out geom 250;` +
      `way["natural"="cliff"](${b});out geom 400;`,
    45_000,
  );
  if (elements === null) return null;

  // Both passes return the near cliffs; keep one copy of each.
  const seen = new Set<number>();
  const out: LatLon[][] = [];
  for (const e of elements) {
    if (!Array.isArray(e.geometry) || e.geometry.length < 2 || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Industry sites
// ---------------------------------------------------------------------------

/**
 * A real-world feature that anchors one stage of an industry chain.
 *
 * `tier` mirrors the two-stage chains in `goods.ts`: 1 is extraction (a
 * forest, a farm, a quarry, a well), 2 is processing (a sawmill, a works). OSM
 * tags a raw-material *site* -- a forest, farmland, a quarry -- far more
 * reliably than it tags a *processing plant*, which is usually just
 * `landuse=industrial` with a name if you are lucky. So tier 2 sites carry a
 * confidence flag: `named` means the classification came from the feature's
 * own name, `guessed` means it is an unlabelled industrial area near a tier 1
 * site and the pairing is an assumption, not a read fact.
 */
export type IndustrySite = {
  kind:
    | "forest" | "sawmill"
    | "farmland" | "grain_mill"
    | "oil_well" | "refinery"
    | "quarry" | "steel_works";
  tier: 1 | 2;
  lat: number;
  lon: number;
  name: string | null;
  confidence: "named" | "guessed";
};

/** Name fragments that identify a tier-2 processing site, by chain. */
const PROCESSING_NAME: Record<string, RegExp> = {
  grain_mill: /\bmill\b|grain|flour/i,
  refinery: /refin|petrol|oil\b/i,
  steel_works: /steel|iron\s*works|foundry|smelt/i,
};

export async function findIndustrySites(
  centre: LatLon,
  radiusNm = 50,
): Promise<IndustrySite[] | null> {
  const b = bbox(centre, radiusNm);
  // Tier-1 sites use real, common OSM tags -- forests, farmland and quarries
  // are reliably mapped almost everywhere. Tier-2 processing has no equally
  // reliable tag, so it is read from generic industrial land plus a name
  // heuristic, same technique the hospital-vs-rehab filter already uses.
  // Learned the hard way on the water/road scan: one shared output budget
  // across several tag types starves whichever ones return last, not the
  // ones you actually need. Six tags here, six budgets -- industrial land is
  // by far the noisiest, so it gets the smallest one.
  const elements = await overpass(
    `[out:json][timeout:60];` +
      `way["landuse"="forest"](${b});out center 200;` +
      `way["landuse"="farmland"](${b});out center 200;` +
      `way["landuse"="quarry"](${b});out center 100;` +
      `(node["craft"="sawmill"](${b});way["craft"="sawmill"](${b}););out center 60;` +
      `(node["man_made"="petroleum_well"](${b});way["man_made"="petroleum_well"](${b}););out center 60;` +
      `way["landuse"="industrial"](${b});out center 150;`,
    60_000,
  );
  if (elements === null) return null;

  const out: IndustrySite[] = [];
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const t = e.tags ?? {};
    const name: string | null = t.name ?? null;

    if (t.landuse === "forest") {
      out.push({ kind: "forest", tier: 1, lat, lon, name, confidence: "named" });
    } else if (t.landuse === "farmland") {
      out.push({ kind: "farmland", tier: 1, lat, lon, name, confidence: "named" });
    } else if (t.landuse === "quarry") {
      out.push({ kind: "quarry", tier: 1, lat, lon, name, confidence: "named" });
    } else if (t.craft === "sawmill") {
      out.push({ kind: "sawmill", tier: 2, lat, lon, name, confidence: "named" });
    } else if (t.man_made === "petroleum_well") {
      out.push({ kind: "oil_well", tier: 1, lat, lon, name, confidence: "named" });
    } else if (t.landuse === "industrial" && name) {
      // Unlabelled industrial land is not placed at all -- a processing site
      // synthesised near its tier-1 supplier (see missions/industries.ts) is
      // more honest than a guess with nothing behind it.
      if (PROCESSING_NAME.grain_mill.test(name)) {
        out.push({ kind: "grain_mill", tier: 2, lat, lon, name, confidence: "named" });
      } else if (PROCESSING_NAME.refinery.test(name)) {
        out.push({ kind: "refinery", tier: 2, lat, lon, name, confidence: "named" });
      } else if (PROCESSING_NAME.steel_works.test(name)) {
        out.push({ kind: "steel_works", tier: 2, lat, lon, name, confidence: "named" });
      }
    }
  }
  return out;
}

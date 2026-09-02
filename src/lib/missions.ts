/**
 * Mission scenes and objectives.
 *
 * A contract is no longer "fly ICAO to ICAO". It has a *scene* -- a point on
 * the map with a type (a vessel, a ridgeline, a closed highway) -- and an
 * ordered list of objectives the sim bridge ticks off from live telemetry:
 * reach the scene, hold a hover, deploy the hoist, take on the casualty, get
 * them to a hospital.
 *
 * Scenes are generated relative to the company's base, so they work wherever in
 * the world you operate. Placement uses two real-world hints, because nothing
 * here can read the sim's terrain directly:
 *
 *   - airports, from the sim's own facility cache, stand in for solid ground
 *   - OSM coastlines, lakes and rivers -- the same data MSFS renders water
 *     from -- stand in for water
 *
 * A base with no water near it is not offered water contracts at all, and one
 * that is coastal gets its vessels placed on actual sea rather than on a bearing
 * that merely looked empty.
 */

import type { AircraftTag } from "./game-data";
import {
  findPowerLines, pathLengthNm, samplePath, bearingBetween,
  type WaterFeatures,
} from "./osm";

export type SceneType =
  | "vessel"
  | "oil_rig"
  | "cliff"
  | "beach"
  | "ridgeline"
  | "forest"
  | "riverbank"
  | "highway"
  | "field"
  | "rooftop"
  | "confined";

export const SCENE_LABELS: Record<SceneType, string> = {
  vessel: "Vessel at sea",
  oil_rig: "Offshore platform",
  cliff: "Cliff face",
  beach: "Beach",
  ridgeline: "Mountain ridgeline",
  forest: "Forest clearing",
  riverbank: "Riverbank",
  highway: "Highway",
  field: "Open field",
  rooftop: "Rooftop pad",
  confined: "Confined area",
};

/** How the scene is described in a briefing, for flavour that reads right. */
const SCENE_FLAVOUR: Record<SceneType, string[]> = {
  vessel: ["a fishing vessel", "a stricken yacht", "a cargo ship's foredeck"],
  oil_rig: ["the platform helideck", "the rig's aft deck"],
  cliff: ["a ledge partway down the cliff", "an exposed rock face"],
  beach: ["the tideline", "a stretch of open sand"],
  ridgeline: ["an exposed saddle", "the ridge below the summit"],
  forest: ["a small clearing in the treeline", "a logging cut"],
  riverbank: ["a gravel bar mid-river", "the far bank"],
  highway: ["a closed carriageway", "the hard shoulder"],
  field: ["a farmer's field", "open pasture beside the road"],
  rooftop: ["the hospital rooftop pad", "a tower helipad"],
  confined: ["a walled yard", "a clearing barely wider than the disc"],
};

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export type Objective =
  /** Get within `radius_nm` of a point. */
  | { id: string; kind: "reach"; label: string; lat: number; lon: number; radius_nm: number }
  /** Hold a low, slow hover -- the hard part of most rotary work. */
  | { id: string; kind: "hover"; label: string; max_agl_ft: number; max_gs_kts: number; hold_seconds: number }
  /** Winch out and back. */
  | { id: string; kind: "hoist"; label: string; min_deployed_pct: number }
  /** Hook up an underslung load. */
  | { id: string; kind: "sling"; label: string }
  /** Set the load down where it was asked for. */
  | { id: string; kind: "sling_release"; label: string; lat: number; lon: number; radius_nm: number }
  /** Weight comes aboard -- a casualty, a crew, cargo. */
  | { id: string; kind: "payload"; label: string; min_delta_lb: number }
  /** Put the skids down away from an airport. */
  | { id: string; kind: "land_off"; label: string; lat: number; lon: number; radius_nm: number }
  /** Land back at a named field. */
  | { id: string; kind: "land"; label: string; icao: string | null; radius_nm: number }
  /** Pass over a point at low level -- inspection work along a route. */
  | { id: string; kind: "overfly"; label: string; lat: number; lon: number; radius_nm: number; max_agl_ft: number };

export type ObjectiveKind = Objective["kind"];

/** Abstract steps a template asks for; coordinates are filled in at generation. */
export type Step =
  | "reach_scene"
  | "hover_scene"
  | "hoist_recover"
  | "sling_attach"
  | "sling_release"
  | "take_on_load"
  | "land_scene"
  | "deliver"
  | "return_base";

export type SceneMissionTemplate = {
  role: string;
  title: string;
  /** `{scene}` is replaced with a flavour phrase for the scene type. */
  brief: string;
  scene_type: SceneType;
  required_tags: AircraftTag[];
  required_certs: string[];
  min_payload: number;
  base_payout: number;
  /** How far the scene sits from base, in nautical miles. */
  scene_range: [number, number];
  difficulty: number;
  weather_factor: number;
  steps: Step[];
  /** Hover tolerances, tightened for hard scenes. */
  hover_agl?: number;
  hover_seconds?: number;
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Point at `distanceNm` along `bearingDeg` from a start position. */
export function offsetPosition(lat: number, lon: number, distanceNm: number, bearingDeg: number) {
  const d = distanceNm / R_NM;
  const b = toRad(bearingDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return {
    lat: Number(toDeg(la2).toFixed(5)),
    // Keep longitude in -180..180 after crossing the antimeridian.
    lon: Number((((toDeg(lo2) + 540) % 360) - 180).toFixed(5)),
  };
}

export function distanceNm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export type Airport = { icao: string; lat: number; lon: number };

/**
 * Closest airport to a point, from the base's reported scatter.
 *
 * This is what the app can offer for diversion/refuel planning without any
 * new data source -- the bridge already sends up to 200 airports around each
 * base for land-anchoring scenes, so reusing it here is free.
 */
export function nearestAirport(
  lat: number,
  lon: number,
  airports: Airport[] | undefined,
): { icao: string; distance_nm: number } | null {
  if (!airports || airports.length === 0) return null;
  let best: Airport | null = null;
  let bestNm = Infinity;
  for (const a of airports) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    const d = distanceNm(lat, lon, a.lat, a.lon);
    if (d < bestNm) {
      bestNm = d;
      best = a;
    }
  }
  return best ? { icao: best.icao, distance_nm: Number(bestNm.toFixed(1)) } : null;
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

/**
 * What kind of water each scene needs, if any.
 *
 *   sea    -- genuine coastline. An oil platform does not belong on a reservoir.
 *   open   -- coastline, or a lake big enough to lose a boat on.
 *   shore  -- a waterline to stand on: a mapped beach, or the coast itself.
 *   river  -- flowing water.
 */
export const SCENE_WATER_NEED: Partial<
  Record<SceneType, "sea" | "open" | "shore" | "river">
> = {
  vessel: "open",
  oil_rig: "sea",
  beach: "shore",
  riverbank: "river",
};

/**
 * Usable water positions near a base, reduced from OSM geometry.
 *
 * Stored on the base rather than recomputed: the Overpass lookup is a 15-20
 * second area query, and the water near an airfield does not move. Points are
 * [lat, lon] pairs to keep the cached JSON small.
 */
export type WaterSites = {
  /** Out to sea, perpendicular to the coast, at a spread of distances. */
  offshore: [number, number][];
  /** Inside a lake large enough to matter. */
  lake: [number, number][];
  /** On a mapped beach, or on the coastline itself. */
  shore: [number, number][];
  /** On a river centreline. */
  river: [number, number][];
};

export type WaterAvailability = { sea: boolean; open: boolean; shore: boolean; river: boolean };

/**
 * Half-diagonal below which a lake is not open water.
 *
 * 2 nm -- roughly 4 nm across -- deliberately excludes the ordinary reservoir.
 * A stricken cargo ship on a Kansas irrigation lake reads as a bug, and the
 * briefings for vessel work talk about foredecks and yachts.
 */
const LAKE_MIN_NM = 2.0;

/** Every nth element, so one long way cannot crowd out all the others. */
function stride<T>(xs: T[], want: number): T[] {
  if (xs.length <= want) return xs;
  const step = Math.ceil(xs.length / want);
  return xs.filter((_, i) => i % step === 0);
}

const asSite = (p: { lat: number; lon: number }): [number, number] => [
  Number(p.lat.toFixed(5)),
  Number(p.lon.toFixed(5)),
];

type Pt = { lat: number; lon: number };

/** Do segments a-b and c-d properly cross? Treated as flat; fine at these scales. */
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const side = (p: Pt, q: Pt, r: Pt) =>
    (r.lon - p.lon) * (q.lat - p.lat) - (r.lat - p.lat) * (q.lon - p.lon);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/**
 * Does the run from shore out to `to` cross a coastline on the way?
 *
 * Stepping perpendicular to the coast is only sound while the water stays open.
 * On the inner shore of a bay, or across a narrow peninsula, 20 nm "seaward"
 * can step clean over the land and put a stricken yacht in somebody's garden.
 * A crossing means we left the water, so the candidate is discarded.
 */
function crossesCoast(from: Pt, to: Pt, coastline: Pt[][]) {
  const loLat = Math.min(from.lat, to.lat), hiLat = Math.max(from.lat, to.lat);
  const loLon = Math.min(from.lon, to.lon), hiLon = Math.max(from.lon, to.lon);

  for (const way of coastline) {
    for (let i = 0; i + 1 < way.length; i++) {
      const p = way[i];
      const q = way[i + 1];
      // Cheap reject before the real test: most segments are nowhere near.
      if (Math.min(p.lat, q.lat) > hiLat || Math.max(p.lat, q.lat) < loLat) continue;
      if (Math.min(p.lon, q.lon) > hiLon || Math.max(p.lon, q.lon) < loLon) continue;
      if (segmentsCross(from, to, p, q)) return true;
    }
  }
  return false;
}

/**
 * The coastline segment nearest this point: which side it falls on, and how
 * far away it is.
 *
 * OSM draws coastline with the land on its left, so for any segment the water
 * lies to its right. Finding the closest segment to a candidate and checking
 * which side it falls on is a purely local test -- unlike tracing a ray back to
 * shore, it does not care whether the rest of the world's coastline made it
 * into the query.
 *
 * That matters because stepping perpendicular from one shore is not enough on
 * its own: measured against Cape Cod it put vessels in Fall River, Warwick and
 * Swansea, because the coastline that would have revealed the crossing had been
 * clipped away. The nearest segment to those points is the shore they walked
 * over, and they sit on its landward side.
 *
 * Longitude is scaled by cos(latitude) so "nearest" is a real distance. The
 * side test needs no such correction: scaling one axis by a positive constant
 * cannot change the sign of the cross product.
 */
function nearestCoast(p: Pt, coastline: Pt[][]) {
  const kx = Math.cos((p.lat * Math.PI) / 180);
  let bestD2 = Infinity;
  let bestSide = 0;

  for (const way of coastline) {
    for (let i = 0; i + 1 < way.length; i++) {
      // Both ends relative to the candidate, so the candidate sits at the origin.
      const ax = (way[i].lon - p.lon) * kx;
      const ay = way[i].lat - p.lat;
      const bx = (way[i + 1].lon - p.lon) * kx;
      const by = way[i + 1].lat - p.lat;

      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d2 = cx * cx + cy * cy;

      if (d2 < bestD2) {
        bestD2 = d2;
        // Sign of (b-a) x (p-a). Negative means p is to the right: the water.
        bestSide = ax * dy - ay * dx;
      }
    }
  }

  if (bestD2 === Infinity) return null;
  // bestD2 is in squared degrees of latitude; 60 nm to the degree.
  return { waterSide: bestSide < 0, distNm: Math.sqrt(bestD2) * 60 };
}

/**
 * Reduce raw OSM water to the handful of positions a contract can actually use.
 *
 * The offshore points are the interesting part. OSM draws coastline with the
 * land on its left and the water on its right, so a segment's bearing plus 90
 * degrees always points out to sea. That convention is what makes this reliable
 * rather than a guess -- there is no need to know which way the continent faces.
 */
export function summariseWater(
  w: WaterFeatures,
  centre: { lat: number; lon: number },
  radiusNm: number,
): WaterSites {
  const sites: WaterSites = { offshore: [], lake: [], shore: [], river: [] };
  // Raw coast is a fallback for beach scenes, not an equal: a mapped beach is
  // sand, a coastline node might be a cliff or a dock.
  const coastShore: [number, number][] = [];
  // Overpass clips geometry to the bounding box, so anything beyond it is
  // unverifiable. Keep a margin inside the edge rather than trusting it exactly.
  const verifiable = radiusNm * 0.85;

  for (const way of w.coastline) {
    const step = Math.max(1, Math.ceil((way.length - 1) / 6));
    for (let i = 0; i + 1 < way.length; i += step) {
      const a = way[i];
      const b = way[i + 1];
      if (a.lat === b.lat && a.lon === b.lon) continue;
      const seaward = (bearingBetween(a, b) + 90) % 360;
      // Start the ray just clear of the shore so the origin's own segment does
      // not register as a crossing.
      const wet = offsetPosition(a.lat, a.lon, 0.25, seaward);
      // A spread of distances so a yacht 3 nm out and a platform 12 nm out both
      // have somewhere to be. Stop at the first offset that leaves the water:
      // everything further along the same bearing is over land too.
      //
      // These stay short deliberately. The crossing test is only as good as the
      // coastline we were given, and that is clipped to the query box and capped
      // in element count -- a 30 nm step outruns it and lands in Massachusetts.
      // Nothing starts closer in than 3 nm either: stepping 1.5 nm off a shore
      // point on an inlet as convoluted as Cohasset's simply crosses it.
      for (const off of [3, 6, 9, 12]) {
        const p = offsetPosition(a.lat, a.lon, off, seaward);
        // Outside the queried area there is no coastline to check against, so
        // the candidate cannot be trusted however clean the ray looks.
        if (distanceNm(centre.lat, centre.lon, p.lat, p.lon) > verifiable) break;
        if (crossesCoast(wet, p, w.coastline)) break;
        const near = nearestCoast(p, w.coastline);
        if (near) {
          // Belt and braces: the ray can look clean when the coastline that
          // would have blocked it is simply missing from the query.
          if (!near.waterSide) break;
          // A point placed `off` nm straight out to sea should be roughly that
          // far from the nearest shore. Much closer means we are up an inlet or
          // have stepped over a spit, whatever the side test says.
          //
          // Held tight at 80%: a concave bay legitimately puts some other shore
          // nearer than `off`, so this does discard good candidates -- but there
          // are 150 of them and only a handful are needed, and the alternative
          // is a stricken yacht in a Cohasset furniture shop.
          if (near.distNm < off * 0.8) break;
        }
        sites.offshore.push(asSite(p));
      }
    }
    for (const p of stride(way, 6)) coastShore.push(asSite(p));
  }

  for (const l of w.lakes) {
    if (l.radiusNm < LAKE_MIN_NM) continue;
    for (let i = 0; i < 3; i++) {
      sites.lake.push(
        asSite(offsetPosition(
          l.centre.lat, l.centre.lon,
          l.radiusNm * 0.45 * Math.random(), Math.random() * 360,
        )),
      );
    }
  }

  // A lake shoreline is not a beach. Only somewhere OSM actually tagged as one.
  for (const way of w.beaches) for (const p of stride(way, 6)) sites.shore.push(asSite(p));
  if (sites.shore.length === 0) sites.shore = coastShore;
  for (const way of w.rivers) for (const p of stride(way, 6)) sites.river.push(asSite(p));

  return {
    offshore: stride(sites.offshore, 150),
    lake: stride(sites.lake, 150),
    shore: stride(sites.shore, 150),
    river: stride(sites.river, 150),
  };
}

/**
 * Read a cached `water_sites` blob back, tolerating anything malformed.
 *
 * An all-empty result is a real answer -- "we looked, there is no water here" --
 * so it is returned as an empty WaterSites rather than null. Only the shape
 * being wrong yields null. Whether a base has been scanned at all is recorded
 * separately in `water_scanned_at`; conflating the two would make a waterless
 * base rescan on every batch and, whenever a rescan was rate-limited, quietly
 * put the vessels back in the wheat.
 */
export function parseWaterSites(raw: unknown): WaterSites | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const arr = (k: string): [number, number][] =>
    (Array.isArray(o[k]) ? (o[k] as unknown[]) : [])
      .filter(
        (p): p is [number, number] =>
          Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
      .map((p) => [Number(p[0]), Number(p[1])]);
  return {
    offshore: arr("offshore"), lake: arr("lake"),
    shore: arr("shore"), river: arr("river"),
  };
}

export function waterAvailability(s: WaterSites | null): WaterAvailability | null {
  if (!s) return null;
  return {
    sea: s.offshore.length > 0,
    open: s.offshore.length > 0 || s.lake.length > 0,
    shore: s.shore.length > 0,
    river: s.river.length > 0,
  };
}

/**
 * Can this scene type honestly be flown from this base?
 *
 * A null availability means the water is unknown -- never scanned, or Overpass
 * did not answer. Half the mission board is not worth losing to a network blip,
 * so an unknown answer lets everything through and placement falls back to the
 * old bearing guess.
 */
export function sceneIsFlyable(type: SceneType, avail: WaterAvailability | null): boolean {
  const need = SCENE_WATER_NEED[type];
  if (!need || !avail) return true;
  return avail[need];
}

function sitesFor(need: "sea" | "open" | "shore" | "river", s: WaterSites) {
  if (need === "sea") return s.offshore;
  if (need === "open") return [...s.offshore, ...s.lake];
  if (need === "shore") return s.shore;
  return s.river;
}


/**
 * Choose where a scene sits.
 *
 * Land scenes anchor to airports: an airport is always on ground you can land
 * on, and the sim's facility cache gives us a scatter of them around the base.
 *
 * Water scenes anchor to actual OSM water. Before that they took the "emptiest
 * bearing" from base on the theory that empty means sea -- which inland just
 * means empty farmland, and is why a vessel could end up in a wheat field.
 */
function placeScene(
  type: SceneType,
  base: { lat: number; lon: number; airports?: Airport[]; water?: WaterSites | null },
  rangeNm: number,
) {
  const need = SCENE_WATER_NEED[type];
  if (need && base.water) {
    const cands = sitesFor(need, base.water);
    if (cands.length > 0) {
      // Closest to the distance the template asked for, with enough spread that
      // six contracts don't all stack on one headland.
      const ranked = cands
        .map(([lat, lon]) => ({
          lat, lon,
          off: Math.abs(distanceNm(base.lat, base.lon, lat, lon) - rangeNm),
        }))
        .sort((a, b) => a.off - b.off);
      const p = pick(ranked.slice(0, Math.min(10, ranked.length)));
      return { lat: p.lat, lon: p.lon };
    }
  }

  const airports = (base.airports ?? []).filter(
    (a) => Number.isFinite(a.lat) && Number.isFinite(a.lon),
  );

  if (airports.length === 0) {
    return offsetPosition(base.lat, base.lon, rangeNm, Math.random() * 360);
  }

  if (need) {
    // No water data. Fall back to the old heuristic rather than refusing to
    // place the scene at all.
    let bestBearing = Math.random() * 360;
    let fewest = Infinity;
    for (let b = 0; b < 360; b += 15) {
      const probe = offsetPosition(base.lat, base.lon, rangeNm, b);
      const near = airports.filter(
        (a) => distanceNm(probe.lat, probe.lon, a.lat, a.lon) < rangeNm * 0.5,
      ).length;
      if (near < fewest) {
        fewest = near;
        bestBearing = b + (Math.random() * 10 - 5);
      }
    }
    return offsetPosition(base.lat, base.lon, rangeNm, bestBearing);
  }

  // Land scene: anchor to an airport roughly the right distance out, then step
  // a little way off it so the site isn't sitting on the runway.
  const ranked = airports
    .map((a) => ({ a, d: distanceNm(base.lat, base.lon, a.lat, a.lon) }))
    .filter((x) => x.d > 1)
    .sort((x, y) => Math.abs(x.d - rangeNm) - Math.abs(y.d - rangeNm));

  if (ranked.length === 0) {
    return offsetPosition(base.lat, base.lon, rangeNm, Math.random() * 360);
  }

  // Pick among the closest few matches so contracts don't all stack on one field.
  const anchor = pick(ranked.slice(0, Math.min(5, ranked.length))).a;
  const offNm = 0.6 + Math.random() * 3;
  return offsetPosition(anchor.lat, anchor.lon, offNm, Math.random() * 360);
}

// ---------------------------------------------------------------------------
// Templates -- real rotary work
// ---------------------------------------------------------------------------

export const SCENE_TEMPLATES: SceneMissionTemplate[] = [
  // --- Search and rescue ---------------------------------------------------
  {
    role: "sar",
    title: "Vessel in Distress",
    brief: "Crew member with serious injuries aboard {scene}. Hoist required — the deck is too small to land on.",
    scene_type: "vessel",
    required_tags: ["sar"], required_certs: ["hoist", "sar"],
    min_payload: 600, base_payout: 14000, scene_range: [18, 55],
    difficulty: 4, weather_factor: 3,
    steps: ["reach_scene", "hover_scene", "hoist_recover", "take_on_load", "deliver"],
    hover_agl: 120, hover_seconds: 30,
  },
  {
    role: "sar",
    title: "Cliff Rescue",
    brief: "Climber stranded on {scene}. No landing area — winch the casualty off and get them to hospital.",
    scene_type: "cliff",
    required_tags: ["sar"], required_certs: ["hoist", "sar"],
    min_payload: 500, base_payout: 12500, scene_range: [10, 35],
    difficulty: 5, weather_factor: 3,
    steps: ["reach_scene", "hover_scene", "hoist_recover", "take_on_load", "deliver"],
    hover_agl: 90, hover_seconds: 35,
  },
  {
    role: "sar",
    title: "Beach Extraction",
    brief: "Swimmer pulled from the surf, unconscious at {scene}. Land if you can, hoist if you can't.",
    scene_type: "beach",
    required_tags: ["sar"], required_certs: ["sar"],
    min_payload: 500, base_payout: 8600, scene_range: [8, 30],
    difficulty: 3, weather_factor: 2,
    steps: ["reach_scene", "hover_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 150, hover_seconds: 20,
  },
  {
    role: "sar",
    title: "Ridgeline Recovery",
    brief: "Two hikers benighted on {scene}. High density altitude — watch your power margin.",
    scene_type: "ridgeline",
    required_tags: ["sar"], required_certs: ["hoist", "sar"],
    min_payload: 800, base_payout: 16500, scene_range: [15, 45],
    difficulty: 5, weather_factor: 4,
    steps: ["reach_scene", "hover_scene", "hoist_recover", "take_on_load", "deliver"],
    hover_agl: 100, hover_seconds: 40,
  },
  {
    role: "sar",
    title: "Swiftwater Rescue",
    brief: "Vehicle swept into the river; occupant clinging to {scene}. Rising water — time matters.",
    scene_type: "riverbank",
    required_tags: ["sar"], required_certs: ["hoist", "sar"],
    min_payload: 400, base_payout: 11000, scene_range: [6, 25],
    difficulty: 4, weather_factor: 3,
    steps: ["reach_scene", "hover_scene", "hoist_recover", "take_on_load", "deliver"],
    hover_agl: 80, hover_seconds: 30,
  },

  // --- Medevac -------------------------------------------------------------
  {
    role: "medevac",
    title: "Highway RTC",
    brief: "Multi-vehicle collision. Police have closed {scene} for you — land on the carriageway, wires either side.",
    scene_type: "highway",
    required_tags: ["medevac"], required_certs: ["medevac"],
    min_payload: 600, base_payout: 9500, scene_range: [8, 40],
    difficulty: 3, weather_factor: 2,
    steps: ["reach_scene", "hover_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 200, hover_seconds: 15,
  },
  {
    role: "medevac",
    title: "Cardiac Callout",
    brief: "Chest pain in a rural property. Nearest LZ is {scene}. Straight in, load, and run to the receiving hospital.",
    scene_type: "field",
    required_tags: ["medevac"], required_certs: ["medevac"],
    min_payload: 550, base_payout: 7800, scene_range: [10, 45],
    difficulty: 2, weather_factor: 2,
    steps: ["reach_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 250, hover_seconds: 10,
  },
  {
    role: "medevac",
    title: "Trailhead Evacuation",
    brief: "Compound fracture, miles from a road. LZ is {scene} — tight, and the trees are close.",
    scene_type: "forest",
    required_tags: ["medevac"], required_certs: ["medevac"],
    min_payload: 500, base_payout: 10800, scene_range: [12, 40],
    difficulty: 4, weather_factor: 3,
    steps: ["reach_scene", "hover_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 120, hover_seconds: 25,
  },
  {
    role: "medevac",
    title: "Interfacility Transfer",
    brief: "Stable but time-critical patient moving between hospitals. Departure from {scene}.",
    scene_type: "rooftop",
    required_tags: ["medevac"], required_certs: ["medevac"],
    min_payload: 700, base_payout: 6400, scene_range: [15, 60],
    difficulty: 2, weather_factor: 2,
    steps: ["reach_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 200, hover_seconds: 10,
  },

  // --- Offshore ------------------------------------------------------------
  {
    role: "offshore",
    title: "Platform Crew Change",
    brief: "Six workers out, six back. Deck is {scene} — confirm the deck is clear before committing.",
    scene_type: "oil_rig",
    required_tags: ["offshore"], required_certs: ["offshore"],
    min_payload: 1400, base_payout: 13500, scene_range: [20, 42],
    difficulty: 3, weather_factor: 4,
    steps: ["reach_scene", "land_scene", "take_on_load", "return_base"],
    hover_agl: 200, hover_seconds: 15,
  },
  {
    role: "offshore",
    title: "Platform Medevac",
    brief: "Crush injury on {scene}. Weather is marginal and deteriorating.",
    scene_type: "oil_rig",
    required_tags: ["offshore", "medevac"], required_certs: ["offshore", "medevac"],
    min_payload: 800, base_payout: 18000, scene_range: [25, 42],
    difficulty: 5, weather_factor: 5,
    steps: ["reach_scene", "land_scene", "take_on_load", "deliver"],
    hover_agl: 180, hover_seconds: 20,
  },

  // --- Sling and utility ---------------------------------------------------
  {
    role: "construction",
    title: "Tower Section Lift",
    brief: "Lift a lattice section into place at {scene}. Long line, precise placement, ground crew on the hook.",
    scene_type: "confined",
    required_tags: ["heavy_lift"], required_certs: ["heavy_lift"],
    min_payload: 3000, base_payout: 17500, scene_range: [8, 30],
    difficulty: 4, weather_factor: 3,
    steps: ["reach_scene", "sling_attach", "hover_scene", "sling_release", "return_base"],
    hover_agl: 150, hover_seconds: 40,
  },
  {
    role: "construction",
    title: "Rooftop HVAC Placement",
    brief: "Set a plant unit onto {scene} in the city core. Confined, and the public is watching.",
    scene_type: "rooftop",
    required_tags: ["heavy_lift"], required_certs: ["heavy_lift"],
    min_payload: 2200, base_payout: 15000, scene_range: [5, 25],
    difficulty: 5, weather_factor: 3,
    steps: ["reach_scene", "sling_attach", "hover_scene", "sling_release", "return_base"],
    hover_agl: 120, hover_seconds: 45,
  },
  {
    role: "logistics",
    title: "Remote Camp Resupply",
    brief: "Underslung stores into {scene}. No road access for forty miles.",
    scene_type: "forest",
    required_tags: ["medium_utility", "heavy_lift"], required_certs: [],
    min_payload: 1600, base_payout: 8200, scene_range: [20, 70],
    difficulty: 3, weather_factor: 3,
    steps: ["reach_scene", "sling_attach", "hover_scene", "sling_release", "return_base"],
    hover_agl: 180, hover_seconds: 25,
  },

  // --- Firefighting --------------------------------------------------------
  {
    role: "firefighting",
    title: "Ridge Fire Bucket Run",
    brief: "Fire running up toward {scene}. Fill, drop, repeat — the incident commander wants it flanked.",
    scene_type: "ridgeline",
    required_tags: ["firefighting"], required_certs: ["firefighting"],
    min_payload: 2000, base_payout: 14500, scene_range: [10, 45],
    difficulty: 4, weather_factor: 4,
    steps: ["reach_scene", "sling_attach", "hover_scene", "return_base"],
    hover_agl: 200, hover_seconds: 30,
  },

  // --- Survey / patrol -----------------------------------------------------
  {
    role: "patrol",
    title: "Powerline Patrol",
    brief: "Low-level inspection run terminating at {scene}. Cameras rolling, slow and steady.",
    scene_type: "field",
    required_tags: ["survey", "patrol"], required_certs: [],
    min_payload: 300, base_payout: 5200, scene_range: [25, 80],
    difficulty: 2, weather_factor: 2,
    steps: ["reach_scene", "hover_scene", "return_base"],
    hover_agl: 300, hover_seconds: 20,
  },
];

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GeneratedScene = {
  scene_lat: number;
  scene_lon: number;
  scene_type: SceneType;
  scene_name: string;
  objectives: Objective[];
};

const SITE_NAMES: Partial<Record<SceneType, string[]>> = {
  vessel: ["MV Northern Star", "FV Cape Rose", "MV Aldebaran", "SY Windward"],
  oil_rig: ["Platform Bravo-7", "Selkie Alpha", "Rig Kestrel", "Platform Delta-2"],
  cliff: ["Gannet Head", "The Buttress", "Raven Crag", "Black Point"],
  beach: ["Long Sands", "Shell Cove", "Mill Bay", "Drift Beach"],
  ridgeline: ["Saddleback Ridge", "Storm Col", "The Spine", "High Cairn"],
  forest: ["Larch Cut", "Blackwood Clearing", "Fern Hollow"],
  riverbank: ["Gravel Bar 4", "Otter Reach", "Miller's Crossing"],
  highway: ["Route 12, mile 40", "The bypass", "Highway 6 northbound"],
  field: ["Hillcrest Farm", "Meadow LZ", "Barrow Field"],
  rooftop: ["St. Anne's rooftop", "Central Tower pad", "Mercy General pad"],
  confined: ["the compound yard", "Site 4", "the substation yard"],
};

/**
 * Turn a template into a live contract anchored to the company's base.
 *
 * `baseLat`/`baseLon` come from the base's real position, which the sim bridge
 * fills in the first time it sees the airport. Without it there's no scene to
 * fly to, so the caller falls back to a plain point-to-point contract.
 */
export function generateSceneMission(
  t: SceneMissionTemplate,
  reputation: number,
  base: {
    lat: number; lon: number; icao: string | null;
    airports?: Airport[];
    water?: WaterSites | null;
  },
) {
  const [lo, hi] = t.scene_range;
  const rangeNm = lo + Math.random() * (hi - lo);
  const scene = placeScene(t.scene_type, base, rangeNm);
  // Anchoring to real water or a real airfield moves the site off the requested
  // range, so bill the distance actually flown rather than the one asked for.
  const actualNm = distanceNm(base.lat, base.lon, scene.lat, scene.lon);
  const sceneName = pick(SITE_NAMES[t.scene_type] ?? [SCENE_LABELS[t.scene_type]]);
  const flavour = pick(SCENE_FLAVOUR[t.scene_type]);

  const hoverAgl = t.hover_agl ?? 150;
  const hoverSecs = t.hover_seconds ?? 25;
  const objectives: Objective[] = [];

  for (const step of t.steps) {
    switch (step) {
      case "reach_scene":
        objectives.push({
          id: "reach", kind: "reach",
          label: `Reach ${sceneName}`,
          lat: scene.lat, lon: scene.lon, radius_nm: 0.6,
        });
        break;
      case "hover_scene":
        objectives.push({
          id: "hover", kind: "hover",
          label: `Hold a hover below ${hoverAgl} ft AGL for ${hoverSecs}s`,
          max_agl_ft: hoverAgl, max_gs_kts: 15, hold_seconds: hoverSecs,
        });
        break;
      case "hoist_recover":
        objectives.push({
          id: "hoist", kind: "hoist",
          label: "Deploy the hoist and recover the casualty",
          min_deployed_pct: 40,
        });
        break;
      case "sling_attach":
        objectives.push({ id: "sling", kind: "sling", label: "Hook up the underslung load" });
        break;
      case "sling_release":
        objectives.push({
          id: "sling_release", kind: "sling_release",
          label: `Set the load down at ${sceneName}`,
          lat: scene.lat, lon: scene.lon, radius_nm: 0.3,
        });
        break;
      case "take_on_load":
        objectives.push({
          id: "load", kind: "payload",
          label: "Take the load aboard",
          min_delta_lb: Math.max(150, Math.round(t.min_payload * 0.3)),
        });
        break;
      case "land_scene":
        objectives.push({
          id: "land_scene", kind: "land_off",
          label: `Put the skids down at ${sceneName}`,
          lat: scene.lat, lon: scene.lon, radius_nm: 0.5,
        });
        break;
      case "deliver":
        objectives.push({
          id: "deliver", kind: "land",
          label: "Land at the receiving field",
          icao: base.icao, radius_nm: 1.5,
        });
        break;
      case "return_base":
        objectives.push({
          id: "return", kind: "land",
          label: "Return to base",
          icao: base.icao, radius_nm: 1.5,
        });
        break;
    }
  }

  const variance = 0.85 + Math.random() * 0.4;
  const nearest = nearestAirport(scene.lat, scene.lon, base.airports);

  return {
    role: t.role,
    title: t.title,
    description: t.brief.replace("{scene}", flavour),
    required_tags: t.required_tags,
    required_certs: t.required_certs,
    min_payload: t.min_payload,
    payout: Math.round(t.base_payout * variance * (1 + reputation / 200)),
    // Out and back, so the economy charges roughly the right flight time.
    distance_nm: Math.max(2, Math.round(actualNm * 2)),
    difficulty: t.difficulty,
    weather_factor: t.weather_factor,
    origin: base.icao,
    destination: base.icao,
    scene_lat: scene.lat,
    scene_lon: scene.lon,
    scene_type: t.scene_type,
    scene_name: sceneName,
    nearest_airport_icao: nearest?.icao ?? null,
    nearest_airport_nm: nearest?.distance_nm ?? null,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

// ---------------------------------------------------------------------------
// Powerline patrol along a real transmission line
// ---------------------------------------------------------------------------

/**
 * Build a patrol that follows an actual power line.
 *
 * MSFS renders its powerlines from OpenStreetMap, so a line OSM knows about is
 * one you can physically see and follow in the sim. The contract is a string of
 * low-level overfly points along the real geometry, ending back at base.
 *
 * Returns null when OSM has nothing usable nearby -- the caller then falls back
 * to a synthetic scene.
 */
export async function generatePowerlinePatrol(
  reputation: number,
  base: { lat: number; lon: number; icao: string | null; airports?: Airport[] },
): Promise<Record<string, unknown> | null> {
  const lines = await findPowerLines({ lat: base.lat, lon: base.lon }, 40);
  if (lines.length === 0) return null;

  // Prefer a line that's a sensible patrol length rather than the longest.
  const usable = lines
    .map((l) => ({ l, len: pathLengthNm(l.geometry) }))
    .filter((x) => x.len >= 3)
    .sort((a, b) => Math.abs(a.len - 25) - Math.abs(b.len - 25));
  if (usable.length === 0) return null;

  const { l: line, len } = usable[0];
  const points = samplePath(line.geometry, 6);
  const label = line.name ?? `${line.operator ?? "the"} transmission line`;

  const objectives: Objective[] = points.map((p, i) => ({
    id: `pt${i + 1}`,
    kind: "overfly",
    label:
      i === 0
        ? `Start the run at the ${ordinal(1)} tower`
        : `Inspect section ${i + 1} of ${points.length}`,
    lat: Number(p.lat.toFixed(5)),
    lon: Number(p.lon.toFixed(5)),
    radius_nm: 0.5,
    max_agl_ft: 500,
  }));

  objectives.push({
    id: "return",
    kind: "land",
    label: "Return to base",
    icao: base.icao,
    radius_nm: 1.5,
  });

  const variance = 0.85 + Math.random() * 0.4;
  const start = points[0];
  const nearest = nearestAirport(start.lat, start.lon, base.airports);

  return {
    role: "patrol",
    title: line.name ? `Line Patrol — ${line.name}` : "Powerline Patrol",
    description:
      `Low-level inspection of ${label}` +
      (line.voltage ? ` (${line.voltage} V)` : "") +
      `. ${len.toFixed(0)} nm of conductor, ${points.length} sections. ` +
      `Stay below 500 ft AGL over each one — cameras rolling.`,
    required_tags: ["survey", "patrol"] as AircraftTag[],
    required_certs: [],
    min_payload: 300,
    payout: Math.round((3800 + len * 90) * variance * (1 + reputation / 200)),
    distance_nm: Math.round(len * 1.6),
    difficulty: 2,
    weather_factor: 2,
    origin: base.icao,
    destination: base.icao,
    scene_lat: Number(start.lat.toFixed(5)),
    scene_lon: Number(start.lon.toFixed(5)),
    scene_type: "field" as SceneType,
    scene_name: line.name ?? "Transmission line",
    nearest_airport_icao: nearest?.icao ?? null,
    nearest_airport_nm: nearest?.distance_nm ?? null,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

function ordinal(n: number) {
  return n === 1 ? "first" : n === 2 ? "second" : `${n}th`;
}

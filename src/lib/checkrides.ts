/**
 * Check rides: a real flight you have to pass to earn a rating.
 *
 * Every certification used to be a straight purchase -- pay the cost, meet a
 * reputation floor, click Acquire, done. No different from buying an
 * aircraft. Booking a check ride still costs money and still needs the
 * reputation floor -- that part hasn't changed -- but the cert itself is only
 * granted once the flight is actually flown and every graded objective on it
 * is genuinely completed, tracked by the same sim bridge that already tracks
 * every contract.
 *
 * A check ride is a mission like any other -- reach / hover / hoist / sling /
 * land_off, the exact objective kinds the bridge already knows how to track
 * -- so it needs no bridge changes at all. What makes it a check ride rather
 * than a contract is `role: "checkride"`, which the server checks at
 * resolution time: passing requires every objective to be ticked off, not
 * merely landing somewhere with the right weight aboard the way an ordinary
 * contract does.
 *
 * Every ride below was a helicopter ride, so a plane company booking Turbine was
 * asked to hover. Each certification a plane can meaningfully fly now also has
 * a plane version (user approved 2026-09-15); Hoist stays helicopter only,
 * since a plane has nothing to deploy.
 */

import { CERT_LABELS } from "./game-data";
import { offsetPosition, distanceNm, type Airport, type Objective, type PlacementSites } from "./missions";

export type CheckrideProfile = {
  cert: string;
  /** Which aircraft may attempt it. Empty means any -- the objectives
   * themselves are the real gate (an aircraft with no hoist simply cannot
   * satisfy a hoist objective, whatever tags it carries). */
  required_tags: string[];
  briefing: string;
  /** How far the practice area sits from base, in nautical miles. */
  range_nm: number;
  build: (scene: { lat: number; lon: number }, base: { lat: number; lon: number; icao: string | null }) => Objective[];
};

const R_NM = "return"; // land objective id, shared across every profile

function landHome(base: { icao: string | null }): Objective {
  return { id: R_NM, kind: "land", label: "Land back at base", icao: base.icao, radius_nm: 1.5 };
}

export const CHECKRIDE_PROFILES: Record<string, CheckrideProfile> = {
  turbine: {
    cert: "turbine",
    required_tags: [],
    range_nm: 3,
    briefing: "Demonstrate a stable hover on a turbine-powered airframe, then bring it home. Fly a turbine aircraft — the examiner is watching power management, not just the stick.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the practice area", lat: scene.lat, lon: scene.lon, radius_nm: 0.6 },
      { id: "hover", kind: "hover", label: "Hold a stable hover — 120 ft AGL, 30s", max_agl_ft: 120, max_gs_kts: 15, hold_seconds: 30 },
      landHome(base),
    ],
  },
  hoist: {
    cert: "hoist",
    required_tags: [],
    range_nm: 4,
    briefing: "Deploy the hoist over the practice point and demonstrate a full recovery cycle. Needs a hoist-equipped aircraft — without one, the deployment objective can never be satisfied.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the practice point", lat: scene.lat, lon: scene.lon, radius_nm: 0.6 },
      { id: "hover", kind: "hover", label: "Hold the hover — 100 ft AGL, 25s", max_agl_ft: 100, max_gs_kts: 12, hold_seconds: 25 },
      { id: "hoist", kind: "hoist", label: "Deploy the hoist fully and recover it", min_deployed_pct: 70 },
      landHome(base),
    ],
  },
  medevac: {
    cert: "medevac",
    required_tags: ["medevac"],
    range_nm: 5,
    briefing: "A simulated patient pickup: precision landing, load, and a smooth delivery back to base within tolerance.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the practice LZ", lat: scene.lat, lon: scene.lon, radius_nm: 0.6 },
      { id: "hover", kind: "hover", label: "Set up for the approach", max_agl_ft: 200, max_gs_kts: 15, hold_seconds: 15 },
      { id: "land_scene", kind: "land_off", label: "Put it down at the LZ", lat: scene.lat, lon: scene.lon, radius_nm: 0.3 },
      { id: "load", kind: "payload", label: "Take the simulated patient aboard", min_delta_lb: 180 },
      landHome(base),
    ],
  },
  offshore: {
    cert: "offshore",
    required_tags: ["offshore"],
    range_nm: 8,
    briefing: "Transit out and put it down on a helideck-sized pad. Offshore work does not forgive a sloppy approach — the tolerance here is tighter than anything on land.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the platform", lat: scene.lat, lon: scene.lon, radius_nm: 0.8 },
      { id: "land_scene", kind: "land_off", label: "Land on the deck", lat: scene.lat, lon: scene.lon, radius_nm: 0.12 },
      landHome(base),
    ],
  },
  firefighting: {
    cert: "firefighting",
    required_tags: ["firefighting"],
    range_nm: 4,
    briefing: "Hook up, hold the hover, and place the load precisely on the mark — the same precision a real bucket drop demands.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the practice site", lat: scene.lat, lon: scene.lon, radius_nm: 0.6 },
      { id: "sling", kind: "sling", label: "Hook up the load", min_delta_lb: 200 },
      { id: "hover", kind: "hover", label: "Hold the hover with the load attached", max_agl_ft: 150, max_gs_kts: 15, hold_seconds: 30 },
      { id: "sling_release", kind: "sling_release", label: "Place the load on the mark", lat: scene.lat, lon: scene.lon, radius_nm: 0.25 },
      landHome(base),
    ],
  },
  heavy_lift: {
    cert: "heavy_lift",
    required_tags: ["heavy_lift"],
    range_nm: 5,
    briefing: "A heavier load, a longer hold, and a tighter placement radius than the firefighting check ride — this is the precision standard for construction lifts.",
    build: (scene, base) => [
      { id: "reach", kind: "reach", label: "Reach the practice site", lat: scene.lat, lon: scene.lon, radius_nm: 0.6 },
      { id: "sling", kind: "sling", label: "Hook up the load", min_delta_lb: 500 },
      { id: "hover", kind: "hover", label: "Hold the hover with the load attached", max_agl_ft: 150, max_gs_kts: 12, hold_seconds: 40 },
      { id: "sling_release", kind: "sling_release", label: "Place the load on the mark", lat: scene.lat, lon: scene.lon, radius_nm: 0.2 },
      landHome(base),
    ],
  },
  sar: {
    cert: "sar",
    required_tags: ["sar"],
    range_nm: 6,
    briefing: "The hardest check ride in the book: find a simulated casualty in a tasked area with no beacon to home on, then winch them out. This is real search and rescue, not a scripted approach.",
    build: (scene) => [
      {
        id: "search", kind: "search", label: "Search the tasked area — 1.2 nm radius",
        datum_lat: scene.lat, datum_lon: scene.lon, radius_nm: 1.2, beacon: false,
      },
      { id: "hover", kind: "hover", label: "Hold the hover over the casualty", max_agl_ft: 100, max_gs_kts: 12, hold_seconds: 30, near_search: true },
      { id: "hoist", kind: "hoist", label: "Winch the casualty out", min_deployed_pct: 60 },
      { id: "return", kind: "land", label: "Return to base", icao: null, radius_nm: 1.5 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Plane check rides
// ---------------------------------------------------------------------------

/** Marks a check ride as the plane version, so the board and dispatch can tell. */
export const PLANE_CHECKRIDE_SUFFIX = " (plane)";

type Base = { lat: number; lon: number; icao: string | null };

/** What a plane check ride can use around the base. */
export type PlaneRideContext = {
  base: Base;
  /** Fields near the base, with runways -- airfieldsNear(base, true). */
  airports: Airport[];
  /** The base's scanned water, for the offshore ride. */
  sites?: PlacementSites | null;
};

export type PlaneCheckrideProfile = {
  cert: string;
  briefing: string;
  /** The ride, or null when the base has nothing it needs (no usable airfield in range). */
  build: (
    ctx: PlaneRideContext,
  ) => { objectives: Objective[]; scene: { lat: number; lon: number }; distance_nm: number } | null;
};

const planeHome = (base: Base): Objective => ({
  id: R_NM, kind: "land", label: `Land back at ${base.icao ?? "base"}`, icao: base.icao, radius_nm: 2,
});

const anyBearing = () => Math.random() * 360;

/** A field a plane can use between `lo` and `hi` nm from base: a mapped runway of 1,500 ft or more, or none mapped. */
function fieldBetween(ctx: PlaneRideContext, lo: number, hi: number) {
  const home = (ctx.base.icao ?? "").toUpperCase();
  const fits = ctx.airports
    .map((a) => ({ ...a, nm: distanceNm(ctx.base.lat, ctx.base.lon, a.lat, a.lon) }))
    .filter(
      (a) =>
        a.icao.toUpperCase() !== home &&
        a.nm >= lo &&
        a.nm <= hi &&
        a.runway_ft !== 0 &&
        (a.runway_ft == null || a.runway_ft >= 1500),
    );
  return fits.length > 0 ? fits[Math.floor(Math.random() * fits.length)] : null;
}

const landAt = (id: string, label: string, f: Airport): Objective => ({
  id, kind: "land", label, icao: f.icao, radius_nm: 2,
  lat: f.lat, lon: f.lon, runway_ft: f.runway_ft, surface: f.surface,
});

export const PLANE_CHECKRIDE_PROFILES: Record<string, PlaneCheckrideProfile> = {
  turbine: {
    cert: "turbine",
    briefing: "Take a turbine aircraft up to altitude over the practice area, then bring it home. The examiner is watching power management on the climb and a stable approach at the end.",
    build: ({ base }) => {
      const p = offsetPosition(base.lat, base.lon, 10, anyBearing());
      return {
        scene: p,
        distance_nm: 20,
        objectives: [
          { id: "climb", kind: "climb", label: "Climb to 5,000 ft AGL over the practice area", lat: p.lat, lon: p.lon, radius_nm: 3, min_agl_ft: 5000 },
          planeHome(base),
        ],
      };
    },
  },
  medevac: {
    cert: "medevac",
    briefing: "A patient transfer by air: fly to the receiving field, take the simulated patient aboard, and bring them home smoothly.",
    build: (ctx) => {
      const f = fieldBetween(ctx, 15, 60);
      if (!f) return null;
      return {
        scene: { lat: f.lat, lon: f.lon },
        distance_nm: Math.round(f.nm * 2),
        objectives: [
          landAt("arrive", `Land at ${f.icao}`, f),
          { id: "load", kind: "payload", label: "Take the simulated patient aboard", min_delta_lb: 180 },
          planeHome(ctx.base),
        ],
      };
    },
  },
  offshore: {
    cert: "offshore",
    briefing: "Out over open water and back. Offshore flying is about keeping it low and tidy with nowhere to put down — pass over the offshore point below 1,000 ft, then come home.",
    build: ({ base, sites }) => {
      const water = (sites?.offshore ?? [])
        .map(([lat, lon]) => ({ lat, lon, nm: distanceNm(base.lat, base.lon, lat, lon) }))
        .filter((w) => w.nm >= 15 && w.nm <= 25);
      // No mapped coast in range: a point 20 nm out on a random bearing.
      const p = water.length > 0 ? water[Math.floor(Math.random() * water.length)] : offsetPosition(base.lat, base.lon, 20, anyBearing());
      const nm = distanceNm(base.lat, base.lon, p.lat, p.lon);
      return {
        scene: { lat: p.lat, lon: p.lon },
        distance_nm: Math.round(nm * 2),
        objectives: [
          { id: "overwater", kind: "overfly", label: "Pass over the offshore point below 1,000 ft AGL", lat: p.lat, lon: p.lon, radius_nm: 1, max_agl_ft: 1000 },
          planeHome(base),
        ],
      };
    },
  },
  firefighting: {
    cert: "firefighting",
    briefing: "Fire spotting from the air: three low passes over the reported fire area, below 1,000 ft, so the incident commander gets a proper look. Then home.",
    build: ({ base }) => {
      const c = offsetPosition(base.lat, base.lon, 10, anyBearing());
      const first = anyBearing();
      const passes: Objective[] = [0, 1, 2].map((i) => {
        const q = offsetPosition(c.lat, c.lon, 1.5, first + i * 120);
        return {
          id: `pass${i + 1}`, kind: "overfly", label: `Low pass ${i + 1} of 3 over the fire area, below 1,000 ft AGL`,
          lat: q.lat, lon: q.lon, radius_nm: 0.6, max_agl_ft: 1000,
        };
      });
      return { scene: c, distance_nm: 24, objectives: [...passes, planeHome(base)] };
    },
  },
  heavy_lift: {
    cert: "heavy_lift",
    briefing: "Heavy freight: 1,000 lb aboard at base, delivered to the receiving field, then home. Weight and balance matter — check your numbers before you roll.",
    build: (ctx) => {
      const f = fieldBetween(ctx, 20, 60);
      if (!f) return null;
      return {
        scene: { lat: f.lat, lon: f.lon },
        distance_nm: Math.round(f.nm * 2),
        objectives: [
          { id: "load", kind: "payload", label: "Take 1,000 lb of freight aboard", min_delta_lb: 1000 },
          landAt("arrive", `Deliver it to ${f.icao}`, f),
          planeHome(ctx.base),
        ],
      };
    },
  },
  sar: {
    cert: "sar",
    briefing: "An air search with no beacon to home on: find the simulated casualty in the tasked area, then report back to base.",
    build: ({ base }) => {
      const p = offsetPosition(base.lat, base.lon, 6, anyBearing());
      return {
        scene: p,
        distance_nm: 16,
        objectives: [
          { id: "search", kind: "search", label: "Search the tasked area — 1.5 nm radius", datum_lat: p.lat, datum_lon: p.lon, radius_nm: 1.5, beacon: false },
          planeHome(base),
        ],
      };
    },
  },
};

/** Whether a cert has a helicopter / plane check ride. */
export const hasHelicopterCheckride = (cert: string) => cert in CHECKRIDE_PROFILES;
export const hasPlaneCheckride = (cert: string) => cert in PLANE_CHECKRIDE_PROFILES;

/** Is this check ride the plane version? */
export function isPlaneCheckride(m: { role?: string | null; title?: string | null }) {
  return m?.role === "checkride" && (m.title ?? "").endsWith(PLANE_CHECKRIDE_SUFFIX);
}

const payloadOf = (objectives: Objective[]) =>
  objectives.reduce((max, o) => {
    if (o.kind === "payload" || o.kind === "sling") return Math.max(max, o.min_delta_lb ?? 0);
    return max;
  }, 0);

/**
 * Build a check ride mission for a cert, anchored a short hop from base.
 *
 * The `land` objective's icao is filled from base here rather than baked into
 * the profile, since every profile shares the same "come home" step.
 *
 * `wing: "fixed"` builds the plane version; it returns null when the cert has
 * none (Hoist) or the base has nothing it needs, such as an airfield in range.
 */
export function generateCheckride(
  cert: string,
  base: Base,
  opts?: { wing?: "rotary" | "fixed"; airports?: Airport[]; sites?: PlacementSites | null },
): Record<string, unknown> | null {
  if (opts?.wing === "fixed") {
    const plane = PLANE_CHECKRIDE_PROFILES[cert];
    const built = plane?.build({ base, airports: opts.airports ?? [], sites: opts.sites });
    if (!plane || !built) return null;
    return checkrideRow(cert, base, {
      title: `Check Ride — ${CERT_LABELS[cert] ?? cert}${PLANE_CHECKRIDE_SUFFIX}`,
      briefing: plane.briefing,
      required_tags: [],
      objectives: built.objectives,
      scene: built.scene,
      distance_nm: built.distance_nm,
    });
  }

  const profile = CHECKRIDE_PROFILES[cert];
  if (!profile) return null;

  const scene = offsetPosition(base.lat, base.lon, profile.range_nm, Math.random() * 360);
  const objectives = profile.build(scene, base).map((o) =>
    o.kind === "land" && o.icao === null ? { ...o, icao: base.icao } : o,
  );
  return checkrideRow(cert, base, {
    title: `Check Ride — ${CERT_LABELS[cert] ?? cert}`,
    briefing: profile.briefing,
    required_tags: profile.required_tags,
    objectives,
    scene,
    distance_nm: profile.range_nm * 2,
  });
}

function checkrideRow(
  cert: string,
  base: Base,
  r: {
    title: string;
    briefing: string;
    required_tags: string[];
    objectives: Objective[];
    scene: { lat: number; lon: number };
    distance_nm: number;
  },
): Record<string, unknown> {
  return {
    role: "checkride",
    title: r.title,
    description: r.briefing,
    required_tags: r.required_tags,
    required_certs: [],
    min_payload: payloadOf(r.objectives),
    // Check rides pay no contract fee -- the cert itself is the payout, and
    // the server forces this to 0 at resolution regardless, so this is
    // documentation as much as a real value.
    payout: 0,
    distance_nm: Math.max(2, Math.round(r.distance_nm)),
    difficulty: 3,
    weather_factor: 1,
    origin: base.icao,
    destination: base.icao,
    scene_lat: r.scene.lat,
    scene_lon: r.scene.lon,
    scene_type: "checkride",
    // Reused rather than a new column: which cert this check ride is for is
    // the one thing the server needs back at resolution time to know what to
    // grant, and scene_name has no other purpose on a check ride.
    scene_name: cert,
    nearest_airport_icao: null,
    nearest_airport_nm: null,
    objectives: r.objectives as unknown as Record<string, unknown>[],
  };
}

export function isCheckrideMission(m: { scene_type?: string | null }) {
  return m?.scene_type === "checkride";
}

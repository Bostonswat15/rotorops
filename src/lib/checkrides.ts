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
 */

import { CERT_LABELS } from "./game-data";
import { offsetPosition, distanceNm, type Objective } from "./missions";

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

/**
 * Build a check ride mission for a cert, anchored a short hop from base.
 *
 * The `land` objective's icao is filled from base here rather than baked into
 * the profile, since every profile shares the same "come home" step.
 */
export function generateCheckride(
  cert: string,
  base: { lat: number; lon: number; icao: string | null },
): Record<string, unknown> | null {
  const profile = CHECKRIDE_PROFILES[cert];
  if (!profile) return null;

  const scene = offsetPosition(base.lat, base.lon, profile.range_nm, Math.random() * 360);
  const objectives = profile.build(scene, base).map((o) =>
    o.kind === "land" && o.icao === null ? { ...o, icao: base.icao } : o,
  );
  const minPayload = objectives.reduce((max, o) => {
    if (o.kind === "payload" || o.kind === "sling") return Math.max(max, o.min_delta_lb ?? 0);
    return max;
  }, 0);

  return {
    role: "checkride",
    title: `Check Ride — ${CERT_LABELS[cert] ?? cert}`,
    description: profile.briefing,
    required_tags: profile.required_tags,
    required_certs: [],
    min_payload: minPayload,
    // Check rides pay no contract fee -- the cert itself is the payout, and
    // the server forces this to 0 at resolution regardless, so this is
    // documentation as much as a real value.
    payout: 0,
    distance_nm: Math.max(2, Math.round(profile.range_nm * 2)),
    difficulty: 3,
    weather_factor: 1,
    origin: base.icao,
    destination: base.icao,
    scene_lat: scene.lat,
    scene_lon: scene.lon,
    scene_type: "checkride",
    // Reused rather than a new column: which cert this check ride is for is
    // the one thing the server needs back at resolution time to know what to
    // grant, and scene_name has no other purpose on a check ride.
    scene_name: cert,
    nearest_airport_icao: null,
    nearest_airport_nm: null,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

export function isCheckrideMission(m: { scene_type?: string | null }) {
  return m?.scene_type === "checkride";
}

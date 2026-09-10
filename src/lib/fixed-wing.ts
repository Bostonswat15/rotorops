/**
 * Fixed-wing contracts.
 *
 * The helicopter side of the board is built around a *scene* -- a point in the
 * world you hover over, winch from, or put the skids down on. None of that
 * applies to an aeroplane. Fixed-wing work is runway to runway: freight into a
 * strip, a patient between hospitals' nearest fields, a survey track flown at
 * height, a charter that waits and brings them home.
 *
 * So these contracts are built from real airports rather than from scenes. The
 * base already carries a scatter of them -- reported by the sim's own facility
 * cache and topped up from OSM -- which means a destination here is a field
 * that genuinely exists at a distance the aircraft can actually make.
 *
 * Objectives reuse the existing kinds (`land`, `reach`, `overfly`), so the sim
 * bridge needs no changes: it already resolves an ICAO through the facility
 * cache and already knows what overflying a point at height means.
 */

import type { AircraftTag } from "./game-data";
import {
  distanceNm, nearestAirport, offsetPosition,
  type Airport, type Objective,
} from "./missions";

/** How a fixed-wing job is shaped. */
export type FixedWingKind =
  /** Out to a field and that's the job -- freight, a drop-off, a positioning leg. */
  | "delivery"
  /** Out, then home again: charters, air ambulance, anything with a return leg. */
  | "round_trip"
  /** A track flown at height and back -- survey, patrol, photography. */
  | "survey";

export type FixedWingTemplate = {
  role: string;
  title: string;
  /** `{dest}` is replaced with the destination field. */
  brief: string;
  kind: FixedWingKind;
  required_tags: AircraftTag[];
  required_certs: string[];
  min_payload: number;
  /**
   * Shortest strip the contract can be flown into, in feet.
   *
   * The one figure that decides whether a job is a bush job or an airline job.
   * Nothing enforces it against the airframe yet -- the sim's facility cache
   * does not report runway length -- so it reads as a warning in the briefing
   * rather than a hard gate.
   */
  min_runway_ft: number;
  base_payout: number;
  /** How far out the destination sits, in nautical miles. */
  leg_range: [number, number];
  difficulty: number;
  weather_factor: number;
};

export const FIXED_WING_TEMPLATES: FixedWingTemplate[] = [
  // --- Freight -------------------------------------------------------------
  {
    role: "freight",
    title: "Scheduled Freight Run",
    brief: "Palletised freight out to {dest}. Routine, and it pays the bills between the interesting jobs.",
    kind: "delivery",
    required_tags: ["cargo", "medium_utility"], required_certs: [],
    min_payload: 1500, min_runway_ft: 2500, base_payout: 4200,
    leg_range: [35, 150], difficulty: 1, weather_factor: 2,
  },
  {
    role: "freight",
    title: "Bush Strip Resupply",
    brief: "Stores into {dest}. Short, unpaved and no go-around worth the name — check your numbers before you commit.",
    kind: "delivery",
    required_tags: ["bush", "cargo"], required_certs: [],
    min_payload: 900, min_runway_ft: 1200, base_payout: 6800,
    leg_range: [40, 160], difficulty: 4, weather_factor: 3,
  },
  {
    role: "freight",
    title: "Overnight Priority Freight",
    brief: "Time-critical consignment to {dest}. Wheels up as soon as you can — the courier is waiting the other end.",
    kind: "delivery",
    required_tags: ["cargo", "airline"], required_certs: [],
    min_payload: 3000, min_runway_ft: 3500, base_payout: 9400,
    leg_range: [70, 240], difficulty: 2, weather_factor: 3,
  },

  // --- Passengers ----------------------------------------------------------
  {
    role: "charter",
    title: "Executive Charter",
    brief: "Two directors out to {dest} and back the same day. They will notice the landing.",
    kind: "round_trip",
    required_tags: ["vip"], required_certs: [],
    min_payload: 700, min_runway_ft: 2500, base_payout: 8600,
    leg_range: [45, 170], difficulty: 2, weather_factor: 2,
  },
  {
    role: "charter",
    title: "Regional Shuttle",
    brief: "Scheduled passenger rotation to {dest}. Full load, tight turnaround, back before dark.",
    kind: "round_trip",
    required_tags: ["airline"], required_certs: [],
    min_payload: 6000, min_runway_ft: 4000, base_payout: 15500,
    leg_range: [70, 200], difficulty: 2, weather_factor: 3,
  },
  {
    role: "training",
    title: "Cross-Country Instruction",
    brief: "Student needs a qualifying cross-country to {dest} and back. You are along for the ride and the paperwork.",
    kind: "round_trip",
    required_tags: ["trainer"], required_certs: ["training"],
    min_payload: 350, min_runway_ft: 1800, base_payout: 1900,
    leg_range: [40, 120], difficulty: 1, weather_factor: 1,
  },

  // --- Medical -------------------------------------------------------------
  {
    role: "medevac",
    title: "Air Ambulance Transfer",
    brief: "Stable patient and a nurse escort, moving to the specialist unit at {dest}. Smooth and straight.",
    kind: "delivery",
    required_tags: ["medevac"], required_certs: ["medevac"],
    min_payload: 900, min_runway_ft: 3000, base_payout: 11200,
    leg_range: [55, 190], difficulty: 2, weather_factor: 3,
  },
  {
    role: "medevac",
    title: "Organ Transport",
    brief: "Transplant team on the clock. Direct to {dest}, no deviations, and every minute is somebody's.",
    kind: "delivery",
    required_tags: ["medevac", "vip"], required_certs: ["medevac"],
    min_payload: 600, min_runway_ft: 3200, base_payout: 18500,
    leg_range: [90, 280], difficulty: 3, weather_factor: 4,
  },

  // --- Survey and patrol ---------------------------------------------------
  {
    role: "survey",
    title: "Aerial Survey Grid",
    brief: "Photographic run over the survey block beyond {dest}. Height and heading held, cameras rolling.",
    kind: "survey",
    required_tags: ["survey", "patrol"], required_certs: [],
    min_payload: 400, min_runway_ft: 2000, base_payout: 7300,
    leg_range: [40, 140], difficulty: 3, weather_factor: 3,
  },
  {
    role: "patrol",
    title: "Coastal Fisheries Patrol",
    brief: "Track out past {dest} and work the legs. Looking for anything without a transponder.",
    kind: "survey",
    required_tags: ["patrol", "survey"], required_certs: [],
    min_payload: 500, min_runway_ft: 2400, base_payout: 8100,
    leg_range: [60, 200], difficulty: 2, weather_factor: 3,
  },
  {
    role: "positioning",
    title: "Ferry Flight",
    brief: "Airframe is wanted at {dest} for tomorrow. Empty legs pay poorly, but they beat leaving it parked.",
    kind: "delivery",
    required_tags: ["light_utility", "trainer"], required_certs: [],
    min_payload: 200, min_runway_ft: 1800, base_payout: 2400,
    leg_range: [45, 160], difficulty: 1, weather_factor: 2,
  },
];

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * Choose a destination field roughly the requested distance out.
 *
 * Ranked by how close it lands to the asked-for leg, then picked from the best
 * few so a batch of contracts doesn't all route to the same airport. Returns
 * null when the base has no airport data at all, which is the caller's cue to
 * skip fixed-wing work entirely rather than invent a field.
 *
 * Exported for charter.ts -- rotary charter contracts want exactly this same
 * "a real field at roughly the distance asked for" logic, not a second copy
 * of it that drifts over time.
 */
export function pickDestination(
  base: { lat: number; lon: number; icao: string | null },
  airports: Airport[] | undefined,
  legNm: number,
): { icao: string; lat: number; lon: number; distance_nm: number } | null {
  const usable = (airports ?? []).filter(
    (a) =>
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lon) &&
      // Don't send anyone on a round trip to the field they started from.
      String(a.icao).toUpperCase() !== String(base.icao ?? "").toUpperCase(),
  );
  if (usable.length === 0) return null;

  const ranked = usable
    .map((a) => ({ a, d: distanceNm(base.lat, base.lon, a.lat, a.lon) }))
    .filter((x) => x.d > 5)
    .sort((x, y) => Math.abs(x.d - legNm) - Math.abs(y.d - legNm));
  if (ranked.length === 0) return null;

  // When every known field is nearer than the leg asked for -- common, since
  // the airfield picture only reaches so far -- ranking alone would hand back
  // the same farthest airport every time. Widen the pick in that case so a
  // batch of contracts still spreads across the map.
  const reachable = ranked.some((x) => x.d >= legNm);
  const width = reachable ? 5 : Math.min(10, ranked.length);
  const chosen = pick(ranked.slice(0, Math.max(1, width)));
  return {
    icao: chosen.a.icao,
    lat: chosen.a.lat,
    lon: chosen.a.lon,
    distance_nm: Number(chosen.d.toFixed(1)),
  };
}

/**
 * Turn a fixed-wing template into a live contract.
 *
 * Returns null when the base has no usable airports, since the whole contract
 * is built around a real destination and there is nothing honest to fall back
 * on -- unlike a scene, an airport cannot be invented.
 */
export function generateFixedWingMission(
  t: FixedWingTemplate,
  reputation: number,
  base: { lat: number; lon: number; icao: string | null; airports?: Airport[] },
): Record<string, unknown> | null {
  const [lo, hi] = t.leg_range;
  const legNm = lo + Math.random() * (hi - lo);
  const dest = pickDestination(base, base.airports, legNm);
  if (!dest) return null;

  const objectives: Objective[] = [];

  if (t.kind === "survey") {
    // A track out past the destination and back, flown at height. Legs are
    // strung along the outbound bearing so the route reads as a survey block
    // rather than a scatter of unrelated waypoints.
    const brg = Math.random() * 360;
    const legs = 4;
    for (let i = 1; i <= legs; i++) {
      const out = offsetPosition(
        base.lat, base.lon,
        dest.distance_nm * (0.5 + (i / legs) * 0.8),
        brg + (i % 2 === 0 ? 6 : -6),
      );
      objectives.push({
        id: `leg${i}`, kind: "overfly",
        label: `Fly survey leg ${i} of ${legs}`,
        lat: out.lat, lon: out.lon, radius_nm: 1.2, max_agl_ft: 6000,
      });
    }
    objectives.push({
      id: "return", kind: "land",
      label: `Land back at ${base.icao ?? "base"}`,
      icao: base.icao, radius_nm: 2,
    });
  } else {
    objectives.push({
      id: "arrive", kind: "land",
      label: `Land at ${dest.icao}`,
      icao: dest.icao, radius_nm: 2,
    });
    if (t.kind === "round_trip") {
      objectives.push({
        id: "return", kind: "land",
        label: `Return to ${base.icao ?? "base"}`,
        icao: base.icao, radius_nm: 2,
      });
    }
  }

  const variance = 0.85 + Math.random() * 0.4;
  const roundTrip = t.kind !== "delivery";
  const nearest = nearestAirport(dest.lat, dest.lon, base.airports);

  return {
    role: t.role,
    title: t.title,
    description:
      t.brief.replace("{dest}", dest.icao) +
      ` Shortest usable strip: ${t.min_runway_ft.toLocaleString()} ft.`,
    required_tags: t.required_tags,
    required_certs: t.required_certs,
    min_payload: t.min_payload,
    payout: Math.round(t.base_payout * variance * (1 + reputation / 200)),
    distance_nm: Math.max(2, Math.round(dest.distance_nm * (roundTrip ? 2 : 1))),
    difficulty: t.difficulty,
    weather_factor: t.weather_factor,
    origin: base.icao,
    destination: roundTrip ? base.icao : dest.icao,
    scene_lat: dest.lat,
    scene_lon: dest.lon,
    // `airport` is what marks a contract as fixed-wing. scene_type is plain
    // text, so this needs no migration and no new column.
    scene_type: "airport",
    scene_name: dest.icao,
    nearest_airport_icao: nearest?.icao ?? dest.icao,
    nearest_airport_nm: nearest?.distance_nm ?? 0,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

/** Is this contract an aeroplane job? */
export function isFixedWingMission(m: { scene_type?: string | null }) {
  return m?.scene_type === "airport";
}

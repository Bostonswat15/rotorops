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
 * A few jobs aren't runway to runway. A skydive lift climbs over its own field,
 * a floatplane run lands on water, a spotting patrol goes low over smoke. Those
 * use `climb`, `land_off` and `overfly`; `climb` is the one objective the bridge
 * had to learn for them.
 */

import type { AircraftTag } from "./game-data";
import { surfaceClass } from "./osm";
import {
  distanceNm, nearestAirport, offsetPosition,
  type Airport, type Objective, type PlacementSites,
} from "./missions";

/** How a fixed-wing job is shaped. */
export type FixedWingKind =
  /** Out to a field and that's the job -- freight, a drop-off, a positioning leg. */
  | "delivery"
  /** Out, then home again: charters, air ambulance, anything with a return leg. */
  | "round_trip"
  /** A track flown at height and back -- survey, patrol, photography. */
  | "survey"
  /** Jumpers aboard, a climb over the home field, back down. */
  | "skydive"
  /** Several fields in a row -- a mail run, a hopper -- and maybe home after. */
  | "multi_stop"
  /** Low passes over reported smoke, then home. */
  | "spotting"
  /** Down on the water at a lodge and back to the float base. No runway at either end. */
  | "water";

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
   * Shortest strip the contract can be flown into, in feet. 0 for a job with
   * no runway at all.
   *
   * Destinations are chosen to have a longest mapped runway at least this long
   * (`fieldSuits`). Not checked against the airframe.
   */
  min_runway_ft: number;
  /** A bush job: only goes to strips -- unpaved, or short. See `fieldSuits`. */
  bush_strip?: boolean;
  base_payout: number;
  /** How far out the destination sits, in nautical miles. Per leg for multi_stop. */
  leg_range: [number, number];
  difficulty: number;
  weather_factor: number;
  /** multi_stop: how many fields, in order. */
  stops?: number;
  /** multi_stop: fly home after the last one. */
  returns?: boolean;
  /** multi_stop: added to base_payout for each field on the run. */
  per_stop_payout?: number;
  /** Used instead of `title` when the base is on the coast. */
  coastal_title?: string;
};

/** How high a skydive lift climbs, above the field. */
export const SKYDIVE_AGL_FT = 10000;

/**
 * Runway matching (user approved 2026-09-13). A bush job only goes to a strip:
 * a field whose longest runway is unpaved or shorter than BUSH_STRIP_MAX_FT.
 * A field with no runway mapped is offered only to a job needing
 * UNMAPPED_RUNWAY_MAX_FT or less, and never to a bush job, which has to know
 * it is sending you to a strip.
 */
export const BUSH_STRIP_MAX_FT = 3000;
export const UNMAPPED_RUNWAY_MAX_FT = 2500;

/** Can this job be sent to this field? */
export function fieldSuits(t: Pick<FixedWingTemplate, "min_runway_ft" | "bush_strip">, a: Airport): boolean {
  const ft = a.runway_ft;
  // Water runways only: a seaplane base.
  if (ft === 0) return false;
  if (ft === null || ft === undefined) return !t.bush_strip && t.min_runway_ft <= UNMAPPED_RUNWAY_MAX_FT;
  if (ft < t.min_runway_ft) return false;
  return !t.bush_strip || ft < BUSH_STRIP_MAX_FT || surfaceClass(a.surface) === "unpaved";
}

/**
 * Where "home" is for a landing step. The base's field when it names one --
 * the sim knows it by ident, and a base can sit a few miles from the airport
 * it names -- and the base's own position only when it names none.
 */
export const homeField = (base: { lat: number; lon: number; icao: string | null }) =>
  base.icao ? {} : { lat: base.lat, lon: base.lon };

/**
 * How close the nearest water has to be for a base to have a float base at
 * all. A floatplane can't use the runway, so water 30 nm away is no use.
 */
const FLOAT_BASE_MAX_NM = 10;

export type FixedWingBase = {
  lat: number;
  lon: number;
  icao: string | null;
  airports?: Airport[];
  /** The base's scanned water, roads and hospitals. Only the floatplane run needs it. */
  sites?: PlacementSites | null;
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
    bush_strip: true,
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
  {
    role: "mail",
    title: "Mail Run",
    brief: "Mailbags for {dest}, landing at each in that order. The last stop keeps the aircraft overnight.",
    kind: "multi_stop", stops: 3, returns: false, per_stop_payout: 1000,
    required_tags: ["cargo", "light_utility", "bush"], required_certs: [],
    min_payload: 300, min_runway_ft: 1500, base_payout: 3000,
    leg_range: [20, 60], difficulty: 2, weather_factor: 2,
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
    brief: "Scheduled passenger rotation to {dest}. Full cabin, tight turnaround, back before dark.",
    kind: "round_trip",
    // Was 6,000 lb for the airline tag alone: more than any aeroplane in the
    // catalogue carries (the King Air 350i tops out at 5,150), so nothing could
    // ever fly it.
    required_tags: ["airline", "medium_utility", "vip"], required_certs: [],
    min_payload: 2500, min_runway_ft: 4000, base_payout: 15500,
    leg_range: [70, 200], difficulty: 2, weather_factor: 3,
  },
  {
    role: "charter",
    title: "Lodge Hopper",
    coastal_title: "Island Hopper",
    brief: "Guests to drop at {dest}, then home empty. Short hops and a lot of landings.",
    kind: "multi_stop", stops: 2, returns: true, per_stop_payout: 0,
    required_tags: ["medium_utility", "vip", "bush"], required_certs: [],
    min_payload: 1000, min_runway_ft: 1800, base_payout: 6500,
    leg_range: [25, 80], difficulty: 2, weather_factor: 2,
    bush_strip: true,
  },
  {
    role: "floatplane",
    title: "Floatplane Lodge Run",
    brief: "Supplies and guests for a lodge on the water, {dest}. No runway at the other end — put it down by the dock, then bring it home to the float base.",
    kind: "water",
    required_tags: ["floats"], required_certs: [],
    min_payload: 600, min_runway_ft: 0, base_payout: 5500,
    leg_range: [10, 50], difficulty: 3, weather_factor: 3,
  },
  {
    role: "skydive",
    title: "Skydive Lift",
    brief: "A load of jumpers out of {dest}. Climb to 10,000 ft above the field, let them go over the drop zone, and come back down.",
    kind: "skydive",
    required_tags: ["medium_utility"], required_certs: [],
    min_payload: 800, min_runway_ft: 1800, base_payout: 2800,
    leg_range: [0, 0], difficulty: 1, weather_factor: 2,
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
    role: "patrol",
    title: "Fire Spotting Patrol",
    brief: "Smoke reported in three places around {dest}. Get down low over each for a proper look, then report back.",
    kind: "spotting",
    required_tags: ["patrol", "survey"], required_certs: [],
    min_payload: 300, min_runway_ft: 2000, base_payout: 6000,
    leg_range: [20, 60], difficulty: 2, weather_factor: 2,
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

/** "A", "A and B", "A, B and C". */
const listOf = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** A field a contract was sent to, with what OSM knows of its runway. */
export type PickedField = {
  icao: string;
  lat: number;
  lon: number;
  distance_nm: number;
  runway_ft: number | null;
  surface: string | null;
};

/** A line for the briefing when a field the job lands at has no runway on the map. */
function runwayNote(t: FixedWingTemplate, fields: PickedField[]): string | undefined {
  const unmapped = fields.filter((f) => f.runway_ft === null).map((f) => f.icao);
  if (t.min_runway_ft === 0 || unmapped.length === 0) return undefined;
  return `No runway is mapped at ${listOf(unmapped)}, so its length is unknown — check it before you commit.`;
}

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
  /** Which fields the job can use at all -- runway length and surface, for a plane. */
  accept: (a: Airport) => boolean = () => true,
): PickedField | null {
  const usable = (airports ?? []).filter(
    (a) =>
      Number.isFinite(a.lat) &&
      Number.isFinite(a.lon) &&
      // Don't send anyone on a round trip to the field they started from.
      String(a.icao).toUpperCase() !== String(base.icao ?? "").toUpperCase() &&
      accept(a),
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
    runway_ft: chosen.a.runway_ft ?? null,
    surface: chosen.a.surface ?? null,
  };
}

/**
 * A run of fields one after another, each a leg from the last, never visiting
 * the same field twice or coming back through base. Null when the base doesn't
 * know enough airports to string that many together.
 */
function pickChain(
  base: FixedWingBase,
  stops: number,
  [lo, hi]: [number, number],
  accept: (a: Airport) => boolean,
): PickedField[] | null {
  const visited = new Set([String(base.icao ?? "").toUpperCase()]);
  const chain: PickedField[] = [];
  let from: { lat: number; lon: number; icao: string | null } = base;
  for (let i = 0; i < stops; i++) {
    const unvisited = (base.airports ?? []).filter((a) => !visited.has(String(a.icao).toUpperCase()));
    const next = pickDestination(from, unvisited, lo + Math.random() * (hi - lo), accept);
    if (!next) return null;
    visited.add(next.icao.toUpperCase());
    chain.push(next);
    from = next;
  }
  return chain;
}

/**
 * Turn a fixed-wing template into a live contract.
 *
 * Returns null when the base can't honestly support the job -- no airports for
 * a destination, not enough of them in a row for a mail run, no water near the
 * field for a floatplane. Unlike a scene, an airport or a lake cannot be invented.
 */
export function generateFixedWingMission(
  t: FixedWingTemplate,
  reputation: number,
  base: FixedWingBase,
): Record<string, unknown> | null {
  switch (t.kind) {
    case "skydive":
      return skydiveLift(t, reputation, base);
    case "multi_stop":
      return multiStop(t, reputation, base);
    case "spotting":
      return spottingPatrol(t, reputation, base);
    case "water":
      return floatplaneRun(t, reputation, base);
    default:
      return pointToPoint(t, reputation, base);
  }
}

/** The columns every fixed-wing contract shares, whatever shape the job is. */
function contractRow(
  t: FixedWingTemplate,
  reputation: number,
  base: FixedWingBase,
  job: {
    objectives: Objective[];
    destination: string | null;
    distance_nm: number;
    scene: { lat: number; lon: number; name: string };
    brief: string;
    title?: string;
    payout?: number;
    /** Added to the briefing. */
    note?: string;
  },
): Record<string, unknown> {
  const variance = 0.85 + Math.random() * 0.4;
  const nearest = nearestAirport(job.scene.lat, job.scene.lon, base.airports);
  return {
    role: t.role,
    title: job.title ?? t.title,
    description:
      job.brief +
      (t.min_runway_ft > 0 ? ` Shortest usable strip: ${t.min_runway_ft.toLocaleString()} ft.` : "") +
      (job.note ? ` ${job.note}` : ""),
    required_tags: t.required_tags,
    required_certs: t.required_certs,
    min_payload: t.min_payload,
    payout: Math.round((job.payout ?? t.base_payout) * variance * (1 + reputation / 200)),
    distance_nm: Math.max(2, Math.round(job.distance_nm)),
    difficulty: t.difficulty,
    weather_factor: t.weather_factor,
    origin: base.icao,
    destination: job.destination,
    scene_lat: job.scene.lat,
    scene_lon: job.scene.lon,
    // `airport` is what marks a contract as fixed-wing. scene_type is plain
    // text, so this needs no migration and no new column.
    scene_type: "airport",
    scene_name: job.scene.name,
    nearest_airport_icao: nearest?.icao ?? null,
    nearest_airport_nm: nearest?.distance_nm ?? null,
    objectives: job.objectives as unknown as Record<string, unknown>[],
  };
}

/** Delivery, round trip and survey: out to a real field and, maybe, back. */
function pointToPoint(t: FixedWingTemplate, reputation: number, base: FixedWingBase) {
  const [lo, hi] = t.leg_range;
  const legNm = lo + Math.random() * (hi - lo);
  // A survey only measures its track from the destination; nobody lands there.
  const dest = pickDestination(
    base, base.airports, legNm,
    t.kind === "survey" ? undefined : (a) => fieldSuits(t, a),
  );
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
      icao: base.icao, radius_nm: 2, ...homeField(base),
    });
  } else {
    objectives.push({
      id: "arrive", kind: "land",
      label: `Land at ${dest.icao}`,
      icao: dest.icao, radius_nm: 2,
      lat: dest.lat, lon: dest.lon, runway_ft: dest.runway_ft, surface: dest.surface,
    });
    if (t.kind === "round_trip") {
      objectives.push({
        id: "return", kind: "land",
        label: `Return to ${base.icao ?? "base"}`,
        icao: base.icao, radius_nm: 2, ...homeField(base),
      });
    }
  }

  const roundTrip = t.kind !== "delivery";
  return contractRow(t, reputation, base, {
    objectives,
    destination: roundTrip ? base.icao : dest.icao,
    distance_nm: dest.distance_nm * (roundTrip ? 2 : 1),
    scene: { lat: dest.lat, lon: dest.lon, name: dest.icao },
    brief: t.brief.replace("{dest}", dest.icao),
    note: t.kind === "survey" ? undefined : runwayNote(t, [dest]),
  });
}

/** Jumpers aboard at the home field, a climb over it, and back down. */
function skydiveLift(t: FixedWingTemplate, reputation: number, base: FixedWingBase) {
  const field = base.icao ?? "the field";
  const objectives: Objective[] = [
    // The bridge puts the weight aboard once you're stopped on the ground,
    // exactly as it boards a casualty.
    { id: "board", kind: "payload", label: "Board the jumpers", min_delta_lb: t.min_payload },
    {
      id: "jump_run", kind: "climb",
      label: `Climb to ${SKYDIVE_AGL_FT.toLocaleString()} ft AGL over ${field}`,
      lat: base.lat, lon: base.lon, radius_nm: 3, min_agl_ft: SKYDIVE_AGL_FT,
    },
    { id: "return", kind: "land", label: `Land back at ${field}`, icao: base.icao, radius_nm: 2, ...homeField(base) },
  ];
  return contractRow(t, reputation, base, {
    objectives,
    destination: base.icao,
    distance_nm: 20,
    scene: { lat: base.lat, lon: base.lon, name: `${field} drop zone` },
    brief: t.brief.replace("{dest}", field),
  });
}

/** A mail run or a hopper: several fields in order, home afterwards or not. */
function multiStop(t: FixedWingTemplate, reputation: number, base: FixedWingBase) {
  const stops = t.stops ?? 2;
  const chain = pickChain(base, stops, t.leg_range, (a) => fieldSuits(t, a));
  if (!chain) return null;

  const objectives: Objective[] = chain.map(
    (s, i): Objective => ({
      id: `stop${i + 1}`, kind: "land",
      label: `Stop ${i + 1} of ${stops}: land at ${s.icao}`,
      icao: s.icao, radius_nm: 2,
      lat: s.lat, lon: s.lon, runway_ft: s.runway_ft, surface: s.surface,
    }),
  );
  let distance = chain.reduce((sum, s) => sum + s.distance_nm, 0);
  const last = chain[chain.length - 1];
  if (t.returns) {
    objectives.push({
      id: "return", kind: "land",
      label: `Home to ${base.icao ?? "base"}`,
      icao: base.icao, radius_nm: 2, ...homeField(base),
    });
    distance += distanceNm(last.lat, last.lon, base.lat, base.lon);
  }

  const coastal = !!base.sites && (base.sites.offshore.length > 0 || base.sites.shore.length > 0);
  return contractRow(t, reputation, base, {
    objectives,
    destination: t.returns ? base.icao : last.icao,
    distance_nm: distance,
    scene: { lat: chain[0].lat, lon: chain[0].lon, name: chain.map((s) => s.icao).join(" → ") },
    brief: t.brief.replace("{dest}", listOf(chain.map((s) => s.icao))),
    title: coastal && t.coastal_title ? t.coastal_title : t.title,
    payout: t.base_payout + (t.per_stop_payout ?? 0) * stops,
    note: runwayNote(t, chain),
  });
}

/** Three smoke reports around a real field, passed over low, then home. */
function spottingPatrol(t: FixedWingTemplate, reputation: number, base: FixedWingBase) {
  const [lo, hi] = t.leg_range;
  const dest = pickDestination(base, base.airports, lo + Math.random() * (hi - lo));
  if (!dest) return null;

  // Spread round the field a few miles out, so it's a patrol rather than three
  // passes over one hillside.
  const first = Math.random() * 360;
  const objectives: Objective[] = [0, 1, 2].map((i): Objective => {
    const p = offsetPosition(dest.lat, dest.lon, 4 + Math.random() * 6, first + i * 120);
    return {
      id: `smoke${i + 1}`, kind: "overfly",
      label: `Check smoke report ${i + 1} of 3`,
      lat: p.lat, lon: p.lon, radius_nm: 1, max_agl_ft: 3000,
    };
  });
  objectives.push({
    id: "return", kind: "land",
    label: `Report back at ${base.icao ?? "base"}`,
    icao: base.icao, radius_nm: 2, ...homeField(base),
  });

  return contractRow(t, reputation, base, {
    objectives,
    destination: base.icao,
    distance_nm: dest.distance_nm * 2 + 30,
    scene: { lat: dest.lat, lon: dest.lon, name: `Smoke near ${dest.icao}` },
    brief: t.brief.replace("{dest}", dest.icao),
  });
}

/**
 * A lodge on mapped water and back to the float base -- the water nearest the
 * home field. Lakes and shoreline both count; rivers are too narrow to trust.
 *
 * Not yet flown: this relies on the sim reporting a floatplane on the water as
 * on the ground, which is how land_off and boarding know it has landed.
 */
function floatplaneRun(t: FixedWingTemplate, reputation: number, base: FixedWingBase) {
  const water = [...(base.sites?.lake ?? []), ...(base.sites?.shore ?? [])].map(([lat, lon]) => ({
    lat, lon, fromBase: distanceNm(base.lat, base.lon, lat, lon),
  }));
  if (water.length < 2) return null;

  const home = water.reduce((a, b) => (b.fromBase < a.fromBase ? b : a));
  if (home.fromBase > FLOAT_BASE_MAX_NM) return null;

  const [lo, hi] = t.leg_range;
  const want = lo + Math.random() * (hi - lo);
  const lodges = water
    .map((w) => ({ ...w, leg: distanceNm(home.lat, home.lon, w.lat, w.lon) }))
    .filter((w) => w.leg >= 5)
    .sort((a, b) => Math.abs(a.leg - want) - Math.abs(b.leg - want))
    .slice(0, 5);
  if (lodges.length === 0) return null;
  const lodge = pick(lodges);

  const objectives: Objective[] = [
    { id: "board", kind: "payload", label: "Take the guests and supplies aboard", min_delta_lb: t.min_payload },
    { id: "lodge", kind: "land_off", label: "Land on the water at the lodge", lat: lodge.lat, lon: lodge.lon, radius_nm: 0.8 },
    { id: "home", kind: "land_off", label: "Back to the float base", lat: home.lat, lon: home.lon, radius_nm: 1 },
  ];

  return contractRow(t, reputation, base, {
    objectives,
    destination: base.icao,
    distance_nm: lodge.leg * 2,
    scene: { lat: lodge.lat, lon: lodge.lon, name: "Lodge on the water" },
    brief: t.brief.replace("{dest}", `${Math.round(lodge.leg)} nm out`),
  });
}

/** Is this contract an aeroplane job? */
export function isFixedWingMission(m: { scene_type?: string | null }) {
  return m?.scene_type === "airport";
}

/**
 * The hardest field a plane contract lands at, for its card: an unpaved strip
 * before a paved runway, then the shortest. Null for contracts generated before
 * runway data was kept, and for jobs that only land back home.
 */
export function stripOf(objectives: unknown): { label: string; unpaved: boolean } | null {
  const fields = (Array.isArray(objectives) ? objectives : []).filter(
    (o) => o && o.kind === "land" && "runway_ft" in o,
  ) as { runway_ft: number | null; surface: string | null }[];
  if (fields.length === 0) return null;

  const mapped = fields
    .filter((f) => typeof f.runway_ft === "number" && f.runway_ft > 0)
    .map((f) => ({ ft: f.runway_ft as number, surface: f.surface, unpaved: surfaceClass(f.surface) === "unpaved" }))
    .sort((a, b) => Number(b.unpaved) - Number(a.unpaved) || a.ft - b.ft);
  const hardest = mapped[0];
  if (!hardest) return { label: fields.length > 1 ? "Runways not on the map" : "Runway not on the map", unpaved: false };

  const ft = `${hardest.ft.toLocaleString()} ft`;
  const cls = surfaceClass(hardest.surface);
  const name = (hardest.surface ?? "").split(/[;:]/)[0].replace(/_/g, " ");
  const label =
    cls === "unpaved" ? `${name.charAt(0).toUpperCase()}${name.slice(1)} strip · ${ft}`
    : cls === "paved" ? `Paved runway · ${ft}`
    : `Runway · ${ft}`;
  const unmapped = fields.length - mapped.length;
  return {
    label: (fields.length > 1 ? "Hardest stop: " : "") + label + (unmapped > 0 ? ` · ${unmapped} not mapped` : ""),
    unpaved: hardest.unpaved,
  };
}

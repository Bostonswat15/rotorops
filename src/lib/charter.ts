/**
 * Rotary charter contracts: plain point-to-point work between real airports.
 *
 * Every other rotary contract on the board is built around a *scene* -- a
 * search area, a hospital, a wilderness site to sling into. That is honest
 * for a lot of helicopter flying, but it leaves out the simplest job there
 * is: someone has cargo or people at one real field and wants them at
 * another. No search, no hover, no hoist -- just get there with the weight
 * aboard and land, the same shape of contract fixed-wing freight/charter
 * work already uses (see fixed-wing.ts, which this borrows its destination
 * picker from).
 */

import type { AircraftTag } from "./game-data";
import { distanceNm, nearestAirport, type Airport, type Objective } from "./missions";
import { pickDestination } from "./fixed-wing";

export type CharterKind =
  /** Out to a field and that's the job -- cargo, parts, a one-way transfer. */
  | "delivery"
  /** Out, then home again: passenger charters, crew changes. */
  | "round_trip";

export type CharterTemplate = {
  role: string;
  title: string;
  /** `{dest}` is replaced with the destination field. */
  brief: string;
  kind: CharterKind;
  required_tags: AircraftTag[];
  required_certs: string[];
  min_payload: number;
  base_payout: number;
  /** How far out the destination sits, in nautical miles. */
  leg_range: [number, number];
  difficulty: number;
  weather_factor: number;
};

export const CHARTER_TEMPLATES: CharterTemplate[] = [
  {
    role: "charter_cargo",
    title: "Parts Run",
    brief: "Time-sensitive parts out to {dest}. A ground crew is waiting on the ramp.",
    kind: "delivery",
    required_tags: ["light_utility"], required_certs: [],
    min_payload: 500, base_payout: 2600,
    leg_range: [15, 60], difficulty: 1, weather_factor: 1,
  },
  {
    role: "charter_cargo",
    title: "Freight Transfer",
    brief: "Palletised freight to {dest}. Routine work, and it pays the bills between the interesting jobs.",
    kind: "delivery",
    required_tags: ["medium_utility"], required_certs: [],
    min_payload: 1800, base_payout: 5400,
    leg_range: [25, 90], difficulty: 1, weather_factor: 2,
  },
  {
    role: "charter_cargo",
    title: "Heavy Equipment Transfer",
    brief: "Oversized cargo to {dest}. Weigh it twice before you lift.",
    kind: "delivery",
    required_tags: ["heavy_lift"], required_certs: [],
    min_payload: 5000, base_payout: 11000,
    leg_range: [15, 60], difficulty: 2, weather_factor: 2,
  },
  {
    role: "charter_pax",
    title: "Crew Change",
    brief: "Rotate a work crew out to {dest} and bring the outgoing team home.",
    kind: "round_trip",
    required_tags: ["medium_utility"], required_certs: [],
    min_payload: 1000, base_payout: 4800,
    leg_range: [20, 80], difficulty: 1, weather_factor: 2,
  },
  {
    role: "charter_pax",
    title: "Executive Charter",
    brief: "Two directors out to {dest} and back the same day. They will notice the landing.",
    kind: "round_trip",
    required_tags: ["vip"], required_certs: [],
    min_payload: 700, base_payout: 6200,
    leg_range: [25, 100], difficulty: 2, weather_factor: 2,
  },
  {
    role: "charter_pax",
    title: "Scenic Charter",
    brief: "A private party wants the view on the way to {dest}. Keep it smooth.",
    kind: "round_trip",
    required_tags: ["light_utility"], required_certs: [],
    min_payload: 500, base_payout: 3400,
    leg_range: [15, 50], difficulty: 1, weather_factor: 1,
  },
];

/**
 * Turn a template into a live contract, routed to a real nearby airport.
 *
 * Returns null exactly when fixed-wing's own generator does: no usable
 * airport data for this base yet, so there is nowhere honest to send it.
 */
export function generateCharterMission(
  t: CharterTemplate,
  reputation: number,
  base: { lat: number; lon: number; icao: string | null; airports?: Airport[] },
): Record<string, unknown> | null {
  const [lo, hi] = t.leg_range;
  const legNm = lo + Math.random() * (hi - lo);
  const dest = pickDestination(base, base.airports, legNm);
  if (!dest) return null;

  const roundTrip = t.kind === "round_trip";
  const objectives: Objective[] = [
    { id: "arrive", kind: "land", label: `Land at ${dest.icao}`, icao: dest.icao, radius_nm: 2 },
  ];
  if (roundTrip) {
    objectives.push({
      id: "return", kind: "land",
      label: `Return to ${base.icao ?? "base"}`,
      icao: base.icao, radius_nm: 2,
    });
  }

  const variance = 0.85 + Math.random() * 0.4;
  const nearest = nearestAirport(dest.lat, dest.lon, base.airports);

  return {
    role: t.role,
    title: t.title,
    description: t.brief.replace("{dest}", dest.icao),
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
    // Deliberately NOT "airport" -- that value is what the board reads as
    // fixed-wing (see isFixedWingMission in fixed-wing.ts). A charter run
    // needs its own value to avoid landing on the wrong half of the board.
    scene_type: "charter",
    scene_name: dest.icao,
    nearest_airport_icao: nearest?.icao ?? dest.icao,
    nearest_airport_nm: nearest?.distance_nm ?? 0,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

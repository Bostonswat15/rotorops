/**
 * Cargo trips in the sim: when the weight goes aboard, and where each job
 * comes off.
 *
 * A trip is jobs loaded into one aircraft at one pickup (src/lib/cargo.ts,
 * 20260923000000_cargo_inventory.sql). The bridge puts their weight on the
 * aircraft once it is stopped at the pickup, sets the fuel chosen on the load
 * sheet, and takes each job's weight off once it is stopped at that job's drop.
 *
 * These are the decisions, kept free of SimConnect so they can be tested
 * without a sim. runner.ts acts on them.
 */

import { distanceNm } from './telemetry.ts';
import { FUEL_TANKS } from './simvars.ts';

export type BridgeTripJob = {
  id: string;
  title: string;
  cargo_lb: number | null;
  payout: number;
  drop_name: string | null;
  drop_icao: string | null;
  drop_lat: number | null;
  drop_lon: number | null;
  drop_radius_nm: number | null;
  delivered: boolean;
};

export type BridgeTrip = {
  id: string;
  aircraft_id: string;
  /** Fuel to put in the tanks at pickup; null leaves it as set in the sim. */
  fuel_lb: number | null;
  cargo_lb?: number;
  pax?: number;
  pickup_name: string | null;
  pickup_icao: string | null;
  pickup_lat: number | null;
  pickup_lon: number | null;
  pickup_radius_nm: number | null;
  loaded_at: string | null;
  jobs: BridgeTripJob[];
};

/** Stopped this long at a pickup or drop before the weight moves -- the load sheet's 8 s. */
export const TRIP_HOLD_MS = 8000;

// Mirrors objectives.ts, so the ring drawn on the map is the ring that counts.
const ZONE_TOLERANCE = 1.35;
const MIN_ZONE_NM = 0.25;
export const zoneNm = (radiusNm: number | null | undefined) =>
  Math.max(MIN_ZONE_NM, (Number(radiusNm) || 0) * ZONE_TOLERANCE);

export type LatLon = { lat: number; lon: number };
export type Locate = (icao: string) => LatLon | null;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored position first -- every job is written with one -- else the sim's airport. */
export function placeOf(lat: unknown, lon: unknown, icao: string | null, locate: Locate): LatLon | null {
  if (finite(lat) && finite(lon)) return { lat, lon };
  return icao ? locate(icao) : null;
}

/** Weight still aboard: every job not yet delivered. */
export const aboardLb = (trip: BridgeTrip) =>
  trip.jobs.filter((j) => !j.delivered).reduce((sum, j) => sum + (Number(j.cargo_lb) || 0), 0);

export type TripAction =
  | { kind: 'load' }
  | { kind: 'deliver'; jobs: BridgeTripJob[] }
  | { kind: 'wait'; hint: string }
  | { kind: 'done' };

/** What to do with the aircraft stopped at `pos`. */
export function tripAction(trip: BridgeTrip, pos: LatLon, locate: Locate): TripAction {
  if (!trip.loaded_at) {
    const at = placeOf(trip.pickup_lat, trip.pickup_lon, trip.pickup_icao, locate);
    // A pickup nobody can place is taken on trust, wherever the aircraft is.
    if (!at) return { kind: 'load' };
    const d = distanceNm(pos.lat, pos.lon, at.lat, at.lon);
    if (d <= zoneNm(trip.pickup_radius_nm)) return { kind: 'load' };
    return { kind: 'wait', hint: `${d.toFixed(1)} nm to ${trip.pickup_name ?? trip.pickup_icao ?? 'the pickup'} to load` };
  }

  const left = trip.jobs.filter((j) => !j.delivered);
  if (left.length === 0) return { kind: 'done' };

  // Several jobs can share a drop; they all come off at once.
  const here: BridgeTripJob[] = [];
  let nearest: { job: BridgeTripJob; d: number } | null = null;
  for (const j of left) {
    const at = placeOf(j.drop_lat, j.drop_lon, j.drop_icao, locate);
    if (!at) continue;
    const d = distanceNm(pos.lat, pos.lon, at.lat, at.lon);
    if (d <= zoneNm(j.drop_radius_nm)) here.push(j);
    else if (!nearest || d < nearest.d) nearest = { job: j, d };
  }
  if (here.length > 0) return { kind: 'deliver', jobs: here };
  return {
    kind: 'wait',
    hint: nearest
      ? `${nearest.d.toFixed(1)} nm to ${nearest.job.drop_name ?? nearest.job.drop_icao ?? 'the next drop'}`
      : 'none of the drops can be placed',
  };
}

type Snap = Record<string, number | string | undefined>;
const num = (v: unknown) => (finite(v) ? v : 0);

/** Fuel the aircraft holds when full, in pounds; null when the sim doesn't say. */
export function fuelCapacityLb(s: Snap): number | null {
  const gallons = num(s.fuelTotalCapacity);
  const perGallon = num(s.fuelWeightPerGallon);
  return gallons > 0 && perGallon > 0 ? Math.round(gallons * perGallon) : null;
}

/**
 * Gallons for each tank that holds `targetLb` in all: every tank the aircraft
 * has filled to the same fraction. Null when the sim reports no tank capacities
 * or fuel weight, which is the cue to leave the fuel alone.
 */
export function fuelTanks(targetLb: number, s: Snap): { name: string; gallons: number }[] | null {
  const perGallon = num(s.fuelWeightPerGallon);
  const tanks = FUEL_TANKS.map((t) => ({ name: t.name, capacity: num(s[`tankCap_${t.key}`]) })).filter(
    (t) => t.capacity > 0,
  );
  const total = tanks.reduce((sum, t) => sum + t.capacity, 0);
  if (perGallon <= 0 || total <= 0) return null;
  const fraction = Math.min(1, Math.max(0, targetLb / (total * perGallon)));
  return tanks.map((t) => ({ name: t.name, gallons: Math.round(t.capacity * fraction * 100) / 100 }));
}

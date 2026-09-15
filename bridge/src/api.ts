/**
 * PostgREST RPC client.
 *
 * Deliberately not @supabase/supabase-js: the bridge only ever calls three
 * SECURITY DEFINER functions and has no user session, so a plain fetch keeps
 * the auth story obvious -- device token in, company resolved server-side.
 */

import { supabaseEnv } from './config.ts';
import type { BridgeTrip } from './trips.ts';

export type BridgeAircraft = {
  id: string;
  internal_id: string;
  display_name: string;
  sim_title: string | null;
  sim_title_aliases: string[];
  status: string;
  hours: number;
  wear: number;
  cruise_kts: number;
  fuel_burn_pph: number;
  /** As the sim last reported them. Absent until 20260923000000_cargo_inventory.sql is run. */
  empty_weight_lb?: number | null;
  max_gross_lb?: number | null;
  fuel_capacity_lb?: number | null;
};

export type BridgeMission = {
  id: string;
  title: string;
  role: string;
  origin: string | null;
  destination: string | null;
  distance_nm: number;
  min_payload: number;
  payout: number;
  difficulty: number;
  aircraft_id: string | null;
  dispatched_at: string | null;
  scene_lat: number | null;
  scene_lon: number | null;
  scene_name: string | null;
  scene_type: string | null;
  objectives: any[];
  objectives_state: Record<string, { done: boolean; at: string }>;
  /**
   * Set after a crash reset the contract: it only counts when flown from this
   * ICAO. Absent until 20260916000000_crash_restart.sql is run.
   */
  restart_from?: string | null;
  crash_count?: number;
};

export type BridgeBase = {
  id: string;
  icao: string | null;
  name?: string;
  latitude: number | null;
  longitude: number | null;
  airport_count?: number;
  airports_updated_at?: string | null;
};

export type BridgeState = {
  company: { id: string; name: string; cash: number; reputation: number };
  aircraft: BridgeAircraft[];
  dispatched: BridgeMission[];
  bases: BridgeBase[];
  bases_needing_position: { id: string; icao: string }[];
  /** Open cargo trips. Absent until 20260923000000_cargo_inventory.sql is run. */
  trips?: BridgeTrip[];
  /** The company's industry sites. Absent until 20260928000000_camps_on_bridge.sql is run. */
  industries?: BridgeIndustry[];
};

/** An industry site, for dressing its camp in the sim. */
export type BridgeIndustry = {
  id: string;
  kind: string;
  name: string | null;
  latitude: number;
  longitude: number;
};

export type DeliverResult = {
  job_id: string;
  title: string;
  payout: number;
  reputation_delta: number;
  xp_gained: number;
  loan_repayment: number;
  haul_delivered_units: number;
  jobs_left: number;
  trip_completed: boolean;
};

export type ResolveResult = {
  flight_log_id: string;
  success: boolean;
  landing_quality: string;
  duration_hr: number;
  fuel_used: number;
  fuel_cost: number;
  op_cost: number;
  payout: number;
  net: number;
  wear_added: number;
  aircraft_wear: number;
  reputation_delta: number;
  incidents: string[];
  /** Added by 20260914000000_maintenance_and_loans.sql -- absent until it's run. */
  breakdown?: boolean;
  loan_repayment?: number;
  inspection_due_in_hr?: number;
  /** Added by 20260915000000_fuel_farms.sql. */
  fuel_from_tank_lb?: number;
  fuel_delivered_lb?: number;
  /** Added by 20260916000000_crash_restart.sql. */
  crashed?: boolean;
  restart_required?: boolean;
  restart_from?: string | null;
};

/**
 * A failed call. `status` is the HTTP status, or null when no response came
 * back at all -- which a retry needs to know: a 504 may have come after the
 * work was done, a 400 is the database refusing it.
 */
export class RpcError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
  }
}

async function rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { url, key } = supabaseEnv();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: key,
  };
  // Legacy anon keys are JWTs and want a bearer header; the newer
  // `sb_publishable_*` keys are opaque and must not be sent as one.
  if (!key.startsWith('sb_publishable_') && !key.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${key}`;
  }

  let res: Response;
  try {
    res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    // fetch collapses every transport failure into "fetch failed"; the useful
    // detail (DNS, refused, TLS) is on the cause.
    const cause = (e as { cause?: { message?: string; code?: string } }).cause;
    const detail = cause?.message || cause?.code || (e as Error).message;
    throw new RpcError(`${fn}: could not reach ${url} (${detail})`, null);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.hint || text;
    } catch {
      /* not JSON; use the raw body */
    }
    throw new RpcError(`${fn}: ${message}`, res.status);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export function redeemPairingCode(code: string, deviceName: string) {
  return rpc<{ device_id: string; device_token: string; company_id: string }>(
    'redeem_pairing_code',
    { _code: code.trim().toUpperCase(), _device_name: deviceName },
  );
}

export function fetchState(token: string) {
  return rpc<BridgeState>('bridge_state', { _token: token });
}

export function setBasePosition(token: string, baseId: string, lat: number, lon: number) {
  return rpc<void>('bridge_set_base_position', {
    _token: token, _base_id: baseId, _lat: lat, _lon: lon,
  });
}

export function setBaseAirports(
  token: string,
  baseId: string,
  airports: { icao: string; lat: number; lon: number }[],
) {
  return rpc<number>('bridge_set_base_airports', {
    _token: token, _base_id: baseId, _airports: airports,
  });
}

export function completeObjective(token: string, missionId: string, objectiveId: string) {
  return rpc<Record<string, unknown>>('bridge_complete_objective', {
    _token: token, _mission_id: missionId, _objective_id: objectiveId,
  });
}

export function submitFlight(
  token: string,
  aircraftId: string,
  missionId: string | null,
  telemetry: Record<string, unknown>,
) {
  return rpc<ResolveResult>('bridge_submit_flight', {
    _token: token,
    _aircraft_id: aircraftId,
    _mission_id: missionId,
    _telemetry: telemetry,
  });
}

export function setAircraftLimits(
  token: string,
  aircraftId: string,
  emptyLb: number,
  maxGrossLb: number,
  fuelCapacityLb: number | null,
) {
  return rpc<boolean>('bridge_set_aircraft_limits', {
    _token: token, _aircraft_id: aircraftId,
    _empty_lb: emptyLb, _max_gross_lb: maxGrossLb, _fuel_capacity_lb: fuelCapacityLb,
  });
}

export function tripLoaded(token: string, tripId: string) {
  return rpc<boolean>('bridge_trip_loaded', { _token: token, _trip_id: tripId });
}

export function deliverJob(token: string, jobId: string) {
  return rpc<DeliverResult>('bridge_deliver_job', { _token: token, _job_id: jobId });
}

/**
 * Match what the sim reports against the fleet.
 *
 * MSFS titles carry livery and variant suffixes, so exact equality misses more
 * often than it hits. Falls back to loose containment in either direction.
 */
export function matchAircraft(
  fleet: BridgeAircraft[],
  simTitle: string,
): BridgeAircraft | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = norm(simTitle);
  if (!t) return null;

  const candidates = fleet.filter((a) => a.status !== 'destroyed');

  for (const a of candidates) {
    const names = [a.sim_title, ...(a.sim_title_aliases ?? [])].filter(Boolean) as string[];
    if (names.some((n) => norm(n) === t)) return a;
  }
  for (const a of candidates) {
    const names = [a.sim_title, ...(a.sim_title_aliases ?? [])].filter(Boolean) as string[];
    if (names.some((n) => n && (t.includes(norm(n)) || norm(n).includes(t)))) return a;
  }
  // Last resort: the internal id often appears in the title (e.g. "H125").
  for (const a of candidates) {
    if (a.internal_id && t.includes(norm(a.internal_id))) return a;
  }
  return null;
}

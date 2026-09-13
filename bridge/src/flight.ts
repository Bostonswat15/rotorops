/**
 * Flight state machine.
 *
 * Consumes snapshots and decides when a flight has started and finished.
 * A flight is: engines lit -> airborne at some point -> back on the ground
 * with engines off. Anything that never leaves the ground is discarded.
 */

import { EventEmitter } from 'node:events';
import { distanceNm } from './telemetry.ts';
import { FlightScorer, type ScoreItem } from './score.ts';

export type Telemetry = {
  departure: string | null;
  arrival: string | null;
  duration_hr: number;
  fuel_used: number;
  payload: number;
  touchdown_fpm: number | null;
  crashed: boolean;
  incidents: string[];
  distance_flown_nm: number;
  sim_title: string;
  max_g: number | null;
  end_lat: number;
  end_lon: number;
  started_at: string;
  ended_at: string;
  /** 0-100, null when no flight was scored (a resumed contract, say). */
  score: number | null;
  grade: string | null;
  score_items: ScoreItem[];
};

type Snap = Record<string, number | string>;

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export class FlightTracker extends EventEmitter {
  private active = false;
  private hasFlown = false;
  private simTitle = '';
  private startFuel = 0;
  private startTime = 0;
  private startLat = 0;
  private startLon = 0;
  private lastLat = 0;
  private lastLon = 0;
  private lastSnap: Snap = {};
  private distance = 0;
  private maxPayload = 0;
  private touchdownFpm: number | null = null;
  private maxG: number | null = null;
  private incidents = new Set<string>();
  private startedAt = '';
  private departure: string | null = null;
  private scorer: FlightScorer | null = null;

  /** Resolve a position to an ICAO, or null when off-airport. */
  private readonly resolveAirport: (lat: number, lon: number) => string | null;

  // Written out rather than a parameter property: Node's type stripping only
  // erases types, and a parameter property emits real assignment code.
  constructor(resolveAirport: (lat: number, lon: number) => string | null) {
    super();
    this.resolveAirport = resolveAirport;
  }

  get inFlight() {
    return this.active;
  }

  get airborne() {
    return this.hasFlown && num(this.lastSnap.onGround, 1) === 0;
  }

  get currentTitle() {
    return this.simTitle;
  }

  /** Live figures for the status line and the moving map, mid-flight. */
  get progress() {
    if (!this.active) return null;
    return {
      simTitle: this.simTitle,
      departure: this.departure,
      hours: this.elapsedHours(),
      fuelUsed: Math.max(0, this.startFuel - num(this.lastSnap.fuelWeight, this.startFuel)),
      distance: this.distance,
      airborne: this.airborne,
      lat: this.lastLat,
      lon: this.lastLon,
      heading: num(this.lastSnap.heading),
      agl: num(this.lastSnap.agl),
      groundSpeed: num(this.lastSnap.groundSpeed),
      altitude: num(this.lastSnap.altitude),
    };
  }

  /** The score so far, for the live readout. Null outside a flight. */
  get scoreNow(): { score: number; grade: string; items: ScoreItem[] } | null {
    if (!this.active || !this.scorer) return null;
    return { score: this.scorer.score, grade: this.scorer.grade, items: this.scorer.breakdown };
  }

  onTouchdown(fpm: number, g: number) {
    if (!this.active || !this.hasFlown) return;
    this.touchdownFpm = fpm;
    this.maxG = this.maxG === null ? g : Math.max(this.maxG, g);
    if (g >= 2.5) this.incidents.add('high-G touchdown');
    this.scorer?.onTouchdown(fpm, g, this.lastSnap);
  }

  onSnapshot(s: Snap) {
    const engineOn = num(s.engine1) === 1 || num(s.engine2) === 1;
    const onGround = num(s.onGround, 1) === 1;
    const title = String(s.title ?? '').trim();

    // Swapping aircraft mid-session invalidates whatever we were tracking.
    if (this.active && title && title !== this.simTitle) {
      this.emit('log', `aircraft changed (${this.simTitle} -> ${title}); discarding flight`);
      this.reset();
    }

    if (!this.active) {
      // Start on engine light-up, or immediately if the bridge was launched
      // with a flight already underway.
      if (engineOn) this.begin(s, title, onGround);
      else this.lastSnap = s;
      return;
    }

    if (!onGround) this.hasFlown = true;

    // Accumulate track distance at snapshot rate while moving.
    const lat = num(s.lat, this.lastLat);
    const lon = num(s.lon, this.lastLon);
    if (this.lastLat !== 0 || this.lastLon !== 0) {
      const step = distanceNm(this.lastLat, this.lastLon, lat, lon);
      if (step < 10) this.distance += step; // ignore teleports / slew
    }
    this.lastLat = lat;
    this.lastLon = lon;

    this.maxPayload = Math.max(this.maxPayload, num(s.payload));
    this.collectIncidents(s);
    if (this.scorer) {
      this.scorer.onSample(s, !onGround);
      for (const incident of this.incidents) this.scorer.onIncident(incident);
    }
    this.lastSnap = s;

    if (num(s.crashFlag) !== 0) {
      this.incidents.add('crash');
      this.finish(s, true);
      return;
    }

    // Engines off, back on the ground, and we actually flew: that's a flight.
    if (this.hasFlown && onGround && !engineOn) this.finish(s, false);
  }

  private begin(s: Snap, title: string, onGround: boolean) {
    this.active = true;
    this.hasFlown = !onGround;
    this.simTitle = title;
    this.startFuel = num(s.fuelWeight);
    this.startTime = num(s.absoluteTime);
    this.startLat = num(s.lat);
    this.startLon = num(s.lon);
    this.lastLat = this.startLat;
    this.lastLon = this.startLon;
    this.distance = 0;
    this.maxPayload = num(s.payload);
    this.touchdownFpm = null;
    this.maxG = null;
    this.incidents.clear();
    this.startedAt = new Date().toISOString();
    this.departure = onGround ? this.resolveAirport(this.startLat, this.startLon) : null;
    this.lastSnap = s;
    // A flight begins on engine light-up, which is exactly when the beacon rule applies.
    this.scorer = new FlightScorer(FlightScorer.kindOf(s));
    this.scorer.onStart(s);
    this.emit('start', { simTitle: title, departure: this.departure });
  }

  private collectIncidents(s: Snap) {
    if (num(s.engineFailed) === 1) this.incidents.add('engine failure');
    if (num(s.engineOnFire) === 1) this.incidents.add('engine fire');
    // Percent of total damage to the engine; the sim exposes no overtorque var.
    if (num(s.engineDamagePct) > 0) this.incidents.add('engine damage');
    if (num(s.slingCableBroken) === 1) this.incidents.add('sling cable parted');
    if (num(s.rotorRpmPct) > 0 && num(s.rotorRpmPct) < 80 && !num(s.onGround))
      this.incidents.add('rotor RPM low in flight');
  }

  private elapsedHours(): number {
    const now = num(this.lastSnap.absoluteTime, this.startTime);
    return Math.max(0, (now - this.startTime) / 3600);
  }

  /**
   * End the flight now, from the last sample, without waiting for shutdown.
   *
   * The normal end is engines off on the ground. That suits a return to base
   * and nothing else: a medevac hands over on a hospital pad with the rotors
   * turning, and ending a session from the sim menu disconnects before an
   * engines-off sample ever arrives. Either way a contract whose objectives
   * were all complete sat unresolved indefinitely. The caller decides when the
   * job is done; this just closes out the telemetry.
   *
   * Returns false when there is nothing to finish.
   */
  finishNow(): boolean {
    if (!this.active || !this.hasFlown) return false;
    this.finish(this.lastSnap, false);
    return true;
  }

  private finish(s: Snap, crashed: boolean) {
    const lat = num(s.lat, this.lastLat);
    const lon = num(s.lon, this.lastLon);
    const fuelUsed = Math.max(0, Math.round(this.startFuel - num(s.fuelWeight, this.startFuel)));
    this.scorer?.onFinish(num(s.fuelWeight), fuelUsed, this.elapsedHours());
    const result: Telemetry = {
      departure: this.departure,
      arrival: this.resolveAirport(lat, lon),
      duration_hr: Number(this.elapsedHours().toFixed(3)),
      fuel_used: fuelUsed,
      payload: Math.round(this.maxPayload),
      touchdown_fpm: this.touchdownFpm === null ? null : Math.round(this.touchdownFpm),
      crashed,
      incidents: [...this.incidents],
      distance_flown_nm: Number(this.distance.toFixed(1)),
      sim_title: this.simTitle,
      max_g: this.maxG,
      end_lat: lat,
      end_lon: lon,
      started_at: this.startedAt,
      ended_at: new Date().toISOString(),
      score: this.scorer ? this.scorer.score : null,
      grade: this.scorer ? this.scorer.grade : null,
      score_items: this.scorer ? this.scorer.breakdown : [],
    };
    this.reset();

    // A two-minute engine run on the ramp isn't a flight.
    if (!result.crashed && result.duration_hr < 0.02 && result.distance_flown_nm < 0.5) {
      this.emit('log', 'discarded: no meaningful flight recorded');
      return;
    }
    this.emit('flight', result);
  }

  private reset() {
    this.active = false;
    this.hasFlown = false;
    this.distance = 0;
    this.maxPayload = 0;
    this.touchdownFpm = null;
    this.maxG = null;
    this.incidents.clear();
    this.departure = null;
    this.scorer = null;
    this.lastLat = 0;
    this.lastLon = 0;
  }
}

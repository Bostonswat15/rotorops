/**
 * Objective tracking.
 *
 * Watches telemetry against a contract's ordered objective list and reports
 * each one as it's satisfied. Objectives complete in order: you can't winch
 * someone off a cliff you haven't reached.
 *
 * Everything here is derived from SimVars the bridge already reads -- position,
 * AGL, groundspeed, hoist deployment, sling attachment, payload weight -- so no
 * objective asks the player to confirm anything by hand.
 */

import { distanceNm } from './telemetry.ts';

export type Objective =
  | { id: string; kind: 'reach'; label: string; lat: number; lon: number; radius_nm: number }
  | { id: string; kind: 'hover'; label: string; max_agl_ft: number; max_gs_kts: number; hold_seconds: number }
  | { id: string; kind: 'hoist'; label: string; min_deployed_pct: number }
  | { id: string; kind: 'sling'; label: string }
  /** Put the underslung load down where it was asked for. */
  | { id: string; kind: 'sling_release'; label: string; lat: number; lon: number; radius_nm: number }
  | { id: string; kind: 'payload'; label: string; min_delta_lb: number }
  | { id: string; kind: 'land_off'; label: string; lat: number; lon: number; radius_nm: number }
  | { id: string; kind: 'land'; label: string; icao: string | null; radius_nm: number }
  /** Pass over a point at low level -- route inspection work. */
  | { id: string; kind: 'overfly'; label: string; lat: number; lon: number; radius_nm: number; max_agl_ft: number };

type Snap = Record<string, number | string>;

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export type ObjectiveProgress = {
  id: string;
  label: string;
  done: boolean;
  /** 0..1 for objectives that accumulate, like a timed hover. */
  progress: number;
  hint: string | null;
};

export class ObjectiveTracker {
  private objectives: Objective[] = [];
  private done = new Set<string>();
  private hoverHeldMs = 0;
  private lastTick: number | null = null;
  private basePayload: number | null = null;
  private hint: string | null = null;
  /** Something has been on the hook this contract. */
  private slungOnce = false;

  /** Resolve an ICAO to a position; supplied by the sim's facility cache. */
  private readonly locateIcao: (icao: string) => { lat: number; lon: number } | null;

  // Written out rather than a parameter property: type stripping only erases
  // types, and a parameter property emits real assignment code.
  constructor(locateIcao: (icao: string) => { lat: number; lon: number } | null) {
    this.locateIcao = locateIcao;
  }

  load(objectives: Objective[], alreadyDone: string[]) {
    this.objectives = objectives ?? [];
    this.done = new Set(alreadyDone ?? []);
    this.hoverHeldMs = 0;
    this.lastTick = null;
    this.basePayload = null;
    this.hint = null;
    this.slungOnce = false;
  }

  get isLoaded() {
    return this.objectives.length > 0;
  }

  get allComplete() {
    return this.objectives.length > 0 && this.objectives.every((o) => this.done.has(o.id));
  }

  /** The objective currently being worked, or null when the list is finished. */
  get current(): Objective | null {
    return this.objectives.find((o) => !this.done.has(o.id)) ?? null;
  }

  snapshotProgress(): ObjectiveProgress[] {
    const current = this.current;
    return this.objectives.map((o) => ({
      id: o.id,
      label: o.label,
      done: this.done.has(o.id),
      progress:
        o.kind === 'hover' && o.id === current?.id
          ? Math.min(1, this.hoverHeldMs / (o.hold_seconds * 1000))
          : this.done.has(o.id)
            ? 1
            : 0,
      hint: o.id === current?.id ? this.hint : null,
    }));
  }

  /**
   * Feed a telemetry sample. Returns objective ids completed by this sample,
   * so the caller can persist them.
   */
  update(s: Snap): string[] {
    const now = Date.now();
    const dt = this.lastTick === null ? 0 : now - this.lastTick;
    this.lastTick = now;

    const completed: string[] = [];
    // Only ever advance one objective per sample -- keeps the order honest.
    const o = this.current;
    if (!o) return completed;

    const lat = num(s.lat);
    const lon = num(s.lon);
    const agl = num(s.agl);
    const gs = num(s.groundSpeed);
    const onGround = num(s.onGround, 0) === 1;
    const payload = num(s.payload);

    this.hint = null;

    switch (o.kind) {
      case 'reach': {
        const d = distanceNm(lat, lon, o.lat, o.lon);
        if (d <= o.radius_nm) {
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint = `${d.toFixed(1)} nm to run`;
        }
        break;
      }

      case 'overfly': {
        // Inspection work: being overhead isn't enough, you have to be low.
        const d = distanceNm(lat, lon, o.lat, o.lon);
        const lowEnough = agl > 0 && agl <= o.max_agl_ft;
        if (d <= o.radius_nm && lowEnough) {
          this.done.add(o.id);
          completed.push(o.id);
        } else if (d > o.radius_nm) {
          this.hint = `${d.toFixed(1)} nm to the next section`;
        } else {
          this.hint = `overhead — descend below ${o.max_agl_ft} ft AGL`;
        }
        break;
      }

      case 'hover': {
        const steady = !onGround && agl > 0 && agl <= o.max_agl_ft && gs <= o.max_gs_kts;
        if (steady) {
          this.hoverHeldMs += dt;
          const held = this.hoverHeldMs / 1000;
          this.hint = `holding ${held.toFixed(0)}/${o.hold_seconds}s`;
          if (this.hoverHeldMs >= o.hold_seconds * 1000) {
            this.done.add(o.id);
            completed.push(o.id);
            this.hoverHeldMs = 0;
          }
        } else {
          // Drifting out resets the clock; a hover you didn't hold isn't one.
          if (this.hoverHeldMs > 0) this.hoverHeldMs = 0;
          this.hint = onGround
            ? 'lift into a hover'
            : agl > o.max_agl_ft
              ? `descend below ${o.max_agl_ft} ft AGL`
              : `slow below ${o.max_gs_kts} kts`;
        }
        break;
      }

      case 'hoist': {
        const deployed = num(s.hoistDeployed);
        if (deployed >= o.min_deployed_pct) {
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint =
            s.hoistDeployed === undefined
              ? 'this aircraft reports no hoist'
              : `hoist out ${Math.round(deployed)}%`;
        }
        break;
      }

      case 'sling': {
        if (num(s.slingObjectAttached) === 1) {
          this.slungOnce = true;
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint =
            s.slingObjectAttached === undefined
              ? 'this aircraft reports no sling'
              : num(s.slingHookPickup) === 1
                ? 'hook is down — position over the load'
                : 'lower the hook into pickup mode';
        }
        break;
      }

      case 'sling_release': {
        // Only counts as placed once something was actually carried and then
        // let go -- arriving empty-handed shouldn't tick a delivery.
        const attached = num(s.slingObjectAttached) === 1;
        const d = distanceNm(lat, lon, o.lat, o.lon);
        if (!this.slungOnce) {
          this.hint = 'nothing on the hook';
        } else if (attached) {
          this.hint = d <= o.radius_nm ? 'release the load' : `${d.toFixed(1)} nm to the drop`;
        } else if (d <= o.radius_nm) {
          this.done.add(o.id);
          completed.push(o.id);
          this.slungOnce = false;
        } else {
          this.hint = `load released ${d.toFixed(1)} nm off the mark`;
        }
        break;
      }

      case 'payload': {
        // First reading after the previous objective is the empty baseline.
        if (this.basePayload === null) this.basePayload = payload;
        const delta = payload - this.basePayload;
        if (delta >= o.min_delta_lb) {
          this.done.add(o.id);
          completed.push(o.id);
          this.basePayload = null;
        } else {
          this.hint = `${Math.max(0, Math.round(delta))}/${o.min_delta_lb} lb aboard`;
        }
        break;
      }

      case 'land_off': {
        const d = distanceNm(lat, lon, o.lat, o.lon);
        if (onGround && d <= o.radius_nm) {
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint = onGround ? `${d.toFixed(1)} nm from the site` : 'land at the site';
        }
        break;
      }

      case 'land': {
        if (!onGround) {
          this.hint = 'land to complete';
          break;
        }
        const target = o.icao ? this.locateIcao(o.icao) : null;
        if (!target) {
          // Field unknown to the sim's cache -- being on the ground is the
          // best evidence available.
          this.done.add(o.id);
          completed.push(o.id);
          break;
        }
        const d = distanceNm(lat, lon, target.lat, target.lon);
        if (d <= o.radius_nm) {
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint = `${d.toFixed(1)} nm from ${o.icao}`;
        }
        break;
      }
    }

    return completed;
  }
}

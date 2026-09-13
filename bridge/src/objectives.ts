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
import {
  CoverageGrid, DETECT_HOLD_MS, bearingTo, clockPosition, compass,
  detectionRangeNm, nmBetween, type LatLon,
} from './search.ts';

export type Objective =
  | { id: string; kind: 'reach'; label: string; lat: number; lon: number; radius_nm: number }
  /**
   * Find the casualty inside a search area.
   *
   * Carries the datum and radius only. The true position is resolved by the
   * bridge and handed to the tracker separately, so nothing the server or the
   * web app holds can give it away.
   */
  | {
      id: string; kind: 'search'; label: string;
      datum_lat: number; datum_lon: number; radius_nm: number;
      beacon?: boolean;
      /** Real positions the casualty may be at; see SearchSpec. */
      target_candidates?: [number, number][];
    }
  | {
      id: string; kind: 'hover'; label: string;
      max_agl_ft: number; max_gs_kts: number; hold_seconds: number;
      /**
       * Hold it over the casualty, not merely somewhere. The position comes
       * from the resolved search target, so the requirement can be enforced
       * without the contract ever naming the spot.
       */
      near_search?: boolean;
    }
  | { id: string; kind: 'hoist'; label: string; min_deployed_pct: number }
  | {
      id: string; kind: 'sling'; label: string;
      /**
       * Weight that counts as a load on the hook.
       *
       * The native sling vars are the preferred evidence, but the stock MSFS
       * 2024 H125 Cargo flies a visible rope and reports none of them -- zero
       * cables, zero cable length, and SLING_PICKUP_RELEASE does nothing. A
       * load is still weight on the airframe whoever built the hook, so weight
       * is the fallback that works across every helicopter.
       */
      min_delta_lb?: number;
      /**
       * Where the load is waiting, when it is waiting somewhere specific.
       *
       * Construction and logistics loads are rigged on the apron at base and
       * flown out, so the hook-up has a position. A firefighting bucket has
       * none -- it is dipped in whatever water is near the fire.
       */
      lat?: number; lon?: number; radius_nm?: number;
    }
  /** Put the underslung load down where it was asked for. */
  | { id: string; kind: 'sling_release'; label: string; lat: number; lon: number; radius_nm: number }
  | { id: string; kind: 'payload'; label: string; min_delta_lb: number }
  | {
      id: string; kind: 'land_off'; label: string;
      lat: number; lon: number; radius_nm: number;
      /** Put it down by the casualty the search turned up, not at the datum. */
      near_search?: boolean;
    }
  | { id: string; kind: 'land'; label: string; icao: string | null; radius_nm: number }
  /** Pass over a point at low level -- route inspection work. */
  | { id: string; kind: 'overfly'; label: string; lat: number; lon: number; radius_nm: number; max_agl_ft: number }
  /** Get up to height over a point -- a skydive lift's jump run. */
  | { id: string; kind: 'climb'; label: string; lat: number; lon: number; radius_nm: number; min_agl_ft: number };

/**
 * How much slack to allow around a positional objective.
 *
 * Applied here rather than at generation so contracts already sitting on the
 * board get the same slack as newly generated ones.
 *
 * Kept modest on purpose. A first pass at 1.8x looked reasonable in the code
 * and absurd in the air -- a patrol point became a 4 nm-wide ring you could
 * tick without going near the line. Most of what felt like "the zone is too
 * small" was really the zone being invisible: the map drew no ring at all, so
 * there was nothing to fly to. With the ring drawn, a little slack is enough.
 *
 * Deliberately NOT applied to 'search': hunting for a casualty inside a
 * stated radius is the mechanic, not an obstacle, and widening it silently
 * would let the one contract type built around looking for something complete
 * itself early.
 */
const ZONE_TOLERANCE = 1.35;
/**
 * A floor as well, so a very tight radius is still flyable.
 *
 * Lowered twice as patrol sections tightened: at 0.5, and then at 0.35, the
 * floor was doing the work rather than the multiplier, so shrinking a radius
 * was clamped straight back up and looked like the change had not landed.
 *
 * At 0.25 nm -- about 460 m -- it binds nothing currently in the game: every
 * other objective's radius times the tolerance already clears it, so this
 * only exists to keep a hand-authored radius of nearly zero flyable.
 */
const MIN_ZONE_NM = 0.25;
const zone = (radiusNm: number) => Math.max(MIN_ZONE_NM, radiusNm * ZONE_TOLERANCE);

/**
 * The winch, simulated.
 *
 * The hoist objective used to wait for SLING HOIST PERCENT DEPLOYED to pass
 * 40%. Measured on every helicopter tried -- H125 Cargo, H125 Rescue, AS365,
 * HH-65B Dolphin SAR -- the sim exposes that variable and never moves it: the
 * hoist commands are accepted and ignored, no cable ever appears, and so four
 * of the five SAR contracts could not be finished in anything available.
 *
 * What a crew actually needs from the pilot during a winch is a steady hover
 * over the casualty for as long as the lift takes, so that is what counts:
 * close, low enough for the cable, slow, held without a break. A real hoist
 * still completes it outright on an aircraft that has one.
 */
const WINCH_SECONDS = 40;
const WINCH_MAX_AGL_FT = 200;
const WINCH_MAX_GS_KTS = 10;
const WINCH_NEAR_NM = 0.1;

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
  /** How long the winch hover has been held without a break. */
  private winchHeldMs = 0;
  private lastTick: number | null = null;
  private basePayload: number | null = null;
  private hint: string | null = null;
  /** Something has been on the hook this contract. */
  private slungOnce = false;
  /** Airframe weight when the hook-up started, for the weight fallback. */
  private slingBase: number | null = null;

  /** Where the casualty really is, resolved by the bridge, never by the server. */
  private searchTarget: LatLon | null = null;
  private coverage: CoverageGrid | null = null;
  private contactMs = 0;
  /** Raised the moment the casualty is sighted, for the radio call and the map. */
  private foundAt: LatLon | null = null;

  /** Resolve an ICAO to a position; supplied by the sim's facility cache. */
  private readonly locateIcao: (icao: string) => { lat: number; lon: number } | null;

  // Written out rather than a parameter property: type stripping only erases
  // types, and a parameter property emits real assignment code.
  constructor(locateIcao: (icao: string) => { lat: number; lon: number } | null) {
    this.locateIcao = locateIcao;
  }

  load(objectives: Objective[], alreadyDone: string[], searchTarget?: LatLon | null) {
    this.objectives = objectives ?? [];
    this.done = new Set(alreadyDone ?? []);
    this.hoverHeldMs = 0;
    this.winchHeldMs = 0;
    this.lastTick = null;
    this.basePayload = null;
    this.hint = null;
    this.slungOnce = false;
    this.slingBase = null;
    this.searchTarget = searchTarget ?? null;
    this.contactMs = 0;
    this.foundAt = null;

    const spec = this.objectives.find((o) => o.kind === 'search');
    this.coverage =
      spec && spec.kind === 'search'
        ? new CoverageGrid({ lat: spec.datum_lat, lon: spec.datum_lon }, spec.radius_nm)
        : null;

    // Resuming a contract whose search was already ticked off: the casualty is
    // found, so the map and the hoist run should behave as though it just was.
    if (spec && this.done.has(spec.id)) this.foundAt = this.searchTarget;
  }

  /** The casualty's position, once sighted. Null while the search is still on. */
  get sighted(): LatLon | null {
    return this.foundAt;
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
      progress: this.done.has(o.id)
        ? 1
        : o.id !== current?.id
          ? 0
          : o.kind === 'hover'
            ? Math.min(1, this.hoverHeldMs / (o.hold_seconds * 1000))
            : o.kind === 'hoist'
              ? Math.min(1, this.winchHeldMs / (WINCH_SECONDS * 1000))
            : o.kind === 'search'
              ? (this.coverage?.fraction ?? 0)
              : 0,
      hint: o.id === current?.id ? this.hint : null,
    }));
  }

  /**
   * Feed a telemetry sample. Returns objective ids completed by this sample,
   * so the caller can persist them.
   *
   * `now` exists so the timed objectives -- a held hover, sustained visual
   * contact -- can be driven by a synthetic clock in tests. Production callers
   * leave it alone.
   */
  update(s: Snap, now: number = Date.now()): string[] {
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

    // Inspection sections count in any order.
    //
    // Everything else here is a sequence -- you cannot drop a load you have
    // not picked up -- so the tracker advances one objective at a time. A
    // line patrol is the exception: its points are six sections of the same
    // conductor, not six steps. Under strict ordering, missing the first one
    // (by joining the line partway along, or transiting over it above the
    // ceiling) left the remaining five unreachable no matter how carefully
    // they were flown, and the contract read as broken rather than missed.
    //
    // Safe to evaluate out of band because overfly is pure position and
    // altitude: no timers, no carried state, nothing that depends on what
    // came before it. The current objective is skipped here and left to the
    // switch below, which owns the hint.
    for (const cand of this.objectives) {
      if (cand.kind !== 'overfly') continue;
      if (this.done.has(cand.id) || cand.id === o.id) continue;
      const d = distanceNm(lat, lon, cand.lat, cand.lon);
      const low = onGround || (agl > 0 && agl <= cand.max_agl_ft);
      if (d <= zone(cand.radius_nm) && low) {
        this.done.add(cand.id);
        completed.push(cand.id);
      }
    }

    this.hint = null;

    switch (o.kind) {
      case 'reach': {
        const d = distanceNm(lat, lon, o.lat, o.lon);
        if (d <= zone(o.radius_nm)) {
          this.done.add(o.id);
          completed.push(o.id);
        } else {
          this.hint = `${d.toFixed(1)} nm to run`;
        }
        break;
      }

      case 'search': {
        // Nothing to search for if the bridge could not resolve a target;
        // treat it as found rather than stranding the contract.
        if (!this.searchTarget) {
          this.done.add(o.id);
          completed.push(o.id);
          break;
        }

        const here = { lat, lon };
        const range = detectionRangeNm(agl, gs);
        const d = nmBetween(here, this.searchTarget);

        if (range > 0) this.coverage?.mark(lat, lon, range);
        const swept = Math.round((this.coverage?.fraction ?? 0) * 100);

        if (range > 0 && d <= range) {
          // Hold contact briefly: clipping the corner of the area at 110 kts
          // is not a sighting.
          this.contactMs += dt;
          if (this.contactMs >= DETECT_HOLD_MS) {
            this.foundAt = this.searchTarget;
            this.done.add(o.id);
            completed.push(o.id);
          } else {
            this.hint = 'contact — hold your line';
          }
          break;
        }

        this.contactMs = 0;

        if (range === 0) {
          // Say which limit is the problem; "search harder" helps nobody.
          this.hint =
            agl > 1500
              ? `${swept}% swept — descend below 1500 ft AGL to search`
              : gs > 110
                ? `${swept}% swept — slow below 110 kts to search`
                : `${swept}% swept — get airborne over the area`;
          break;
        }

        // A beacon is the difference between a directed search and a grid
        // sweep, so it homes -- but only once you are close enough for the
        // signal to be worth anything.
        if (o.beacon && d <= range * 6) {
          const brg = bearingTo(here, this.searchTarget);
          this.hint = `${swept}% swept — signal ${compass(brg)}, ${d.toFixed(1)} nm`;
        } else {
          this.hint = `${swept}% swept — no contact`;
        }
        break;
      }

      case 'overfly': {
        // Inspection work: being overhead isn't enough, you have to be low.
        const d = distanceNm(lat, lon, o.lat, o.lon);
        // On the ground counts: you cannot get lower than the ground, and
        // agl reads 0 there -- the old `agl > 0` guard turned standing at the
        // tower into "not low enough" and told the pilot to descend. The
        // guard existed because agl also reads 0 before telemetry settles, so
        // the onGround flag carries that distinction instead of the altitude.
        const lowEnough = onGround || (agl > 0 && agl <= o.max_agl_ft);
        if (d <= zone(o.radius_nm) && lowEnough) {
          this.done.add(o.id);
          completed.push(o.id);
        } else if (d > zone(o.radius_nm)) {
          this.hint = `${d.toFixed(1)} nm to the next section`;
        } else {
          this.hint = `overhead at ${Math.round(agl)} ft — descend below ${o.max_agl_ft} ft AGL`;
        }
        break;
      }

      case 'climb': {
        // The mirror of overfly: over the drop zone and high enough. Height
        // above ground, not altitude, so a field at 4,000 ft asks for the same
        // climb as one at sea level.
        const d = distanceNm(lat, lon, o.lat, o.lon);
        const inZone = d <= zone(o.radius_nm);
        if (inZone && !onGround && agl >= o.min_agl_ft) {
          this.done.add(o.id);
          completed.push(o.id);
        } else if (!inZone) {
          this.hint = `${d.toFixed(1)} nm to the drop zone`;
        } else {
          this.hint = `climbing — ${Math.round(agl).toLocaleString()} of ${o.min_agl_ft.toLocaleString()} ft AGL`;
        }
        break;
      }

      case 'hover': {
        // A hover bound to the casualty has to be over the casualty.
        if (o.near_search && this.searchTarget) {
          const d = nmBetween({ lat, lon }, this.searchTarget);
          if (d > 0.25) {
            this.hoverHeldMs = 0;
            this.hint = `${(d * 2025).toFixed(0)} yds from the casualty`;
            break;
          }
        }
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
        // A real hoist, where an aircraft has one, finishes it outright.
        if (num(s.hoistDeployed) >= o.min_deployed_pct) {
          this.done.add(o.id);
          completed.push(o.id);
          this.winchHeldMs = 0;
          break;
        }

        const d = this.searchTarget ? nmBetween({ lat, lon }, this.searchTarget) : 0;
        const why = onGround
          ? 'lift into a hover over the casualty for the winch'
          : d > WINCH_NEAR_NM
            ? `${(d * 2025).toFixed(0)} yds from the casualty`
            : !(agl > 0) || agl > WINCH_MAX_AGL_FT
              ? `descend below ${WINCH_MAX_AGL_FT} ft AGL for the winch`
              : gs > WINCH_MAX_GS_KTS
                ? `slow below ${WINCH_MAX_GS_KTS} kts for the winch`
                : null;

        if (why) {
          // A break in the hover restarts the lift: nobody winches a casualty
          // up half way and parks them.
          this.winchHeldMs = 0;
          this.hint = why;
          break;
        }

        this.winchHeldMs += dt;
        const held = this.winchHeldMs / 1000;
        if (held >= WINCH_SECONDS) {
          this.done.add(o.id);
          completed.push(o.id);
          this.winchHeldMs = 0;
          break;
        }
        const p = held / WINCH_SECONDS;
        const stage = p < 0.3 ? 'hook going down' : p < 0.7 ? 'crewman with the casualty' : 'bringing them up';
        this.hint = `${stage} — hold it steady ${held.toFixed(0)}/${WINCH_SECONDS}s`;
        break;
      }

      case 'sling': {
        // A positioned load has to be hooked where it is sitting. Without
        // this the weight fallback would tick anywhere -- including at the
        // delivery point, which would complete the pickup and the drop on
        // one spot and leave nothing to actually carry.
        if (typeof o.lat === 'number' && typeof o.lon === 'number') {
          const d = distanceNm(lat, lon, o.lat, o.lon);
          if (d > zone(o.radius_nm ?? 0.5)) {
            this.slingBase = null;
            this.hint = `${d.toFixed(1)} nm to the load`;
            break;
          }
        }
        // First reading once this objective is live is the empty baseline.
        if (this.slingBase === null) this.slingBase = payload;
        const gained = payload - this.slingBase;
        const need = o.min_delta_lb ?? 200;

        // Native sling if the aircraft has one, weight if it does not. You do
        // not hook a load at 120 kts, so the weight path is gated on working
        // flight -- otherwise loading passengers mid-cruise would tick it.
        const onTheHook = num(s.slingObjectAttached) === 1;
        const working = agl <= 300 && gs <= 40;

        if (onTheHook || (working && gained >= need)) {
          this.slungOnce = true;
          this.done.add(o.id);
          completed.push(o.id);
          break;
        }

        if (gained >= need && !working) {
          this.hint = 'slow down and get low to take the load';
        } else if (gained > 20) {
          this.hint = `${Math.round(gained)}/${need} lb on the hook`;
        } else if (num(s.slingHookPickup) === 1) {
          this.hint = 'hook is down — position over the load';
        } else {
          // Say how, not just what. A SimObject spawned by the bridge cannot
          // be attached to the hook by the sim -- the staged crates are there
          // to fly to, and the weight aboard is what the contract actually
          // measures.
          this.hint = `over the load — hook it, or take ${need} lb aboard`;
        }
        break;
      }

      case 'sling_release': {
        // Only counts as placed once something was actually carried and then
        // let go -- arriving empty-handed shouldn't tick a delivery.
        const d = distanceNm(lat, lon, o.lat, o.lon);
        // Still carrying, by whichever signal picked the load up: the native
        // var if the aircraft has one, otherwise the weight it added.
        const carrying =
          num(s.slingObjectAttached) === 1 ||
          (this.slingBase !== null && payload - this.slingBase > 20);

        if (!this.slungOnce) {
          this.hint = 'nothing on the hook';
        } else if (carrying) {
          this.hint = d <= zone(o.radius_nm) ? 'release the load' : `${d.toFixed(1)} nm to the drop`;
        } else if (d <= zone(o.radius_nm)) {
          this.done.add(o.id);
          completed.push(o.id);
          this.slungOnce = false;
          this.slingBase = null;
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
        } else if (delta < 20) {
          // Say what to do, not a number that sits at zero. The bridge puts
          // them aboard once the hoist is done or the skids are down and
          // still, so the useful hint is which of those is missing.
          const hoisted = this.objectives.some((x) => x.kind === 'hoist' && this.done.has(x.id));
          this.hint =
            hoisted || (onGround && gs < 5)
              ? 'hold still — taking them aboard'
              : 'land by the casualty to take them aboard';
        } else {
          this.hint = `${Math.max(0, Math.round(delta))}/${o.min_delta_lb} lb aboard`;
        }
        break;
      }

      case 'land_off': {
        // After a search the mark is the casualty, not the datum they drifted
        // from -- which may be miles away by the time you find them.
        const site =
          o.near_search && this.searchTarget
            ? this.searchTarget
            : { lat: o.lat, lon: o.lon };
        const d = distanceNm(lat, lon, site.lat, site.lon);
        if (onGround && d <= zone(o.radius_nm)) {
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
        if (d <= zone(o.radius_nm)) {
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

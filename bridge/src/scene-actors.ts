/**
 * Putting the job in the sim.
 *
 * Until now the app watched you fly and ticked boxes -- the vessel you were
 * hoisting from didn't exist, so "reach the scene" meant hovering over empty
 * water. This spawns the actual thing: a boat at the vessel, a vehicle at the
 * roadside, cargo at the lift site, using SimConnect's AI object API.
 *
 * It also talks to you in the sim (on-screen text), and loads the casualty as
 * real weight, so taking someone aboard is something you feel in the hover.
 *
 * All of it degrades quietly. If the install has no suitable SimObject, or a
 * spawn is refused, the contract still tracks from telemetry exactly as before.
 */

import simconnect from 'node-simconnect';

const { SimConnectDataType, SimConnectConstants, SimObjectType, TextType, InitPosition, EventFlag } =
  simconnect as any;

const REQ_ENUM_BOAT = 900;
const REQ_ENUM_GROUND = 901;
const REQ_SPAWN = 910;
const REQ_REMOVE = 911;
const REQ_RELEASE = 912;
const EVENT_FREEZE_LATLON = 940;
const EVENT_FREEZE_ALT = 941;
const EVENT_FREEZE_ATT = 942;
const DEF_PAYLOAD = 920;
const EVENT_TEXT = 930;

/** Payload station used for the casualty. High enough to miss crew stations. */
const CASUALTY_STATION = 3;

export type SceneType =
  | 'vessel' | 'oil_rig' | 'cliff' | 'beach' | 'ridgeline' | 'forest'
  | 'riverbank' | 'highway' | 'field' | 'rooftop' | 'confined'
  // Not terrain. An industry site (camp, mill, quarry, well); a charter
  // run's destination; a fixed-wing contract's destination field; and a
  // check ride's practice area. All four arrive here as scene_type.
  | 'industry' | 'charter' | 'airport' | 'checkride';

/**
 * What to place, driven by the job rather than just the terrain.
 *
 * A resupply drop needs cargo on the ground, not a parked car; a powerline
 * patrol wants something strung out along the route to fly past. `count` and
 * `spreadNm` turn a single marker into a site.
 */
type StagePlan = {
  pool: 'boat' | 'ground';
  hints: string[];
  count: number;
  spreadNm: number;
  /**
   * Pin the object in place. Defaults true -- an ambulance that drives off
   * ruins the scene. Must be false for anything you are meant to hook and
   * lift, since a frozen object cannot be picked up by a sling.
   */
  freeze?: boolean;
};

const CARGO_HINTS = ['cargo', 'pallet', 'crate', 'container', 'box', 'freight', 'sling', 'barrel'];
/** A working site: something stacked, something parked, something built. */
const SITE_HINTS = [
  'container', 'crate', 'pallet', 'barrel', 'tank', 'silo', 'shed', 'hut',
  'trailer', 'excavator', 'digger', 'loader', 'tractor', 'crane', 'generator',
  'truck', 'pickup',
];
const MEDICAL_HINTS = ['ambulance', 'medic', 'rescue', 'emergency'];
const FIRE_HINTS = ['fire', 'engine', 'tender', 'pumper'];
const VEHICLE_HINTS = ['truck', 'van', 'suv', 'car', 'pickup', 'jeep', 'bus'];
const BOAT_HINTS = ['fishing', 'trawler', 'yacht', 'boat', 'sail', 'ferry', 'cargo'];
const STRUCTURE_HINTS = ['tower', 'pylon', 'pole', 'mast', 'antenna', 'crane', 'generator'];
/** Emergency response: what turns up when something has gone wrong on a road. */
const RESPONSE_HINTS = ['police', 'patrol', 'sheriff', 'ambulance', 'fire', 'tow', 'recovery'];
/**
 * Small enough to be worth searching for.
 *
 * A casualty on a ridge or a cliff has no vehicle beside them -- what makes a
 * search a search is a small object you have to actually spot. MSFS enumerates
 * no reliable person object, so this reaches for the smallest, most
 * out-of-place things an install tends to carry, and the generic fallback
 * covers a install that has none of them.
 */
const CASUALTY_HINTS = [
  'raft', 'dinghy', 'kayak', 'canoe', 'tent', 'backpack', 'quad', 'atv',
  'snowmobile', 'motorcycle', 'bike', 'cart',
];
/** People gathered where people gather: a pad, an estate, a viewpoint. */
const PAX_HINTS = ['car', 'suv', 'van', 'limo', 'bus', 'minibus'];
/** Farm/parked plant, for a supply run into somewhere remote. */
const OUTPOST_HINTS = ['hut', 'shed', 'cabin', 'trailer', 'tank', 'barrel', 'crate', 'tractor'];

/**
 * Optional user overrides, read once from
 * %APPDATA%\RotorOps\scene-objects.json
 *
 * Custom SimObjects are the whole point of this file existing: add a model to
 * the sim, name it here against a role or scene, and it gets placed -- no
 * rebuild of the bridge. Explicit `titles` win over keyword matching, so a
 * hand-authored object is always preferred to a guessed one.
 *
 *   {
 *     "roles":  { "logistics": { "pool": "ground", "titles": ["My Cargo Pallet"],
 *                                "count": 4, "spreadNm": 0.05 } },
 *     "scenes": { "vessel":    { "pool": "boat",   "titles": ["My Trawler"] } }
 *   }
 */
export type SceneOverride = Partial<StagePlan> & { titles?: string[] };
export type SceneOverrides = {
  roles?: Record<string, SceneOverride>;
  scenes?: Record<string, SceneOverride>;
};

let overrides: SceneOverrides = {};

export function setSceneOverrides(next: SceneOverrides | null) {
  overrides = next ?? {};
}

/**
 * Role first -- the job decides the props. Scene type is the fallback.
 *
 * Every role the game generates is answered explicitly, so nothing drops
 * through to "one random car in a field" by accident. Returning null is a
 * decision too: a real airport dresses itself, and there is no prop worth
 * putting on an oil platform that the sim's own scenery doesn't already have.
 */
function planFor(role: string, scene: SceneType): StagePlan | null {
  switch (role) {
    // --- Work with a load on the hook ------------------------------------
    case 'logistics':
    case 'supply':
      // A camp being resupplied: a cluster of stores on the ground. Not frozen --
      // these are the loads you hook.
      return { pool: 'ground', hints: CARGO_HINTS, count: 4, spreadNm: 0.05, freeze: false };
    case 'construction':
      // Load to lift, plus something being built next to it.
      return { pool: 'ground', hints: [...CARGO_HINTS, ...STRUCTURE_HINTS], count: 3, spreadNm: 0.04, freeze: false };
    case 'industry':
      // A lumber camp, quarry, well or mill. Nothing in the sim marks these
      // -- they are real OSM land use, or a spot the company chose to build
      // on -- so without something placed here you fly to an empty clearing
      // and take it on trust. Clustered and frozen: this is the site itself,
      // not the load (the load is a payload objective, not an object).
      return { pool: 'ground', hints: [...SITE_HINTS, ...CARGO_HINTS], count: 5, spreadNm: 0.06 };

    // --- Emergency work ---------------------------------------------------
    case 'patrol':
      // Strung out along the line so there's a route to follow, not a dot.
      return { pool: 'ground', hints: [...STRUCTURE_HINTS, ...VEHICLE_HINTS], count: 5, spreadNm: 0.8 };
    case 'firefighting':
      return { pool: 'ground', hints: [...FIRE_HINTS, ...VEHICLE_HINTS], count: 4, spreadNm: 0.3 };
    case 'medevac':
      // A roadside scene should look like one: the casualty's own vehicle,
      // plus whatever turned up to help.
      if (scene === 'highway')
        return { pool: 'ground', hints: [...RESPONSE_HINTS, ...VEHICLE_HINTS], count: 5, spreadNm: 0.04 };
      return { pool: 'ground', hints: [...MEDICAL_HINTS, ...VEHICLE_HINTS], count: 3, spreadNm: 0.03 };
    case 'sar':
      if (scene === 'vessel' || scene === 'riverbank') {
        return { pool: 'boat', hints: BOAT_HINTS, count: 1, spreadNm: 0 };
      }
      // A casualty up a cliff or along a ridge used to get nothing at all,
      // on the grounds that no vehicle belongs there -- which left the one
      // contract type built around *looking* for someone with nothing to
      // find. Something small and out of place is the whole point.
      if (scene === 'cliff' || scene === 'ridgeline' || scene === 'confined')
        return { pool: 'ground', hints: CASUALTY_HINTS, count: 2, spreadNm: 0.015 };
      if (scene === 'beach')
        return { pool: 'ground', hints: [...CASUALTY_HINTS, ...VEHICLE_HINTS], count: 2, spreadNm: 0.02 };
      // Ground search: a couple of vehicles at the staging point.
      return { pool: 'ground', hints: [...MEDICAL_HINTS, ...VEHICLE_HINTS], count: 3, spreadNm: 0.03 };
    case 'offshore':
      // The platform itself is scenery where the sim has it, but a rig with
      // nothing alongside reads as abandoned -- and in plenty of regions
      // there is no platform modelled at all, leaving open water.
      return { pool: 'boat', hints: BOAT_HINTS, count: 2, spreadNm: 0.08 };

    // --- People work ------------------------------------------------------
    case 'executive':
    case 'tourism':
    case 'training':
      return { pool: 'ground', hints: PAX_HINTS, count: 2, spreadNm: 0.02 };
    case 'survey':
      // Something to actually survey, spread along the track.
      return { pool: 'ground', hints: [...STRUCTURE_HINTS, ...SITE_HINTS], count: 4, spreadNm: 0.5 };

    // --- Nothing to add ---------------------------------------------------
    case 'charter_cargo':
    case 'charter_pax':
    case 'charter':
    case 'freight':
    case 'positioning':
      // These all begin and end at real airports, which have their own
      // scenery and traffic. Spawning a lone pickup on the apron adds
      // nothing.
      return null;
    case 'checkride':
      // A graded flight in an open practice area. Props would only be
      // clutter to manoeuvre around, and the examiner is the objectives.
      return null;
    default:
      break;
  }

  // No role match: fall back to what the terrain suggests.
  if (scene === 'vessel' || scene === 'riverbank') {
    return { pool: 'boat', hints: BOAT_HINTS, count: 1, spreadNm: 0 };
  }
  if (scene === 'airport' || scene === 'charter' || scene === 'checkride') return null;
  if (scene === 'oil_rig') return { pool: 'boat', hints: BOAT_HINTS, count: 1, spreadNm: 0.05 };
  if (scene === 'rooftop') return null; // nothing settles believably on a roof
  if (scene === 'forest' || scene === 'field')
    return { pool: 'ground', hints: OUTPOST_HINTS, count: 3, spreadNm: 0.04 };
  if (scene === 'highway')
    return { pool: 'ground', hints: [...RESPONSE_HINTS, ...VEHICLE_HINTS], count: 4, spreadNm: 0.04 };
  if (scene === 'cliff' || scene === 'ridgeline')
    return { pool: 'ground', hints: CASUALTY_HINTS, count: 2, spreadNm: 0.015 };
  return { pool: 'ground', hints: VEHICLE_HINTS, count: 2, spreadNm: 0.02 };
}

/** Every title matching any hint, best hints first. */
function matches(titles: string[], hints: string[]): string[] {
  const lower = titles.map((t) => ({ t, l: t.toLowerCase() }));
  const out: string[] = [];
  for (const h of hints) {
    for (const x of lower) {
      if (x.l.includes(h) && !out.includes(x.t)) out.push(x.t);
    }
  }
  return out;
}

/** Point at distanceNm along bearingDeg from a start position. */
function offset(lat: number, lon: number, distanceNm: number, bearingDeg: number) {
  const R = 3440.065;
  const rad = (d: number) => (d * Math.PI) / 180;
  const deg = (r: number) => (r * 180) / Math.PI;
  const d = distanceNm / R;
  const b = rad(bearingDeg);
  const la1 = rad(lat);
  const lo1 = rad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 +
    Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lon: (((deg(lo2) + 540) % 360) - 180) };
}

export class SceneDirector {
  private handle: any;
  private log: (m: string) => void;
  private boats: string[] = [];
  private ground: string[] = [];
  private spawned: number[] = [];
  private payloadReady = false;
  private freezeReady = false;
  /** Whether the next batch of spawns should be pinned in place. */
  private freezeNext = true;
  /** Titles awaiting an object id, in request order. */
  private pendingTitles: string[] = [];
  /** What actually made it into the world, for reporting. */
  private placedById = new Map<number, string>();

  constructor(handle: any, log: (m: string) => void) {
    this.handle = handle;
    this.log = log;
  }

  /** Ask the sim what objects this install actually has. */
  discover() {
    try {
      this.handle.enumerateSimObjectsAndLiveries(REQ_ENUM_BOAT, SimObjectType.BOAT);
      this.handle.enumerateSimObjectsAndLiveries(REQ_ENUM_GROUND, SimObjectType.GROUND);
    } catch (e) {
      this.log(`could not enumerate sim objects: ${(e as Error).message}`);
    }

    this.handle.on('enumerateSimobjectAndLiveryList', (recv: any) => {
      const titles: string[] = (recv.simobjectLiveries ?? [])
        .map((x: any) => x.aircraftTitle)
        .filter(Boolean);
      if (recv.requestID === REQ_ENUM_BOAT) {
        this.boats = [...new Set([...this.boats, ...titles])];
      } else if (recv.requestID === REQ_ENUM_GROUND) {
        this.ground = [...new Set([...this.ground, ...titles])];
      }
    });

    this.handle.on('assignedObjectID', (recv: any) => {
      if (recv.requestID !== REQ_SPAWN) return;

      this.spawned.push(recv.objectID);
      // Objects come back in the order they were requested, so pairing the id
      // with the title makes it obvious which one failed to appear.
      const title = this.pendingTitles.shift() ?? '(unknown)';
      this.placedById.set(recv.objectID, title);
      this.log(`Placed "${title}" (id ${recv.objectID}).`);

      if (this.freezeNext) this.freeze(recv.objectID);
      else this.log(`  left liftable (sling load)`);
    });
  }

  /**
   * Pin a spawned object in place.
   *
   * Two mechanisms, deliberately. `AIReleaseControl` takes the object out of
   * the sim's AI traffic system so nothing drives it, and the freeze key events
   * pin its position and attitude. Release alone was observed to be enough for
   * ambulances, but the freeze costs nothing and covers objects that ignore it.
   */
  private freeze(objectId: number) {
    try {
      this.handle.aIReleaseControl(objectId, REQ_RELEASE);
    } catch {
      // Not fatal -- the freeze events below usually hold it anyway.
    }

    if (!this.freezeReady) {
      try {
        this.handle.mapClientEventToSimEvent(EVENT_FREEZE_LATLON, 'FREEZE_LATITUDE_LONGITUDE_SET');
        this.handle.mapClientEventToSimEvent(EVENT_FREEZE_ALT, 'FREEZE_ALTITUDE_SET');
        this.handle.mapClientEventToSimEvent(EVENT_FREEZE_ATT, 'FREEZE_ATTITUDE_SET');
        this.freezeReady = true;
      } catch (e) {
        this.log(`could not map freeze events: ${(e as Error).message}`);
        return;
      }
    }

    for (const ev of [EVENT_FREEZE_LATLON, EVENT_FREEZE_ALT, EVENT_FREEZE_ATT]) {
      try {
        this.handle.transmitClientEvent(
          objectId, ev, 1, SimConnectConstants.UNKNOWN_GROUP, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY,
        );
      } catch (e) {
        this.log(`could not freeze object ${objectId}: ${(e as Error).message}`);
        return;
      }
    }
  }

  get catalogue() {
    return { boats: this.boats.length, ground: this.ground.length };
  }

  /**
   * Dress the scene for the job. Returns how many objects were requested.
   *
   * Placement is spread over `spreadNm` so a resupply drop reads as a camp and
   * a powerline patrol as a line of structures, rather than everything stacked
   * on one point.
   */
  stage(scene: { lat: number; lon: number; type: SceneType | string; role?: string }): number {
    const role = scene.role ?? '';
    const type = (scene.type as SceneType) ?? 'field';

    // A user override for this role or scene replaces the built-in plan.
    const override = overrides.roles?.[role] ?? overrides.scenes?.[type];
    const base = planFor(role, type);
    if (!base && !override) return 0;

    const plan: StagePlan = {
      pool: override?.pool ?? base?.pool ?? 'ground',
      hints: override?.hints ?? base?.hints ?? [],
      count: override?.count ?? base?.count ?? 1,
      spreadNm: override?.spreadNm ?? base?.spreadNm ?? 0,
      freeze: override?.freeze ?? base?.freeze ?? true,
    };
    this.freezeNext = plan.freeze !== false;
    const explicit = override?.titles ?? [];

    const pool = plan.pool === 'boat' ? this.boats : this.ground;
    if (pool.length === 0 && explicit.length === 0) {
      this.log(`no ${plan.pool} SimObjects in this install -- nothing to place`);
      return 0;
    }

    // Hand-authored titles first: if you've added a model for this job, it is
    // by definition a better choice than anything keyword matching found. Only
    // titles the sim actually reports are used, so a typo fails loudly rather
    // than silently spawning nothing.
    const known = new Set([...this.boats, ...this.ground]);
    const configured = explicit.filter((t) => known.has(t));
    const missing = explicit.filter((t) => !known.has(t));
    if (missing.length > 0) {
      this.log(`configured object(s) not found in this install: ${missing.join(', ')}`);
    }

    let titles = configured.length > 0 ? configured : matches(pool, plan.hints);
    if (titles.length === 0) {
      // Nothing matched the job; anything is better than an empty scene.
      titles = pool.slice(0, 5);
      this.log(`no object matched ${scene.role ?? scene.type}; using a generic one`);
    }

    // Along a bearing for spread-out sites, scattered for clustered ones.
    const lineBearing = Math.random() * 360;
    let placed = 0;

    for (let i = 0; i < plan.count; i++) {
      const title = titles[i % titles.length];
      const spread =
        plan.spreadNm === 0
          ? { lat: scene.lat, lon: scene.lon }
          : plan.spreadNm > 0.3
            ? offset(scene.lat, scene.lon, plan.spreadNm * i, lineBearing) // a line
            : offset(scene.lat, scene.lon, plan.spreadNm * (0.4 + Math.random()), Math.random() * 360);

      try {
        const pos = new InitPosition();
        pos.latitude = spread.lat;
        pos.longitude = spread.lon;
        // Zero altitude with onGround set lets the sim settle it onto terrain
        // or sea level, which is what we want without knowing the elevation.
        pos.altitude = 0;
        pos.pitch = 0;
        pos.bank = 0;
        pos.heading = plan.spreadNm > 0.3 ? lineBearing : Math.random() * 360;
        pos.onGround = true;
        pos.airspeed = 0;

        this.pendingTitles.push(title);
        this.handle.aICreateSimulatedObject(title, pos, REQ_SPAWN);
        placed++;
      } catch (e) {
        this.log(`could not place "${title}": ${(e as Error).message}`);
      }
    }

    if (placed > 0) {
      this.log(`Requested ${placed} object(s): ${this.pendingTitles.slice(-placed).join(', ')}`);
      // Anything the sim silently refuses never gets an id back, so say so
      // rather than leaving an invisible gap at the scene.
      const expected = [...this.pendingTitles];
      setTimeout(() => {
        const missed = expected.filter((t) => ![...this.placedById.values()].includes(t));
        if (missed.length) {
          this.log(`sim refused to place: ${[...new Set(missed)].join(', ')}`);
        }
      }, 4000);
    }
    return placed;
  }

  /** Case-insensitive title search across both pools. */
  search(term: string, limit = 40) {
    const t = term.toLowerCase();
    const hit = (xs: string[]) => xs.filter((x) => x.toLowerCase().includes(t)).slice(0, limit);
    return { boats: hit(this.boats), ground: hit(this.ground) };
  }

  /** A sample of what this install offers, for tuning the hint lists. */
  sampleTitles(n = 25) {
    return { boats: this.boats.slice(0, n), ground: this.ground.slice(0, n) };
  }

  /** Remove anything this contract put in the world. */
  clear() {
    for (const id of this.spawned) {
      try {
        this.handle.aIRemoveObject(id, REQ_REMOVE);
      } catch {
        /* object may already be gone */
      }
    }
    this.spawned = [];
  }

  /** On-screen message in the sim itself. */
  say(message: string, seconds = 8) {
    try {
      this.handle.text(TextType.PRINT_WHITE, seconds, EVENT_TEXT, message);
    } catch {
      // Older protocol levels reject text; not worth surfacing every time.
    }
  }

  /**
   * Load or unload the casualty as real weight.
   *
   * Written to a high payload station so it doesn't fight the aircraft's own
   * crew and fuel stations. Set to 0 to unload.
   */
  setCasualtyWeight(pounds: number) {
    try {
      if (!this.payloadReady) {
        this.handle.addToDataDefinition(
          DEF_PAYLOAD,
          `PAYLOAD STATION WEIGHT:${CASUALTY_STATION}`,
          'pounds',
          SimConnectDataType.FLOAT64,
        );
        this.payloadReady = true;
      }
      this.handle.setDataOnSimObject(DEF_PAYLOAD, SimConnectConstants.OBJECT_ID_USER, {
        value: pounds,
      });
      return true;
    } catch (e) {
      this.log(`could not set casualty weight: ${(e as Error).message}`);
      return false;
    }
  }
}

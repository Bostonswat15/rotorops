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
const REQ_ENUM_HELI = 902;
const REQ_ENUM_PLANE = 903;
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
type StageLayer = {
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

/**
 * A scene is composed of layers, each drawn from its own shortlist.
 *
 * One flat list could not express "the casualty, and the ambulance that came
 * for them": placement walks the matched titles in order, so a single list
 * with people ranked first placed three bodies and no ambulance. A layer per
 * element is what makes a scene read as a scene.
 */
type StagePlan = StageLayer[];

/**
 * Hint lists, ordered best-first.
 *
 * These were guesses until a real MSFS 2024 install was enumerated (1462
 * boats, 403 ground) and checked against them -- 'crate', 'pylon', 'tower'
 * and 'ambulance' all matched nothing, while the install turned out to carry
 * a purpose-built roadside accident, aircraft wrecks with fire variants,
 * rescue baskets and stretchers, 36 casualty poses, and fire/smoke effects.
 * What follows names those directly and keeps the generic terms as the tail
 * so a thinner install still finds something.
 */

/** The load on the hook. Sling loads and pallets before generic freight. */
const CARGO_HINTS = [
  'slingload', 'doublepallet', 'singlepallet', 'pallet', 'container',
  'cargo', 'crate', 'box', 'freight', 'barrel',
];
/** A working site: plant, stores, something half-built. */
const SITE_HINTS = [
  'bulldozer', 'harvester', 'forklift', 'crane', 'tractor', 'loader',
  'tank', 'container', 'pallet', 'tent', 'trailer', 'excavator', 'digger',
  'silo', 'shed', 'hut', 'generator',
];
/**
 * A person on the ground.
 *
 * The install carries EDPro_Person_Laying_down_001-018 and
 * EDPro_Person_Sitting_down_001-018, plus mmh_hikerRescue and
 * mmh_skierRescue. Laying first: someone upright reads as a bystander,
 * someone down reads as the reason you came.
 */
const PERSON_HINTS = [
  'laying_down', 'hikerrescue', 'skierrescue', 'sitting_down',
  'laying', 'hiker', 'person',
];
/** What a casualty is packaged into once you reach them. */
const RESCUE_KIT_HINTS = ['rescuebasket', 'rescuestretcher', 'basket', 'stretcher', 'arcticrescue'];
/** Medical response, real models first. */
const MEDICAL_HINTS = [
  'mmhambulance', 'ambulance', 'medicaltent', 'medic', 'rescuestretcher',
  'rescuebasket', 'rescue', 'emergency',
];
/** Fire, including the standalone fire and smoke effects. */
const FIRE_HINTS = [
  'mmh_fire', 'firetruck', 'truck_fire', 'fire airport', 'truck fire',
  'firefighting', 'fire', 'smokeeffect', 'engine', 'tender', 'pumper',
];
/** Smoke and flare, for marking a scene you are meant to find. */
const SIGNAL_HINTS = ['smokeeffect', 'flareeffect', 'smoke', 'flare'];
const VEHICLE_HINTS = ['truck', 'van', 'suv', 'car', 'pickup', 'jeep', 'bus'];
const BOAT_HINTS = ['fishing', 'trawler', 'yacht', 'boat', 'sail', 'ferry', 'cargo'];
/**
 * A vessel in trouble.
 *
 * The stock ship library carries "_Sink" variants of most hulls -- a ship
 * going down is the whole reason a rescue was tasked, so those come first,
 * then the life raft, and only then an ordinary working boat.
 */
const DISTRESS_BOAT_HINTS = ['sink', 'raft', 'emergency', 'fishing', 'trawler', 'yacht', 'sail'];
/**
 * Small craft only, for water a ship could not reach.
 *
 * Kept apart from DISTRESS_BOAT_HINTS because 'sink' matches the whole
 * Microsoft_Ships_*_Sink family -- a couple of hundred metres of freighter,
 * which is the right answer for a vessel in distress offshore and an absurd
 * one for a swiftwater rescue in a river.
 */
const SMALL_CRAFT_HINTS = ['emergencyraft', 'raft', 'dinghy', 'canoe', 'kayak'];
/**
 * Things strung out along a line to fly past.
 *
 * No SimObject in a stock install is a transmission tower, and none needs to
 * be: the sim renders real pylons from OSM as terrain, which SimConnect can
 * neither enumerate nor place. So this list is for sites that genuinely have
 * no scenery of their own, and a powerline patrol no longer uses it at all.
 */
const STRUCTURE_HINTS = [
  'mast', 'crane', 'tower', 'pylon', 'pole', 'antenna', 'generator',
  'aerial_tank', 'platform tank',
];
/** What turns up when something has gone wrong on a road. */
const RESPONSE_HINTS = [
  'roadsideaccident', 'mmhpolice', 'police', 'mmhambulance', 'ambulance',
  'firetruck', 'sheriff', 'tow', 'recovery',
];
/** A crash site: the wreck itself, burning where the install offers it. */
const WRECK_HINTS = ['ac_wreck', 'wreck'];
/** Small, out of place, and worth spotting from the air. */
const KIT_HINTS = [
  'quad', 'motorbike', 'snowcat', 'raft', 'dinghy', 'kayak', 'canoe',
  'tent', 'backpack', 'atv', 'snowmobile', 'motorcycle', 'bike', 'cart',
];
/** People gathered where people gather: a pad, an estate, a viewpoint. */
const PAX_HINTS = ['limousine', 'limo', 'sportscar', 'suv', 'car', 'van', 'minibus', 'bus'];
/** Somewhere remote that is nonetheless lived in. */
const OUTPOST_HINTS = [
  'tent', 'hut', 'shed', 'cabin', 'trailer', 'bush', 'tank', 'barrel',
  'tractor', 'quad', 'snowcat',
];

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
 *
 * Or compose one out of parts, which is what the built-in plans do:
 *
 *   {
 *     "roles": { "medevac": { "layers": [
 *       { "titles": ["EDPro_Person_Laying_down_008"], "count": 1 },
 *       { "titles": ["MMHAmbulance"], "count": 1, "spreadNm": 0.02 }
 *     ] } }
 *   }
 *
 * A title the install does not actually have is ignored with a warning,
 * and an override left with nothing usable falls back to the built-in
 * plan rather than staging an empty scene.
 */
export type SceneOverride = Partial<StageLayer> & {
  titles?: string[];
  /**
   * Compose a custom scene out of several elements, the same way the
   * built-in plans do. Each layer draws from its own titles/hints, so
   * "the casualty, and the ambulance that came for them" is expressible
   * by hand and not just in code. When present this wins over the flat
   * titles/hints fields above.
   */
  layers?: (Partial<StageLayer> & { titles?: string[] })[];
};
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
 * decision too: a real airport dresses itself, and a check ride wants clear
 * air rather than obstacles.
 *
 * Scenes are composed of layers so they read as a situation rather than a
 * pile of one kind of object -- the casualty AND the ambulance that came for
 * them, the load AND the plant that will lift it.
 */
function planFor(role: string, scene: SceneType): StagePlan | null {
  /** The load you are there to hook: never frozen, or a sling cannot lift it. */
  const load = (hints: string[], count: number, spreadNm: number): StageLayer =>
    ({ pool: 'ground', hints, count, spreadNm, freeze: false });
  /** Anything that is there to be looked at rather than moved. */
  const set = (hints: string[], count: number, spreadNm: number): StageLayer =>
    ({ pool: 'ground', hints, count, spreadNm });
  const afloat = (hints: string[], count: number, spreadNm: number): StageLayer =>
    ({ pool: 'boat', hints, count, spreadNm });

  switch (role) {
    // --- Work with a load on the hook ------------------------------------
    case 'logistics':
    case 'supply':
      // Stores to hook, and the camp that ordered them.
      return [load(CARGO_HINTS, 3, 0.04), set(OUTPOST_HINTS, 2, 0.05)];
    case 'construction':
      // Load to lift, plus the site it is going to.
      return [load(CARGO_HINTS, 2, 0.03), set([...STRUCTURE_HINTS, ...SITE_HINTS], 3, 0.04)];
    case 'signal':
      // Smoke popped by the casualty when they hear you, placed exactly on
      // them -- zero spread, because the whole point is that it marks the
      // spot. One object: two plumes reads as two casualties.
      return [set(SIGNAL_HINTS, 1, 0)];
    case 'sling_pickup':
      // The apron at base, where the load is rigged and waiting. Staged
      // separately from the scene because a sling job now has two ends: the
      // delivery point gets the site it is going to, this gets the thing you
      // are there to collect. Tight spread -- it wants to read as a rigged
      // load beside the aircraft, not freight scattered across the airfield.
      return [load(CARGO_HINTS, 3, 0.02), set(VEHICLE_HINTS, 1, 0.03)];
    case 'industry':
      // A lumber camp, quarry, well or mill. Nothing in the sim marks these
      // -- they are real OSM land use, or a spot the company chose to build
      // on -- so without something placed here you fly to an empty clearing
      // and take it on trust. The stock is the site's, not yours to hook:
      // the load is a payload objective, so all of this stays frozen.
      return [
        set(SITE_HINTS, 3, 0.05),
        set(CARGO_HINTS, 2, 0.03),
        set(OUTPOST_HINTS, 1, 0.05),
        set(VEHICLE_HINTS, 1, 0.04),
      ];

    // --- Emergency work ---------------------------------------------------
    case 'patrol':
      // No towers placed, deliberately.
      //
      // The sim already draws them. MSFS builds transmission lines from the
      // same OSM data the contract samples its waypoints from, so the real
      // pylons are standing on the route before anything is spawned -- which
      // is the whole reason the waypoints snap to OSM tower coordinates.
      //
      // Six placed structures on top of that was not dressing a scene, it was
      // littering one: nothing in this install matches a lattice tower, so
      // STRUCTURE_HINTS fell through to a Skyship mast truck and a small
      // crane truck, and a patrol strung six crane trucks across the
      // wilderness beside the conductor it was inspecting.
      //
      // One service vehicle stays, mid-route, because a crew working the line
      // is the one thing the sim will not draw for you.
      return [set(VEHICLE_HINTS, 1, 0.8)];
    case 'firefighting':
      // MMH_Fire and the smoke effect are standalone objects here, so a
      // fire contract can have a fire in it rather than only the trucks
      // that came to fight it.
      return [set(SIGNAL_HINTS, 2, 0.2), set(FIRE_HINTS, 3, 0.25), set(VEHICLE_HINTS, 1, 0.3)];
    case 'medevac':
      // The patient first -- they are the reason for the contract -- then
      // whatever turned up for them. A roadside scene gets the traffic too.
      if (scene === 'highway') {
        // mmh_roadsideAccident is exactly this scene in one object; the
        // casualties, the responders and the stopped traffic build around it.
        return [
          set(RESPONSE_HINTS, 2, 0.015),
          set(PERSON_HINTS, 2, 0.004),
          set(RESCUE_KIT_HINTS, 1, 0.006),
          set(VEHICLE_HINTS, 3, 0.05),
        ];
      }
      return [
        // Tight on the datum: the casualty is the reason for the contract and
        // the smallest thing in the scene, so scattering them 18 m into the
        // grass made the one object that matters the hardest to find.
        set(PERSON_HINTS, 1, 0.003),
        set(RESCUE_KIT_HINTS, 1, 0.005),
        set(MEDICAL_HINTS, 2, 0.02),
        set(VEHICLE_HINTS, 1, 0.03),
      ];
    case 'sar':
      if (scene === 'vessel') {
        // A hull going down, and people in the water beside it.
        return [afloat(DISTRESS_BOAT_HINTS, 1, 0), set(PERSON_HINTS, 2, 0.005)];
      }
      if (scene === 'riverbank') {
        // Swiftwater: someone in the water and the raft they came off, with
        // their kit washed up on the bank. This shared the vessel branch and
        // put a sinking cargo ship in a river -- nothing that size floats up
        // one, and the scale made the rescue look like a joke.
        return [
          afloat(SMALL_CRAFT_HINTS, 1, 0.004),
          set(PERSON_HINTS, 2, 0.004),
          set(KIT_HINTS, 1, 0.01),
        ];
      }
      // A casualty up a cliff or along a ridge used to get nothing at all,
      // on the grounds that no vehicle belongs up there -- which left the one
      // contract type built entirely around *looking* for someone with
      // nothing to find. The person is the object now, with their kit beside
      // them to give the eye something to catch.
      if (scene === 'cliff' || scene === 'ridgeline' || scene === 'confined') {
        // Smoke is what a casualty on a ridge actually has to signal with,
        // and it is the difference between a search you can fly and one you
        // give up on.
        return [
          set(PERSON_HINTS, 2, 0.004),
          set(SIGNAL_HINTS, 1, 0.008),
          set(KIT_HINTS, 1, 0.008),
        ];
      }
      if (scene === 'beach') {
        return [set(PERSON_HINTS, 2, 0.005), set(KIT_HINTS, 1, 0.01), set(VEHICLE_HINTS, 1, 0.03)];
      }
      if (scene === 'forest' || scene === 'field') {
        // Downed aircraft: the install carries wrecks with burning variants,
        // which is the classic inland search and a far better reason to be
        // hovering over trees than a parked van.
        return [
          set(WRECK_HINTS, 1, 0),
          set(PERSON_HINTS, 2, 0.006),
          set(SIGNAL_HINTS, 1, 0.008),
        ];
      }
      // Ground search: the casualty, and the search party staged nearby.
      return [
        set(PERSON_HINTS, 2, 0.005),
        set(RESCUE_KIT_HINTS, 1, 0.008),
        set(MEDICAL_HINTS, 1, 0.03),
        set(VEHICLE_HINTS, 2, 0.04),
      ];
    case 'offshore':
      // The platform itself is scenery where the sim has it, but a rig with
      // nothing alongside reads as abandoned -- and in plenty of regions
      // there is no platform modelled at all, leaving open water.
      return [afloat(BOAT_HINTS, 2, 0.08)];

    // --- People work ------------------------------------------------------
    case 'executive':
    case 'tourism':
    case 'training':
      return [set(PAX_HINTS, 2, 0.02), set(PERSON_HINTS, 2, 0.008)];
    case 'survey':
      // Something to actually survey, spread along the track.
      return [set(STRUCTURE_HINTS, 4, 0.5), set(SITE_HINTS, 1, 0.05)];

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
  if (scene === 'vessel' || scene === 'riverbank') return [afloat(BOAT_HINTS, 1, 0)];
  if (scene === 'airport' || scene === 'charter' || scene === 'checkride') return null;
  if (scene === 'oil_rig') return [afloat(BOAT_HINTS, 1, 0.05)];
  if (scene === 'rooftop') return null; // nothing settles believably on a roof
  if (scene === 'forest' || scene === 'field') return [set(OUTPOST_HINTS, 3, 0.04)];
  if (scene === 'highway') return [set(RESPONSE_HINTS, 2, 0.03), set(VEHICLE_HINTS, 2, 0.04)];
  if (scene === 'cliff' || scene === 'ridgeline') return [set(PERSON_HINTS, 1, 0.004), set(KIT_HINTS, 1, 0.008)];
  return [set(VEHICLE_HINTS, 2, 0.02)];
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
  /**
   * Flyable aircraft this install actually has.
   *
   * Not used for staging -- you cannot spawn the user's own aircraft as
   * scenery -- but the catalogue has no other honest source for which
   * variants and liveries exist. MSFS gives every livery its own title
   * ("H125 C-GJPC", "H125 Cargo"), so a catalogue written from memory
   * will name aircraft nobody can fly and miss the ones they can.
   */
  private helicopters: string[] = [];
  private planes: string[] = [];
  private spawned: number[] = [];
  private payloadReady = false;
  private freezeReady = false;
  /**
   * Spawns awaiting an object id, in request order.
   *
   * Freeze is carried per spawn rather than held in one field: a scene is
   * staged in layers now, and a load that must stay liftable is requested in
   * the same batch as scenery that must stay put. A single shared flag was
   * read by the time the ids came back, so the last layer's setting won for
   * every object in the batch.
   */
  private pending: { title: string; freeze: boolean }[] = [];
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
      this.handle.enumerateSimObjectsAndLiveries(REQ_ENUM_HELI, SimObjectType.HELICOPTER);
      this.handle.enumerateSimObjectsAndLiveries(REQ_ENUM_PLANE, SimObjectType.AIRCRAFT);
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
      } else if (recv.requestID === REQ_ENUM_HELI) {
        this.helicopters = [...new Set([...this.helicopters, ...titles])];
      } else if (recv.requestID === REQ_ENUM_PLANE) {
        this.planes = [...new Set([...this.planes, ...titles])];
      }
    });

    this.handle.on('assignedObjectID', (recv: any) => {
      if (recv.requestID !== REQ_SPAWN) return;

      this.spawned.push(recv.objectID);
      // Objects come back in the order they were requested, so pairing the id
      // with the request makes it obvious which one failed to appear.
      const req = this.pending.shift();
      const title = req?.title ?? '(unknown)';
      this.placedById.set(recv.objectID, title);
      this.log(`Placed "${title}" (id ${recv.objectID}).`);

      if (req?.freeze === false) this.log(`  left liftable (sling load)`);
      else this.freeze(recv.objectID);
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
    return {
      boats: this.boats.length,
      ground: this.ground.length,
      helicopters: this.helicopters.length,
      planes: this.planes.length,
    };
  }

  /** Every flyable title, for checking the aircraft catalogue against reality. */
  get flyable() {
    return { helicopters: [...this.helicopters], planes: [...this.planes] };
  }

  /**
   * Dress the scene for the job. Returns how many objects were requested.
   *
   * Placement is spread over `spreadNm` so a resupply drop reads as a camp and
   * a powerline patrol as a line of structures, rather than everything stacked
   * on one point.
   */
  stage(scene: {
    lat: number;
    lon: number;
    type: SceneType | string;
    role?: string;
    /**
     * The route this contract actually asks you to fly, when it has one.
     *
     * A powerline patrol follows a real transmission line out of OSM, but
     * staging knew only the start point and strung its props along a random
     * bearing at 0.8 nm intervals -- so the pilot flew the conductor while
     * the towers sat a mile and a half sideways in a field. Given the
     * waypoints, a line layer puts its objects where you are actually
     * required to go.
     */
    path?: { lat: number; lon: number }[];
  }): number {
    const role = scene.role ?? '';
    const type = (scene.type as SceneType) ?? 'field';

    // A user override for this role or scene replaces the built-in plan --
    // but only as far as it actually works. An override naming objects this
    // install does not have used to collapse the scene to a single degenerate
    // layer; now it falls back to the built-in plan, so a stale file (a copy
    // of the example, say, listing models from a mod you don't run) degrades
    // to a working scene instead of an empty field.
    const override = overrides.roles?.[role] ?? overrides.scenes?.[type];
    const base = planFor(role, type);
    if (!base && !override) return 0;

    const known = new Set([...this.boats, ...this.ground]);
    /** Titles this install genuinely has, per layer. Empty means "use hints". */
    const usable = (ts: string[] | undefined): string[] => {
      const wanted = ts ?? [];
      const missing = wanted.filter((t) => !known.has(t));
      if (missing.length > 0) {
        this.log(`configured object(s) not in this install: ${missing.join(', ')}`);
      }
      return wanted.filter((t) => known.has(t));
    };

    /** Per-layer explicit titles, aligned with `layers` below. */
    let layerTitles: string[][] = [];
    let layers: StageLayer[];

    const fallback = (): StageLayer[] => {
      layerTitles = [];
      return base ?? [];
    };

    if (override?.layers?.length) {
      // A hand-composed scene: each layer keeps its own titles.
      const built = override.layers.map((l) => ({
        layer: {
          pool: l.pool ?? override.pool ?? 'ground',
          hints: l.hints ?? [],
          count: l.count ?? 1,
          spreadNm: l.spreadNm ?? override.spreadNm ?? 0.02,
          freeze: l.freeze ?? override.freeze ?? true,
        } as StageLayer,
        titles: usable(l.titles),
      }));
      // Keep only layers that can actually place something.
      const alive = built.filter((b) => b.titles.length > 0 || b.layer.hints.length > 0);
      if (alive.length === 0) {
        this.log(`override for ${role || type} named nothing this install has -- using the built-in scene`);
        layers = fallback();
      } else {
        layers = alive.map((b) => b.layer);
        layerTitles = alive.map((b) => b.titles);
      }
    } else if (override) {
      const configured = usable(override.titles);
      const hints = override.hints ?? [];
      if (configured.length === 0 && hints.length === 0) {
        this.log(`override for ${role || type} named nothing this install has -- using the built-in scene`);
        layers = fallback();
      } else {
        layers = [{
          pool: override.pool ?? base?.[0]?.pool ?? 'ground',
          hints,
          count: override.count ?? base?.[0]?.count ?? 1,
          spreadNm: override.spreadNm ?? base?.[0]?.spreadNm ?? 0,
          freeze: override.freeze ?? base?.[0]?.freeze ?? true,
        }];
        layerTitles = [configured];
      }
    } else {
      layers = base!;
    }

    if (layers.length === 0) return 0;

    // One bearing for the whole scene, so layers strung along a line share it
    // rather than each picking their own and crossing.
    const lineBearing = Math.random() * 360;
    let placed = 0;
    const requested: string[] = [];
    /** Titles already used at this scene, so layers don't repeat each other. */
    const usedTitles = new Set<string>();

    for (const [li, layer] of layers.entries()) {
      const configured = layerTitles[li] ?? [];
      const pool = layer.pool === 'boat' ? this.boats : this.ground;
      if (pool.length === 0 && configured.length === 0) {
        this.log(`no ${layer.pool} SimObjects in this install -- skipping that part of the scene`);
        continue;
      }

      // Hand-authored titles first: if you've added a model for this job, it
      // is by definition a better choice than anything keyword matching
      // found.
      let titles = configured.length > 0 ? configured : matches(pool, layer.hints);
      // Prefer something this scene hasn't used yet, so a casualty layer and
      // a vehicle layer that happen to share a matching title still look
      // like two different things.
      const fresh = titles.filter((t) => !usedTitles.has(t));
      if (fresh.length > 0) titles = fresh;

      if (titles.length === 0) {
        // Nothing matched this layer. Skip rather than substitute: a random
        // airliner tug standing in for a casualty is worse than an empty
        // patch of grass, and the other layers still stand.
        this.log(`no object matched ${layer.hints.slice(0, 3).join('/')} for ${role || type}`);
        continue;
      }

      for (let i = 0; i < layer.count; i++) {
        const title = titles[i % titles.length];
        usedTitles.add(title);
        const wantsLine = layer.spreadNm > 0.3;
        const route = scene.path ?? [];
        let spread: { lat: number; lon: number };
        if (layer.spreadNm === 0) {
          spread = { lat: scene.lat, lon: scene.lon };
        } else if (wantsLine && route.length >= 2) {
          // Walk the real route, spacing objects evenly across it, with a
          // little jitter so they don't sit dead on the waypoint the
          // objective is already marking.
          //
          // A single object goes to the middle of the route rather than the
          // start: with count 1 the even spacing degenerates to index 0, and
          // the start of a route is exactly where the pilot is standing.
          const frac = layer.count === 1 ? 0.5 : i / (layer.count - 1);
          const at = route[Math.min(route.length - 1, Math.round(frac * (route.length - 1)))];
          spread = offset(at.lat, at.lon, 0.02 * Math.random(), Math.random() * 360);
        } else if (wantsLine) {
          spread = offset(scene.lat, scene.lon, layer.spreadNm * i, lineBearing); // a synthetic line
        } else {
          spread = offset(
            scene.lat, scene.lon,
            layer.spreadNm * (0.4 + Math.random()), Math.random() * 360,
          );
        }

        try {
          const pos = new InitPosition();
          pos.latitude = spread.lat;
          pos.longitude = spread.lon;
          // Zero altitude with onGround set lets the sim settle it onto terrain
          // or sea level, which is what we want without knowing the elevation.
          pos.altitude = 0;
          pos.pitch = 0;
          pos.bank = 0;
          pos.heading = wantsLine ? lineBearing : Math.random() * 360;
          pos.onGround = true;
          pos.airspeed = 0;

          this.pending.push({ title, freeze: layer.freeze !== false });
          this.handle.aICreateSimulatedObject(title, pos, REQ_SPAWN);
          requested.push(title);
          placed++;
        } catch (e) {
          this.log(`could not place "${title}": ${(e as Error).message}`);
        }
      }
    }

    if (placed > 0) {
      this.log(`Requested ${placed} object(s): ${requested.join(', ')}`);
      // Anything the sim silently refuses never gets an id back, so say so
      // rather than leaving an invisible gap at the scene.
      setTimeout(() => {
        const arrived = [...this.placedById.values()];
        const missed = requested.filter((t) => !arrived.includes(t));
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

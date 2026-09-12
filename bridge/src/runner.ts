/**
 * The bridge as a library.
 *
 * The CLI in index.ts drives this, and so does the desktop app's main process.
 * Everything it wants to tell a UI goes through one event callback rather than
 * console.log, so the same logic can render as a log line or a status pill.
 */

import { SimSession, distanceNm } from './telemetry.ts';
import { FlightTracker, type Telemetry } from './flight.ts';
import { ObjectiveTracker, type Objective, type ObjectiveProgress } from './objectives.ts';
import { SceneDirector, setSceneOverrides, type SceneType, type SceneOverrides } from './scene-actors.ts';
import { bearingTo, clockPosition, resolveSearchTarget, type LatLon } from './search.ts';
import {
  fetchState, submitFlight, matchAircraft, setBasePosition, setBaseAirports, completeObjective,
  type BridgeState, type BridgeAircraft, type BridgeMission, type ResolveResult,
} from './api.ts';
import { readSceneObjects } from './config.ts';

/** How close to the filed destination counts as arriving there. */
const ARRIVAL_TOLERANCE_NM = 3;
const STATE_POLL_MS = 30_000;
const RECONNECT_MS = 5_000;

export type BridgeEvent =
  | { type: 'log'; message: string }
  | { type: 'warn'; message: string }
  | { type: 'sim'; connected: boolean; version?: string }
  | { type: 'state'; state: BridgeState }
  | { type: 'flight-start'; simTitle: string; departure: string | null; aircraft: string | null; mission: string | null }
  | { type: 'flight-progress'; hours: number; fuelUsed: number; distance: number; airborne: boolean;
      lat: number; lon: number; heading: number; agl: number; groundSpeed: number; altitude: number }
  | { type: 'flight-logged'; result: ResolveResult; aircraft: string; mission: string | null }
  | { type: 'unmatched-aircraft'; simTitle: string }
  // Whatever is loaded in the sim right now, matched against the fleet or not.
  // Lets the UI offer "add this title to an aircraft" without the player having
  // to transcribe a mod's exact TITLE string by hand.
  | { type: 'sim-aircraft'; simTitle: string; matchedId: string | null; matchedName: string | null }
  // Live objective state for the contract being flown.
  | {
      type: 'objectives';
      missionId: string;
      missionTitle: string;
      objectives: ObjectiveProgress[];
      /** Set once a SAR casualty has been sighted; null while still searching. */
      sighted?: { lat: number; lon: number } | null;
    }
  | { type: 'objective-done'; missionId: string; objectiveId: string; label: string }
  | { type: 'objectives-complete'; missionId: string; missionTitle: string }
  // Raw position, emitted whenever the sim reports one -- engines running or
  // not. The moving map uses this so it works while planning, not just in the
  // air.
  | { type: 'position'; lat: number; lon: number; heading: number; agl: number;
      groundSpeed: number; altitude: number; onGround: boolean };

export type Bridge = {
  start(): Promise<void>;
  stop(): void;
  refresh(): Promise<BridgeState | null>;
  readonly state: BridgeState | null;
  readonly simConnected: boolean;
};

export function createBridge(token: string, emit: (e: BridgeEvent) => void): Bridge {
  let state: BridgeState | null = null;
  let sim: SimSession | null = null;
  let tracker: FlightTracker | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let progressTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const log = (message: string) => emit({ type: 'log', message });
  const warn = (message: string) => emit({ type: 'warn', message });

  async function refresh(): Promise<BridgeState | null> {
    try {
      state = await fetchState(token);
      emit({ type: 'state', state });
      armObjectives();
      void reportBasePositions();
    } catch (e) {
      warn(`state refresh failed: ${(e as Error).message}`);
    }
    return state;
  }

  /**
   * Nothing in the web app knows where an ICAO is; the sim's facility cache
   * does. Fill in any base still missing a position so mission scenes can be
   * generated around it.
   */
  async function reportBasePositions() {
    const pending = state?.bases_needing_position ?? [];
    if (!sim) return;

    for (const b of pending) {
      const airport = sim.airportCache.get(b.icao?.trim().toUpperCase() ?? '');
      if (!airport) continue;
      try {
        await setBasePosition(token, b.id, airport.lat, airport.lon);
        log(`Reported position of ${b.icao} to the company (${airport.lat.toFixed(3)}, ${airport.lon.toFixed(3)})`);
      } catch (e) {
        warn(`could not report base position: ${(e as Error).message}`);
      }
    }

    await reportNearbyAirports();
  }

  /**
   * Send the airports around each base.
   *
   * Mission generation uses these as stand-ins for terrain -- an airport is on
   * land, so a scene placed near one is on land too. Without them, scenes are
   * put at a random bearing and a "field" can end up in the sea.
   */
  let airportsReportedAt = 0;
  async function reportNearbyAirports() {
    if (!sim || sim.airportCache.size === 0) return;
    // The facility cache fills as you fly; refreshing hourly is plenty.
    if (Date.now() - airportsReportedAt < 60 * 60_000) return;

    for (const b of state?.bases ?? []) {
      if (b.latitude == null || b.longitude == null) continue;
      if ((b.airport_count ?? 0) > 20) continue; // already has a decent scatter

      const near = [...sim.airportCache.values()]
        .map((a) => ({ a, d: distanceNm(Number(b.latitude), Number(b.longitude), a.lat, a.lon) }))
        .filter((x) => x.d <= 150)
        .sort((x, y) => x.d - y.d)
        .slice(0, 200)
        .map(({ a }) => ({ icao: a.icao, lat: a.lat, lon: a.lon }));

      if (near.length === 0) continue;
      try {
        const n = await setBaseAirports(token, b.id, near);
        airportsReportedAt = Date.now();
        log(`Reported ${n} airports near ${b.icao ?? 'base'} for scene placement.`);
      } catch (e) {
        warn(`could not report nearby airports: ${(e as Error).message}`);
      }
    }
  }

  const missionFor = (ac: BridgeAircraft): BridgeMission | null =>
    state?.dispatched.find((m) => m.aircraft_id === ac.id) ?? null;

  // --- Objectives ----------------------------------------------------------

  const objectives = new ObjectiveTracker((icao) => {
    const a = sim?.airportCache.get(icao.trim().toUpperCase());
    return a ? { lat: a.lat, lon: a.lon } : null;
  });
  let objectiveMission: BridgeMission | null = null;
  let director: SceneDirector | null = null;
  /** Weight of whoever we picked up, so it can be unloaded on delivery. */
  let casualtyLb = 0;
  /** Where the SAR casualty really is. Derived here; never sent to the server. */
  let searchTarget: LatLon | null = null;
  /** Most recent telemetry, for capability checks when a contract arms. */
  let lastSnapshot: Record<string, number | string> | null = null;
  const numOf = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  /**
   * Load the contract the current aircraft is flying, if it has objectives.
   *
   * Called both when the loaded aircraft changes and on every state refresh --
   * dispatching a contract while already sitting in the helicopter doesn't
   * change the sim's TITLE, so keying off that alone meant objectives never
   * armed for the job you just accepted.
   */
  /** So the reason is stated once, not on every poll. */
  let warnedNoArm = false;
  function armObjectives(ac?: BridgeAircraft | null) {
    const aircraft =
      ac !== undefined
        ? ac
        : state && currentSimTitle
          ? matchAircraft(state.aircraft, currentSimTitle)
          : null;

    const m = aircraft ? missionFor(aircraft) : null;
    if (!m || !Array.isArray(m.objectives) || m.objectives.length === 0) {
      // Say which of the three ways this can fail actually happened. The map
      // draws its rings from the database, not from here, so a contract whose
      // objectives never armed looks completely normal in the app and simply
      // never ticks -- the failure has to announce itself or it reads as the
      // objectives being broken.
      if (objectiveMission || !warnedNoArm) {
        warnedNoArm = true;
        if (!state) {
          // Distinct from a naming mismatch, and the fix is nothing to do
          // with the aircraft: with no fleet to compare against, every title
          // looks unrecognised, so saying "not in the fleet" sends you to
          // link an aircraft that is already linked.
          warn(
            'Your fleet could not be read from the server, so nothing can be ' +
              'tracked no matter what you are flying. See the state refresh error above.',
          );
        } else if (!aircraft) {
          warn(
            `Loaded aircraft "${currentSimTitle || 'unknown'}" is not in the fleet, ` +
              'so no contract can be tracked. Link it on Settings -> Sim Link.',
          );
        } else if (!m) {
          log(`No contract dispatched to ${aircraft.display_name}. Dispatch one from the Mission Board.`);
        } else {
          log(`Contract "${m.title}" has no objectives to track.`);
        }
      }
      objectiveMission = null;
      return;
    }
    warnedNoArm = false;
    if (objectiveMission?.id === m.id) return;
    objectiveMission = m;
    signalled = false;
    const alreadyDone = Object.entries(m.objectives_state ?? {})
      .filter(([, v]) => v?.done)
      .map(([k]) => k);
    log(`Contract "${m.title}": ${m.objectives.length} objectives armed.`);

    // Warn now rather than after a 40 nm transit: plenty of helicopters have no
    // sling or hoist fitted, and the contract simply cannot be completed in one.
    const kinds = new Set(
      (m.objectives as Objective[]).map((o) => (o as { kind: string }).kind),
    );
    // Deliberately not a warning any more. The stock MSFS 2024 H125 Cargo flies
    // a visible rope and still reports zero cables, so "no sling cables" does
    // not mean "no sling" -- and the objective now falls back to the weight the
    // load puts on the airframe, which works either way.
    if (kinds.has('sling') && lastSnapshot && numOf(lastSnapshot.numSlingCables) === 0) {
      log(`"${m.title}" needs a sling. This aircraft reports no sling cables, so the`);
      log('load will be judged by the weight it puts on the airframe instead.');
    }
    if (kinds.has('hoist') && lastSnapshot && lastSnapshot.hoistDeployed === undefined) {
      warn(`"${m.title}" needs a hoist, but this aircraft reports no hoist.`);
      director?.say('WARNING: this aircraft has no hoist — the casualty cannot be winched.', 12);
    }

    // A search contract hides the casualty: the server holds only the datum, and
    // the real position is derived here from the contract id. Deriving rather
    // than storing means it survives a bridge restart without the web app ever
    // being told the answer.
    const spec = (m.objectives as Objective[]).find((o) => o.kind === 'search');
    searchTarget =
      spec && spec.kind === 'search' ? resolveSearchTarget(m.id, spec) : null;

    // Testing a search you cannot see the answer to means flying the whole
    // sweep to find out whether one line of code works. Off by default and
    // deliberately loud when on -- the hidden position is the mechanic, and
    // nobody should reveal it by accident.
    if (searchTarget && process.env.ROTOROPS_REVEAL) {
      warn(
        `REVEAL: casualty is at ${searchTarget.lat.toFixed(5)}, ${searchTarget.lon.toFixed(5)} ` +
          `(${distanceNm(spec && spec.kind === 'search' ? spec.datum_lat : 0,
            spec && spec.kind === 'search' ? spec.datum_lon : 0,
            searchTarget.lat, searchTarget.lon).toFixed(2)} nm from the datum)`,
      );
    }

    objectives.load(m.objectives as Objective[], alreadyDone, searchTarget);

    // Put the job in the world, and brief the pilot inside the sim.
    if (director && m.scene_lat != null && m.scene_lon != null) {
      director.clear();
      casualtyLb = 0;
      director.setCasualtyWeight(0);
      // Objects go where the casualty actually is, not at the datum -- the sim
      // stops drawing a person-sized object a few hundred metres out, so this
      // is what makes the search a real visual search.
      const at = searchTarget ?? { lat: Number(m.scene_lat), lon: Number(m.scene_lon) };
      // The route the contract actually asks for, where it has one. A line
      // patrol follows a real transmission line, so its props belong on that
      // line rather than strung along a bearing picked at random.
      const route = (m.objectives as Objective[])
        .map((o) => o as { lat?: number; lon?: number })
        .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
        .map((o) => ({ lat: Number(o.lat), lon: Number(o.lon) }));
      const placed = director.stage({
        lat: at.lat,
        lon: at.lon,
        type: (m.scene_type ?? 'field') as SceneType,
        role: m.role,
        path: route,
      });

      // A sling job has two ends. The scene above gets the site the load is
      // going to; the pickup gets the load itself, on the apron at base,
      // because otherwise the contract asks you to hook up something that
      // was never put anywhere.
      const pickup = (m.objectives as Objective[]).find(
        (o) => o.kind === 'sling' && typeof (o as { lat?: number }).lat === 'number',
      ) as { lat: number; lon: number } | undefined;
      if (pickup) {
        const n = director.stage({
          lat: pickup.lat,
          lon: pickup.lon,
          type: 'field',
          role: 'sling_pickup',
        });
        if (n > 0) log(`Staged ${n} object(s) at the pickup.`);
      }
      director.say(
        spec && spec.kind === 'search'
          ? `RotorOps — ${m.title}. Search datum ${m.scene_name ?? 'set'}, ` +
              `radius ${spec.radius_nm} nm. ` +
              (spec.beacon ? 'Beacon active — home on the signal.' : 'No beacon — visual search.')
          : `RotorOps — ${m.title}. Target: ${m.scene_name ?? 'scene'}.` +
              (placed > 0 ? ` ${placed} object(s) on scene.` : ''),
        12,
      );
    }
    emit({
      type: 'objectives',
      missionId: m.id,
      missionTitle: m.title,
      objectives: objectives.snapshotProgress(),
      sighted: sightedForUi(),
    });
  }

  /**
   * Say out loud why the current objective is not ticking.
   *
   * The hint already goes to the app, but "it just says go back to it" is
   * exactly the report that needs numbers rather than a phrase -- distance
   * against the zone that actually counts, and altitude against the ceiling.
   * Throttled hard: this runs on every telemetry sample.
   */
  let lastWhyAt = 0;
  let lastWhyId: string | null = null;
  function logWhyPending(s: Record<string, number | string>) {
    const o = objectives.current as unknown as Record<string, any> | null;
    if (!o) return;
    const now = Date.now();
    // On a change of objective say it immediately; otherwise every 15 s.
    if (o.id === lastWhyId && now - lastWhyAt < 15_000) return;
    lastWhyAt = now;
    lastWhyId = o.id;
    const hint = objectives.snapshotProgress().find((p) => p.id === o.id)?.hint ?? null;
    if (typeof o.lat === 'number' && typeof o.lon === 'number') {
      const d = distanceNm(n(s.lat), n(s.lon), o.lat, o.lon);
      const parts = [
        `"${o.label}"`,
        `${d.toFixed(2)} nm away`,
        typeof o.radius_nm === 'number' ? `zone ${(Math.max(0.5, o.radius_nm * 1.35)).toFixed(2)} nm` : null,
        typeof o.max_agl_ft === 'number'
          ? `agl ${Math.round(n(s.agl))} ft / max ${o.max_agl_ft}`
          : null,
        n(s.onGround) === 1 ? 'on ground' : 'airborne',
      ].filter(Boolean);
      log(`Pending: ${parts.join(' · ')}${hint ? ` — ${hint}` : ''}`);
    } else if (hint) {
      log(`Pending: "${o.label}" — ${hint}`);
    }
  }

  /**
   * The casualty signals when they hear you coming.
   *
   * A search is a real visual search -- the sim stops drawing a person-sized
   * object a few hundred metres out, and the detection model peaks at about
   * 0.55 nm in the best case. Sweeping a 1.5 nm circle for something that
   * small is tedious rather than hard, and nothing about it feels like the
   * moment a survivor sees a helicopter.
   *
   * So once you are inside 1.2 nm -- comfortably beyond what you could pick
   * out by eye -- they pop smoke. It is a head start, not a giveaway: the
   * objective still needs you to close to detection range and hold contact.
   *
   * Fires once per contract. The ceiling stops a high transit overhead from
   * burning the flare before the search has even begun.
   */
  /**
   * What the app is allowed to draw as the casualty.
   *
   * Normally nothing until they are sighted -- the position is derived here
   * precisely so the web app never holds it. Under reveal it is handed over
   * from the moment the contract arms, so a search can be tested by flying
   * straight to the answer instead of sweeping for it. A log line in a
   * console behind the sim is not much use when the map is the thing you are
   * looking at.
   */
  function sightedForUi(): LatLon | null {
    if (objectives.sighted) return objectives.sighted;
    return process.env.ROTOROPS_REVEAL ? searchTarget : null;
  }

  const SIGNAL_RANGE_NM = 1.2;
  const SIGNAL_CEILING_FT = 2500;
  let signalled = false;
  function maybeSignal(s: Record<string, number | string>) {
    if (signalled || !searchTarget || !director) return;
    const o = objectives.current as { kind?: string } | null;
    if (o?.kind !== 'search') return;
    if (n(s.agl) > SIGNAL_CEILING_FT) return;

    const here = { lat: n(s.lat), lon: n(s.lon) };
    const d = distanceNm(here.lat, here.lon, searchTarget.lat, searchTarget.lon);
    if (d > SIGNAL_RANGE_NM) return;

    // Set before staging: a failure to place the object should not leave this
    // retrying on every telemetry sample for the rest of the contract.
    signalled = true;
    const placed = director.stage({
      lat: searchTarget.lat,
      lon: searchTarget.lon,
      type: 'field',
      role: 'signal',
    });
    if (placed > 0) {
      const rel = clockPosition(bearingTo(here, searchTarget), n(s.heading));
      director.say(`SIGNAL — smoke ${rel}, ${d.toFixed(1)} nm. Turn toward it.`, 10);
      log(`Casualty signalled at ${d.toFixed(2)} nm.`);
    } else {
      log('Casualty would have signalled, but this install has no smoke or flare object.');
    }
  }

  function trackObjectives(s: Record<string, number | string>) {
    if (!objectiveMission || !objectives.isLoaded) return;
    maybeSignal(s);
    const justDone = objectives.update(s);
    if (justDone.length === 0) logWhyPending(s);

    for (const id of justDone) {
      const label =
        objectives.snapshotProgress().find((o) => o.id === id)?.label ?? id;
      log(`Objective complete: ${label}`);

      // Make it land in the sim as well as the app.
      if (director) {
        const found = objectives.sighted;
        if (found && searchTarget && id === 'search') {
          // Call it the way a crew would: clock position off the nose, and how
          // far. The pilot still has to get eyes on and set up the hoist.
          const brg = bearingTo({ lat: n(s.lat), lon: n(s.lon) }, found);
          const rel = clockPosition(brg, n(s.heading));
          director.say(`SURVIVOR SIGHTED — ${rel}. Set up for the recovery.`, 12);
          log(`Casualty sighted at ${found.lat.toFixed(5)}, ${found.lon.toFixed(5)}.`);
        } else {
          director.say(`✓ ${label}`, 6);
        }

        // Winching someone up, or loading them aboard, is real weight from here
        // on -- you fly the rest of the job heavier than you arrived.
        if ((id === 'hoist' || id === 'load') && casualtyLb === 0) {
          casualtyLb = 220;
          if (director.setCasualtyWeight(casualtyLb)) {
            director.say('Casualty aboard — 220 lb. Get them to the receiving field.', 10);
            log('Casualty loaded: +220 lb on the airframe.');
          }
        }
        // Delivered: hand them over and take the weight back off.
        if ((id === 'deliver' || id === 'return') && casualtyLb > 0) {
          director.setCasualtyWeight(0);
          casualtyLb = 0;
          director.say('Casualty handed over. Well flown.', 8);
        }
      }

      emit({ type: 'objective-done', missionId: objectiveMission.id, objectiveId: id, label });
      // Persist so the rest of the company sees it happen live.
      void completeObjective(token, objectiveMission.id, id).catch((e) =>
        warn(`could not record objective: ${(e as Error).message}`),
      );
    }

    emit({
      type: 'objectives',
      missionId: objectiveMission.id,
      missionTitle: objectiveMission.title,
      objectives: objectives.snapshotProgress(),
      sighted: sightedForUi(),
    });

    if (justDone.length && objectives.allComplete) {
      log(`All objectives complete for "${objectiveMission.title}".`);
      emit({
        type: 'objectives-complete',
        missionId: objectiveMission.id,
        missionTitle: objectiveMission.title,
      });
    }
  }

  const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  /** Position on every sample, so the map has something to draw immediately. */
  function reportPosition(s: Record<string, number | string>) {
    const lat = n(s.lat);
    const lon = n(s.lon);
    if (lat === 0 && lon === 0) return; // sim not settled yet
    emit({
      type: 'position',
      lat, lon,
      heading: n(s.heading),
      agl: n(s.agl),
      groundSpeed: n(s.groundSpeed),
      altitude: n(s.altitude),
      onGround: n(s.onGround, 1) === 1,
    });
  }

  // Announce the loaded aircraft once per change rather than every second.
  let lastReportedTitle: string | null = null;
  let lastReportedMatch: string | null = null;
  let currentSimTitle: string | null = null;
  function reportAircraftChange(simTitle: string) {
    if (!simTitle) return;
    currentSimTitle = simTitle;
    const ac = state ? matchAircraft(state.aircraft, simTitle) : null;
    const matchId = ac?.id ?? null;
    // Re-announce when the match changes, not only when the title does.
    // Buying the aircraft, or linking the title to one you already own,
    // fixes the match without the title ever changing -- and the app went
    // on saying "not in your fleet" until the aircraft was reloaded in the
    // sim, which reads as the link having silently failed.
    if (simTitle === lastReportedTitle && matchId === lastReportedMatch) return;
    lastReportedTitle = simTitle;
    lastReportedMatch = matchId;
    emit({
      type: 'sim-aircraft',
      simTitle,
      matchedId: ac?.id ?? null,
      matchedName: ac?.display_name ?? null,
    });
    // Loading the aircraft is what tells us which contract is being flown.
    armObjectives(ac);
  }

  async function onFlight(t: Telemetry) {
    await refresh();
    const ac = state ? matchAircraft(state.aircraft, t.sim_title) : null;
    if (!ac) {
      emit({ type: 'unmatched-aircraft', simTitle: t.sim_title });
      warn(`Flight finished but "${t.sim_title}" matches no fleet aircraft -- not logged.`);
      return;
    }
    const mission = missionFor(ac);

    // Helicopter work often ends off-airport, so finishing within tolerance of
    // the filed destination counts as arriving there.
    let arrival = t.arrival;
    if (mission?.destination && sim) {
      const d = sim.distanceToIcao(mission.destination, t.end_lat, t.end_lon);
      if (d !== null && d <= ARRIVAL_TOLERANCE_NM) arrival = mission.destination;
    }

    try {
      const result = await submitFlight(token, ac.id, mission?.id ?? null, {
        departure: t.departure ?? mission?.origin ?? null,
        arrival,
        duration_hr: t.duration_hr,
        fuel_used: t.fuel_used,
        payload: t.payload,
        touchdown_fpm: t.touchdown_fpm,
        crashed: t.crashed,
        incidents: t.incidents,
        distance_flown_nm: t.distance_flown_nm,
        sim_title: t.sim_title,
        max_g: t.max_g,
        started_at: t.started_at,
        ended_at: t.ended_at,
      });
      director?.clear();
      director?.setCasualtyWeight(0);
      casualtyLb = 0;
      emit({
        type: 'flight-logged',
        result,
        aircraft: ac.display_name,
        mission: mission?.title ?? null,
      });
      await refresh();
    } catch (e) {
      warn(`Failed to submit flight: ${(e as Error).message}`);
    }
  }

  async function connect() {
    if (stopped) return;
    sim = new SimSession();
    tracker = new FlightTracker((lat, lon) => sim!.nearestAirport(lat, lon)?.icao ?? null);

    sim.on('log', log);
    sim.on('connected', (version) => {
      emit({ type: 'sim', connected: true, version });
      const opt = sim!.availableOptional;
      log(`Rotor SimVars available: ${opt.length ? opt.join(', ') : 'none'}`);

      // Learn what this install can place at a scene, then re-arm so a contract
      // accepted before the sim connected still gets staged.
      director = new SceneDirector(sim!.connection, log);
      // Custom SimObject mappings, if the player has authored any.
      const custom = readSceneObjects() as SceneOverrides | null;
      setSceneOverrides(custom);
      if (custom) {
        const n =
          Object.keys(custom.roles ?? {}).length + Object.keys(custom.scenes ?? {}).length;
        log(`Loaded ${n} custom scene-object mapping(s) from scene-objects.json.`);
      }
      director.discover();
      setTimeout(() => {
        const c = director?.catalogue;
        if (c) log(`Scene objects available: ${c.boats} boats, ${c.ground} ground.`);
        if (c?.excluded) {
          log(
            `${c.excluded} add-on object(s) excluded: scenes use only what ships with the ` +
              'sim. Stock has no people, smoke or wrecks, so rescue scenes will be sparse. ' +
              'Set "stockOnly": false in scene-objects.json to use everything installed.',
          );
        }
        const sample = director?.sampleTitles(12);
        if (sample?.ground.length) log(`Ground objects: ${sample.ground.join(' | ')}`);
        if (sample?.boats.length) log(`Boat objects: ${sample.boats.join(' | ')}`);
        objectiveMission = null; // force a restage now the director exists
        armObjectives();
      }, 4000);
    });
    sim.on('snapshot', (s) => {
      lastSnapshot = s;
      reportAircraftChange(String(s.title ?? '').trim());
      reportPosition(s);
      tracker!.onSnapshot(s);
      trackObjectives(s);
    });
    sim.on('touchdown', (fpm, g) => {
      tracker!.onTouchdown(fpm, g);
      log(`Touchdown: ${Math.round(fpm)} fpm, ${g.toFixed(2)}g`);
    });
    sim.on('disconnected', () => {
      emit({ type: 'sim', connected: false });
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    });

    tracker.on('log', log);
    tracker.on('start', ({ simTitle, departure }: { simTitle: string; departure: string | null }) => {
      const ac = state ? matchAircraft(state.aircraft, simTitle) : null;
      const mission = ac ? missionFor(ac) : null;
      emit({
        type: 'flight-start',
        simTitle,
        departure,
        aircraft: ac?.display_name ?? null,
        mission: mission?.title ?? null,
      });
      if (!ac) emit({ type: 'unmatched-aircraft', simTitle });
    });
    tracker.on('flight', (t: Telemetry) => void onFlight(t));

    try {
      await sim.connect();
    } catch (e) {
      warn((e as Error).message);
      emit({ type: 'sim', connected: false });
      if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }
  }

  return {
    async start() {
      stopped = false;
      await refresh();
      pollTimer = setInterval(refresh, STATE_POLL_MS);
      // Mid-flight figures for the status bar.
      progressTimer = setInterval(() => {
        const p = tracker?.progress;
        if (p) {
          emit({
            type: 'flight-progress',
            hours: p.hours,
            fuelUsed: p.fuelUsed,
            distance: p.distance,
            airborne: p.airborne,
            lat: p.lat,
            lon: p.lon,
            heading: p.heading,
            agl: p.agl,
            groundSpeed: p.groundSpeed,
            altitude: p.altitude,
          });
        }
      }, 2000);
      await connect();
    },
    stop() {
      stopped = true;
      director?.clear();
      director?.setCasualtyWeight(0);
      director = null;
      if (pollTimer) clearInterval(pollTimer);
      if (progressTimer) clearInterval(progressTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      pollTimer = progressTimer = null;
      reconnectTimer = null;
      sim?.close();
      sim = null;
      tracker = null;
    },
    refresh,
    get state() {
      return state;
    },
    get simConnected() {
      return sim?.connected ?? false;
    },
  };
}

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
  | { type: 'objectives'; missionId: string; missionTitle: string; objectives: ObjectiveProgress[] }
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
  function armObjectives(ac?: BridgeAircraft | null) {
    const aircraft =
      ac !== undefined
        ? ac
        : state && currentSimTitle
          ? matchAircraft(state.aircraft, currentSimTitle)
          : null;

    const m = aircraft ? missionFor(aircraft) : null;
    if (!m || !Array.isArray(m.objectives) || m.objectives.length === 0) {
      if (objectiveMission) log('No contract with objectives for the loaded aircraft.');
      objectiveMission = null;
      return;
    }
    if (objectiveMission?.id === m.id) return;
    objectiveMission = m;
    const alreadyDone = Object.entries(m.objectives_state ?? {})
      .filter(([, v]) => v?.done)
      .map(([k]) => k);
    objectives.load(m.objectives as Objective[], alreadyDone);
    log(`Contract "${m.title}": ${m.objectives.length} objectives armed.`);

    // Warn now rather than after a 40 nm transit: plenty of helicopters have no
    // sling or hoist fitted, and the contract simply cannot be completed in one.
    const kinds = new Set(
      (m.objectives as Objective[]).map((o) => (o as { kind: string }).kind),
    );
    if (kinds.has('sling') && lastSnapshot && numOf(lastSnapshot.numSlingCables) === 0) {
      warn(`"${m.title}" needs a sling, but this aircraft reports no sling cables.`);
      director?.say('WARNING: this aircraft has no sling — the load cannot be hooked.', 12);
    }
    if (kinds.has('hoist') && lastSnapshot && lastSnapshot.hoistDeployed === undefined) {
      warn(`"${m.title}" needs a hoist, but this aircraft reports no hoist.`);
      director?.say('WARNING: this aircraft has no hoist — the casualty cannot be winched.', 12);
    }

    // Put the job in the world, and brief the pilot inside the sim.
    if (director && m.scene_lat != null && m.scene_lon != null) {
      director.clear();
      casualtyLb = 0;
      director.setCasualtyWeight(0);
      const placed = director.stage({
        lat: Number(m.scene_lat),
        lon: Number(m.scene_lon),
        type: (m.scene_type ?? 'field') as SceneType,
        role: m.role,
      });
      director.say(
        `RotorOps — ${m.title}. Target: ${m.scene_name ?? 'scene'}.` +
          (placed > 0 ? ` ${placed} object(s) on scene.` : ''),
        12,
      );
    }
    emit({
      type: 'objectives',
      missionId: m.id,
      missionTitle: m.title,
      objectives: objectives.snapshotProgress(),
    });
  }

  function trackObjectives(s: Record<string, number | string>) {
    if (!objectiveMission || !objectives.isLoaded) return;
    const justDone = objectives.update(s);

    for (const id of justDone) {
      const label =
        objectives.snapshotProgress().find((o) => o.id === id)?.label ?? id;
      log(`Objective complete: ${label}`);

      // Make it land in the sim as well as the app.
      if (director) {
        director.say(`✓ ${label}`, 6);

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
  let currentSimTitle: string | null = null;
  function reportAircraftChange(simTitle: string) {
    if (!simTitle) return;
    currentSimTitle = simTitle;
    if (simTitle === lastReportedTitle) return;
    lastReportedTitle = simTitle;
    const ac = state ? matchAircraft(state.aircraft, simTitle) : null;
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

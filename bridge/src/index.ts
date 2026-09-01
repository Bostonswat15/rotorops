#!/usr/bin/env node
/**
 * RotorOps bridge -- connects MSFS 2024 to your company backend.
 *
 *   node --experimental-strip-types src/index.ts pair <CODE>
 *   node --experimental-strip-types src/index.ts run
 *   node --experimental-strip-types src/index.ts probe
 */

import { SimSession } from './telemetry.ts';
import { FlightTracker, type Telemetry } from './flight.ts';
import {
  fetchState, redeemPairingCode, submitFlight, matchAircraft,
  type BridgeState, type BridgeAircraft, type BridgeMission,
} from './api.ts';
import { readConfig, writeConfig, CONFIG_PATH, isPackaged, readSceneObjects } from './config.ts';
import { SceneDirector, setSceneOverrides, type SceneOverrides } from './scene-actors.ts';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';

/** How close to the filed destination counts as arriving there. */
const ARRIVAL_TOLERANCE_NM = 3;
const STATE_POLL_MS = 30_000;
const RECONNECT_MS = 5_000;

const ts = () => new Date().toLocaleTimeString();
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ! ${msg}`);
const money = (n: number) =>
  `${n < 0 ? '-' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`;

const interactive = () => process.stdin.isTTY === true;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * A double-clicked exe closes its console the instant the process exits, which
 * would swallow the error the user needs to read.
 */
async function holdWindowOpen() {
  if (!isPackaged || !interactive()) return;
  await ask('\nPress Enter to close...');
}

// ---------------------------------------------------------------------------
// pair
// ---------------------------------------------------------------------------

async function cmdPair(code?: string) {
  if (!code && interactive()) {
    console.log('Generate a pairing code in the app under Settings -> Sim Link.');
    code = await ask('Pairing code: ');
  }
  if (!code) {
    console.error('Usage: pair <CODE>\nGenerate a code in the app under Settings -> Sim Link.');
    process.exit(1);
  }
  const result = await redeemPairingCode(code, `MSFS 2024 (${hostname()})`);
  writeConfig({
    deviceToken: result.device_token,
    deviceId: result.device_id,
    companyId: result.company_id,
  });
  log(`Paired. Token saved to ${CONFIG_PATH}`);

  const state = await fetchState(result.device_token);
  log(`Company: ${state.company.name} -- ${state.aircraft.length} aircraft in fleet.`);
}

// ---------------------------------------------------------------------------
// probe -- report which optional SimVars this install actually exposes
// ---------------------------------------------------------------------------

async function cmdProbe(filter?: string) {
  const sim = new SimSession();
  sim.on('log', (m) => log(m));
  sim.on('connected', (v) => log(`Connected to ${v}`));
  await sim.connect();

  // Scene dressing draws from whatever SimObjects the install has, so probe
  // needs to report them -- otherwise there's no way to know what's available
  // without flying a whole contract.
  const custom = readSceneObjects() as SceneOverrides | null;
  setSceneOverrides(custom);
  log(custom ? `Loaded scene-objects.json overrides.` : `No scene-objects.json -- using built-in matching.`);
  const director = new SceneDirector(sim.connection, (m) => log(m));
  director.discover();

  let seen = 0;
  sim.on('snapshot', (s) => {
    seen += 1;
    if (seen !== 3) return; // let the optional probes settle first
    console.log('\n--- snapshot ---');
    console.log(`  aircraft   ${s.title}`);
    console.log(`  position   ${Number(s.lat).toFixed(4)}, ${Number(s.lon).toFixed(4)}`);
    console.log(`  on ground  ${s.onGround}`);
    console.log(`  fuel       ${Math.round(Number(s.fuelWeight))} lb`);
    console.log(`  payload    ${s.payload} lb`);
    console.log(`\n--- rotor SimVars available on this install ---`);
    const available = sim.availableOptional;
    console.log(available.length ? available.map((n) => `  OK  ${n}`).join('\n') : '  (none)');
    console.log(`\n--- airports in facility cache: ${sim.airportCache.size} ---`);
    const near = s.lat && s.lon ? sim.nearestAirport(Number(s.lat), Number(s.lon), 50) : null;
    console.log(near ? `  nearest: ${near.icao}` : '  nearest: none within 50nm');

    // Enumeration arrives asynchronously; give it a moment before reporting.
    setTimeout(() => {
      const cat = director.catalogue;
      console.log(`\n--- SimObjects available for scene dressing ---`);
      console.log(`  boats:  ${cat.boats}`);
      console.log(`  ground: ${cat.ground}`);

      if (!cat.boats && !cat.ground) {
        console.log('  none reported -- scene objects will not appear');
      } else if (filter) {
        // With well over a thousand titles, listing them all is useless --
        // searching for the kind of prop you need is what's actually wanted.
        const hits = director.search(filter);
        console.log(`\n  matching "${filter}":`);
        console.log(
          hits.boats.length ? `    [boat]   ${hits.boats.join('\n    [boat]   ')}` : '',
        );
        console.log(
          hits.ground.length ? `    [ground] ${hits.ground.join('\n    [ground] ')}` : '',
        );
        if (!hits.boats.length && !hits.ground.length) console.log('    (no matches)');
      } else {
        const sample = director.sampleTitles(25);
        if (sample.boats.length) {
          console.log(`\n  BOAT (first 25):\n    ${sample.boats.join('\n    ')}`);
        }
        if (sample.ground.length) {
          console.log(`\n  GROUND (first 25):\n    ${sample.ground.join('\n    ')}`);
        }
        console.log('\n  Search for a kind of object:  npm run probe -- fire');
      }
      sim.close();
      process.exit(0);
    }, 3000);
  });

  setTimeout(() => {
    warn('No data received. Is a flight loaded?');
    process.exit(1);
  }, 30_000);
}

// ---------------------------------------------------------------------------
// spawn-test -- prove object placement works, without flying a contract
// ---------------------------------------------------------------------------

/**
 * Puts a scene object about 60 m in front of the aircraft and leaves it there.
 *
 * Everything else about scene dressing depends on this working, and until now
 * the only way to find out was to fly a whole mission to a remote scene. Park
 * somewhere, run this, look out of the window.
 */
async function cmdSpawnTest(kind?: string) {
  const sim = new SimSession();
  sim.on('log', (m) => log(m));
  sim.on('connected', (v) => log(`Connected to ${v}`));
  await sim.connect();

  const custom = readSceneObjects() as SceneOverrides | null;
  setSceneOverrides(custom);
  log(custom ? `Loaded scene-objects.json overrides.` : `No scene-objects.json -- using built-in matching.`);
  const director = new SceneDirector(sim.connection, (m) => log(m));
  director.discover();

  let done = false;
  sim.on('snapshot', (s) => {
    if (done) return;
    const lat = Number(s.lat);
    const lon = Number(s.lon);
    if (!Number.isFinite(lat) || (lat === 0 && lon === 0)) return;
    done = true;

    // Wait for the object enumeration to come back before trying to place one.
    setTimeout(() => {
      const cat = director.catalogue;
      log(`Objects available: ${cat.boats} boats, ${cat.ground} ground.`);
      if (!cat.boats && !cat.ground) {
        warn('This install reports no spawnable SimObjects -- nothing to test.');
        sim.close();
        process.exit(1);
      }

      // Just ahead of the nose, so it lands in view from the cockpit.
      const hdg = Number(s.heading) || 0;
      const R = 3440.065;
      const d = 0.032 / R; // ~60 m in radians
      const rad = (x: number) => (x * Math.PI) / 180;
      const la1 = rad(lat);
      const lo1 = rad(lon);
      const la2 = Math.asin(
        Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(rad(hdg)),
      );
      const lo2 =
        lo1 +
        Math.atan2(
          Math.sin(rad(hdg)) * Math.sin(d) * Math.cos(la1),
          Math.cos(d) - Math.sin(la1) * Math.sin(la2),
        );

      const role = kind ?? 'medevac';
      const placed = director.stage({
        lat: (la2 * 180) / Math.PI,
        lon: (((lo2 * 180) / Math.PI + 540) % 360) - 180,
        type: 'field',
        role,
      });

      director.say(`RotorOps spawn test: ${placed} object(s) placed ahead.`, 15);
      log(`Requested ${placed} object(s) for role "${role}" ~60 m ahead.`);
      log('Look out of the window. Ctrl+C when done -- objects are removed on exit.');

      // Stay alive so the objects persist while you look.
      setTimeout(() => {
        director.clear();
        log('Test objects removed.');
        sim.close();
        process.exit(0);
      }, 120_000);
    }, 4000);
  });

  process.on('SIGINT', () => {
    director.clear();
    log('Test objects removed.');
    sim.close();
    process.exit(0);
  });

  setTimeout(() => {
    if (!done) {
      warn('No position received. Is a flight loaded?');
      process.exit(1);
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// sling -- live sling/hoist state, and a way to fire the pickup toggle
// ---------------------------------------------------------------------------

/**
 * Prints the sling and hoist SimVars as they change.
 *
 * MSFS exposes exactly one sling action -- SLING_PICKUP_RELEASE, a toggle that
 * both hooks and drops. Whether it works over an AI-spawned object is not
 * something the docs answer, so this shows the state live while you experiment.
 *
 * With `fire` as the argument it also transmits the toggle every few seconds,
 * which tests the event path without needing a keybinding.
 */
async function cmdSling(mode?: string) {
  const sim = new SimSession();
  sim.on('log', (m) => log(m));
  sim.on('connected', (v) => log(`Connected to ${v}`));
  await sim.connect();

  const fire = mode === 'fire';
  const EVENT_SLING = 950;
  if (fire) {
    try {
      sim.connection.mapClientEventToSimEvent(EVENT_SLING, 'SLING_PICKUP_RELEASE');
      log('Will toggle SLING_PICKUP_RELEASE every 5s. Ctrl+C to stop.');
    } catch (e) {
      warn(`could not map the sling event: ${(e as Error).message}`);
    }
    setInterval(() => {
      try {
        sim.connection.transmitClientEvent(0, EVENT_SLING, 0, 1, 16);
        log('-> SLING_PICKUP_RELEASE sent');
      } catch (e) {
        warn(`send failed: ${(e as Error).message}`);
      }
    }, 5000);
  } else {
    log('Watching sling state. Try your sling keybind, or run with "fire" to');
    log('trigger SLING_PICKUP_RELEASE from here. Ctrl+C to stop.');
  }

  let last = '';
  let gotData = false;
  let announced = false;
  sim.on('snapshot', (s) => {
    gotData = true;
    if (!announced) {
      announced = true;
      log(`Aircraft: ${String(s.title ?? '(unknown)')}`);
    }
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const cables = n(s.numSlingCables);
    const attached = n(s.slingObjectAttached);
    const pickup = n(s.slingHookPickup);
    const hoist = n(s.hoistDeployed);
    const broken = n(s.slingCableBroken);

    const line =
      `cables=${cables ?? '-'}  attached=${attached ?? '-'}  ` +
      `pickupMode=${pickup ?? '-'}  hoist=${hoist === null ? '-' : hoist.toFixed(0) + '%'}  ` +
      `broken=${broken ?? '-'}  agl=${Math.round(n(s.agl) ?? 0)}ft`;

    // Only print on change, so the console stays readable in a long hover.
    if (line !== last) {
      last = line;
      console.log(`  ${line}`);
      if (cables === 0) {
        console.log('    ^ this aircraft reports no sling cables — it has no sling');
      }
      if (attached === 1) console.log('    ^ LOAD ATTACHED');
    }
  });

  setTimeout(() => {
    if (!gotData) {
      warn('No data received. Is a flight loaded?');
      process.exit(1);
    }
  }, 30_000);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function cmdRun() {
  let cfg = readConfig();
  // First launch of the exe: pair inline rather than making the user find a
  // command line.
  if (!cfg.deviceToken && interactive()) {
    console.log('This bridge is not paired with a company yet.\n');
    await cmdPair();
    cfg = readConfig();
  }
  if (!cfg.deviceToken) {
    console.error(
      isPackaged
        ? 'Not paired. Run:  rotorops-bridge.exe pair <CODE>'
        : 'Not paired. Run:  npm run pair -- <CODE>',
    );
    process.exit(1);
  }
  const token = cfg.deviceToken;

  let state: BridgeState | null = null;
  const refreshState = async (): Promise<BridgeState | null> => {
    try {
      state = await fetchState(token);
    } catch (e) {
      warn(`state refresh failed: ${(e as Error).message}`);
    }
    return state;
  };
  state = await refreshState();
  if (!state) {
    console.error('Could not reach the backend. Check your connection and pairing.');
    process.exit(1);
  }
  log(`${state.company.name} -- $${Math.round(state.company.cash).toLocaleString()}, rep ${state.company.reputation}`);
  log(`${state.dispatched.length} contract(s) dispatched, ${state.aircraft.length} aircraft.`);
  setInterval(refreshState, STATE_POLL_MS);

  let sim: SimSession | null = null;
  let tracker: FlightTracker | null = null;

  const connect = async () => {
    sim = new SimSession();
    tracker = new FlightTracker((lat, lon) => sim!.nearestAirport(lat, lon)?.icao ?? null);

    sim.on('log', (m) => log(m));
    sim.on('connected', (v) => {
      log(`Connected to ${v}. Waiting for engine start.`);
      const opt = sim!.availableOptional;
      log(`Rotor SimVars available: ${opt.length ? opt.join(', ') : 'none'}`);
    });
    sim.on('snapshot', (s) => tracker!.onSnapshot(s));
    sim.on('touchdown', (fpm, g) => {
      tracker!.onTouchdown(fpm, g);
      log(`Touchdown: ${Math.round(fpm)} fpm, ${g.toFixed(2)}g`);
    });
    sim.on('disconnected', () => {
      warn('Sim disconnected. Reconnecting...');
      setTimeout(connect, RECONNECT_MS);
    });

    tracker.on('log', (m: string) => log(m));
    tracker.on('start', ({ simTitle, departure }: { simTitle: string; departure: string | null }) => {
      const ac = state ? matchAircraft(state.aircraft, simTitle) : null;
      log(`Flight started: ${simTitle}${departure ? ` from ${departure}` : ''}`);
      if (ac) {
        const mission = findMissionFor(state, ac);
        log(`  -> ${ac.display_name}${mission ? ` on "${mission.title}" (${mission.origin} -> ${mission.destination})` : ' (no dispatched contract -- will log as positioning)'}`);
      } else {
        warn(`  -> "${simTitle}" does not match any aircraft in your fleet.`);
        warn('     Add it in the app, or add the title as an alias on an existing aircraft.');
      }
    });
    tracker.on('flight', (t: Telemetry) => void onFlight(t));

    try {
      await sim.connect();
    } catch (e) {
      warn(`Sim not available (${(e as Error).message}). Retrying in ${RECONNECT_MS / 1000}s.`);
      setTimeout(connect, RECONNECT_MS);
    }
  };

  const findMissionFor = (s: BridgeState | null, ac: BridgeAircraft): BridgeMission | null =>
    s?.dispatched.find((m) => m.aircraft_id === ac.id) ?? null;

  const onFlight = async (t: Telemetry) => {
    await refreshState();
    const ac = state ? matchAircraft(state.aircraft, t.sim_title) : null;
    if (!ac) {
      warn(`Flight finished but "${t.sim_title}" matches no fleet aircraft -- not logged.`);
      return;
    }
    const mission = findMissionFor(state, ac);

    // Helicopter work often ends off-airport, so nearest-airport alone is a
    // poor test. If we finished within tolerance of the filed destination,
    // that counts as arriving regardless of what the nearest facility is.
    let arrival = t.arrival;
    if (mission?.destination && sim) {
      const d = sim.distanceToIcao(mission.destination, t.end_lat, t.end_lon);
      if (d !== null && d <= ARRIVAL_TOLERANCE_NM) arrival = mission.destination;
    }

    const payload = {
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
    };

    try {
      const r = await submitFlight(token, ac.id, mission?.id ?? null, payload);
      log('--------------------------------------------------');
      log(`Flight logged: ${ac.display_name} ${payload.departure ?? '???'} -> ${arrival ?? '???'}`);
      log(`  ${r.duration_hr.toFixed(2)}h  ${r.fuel_used} lb fuel  landing: ${r.landing_quality}`);
      if (mission) {
        log(`  Contract "${mission.title}": ${r.success ? 'COMPLETE' : 'FAILED'}`);
        log(`  Payout ${money(r.payout)}  fuel ${money(-r.fuel_cost)}  ops ${money(-r.op_cost)}  =  ${money(r.net)}`);
        log(`  Reputation ${r.reputation_delta >= 0 ? '+' : ''}${r.reputation_delta}`);
      } else {
        log(`  Positioning flight. Cost ${money(r.net)}`);
      }
      log(`  Airframe wear now ${r.aircraft_wear}%${r.aircraft_wear >= 85 ? ' -- GROUNDED, maintenance required' : ''}`);
      if (r.incidents.length) log(`  Incidents: ${r.incidents.join(', ')}`);
      log('--------------------------------------------------');
      await refreshState();
    } catch (e) {
      warn(`Failed to submit flight: ${(e as Error).message}`);
      warn(`Telemetry: ${JSON.stringify(payload)}`);
    }
  };

  await connect();

  process.on('SIGINT', () => {
    log('Shutting down.');
    sim?.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------

const [, , cmd, arg] = process.argv;
const run = async () => {
  switch (cmd) {
    case 'pair': return cmdPair(arg);
    case 'probe': return cmdProbe(arg);
    case 'spawn-test': return cmdSpawnTest(arg);
    case 'sling': return cmdSling(arg);
    case 'run':
    case undefined: return cmdRun();
    default:
      console.error(`Unknown command "${cmd}". Expected: pair | run | probe | spawn-test | sling`);
      process.exit(1);
  }
};

run().catch(async (e) => {
  console.error(`\n${(e as Error).message}\n`);
  await holdWindowOpen();
  process.exit(1);
});

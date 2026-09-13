/**
 * SimVar definitions for MSFS 2024.
 *
 * Split into two groups on purpose. SimConnect rejects an *entire* data
 * definition if any single datum name is unknown, so anything I'm not certain
 * exists under this exact name in 2024 goes in OPTIONAL and is registered in
 * its own definition. A bad name there costs us one field, not the flight.
 */

export type DatumType = 'f64' | 'i32' | 'str256';

export type Datum = {
  /** Property name on the emitted snapshot. */
  key: string;
  /** SimVar name as SimConnect knows it. */
  name: string;
  /** Unit string, or null for strings. */
  unit: string | null;
  type: DatumType;
};

/**
 * Read every sample. These are long-standing SimVars, unchanged since FSX in
 * most cases, and the flight log is built from them.
 */
export const CORE_DATA: Datum[] = [
  { key: 'title', name: 'TITLE', unit: null, type: 'str256' },
  { key: 'atcModel', name: 'ATC MODEL', unit: null, type: 'str256' },
  { key: 'lat', name: 'PLANE LATITUDE', unit: 'degrees', type: 'f64' },
  { key: 'lon', name: 'PLANE LONGITUDE', unit: 'degrees', type: 'f64' },
  { key: 'altitude', name: 'PLANE ALTITUDE', unit: 'feet', type: 'f64' },
  { key: 'agl', name: 'PLANE ALT ABOVE GROUND', unit: 'feet', type: 'f64' },
  { key: 'groundSpeed', name: 'GROUND VELOCITY', unit: 'knots', type: 'f64' },
  { key: 'heading', name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', type: 'f64' },
  { key: 'fuelWeight', name: 'FUEL TOTAL QUANTITY WEIGHT', unit: 'pounds', type: 'f64' },
  { key: 'totalWeight', name: 'TOTAL WEIGHT', unit: 'pounds', type: 'f64' },
  { key: 'emptyWeight', name: 'EMPTY WEIGHT', unit: 'pounds', type: 'f64' },
  // Sim clock rather than wall clock, so a paused sim doesn't inflate hours.
  { key: 'absoluteTime', name: 'ABSOLUTE TIME', unit: 'seconds', type: 'f64' },
  { key: 'engine1', name: 'ENG COMBUSTION:1', unit: 'Bool', type: 'i32' },
  { key: 'engine2', name: 'ENG COMBUSTION:2', unit: 'Bool', type: 'i32' },
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'Bool', type: 'i32' },
  { key: 'crashFlag', name: 'CRASH FLAG', unit: 'Number', type: 'i32' },
];

/**
 * High-rate group. Touchdown rate has to be sampled per frame or the number is
 * meaningless -- at 1Hz you miss the contact entirely.
 */
export const TOUCHDOWN_DATA: Datum[] = [
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'Bool', type: 'i32' },
  { key: 'verticalSpeed', name: 'VERTICAL SPEED', unit: 'feet per minute', type: 'f64' },
  { key: 'gForce', name: 'G FORCE', unit: 'GForce', type: 'f64' },
];

/**
 * Rotor-specific variables.
 *
 * Names and indexing verified against the MSFS 2024 SDK documentation
 * (Helicopter Variables and Aircraft Engine Variables) and cross-checked with
 * the token enum in `WASM/include/MSFS/Legacy/gauges.h` in the installed SDK.
 *
 * Still registered one definition per datum: an aircraft that doesn't implement
 * a sling shouldn't cost us the whole telemetry stream. `npm run probe` reports
 * which resolved on a given install.
 */
export const OPTIONAL_DATA: Datum[] = [
  // Indexed by ENGINE index, not rotor. Native unit is "percent over 100";
  // asking for "percent" makes SimConnect convert to a 0-100 scale.
  { key: 'rotorRpmPct', name: 'ROTOR RPM PCT:1', unit: 'percent', type: 'f64' },
  { key: 'rotorBrake', name: 'ROTOR BRAKE ACTIVE', unit: 'Bool', type: 'i32' },
  // Indexed by sling index.
  { key: 'slingCableBroken', name: 'SLING CABLE BROKEN:1', unit: 'Bool', type: 'i32' },
  { key: 'hoistDeployed', name: 'SLING HOIST PERCENT DEPLOYED:1', unit: 'percent', type: 'f64' },
  // Registered both ways deliberately. The SDK documents this one as indexed,
  // but the unindexed name resolves too -- and a var that resolves and always
  // reads 0 is indistinguishable from one that is being asked wrongly. Reading
  // both means a disagreement between them is visible rather than silently
  // taken as "nothing attached".
  { key: 'slingObjectAttached', name: 'SLING OBJECT ATTACHED', unit: 'Bool', type: 'i32' },
  { key: 'slingObjectAttached1', name: 'SLING OBJECT ATTACHED:1', unit: 'Bool', type: 'i32' },
  { key: 'slingHookPickup', name: 'SLING HOOK IN PICKUP MODE', unit: 'Bool', type: 'i32' },
  { key: 'numSlingCables', name: 'NUM SLING CABLES', unit: 'Number', type: 'i32' },
  // The stock MSFS 2024 H125 Cargo flies with a visible rope but reports zero
  // cables, so NUM SLING CABLES is not a reliable gate on its own. These two
  // say whether a cable is actually out and which station it is working from,
  // which is the difference between "no sling fitted" and "sling fitted, idle".
  { key: 'slingCableLength', name: 'SLING CABLE EXTENDED LENGTH:1', unit: 'feet', type: 'f64' },
  { key: 'slingPayloadStation', name: 'SLING ACTIVE PAYLOAD STATION', unit: 'Number', type: 'i32' },
  // Engine health. There is no overtorque SimVar in 2024 -- damage percent is
  // the closest thing the sim exposes.
  { key: 'engineFailed', name: 'ENG FAILED:1', unit: 'Bool', type: 'i32' },
  { key: 'engineDamagePct', name: 'GENERAL ENG DAMAGE PERCENT:1', unit: 'percent', type: 'f64' },
  { key: 'engineOnFire', name: 'ENG ON FIRE:1', unit: 'Bool', type: 'i32' },

  // Flight score (score.ts). Standard SimVars, but none of these has been
  // probed on this install yet -- one that doesn't resolve just drops its rule.
  { key: 'category', name: 'CATEGORY', unit: null, type: 'str256' },
  { key: 'lightBeacon', name: 'LIGHT BEACON', unit: 'Bool', type: 'i32' },
  { key: 'lightStrobe', name: 'LIGHT STROBE', unit: 'Bool', type: 'i32' },
  { key: 'lightLanding', name: 'LIGHT LANDING', unit: 'Bool', type: 'i32' },
  { key: 'bank', name: 'PLANE BANK DEGREES', unit: 'degrees', type: 'f64' },
  { key: 'pitch', name: 'PLANE PITCH DEGREES', unit: 'degrees', type: 'f64' },
  { key: 'ias', name: 'AIRSPEED INDICATED', unit: 'knots', type: 'f64' },
  { key: 'overspeed', name: 'OVERSPEED WARNING', unit: 'Bool', type: 'i32' },
  { key: 'stall', name: 'STALL WARNING', unit: 'Bool', type: 'i32' },
  // Once a second, so a brief spike can slip between samples; the touchdown G
  // is read per frame separately.
  { key: 'gForceLive', name: 'G FORCE', unit: 'GForce', type: 'f64' },
  { key: 'timeOfDay', name: 'TIME OF DAY', unit: 'Enum', type: 'i32' },
  { key: 'visibilityM', name: 'AMBIENT VISIBILITY', unit: 'meters', type: 'f64' },
];

export type Snapshot = {
  [K in string]: number | string | undefined;
} & {
  title?: string;
  lat?: number;
  lon?: number;
  onGround?: number;
  absoluteTime?: number;
};

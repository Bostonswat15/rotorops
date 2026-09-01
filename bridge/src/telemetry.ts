/**
 * SimConnect session: connects to MSFS 2024, registers SimVar definitions and
 * emits snapshots. Knows nothing about missions or the economy.
 */

import { EventEmitter } from 'node:events';
import simconnect from 'node-simconnect';
import { CORE_DATA, TOUCHDOWN_DATA, OPTIONAL_DATA, type Datum } from './simvars.ts';
import { connectionCandidates } from './address.ts';
import { isPackaged } from './config.ts';

const {
  open,
  Protocol,
  SimConnectDataType,
  SimConnectPeriod,
  SimConnectConstants,
  FacilityListType,
} = simconnect as any;

const DEF_CORE = 1;
const DEF_TOUCHDOWN = 2;
const DEF_OPTIONAL_BASE = 100;

const REQ_CORE = 1;
const REQ_TOUCHDOWN = 2;
const REQ_AIRPORTS = 3;
const REQ_OPTIONAL_BASE = 100;

const DATA_TYPE = {
  f64: () => SimConnectDataType.FLOAT64,
  i32: () => SimConnectDataType.INT32,
  str256: () => SimConnectDataType.STRING256,
} as const;

function readDatum(buf: any, type: Datum['type']): number | string {
  if (type === 'f64') return buf.readFloat64();
  if (type === 'i32') return buf.readInt32();
  return buf.readString256();
}

export type Airport = { icao: string; lat: number; lon: number; altitude: number };

/** Great-circle distance in nautical miles. */
export function distanceNm(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const R = 3440.065;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export declare interface SimSession {
  on(e: 'snapshot', fn: (s: Record<string, number | string>) => void): this;
  on(e: 'touchdown', fn: (fpm: number, g: number) => void): this;
  on(e: 'connected', fn: (version: string) => void): this;
  on(e: 'disconnected', fn: () => void): this;
  on(e: 'log', fn: (msg: string) => void): this;
}

export class SimSession extends EventEmitter {
  private handle: any = null;
  /** Optional datums that survived the probe, by definition id. */
  private liveOptional = new Map<number, Datum>();
  /** sendId -> datum, so an exception tells us exactly which name was bad. */
  private pendingProbe = new Map<number, { defId: number; datum: Datum }>();
  private optionalValues: Record<string, number> = {};
  private airports = new Map<string, Airport>();
  private prevOnGround: number | null = null;
  private prevVs = 0;
  private airportTimer: NodeJS.Timeout | null = null;

  get connected() {
    return this.handle !== null;
  }

  /** Raw SimConnect handle, for features beyond reading SimVars. */
  get connection() {
    return this.handle;
  }

  /** Airports currently in the sim's facility cache. */
  get airportCache() {
    return this.airports;
  }

  /** Which optional SimVars this install actually accepted. */
  get availableOptional(): string[] {
    return [...this.liveOptional.values()].map((d) => d.name);
  }

  async connect(): Promise<void> {
    // SunRise is the MSFS 2024 protocol level; KittyHawk (5) is 2020.
    // Autodetect reads the registry via a helper script that cannot be bundled,
    // so a packaged build skips it and relies on SimConnect.xml instead.
    const candidates = connectionCandidates(!isPackaged);
    let recvOpen: any;
    let handle: any;

    for (const candidate of candidates) {
      try {
        ({ recvOpen, handle } = await open(
          'RotorOps Bridge', Protocol.SunRise, candidate.options as any,
        ));
        this.emit('log', `connected via ${candidate.label}`);
        break;
      } catch (e) {
        const detail = (e as Error)?.message;
        if (detail) this.emit('log', `${candidate.label}: ${detail}`);
      }
    }

    if (!handle) {
      // node-simconnect rejects with an empty message when nothing is listening.
      throw new Error(
        'could not reach SimConnect -- is MSFS 2024 running and past the main menu?\n' +
          `Tried: ${candidates.map((c) => c.label).join(', ')}\n` +
          'If your sim uses a non-standard port, set SIMCONNECT_PORT.',
      );
    }
    this.handle = handle;

    handle.on('exception', (ex: any) => {
      const probe = this.pendingProbe.get(ex.sendId);
      if (probe) {
        // Expected for SimVars this build doesn't expose -- drop the field.
        this.liveOptional.delete(probe.defId);
        this.pendingProbe.delete(ex.sendId);
        this.emit('log', `simvar unavailable: ${probe.datum.name} (${ex.exceptionName})`);
        return;
      }
      this.emit('log', `SimConnect exception: ${ex.exceptionName} (index ${ex.index})`);
    });

    handle.on('simObjectData', (recv: any) => this.onData(recv));
    handle.on('airportList', (recv: any) => {
      for (const a of recv.airports) {
        this.airports.set(a.icao.trim().toUpperCase(), {
          icao: a.icao.trim().toUpperCase(),
          lat: a.latitude,
          lon: a.longitude,
          altitude: a.altitude,
        });
      }
    });
    handle.on('quit', () => this.teardown());
    handle.on('close', () => this.teardown());
    handle.on('error', (e: Error) => this.emit('log', `socket error: ${e.message}`));

    this.defineCore();
    this.defineTouchdown();
    this.probeOptional();
    this.refreshAirports();
    this.airportTimer = setInterval(() => this.refreshAirports(), 5 * 60_000);

    const version = `${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`;
    this.emit('connected', version);
  }

  private defineCore() {
    for (const d of CORE_DATA) {
      this.handle.addToDataDefinition(DEF_CORE, d.name, d.unit, DATA_TYPE[d.type]());
    }
    this.handle.requestDataOnSimObject(
      REQ_CORE, DEF_CORE, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND,
    );
  }

  private defineTouchdown() {
    for (const d of TOUCHDOWN_DATA) {
      this.handle.addToDataDefinition(DEF_TOUCHDOWN, d.name, d.unit, DATA_TYPE[d.type]());
    }
    this.handle.requestDataOnSimObject(
      REQ_TOUCHDOWN, DEF_TOUCHDOWN, SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SIM_FRAME,
    );
  }

  /** One definition per optional datum, so failures are isolated. */
  private probeOptional() {
    OPTIONAL_DATA.forEach((d, i) => {
      const defId = DEF_OPTIONAL_BASE + i;
      const sendId = this.handle.addToDataDefinition(
        defId, d.name, d.unit, DATA_TYPE[d.type](),
      );
      this.liveOptional.set(defId, d);
      this.pendingProbe.set(sendId, { defId, datum: d });
      this.handle.requestDataOnSimObject(
        REQ_OPTIONAL_BASE + i, defId, SimConnectConstants.OBJECT_ID_USER,
        SimConnectPeriod.SECOND,
      );
    });
  }

  private refreshAirports() {
    try {
      this.handle?.requestFacilitiesList(FacilityListType.AIRPORT, REQ_AIRPORTS);
    } catch {
      /* facility cache not ready yet; the interval will retry */
    }
  }

  private onData(recv: any) {
    const { requestID, data } = recv;

    if (requestID === REQ_CORE) {
      const snap: Record<string, number | string> = {};
      for (const d of CORE_DATA) snap[d.key] = readDatum(data, d.type);
      // Payload = everything aboard that isn't airframe or fuel.
      const total = snap.totalWeight as number;
      const empty = snap.emptyWeight as number;
      const fuel = snap.fuelWeight as number;
      if (typeof total === 'number' && typeof empty === 'number') {
        snap.payload = Math.max(0, Math.round(total - empty - (fuel ?? 0)));
      }
      this.emit('snapshot', { ...snap, ...this.optionalValues });
      return;
    }

    if (requestID === REQ_TOUCHDOWN) {
      const onGround = data.readInt32();
      const vs = data.readFloat64();
      const g = data.readFloat64();
      // The frame that registers contact already shows the arrested rate, so
      // the meaningful number is the one from the frame before it.
      if (this.prevOnGround === 0 && onGround === 1) {
        this.emit('touchdown', this.prevVs, g);
      }
      this.prevOnGround = onGround;
      if (onGround === 0) this.prevVs = vs;
      return;
    }

    const optIndex = requestID - REQ_OPTIONAL_BASE;
    if (optIndex >= 0 && optIndex < OPTIONAL_DATA.length) {
      const defId = DEF_OPTIONAL_BASE + optIndex;
      const datum = this.liveOptional.get(defId);
      if (datum) this.optionalValues[datum.key] = readDatum(data, datum.type) as number;
    }
  }

  /** Nearest airport to a position, or null if none within `maxNm`. */
  nearestAirport(lat: number, lon: number, maxNm = 5): Airport | null {
    let best: Airport | null = null;
    let bestDist = maxNm;
    for (const a of this.airports.values()) {
      const d = distanceNm(lat, lon, a.lat, a.lon);
      if (d < bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  /** Distance to a known ICAO, or null if it isn't in the facility cache. */
  distanceToIcao(icao: string, lat: number, lon: number): number | null {
    const a = this.airports.get(icao.trim().toUpperCase());
    return a ? distanceNm(lat, lon, a.lat, a.lon) : null;
  }

  private teardown() {
    if (this.airportTimer) clearInterval(this.airportTimer);
    this.airportTimer = null;
    this.handle = null;
    this.prevOnGround = null;
    this.emit('disconnected');
  }

  close() {
    if (this.airportTimer) clearInterval(this.airportTimer);
    this.airportTimer = null;
    try {
      this.handle?.close();
    } catch {
      /* already gone */
    }
    this.handle = null;
  }
}

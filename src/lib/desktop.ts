/**
 * The desktop shell's bridge to the web app.
 *
 * Present only when running inside the Electron app; on the web `desktop()`
 * returns null and every caller falls back to the browser flow.
 */

/** An open cargo trip on the loaded aircraft. Mirrors TripStatus in bridge/src/runner.ts. */
export type TripStatus = {
  id: string;
  loaded: boolean;
  aboardLb: number;
  pickup: string | null;
  pickupLat: number | null;
  pickupLon: number | null;
  pickupRadiusNm: number | null;
  hint: string;
  jobs: {
    id: string;
    title: string;
    drop: string | null;
    delivered: boolean;
    lat: number | null;
    lon: number | null;
    radiusNm: number | null;
  }[];
};

export type BridgeStatus = {
  simConnected: boolean;
  simVersion?: string;
  paired: boolean;
  /** Live objective progress for the contract being flown. */
  objectives: {
    missionId: string;
    missionTitle: string;
    items: { id: string; label: string; done: boolean; progress: number; hint: string | null }[];
    /** Where the SAR casualty turned out to be, once sighted. */
    sighted?: { lat: number; lon: number } | null;
  } | null;
  /** Latest position, present whenever the sim is connected. */
  position: {
    lat: number; lon: number; heading: number; agl: number;
    groundSpeed: number; altitude: number; onGround: boolean;
  } | null;
  /** Whatever is loaded in the sim right now, and whether the fleet knows it. */
  simAircraft: {
    simTitle: string;
    matchedId: string | null;
    matchedName: string | null;
  } | null;
  /**
   * Flight score as it stands: live while flying, and the final one after
   * landing until the next flight starts. Absent from an older desktop build.
   */
  score?: {
    score: number;
    grade: string;
    items: { code: string; label: string; points: number }[];
  } | null;
  /** The cargo trip on the loaded aircraft. Absent from an older desktop build. */
  trip?: TripStatus | null;
  flight: {
    simTitle?: string;
    departure?: string | null;
    aircraft?: string | null;
    mission?: string | null;
    hours?: number;
    fuelUsed?: number;
    distance?: number;
    airborne?: boolean;
  } | null;
};

export type BridgeEvent =
  | { type: "log"; message: string }
  | { type: "warn"; message: string }
  | { type: "sim"; connected: boolean; version?: string }
  | { type: "flight-start"; simTitle: string; departure: string | null }
  | { type: "flight-logged"; result: any; aircraft: string; mission: string | null }
  | { type: "unmatched-aircraft"; simTitle: string }
  | { type: string; [k: string]: unknown };

export type DesktopApi = {
  isDesktop: true;
  hasToken(): Promise<boolean>;
  provision(code: string): Promise<{ ok: boolean }>;
  status(): Promise<BridgeStatus>;
  recentLog(): Promise<{ type: string; message: string; at: number }[]>;
  restart(): Promise<{ ok: boolean; error?: string }>;
  onStatus(fn: (s: BridgeStatus) => void): () => void;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
};

declare global {
  interface Window {
    rotorops?: DesktopApi;
  }
}

/** The desktop API, or null in a browser. */
export function desktop(): DesktopApi | null {
  if (typeof window === "undefined") return null;
  return window.rotorops ?? null;
}

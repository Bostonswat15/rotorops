import { useEffect, useRef, useState } from "react";
import { desktop, type BridgeStatus } from "@/lib/desktop";

export type LiveFlight = {
  lat: number;
  lon: number;
  heading: number;
  agl: number;
  groundSpeed: number;
  altitude: number;
  onGround: boolean;
  /** Present only once a flight is actually under way. */
  hours: number | null;
  fuelUsed: number | null;
  distance: number | null;
  airborne: boolean;
  simTitle?: string;
};

/**
 * Live position from the local sim bridge, plus the track flown so far.
 *
 * Two sources, deliberately: the bridge reports raw `position` on every sample
 * as soon as the sim connects, and a richer `flight` block once engines are
 * running. The map only needs the former -- waiting for a flight meant no map
 * while planning, taxiing, or sitting on the ramp deciding what to do.
 *
 * Desktop only. The browser build has no bridge to listen to.
 */
export function useLiveFlight() {
  const [live, setLive] = useState<LiveFlight | null>(null);
  const [track, setTrack] = useState<[number, number][]>([]);
  const lastPoint = useRef<[number, number] | null>(null);
  const wasFlying = useRef(false);

  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let cancelled = false;

    const apply = (s: BridgeStatus | null) => {
      if (cancelled) return;
      const pos = s?.position ?? null;
      const f = s?.flight ?? null;

      if (!pos) {
        setLive(null);
        return;
      }

      setLive({
        lat: pos.lat,
        lon: pos.lon,
        heading: pos.heading,
        agl: pos.agl,
        groundSpeed: pos.groundSpeed,
        altitude: pos.altitude,
        onGround: pos.onGround,
        hours: f?.hours ?? null,
        fuelUsed: f?.fuelUsed ?? null,
        distance: f?.distance ?? null,
        airborne: f?.airborne ?? !pos.onGround,
        simTitle: f?.simTitle ?? s?.simAircraft?.simTitle,
      });

      // A fresh flight starts a fresh track.
      const flyingNow = !!f;
      if (flyingNow && !wasFlying.current) {
        lastPoint.current = null;
        setTrack([]);
      }
      wasFlying.current = flyingNow;

      // Only extend the track when the aircraft has actually moved, so a long
      // hover doesn't accumulate thousands of identical points.
      const prev = lastPoint.current;
      const moved =
        !prev || Math.abs(prev[0] - pos.lat) > 0.00005 || Math.abs(prev[1] - pos.lon) > 0.00005;
      if (moved) {
        lastPoint.current = [pos.lat, pos.lon];
        setTrack((t) =>
          t.length > 5000 ? [...t.slice(-4000), [pos.lat, pos.lon]] : [...t, [pos.lat, pos.lon]],
        );
      }
    };

    app.status().then(apply).catch(() => {});
    const off = app.onStatus(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return { flight: live, track, isDesktop: !!desktop() };
}

/** The flight score from the sim bridge, live while flying. Null when there's none. */
export function useBridgeScore() {
  const [score, setScore] = useState<BridgeStatus["score"]>(null);

  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let live = true;
    app.status().then((s) => live && setScore(s?.score ?? null)).catch(() => {});
    const off = app.onStatus((s) => live && setScore(s?.score ?? null));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return score ?? null;
}

/**
 * Live objective progress from the sim bridge.
 *
 * Shared by the checklist and the moving map: both need the same snapshot, and
 * the map in particular needs `sighted`, which is the only channel through
 * which a hidden SAR casualty ever becomes known to the app.
 */
export function useBridgeObjectives() {
  const [state, setState] = useState<BridgeStatus["objectives"]>(null);

  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let live = true;
    app.status().then((s) => live && setState(s?.objectives ?? null)).catch(() => {});
    const off = app.onStatus((s) => live && setState(s?.objectives ?? null));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  return state;
}

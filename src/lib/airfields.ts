/**
 * The airfields around a base: the sim's list and OSM's, merged.
 *
 * Shared by the Mission Board and the Cargo Hub, which both build work to and
 * from real fields.
 */

import { findAerodromes, nmBetween, type Aerodrome } from "./osm";
import type { Airport } from "./missions";

/**
 * Airfields near a base, remembered for the session.
 *
 * The runway lookup is the slowest thing Generate does, and a base's airfields
 * don't move between clicks. A result with runways serves a helicopter batch
 * too. A plane result with no runway data at all means Overpass failed the
 * second query, so it isn't kept -- the next click tries again.
 */
const aerodromeCache = new Map<string, Promise<Aerodrome[]>>();
function aerodromesNear(centre: { lat: number; lon: number }, withRunways: boolean): Promise<Aerodrome[]> {
  const where = `${centre.lat.toFixed(3)},${centre.lon.toFixed(3)}`;
  const full = aerodromeCache.get(`${where}:runways`);
  if (full) return full;
  if (!withRunways) {
    const plain = aerodromeCache.get(`${where}:plain`);
    if (plain) return plain;
  }
  const key = `${where}:${withRunways ? "runways" : "plain"}`;
  const p = findAerodromes(centre, 140, withRunways).then(
    (fields) => {
      const noRunways = withRunways && fields.every((f) => f.runway_ft === null);
      if (fields.length === 0 || noRunways) aerodromeCache.delete(key);
      return fields;
    },
    (e: unknown) => {
      aerodromeCache.delete(key);
      throw e;
    },
  );
  aerodromeCache.set(key, p);
  return p;
}

type BridgeAirport = { icao: string; lat: number; lon: number };

/**
 * Every field near a base. The sim's facility cache (reported by the bridge)
 * and OSM can each be empty -- the cache before the bridge has run, OSM in
 * poorly mapped regions -- so both are asked and merged.
 *
 * The sim's list has no runways, so a field it shares with OSM takes OSM's
 * runway data: matched by ident, else by position, since OSM often names a
 * strip the sim knows by ident. A position match is the same field, so its OSM
 * copy is dropped rather than offered twice.
 */
export async function airfieldsNear(
  base: { latitude: unknown; longitude: unknown; nearby_airports?: unknown },
  /** Planes need each field's runways; a helicopter lands beside them, and the lookup is slow. */
  withRunways: boolean,
): Promise<Airport[]> {
  const centre = { lat: Number(base.latitude), lon: Number(base.longitude) };
  const fromBridge = (Array.isArray(base.nearby_airports) ? base.nearby_airports : []).filter(
    (a): a is BridgeAirport =>
      !!a && Number.isFinite((a as BridgeAirport).lat) && Number.isFinite((a as BridgeAirport).lon),
  );
  let fromOsm: Aerodrome[] = [];
  try {
    fromOsm = await aerodromesNear(centre, withRunways);
  } catch {
    // Overpass unavailable; the bridge's list still stands.
  }

  const osmCopyOf = (a: BridgeAirport) => {
    const icao = String(a.icao).toUpperCase();
    let near: Aerodrome | null = null;
    let nearNm = 1;
    for (const o of fromOsm) {
      if (String(o.icao).toUpperCase() === icao) return o;
      const d = nmBetween(a, o);
      if (d <= nearNm) {
        nearNm = d;
        near = o;
      }
    }
    return near;
  };
  const seen = new Set(fromBridge.map((a) => String(a.icao).toUpperCase()));
  const copied = new Set<Aerodrome>();
  return [
    ...fromBridge.map((a): Airport => {
      const o = osmCopyOf(a);
      if (!o) return a;
      copied.add(o);
      return { ...a, runway_ft: o.runway_ft, surface: o.surface };
    }),
    ...fromOsm.filter((a) => !copied.has(a) && !seen.has(String(a.icao).toUpperCase())),
  ];
}

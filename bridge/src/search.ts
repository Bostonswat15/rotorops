/**
 * Search and rescue: finding the casualty rather than being told where it is.
 *
 * A SAR contract gives a *datum* -- the last known position -- and a radius,
 * not a pinpoint. The survivor is somewhere inside that circle and the pilot
 * has to fly a search pattern to find them.
 *
 * The true position never leaves this process. The server stores only the
 * datum, so nothing the web app receives can give the answer away; the offset
 * is derived here from the mission id, which means it is the same every time
 * without anyone having to persist it. Restart the bridge mid-search and the
 * survivor is still where they were.
 *
 * Detection is proximity under conditions, because nothing can read the pilot's
 * eyes. In practice that lines up well with what is actually on screen: MSFS
 * stops drawing a person-sized object a few hundred metres out, so a casualty
 * spawned at the true position genuinely is invisible until you are close. The
 * model below is tuned to agree with roughly that, and to reward the thing real
 * SAR crews do -- fly low, fly slow, and cover the area properly.
 */

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export type LatLon = { lat: number; lon: number };

export type SearchSpec = {
  datum_lat: number;
  datum_lon: number;
  radius_nm: number;
  /** An ELT, EPIRB or PLB the aircraft can home on. Without one it is eyes only. */
  beacon?: boolean;
  /**
   * Places the casualty can really be, when the terrain decides.
   *
   * A climber is on the cliff, not wherever a random offset from the datum
   * happens to land -- which on a sea cliff is the sea. Generation supplies
   * mapped cliff points within the search radius and the pick among them is
   * still made here, from the contract id, so the server holds a shortlist
   * but never the answer.
   */
  target_candidates?: [number, number][];
};

// ---------------------------------------------------------------------------
// Deterministic placement
// ---------------------------------------------------------------------------

/** FNV-1a over a string, so the same contract always seeds the same search. */
function seedOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, and good enough to scatter a casualty. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offsetPosition(lat: number, lon: number, distanceNm: number, bearingDeg: number): LatLon {
  const d = distanceNm / R_NM;
  const b = toRad(bearingDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2),
    );
  return { lat: toDeg(la2), lon: (((toDeg(lo2) + 540) % 360) - 180) };
}

export function bearingTo(from: LatLon, to: LatLon): number {
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  return ((toDeg(Math.atan2(y, x)) + 360) % 360);
}

/**
 * Where the casualty actually is.
 *
 * Uniform over the disc -- sqrt on the radius, otherwise everything bunches
 * near the datum and the search is over before it starts. Held back from the
 * rim by 10% so the target is never right on the boundary, which reads as
 * unfair when you have swept the whole area and it was on the edge line.
 */
export function resolveSearchTarget(missionId: string, spec: SearchSpec): LatLon {
  const r = rng(seedOf(missionId));
  const cands = (spec.target_candidates ?? []).filter(
    (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]),
  );
  if (cands.length > 0) {
    const [lat, lon] = cands[Math.min(cands.length - 1, Math.floor(r() * cands.length))];
    return { lat, lon };
  }
  const dist = spec.radius_nm * 0.9 * Math.sqrt(r());
  const brg = r() * 360;
  return offsetPosition(spec.datum_lat, spec.datum_lon, dist, brg);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));

/**
 * How far out a casualty can be picked up, in nautical miles.
 *
 * Rises with height because you can see further, then falls again because a
 * person stops being a distinguishable shape from altitude -- and drops to
 * nothing above 1500 ft AGL, which is the difference between searching and
 * transiting. Speed scales it down: you cannot scan at 120 kts.
 *
 * Returns 0 when no detection is possible at all.
 */
export function detectionRangeNm(aglFt: number, groundSpeedKts: number): number {
  if (!(aglFt > 0) || aglFt > 1500) return 0;
  if (groundSpeedKts > 110) return 0;

  const byHeight =
    aglFt < 100
      ? lerp(0.08, 0.2, aglFt / 100) // down in the weeds, no horizon
      : aglFt < 700
        ? lerp(0.2, 0.55, (aglFt - 100) / 600) // the sweet spot
        : lerp(0.55, 0.1, (aglFt - 700) / 800); // too high to make out a person

  const bySpeed = groundSpeedKts <= 60 ? 1 : lerp(1, 0.35, (groundSpeedKts - 60) / 50);

  return byHeight * bySpeed;
}

/** Contact has to hold briefly, so clipping a corner at speed isn't a find. */
export const DETECT_HOLD_MS = 1500;

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * How much of the search area has actually been swept.
 *
 * Drives the progress bar, and is the honest answer to "am I getting
 * anywhere?" during a search that has not found anything yet. Cells are marked
 * only when they fall inside the live detection radius, so orbiting the datum
 * at 2000 ft racks up no credit.
 */
export class CoverageGrid {
  private centre: LatLon;
  private radiusNm: number;
  private cellNm: number;
  private cells = new Set<string>();
  private total: number;

  constructor(centre: LatLon, radiusNm: number, cellNm = 0.25) {
    this.centre = centre;
    this.radiusNm = radiusNm;
    this.cellNm = cellNm;
    // Cells whose centre falls inside the circle, counted once up front.
    const n = Math.ceil(radiusNm / cellNm);
    let total = 0;
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        if (Math.hypot(i + 0.5, j + 0.5) * cellNm <= radiusNm) total++;
      }
    }
    this.total = Math.max(1, total);
  }

  /** Nautical miles north and east of the datum, as grid indices. */
  private key(lat: number, lon: number) {
    const dNorth = (lat - this.centre.lat) * 60;
    const dEast = (lon - this.centre.lon) * 60 * Math.cos(toRad(this.centre.lat));
    return `${Math.floor(dNorth / this.cellNm)},${Math.floor(dEast / this.cellNm)}`;
  }

  mark(lat: number, lon: number, rangeNm: number) {
    if (rangeNm <= 0) return;
    const step = this.cellNm / 2;
    const reach = Math.ceil(rangeNm / step);
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        const dn = i * step;
        const de = j * step;
        if (Math.hypot(dn, de) > rangeNm) continue;
        const cLat = lat + dn / 60;
        const cLon = lon + de / (60 * Math.cos(toRad(this.centre.lat)));
        // Only credit ground inside the tasked area.
        if (nmBetween({ lat: cLat, lon: cLon }, this.centre) > this.radiusNm) continue;
        this.cells.add(this.key(cLat, cLon));
      }
    }
  }

  get fraction() {
    return Math.min(1, this.cells.size / this.total);
  }
}

export function nmBetween(a: LatLon, b: LatLon) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass point for a bearing, for radio calls that read like radio calls. */
export function compass(deg: number) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
               'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Clock position of a bearing relative to the nose -- how a crew calls it. */
export function clockPosition(bearingDeg: number, headingDeg: number) {
  const rel = (((bearingDeg - headingDeg) % 360) + 360) % 360;
  const hour = Math.round(rel / 30) || 12;
  return `${hour} o'clock`;
}

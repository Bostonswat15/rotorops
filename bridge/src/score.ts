/**
 * Flight score.
 *
 * Every flight starts at 100 and loses points for what it did wrong -- a hard
 * landing, lights left off, an overspeed, a bank that would spill the coffee --
 * with a few points back for landing well in the dark or in murk. The server
 * turns the score into a grade that moves pay, XP and reputation
 * (20260917000000_flight_score.sql).
 *
 * Each rule counts once per flight: a pilot who holds a steep turn for thirty
 * seconds loses the same five points as one who clips 46 degrees for a moment,
 * because the lesson is the same and a score that bleeds out every second
 * punishes the long flight rather than the bad one. The landing is the
 * exception: it is judged on the worst touchdown of the flight.
 *
 * Every reading here is optional. A SimVar this install doesn't expose simply
 * leaves its rule out -- a missing reading is never scored as a violation.
 */

export type WingKind = 'rotary' | 'fixed';

export type ScoreItem = {
  code: string;
  label: string;
  /** Negative for a deduction, positive for a bonus. */
  points: number;
};

type Snap = Record<string, number | string | undefined>;

const known = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Touchdown rate limits, fpm: [worst rate for this band, points]. */
const LANDING_RATE: Record<WingKind, [number, number, string][]> = {
  // Helicopters settle onto skids; a jet-style 300 fpm arrival is a thump.
  rotary: [
    [60, 0, 'butter'],
    [150, -5, 'smooth'],
    [240, -10, 'normal'],
    [400, -20, 'firm'],
  ],
  fixed: [
    [200, 0, 'butter'],
    [300, -5, 'smooth'],
    [400, -10, 'normal'],
    [500, -20, 'firm'],
  ],
};
const HARD_LANDING_POINTS = -35;

const LANDING_G: [number, number][] = [
  [1.2, 0],
  [1.4, -5],
  [1.7, -10],
];
const HARD_G_POINTS = -20;

/** Below this height above ground on final, the landing light should be on. */
const LANDING_LIGHT_FT: Record<WingKind, number> = { rotary: 500, fixed: 1000 };
/** Helicopters only (user asked 2026-09-15): a plane pitches up hard on a short-field climb-out. */
const PITCH_LIMIT_ROTARY = 30;
const BANK_LIMIT = 45;
const G_HIGH = 2.5;
const G_LOW = -1;
/** A statute mile, in metres: under this at touchdown is a low-visibility landing. */
const LOW_VIS_M = 1609;
const RESERVE_MIN = 30;

const INCIDENT_POINTS: Record<string, { code: string; label: string; points: number }> = {
  'engine damage': { code: 'engine', label: 'Engine damage', points: -25 },
  'engine failure': { code: 'engine', label: 'Engine failure', points: -25 },
  'engine fire': { code: 'engine', label: 'Engine fire', points: -25 },
  'sling cable parted': { code: 'sling', label: 'Sling cable parted', points: -15 },
  'rotor RPM low in flight': { code: 'rotor-rpm', label: 'Rotor RPM low in flight', points: -15 },
};

export function gradeOf(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Points for a touchdown: the worse of its rate and its G. */
export function landingPoints(
  kind: WingKind,
  fpm: number,
  g: number | null,
): { points: number; label: string } {
  const rate = Math.abs(fpm);
  const band = LANDING_RATE[kind].find(([limit]) => rate <= limit);
  const ratePts = band ? band[1] : HARD_LANDING_POINTS;
  const words = band ? band[2] : 'hard';
  let gPts = 0;
  if (known(g)) {
    const gBand = LANDING_G.find(([limit]) => g <= limit);
    gPts = gBand ? gBand[1] : HARD_G_POINTS;
  }
  const g1 = known(g) ? `, ${g.toFixed(2)} G` : '';
  return { points: Math.min(ratePts, gPts), label: `Landing ${Math.round(rate)} fpm${g1} (${words})` };
}

export class FlightScorer {
  readonly kind: WingKind;
  private items = new Map<string, ScoreItem>();
  /** Set while low on final with the landing light off; judged at touchdown. */
  private lightOffOnFinal = false;

  constructor(kind: WingKind) {
    this.kind = kind;
  }

  /**
   * Helicopter or aeroplane, from what the sim says. CATEGORY is the direct
   * answer; a live rotor RPM is the fallback. With neither, rotary -- this
   * app was helicopters first and most fleets still are.
   */
  static kindOf(s: Snap): WingKind {
    const category = typeof s.category === 'string' ? s.category.toLowerCase() : '';
    if (category.includes('heli')) return 'rotary';
    if (category.includes('airplane') || category.includes('aeroplane')) return 'fixed';
    return 'rotary';
  }

  private once(code: string, label: string, points: number) {
    if (!this.items.has(code)) this.items.set(code, { code, label, points });
  }

  /** At engine start: anti-collision lights should already be on. */
  onStart(s: Snap) {
    if (known(s.lightBeacon) && known(s.lightStrobe) && s.lightBeacon === 0 && s.lightStrobe === 0) {
      this.once('beacon', 'Beacon and strobe off at engine start', -5);
    }
  }

  onSample(s: Snap, airborne: boolean) {
    if (!airborne) return;

    if (known(s.bank) && Math.abs(s.bank) > BANK_LIMIT) {
      this.once('bank', `Bank over ${BANK_LIMIT}°`, -5);
    }
    if (this.kind === 'rotary' && known(s.pitch) && Math.abs(s.pitch) > PITCH_LIMIT_ROTARY) {
      this.once('pitch', `Pitch over ${PITCH_LIMIT_ROTARY}°`, -5);
    }
    if (known(s.gForceLive) && (s.gForceLive > G_HIGH || s.gForceLive < G_LOW)) {
      this.once('g', `G over ${G_HIGH} or under ${G_LOW}`, -10);
    }
    if (known(s.overspeed) && s.overspeed === 1) {
      this.once('overspeed', 'Overspeed warning', -10);
    }
    if (this.kind === 'fixed' && known(s.stall) && s.stall === 1) {
      this.once('stall', 'Stall warning', -10);
    }
    if (known(s.lightLanding) && known(s.agl)) {
      if (s.agl < LANDING_LIGHT_FT[this.kind]) {
        if (s.lightLanding === 0) this.lightOffOnFinal = true;
      } else {
        // Climbed back out: whatever happened down low was not a final.
        this.lightOffOnFinal = false;
      }
    }
  }

  onIncident(incident: string) {
    const rule = INCIDENT_POINTS[incident];
    if (rule) this.once(rule.code, rule.label, rule.points);
  }

  onTouchdown(fpm: number, g: number | null, s: Snap) {
    const landing = landingPoints(this.kind, fpm, g);
    const prev = this.items.get('landing');
    // A flight with several landings is judged on its worst one.
    if (!prev || landing.points < prev.points) {
      this.items.set('landing', { code: 'landing', label: landing.label, points: landing.points });
    }
    if (this.lightOffOnFinal) this.once('landing-light', 'Landing light off on final', -5);
    this.lightOffOnFinal = false;

    // TIME OF DAY: 0 dawn, 1 day, 2 dusk, 3 night.
    if (known(s.timeOfDay) && s.timeOfDay === 3) this.once('night', 'Night landing', 3);
    if (known(s.visibilityM) && s.visibilityM < LOW_VIS_M) {
      this.once('low-vis', 'Low-visibility landing', 5);
    }
  }

  /**
   * At shutdown: was there half an hour of fuel left at the rate this flight
   * actually burned it? Only judged when there is a rate worth trusting.
   */
  onFinish(fuelLeftLb: number, fuelUsedLb: number, hours: number) {
    if (hours < 0.1 || fuelUsedLb <= 0 || !known(fuelLeftLb)) return;
    const minutesLeft = (fuelLeftLb / (fuelUsedLb / hours)) * 60;
    if (minutesLeft < RESERVE_MIN) {
      this.once('reserve', `Landed with under ${RESERVE_MIN} min of fuel`, -10);
    }
  }

  get breakdown(): ScoreItem[] {
    return [...this.items.values()];
  }

  get score(): number {
    const total = 100 + this.breakdown.reduce((s, i) => s + i.points, 0);
    return Math.max(0, Math.min(100, Math.round(total)));
  }

  get grade() {
    return gradeOf(this.score);
  }
}

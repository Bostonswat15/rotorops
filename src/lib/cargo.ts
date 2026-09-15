/**
 * Cargo and passenger jobs: what waits where, what it weighs and pays, and the
 * load sheet's arithmetic.
 *
 * OnAir-style work, approved by the user 2026-09-14. Jobs wait at the base,
 * nearby airfields and industry sites. You load several from one pickup into
 * one aircraft, and each is delivered -- and paid -- when it is set down at its
 * own drop. The server side is 20260923000000_cargo_inventory.sql
 * (dispatch_trip, bridge_deliver_job); anything here that decides whether a
 * load may fly is mirrored there, and the server has the last word.
 */

import type { WingType } from "./game-data";
import { PAY_SCALE } from "./economy";
import { distanceNm, type Airport } from "./missions";
import { INDUSTRY_DEFS, type IndustryKind } from "./industries";
import { goodById } from "./goods";
import { surfaceClass } from "./osm";
import { BUSH_STRIP_MAX_FT } from "./fixed-wing";

/** A passenger with a bag. */
export const PAX_LB = 190;
/** How long a job waits to be collected. */
export const JOB_EXPIRY_HOURS = 48;
/** How close counts as there: an airfield, and a camp, site or hospital. */
export const FIELD_ZONE_NM = 2;
export const SITE_ZONE_NM = 0.5;

/**
 * Pay per job: base + per nm + per lb, then variance and reputation as every
 * contract has. Fitted to today's contracts so the two boards pay alike.
 */
export const PAY: Record<WingType, { base: number; perNm: number; perLb: number }> = {
  // Parts Run 500 lb ~37 nm $2,600; Freight Transfer 1,800 lb ~57 nm $5,400;
  // Heavy Equipment Transfer 5,000 lb ~37 nm $11,000.
  rotary: { base: 1000, perNm: 18, perLb: 1.85 },
  // Scheduled Freight Run 1,500 lb ~92 nm $4,200; Ferry Flight 200 lb ~102 nm $2,400.
  fixed: { base: 900, perNm: 20, perLb: 1.5 },
};
/** Setting down away from an airfield -- the approved Camp Supply Run's $4,500 for 600 lb. */
export const OFF_AIRPORT_MULT = 1.7;
/** An aeroplane into a bush strip -- Bush Strip Resupply's $6,800 for 900 lb. */
export const BUSH_STRIP_MULT = 1.8;

/** How far a drop sits from its pickup, by what it is. Planes only fly field to field. */
const LEG_NM: Record<WingType, { field: [number, number]; site: [number, number] }> = {
  rotary: { field: [10, 60], site: [5, 40] },
  fixed: { field: [30, 200], site: [0, 0] },
};
/** Nearby airfields that get jobs of their own, besides the base. */
const PICKUP_FIELDS: Record<WingType, { count: number; withinNm: number }> = {
  rotary: { count: 2, withinNm: 25 },
  fixed: { count: 3, withinNm: 80 },
};
const JOB_LB: Record<WingType, [number, number]> = { rotary: [150, 1200], fixed: [200, 2500] };
const SITE_JOB_MAX_LB = 1000;
const HOSPITAL_JOB_LB: [number, number] = [60, 300];
const MAX_PAX: Record<WingType, number> = { rotary: 4, fixed: 8 };
/**
 * Plane jobs sized to the biggest plane in the fleet (user approved
 * 2026-09-14): PLANE_JOB_MIN_LB up to PLANE_LOAD_SHARE of its payload, the
 * rest left for fuel, and never more than JOB_LB allows.
 */
export const PLANE_JOB_MIN_LB = 60;
export const PLANE_LOAD_SHARE = 0.7;
const PAX_SHARE: Record<WingType, number> = { rotary: 0.3, fixed: 0.35 };
const JOBS_AT_PICKUP: [number, number] = [3, 4];
const MAX_JOBS = 12;
/** Goods waiting at industry sites, on top of the general jobs. Helicopters only. */
const GOODS_JOBS = 2;
const GOODS_LB: [number, number] = [300, 1000];
/** Closer than this isn't a trip worth flying. */
const MIN_LEG_NM = 3;

export type ManifestItem = { name: string; qty: number; unit_lb: number };
export type Manifest = { wing: WingType; items: ManifestItem[]; pax: number };

/** What a manifest weighs. Mirrors public.manifest_weight. */
export function manifestWeight(
  m: { items?: ManifestItem[] | null; pax?: number | null } | null | undefined,
): number {
  if (!m) return 0;
  const items = Array.isArray(m.items) ? m.items : [];
  const cargo = items.reduce(
    (sum, i) => sum + Math.max(0, Number(i?.qty) || 0) * Math.max(0, Number(i?.unit_lb) || 0),
    0,
  );
  return cargo + Math.max(0, Math.trunc(Number(m.pax) || 0)) * PAX_LB;
}

type ItemKind = { name: string; plural: string; lb: [number, number] };
const ITEMS: Record<"field" | "site" | "hospital", ItemKind[]> = {
  field: [
    { name: "Parts crate", plural: "Parts crates", lb: [20, 60] },
    { name: "Freight crate", plural: "Freight crates", lb: [40, 120] },
    { name: "Tool chest", plural: "Tool chests", lb: [60, 110] },
    { name: "Mail sack", plural: "Mail sacks", lb: [15, 30] },
    { name: "Fuel drum", plural: "Fuel drums", lb: [180, 180] },
  ],
  site: [
    { name: "Supply crate", plural: "Supply crates", lb: [40, 120] },
    { name: "Food box", plural: "Food boxes", lb: [25, 45] },
    { name: "Fuel drum", plural: "Fuel drums", lb: [180, 180] },
    { name: "Spares crate", plural: "Spares crates", lb: [20, 60] },
  ],
  hospital: [
    { name: "Medical supply box", plural: "Medical supplies", lb: [20, 40] },
    { name: "Blood cooler", plural: "Blood coolers", lb: [25, 35] },
  ],
};

export type CargoPlace = {
  name: string;
  icao: string | null;
  lat: number;
  lon: number;
  radiusNm: number;
  kind: "base" | "field" | "site" | "hospital";
  runwayFt?: number | null;
  surface?: string | null;
  industryId?: string;
};

/** A strip a plane job pays extra for: unpaved, or short. */
export function isBushStrip(p: { runwayFt?: number | null; surface?: string | null }) {
  return (
    typeof p.runwayFt === "number" &&
    p.runwayFt > 0 &&
    (p.runwayFt < BUSH_STRIP_MAX_FT || surfaceClass(p.surface) === "unpaved")
  );
}

export function jobPay(
  wing: WingType,
  nm: number,
  lb: number,
  drop: Pick<CargoPlace, "kind" | "runwayFt" | "surface">,
  reputation: number,
  variance = 1,
): number {
  const p = PAY[wing];
  let pay = p.base + p.perNm * nm + p.perLb * lb;
  if (drop.kind === "site" || drop.kind === "hospital") pay *= OFF_AIRPORT_MULT;
  else if (wing === "fixed" && isBushStrip(drop)) pay *= BUSH_STRIP_MULT;
  return Math.round(pay * PAY_SCALE * variance * (1 + reputation / 200));
}

export type CargoContext = {
  wing: WingType;
  companyId: string;
  reputation: number;
  base: { name: string; icao: string | null; lat: number; lon: number };
  airports: Airport[];
  hospitals?: { lat: number; lon: number; name: string }[];
  industries?: { id: string; kind: string; lat: number; lon: number; name: string | null; stock: number }[];
  /**
   * Plane jobs only: the biggest payload and the most seats behind the pilot
   * among the fleet's planes. Absent keeps the full JOB_LB and MAX_PAX.
   */
  planeLimits?: { payloadLb: number; seats: number } | null;
  /** Goods jobs from the company's industries. Absent keeps GOODS_JOBS; Industry mode asks for more. */
  goodsJobs?: number;
  now?: number;
  random?: () => number;
};

/** A batch of jobs for one half of the Cargo Hub. Rows ready to insert into missions. */
export function generateCargoJobs(ctx: CargoContext): Record<string, unknown>[] {
  const rnd = ctx.random ?? Math.random;
  const now = ctx.now ?? Date.now();
  const wing = ctx.wing;
  const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  const pickOne = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const nm = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
    distanceNm(a.lat, a.lon, b.lat, b.lon);

  const base: CargoPlace = {
    name: ctx.base.name,
    icao: ctx.base.icao,
    lat: ctx.base.lat,
    lon: ctx.base.lon,
    radiusNm: ctx.base.icao ? FIELD_ZONE_NM : SITE_ZONE_NM,
    kind: "base",
  };
  const baseIcao = String(ctx.base.icao ?? "").toUpperCase();

  // A Savage Cub can't take a 2,000 lb crate or four passengers.
  const limits = wing === "fixed" ? (ctx.planeLimits ?? null) : null;
  const jobLb: [number, number] = limits
    ? [
        PLANE_JOB_MIN_LB,
        Math.max(PLANE_JOB_MIN_LB, Math.min(JOB_LB.fixed[1], Math.round(limits.payloadLb * PLANE_LOAD_SHARE))),
      ]
    : JOB_LB[wing];
  const maxPax = limits
    ? Math.min(MAX_PAX.fixed, Math.max(0, Math.floor(limits.seats)), Math.floor(jobLb[1] / PAX_LB))
    : MAX_PAX[wing];

  const fields: CargoPlace[] = ctx.airports
    .filter(
      (a) => Number.isFinite(a.lat) && Number.isFinite(a.lon) && String(a.icao).toUpperCase() !== baseIcao,
    )
    // Never a seaplane base, whose mapped point can be out on the water. A plane
    // also needs a runway it can use.
    .filter((a) => a.runway_ft !== 0 && (wing === "rotary" || a.runway_ft == null || a.runway_ft >= 1200))
    .map((a) => ({
      name: String(a.icao),
      icao: String(a.icao),
      lat: a.lat,
      lon: a.lon,
      radiusNm: FIELD_ZONE_NM,
      kind: "field" as const,
      runwayFt: a.runway_ft ?? null,
      surface: a.surface ?? null,
    }));

  // Off-airport drops are helicopter work: industry sites and hospitals.
  const sites: CargoPlace[] =
    wing === "rotary"
      ? [
          ...(ctx.industries ?? []).map((i) => ({
            name: i.name ?? INDUSTRY_DEFS[i.kind as IndustryKind]?.label ?? "Site",
            icao: null,
            lat: i.lat,
            lon: i.lon,
            radiusNm: SITE_ZONE_NM,
            kind: "site" as const,
            industryId: i.id,
          })),
          ...(ctx.hospitals ?? []).map((h) => ({
            name: h.name,
            icao: null,
            lat: h.lat,
            lon: h.lon,
            radiusNm: SITE_ZONE_NM,
            kind: "hospital" as const,
          })),
        ]
      : [];

  const near = fields
    .filter((f) => nm(base, f) <= PICKUP_FIELDS[wing].withinNm && nm(base, f) >= MIN_LEG_NM)
    .sort((a, b) => nm(base, a) - nm(base, b))
    .slice(0, 6);
  const pickups: CargoPlace[] = [base];
  while (pickups.length < 1 + PICKUP_FIELDS[wing].count && near.length > 0) {
    pickups.push(near.splice(Math.floor(rnd() * near.length), 1)[0]);
  }

  const expires = new Date(now + JOB_EXPIRY_HOURS * 3600_000).toISOString();

  type Spec = {
    role: "cargo" | "passengers";
    title: string;
    description: string;
    items: ManifestItem[];
    pax: number;
    lb: number;
    haul?: Record<string, unknown>;
  };
  const build = (pickup: CargoPlace, drop: CargoPlace, spec: Spec): Record<string, unknown> => {
    const d = nm(pickup, drop);
    const variance = 0.9 + rnd() * 0.25;
    const offAirport = drop.kind === "site" || drop.kind === "hospital";
    return {
      company_id: ctx.companyId,
      role: spec.role,
      title: spec.title,
      description: spec.description,
      required_tags: [],
      required_certs: [],
      min_payload: Math.round(spec.lb),
      payout: jobPay(wing, d, spec.lb, drop, ctx.reputation, variance),
      distance_nm: Math.max(2, Math.round(d)),
      difficulty: offAirport || (wing === "fixed" && isBushStrip(drop)) ? 2 : 1,
      weather_factor: 1,
      origin: pickup.icao,
      destination: drop.icao,
      // Not "airport": cargo jobs stay off the Mission Board's plane half.
      scene_type: "cargo",
      scene_name: drop.name,
      scene_lat: drop.lat,
      scene_lon: drop.lon,
      objectives: [],
      manifest: { wing, items: spec.items, pax: spec.pax } satisfies Manifest,
      cargo_lb: Math.round(spec.lb),
      pickup_name: pickup.name,
      pickup_icao: pickup.icao,
      pickup_lat: pickup.lat,
      pickup_lon: pickup.lon,
      pickup_radius_nm: pickup.radiusNm,
      drop_name: drop.name,
      drop_icao: drop.icao,
      drop_lat: drop.lat,
      drop_lon: drop.lon,
      drop_radius_nm: drop.radiusNm,
      expires_at: expires,
      ...(spec.haul ?? {}),
    };
  };

  /** One or two kinds of item, in whole numbers, to roughly the weight wanted. */
  const fillItems = (kinds: ItemKind[], targetLb: number): ManifestItem[] => {
    const first = pickOne(kinds);
    const chosen = [first];
    if (kinds.length > 1 && rnd() < 0.5) {
      const others = kinds.filter((k) => k !== first);
      chosen.push(pickOne(others));
    }
    return chosen.map((k) => {
      const unit = Math.round(between(k.lb[0], k.lb[1]));
      return { name: k.name, qty: Math.max(1, Math.round(targetLb / chosen.length / unit)), unit_lb: unit };
    });
  };

  const describe = (items: ManifestItem[], lb: number) =>
    `${items.map((i) => `${i.qty} × ${i.name} (${i.unit_lb} lb)`).join(", ")}. ${Math.round(lb).toLocaleString()} lb in all.`;

  const inRange = (from: CargoPlace, p: CargoPlace, [lo, hi]: [number, number]) => {
    const d = nm(from, p);
    return d >= Math.max(lo, MIN_LEG_NM) && d <= hi;
  };

  const makeJob = (pickup: CargoPlace): Record<string, unknown> | null => {
    const fieldDrops = [...fields, ...(pickup === base ? [] : [base])].filter(
      (f) => f !== pickup && inRange(pickup, f, LEG_NM[wing].field),
    );
    const siteDrops = sites.filter((s) => inRange(pickup, s, LEG_NM[wing].site));

    if (fieldDrops.length > 0 && maxPax > 0 && rnd() < PAX_SHARE[wing]) {
      const drop = pickOne(fieldDrops);
      const pax = 1 + Math.floor(rnd() * maxPax);
      const lb = pax * PAX_LB;
      return build(pickup, drop, {
        role: "passengers",
        title: `${pax} passenger${pax === 1 ? "" : "s"} to ${drop.name}`,
        description: `${pax} passenger${pax === 1 ? "" : "s"} with bags. ${lb.toLocaleString()} lb in all.`,
        items: [],
        pax,
        lb,
      });
    }

    const drops = [...fieldDrops, ...siteDrops];
    if (drops.length === 0) return null;
    const drop = pickOne(drops);
    const kind = drop.kind === "hospital" ? "hospital" : drop.kind === "site" ? "site" : "field";
    const [lo, hi] = jobLb;
    const target =
      kind === "hospital"
        ? between(HOSPITAL_JOB_LB[0], HOSPITAL_JOB_LB[1])
        : between(lo, kind === "site" ? Math.min(hi, SITE_JOB_MAX_LB) : hi);
    // Nothing whose single unit is heavier than the job is meant to be.
    const fits = ITEMS[kind].filter((k) => k.lb[0] <= target);
    const items = fillItems(fits.length > 0 ? fits : ITEMS[kind], target);
    if (limits) {
      for (const it of items) {
        while (it.qty > 1 && manifestWeight({ items, pax: 0 }) > hi) it.qty--;
      }
    }
    const lb = manifestWeight({ items, pax: 0 });
    if (limits && lb > hi) return null;
    const lead = ITEMS[kind].find((k) => k.name === items[0].name)!;
    const single = items.length === 1 && items[0].qty === 1;
    return build(pickup, drop, {
      role: "cargo",
      title: `${single ? items[0].name : lead.plural} to ${drop.name}`,
      description: describe(items, lb),
      items,
      pax: 0,
      lb,
    });
  };

  const rows: Record<string, unknown>[] = [];
  for (const pickup of pickups) {
    const n = JOBS_AT_PICKUP[0] + Math.floor(rnd() * (JOBS_AT_PICKUP[1] - JOBS_AT_PICKUP[0] + 1));
    for (let i = 0; i < n && rows.length < MAX_JOBS; i++) {
      const job = makeJob(pickup);
      if (job) rows.push(job);
    }
  }

  // Goods from the company's industries, drawn from their stock when loaded:
  // raw material to the site that processes it, finished goods to the base market.
  if (wing === "rotary") {
    const stocked = (ctx.industries ?? []).filter((i) => i.stock >= 1);
    for (let i = stocked.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [stocked[i], stocked[j]] = [stocked[j], stocked[i]];
    }
    let goods = 0;
    for (const ind of stocked) {
      if (goods >= (ctx.goodsJobs ?? GOODS_JOBS)) break;
      const def = INDUSTRY_DEFS[ind.kind as IndustryKind];
      const good = def ? goodById(def.output) : null;
      const pickup = sites.find((s) => s.industryId === ind.id);
      if (!def || !good || !pickup) continue;

      let drop: CargoPlace | undefined;
      let toId: string | null = null;
      if (def.tier === 1) {
        const pairKind = Object.values(INDUSTRY_DEFS).find((d) => d.chain === def.chain && d.tier === 2)?.kind;
        const pair = (ctx.industries ?? []).find((x) => x.kind === pairKind);
        if (pair) {
          drop = sites.find((s) => s.industryId === pair.id);
          toId = pair.id;
        }
      } else {
        drop = base;
      }
      if (!drop || nm(pickup, drop) < MIN_LEG_NM) continue;

      const units = Math.min(
        Math.floor(ind.stock),
        Math.max(1, Math.round(between(GOODS_LB[0], GOODS_LB[1]) / good.unit_lb)),
      );
      const lb = units * good.unit_lb;
      rows.push(
        build(pickup, drop, {
          role: "cargo",
          title: `${good.name} to ${drop.name}`,
          description: `${units} units of ${good.name} (${good.unit_lb} lb each) from ${pickup.name}. ${lb.toLocaleString()} lb in all.`,
          items: [{ name: good.name, qty: units, unit_lb: good.unit_lb }],
          pax: 0,
          lb,
          haul: { haul_from_industry_id: ind.id, haul_to_industry_id: toId, haul_units: units },
        }),
      );
      goods++;
    }
  }

  return rows;
}

/** Is this row a cargo or passenger job rather than a contract? */
export function isCargoJob(m: { manifest?: unknown } | null | undefined) {
  return !!m && m.manifest != null;
}

export function jobWing(m: { manifest?: unknown }): WingType {
  const w = (m.manifest as Partial<Manifest> | null)?.wing;
  return w === "fixed" ? "fixed" : "rotary";
}

export function isExpired(m: { expires_at?: string | null }, now = Date.now()) {
  return !!m.expires_at && new Date(m.expires_at).getTime() < now;
}

/** "4 × Supply crate, 2 × Fuel drum" or "3 passengers". */
export function manifestSummary(manifest: unknown): string {
  const m = manifest as Partial<Manifest> | null;
  if (!m) return "";
  const parts = (m.items ?? []).map((i) => `${i.qty} × ${i.name}`);
  if (m.pax) parts.push(`${m.pax} passenger${m.pax === 1 ? "" : "s"}`);
  return parts.join(", ");
}

type Pickup = {
  pickup_icao?: string | null;
  pickup_lat?: number | null;
  pickup_lon?: number | null;
};

/** Same place to collect from: the same ident, or within a mile. Mirrors dispatch_trip. */
export function samePickup(a: Pickup, b: Pickup) {
  if (a.pickup_icao && b.pickup_icao && a.pickup_icao.toUpperCase() === b.pickup_icao.toUpperCase()) {
    return true;
  }
  return (
    a.pickup_lat != null &&
    a.pickup_lon != null &&
    b.pickup_lat != null &&
    b.pickup_lon != null &&
    distanceNm(Number(a.pickup_lat), Number(a.pickup_lon), Number(b.pickup_lat), Number(b.pickup_lon)) <= 1
  );
}

export type LoadAircraft = {
  display_name: string;
  payload_lbs: number;
  pax_seats: number;
  empty_weight_lb?: number | null;
  max_gross_lb?: number | null;
  fuel_capacity_lb?: number | null;
};

export type LoadCheck = {
  cargoLb: number;
  pax: number;
  seats: number;
  fuelLb: number | null;
  /** What the limit is measured against: cargo + fuel for "sim", cargo alone for "catalogue". */
  countedLb: number;
  limitLb: number;
  limitSource: "sim" | "catalogue";
  overLb: number;
  errors: string[];
};

/** The load sheet's Validate. Mirrors the checks in dispatch_trip. */
export function checkLoad(
  ac: LoadAircraft,
  jobs: ({ manifest?: unknown } & Pickup)[],
  fuelLb: number | null,
): LoadCheck {
  const cargoLb = jobs.reduce((sum, j) => sum + manifestWeight(j.manifest as Manifest), 0);
  const pax = jobs.reduce((sum, j) => sum + Math.max(0, Math.trunc(Number((j.manifest as Manifest)?.pax) || 0)), 0);
  const seats = Math.max(0, (Number(ac.pax_seats) || 0) - 1);
  const empty = Number(ac.empty_weight_lb);
  const gross = Number(ac.max_gross_lb);
  const simLimit = Number.isFinite(empty) && Number.isFinite(gross) && ac.empty_weight_lb != null && ac.max_gross_lb != null && gross > empty;
  const limitLb = simLimit ? gross - empty : Number(ac.payload_lbs) || 0;
  const countedLb = simLimit ? cargoLb + (fuelLb ?? 0) : cargoLb;
  const overLb = Math.max(0, Math.round(countedLb - limitLb));

  const errors: string[] = [];
  if (jobs.length === 0) errors.push("Pick at least one job to load.");
  if (jobs.some((j) => !samePickup(jobs[0], j))) {
    errors.push("Every job on a trip is collected from the same place.");
  }
  if (pax > seats) {
    errors.push(`${pax} passengers won't fit: the ${ac.display_name} has ${seats} seats behind the pilot.`);
  }
  if (fuelLb != null && fuelLb < 0) errors.push("Fuel can't be negative.");
  if (fuelLb != null && ac.fuel_capacity_lb != null && fuelLb > Number(ac.fuel_capacity_lb) + 1) {
    errors.push(`The ${ac.display_name} holds ${Math.round(Number(ac.fuel_capacity_lb)).toLocaleString()} lb of fuel.`);
  }
  if (overLb > 0) {
    errors.push(`Over weight by ${overLb.toLocaleString()} lb.`);
  }

  return {
    cargoLb: Math.round(cargoLb),
    pax,
    seats,
    fuelLb,
    countedLb: Math.round(countedLb),
    limitLb: Math.round(limitLb),
    limitSource: simLimit ? "sim" : "catalogue",
    overLb,
    errors,
  };
}

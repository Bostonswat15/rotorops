/**
 * Industries: extraction and processing sites your company can haul for,
 * trade with, or invest in.
 *
 * Four chains, each two stages. Tier 1 sites -- a forest, a farm, a quarry, a
 * well -- come straight from OSM, which tags raw land use reliably. Tier 2
 * processing is tagged far less reliably (usually a bare `landuse=industrial`
 * polygon with a name if you're lucky), so a named one is used when OSM has
 * it and an unnamed one is synthesised a short hop from its tier-1 supplier
 * when it doesn't -- the same fallback the mission scenes already use when
 * real data runs thin, applied here rather than invented from nothing.
 *
 * Stock and price are never trusted from the client: every quoted number here
 * is a preview, and every mutating action (dispatch, invest, generate) is
 * recomputed and re-checked server-side in the industries migration before
 * anything is paid or charged, the same discipline `aircraft_sale_value`
 * already holds to.
 */

import type { AircraftTag } from "./game-data";
import { GOODS, goodById, type Good } from "./goods";
import {
  distanceNm, offsetPosition, nearestAirport,
  type Airport, type Objective,
} from "./missions";
import type { IndustrySite } from "./osm";

// ---------------------------------------------------------------------------
// Chain definitions
// ---------------------------------------------------------------------------

export type IndustryKind =
  | "forest" | "sawmill"
  | "farmland" | "grain_mill"
  | "oil_well" | "refinery"
  | "quarry" | "steel_works"
  | "fishing_camp" | "cannery";

export type ChainId = "timber" | "grain" | "fuel" | "steel" | "fishing";

export type IndustryDef = {
  kind: IndustryKind;
  label: string;
  chain: ChainId;
  tier: 1 | 2;
  /** Good produced from nothing (tier 1) or from the input (tier 2). */
  output: string;
  /** What a tier-2 site consumes to make its output. Null for tier 1. */
  input: string | null;
  /** Units of stock the site can hold before production stalls. */
  capacity: number;
  /** Units produced per hour at full capacity, before any investment. */
  base_rate: number;
  /** How much a unit of investment buys in extra capacity, per chain. */
  capacity_per_dollar: number;
  /**
   * One-time cost to build this site from nothing, via `place_industry`.
   * A site found by the OSM scan costs nothing -- it already existed --
   * but building one wherever you like has to cost real capital, or a
   * company could carpet a map in free tier-1 extraction sites and print
   * money forever. Mirrored in industry_defs.build_cost server-side, which
   * is the number that is ever actually charged.
   */
  build_cost: number;
  /**
   * Workers a fully-staffed site can usefully employ. base_rate is the
   * output of a site at max_workers -- production scales down linearly as
   * staffing falls short of that, and a site with zero workers makes
   * nothing at all. Kept in sync with industry_defs.max_workers
   * server-side by hand, same discipline as the pilot perk catalog.
   */
  max_workers: number;
  /** Wage per worker per hour, billed whether or not the shift produced anything sellable. */
  wage_per_hour: number;
};

export const INDUSTRY_DEFS: Record<IndustryKind, IndustryDef> = {
  forest: { kind: "forest", label: "Lumber Camp", chain: "timber", tier: 1, output: "timber", input: null, capacity: 4000, base_rate: 60, capacity_per_dollar: 0.6, build_cost: 55000, max_workers: 4, wage_per_hour: 20 },
  sawmill: { kind: "sawmill", label: "Sawmill", chain: "timber", tier: 2, output: "lumber", input: "timber", capacity: 2500, base_rate: 40, capacity_per_dollar: 0.4, build_cost: 130000, max_workers: 6, wage_per_hour: 26 },

  farmland: { kind: "farmland", label: "Farm", chain: "grain", tier: 1, output: "grain", input: null, capacity: 5000, base_rate: 70, capacity_per_dollar: 0.8, build_cost: 40000, max_workers: 5, wage_per_hour: 18 },
  grain_mill: { kind: "grain_mill", label: "Grain Mill", chain: "grain", tier: 2, output: "flour", input: "grain", capacity: 3000, base_rate: 45, capacity_per_dollar: 0.5, build_cost: 100000, max_workers: 6, wage_per_hour: 24 },

  oil_well: { kind: "oil_well", label: "Oil Well", chain: "fuel", tier: 1, output: "crude", input: null, capacity: 3500, base_rate: 35, capacity_per_dollar: 0.25, build_cost: 200000, max_workers: 5, wage_per_hour: 32 },
  refinery: { kind: "refinery", label: "Refinery", chain: "fuel", tier: 2, output: "avgas", input: "crude", capacity: 2200, base_rate: 28, capacity_per_dollar: 0.2, build_cost: 420000, max_workers: 8, wage_per_hour: 38 },

  quarry: { kind: "quarry", label: "Quarry", chain: "steel", tier: 1, output: "ore", input: null, capacity: 4500, base_rate: 50, capacity_per_dollar: 0.3, build_cost: 70000, max_workers: 6, wage_per_hour: 24 },
  steel_works: { kind: "steel_works", label: "Steel Works", chain: "steel", tier: 2, output: "steel", input: "ore", capacity: 2000, base_rate: 30, capacity_per_dollar: 0.15, build_cost: 380000, max_workers: 8, wage_per_hour: 34 },

  fishing_camp: { kind: "fishing_camp", label: "Fishing Camp", chain: "fishing", tier: 1, output: "fish", input: null, capacity: 3800, base_rate: 55, capacity_per_dollar: 0.35, build_cost: 60000, max_workers: 4, wage_per_hour: 20 },
  cannery: { kind: "cannery", label: "Cannery", chain: "fishing", tier: 2, output: "seafood", input: "fish", capacity: 2400, base_rate: 35, capacity_per_dollar: 0.25, build_cost: 140000, max_workers: 6, wage_per_hour: 26 },
};

export const CHAIN_LABEL: Record<ChainId, string> = {
  timber: "Timber", grain: "Grain", fuel: "Fuel", steel: "Steel", fishing: "Fishing",
};

// ---------------------------------------------------------------------------
// Siting: real sites, with a documented fallback where OSM comes up short
// ---------------------------------------------------------------------------

export type SitedIndustry = {
  kind: IndustryKind;
  lat: number;
  lon: number;
  name: string | null;
  /** Whether this came straight from OSM or was placed near its supplier. */
  confidence: "named" | "guessed" | "synthesised";
};

const TIER1_KINDS: IndustryKind[] = ["forest", "farmland", "oil_well", "quarry", "fishing_camp"];
const TIER2_OF: Record<IndustryKind, IndustryKind> = {
  forest: "sawmill", sawmill: "sawmill",
  farmland: "grain_mill", grain_mill: "grain_mill",
  oil_well: "refinery", refinery: "refinery",
  quarry: "steel_works", steel_works: "steel_works",
  fishing_camp: "cannery", cannery: "cannery",
};

/**
 * Turn what OSM found into a full set of chains: one tier-1 plus one tier-2
 * per chain that has a tier-1 anchor nearby. A chain with no raw-material
 * site at all is simply not offered -- there is nothing honest to synthesise
 * a processing plant near.
 */
export function siteIndustries(raw: IndustrySite[]): SitedIndustry[] {
  const out: SitedIndustry[] = [];
  const byKind = new Map<IndustryKind, IndustrySite[]>();
  for (const s of raw) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind)!.push(s);
  }

  for (const t1 of TIER1_KINDS) {
    const anchors = byKind.get(t1) ?? [];
    if (anchors.length === 0) continue;
    // The largest handful, not every polygon OSM knows about -- a region can
    // have hundreds of farmland ways and one industry per chain is plenty.
    for (const a of anchors.slice(0, 2)) {
      out.push({ kind: t1, lat: a.lat, lon: a.lon, name: a.name, confidence: "named" });
    }

    const t2 = TIER2_OF[t1];
    const named = byKind.get(t2) ?? [];
    const anchor = anchors[0];
    if (named.length > 0) {
      // Nearest named processing site to the tier-1 anchor, not just the
      // first one Overpass returned.
      const nearest = named
        .map((n) => ({ n, d: distanceNm(anchor.lat, anchor.lon, n.lat, n.lon) }))
        .sort((a, b) => a.d - b.d)[0].n;
      out.push({ kind: t2, lat: nearest.lat, lon: nearest.lon, name: nearest.name, confidence: "named" });
    } else {
      // No named processing site nearby. Synthesised a short hop from the
      // supplier, clearly flagged as such rather than presented as a fact.
      const p = offsetPosition(anchor.lat, anchor.lon, 2 + Math.random() * 3, Math.random() * 360);
      out.push({
        kind: t2, lat: p.lat, lon: p.lon,
        name: null, confidence: "synthesised",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stock, price and the lazy tick
// ---------------------------------------------------------------------------

export type IndustryStock = {
  kind: IndustryKind;
  stock: number;
  capacity: number;
  ratio: number; // stock / capacity, 0..1
};

/**
 * Advance a site's stock by elapsed time.
 *
 * Not a server call: this is the same math `industry_tick` runs in the
 * database, duplicated here so the Trading Hall can show a live preview
 * without a round trip. Every mutating action re-derives the authoritative
 * number server-side before it is trusted -- see the migration.
 */
export function projectStock(
  def: IndustryDef,
  stock: number,
  capacity: number,
  hoursElapsed: number,
  inputStock: number | null,
): { stock: number; consumedInput: number } {
  const rate = def.base_rate;
  if (def.tier === 1) {
    const gained = rate * Math.max(0, hoursElapsed);
    return { stock: Math.min(capacity, stock + gained), consumedInput: 0 };
  }
  // Tier 2 is capped by both its own headroom and the input actually on hand.
  const wanted = rate * Math.max(0, hoursElapsed);
  const roomLeft = Math.max(0, capacity - stock);
  const inputAvailable = inputStock ?? 0;
  const made = Math.min(wanted, roomLeft, inputAvailable);
  return { stock: stock + made, consumedInput: made };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));

/**
 * What it costs to buy a unit of this good from this site right now.
 *
 * Cheap where the site is sitting on a surplus (production has been outrunning
 * demand), expensive as stock runs toward empty -- a shortage is not
 * something you get to buy your way past for the base price.
 */
export function buyPrice(good: Good, ratio: number): number {
  return Math.round(good.base_value * lerp(2.4, 0.55, ratio) * 100) / 100;
}

/**
 * What delivering a unit to this site is worth right now.
 *
 * Pays well into a site running low on the input it needs to keep working,
 * poorly into one already stocked to the ceiling -- the site does not need
 * a fourth truckload of grain when the mill is already full.
 */
export function sellPrice(good: Good, ratio: number): number {
  return Math.round(good.base_value * lerp(2.1, 0.5, ratio) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Contract-driven hauls, for the mission board
// ---------------------------------------------------------------------------

export type IndustryRow = {
  id: string;
  kind: IndustryKind;
  lat: number;
  lon: number;
  name: string | null;
  stock: number;
  capacity: number;
};

/**
 * Build a haul contract from one industry's surplus to the paired site that
 * needs it -- a tier-1 site with grain to move, or a tier-2 site with a
 * finished good ready to go out. Reuses the existing `payload`/`land_off`
 * objective pair, exactly the shape a logistics resupply already uses.
 */
export function generateIndustryHaul(
  from: IndustryRow,
  to: { lat: number; lon: number; icao: string | null; name?: string | null },
  reputation: number,
  base: { lat: number; lon: number; icao: string | null; airports?: Airport[] },
): Record<string, unknown> | null {
  const def = INDUSTRY_DEFS[from.kind];
  const good = goodById(def.output);
  if (!good) return null;

  const ratio = from.capacity > 0 ? from.stock / from.capacity : 0;
  // Nothing worth hauling if the site is running near empty.
  if (from.stock < 300) return null;

  // Bounded by a realistic load, not by however much the site happens to be
  // sitting on. The heaviest airframe in the whole fleet -- a CH-47 -- tops
  // out at 24,000 lb; a naive "haul 40% of stock" produced six-figure payload
  // requirements no aircraft in the game could ever carry. 1,200-6,000 lb
  // matches the range the existing logistics contracts already ask for.
  const targetWeightLb = 1200 + Math.random() * 4800;
  const qty = Math.max(
    30,
    Math.min(Math.round(from.stock * 0.4), Math.floor(targetWeightLb / good.unit_lb)),
  );
  const weight = Math.round(qty * good.unit_lb);
  const legNm = distanceNm(from.lat, from.lon, to.lat, to.lon);
  const price = sellPrice(good, ratio);
  const payout = Math.round(qty * price);

  const objectives: Objective[] = [
    { id: "reach", kind: "reach", label: `Reach ${from.name ?? def.label}`, lat: from.lat, lon: from.lon, radius_nm: 0.7 },
    { id: "load", kind: "payload", label: `Load ${qty.toLocaleString()} units of ${good.name}`, min_delta_lb: Math.round(weight * 0.85) },
    {
      id: "deliver", kind: "land_off",
      label: `Deliver to ${to.name ?? "the buyer"}`,
      lat: to.lat, lon: to.lon, radius_nm: 0.5,
    },
  ];

  const variance = 0.9 + Math.random() * 0.25;
  const nearest = nearestAirport(from.lat, from.lon, base.airports);

  return {
    role: "industry",
    title: `${good.name} Haul — ${def.label}`,
    description:
      `${from.name ?? def.label} has ${good.name.toLowerCase()} ready to move. ` +
      `${to.name ? `${to.name} is buying.` : "Deliver to the buyer."} ` +
      `${weight.toLocaleString()} lb aboard.`,
    required_tags: ["cargo", "medium_utility", "heavy_lift"] as AircraftTag[],
    required_certs: [],
    min_payload: Math.round(weight * 0.85),
    payout: Math.round(payout * variance * (1 + reputation / 200)),
    distance_nm: Math.max(2, Math.round(legNm)),
    difficulty: 2,
    weather_factor: 2,
    origin: base.icao,
    destination: to.icao ?? base.icao,
    scene_lat: from.lat,
    scene_lon: from.lon,
    scene_type: "industry",
    scene_name: from.name ?? def.label,
    nearest_airport_icao: nearest?.icao ?? null,
    nearest_airport_nm: nearest?.distance_nm ?? null,
    objectives: objectives as unknown as Record<string, unknown>[],
  };
}

/** Is this contract an industry haul? */
export function isIndustryMission(m: { scene_type?: string | null }) {
  return m?.scene_type === "industry";
}

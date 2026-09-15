/**
 * Game modes (user approved 2026-09-15).
 *
 * Career is the game as it always was: rescues, charters, patrols, plane
 * contracts and goods work. Industry is for playing without contracts: the
 * Mission Board offers only work moving goods for the company's own sites --
 * hauls, market runs, trade runs and fuel runs -- more of it per Generate, and
 * a haul pays the Cargo Hub freight rate on top of the goods it carries, since
 * goods alone paid a few hundred dollars for a flight costing more than that.
 * Check rides stay, because certifications and ratings still gate aircraft.
 *
 * The mode is companies.play_mode (20260930000000_industry_mode.sql).
 */

import type { WingType } from "./game-data";
import { jobPay } from "./cargo";

export type PlayMode = "career" | "industry";

export const isIndustryMode = (c: { play_mode?: string | null } | null | undefined) =>
  c?.play_mode === "industry";

/** Hauls per Generate, per tab, in Industry mode. Career offers 2. */
export const INDUSTRY_MODE_HAULS = 6;

/** Cargo Hub goods jobs in Industry mode. Career offers 2. */
export const INDUSTRY_MODE_GOODS_JOBS = 6;

/** The raw-material camps an Industry company can take as its free first site. */
export const FREE_CAMP_KINDS = ["forest", "farmland", "quarry", "fishing_camp"] as const;

/** Board work that belongs to Industry mode: goods, and the check rides that gate aircraft. */
const INDUSTRY_ROLES = new Set(["industry", "trade", "fuel_run", "checkride", "rating_ride"]);

export function showsInIndustryMode(m: { role?: string | null }) {
  return INDUSTRY_ROLES.has(m?.role ?? "");
}

/**
 * A haul's pay in Industry mode: the goods' value it was generated with, plus
 * the Cargo Hub freight rate for its weight and the whole trip. The weight is
 * read back from min_payload, which a haul sets to 85% of its load.
 */
export function withFreight<T extends { payout?: unknown; min_payload?: unknown; distance_nm?: unknown }>(
  row: T,
  wing: WingType,
  reputation: number,
): T {
  const lb = Math.round(Number(row.min_payload ?? 0) / 0.85);
  const nm = Number(row.distance_nm ?? 0);
  const freight = jobPay(wing, nm, lb, { kind: "field" }, reputation);
  return { ...row, payout: Number(row.payout ?? 0) + freight };
}

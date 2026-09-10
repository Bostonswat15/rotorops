/**
 * Pilot skill tree: labels and descriptions only.
 *
 * The set of perks, their tiers and their costs are enforced server-side by
 * public.pilot_perk_catalog() in 20260910000000_pilot_skills.sql -- this is
 * a display copy that MUST be kept in sync by hand. If you add a perk here
 * without also adding it to the SQL catalog, unlocking it will fail with
 * "unknown perk" from the server, which is the intended failure mode (the
 * server is the source of truth for what spending is legal).
 */

export type PilotPerk = {
  id: string;
  tier: 1 | 2 | 3;
  cost: number;
  label: string;
  description: string;
};

export const XP_PER_POINT = 100;

export const PERK_CATALOG: PilotPerk[] = [
  {
    id: "fuel_discipline", tier: 1, cost: 1,
    label: "Fuel Discipline",
    description: "8% less fuel burned on every flight.",
  },
  {
    id: "easy_hands", tier: 1, cost: 1,
    label: "Easy Hands",
    description: "30% less airframe wear from hard and severe landings.",
  },
  {
    id: "lean_ops", tier: 1, cost: 1,
    label: "Lean Operations",
    description: "10% lower operating cost billed per flight hour.",
  },
  {
    id: "veteran_wear", tier: 2, cost: 2,
    label: "Veteran Maintainer",
    description: "15% less airframe wear accumulated overall.",
  },
  {
    id: "field_reputation", tier: 2, cost: 2,
    label: "Field Reputation",
    description: "+1 extra reputation whenever a landing grades excellent.",
  },
  {
    id: "trusted_lessee", tier: 2, cost: 2,
    label: "Trusted Lessee",
    description: "20% lower lease cost billed per flight hour.",
  },
  {
    id: "ace_pilot", tier: 3, cost: 3,
    label: "Ace Pilot",
    description: "+5% payout on every successful contract.",
  },
  {
    id: "iron_airframe", tier: 3, cost: 3,
    label: "Iron Airframe",
    description: "A further 20% cut to overall airframe wear, stacking with Veteran Maintainer.",
  },
  {
    id: "master_of_type", tier: 3, cost: 3,
    label: "Master of Type",
    description: "A further 8% cut to both fuel burn and operating cost, stacking with the tier 1 perks.",
  },
] as const;

export const TIERS: { tier: 1 | 2 | 3; label: string; note: string }[] = [
  { tier: 1, label: "Tier 1", note: "1 point each — no prerequisite" },
  { tier: 2, label: "Tier 2", note: "2 points each — requires any Tier 1 perk" },
  { tier: 3, label: "Tier 3", note: "3 points each — requires any Tier 2 perk" },
];

export function perkById(id: string): PilotPerk | undefined {
  return PERK_CATALOG.find((p) => p.id === id);
}

/** Points earned so far, independent of how many have been spent. */
export function totalPoints(xp: number): number {
  return Math.floor(xp / XP_PER_POINT);
}

/** Points earned but not yet spent on an unlocked perk. */
export function availablePoints(xp: number, unlocked: string[]): number {
  const spent = unlocked.reduce((sum, id) => sum + (perkById(id)?.cost ?? 0), 0);
  return totalPoints(xp) - spent;
}

/** XP still needed before the next point is earned. */
export function xpToNextPoint(xp: number): number {
  return XP_PER_POINT - (xp % XP_PER_POINT);
}

/** Whether a perk can be unlocked right now, and why not if it can't. */
export function canUnlock(
  perk: PilotPerk,
  xp: number,
  unlocked: string[],
): { ok: true } | { ok: false; reason: string } {
  if (unlocked.includes(perk.id)) return { ok: false, reason: "Already unlocked." };
  if (perk.tier > 1) {
    const hasLowerTier = unlocked.some((id) => perkById(id)?.tier === perk.tier - 1);
    if (!hasLowerTier) return { ok: false, reason: `Unlock a Tier ${perk.tier - 1} perk first.` };
  }
  const available = availablePoints(xp, unlocked);
  if (available < perk.cost) {
    return { ok: false, reason: `Needs ${perk.cost} point${perk.cost === 1 ? "" : "s"} (you have ${available}).` };
  }
  return { ok: true };
}

/**
 * The commodities the industries economy moves.
 *
 * Four short chains, each two stages: a raw good pulled out of the ground or
 * off the land, and a processed good made from it. Real production, real
 * places -- not goods that simply exist because a screen says so.
 */

export type GoodCategory = "raw" | "processed";

export type Good = {
  id: string;
  name: string;
  category: GoodCategory;
  /** Pounds per unit -- what a contract's payload requirement is built from. */
  unit_lb: number;
  /** Dollars per unit in a perfectly balanced market. Real price moves with stock. */
  base_value: number;
};

export const GOODS: Good[] = [
  { id: "timber", name: "Timber", category: "raw", unit_lb: 45, base_value: 6 },
  { id: "lumber", name: "Milled Lumber", category: "processed", unit_lb: 38, base_value: 19 },

  { id: "grain", name: "Grain", category: "raw", unit_lb: 50, base_value: 4 },
  { id: "flour", name: "Flour", category: "processed", unit_lb: 50, base_value: 12 },

  { id: "crude", name: "Crude Oil", category: "raw", unit_lb: 55, base_value: 9 },
  { id: "avgas", name: "Aviation Fuel", category: "processed", unit_lb: 46, base_value: 25 },

  { id: "ore", name: "Iron Ore", category: "raw", unit_lb: 62, base_value: 7 },
  { id: "steel", name: "Structural Steel", category: "processed", unit_lb: 60, base_value: 34 },
];

export function goodById(id: string): Good | null {
  return GOODS.find((g) => g.id === id) ?? null;
}

/**
 * Fuel farm rules, for display.
 *
 * Charged and enforced server-side in 20260915000000_fuel_farms.sql
 * (build_fuel_farm, expand_fuel_farm, buy_bulk_fuel, dispatch_fuel_run and the
 * tank draw in rotorops_resolve_flight). These only let the Bases page quote a
 * price before you pay it; if they ever drift, the server's figure is charged.
 */

import { goodById } from "./goods";

export const FUEL_FARM_BUILD_COST = 25_000;
export const FUEL_FARM_BUILD_LB = 10_000;
export const FUEL_FARM_EXPAND_COST = 15_000;
export const FUEL_FARM_EXPAND_LB = 10_000;
export const BULK_FUEL_PRICE = 0.65;
/** What a flight pays per pound when there's no tank fuel to burn. */
export const PUMP_FUEL_PRICE = 0.9;
/** Pounds per unit of refinery avgas -- industry_defs.good_unit_lb server-side. */
export const AVGAS_UNIT_LB = goodById("avgas")?.unit_lb ?? 46;

/** What each pound in the tank cost. Null when it's empty. */
export function averageFuelCost(farm: { fuel_lb: number; fuel_value: number }): number | null {
  const lb = Number(farm.fuel_lb) || 0;
  return lb > 0 ? (Number(farm.fuel_value) || 0) / lb : null;
}

/** Room left once fuel runs still on the board have their space. */
export function freeTankSpace(
  farm: { capacity_lb: number; fuel_lb: number },
  reservedLb: number,
): number {
  return Math.max(0, (Number(farm.capacity_lb) || 0) - (Number(farm.fuel_lb) || 0) - reservedLb);
}

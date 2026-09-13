/**
 * Maintenance and resale rules, for display.
 *
 * Every figure here is charged or enforced server-side -- service_aircraft,
 * aircraft_resale, dispatch_mission and rotorops_resolve_flight in
 * 20260914000000_maintenance_and_loans.sql and 20260916000000_crash_restart.sql.
 * These only preview them so the Maintenance page can say what a service will
 * do before you pay for it. If the two ever drift, the server's number is the
 * one that counts.
 */

/** Flight hours between inspections. */
export const INSPECTION_INTERVAL_HR = 100;
/** How far past due before the aircraft can't be dispatched. */
export const INSPECTION_GRACE_HR = 10;
/** Wear at which flight resolution grounds the aircraft. */
export const GROUNDED_WEAR = 85;
/** Share of the purchase price a breakdown repair costs. */
export const BREAKDOWN_REPAIR_SHARE = 0.01;
/** Share of the purchase price a crash repair costs. */
export const CRASH_REPAIR_SHARE = 0.1;

export type Airframe = {
  acquisition_cost: number;
  hours: number;
  wear: number;
  reliability: number;
  op_cost_hr: number;
  maintenance_factor: number;
  is_leased?: boolean;
  hours_at_inspection?: number | null;
  broken_down_at?: string | null;
  crash_damaged?: boolean | null;
  wear_before_crash?: number | null;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** price x 70% x 0.8^(hours / 500) x (1 - 15% x wear), floor 10%. */
export function resaleValue(price: number, hours: number, wear: number): number {
  const factor =
    0.7 *
    Math.pow(0.8, Math.max(0, Number(hours) || 0) / 500) *
    (1 - (0.15 * clamp(Number(wear) || 0, 0, 100)) / 100);
  return Math.round(Math.max(0, Number(price) || 0) * Math.max(factor, 0.1));
}

/** Flight hours until the next inspection. Negative means overdue. */
export function inspectionDueIn(a: Airframe): number {
  const since = Number(a.hours) - Number(a.hours_at_inspection ?? 0);
  return INSPECTION_INTERVAL_HR - since;
}

/** Past the grace period: dispatch refuses the aircraft. */
export function inspectionBlocksDispatch(a: Airframe): boolean {
  return inspectionDueIn(a) < -INSPECTION_GRACE_HR;
}

/** Operating cost multiplier from wear: +0.5% per point above 40. */
export function wearCostMultiplier(wear: number): number {
  return 1 + Math.max(0, clamp(Number(wear) || 0, 0, 100) - 40) * 0.005;
}

/** Chance per flight of a breakdown: wear x (100 - reliability) x 25%. */
export function breakdownChance(a: Airframe): number {
  return (
    (clamp(Number(a.wear) || 0, 0, 100) / 100) *
    ((100 - clamp(Number(a.reliability) || 0, 0, 100)) / 100) *
    0.25
  );
}

export type ServiceType = "inspection" | "overhaul" | "repair";

export const SERVICE_LABEL: Record<ServiceType, string> = {
  inspection: "Inspection",
  overhaul: "Overhaul",
  repair: "Repair",
};

/** What can be done to this aircraft right now. A crash has to be repaired first. */
export function availableServices(a: Airframe): ServiceType[] {
  if (a.crash_damaged) return ["repair"];
  if (a.broken_down_at) return ["repair", "inspection", "overhaul"];
  return ["inspection", "overhaul"];
}

export type ServiceQuote = {
  cost: number;
  /** Wear taken off. For a crash repair, back down to the wear before the crash. */
  wearRemoved: number;
  /** Resale gained from the wear removed. Zero for a leased aircraft. */
  valueGain: number;
};

export function serviceQuote(a: Airframe, type: ServiceType): ServiceQuote {
  const price = Number(a.acquisition_cost) || 0;
  const factor = Number(a.maintenance_factor) || 1;
  const crashRepair = type === "repair" && !!a.crash_damaged;
  const cost =
    type === "inspection"
      ? Math.round((Number(a.op_cost_hr) || 0) * 6 * factor)
      : type === "overhaul"
        ? Math.round(price * 0.04 * factor)
        : Math.round(price * (crashRepair ? CRASH_REPAIR_SHARE : BREAKDOWN_REPAIR_SHARE));
  const wear = clamp(Number(a.wear) || 0, 0, 100);
  const removed = crashRepair
    ? Math.max(0, wear - clamp(Number(a.wear_before_crash ?? wear), 0, 100))
    : Math.min(wear, type === "inspection" ? 30 : type === "overhaul" ? 80 : 0);
  const valueGain = a.is_leased
    ? 0
    : resaleValue(price, a.hours, wear - removed) - resaleValue(price, a.hours, wear);
  return { cost, wearRemoved: removed, valueGain };
}

/** Why an aircraft can't fly contracts right now, or null if it can. */
export function groundedReason(a: Airframe): string | null {
  if (a.crash_damaged) return "Crash damage — needs a repair";
  if (a.broken_down_at) return "Broken down — needs a repair";
  if (Number(a.wear) >= GROUNDED_WEAR) return "Grounded — wear too high";
  if (inspectionBlocksDispatch(a)) return "Inspection overdue — can't take contracts";
  return null;
}

export function wearBarClass(wear: number): string {
  return wear >= GROUNDED_WEAR ? "bg-destructive" : wear > 60 ? "bg-warning" : "bg-success";
}

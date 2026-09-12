/**
 * Finance: turning the ledger into answers.
 *
 * The ledger (economy_transactions) is the only record of money moving, so
 * every figure on the Finance page is derived from it here: totals by kind,
 * operating profit kept apart from capital spending, the cash balance over
 * time, and profit per aircraft.
 *
 * Operating and capital are split on purpose. Buying a $2M Caravan is not a
 * $2M loss -- the company swapped cash for an aircraft -- and lumping the two
 * together made a good month with one purchase in it read as a disaster.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Txn = Database["public"]["Tables"]["economy_transactions"]["Row"];

export type TxnGroup = "operating" | "capital";

/**
 * Every transaction type the server writes. A type missing here still shows,
 * labelled from its raw name and counted as operating.
 */
export const TXN_TYPES: Record<string, { label: string; group: TxnGroup }> = {
  mission_payout: { label: "Contract pay", group: "operating" },
  fuel: { label: "Fuel", group: "operating" },
  operating: { label: "Operating costs", group: "operating" },
  lease: { label: "Lease hours", group: "operating" },
  maintenance: { label: "Maintenance", group: "operating" },
  lease_penalty: { label: "Lease return penalties", group: "operating" },
  industry_royalty: { label: "Industry royalties", group: "operating" },
  industry_wages: { label: "Industry wages", group: "operating" },
  aircraft_purchase: { label: "Aircraft bought", group: "capital" },
  aircraft_sale: { label: "Aircraft sold", group: "capital" },
  lease_deposit: { label: "Lease deposits", group: "capital" },
  certification: { label: "Certifications", group: "capital" },
  checkride_fee: { label: "Check ride fees", group: "capital" },
  industry_investment: { label: "Industry investment", group: "capital" },
  industry_construction: { label: "Industry construction", group: "capital" },
  starting_capital: { label: "Starting capital", group: "capital" },
};

export function typeLabel(type: string): string {
  const known = TXN_TYPES[type]?.label;
  if (known) return known;
  const words = type.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function typeGroup(type: string): TxnGroup {
  return TXN_TYPES[type]?.group ?? "operating";
}

// ---------------------------------------------------------------------------
// Periods and loading
// ---------------------------------------------------------------------------

export const PERIODS = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "all", label: "All time", days: null },
] as const;

export type PeriodKey = (typeof PERIODS)[number]["key"];

/** Where a period starts, or null for all time. */
export function periodStart(key: PeriodKey, now = Date.now()): Date | null {
  const days = PERIODS.find((p) => p.key === key)?.days ?? null;
  return days == null ? null : new Date(now - days * 86_400_000);
}

// PostgREST hands back at most 1,000 rows a request. A busy company passes that
// in a week, and a total silently computed from the newest 1,000 is wrong, so
// page until the source runs dry. The cap only guards against a runaway loop.
const PAGE = 1000;
const MAX_ROWS = 50_000;

async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * The company's transactions since a date, newest first.
 *
 * Filtered by company explicitly: read access is by membership, so someone in
 * two companies would otherwise see both ledgers mixed together.
 */
export function fetchLedger(companyId: string, since: Date | null): Promise<Txn[]> {
  return fetchAllRows<Txn>((from, to) => {
    let q = supabase.from("economy_transactions").select("*").eq("company_id", companyId);
    if (since) q = q.gte("created_at", since.toISOString());
    // id breaks ties, so rows sharing a timestamp can't straddle a page twice.
    return q.order("created_at", { ascending: false }).order("id").range(from, to);
  });
}

export type FlightHours = { aircraft_id: string; duration_hr: number };

export function fetchFlightHours(companyId: string, since: Date | null): Promise<FlightHours[]> {
  return fetchAllRows<FlightHours>((from, to) => {
    let q = supabase
      .from("flight_logs")
      .select("aircraft_id, duration_hr")
      .eq("company_id", companyId);
    if (since) q = q.gte("flown_at", since.toISOString());
    return q.order("flown_at", { ascending: false }).order("id").range(from, to);
  });
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export type CategoryTotal = { type: string; label: string; group: TxnGroup; total: number };

export type Summary = {
  /** Money in first, largest first; then money out, largest first. */
  rows: CategoryTotal[];
  operating: number;
  capital: number;
  net: number;
};

export function summarise(txns: readonly Txn[]): Summary {
  const totals = new Map<string, number>();
  for (const t of txns) totals.set(t.type, (totals.get(t.type) ?? 0) + Number(t.amount));

  const rows = [...totals]
    .map(([type, total]) => ({ type, label: typeLabel(type), group: typeGroup(type), total }))
    .sort(
      (a, b) => Number(b.total > 0) - Number(a.total > 0) || Math.abs(b.total) - Math.abs(a.total),
    );

  const sum = (group: TxnGroup) =>
    rows.filter((r) => r.group === group).reduce((s, r) => s + r.total, 0);
  const operating = sum("operating");
  const capital = sum("capital");
  return { rows, operating, capital, net: operating + capital };
}

// ---------------------------------------------------------------------------
// Cash over time
// ---------------------------------------------------------------------------

export type CashPoint = { t: number; cash: number };

/**
 * The cash balance after each moment money moved, oldest first.
 *
 * Cash isn't stored historically, so it's walked backwards from today's
 * balance, undoing each transaction in turn. Flight resolution moves cash by
 * its unrounded net but logs rounded line items, so the rebuilt line can sit a
 * few dollars off over many flights -- close enough to read a trend, and why
 * the page says it's rebuilt.
 *
 * Plot with a step shape: each point's balance holds until the next.
 */
export function cashSeries(
  txns: readonly Txn[],
  cashNow: number,
  since: Date | null,
  now = Date.now(),
): CashPoint[] {
  const newestFirst = txns
    .map((t) => ({ at: Date.parse(t.created_at), amount: Number(t.amount) }))
    .sort((a, b) => b.at - a.at);

  const points: CashPoint[] = [{ t: now, cash: cashNow }];
  let balance = cashNow;
  let i = 0;
  while (i < newestFirst.length) {
    const at = newestFirst[i].at;
    points.push({ t: at, cash: balance });
    // Everything a single server call wrote shares one timestamp; undo it as one step.
    while (i < newestFirst.length && newestFirst[i].at === at) {
      balance -= newestFirst[i].amount;
      i++;
    }
  }

  // Where the line starts: the period's first moment, or just before the very
  // first transaction when looking at all time.
  const oldest = newestFirst.length ? newestFirst[newestFirst.length - 1].at : now;
  const start = since ? since.getTime() : oldest - 1;
  if (start < points[points.length - 1].t) points.push({ t: start, cash: balance });

  return points.reverse();
}

// ---------------------------------------------------------------------------
// Per aircraft
// ---------------------------------------------------------------------------

/** What it costs to keep an aircraft flying, as opposed to owning one. */
const RUNNING_COSTS: ReadonlySet<string> = new Set([
  "fuel",
  "operating",
  "lease",
  "maintenance",
  "lease_penalty",
]);
const AIRCRAFT_CAPITAL: ReadonlySet<string> = new Set([
  "aircraft_purchase",
  "aircraft_sale",
  "lease_deposit",
]);

export type FleetEntry = {
  id: string;
  display_name: string;
  status: string;
  is_leased: boolean;
};

export type AircraftProfit = {
  id: string;
  name: string;
  status: string;
  isLeased: boolean;
  flights: number;
  hours: number;
  /** Contract pay. */
  earned: number;
  /** Fuel, operating, lease hours, maintenance -- negative. */
  running: number;
  /** earned + running. */
  profit: number;
  /** Null until it has flown, rather than a divide-by-zero. */
  perHour: number | null;
  /** Purchase, sale and lease deposit -- kept out of profit, like the company totals. */
  capital: number;
};

/**
 * Profit per aircraft, most profitable first.
 *
 * Needs transactions tagged with an aircraft (the transaction_aircraft
 * migration). Untagged ones are skipped, not guessed at.
 */
export function perAircraft(
  txns: readonly Txn[],
  fleet: readonly FleetEntry[],
  flights: readonly FlightHours[],
): AircraftProfit[] {
  const byId = new Map(fleet.map((a) => [a.id, a]));
  const rows = new Map<string, AircraftProfit>();
  const row = (id: string): AircraftProfit => {
    let r = rows.get(id);
    if (!r) {
      const a = byId.get(id);
      r = {
        id,
        name: a?.display_name ?? "Unknown aircraft",
        status: a?.status ?? "",
        isLeased: a?.is_leased ?? false,
        flights: 0,
        hours: 0,
        earned: 0,
        running: 0,
        profit: 0,
        perHour: null,
        capital: 0,
      };
      rows.set(id, r);
    }
    return r;
  };

  for (const f of flights) {
    const r = row(f.aircraft_id);
    r.flights += 1;
    r.hours += Number(f.duration_hr) || 0;
  }
  for (const t of txns) {
    if (!t.aircraft_id) continue;
    const amount = Number(t.amount);
    const r = row(t.aircraft_id);
    if (t.type === "mission_payout") r.earned += amount;
    else if (RUNNING_COSTS.has(t.type)) r.running += amount;
    else if (AIRCRAFT_CAPITAL.has(t.type)) r.capital += amount;
  }
  for (const r of rows.values()) {
    r.profit = r.earned + r.running;
    r.perHour = r.hours > 0 ? r.profit / r.hours : null;
  }
  return [...rows.values()].sort((a, b) => b.profit - a.profit);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function money(n: number): string {
  return `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

export function signedMoney(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}$${Math.abs(rounded).toLocaleString()}`;
}

const compact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function compactMoney(n: number): string {
  return compact.format(n);
}

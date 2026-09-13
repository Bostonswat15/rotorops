import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, type TooltipProps } from "recharts";
import {
  DollarSign,
  Landmark,
  Search,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useCompany, useCompanyRole } from "@/hooks/use-company";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import {
  LOAN_FEE_RATE,
  LOAN_REPAY_SHARE,
  PERIODS,
  cashSeries,
  compactMoney,
  fetchBalanceSheet,
  fetchFlightHours,
  fetchLedger,
  money,
  perAircraft,
  periodStart,
  signedMoney,
  summarise,
  typeLabel,
  type CashPoint,
  type CategoryTotal,
  type FleetEntry,
  type PeriodKey,
} from "@/lib/finance";

export const Route = createFileRoute("/_authenticated/finance")({
  head: () => ({ meta: [{ title: "Finance — RotorOps" }] }),
  component: FinancePage,
});

// The theme's chart blue, one lightness step darker: at 0.68 it sits just above
// the band a mark can hold on this dark card, measured with the palette
// validator. One series, so no legend -- the card title names it.
const CASH_COLOR = "oklch(0.66 0.11 225)";
const chartConfig = { cash: { label: "Cash", color: CASH_COLOR } } satisfies ChartConfig;

/** Rows drawn before "Show all", so a long ledger doesn't stall the page. */
const SHOWN_ROWS = 200;

const MIGRATION = "20260913000000_transaction_aircraft.sql";
const LOANS_MIGRATION = "20260914000000_maintenance_and_loans.sql";

function FinancePage() {
  const { data: company } = useCompany();
  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [typeFilter, setTypeFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const since = useMemo(() => periodStart(period), [period]);
  const companyId = company?.id;

  // Switching period keeps the previous figures on screen, dimmed, until the
  // new ones arrive -- no flash of empty cards.
  const ledger = useQuery({
    queryKey: ["ledger", companyId, period],
    enabled: !!companyId,
    queryFn: () => fetchLedger(companyId!, since),
    placeholderData: (prev) => prev,
  });
  const flights = useQuery({
    queryKey: ["finance-flights", companyId, period],
    enabled: !!companyId,
    queryFn: () => fetchFlightHours(companyId!, since),
    placeholderData: (prev) => prev,
  });
  // Every airframe the company has had, sold and returned included: their
  // history is still in the ledger.
  const fleet = useQuery({
    queryKey: ["finance-fleet", companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<FleetEntry[]> => {
      const { data, error } = await supabase
        .from("aircraft")
        .select("id, display_name, status, is_leased")
        .eq("company_id", companyId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const txns = useMemo(() => ledger.data ?? [], [ledger.data]);
  const cash = Number(company?.cash ?? 0);
  const summary = useMemo(() => summarise(txns), [txns]);
  const series = useMemo(() => cashSeries(txns, cash, since), [txns, cash, since]);
  const aircraft = useMemo(
    () => perAircraft(txns, fleet.data ?? [], flights.data ?? []),
    [txns, fleet.data, flights.data],
  );
  const fleetNames = useMemo(
    () => new Map((fleet.data ?? []).map((a) => [a.id, a.display_name])),
    [fleet.data],
  );

  // Until the migration runs, rows come back without the column at all.
  const attributed = txns.length === 0 || txns.some((t) => "aircraft_id" in t);

  const typesPresent = useMemo(() => {
    const types = new Set(txns.map((t) => t.type));
    if (typeFilter !== "all") types.add(typeFilter);
    return [...types].sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
  }, [txns, typeFilter]);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = txns.filter((t) => {
    if (typeFilter !== "all" && t.type !== typeFilter) return false;
    if (terms.length === 0) return true;
    const hay = [
      typeLabel(t.type),
      t.description ?? "",
      t.aircraft_id ? (fleetNames.get(t.aircraft_id) ?? "") : "",
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
  const shown = showAll ? filtered : filtered.slice(0, SHOWN_ROWS);

  const operatingRows = summary.rows.filter((r) => r.group === "operating");
  const capitalRows = summary.rows.filter((r) => r.group === "capital");
  const stale = ledger.isPlaceholderData;

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Finance</p>
        <h1 className="mt-1 text-3xl font-semibold">Money</h1>
      </div>

      {/* Where the company stands today -- not scoped by the period below. */}
      {companyId && <BalanceSheetAndLoan companyId={companyId} />}

      {/* One filter row above everything it scopes. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <Button
            key={p.key}
            type="button"
            size="sm"
            variant={period === p.key ? "default" : "secondary"}
            aria-pressed={period === p.key}
            onClick={() => {
              setPeriod(p.key);
              setShowAll(false);
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {ledger.error && (
        <p className="rounded-lg border border-destructive/40 bg-card px-4 py-3 text-sm text-destructive">
          Couldn't load the ledger: {ledger.error.message}
        </p>
      )}

      <div className={`space-y-6 transition-opacity ${stale ? "opacity-60" : ""}`}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Stat icon={DollarSign} label="Cash on hand" value={money(cash)} />
          <Stat
            icon={summary.operating < 0 ? TrendingDown : TrendingUp}
            label="Operating profit"
            value={signedMoney(summary.operating)}
            tone={toneOf(summary.operating)}
            hint="Contracts and industries, less running costs"
          />
          <Stat
            icon={Landmark}
            label="Capital"
            value={signedMoney(summary.capital)}
            hint="Aircraft, deposits, ratings, building and loans"
          />
          <Stat
            icon={summary.net < 0 ? TrendingDown : TrendingUp}
            label="Net cash change"
            value={signedMoney(summary.net)}
            tone={toneOf(summary.net)}
          />
        </div>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-medium">Cash on hand</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Rebuilt from the ledger, so it can sit a few dollars off from rounding.
          </p>
          {txns.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No money moved in this period.
            </p>
          ) : (
            <ChartContainer config={chartConfig} className="mt-4 aspect-auto h-64 w-full">
              <AreaChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={shortDate}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} width={60} />
                <ChartTooltip
                  cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
                  content={<CashTooltip />}
                />
                <Area
                  dataKey="cash"
                  type="stepAfter"
                  stroke="var(--color-cash)"
                  strokeWidth={2}
                  fill="var(--color-cash)"
                  fillOpacity={0.1}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Breakdown
            title="Operating"
            subtitle="What flying and industries earn, and what they cost to run"
            rows={operatingRows}
            total={summary.operating}
            totalLabel="Operating profit"
          />
          <Breakdown
            title="Capital"
            subtitle="Cash turned into aircraft, ratings and industries, or back again"
            rows={capitalRows}
            total={summary.capital}
            totalLabel="Net capital"
          />
        </div>

        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="p-5 pb-3">
            <h2 className="font-medium">Profit per aircraft</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Contract pay less fuel, operating costs, lease hours and maintenance. Buying, selling
              and lease deposits are shown separately.
            </p>
          </div>
          {!attributed ? (
            <p className="border-t border-border px-5 py-4 text-sm text-warning">
              Needs the <span className="font-mono">{MIGRATION}</span> migration. Run it in the
              Supabase SQL editor, then reload this page.
            </p>
          ) : aircraft.length === 0 ? (
            <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
              No aircraft flew or changed hands in this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-border bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Aircraft</th>
                    <th className="px-4 py-2 text-right">Flights</th>
                    <th className="px-4 py-2 text-right">Hours</th>
                    <th className="px-4 py-2 text-right">Earned</th>
                    <th className="px-4 py-2 text-right">Running costs</th>
                    <th className="px-4 py-2 text-right">Profit</th>
                    <th className="px-4 py-2 text-right">Per hour</th>
                    <th className="px-4 py-2 text-right">Bought / sold</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {aircraft.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">
                        {a.name}
                        {a.isLeased && <Tag>Leased</Tag>}
                        {["sold", "returned", "destroyed"].includes(a.status) && (
                          <Tag>{a.status}</Tag>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{a.flights}</td>
                      <td className="px-4 py-2 text-right font-mono">{a.hours.toFixed(1)}</td>
                      <td className="px-4 py-2 text-right font-mono">{money(a.earned)}</td>
                      <td className="px-4 py-2 text-right font-mono">{money(a.running)}</td>
                      <td
                        className={`px-4 py-2 text-right font-mono ${toneClass(toneOf(a.profit))}`}
                      >
                        {signedMoney(a.profit)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        {a.perHour == null ? "—" : signedMoney(a.perHour)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                        {a.capital === 0 ? "—" : signedMoney(a.capital)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <Select
              value={typeFilter}
              onValueChange={(v) => {
                setTypeFilter(v);
                setShowAll(false);
              }}
            >
              <SelectTrigger className="w-52" aria-label="Transaction type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {typesPresent.map((t) => (
                  <SelectItem key={t} value={t}>
                    {typeLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowAll(false);
                }}
                placeholder="Search descriptions or aircraft"
                className="pl-8"
                aria-label="Search transactions"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {filtered.length.toLocaleString()} transaction{filtered.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-secondary/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Description</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-muted-foreground">
                      {txns.length === 0 ? "No transactions in this period." : "Nothing matches."}
                    </td>
                  </tr>
                )}
                {shown.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs">{typeLabel(t.type)}</td>
                    <td className="px-4 py-2">
                      {t.description}
                      {t.aircraft_id && fleetNames.get(t.aircraft_id) && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          · {fleetNames.get(t.aircraft_id)}
                        </span>
                      )}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums ${toneClass(toneOf(Number(t.amount)))}`}
                    >
                      {signedMoney(Number(t.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!showAll && filtered.length > SHOWN_ROWS && (
            <div className="border-t border-border p-3 text-center">
              <Button type="button" variant="secondary" size="sm" onClick={() => setShowAll(true)}>
                Show all {filtered.length.toLocaleString()}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type Tone = "default" | "success" | "destructive";

function toneOf(n: number): Tone {
  const rounded = Math.round(n);
  return rounded > 0 ? "success" : rounded < 0 ? "destructive" : "default";
}

function toneClass(tone: Tone) {
  return tone === "success" ? "text-success" : tone === "destructive" ? "text-destructive" : "";
}

function shortDate(t: number) {
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CashTooltip({ active, payload }: TooltipProps<number, string>) {
  const point = payload?.[0]?.payload as CashPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="font-mono text-sm font-semibold text-foreground">{money(point.cash)}</p>
      <p className="mt-0.5 text-muted-foreground">{new Date(point.t).toLocaleString()}</p>
    </div>
  );
}

/**
 * One group of the profit and loss: a row per kind of transaction, with a thin
 * bar for size. The sign is in the figure, so the bars stay one quiet colour.
 */
function Breakdown({
  title,
  subtitle,
  rows,
  total,
  totalLabel,
}: {
  title: string;
  subtitle: string;
  rows: CategoryTotal[];
  total: number;
  totalLabel: string;
}) {
  const largest = Math.max(1, ...rows.map((r) => Math.abs(r.total)));
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing in this period.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {rows.map((r) => (
            <li
              key={r.type}
              className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-sm"
            >
              <span className="truncate text-muted-foreground">{r.label}</span>
              <span className="h-2" aria-hidden>
                <span
                  className="block h-full rounded-r-[4px]"
                  style={{
                    width: `${Math.max(1, (Math.abs(r.total) / largest) * 100)}%`,
                    background: CASH_COLOR,
                  }}
                />
              </span>
              <span className="text-right font-mono tabular-nums">{signedMoney(r.total)}</span>
            </li>
          ))}
          <li className="grid grid-cols-[1fr_auto] items-center gap-3 border-t border-border pt-2.5 text-sm font-medium">
            <span>{totalLabel}</span>
            <span className={`text-right font-mono tabular-nums ${toneClass(toneOf(total))}`}>
              {signedMoney(total)}
            </span>
          </li>
        </ul>
      )}
    </section>
  );
}

/**
 * The balance sheet, and the loan beside it -- the credit limit is built from
 * the same aircraft values, so they read best together.
 */
function BalanceSheetAndLoan({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { canManage } = useCompanyRole();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"borrow" | "repay" | null>(null);
  const sheet = useQuery({
    queryKey: ["balance-sheet", companyId],
    queryFn: () => fetchBalanceSheet(companyId),
    retry: false,
  });

  if (sheet.error) {
    return (
      <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
        The balance sheet and loans need the <span className="font-mono">{LOANS_MIGRATION}</span>{" "}
        migration. Run it in the Supabase SQL editor, then reload this page.
      </p>
    );
  }
  const s = sheet.data;
  if (!s) return null;

  const value = Math.round(Number(amount.replace(/[^0-9.]/g, "")) || 0);

  async function act(kind: "borrow" | "repay") {
    setBusy(kind);
    const { data, error } = await supabase.rpc(kind === "borrow" ? "take_loan" : "repay_loan", {
      _company_id: companyId,
      _amount: value,
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    const r = data as { borrowed?: number; fee?: number; repaid?: number } | null;
    toast.success(
      kind === "borrow"
        ? `Borrowed ${money(r?.borrowed ?? value)}. Fee ${money(-(r?.fee ?? 0))}.`
        : `Repaid ${money(r?.repaid ?? value)}.`,
    );
    setAmount("");
    qc.invalidateQueries();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-medium">Balance sheet</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          What the company is worth today, with aircraft at what they would sell for.
        </p>
        <dl className="mt-4 space-y-2 text-sm">
          <SheetRow label="Cash" value={money(s.cash)} />
          <SheetRow label={`Owned aircraft (${s.aircraftCount})`} value={money(s.aircraftValue)} />
          {s.fuelValue > 0 && (
            <SheetRow label="Fuel in tanks (at cost)" value={money(s.fuelValue)} />
          )}
          <SheetRow label="Total assets" value={money(s.assets)} strong />
          <SheetRow label="Loan owed" value={money(-s.loanBalance)} />
          <SheetRow
            label="Company value"
            value={money(s.companyValue)}
            strong
            tone={toneOf(s.companyValue)}
          />
        </dl>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-medium">Loan</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Borrow up to $100k plus half the value of your owned aircraft. A {LOAN_FEE_RATE * 100}%
          fee is taken when you borrow, and {LOAN_REPAY_SHARE * 100}% of every contract payout pays
          it down. No interest; repay early any time.
        </p>
        <dl className="mt-4 space-y-2 text-sm">
          <SheetRow label="Owed" value={money(s.loanBalance)} strong />
          <SheetRow label="Credit limit" value={money(s.loanLimit)} />
          <SheetRow label="Available to borrow" value={money(s.availableCredit)} />
        </dl>
        {canManage ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              className="w-36"
              aria-label="Loan amount"
            />
            <Button
              type="button"
              size="sm"
              disabled={busy !== null || value <= 0 || value > s.availableCredit}
              onClick={() => act("borrow")}
            >
              {busy === "borrow"
                ? "Borrowing…"
                : value > 0
                  ? `Borrow · fee ${money(value * LOAN_FEE_RATE)}`
                  : "Borrow"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy !== null || value <= 0 || s.loanBalance <= 0}
              onClick={() => act("repay")}
            >
              {busy === "repay" ? "Repaying…" : "Repay"}
            </Button>
            {s.loanBalance > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setAmount(String(Math.round(s.loanBalance)))}
              >
                Fill full balance
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">
            Only owners and managers can borrow or repay.
          </p>
        )}
      </section>
    </div>
  );
}

function SheetRow({
  label,
  value,
  strong = false,
  tone = "default",
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: Tone;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 ${strong ? "border-t border-border pt-2 font-medium" : ""}`}
    >
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className={`font-mono tabular-nums ${toneClass(tone)}`}>{value}</dd>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  tone = "default",
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <p
        className={`mt-2 font-mono text-2xl font-semibold ${toneClass(tone) || "text-foreground"}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

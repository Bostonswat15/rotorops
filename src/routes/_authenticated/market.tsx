import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { toast } from "sonner";
import { ShoppingCart, Fuel, Gauge, Package, Users, Anchor, ArrowUpDown, Wrench, KeyRound } from "lucide-react";
import { AIRCRAFT_ARCHETYPES, TAG_LABELS, type AircraftArchetype, type WingType } from "@/lib/game-data";
import { useCompany, useCompanyRole } from "@/hooks/use-company";

export const Route = createFileRoute("/_authenticated/market")({
  head: () => ({ meta: [{ title: "Aircraft Market — RotorOps" }] }),
  component: MarketPage,
});

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Rough hourly cost of ownership, so two airframes can be compared honestly. */
function hourlyTotal(a: AircraftArchetype) {
  // Fuel burn is pounds per hour; jet-A runs 0.9/lb in this economy.
  return a.op_cost_hr + a.fuel_burn_pph * 0.9;
}

// These mirror lease_rate_for / lease_deposit_for in the database. The server
// recomputes both on lease, so these are for display only -- if they ever drift,
// the server's figure is the one you're charged.
const leaseRate = (a: AircraftArchetype) => Math.round(a.acquisition_cost * 0.0008);
const leaseDeposit = (a: AircraftArchetype) => Math.round(a.acquisition_cost * 0.02);

/**
 * Flight hours at which leasing stops being the cheaper option.
 *
 * Buying costs the purchase price up front but recovers ~70% on resale;
 * leasing costs the deposit plus the hourly rate forever.
 */
function breakEvenHours(a: AircraftArchetype) {
  const netOwnCost = a.acquisition_cost * 0.30; // capital you don't get back
  const leaseUp = leaseDeposit(a);
  const rate = leaseRate(a);
  if (rate <= 0) return null;
  return Math.max(1, Math.round((netOwnCost - leaseUp) / rate));
}

function MarketPage() {
  const qc = useQueryClient();
  const { data: company } = useCompany();
  const { canManage } = useCompanyRole();
  const [sort, setSort] = useState("price");
  const [wing, setWing] = useState<WingType>("rotary");
  const [busy, setBusy] = useState<string | null>(null);

  const cash = Number(company?.cash ?? 0);

  async function buy(a: AircraftArchetype) {
    if (!company) return;
    setBusy(a.internal_id);
    const { error } = await supabase.rpc("purchase_aircraft", {
      _company_id: company.id,
      _spec: { ...a, is_modded: false } as any,
      _purchase: true,
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success(`${a.display_name} added to the fleet. ${money(-a.acquisition_cost)}`);
    qc.invalidateQueries();
  }

  // Leasing trades a small deposit now for an hourly charge on every flight --
  // cheap to start, expensive to keep. The rate is set server-side.
  async function lease(a: AircraftArchetype) {
    if (!company) return;
    setBusy(a.internal_id);
    const { error } = await supabase.rpc("lease_aircraft", {
      _company_id: company.id,
      _spec: { ...a, is_modded: false } as any,
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success(
      `${a.display_name} leased. ${money(-leaseDeposit(a))} deposit, then ${money(leaseRate(a))}/flight hour.`,
    );
    qc.invalidateQueries();
  }

  const rotaryCount = AIRCRAFT_ARCHETYPES.filter((a) => (a.wing ?? "rotary") === "rotary").length;
  const fixedCount = AIRCRAFT_ARCHETYPES.length - rotaryCount;
  const inWing = AIRCRAFT_ARCHETYPES.filter((a) => (a.wing ?? "rotary") === wing);

  const sorted = [...inWing].sort((x, y) => {
    if (sort === "price") return x.acquisition_cost - y.acquisition_cost;
    if (sort === "hourly") return hourlyTotal(x) - hourlyTotal(y);
    if (sort === "payload") return y.payload_lbs - x.payload_lbs;
    if (sort === "range") return y.max_range_nm - x.max_range_nm;
    return x.display_name.localeCompare(y.display_name);
  });

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Acquisition</p>
          <h1 className="mt-1 text-3xl font-semibold">Aircraft Market</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {sorted.length} {wing === "fixed" ? "fixed-wing" : "rotary"} airframes · cash on hand{" "}
            {money(cash)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => setWing("rotary")}
              className={`px-3 py-2 text-sm ${
                wing === "rotary" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              }`}
            >
              Helicopters ({rotaryCount})
            </button>
            <button
              type="button"
              onClick={() => setWing("fixed")}
              className={`px-3 py-2 text-sm ${
                wing === "fixed" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              }`}
            >
              Planes ({fixedCount})
            </button>
          </div>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="price">Sort: purchase price</SelectItem>
            <SelectItem value="hourly">Sort: cost per hour</SelectItem>
            <SelectItem value="payload">Sort: payload</SelectItem>
            <SelectItem value="range">Sort: range</SelectItem>
            <SelectItem value="name">Sort: name</SelectItem>
          </SelectContent>
        </Select>
        </div>
      </div>

      {!canManage && (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          Only owners and managers can buy aircraft.
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {sorted.map((a) => {
          const hourly = hourlyTotal(a);
          const affordable = cash >= a.acquisition_cost;
          return (
            <div key={a.internal_id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{a.display_name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {a.sim_title ? `MSFS: ${a.sim_title}` : a.internal_id} · {a.engine_type.replace("_", " ")}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-xl font-semibold">{money(a.acquisition_cost)}</p>
                  <p className="text-xs text-muted-foreground">{money(hourly)}/hr all-in</p>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <Spec icon={Gauge} label="Cruise" value={`${a.cruise_kts} kts`} />
                <Spec icon={ArrowUpDown} label="Range" value={`${a.max_range_nm} nm`} />
                <Spec icon={Package} label="Payload" value={`${a.payload_lbs.toLocaleString()} lb`} />
                <Spec icon={Users} label="Seats" value={`${a.pax_seats} pax`} />
                <Spec icon={Fuel} label="Burn" value={`${a.fuel_burn_pph} pph`} />
                <Spec icon={Wrench} label="Reliability" value={`${a.reliability}%`} />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>Ops {money(a.op_cost_hr)}/hr</span>
                <span>Fuel {money(a.fuel_burn_pph * 0.9)}/hr</span>
                <span>Maint factor {a.maintenance_factor}×</span>
                {a.sling_load && <span className="flex items-center gap-1 text-primary"><Anchor className="h-3 w-3" /> sling</span>}
                {a.hoist && <span className="flex items-center gap-1 text-primary"><ArrowUpDown className="h-3 w-3" /> hoist</span>}
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                {a.tags.map((t) => (
                  <span key={t} className="rounded bg-secondary px-2 py-0.5 text-[11px]">
                    {TAG_LABELS[t] ?? t}
                  </span>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                <Button
                  size="sm"
                  disabled={!canManage || !affordable || busy !== null}
                  onClick={() => buy(a)}
                >
                  <ShoppingCart className="mr-2 h-4 w-4" />
                  {busy === a.internal_id ? "Working…" : `Buy · ${money(a.acquisition_cost)}`}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canManage || cash < leaseDeposit(a) || busy !== null}
                  onClick={() => lease(a)}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Lease · {money(leaseDeposit(a))} + {money(leaseRate(a))}/hr
                </Button>
                {!affordable && cash >= leaseDeposit(a) && (
                  <span className="text-xs text-muted-foreground">
                    Can't afford to buy — short {money(a.acquisition_cost - cash)}
                  </span>
                )}
              </div>
              {breakEvenHours(a) !== null && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Leasing is cheaper below roughly {breakEvenHours(a)} flight hours;
                  buying wins beyond that.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Cost per hour combines operating cost and fuel at $0.90/lb — the same figures
        flight resolution charges you. It excludes maintenance, which scales with
        the airframe's maintenance factor and how hard you fly it.
      </p>
    </div>
  );
}

function Spec({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="font-mono text-sm">{value}</p>
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Factory, Fuel, MapPin, Warehouse } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCompany, useCompanyRole } from "@/hooks/use-company";
import { money } from "@/lib/finance";
import { INDUSTRY_DEFS } from "@/lib/industries";
import {
  AVGAS_UNIT_LB,
  BULK_FUEL_PRICE,
  FUEL_FARM_BUILD_COST,
  FUEL_FARM_BUILD_LB,
  FUEL_FARM_EXPAND_COST,
  FUEL_FARM_EXPAND_LB,
  PUMP_FUEL_PRICE,
  averageFuelCost,
  freeTankSpace,
} from "@/lib/fuel";

export const Route = createFileRoute("/_authenticated/bases")({
  head: () => ({ meta: [{ title: "Bases — RotorOps" }] }),
  component: BasesPage,
});

type Base = Database["public"]["Tables"]["bases"]["Row"];
type FuelFarm = Database["public"]["Tables"]["fuel_farms"]["Row"];
type Industry = Database["public"]["Tables"]["industries"]["Row"];
type Delivery = Database["public"]["Tables"]["fuel_farm_deliveries"]["Row"] & {
  missions: { title: string; status: string } | null;
};

const MIGRATION = "20260915000000_fuel_farms.sql";

/** Industry kinds whose output can fill a fuel farm. */
const AVGAS_KINDS = Object.values(INDUSTRY_DEFS)
  .filter((d) => d.output === "avgas")
  .map((d) => d.kind);

const lb = (n: number) => `${Math.round(n).toLocaleString()} lb`;
const perLb = (n: number) => `$${n.toFixed(2)}/lb`;
const digits = (s: string) => Math.max(0, Math.floor(Number(s.replace(/[^0-9]/g, "")) || 0));

function BasesPage() {
  const { data: company } = useCompany();
  const { canManage } = useCompanyRole();
  const companyId = company?.id;

  const bases = useQuery({
    queryKey: ["bases", "fuel", companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<Base[]> => {
      const { data, error } = await supabase
        .from("bases")
        .select("*")
        .eq("company_id", companyId!)
        .order("is_primary", { ascending: false })
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
  const farms = useQuery({
    queryKey: ["fuel-farms", companyId],
    enabled: !!companyId,
    retry: false,
    queryFn: async (): Promise<FuelFarm[]> => {
      const { data, error } = await supabase
        .from("fuel_farms")
        .select("*")
        .eq("company_id", companyId!);
      if (error) throw error;
      return data ?? [];
    },
  });
  // Fuel runs still waiting to be flown: they hold tank space.
  const deliveries = useQuery({
    queryKey: ["fuel-deliveries", companyId],
    enabled: !!companyId && !farms.error,
    queryFn: async (): Promise<Delivery[]> => {
      const { data, error } = await supabase
        .from("fuel_farm_deliveries")
        .select("*, missions(title, status)")
        .eq("company_id", companyId!)
        .is("outcome", null);
      if (error) throw error;
      return (data ?? []) as unknown as Delivery[];
    },
  });
  // Starts with "industries" so the Trading Hall's refreshes reach it.
  const refineries = useQuery({
    queryKey: ["industries", "refineries", companyId],
    enabled: !!companyId,
    queryFn: async (): Promise<Industry[]> => {
      const { data, error } = await supabase
        .from("industries")
        .select("*")
        .eq("company_id", companyId!)
        .in("kind", AVGAS_KINDS);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Operations</p>
        <h1 className="mt-1 text-3xl font-semibold">Bases</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Build a fuel farm at a base, and every flight that departs its airport burns your own fuel
          before paying {perLb(PUMP_FUEL_PRICE)} at the pump.
        </p>
      </div>

      {farms.error && (
        <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
          Fuel farms need the <span className="font-mono">{MIGRATION}</span> migration. Run it in
          the Supabase SQL editor, then reload this page.
        </p>
      )}

      {bases.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">This company has no bases yet.</p>
      )}

      {(bases.data ?? []).map((b) => {
        const farm = farms.data?.find((f) => f.base_id === b.id) ?? null;
        return (
          <BaseCard
            key={b.id}
            base={b}
            farm={farm}
            ready={!farms.error && farms.isSuccess}
            deliveries={(deliveries.data ?? []).filter((d) => d.fuel_farm_id === farm?.id)}
            refineries={refineries.data ?? []}
            cash={Number(company?.cash ?? 0)}
            canManage={canManage}
          />
        );
      })}
    </div>
  );
}

function BaseCard({
  base,
  farm,
  ready,
  deliveries,
  refineries,
  cash,
  canManage,
}: {
  base: Base;
  farm: FuelFarm | null;
  ready: boolean;
  deliveries: Delivery[];
  refineries: Industry[];
  cash: number;
  canManage: boolean;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <MapPin className="h-4 w-4 text-primary" /> {base.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{base.icao ?? "no ICAO"}</span>
            {base.is_primary && " · home base"}
          </p>
        </div>
        <Warehouse className="h-5 w-5 text-primary" />
      </div>

      {ready &&
        (farm ? (
          <FarmPanel
            base={base}
            farm={farm}
            deliveries={deliveries}
            refineries={refineries}
            cash={cash}
            canManage={canManage}
          />
        ) : (
          <BuildFarm base={base} cash={cash} canManage={canManage} />
        ))}
    </section>
  );
}

/** Run an RPC with a busy flag and a toast either way. True on success. */
function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(
    key: string,
    call: () => PromiseLike<{ error: { message: string } | null }>,
    success: string,
  ) {
    setBusy(key);
    const { error } = await call();
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return false;
    }
    toast.success(success);
    qc.invalidateQueries();
    return true;
  }
  return { busy, run };
}

function BuildFarm({ base, cash, canManage }: { base: Base; cash: number; canManage: boolean }) {
  const { busy, run } = useAction();
  return (
    <div className="mt-4 rounded-md border border-dashed border-border p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <Fuel className="h-4 w-4" /> Fuel farm
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A {lb(FUEL_FARM_BUILD_LB)} tank. Buy fuel in bulk at {perLb(BULK_FUEL_PRICE)} or fly avgas
        in from your refinery; flights departing {base.icao ?? "this base"} burn it before paying{" "}
        {perLb(PUMP_FUEL_PRICE)} at the pump.
      </p>
      {!base.icao ? (
        <p className="mt-3 text-xs text-warning">Give this base an ICAO in Settings first.</p>
      ) : canManage ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={busy !== null || cash < FUEL_FARM_BUILD_COST}
            onClick={() =>
              run(
                "build",
                () => supabase.rpc("build_fuel_farm", { _base_id: base.id }),
                `Fuel farm built at ${base.icao}.`,
              )
            }
          >
            {busy === "build" ? "Building…" : `Build · ${money(FUEL_FARM_BUILD_COST)}`}
          </Button>
          {cash < FUEL_FARM_BUILD_COST && (
            <span className="text-xs text-muted-foreground">You have {money(cash)}.</span>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Only owners and managers can build a fuel farm.
        </p>
      )}
    </div>
  );
}

function FarmPanel({
  base,
  farm,
  deliveries,
  refineries,
  cash,
  canManage,
}: {
  base: Base;
  farm: FuelFarm;
  deliveries: Delivery[];
  refineries: Industry[];
  cash: number;
  canManage: boolean;
}) {
  const { busy, run } = useAction();
  const [buyLb, setBuyLb] = useState("");
  const [runUnits, setRunUnits] = useState<Record<string, string>>({});

  const fuelLb = Number(farm.fuel_lb);
  const capacity = Number(farm.capacity_lb);
  const reserved = deliveries.reduce((s, d) => s + Number(d.fuel_lb), 0);
  const free = freeTankSpace(farm, reserved);
  const avg = averageFuelCost(farm);
  const buy = digits(buyLb);
  const buyCost = Math.round(buy * BULK_FUEL_PRICE);
  const located = base.latitude != null && base.longitude != null;

  return (
    <div className="mt-4 space-y-4">
      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5">
            <Fuel className="h-3.5 w-3.5" /> Fuel farm
          </span>
          <span className="font-mono">
            {lb(fuelLb)} / {lb(capacity)}
          </span>
        </div>
        <div
          className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-primary/15"
          role="meter"
          aria-label="Fuel in tank"
          aria-valuemin={0}
          aria-valuemax={capacity}
          aria-valuenow={fuelLb}
        >
          <div className="h-full bg-primary" style={{ width: `${(fuelLb / capacity) * 100}%` }} />
          {reserved > 0 && (
            <div
              className="h-full bg-primary/40"
              style={{ width: `${(Math.min(reserved, capacity - fuelLb) / capacity) * 100}%` }}
            />
          )}
        </div>
        {reserved > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {lb(reserved)} on the way from your refinery
          </p>
        )}
      </div>

      <dl className="grid grid-cols-3 gap-3 text-xs">
        <Fact label="Worth" value={money(Number(farm.fuel_value))} />
        <Fact
          label="Your cost"
          value={avg == null ? "—" : perLb(avg)}
          hint={`pump ${perLb(PUMP_FUEL_PRICE)}`}
        />
        <Fact label="Room left" value={lb(free)} />
      </dl>

      {canManage ? (
        <div className="space-y-4 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-medium">Buy bulk fuel · {perLb(BULK_FUEL_PRICE)}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                inputMode="numeric"
                value={buyLb}
                onChange={(e) => setBuyLb(e.target.value)}
                placeholder="Pounds"
                className="w-32"
                aria-label="Pounds of fuel to buy"
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={free <= 0}
                onClick={() => setBuyLb(String(Math.floor(free)))}
              >
                Fill up
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || buy <= 0 || buy > free || buyCost > cash}
                onClick={async () => {
                  const ok = await run(
                    "buy",
                    () => supabase.rpc("buy_bulk_fuel", { _fuel_farm_id: farm.id, _lb: buy }),
                    `Bought ${lb(buy)} of fuel.`,
                  );
                  if (ok) setBuyLb("");
                }}
              >
                {busy === "buy" ? "Buying…" : buy > 0 ? `Buy · ${money(buyCost)}` : "Buy"}
              </Button>
            </div>
            {buy > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {buy > free
                  ? `Only ${lb(free)} of room left.`
                  : `Saves ${money(buy * (PUMP_FUEL_PRICE - BULK_FUEL_PRICE))} against the pump.`}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Expand the tank by {lb(FUEL_FARM_EXPAND_LB)}
              <span className="text-muted-foreground">
                {" "}
                · to {lb(capacity + FUEL_FARM_EXPAND_LB)}
              </span>
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null || cash < FUEL_FARM_EXPAND_COST}
              onClick={() =>
                run(
                  "expand",
                  () => supabase.rpc("expand_fuel_farm", { _fuel_farm_id: farm.id }),
                  `Tank expanded to ${lb(capacity + FUEL_FARM_EXPAND_LB)}.`,
                )
              }
            >
              {busy === "expand" ? "Expanding…" : `Expand · ${money(FUEL_FARM_EXPAND_COST)}`}
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Only owners and managers can buy fuel or expand the tank.
        </p>
      )}

      <div className="border-t border-border pt-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Factory className="h-4 w-4" /> Fill from your refinery
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Sends a fuel run to the Mission Board: collect the avgas and land it here. The fuel is
          free beyond the refinery's wages; it goes in the tank when the run is flown.
        </p>
        {!located ? (
          <p className="mt-2 text-xs text-warning">
            Run the sim bridge once so this base has a position — fuel runs need somewhere to land.
          </p>
        ) : refineries.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No refinery yet. Find or build one in the Trading Hall.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {refineries.map((r) => {
              const stock = Math.floor(Number(r.stock));
              const max = Math.max(0, Math.min(stock, Math.floor(free / AVGAS_UNIT_LB)));
              const units = digits(runUnits[r.id] ?? "");
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-40 flex-1">
                    <p className="font-medium">{r.name ?? "Refinery"}</p>
                    <p className="text-xs text-muted-foreground">
                      {stock.toLocaleString()} units of avgas · {lb(stock * AVGAS_UNIT_LB)}
                    </p>
                  </div>
                  {canManage && (
                    <>
                      <Input
                        inputMode="numeric"
                        value={runUnits[r.id] ?? ""}
                        onChange={(e) => setRunUnits((s) => ({ ...s, [r.id]: e.target.value }))}
                        placeholder={`Units (max ${max})`}
                        className="w-32"
                        aria-label={`Units of avgas to send from ${r.name ?? "the refinery"}`}
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null || units <= 0 || units > max}
                        onClick={async () => {
                          const ok = await run(
                            `run:${r.id}`,
                            () =>
                              supabase.rpc("dispatch_fuel_run", {
                                _industry_id: r.id,
                                _fuel_farm_id: farm.id,
                                _units: units,
                              }),
                            `Fuel run for ${lb(units * AVGAS_UNIT_LB)} is on the Mission Board.`,
                          );
                          if (ok) setRunUnits((s) => ({ ...s, [r.id]: "" }));
                        }}
                      >
                        {busy === `run:${r.id}`
                          ? "Sending…"
                          : units > 0
                            ? `Send ${lb(units * AVGAS_UNIT_LB)}`
                            : "Send fuel run"}
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {deliveries.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {deliveries.map((d) => (
              <li key={d.mission_id}>
                {d.missions?.title ?? "Fuel run"} · {lb(Number(d.fuel_lb))} ·{" "}
                {d.missions?.status === "in_progress" ? "being flown" : "waiting on the board"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
      {hint && <dd className="text-muted-foreground">{hint}</dd>}
    </div>
  );
}

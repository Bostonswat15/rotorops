import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, CheckCircle, Wrench, XCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { useCompany, useCompanyRole } from "@/hooks/use-company";
import { money } from "@/lib/finance";
import {
  INSPECTION_GRACE_HR,
  SERVICE_LABEL,
  breakdownChance,
  groundedReason,
  inspectionDueIn,
  resaleValue,
  serviceQuote,
  wearBarClass,
  wearCostMultiplier,
  type ServiceType,
} from "@/lib/maintenance";

export const Route = createFileRoute("/_authenticated/maintenance")({
  head: () => ({ meta: [{ title: "Maintenance — RotorOps" }] }),
  component: MaintPage,
});

type Aircraft = Database["public"]["Tables"]["aircraft"]["Row"];

function MaintPage() {
  const qc = useQueryClient();
  const { canManage } = useCompanyRole();
  const { data: company } = useCompany();
  const companyId = company?.id;
  const [busy, setBusy] = useState<string | null>(null);

  const { data: aircraft } = useQuery({
    // Starts with "aircraft" so every page that invalidates the fleet refreshes this too.
    queryKey: ["aircraft", "maintenance", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("aircraft")
        .select("*")
        .eq("company_id", companyId!)
        // Sold, returned and destroyed airframes stay as history; they don't
        // need servicing. Matches the Aircraft page.
        .not("status", "in", "(sold,returned,destroyed)")
        .order("wear", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: events } = useQuery({
    queryKey: ["maint", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("maintenance_events")
        .select("*, aircraft(display_name)")
        .eq("company_id", companyId!)
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Priced server-side from the airframe's own figures, so the cost can't be
  // negotiated from the client; the quote on the button is a preview.
  async function service(a: Aircraft, type: ServiceType) {
    setBusy(`${a.id}:${type}`);
    const { data, error } = await supabase.rpc("service_aircraft", {
      _aircraft_id: a.id,
      _type: type,
    });
    setBusy(null);
    if (error) return toast.error(error.message);
    const cost = Number((data as { cost?: number } | null)?.cost ?? 0);
    toast.success(`${SERVICE_LABEL[type]} done on ${a.display_name}. ${money(-cost)}`);
    qc.invalidateQueries();
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Airworthiness</p>
        <h1 className="mt-1 text-3xl font-semibold">Maintenance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inspections are due every 100 flight hours. Worn aircraft cost more to run, break down
          more often and sell for less.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {aircraft?.map((a) => {
          const wear = Number(a.wear);
          const dueIn = inspectionDueIn(a);
          const reason = groundedReason(a);
          const costUp = Math.round((wearCostMultiplier(wear) - 1) * 100);
          const chance = breakdownChance(a) * 100;
          const services: ServiceType[] = a.broken_down_at
            ? ["repair", "inspection", "overhaul"]
            : ["inspection", "overhaul"];
          return (
            <div key={a.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{a.display_name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {Number(a.hours).toFixed(1)} hrs · reliability {a.reliability}%
                    {a.is_leased && " · leased"}
                  </p>
                </div>
                <Wrench className="h-5 w-5 text-primary" />
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between text-xs">
                  <span>Wear</span>
                  <span className="font-mono">{wear.toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full ${wearBarClass(wear)}`}
                    style={{ width: `${Math.min(100, wear)}%` }}
                  />
                </div>
              </div>

              <div className="mt-3 text-xs">
                {reason ? (
                  <span className="flex items-center gap-1 text-destructive">
                    <XCircle className="h-3 w-3" /> {reason}
                  </span>
                ) : dueIn < 0 ? (
                  <span className="flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3 w-3" /> Inspection overdue — grounded for
                    contracts in {Math.max(0, INSPECTION_GRACE_HR + dueIn).toFixed(1)} hrs
                  </span>
                ) : wear > 60 ? (
                  <span className="flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3 w-3" /> Service recommended
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-success">
                    <CheckCircle className="h-3 w-3" /> Airworthy
                  </span>
                )}
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                <dt className="text-muted-foreground">Next inspection</dt>
                <dd className="text-right font-mono">
                  {dueIn >= 0 ? `in ${dueIn.toFixed(1)} hrs` : `${(-dueIn).toFixed(1)} hrs overdue`}
                </dd>
                <dt className="text-muted-foreground">Running costs</dt>
                <dd className="text-right font-mono">
                  {costUp > 0 ? `+${costUp}% from wear` : "normal"}
                </dd>
                <dt className="text-muted-foreground">Breakdown risk</dt>
                <dd className="text-right font-mono">{chance.toFixed(1)}% per flight</dd>
                {!a.is_leased && (
                  <>
                    <dt className="text-muted-foreground">Resale today</dt>
                    <dd className="text-right font-mono">
                      {money(resaleValue(a.acquisition_cost, a.hours, wear))}
                    </dd>
                  </>
                )}
              </dl>

              <div className="mt-4 flex flex-wrap gap-2">
                {canManage ? (
                  services.map((type) => {
                    const q = serviceQuote(a, type);
                    const effect =
                      type === "repair"
                        ? "clears the breakdown"
                        : [
                            `−${q.wearRemoved.toFixed(0)} wear`,
                            "resets inspection",
                            q.valueGain > 0 ? `+${money(q.valueGain)} resale` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ");
                    return (
                      <Button
                        key={type}
                        size="sm"
                        variant={
                          type === "repair"
                            ? "default"
                            : type === "inspection"
                              ? "secondary"
                              : "outline"
                        }
                        className="h-auto flex-col items-start py-1.5"
                        disabled={busy !== null}
                        onClick={() => service(a, type)}
                      >
                        <span>
                          {busy === `${a.id}:${type}`
                            ? "Working…"
                            : `${SERVICE_LABEL[type]} · ${money(q.cost)}`}
                        </span>
                        <span className="text-[11px] font-normal opacity-70">{effect}</span>
                      </Button>
                    );
                  })
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Only owners and managers can authorise maintenance.
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {events && events.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Service history
          </h2>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {events.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between border-b border-border px-4 py-2 text-sm last:border-0"
              >
                <div>
                  <p className="font-medium">
                    {SERVICE_LABEL[e.type as ServiceType] ?? e.type} · {e.aircraft?.display_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(e.started_at).toLocaleString()}
                    {Number(e.wear_removed) > 0 && ` · −${Number(e.wear_removed).toFixed(0)} wear`}
                  </p>
                </div>
                <span className="font-mono text-destructive">{money(-Number(e.cost))}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Button } from "@/components/ui/button";
import { Wrench, AlertTriangle, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { useCompanyRole } from "@/hooks/use-company";

export const Route = createFileRoute("/_authenticated/maintenance")({
  head: () => ({ meta: [{ title: "Maintenance — RotorOps" }] }),
  component: MaintPage,
});

function MaintPage() {
  const qc = useQueryClient();
  const { canManage } = useCompanyRole();
  const { data: aircraft } = useQuery({
    queryKey: ["aircraft"],
    queryFn: async () => (await supabase.from("aircraft").select("*").order("wear", { ascending: false })).data ?? [],
  });
  const { data: events } = useQuery({
    queryKey: ["maint"],
    queryFn: async () => (await supabase.from("maintenance_events").select("*, aircraft(display_name)").order("started_at", { ascending: false })).data ?? [],
  });
  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });

  // Priced server-side from the airframe's own figures, so the cost can't be
  // negotiated from the client.
  async function service(a: any, type: "inspection" | "overhaul") {
    const { data, error } = await supabase.rpc("service_aircraft", {
      _aircraft_id: a.id,
      _type: type,
    });
    if (error) return toast.error(error.message);
    const cost = (data as any)?.cost ?? 0;
    toast.success(`${type} complete. -$${Number(cost).toLocaleString()}`);
    qc.invalidateQueries();
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Airworthiness</p>
        <h1 className="mt-1 text-3xl font-semibold">Maintenance</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {aircraft?.map((a: any) => {
          const wear = Number(a.wear);
          const barClass = wear > 80 ? "bg-destructive" : wear > 60 ? "bg-warning" : "bg-success";
          return (
            <div key={a.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{a.display_name}</h3>
                  <p className="text-xs text-muted-foreground">{Number(a.hours).toFixed(1)} hrs · reliability {a.reliability}%</p>
                </div>
                <Wrench className="h-5 w-5 text-primary" />
              </div>
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs"><span>Wear</span><span className="font-mono">{wear.toFixed(0)}%</span></div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full ${barClass}`} style={{ width: `${Math.min(100, wear)}%` }} />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1 text-xs">
                {wear > 60 ? (
                  <span className="flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" /> Service recommended</span>
                ) : (
                  <span className="flex items-center gap-1 text-success"><CheckCircle className="h-3 w-3" /> Airworthy</span>
                )}
              </div>
              <div className="mt-4 flex gap-2">
                {canManage ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => service(a, "inspection")}>
                      Inspection · ${Math.round(a.op_cost_hr * 6 * a.maintenance_factor).toLocaleString()}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => service(a, "overhaul")}>
                      Overhaul · ${Math.round(a.acquisition_cost * 0.04 * a.maintenance_factor).toLocaleString()}
                    </Button>
                  </>
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
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">Service history</h2>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {events.map((e: any) => (
              <div key={e.id} className="flex items-center justify-between border-b border-border px-4 py-2 text-sm last:border-0">
                <div>
                  <p className="font-medium capitalize">{e.type} · {e.aircraft?.display_name}</p>
                  <p className="text-xs text-muted-foreground">{new Date(e.started_at).toLocaleString()}</p>
                </div>
                <span className="font-mono text-destructive">-${Number(e.cost).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
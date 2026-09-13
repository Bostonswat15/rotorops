import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Plane, AlertTriangle } from "lucide-react";
import { AircraftForm } from "@/components/aircraft-form";
import { TAG_LABELS } from "@/lib/game-data";
import { groundedReason, inspectionDueIn, wearBarClass } from "@/lib/maintenance";
import { toast } from "sonner";
import { useCompany, useCompanyRole } from "@/hooks/use-company";

export const Route = createFileRoute("/_authenticated/aircraft")({
  head: () => ({ meta: [{ title: "Aircraft Registry — RotorOps" }] }),
  component: AircraftPage,
});

function AircraftPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { canManage } = useCompanyRole();
  // RLS returns every company you belong to, so scope to the one that's open.
  const { data: activeCompany } = useCompany();
  const { data } = useQuery({
    queryKey: ["aircraft", activeCompany?.id],
    enabled: !!activeCompany?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("aircraft")
        .select("*")
        .eq("company_id", activeCompany!.id)
        .not("status", "in", "(sold,returned,destroyed)")
        .order("created_at");
      return data ?? [];
    },
  });
  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Fleet</p>
          <h1 className="mt-1 text-3xl font-semibold">Aircraft Registry</h1>
          <p className="mt-1 text-sm text-muted-foreground">Stock and modded helicopters. {data?.length ?? 0} on roster.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" /> Add helicopter
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Register helicopter</DialogTitle>
            </DialogHeader>
            {company && (
              <AircraftForm
                companyId={company.id}
                realismMode={company.realism_mode}
                cash={Number(company.cash)}
                onSaved={() => {
                  setOpen(false);
                  qc.invalidateQueries({ queryKey: ["aircraft"] });
                  qc.invalidateQueries({ queryKey: ["company"] });
                }}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((a: any) => (
          <div key={a.id} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-mono text-muted-foreground">{a.internal_id}</p>
                <h3 className="text-lg font-semibold">{a.display_name}</h3>
                {a.is_modded && <span className="mt-1 inline-block rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider">Modded</span>}
              </div>
              <Plane className="h-5 w-5 text-primary" />
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {(a.tags as string[]).map((t) => (
                <span key={t} className="rounded bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
                  {TAG_LABELS[t as keyof typeof TAG_LABELS] ?? t}
                </span>
              ))}
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <Stat l="Cruise" v={`${a.cruise_kts} kts`} />
              <Stat l="Range" v={`${a.max_range_nm} nm`} />
              <Stat l="Payload" v={`${Number(a.payload_lbs).toLocaleString()} lb`} />
              <Stat l="Pax" v={a.pax_seats} />
              <Stat l="Op cost" v={`$${a.op_cost_hr}/hr`} />
              <Stat l="Hours" v={Number(a.hours).toFixed(1)} />
            </dl>
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Wear</span>
                <span className="font-mono">{Number(a.wear).toFixed(0)}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${wearBarClass(Number(a.wear))}`}
                  style={{ width: `${Math.min(100, Number(a.wear))}%` }}
                />
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-xs">
              <span className={`${a.status === "available" ? "text-success" : "text-warning"}`}>
                {a.broken_down_at ? "broken down" : a.status}
              </span>
              {groundedReason(a) ? (
                <span className="flex items-center gap-1 text-destructive">
                  <AlertTriangle className="h-3 w-3" /> {groundedReason(a)}
                </span>
              ) : (
                inspectionDueIn(a) <= 10 && (
                  <span className="flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3 w-3" />
                    {inspectionDueIn(a) >= 0
                      ? `Inspection due in ${inspectionDueIn(a).toFixed(1)} hrs`
                      : "Inspection overdue"}
                  </span>
                )
              )}
            </div>

            <Disposal aircraft={a} canManage={canManage} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ l, v }: { l: string; v: any }) {
  return (
    <div>
      <dt className="text-muted-foreground">{l}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
/**
 * Leaving the fleet: sell if you own it, hand it back if you lease it.
 *
 * Sale value is quoted by the database rather than guessed here, so the figure
 * on the button is the figure you get. Nothing is deleted -- retirement is a
 * status change, because flight_logs cascade off aircraft.id and a DELETE would
 * take the airframe's whole history with it.
 */
function Disposal({ aircraft: a, canManage }: { aircraft: any; canManage: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { data: quote } = useQuery({
    queryKey: ["sale_value", a.id, a.wear, a.hours],
    enabled: !a.is_leased && a.status !== "on_mission",
    queryFn: async () =>
      (await supabase.rpc("aircraft_sale_value", { _aircraft_id: a.id })).data as number | null,
  });

  async function dispose() {
    setBusy(true);
    const { data, error } = await supabase.rpc(
      a.is_leased ? "return_aircraft" : "sell_aircraft",
      { _aircraft_id: a.id },
    );
    setBusy(false);
    setConfirming(false);
    if (error) return toast.error(error.message);

    const r = data as any;
    if (a.is_leased) {
      toast.success(
        r?.penalty > 0
          ? `${r.returned} returned. Handback penalty $${Number(r.penalty).toLocaleString()} at ${r.wear}% wear.`
          : `${r?.returned ?? a.display_name} returned in good condition.`,
      );
    } else {
      toast.success(`${r?.sold ?? a.display_name} sold for $${Number(r?.value ?? 0).toLocaleString()}.`);
    }
    qc.invalidateQueries();
  }

  if (!canManage || a.status === "on_mission") return null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      {a.is_leased ? (
        <>
          <p className="text-xs text-muted-foreground">
            Leased · ${Number(a.lease_cost).toLocaleString()}/flight hour
            {Number(a.wear) > 50 && " · handback penalty applies above 50% wear"}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={busy}
            onClick={() => (confirming ? dispose() : setConfirming(true))}
          >
            {busy ? "Working…" : confirming ? "Confirm return?" : "Return lease"}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Paid ${Number(a.acquisition_cost).toLocaleString()}
            {quote != null && ` · worth $${Number(quote).toLocaleString()} today`}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-2"
            disabled={busy || quote == null}
            onClick={() => (confirming ? dispose() : setConfirming(true))}
          >
            {busy
              ? "Working…"
              : confirming
                ? `Confirm sale for $${Number(quote ?? 0).toLocaleString()}?`
                : `Sell · $${Number(quote ?? 0).toLocaleString()}`}
          </Button>
        </>
      )}
    </div>
  );
}

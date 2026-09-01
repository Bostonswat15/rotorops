import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ALL_TAGS, TAG_LABELS, AIRCRAFT_ARCHETYPES, validateAircraft } from "@/lib/game-data";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

export function AircraftForm({
  companyId,
  realismMode,
  cash,
  onSaved,
}: {
  companyId: string;
  realismMode: string;
  cash: number;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    internal_id: "",
    display_name: "",
    sim_title: "",
    category: "light_utility",
    engine_type: "turbine" as "piston" | "turbine" | "twin_turbine",
    cruise_kts: 120,
    max_range_nm: 350,
    fuel_burn_pph: 300,
    payload_lbs: 2000,
    pax_seats: 5,
    sling_load: false,
    hoist: false,
    footprint: "medium" as "small" | "medium" | "large",
    reliability: 85,
    maintenance_factor: 1.0,
    acquisition_cost: 1000000,
    op_cost_hr: 600,
    tags: [] as string[],
    is_modded: true,
    notes: "",
  });
  const [purchase, setPurchase] = useState(false);
  const [loading, setLoading] = useState(false);

  const { errors, warnings } = validateAircraft(f as any, realismMode as any);

  function loadArchetype(id: string) {
    const a = AIRCRAFT_ARCHETYPES.find((x) => x.internal_id === id);
    if (!a) return;
    setF({
      ...f,
      internal_id: a.internal_id,
      display_name: a.display_name,
      sim_title: a.sim_title,
      category: a.category,
      engine_type: a.engine_type,
      cruise_kts: a.cruise_kts,
      max_range_nm: a.max_range_nm,
      fuel_burn_pph: a.fuel_burn_pph,
      payload_lbs: a.payload_lbs,
      pax_seats: a.pax_seats,
      sling_load: a.sling_load,
      hoist: a.hoist,
      footprint: a.footprint,
      reliability: a.reliability,
      maintenance_factor: a.maintenance_factor,
      acquisition_cost: a.acquisition_cost,
      op_cost_hr: a.op_cost_hr,
      tags: a.tags,
      is_modded: false,
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (errors.length) return toast.error(errors[0]);
    if (purchase && cash < f.acquisition_cost) return toast.error("Insufficient cash for purchase.");
    setLoading(true);
    try {
      // Registering and paying happen in one transaction server-side, so a
      // failed debit can't leave a free helicopter on the books.
      const { error } = await supabase.rpc("purchase_aircraft", {
        _company_id: companyId,
        _spec: f as any,
        _purchase: purchase,
      });
      if (error) throw error;
      toast.success(purchase ? "Aircraft purchased." : "Aircraft registered.");
      onSaved();
    } catch (e: any) {
      toast.error(e.message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <div>
        <Label className="text-xs">Quick-load archetype</Label>
        <Select onValueChange={loadArchetype}>
          <SelectTrigger><SelectValue placeholder="Choose stock helicopter…" /></SelectTrigger>
          <SelectContent>
            {AIRCRAFT_ARCHETYPES.map((a) => (
              <SelectItem key={a.internal_id} value={a.internal_id}>{a.display_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Internal ID" v={f.internal_id} onChange={(v) => setF({ ...f, internal_id: v })} required />
        <Field label="Display name" v={f.display_name} onChange={(v) => setF({ ...f, display_name: v })} required />
        <Field label="MSFS sim title" v={f.sim_title} onChange={(v) => setF({ ...f, sim_title: v })} />
        <div>
          <Label>Engine type</Label>
          <Select value={f.engine_type} onValueChange={(v) => setF({ ...f, engine_type: v as any })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="piston">Piston</SelectItem>
              <SelectItem value="turbine">Turbine</SelectItem>
              <SelectItem value="twin_turbine">Twin Turbine</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <NumField label="Cruise (kts)" v={f.cruise_kts} onChange={(v) => setF({ ...f, cruise_kts: v })} />
        <NumField label="Max range (nm)" v={f.max_range_nm} onChange={(v) => setF({ ...f, max_range_nm: v })} />
        <NumField label="Fuel burn (pph)" v={f.fuel_burn_pph} onChange={(v) => setF({ ...f, fuel_burn_pph: v })} />
        <NumField label="Payload (lb)" v={f.payload_lbs} onChange={(v) => setF({ ...f, payload_lbs: v })} />
        <NumField label="Pax seats" v={f.pax_seats} onChange={(v) => setF({ ...f, pax_seats: v })} />
        <NumField label="Reliability (0-100)" v={f.reliability} onChange={(v) => setF({ ...f, reliability: v })} />
        <NumField label="Acquisition cost ($)" v={f.acquisition_cost} onChange={(v) => setF({ ...f, acquisition_cost: v })} />
        <NumField label="Op cost / hour ($)" v={f.op_cost_hr} onChange={(v) => setF({ ...f, op_cost_hr: v })} />
        <div>
          <Label>Footprint</Label>
          <Select value={f.footprint} onValueChange={(v) => setF({ ...f, footprint: v as any })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="large">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={f.sling_load} onCheckedChange={(v) => setF({ ...f, sling_load: v })} /> Sling load
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={f.hoist} onCheckedChange={(v) => setF({ ...f, hoist: v })} /> Hoist
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={f.is_modded} onCheckedChange={(v) => setF({ ...f, is_modded: v })} /> Modded aircraft
        </label>
      </div>

      <div>
        <Label className="mb-2 block">Role tags</Label>
        <div className="flex flex-wrap gap-2">
          {ALL_TAGS.map((t) => {
            const on = f.tags.includes(t);
            return (
              <label key={t} className={`flex cursor-pointer items-center gap-2 rounded border px-3 py-1.5 text-xs ${on ? "border-primary bg-accent" : "border-border"}`}>
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) =>
                    setF({ ...f, tags: v ? [...f.tags, t] : f.tags.filter((x) => x !== t) })
                  }
                />
                {TAG_LABELS[t]}
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <Label>Notes</Label>
        <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={2} />
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-warning"><AlertTriangle className="h-4 w-4" /> Validation</div>
          <ul className="mt-2 space-y-1 text-xs text-foreground/80">
            {errors.map((e, i) => <li key={i} className="text-destructive">• {e}</li>)}
            {warnings.map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={purchase} onCheckedChange={(v) => setPurchase(!!v)} />
        Charge ${f.acquisition_cost.toLocaleString()} to company cash (purchase)
      </label>

      <Button type="submit" className="w-full" disabled={loading || errors.length > 0}>
        {loading ? "Saving…" : "Register aircraft"}
      </Button>
    </form>
  );
}

function Field({ label, v, onChange, required }: { label: string; v: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={v} required={required} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function NumField({ label, v, onChange }: { label: string; v: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}